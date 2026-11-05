// AI vision features run as an optional external tool: a Python helper (vision-py.ts) executed with `uv run --with ...`,
// so packages are fetched on demand and AgentCut core never needs them. Results are cached per file hash + params.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EditError } from "./model.ts";
import { VISION_PY } from "./vision-py.ts";

// pinned so cached results and mattes stay reproducible; opencv 4.12 still ships the Haar face cascades
const CV = ["opencv-contrib-python-headless==4.12.0.88", "numpy==2.2.6"];
const REMBG = ["rembg[cpu]==2.0.86", "onnxruntime==1.31.1", "numpy==2.5.4", "pillow==13.0.0"];
export const MATTE_MODELS = ["u2netp", "u2net", "u2net_human_seg", "isnet-general-use", "silueta"];

export const cacheDir = (root?: string) =>
  root ? join(root, ".agentcut", "cache") : join(process.env.AGENTCUT_CACHE ?? join(homedir(), ".cache", "agentcut"), "vision");

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

const scriptHash = createHash("sha256").update(VISION_PY).digest("hex").slice(0, 12);
export const cacheKey = (path: string, params: unknown) =>
  createHash("sha256").update(`${fileHash(path)}|${scriptHash}|${JSON.stringify(params)}`).digest("hex").slice(0, 20);

const writeAtomic = (file: string, data: string) => { writeFileSync(file + ".tmp", data); renameSync(file + ".tmp", file); };

function runHelper(job: Record<string, unknown>, pkgs: string[], root?: string): any {
  const dir = cacheDir(root);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, `vision-${scriptHash}.py`);
  if (!existsSync(script)) writeAtomic(script, VISION_PY);
  const uv = process.env.AGENTCUT_UV || "uv";
  const r = spawnSync(uv, ["run", "--no-project", "--quiet", ...pkgs.flatMap((p) => ["--with", p]), "python", "-I", script, JSON.stringify(job)],
    { encoding: "utf8", maxBuffer: 256 << 20 });
  if ((r.error as any)?.code === "ENOENT")
    throw new EditError(`${job.cmd === "matte" ? "remove_background" : job.cmd === "track" ? "track_to" : "subject analysis"} needs uv (runs the Python vision helper)`, "missing_dependency",
      "install uv (`brew install uv`, or `curl -LsSf https://astral.sh/uv/install.sh | sh`) or set AGENTCUT_UV=/path/to/uv; the first run downloads " +
      (job.cmd === "matte" ? "rembg + onnxruntime and a ~5 MB segmentation model" : "opencv (~40 MB)"));
  if (r.error || r.status !== 0)
    throw new EditError(`vision helper failed (${job.cmd}): ${(r.stderr || String(r.error ?? "")).trim().split("\n").slice(-4).join(" | ").slice(0, 500)}`, "vision_failed",
      "the first run needs network access for uv to download packages; check the media file decodes (probe_media)");
  try { return JSON.parse(r.stdout); } catch { throw new EditError(`vision helper printed no JSON: ${r.stdout.slice(0, 200)}`, "vision_failed"); }
}

function cachedJson<T>(root: string | undefined, name: string, f: () => T): T & { cached: boolean } {
  const file = join(cacheDir(root), `${name}.json`);
  if (existsSync(file)) return { ...JSON.parse(readFileSync(file, "utf8")), cached: true };
  const v = f();
  mkdirSync(cacheDir(root), { recursive: true });
  writeAtomic(file, JSON.stringify(v));
  return { ...v, cached: false };
}

export interface Sample { t: number; x?: number; y?: number; w?: number; h?: number; kind?: string; score?: number; ok?: boolean }
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Subject centre over time (largest face, else saliency centroid); x/y are 0..1 of the full source frame. */
export function analyzeSubject(path: string, o: { still?: boolean; start?: number; duration?: number; fps?: number; srcW: number; srcH: number; root?: string }) {
  const fps = o.still ? null : o.fps ?? 6, w = even(Math.min(480, o.srcW)), h = even((w * o.srcH) / o.srcW);
  // a still is one frame: no seek, no fps resampling (either would yield zero frames)
  const params = { cmd: "subject", start: o.still ? null : o.start ?? 0, duration: o.still ? null : o.duration ?? null, fps, w, h };
  const res = cachedJson(o.root, `subject-${cacheKey(path, params)}`, () => runHelper({ ...params, path }, CV, o.root) as { samples: Sample[] });
  if (!res.samples.length) throw new EditError(`subject analysis decoded no frames from ${path}`, "vision_failed", "check the file and range with probe_media / preview_frame");
  return { source: path, fps, ...res };
}

/** OpenCV CSRT/KCF track of a box (fractions of the source frame) given at source time `at`, forwards and backwards. */
export function trackBox(path: string, o: { start: number; duration: number; at: number; box: number[]; fps?: number; tracker?: string; srcW: number; srcH: number; root?: string }) {
  const fps = o.fps ?? 15, w = even(Math.min(640, o.srcW)), h = even((w * o.srcH) / o.srcW);
  const params = { cmd: "track", start: o.start, duration: o.duration, at: o.at, box: o.box.map((v) => +v.toFixed(5)), fps, w, h, tracker: o.tracker ?? "csrt" };
  return cachedJson(o.root, `track-${cacheKey(path, params)}`, () => runHelper({ ...params, path }, CV, o.root) as { samples: Sample[] });
}

/** Alpha version of a video (ProRes 4444 .mov, source audio kept) or image (.png), cached by content hash + model. */
export function matte(path: string, o: { kind: string; fps?: number | null; srcW: number; srcH: number; model?: string; root?: string }) {
  const model = o.model ?? "u2netp";
  if (!MATTE_MODELS.includes(model)) throw new EditError(`unknown matte model '${model}'`, "bad_value", `models: ${MATTE_MODELS.join(", ")}`);
  const s = Math.min(1, 1920 / Math.max(o.srcW, o.srcH)), w = even(o.srcW * s), h = even(o.srcH * s);
  const params = { cmd: "matte", kind: o.kind, fps: o.fps ?? null, w, h, model };
  const out = join(cacheDir(o.root), `matte-${cacheKey(path, params)}${o.kind === "image" ? ".png" : ".mov"}`);
  if (existsSync(out)) return { out, w, h, cached: true };
  const tmp = out.replace(/(\.\w+)$/, ".part$1");
  runHelper({ ...params, path, out: tmp }, REMBG, o.root);
  renameSync(tmp, out);
  return { out, w, h, cached: false };
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
