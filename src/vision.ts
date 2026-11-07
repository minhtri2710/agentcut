// AI vision features run as an optional external tool: a Python helper (vision-py.ts) executed with `uv run --with ...`,
// so packages are fetched on demand and AgentCut core never needs them. Results are cached per file hash + params and are
// only computed by `prepare` (prepare.ts), never inside apply_ops.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { stopOnAbort } from "./media.ts";
import { type Dict, EditError, MATTE_MB, MATTE_MODELS } from "./model.ts";
import { commit, createFile, ensureDir, tmpSibling, writeFile } from "./safe-write.ts";
import { VISION_PY } from "./vision-py.ts";

// pinned so cached results and mattes stay reproducible; opencv 4.12 still ships the Haar face cascades
const CV = ["opencv-contrib-python-headless==4.12.0.88", "numpy==2.2.6"];
const REMBG = ["rembg[cpu]==2.0.86", "onnxruntime==1.31.1", "numpy==2.5.4", "pillow==13.0.0"];

const userCache = () => resolve(process.env.AGENTCUT_CACHE ?? join(homedir(), ".cache", "agentcut"));
/** Matte models live only in `<user cache>/models/<name>/<name>.onnx`: the helper runs with U2NET_HOME = the user cache, and rembg 2.0.86 keeps a
 *  model at `<U2NET_HOME>/models/<name>/<name>.onnx`. Nothing under ~/.u2net is read. */
export const matteModelFile = (model: string) => join(userCache(), "models", model, `${model}.onnx`);
export const matteCached = (model: string) => lstatSync(matteModelFile(model), { throwIfNoEntry: false })?.isFile() === true;
/** The matte models these jobs need that are not in the models dir yet. */
export function modelsToDownload(jobs: Derived[]) {
  const names = new Set(jobs.filter((d) => d.kind === "matte").map((d) => String(d.job.model)));
  return [...names].filter((model) => !matteCached(model)).map((model) => ({ model, approx_mb: MATTE_MB[model], path: matteModelFile(model) }));
}
export const cacheDir = (root?: string) => (root ? join(root, ".agentcut", "cache") : join(userCache(), "vision"));

const hashes = new Map<string, string>();
/** sha256 of the file content (memoized per path + size + mtime). */
export function fileHash(path: string): string {
  const st = statSync(path), memo = `${path}|${st.size}|${st.mtimeMs}`;
  let h = hashes.get(memo);
  if (!h) {
    const hs = createHash("sha256"), buf = Buffer.alloc(1 << 20), fd = openSync(path, "r");
    try { for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hs.update(buf.subarray(0, n)); } finally { closeSync(fd); }
    hashes.set(memo, (h = hs.digest("hex")));
  }
  return h;
}

const helperSha = createHash("sha256").update(VISION_PY).digest("hex");
const scriptHash = helperSha.slice(0, 12);
export const cacheKey = (path: string, params: unknown) =>
  createHash("sha256").update(`${fileHash(path)}|${scriptHash}|${JSON.stringify(params)}`).digest("hex").slice(0, 20);

/** A derived asset (analysis JSON or alpha matte) in the cache: `file` exists once it was computed. Ops only look it up;
 *  `compute` (run by prepare, never inside apply_ops) produces it. `frames` estimates the helper's work for progress. */
export interface Derived { kind: "subject" | "track" | "matte"; file: string; job: Record<string, unknown>; pkgs: string[]; root?: string; frames: number; w?: number; h?: number }
export const isReady = (d: Derived) => existsSync(d.file);
export const readResult = (d: Derived): { samples: Sample[] } => JSON.parse(readFileSync(d.file, "utf8"));

/** `<user cache>/helper-runs`, where every run dir lives. Resolved to a canonical absolute path, then checked before anything is written:
 *  every directory from there up to the filesystem root (the home dir is no stopping point: the parent search goes above it) must be a real directory
 *  owned by this user or root and not group- or world-writable (the sticky bit does not matter: it stops deletion, not creating entries;
 *  only the home dir itself may be group-writable), and `helper-runs`
 *  itself must be a real directory owned by this user with mode 0700 (created so if missing). Anything else is refused with
 *  `unsafe_helper_dir`. Windows has no uid or mode bits: there only the real-directory checks apply. */
function helperRoot(): string {
  const base = userCache(), uid = process.getuid?.(), posix = uid !== undefined;
  const refuse = (what: string) => new EditError(`the vision helper's run dir is refused: ${what}`, "unsafe_helper_dir",
    "nothing was written or run; the helper runs only under a directory in the user cache (~/.cache/agentcut, or AGENTCUT_CACHE) that only you can write");
  let top = base; // the deepest part of the cache path that exists; what is missing below it is created here, under a checked parent
  while (!lstatSync(top, { throwIfNoEntry: false })) top = dirname(top);
  const real = realpathSync(top);
  let home: string | undefined;
  try { home = realpathSync(homedir()); } catch { /* no home: no exemption */ }
  for (let d = real; ; d = dirname(d)) {
    const st = lstatSync(d), isHome = d === home;
    // the home dir may be group-writable (user-private groups); no other directory on the way may be group- or world-writable
    const loose = posix && (st.mode & (isHome ? 0o002 : 0o022)) !== 0;
    if (!st.isDirectory() || (posix && st.uid !== uid && st.uid !== 0) || loose) throw refuse(`${d} is not a directory that only you can write`);
    if (d === dirname(d)) break;
  }
  const root = join(real, relative(top, base), "helper-runs");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (!st.isDirectory() || (posix && (st.uid !== uid || (st.mode & 0o777) !== 0o700))) throw refuse(`${root} is not a private directory (owner you, mode 0700)`);
  return root;
}

/** The helper is only ever run from a private dir that this process just created under helperRoot(), never from a cache or project path.
 *  This check runs right before every spawn: the bytes on disk must be exactly the embedded script. */
export function checkHelper(script: string) {
  let sha: string | undefined;
  try { sha = createHash("sha256").update(readFileSync(script)).digest("hex"); } catch { /* unreadable: refused below */ }
  if (sha !== helperSha) throw new EditError("the vision helper script on disk is not the embedded script", "unsafe_helper", "AgentCut did not run it; retry, and check that nothing else writes to the temp dir");
}

const PROGRESS = /^AGENTCUT_PROGRESS (\d+)$/;
const label = (cmd: unknown) => (cmd === "matte" ? "remove_background" : cmd === "track" ? "track_to" : "subject analysis");

/** Runs the helper (`root` = helperRoot()) from a fresh private (0700) run dir `helper-runs/vision-<pid>-xxxxxx`, removed afterwards even on failure or abort
 *  (best effort: a cleanup error never replaces the result; a SIGKILL leaves the dir behind). The dir is also the spawn's cwd, and uv gets
 *  --no-config; with every ancestor of the dir owned by this user or root and closed to others, no other folder chooses uv's settings. */
async function runHelper(root: string, d: Derived, out: string, allowDownload: boolean, onFrames?: (n: number) => void, signal?: AbortSignal): Promise<any> {
  const uvEnv = process.env.AGENTCUT_UV || "uv", uv = /[\\/]/.test(uvEnv) ? resolve(uvEnv) : uvEnv; // the cwd changes below: keep a relative path meaning what the user typed
  const job: Record<string, unknown> = d.kind === "matte" ? { ...d.job, out, allow_download: allowDownload } : d.job;
  const dir = mkdtempSync(join(root, `vision-${process.pid}-`));
  try {
    const script = join(dir, "helper.py");
    createFile(script, VISION_PY, 0o600);
    return await spawnHelper(uv, dir, script, d, job, onFrames, signal);
  } finally { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort: never mask the result or the abort reason */ } }
}

function spawnHelper(uv: string, dir: string, script: string, d: Derived, job: Record<string, unknown>, onFrames?: (n: number) => void, signal?: AbortSignal): Promise<any> {
  checkHelper(script);
  const env = { ...process.env, ORT_DISABLE_TELEMETRY: "1", ...(d.kind === "matte" && { U2NET_HOME: userCache() }) };
  return new Promise((res, rej) => {
    const ch = spawn(uv, ["run", "--no-project", "--no-config", "--quiet", ...d.pkgs.flatMap((p) => ["--with", p]), "python", "-I", script, JSON.stringify(job)], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    // stdin is the stop channel: the helper exits when it reads EOF (we close it on abort, and it closes when this process dies)
    ch.stdin.on("error", () => {});
    stopOnAbort(ch, signal);
    let stdout = "", err = "", partial = "";
    ch.stdout.on("data", (b) => { stdout += b; });
    ch.stderr.on("data", (b) => {
      const lines = (partial + b).split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) { const m = PROGRESS.exec(l); if (m) onFrames?.(Number(m[1])); else err += l + "\n"; }
    });
    ch.on("error", (e: any) => rej(e.code === "ENOENT"
      ? new EditError(`${label(job.cmd)} needs uv (runs the Python vision helper)`, "missing_dependency",
        "install uv (`brew install uv`, or `curl -LsSf https://astral.sh/uv/install.sh | sh`) or set AGENTCUT_UV=/path/to/uv; the first run downloads " +
        (job.cmd === "matte" ? "rembg + onnxruntime" : "opencv (~40 MB)"))
      : new EditError(`vision helper failed to start (${job.cmd}): ${e.message}`, "vision_failed")));
    ch.on("close", (code) => {
      if (signal?.aborted) return rej(signal.reason);
      if (code !== 0) {
        const model = d.kind === "matte" && matteCached(String(d.job.model)) ? matteModelFile(String(d.job.model)) : null; // rembg never re-checks an existing model file
        return rej(new EditError(`vision helper failed (${job.cmd}): ${(err + partial).trim().split("\n").slice(-4).join(" | ").slice(0, 500)}`, "vision_failed",
          "the first run needs network access for uv to download packages; check the media file decodes (probe_media)"
          + (model ? `; if the error is about loading the model, the model file ${model} may be damaged: delete it and run prepare with allow_download=true` : "")));
      }
      try { res(JSON.parse(stdout)); } catch { rej(new EditError(`vision helper printed no JSON: ${stdout.slice(0, 200)}`, "vision_failed")); }
    });
  });
}

/** The trusted base of d.file: the project folder, or the user cache for an analysis without a project. */
const baseOf = (d: Derived) => d.root ?? userCache();

/** Produce d.file unless it is cached. Writes go to a unique temp name + rename, so concurrent computes never tear a file.
 *  A matte model is fetched by the helper only with `allowDownload` (prepare gates it first: prepare.ts). */
export async function compute(d: Derived, onFrames?: (n: number) => void, signal?: AbortSignal, allowDownload = false): Promise<{ cached: boolean }> {
  signal?.throwIfAborted();
  if (isReady(d)) return { cached: true };
  const root = helperRoot(); // refused before anything is written, the cache dir included
  const tmp = tmpSibling(d.file, baseOf(d));
  if (d.kind === "matte") ensureDir(userCache(), join(userCache(), "models"));
  try {
    const r = await runHelper(root, d, tmp, allowDownload, onFrames, signal);
    if (d.kind === "matte") commit(tmp, d.file);
    else writeFile(d.file, JSON.stringify(r), baseOf(d));
  } finally { rmSync(tmp, { force: true }); }
  return { cached: false };
}

export interface Sample { t: number; x?: number; y?: number; w?: number; h?: number; kind?: string; score?: number; ok?: boolean }
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
/** The numbers a job hands to the helper's ffmpeg commands must be real numbers: finite, and fps and the frame size positive. Every job builder goes through derived. */
function checkJob(params: Dict) {
  for (const k of ["fps", "start", "duration", "at", "w", "h", "frames"]) {
    const v = params[k];
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || (["fps", "w", "h"].includes(k) && v <= 0))
      throw new EditError(`vision job: ${k} must be a ${["fps", "w", "h"].includes(k) ? "number > 0" : "finite number"}, got ${JSON.stringify(v)}`, "bad_media", "check the asset record (fps, width, height) in project.json");
  }
}
const derived = (kind: Derived["kind"], ext: string, path: string, params: Dict, pkgs: string[], root: string | undefined, frames: number, extra: Partial<Derived> = {}): Derived => {
  checkJob({ ...params, frames });
  return { kind, file: join(cacheDir(root), `${kind}-${cacheKey(path, params)}${ext}`), job: { ...params, path }, pkgs, root, frames: Math.max(1, Math.round(frames)), ...extra };
};

/** Subject centre over time (largest face, else saliency centroid); x/y are 0..1 of the full source frame. */
export function subjectJob(path: string, o: { still?: boolean; start?: number; duration?: number; fps?: number; srcW: number; srcH: number; root?: string }) {
  const fps = o.still ? null : o.fps ?? 6, w = even(Math.min(480, o.srcW)), h = even((w * o.srcH) / o.srcW);
  // a still is one frame: no seek, no fps resampling (either would yield zero frames)
  const params = { cmd: "subject", start: o.still ? null : o.start ?? 0, duration: o.still ? null : o.duration ?? null, fps, w, h };
  return derived("subject", ".json", path, params, CV, o.root, fps ? (o.duration ?? 1) * fps : 1);
}
/** Cached subject samples; throws vision_failed when the helper decoded nothing. */
export function subjectSamples(d: Derived) {
  const res = readResult(d);
  if (!res.samples.length) throw new EditError(`subject analysis decoded no frames from ${d.job.path}`, "vision_failed", "check the file and range with probe_media / preview_frame");
  return res.samples;
}
/** Standalone analysis (analyze_subject): computes on a cache miss. */
export async function analyzeSubject(path: string, o: Parameters<typeof subjectJob>[1]) {
  const d = subjectJob(path, o), { cached } = await compute(d);
  return { source: path, fps: d.job.fps, samples: subjectSamples(d), cached };
}

/** OpenCV CSRT/KCF track of a box (fractions of the source frame) given at source time `at`, forwards and backwards. */
export function trackJob(path: string, o: { start: number; duration: number; at: number; box: number[]; fps?: number; tracker?: string; srcW: number; srcH: number; root?: string }) {
  const fps = o.fps ?? 15, w = even(Math.min(640, o.srcW)), h = even((w * o.srcH) / o.srcW);
  const params = { cmd: "track", start: o.start, duration: o.duration, at: o.at, box: o.box.map((v) => +v.toFixed(5)), fps, w, h, tracker: o.tracker ?? "csrt" };
  return derived("track", ".json", path, params, CV, o.root, o.duration * fps);
}

/** Alpha version of a video (ProRes 4444 .mov, source audio kept) or image (.png), cached by content hash + model. */
export function matteJob(path: string, o: { kind: string; fps?: number | null; duration?: number; srcW: number; srcH: number; model?: string; root?: string }) {
  const model = o.model ?? "u2netp";
  if (!MATTE_MODELS.includes(model)) throw new EditError(`unknown matte model '${model}'`, "bad_value", `models: ${MATTE_MODELS.join(", ")}`);
  const s = Math.min(1, 1920 / Math.max(o.srcW, o.srcH)), w = even(o.srcW * s), h = even(o.srcH * s);
  const fps = o.kind === "image" ? null : o.fps ?? 30; // a video of unknown rate is matted at 30
  const params = { cmd: "matte", kind: o.kind, fps, w, h, model };
  return derived("matte", o.kind === "image" ? ".png" : ".mov", path, params, REMBG, o.root, fps ? (o.duration ?? 1) * fps : 1, { w, h });
}

// ---------------------------------------------------------------- path smoothing (pure)
/** Fill gaps (missing samples hold/interpolate), median-filter outliers, then smooth with a Gaussian kernel (sigma seconds). */
export function smoothPath(ts: number[], vs: (number | undefined)[], sigma: number): number[] {
  const n = ts.length, known = vs.map((v, i) => [i, v] as const).filter(([, v]) => v !== undefined && Number.isFinite(v)) as [number, number][];
  if (!known.length) return ts.map(() => 0.5);
  const filled = ts.map((_, i) => {
    let a: [number, number] | undefined, b: [number, number] | undefined;
    for (const k of known) { if (k[0] <= i) a = k; if (k[0] >= i && !b) b = k; }
    if (!a) return b![1]; if (!b) return a[1];
    return a[0] === b[0] ? a[1] : a[1] + ((b[1] - a[1]) * (i - a[0])) / (b[0] - a[0]);
  });
  // 5-sample median drops one-sample outliers; the first/last 2 samples stay raw (a shrunken window would bias them)
  const med = filled.map((v, i) => (i < 2 || i > n - 3 ? v : filled.slice(i - 2, i + 3).sort((x, y) => x - y)[2]));
  if (n < 2 || sigma <= 0) return med;
  // Gaussian-weighted local linear fit (zero-phase): equals Gaussian smoothing inside, and at the ends it follows a moving
  // subject instead of pulling the path toward the middle
  return med.map((_, i) => {
    let sw = 0, st = 0, sv = 0, stt = 0, stv = 0;
    for (let j = 0; j < n; j++) {
      const d = ts[j] - ts[i];
      if (Math.abs(d) > 3 * sigma) continue;
      const w = Math.exp(-(d * d) / (2 * sigma * sigma));
      sw += w; st += w * d; sv += w * med[j]; stt += w * d * d; stv += w * d * med[j];
    }
    const den = sw * stt - st * st;
    return den > 1e-12 * sw * sw ? (sv * stt - st * stv) / den : sv / sw;
  });
}

/** Ramer-Douglas-Peucker on a 1-D or 2-D path; returns kept indices (first and last always kept). */
export function simplify(ts: number[], series: number[][], tol: number): number[] {
  const keep = new Set([0, ts.length - 1]);
  const rec = (a: number, b: number) => {
    let worst = -1, wd = tol;
    for (let i = a + 1; i < b; i++) {
      const f = (ts[i] - ts[a]) / (ts[b] - ts[a] || 1);
      const d = Math.max(...series.map((s) => Math.abs(s[i] - (s[a] + (s[b] - s[a]) * f))));
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst >= 0) { keep.add(worst); rec(a, worst); rec(worst, b); }
  };
  if (ts.length > 2) rec(0, ts.length - 1);
  return [...keep].sort((x, y) => x - y);
}
