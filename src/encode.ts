// Video export: frames -> FFmpeg with back-pressure; long renders are split into segments rendered by
// parallel worker processes (one Skia compositor per core pair) and joined losslessly.
// Output options: codec (h264 | hevc | prores | prores_4444 | vp9 | auto by extension), alpha (transparent video in
// .mov ProRes 4444 / .webm VP9), and audio-only exports (.wav .mp3 .m4a .aac .flac) that skip video entirely.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { audioSources, buildAudio } from "./audio.ts";
import { needFfmpeg, stopOnAbort } from "./media.ts";
import { EditError, parseColor, resolve, type Timeline, totalDuration } from "./model.ts";
import { Renderer } from "./render.ts";

export type VideoCodec = "h264" | "hevc" | "prores" | "prores_4444" | "vp9";
export type Codec = VideoCodec | "auto";

/** Video containers: default codec ("auto") and audio args. */
export const FORMATS: Record<string, { codec: VideoCodec; audio: string[] }> = {
  ".mp4": { codec: "h264", audio: ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"] },
  ".m4v": { codec: "h264", audio: ["-c:a", "aac", "-b:a", "192k"] },
  ".mov": { codec: "prores", audio: ["-c:a", "pcm_s16le"] },
  ".webm": { codec: "vp9", audio: ["-c:a", "libopus", "-b:a", "160k"] },
  ".mkv": { codec: "h264", audio: ["-c:a", "aac", "-b:a", "192k"] },
};
/** Codec -> containers it can go in, and the containers where it keeps an alpha channel. */
export const CODECS: Record<VideoCodec, { exts: string[]; alpha: string[] }> = {
  h264: { exts: [".mp4", ".m4v", ".mov", ".mkv"], alpha: [] },
  hevc: { exts: [".mp4", ".m4v", ".mov", ".mkv"], alpha: [] },
  prores: { exts: [".mov", ".mkv"], alpha: [] },
  prores_4444: { exts: [".mov"], alpha: [".mov"] },
  vp9: { exts: [".webm", ".mkv"], alpha: [".webm"] },
};
/** Audio-only exports: no frames are rendered, just the mix for the range. */
export const AUDIO_FORMATS: Record<string, { codec: string; args: string[] }> = {
  ".wav": { codec: "pcm_s16le", args: ["-c:a", "pcm_s16le"] },
  ".mp3": { codec: "mp3", args: ["-c:a", "libmp3lame", "-b:a", "192k"] },
  ".m4a": { codec: "aac", args: ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"] },
  ".aac": { codec: "aac", args: ["-c:a", "aac", "-b:a", "192k"] },
  ".flac": { codec: "flac", args: ["-c:a", "flac"] },
};
export const QUALITY: Record<string, { crf: number; preset: string; vp9: number; x265: number; vt: number }> = {
  draft: { crf: 30, preset: "ultrafast", vp9: 40, x265: 32, vt: 45 },
  standard: { crf: 20, preset: "veryfast", vp9: 32, x265: 24, vt: 62 },
  high: { crf: 16, preset: "slow", vp9: 24, x265: 20, vt: 75 },
};
const ALL_EXTS = [...Object.keys(FORMATS), ".gif", ...Object.keys(AUDIO_FORMATS)].join(", ");

let encoderList: string | null = null;
function hasEncoder(name: string) {
  if (encoderList === null) encoderList = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout || "";
  return new RegExp(`^\\s*\\S+\\s+${name.replace(/[-]/g, "\\-")}\\s`, "m").test(encoderList);
}
const hasVideoToolbox = (enc: string) => process.platform === "darwin" && hasEncoder(enc);
function needEncoder(name: string, what: string) {
  if (!hasEncoder(name)) throw new EditError(`this FFmpeg build has no ${name} encoder (needed for ${what})`, "encoder_missing",
    "install an FFmpeg build with it (e.g. a full static build) or pick another codec/format");
}

/** Encoder args for a video codec. `mux` are output-container args that must go on the final file (not on segments). */
export function videoArgs(codec: VideoCodec, quality: string, hwEncode: boolean, alpha = false, ext = ""): { v: string[]; mux: string[] } {
  const q = QUALITY[quality] ?? QUALITY.standard;
  const apple = ext === ".mp4" || ext === ".m4v" || ext === ".mov";
  switch (codec) {
    case "h264":
      if (hwEncode && hasVideoToolbox("h264_videotoolbox"))
        return { v: ["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", "-q:v", String(q.vt), "-allow_sw", "1"], mux: [] };
      needEncoder("libx264", "h264");
      return { v: ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", String(q.crf), "-preset", q.preset], mux: [] };
    case "hevc": {
      const mux = apple ? ["-tag:v", "hvc1"] : []; // hvc1 tag: QuickTime / Apple players refuse the default hev1
      if (hwEncode && hasVideoToolbox("hevc_videotoolbox"))
        return { v: ["-c:v", "hevc_videotoolbox", "-pix_fmt", "yuv420p", "-q:v", String(q.vt), "-allow_sw", "1"], mux };
      needEncoder("libx265", "hevc");
      return { v: ["-c:v", "libx265", "-pix_fmt", "yuv420p", "-crf", String(q.x265), "-preset", q.preset, "-x265-params", "log-level=error"], mux };
    }
    case "prores":
      needEncoder("prores_ks", "prores");
      return { v: ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"], mux: [] };
    case "prores_4444":
      needEncoder("prores_ks", "prores_4444");
      return { v: ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", alpha ? "yuva444p10le" : "yuv444p10le", ...(alpha ? ["-alpha_bits", "16"] : [])], mux: [] };
    case "vp9":
      needEncoder("libvpx-vp9", "vp9");
      return { v: ["-c:v", "libvpx-vp9", "-b:v", "0", "-row-mt", "1", "-deadline", "realtime", "-cpu-used", "8",
        "-pix_fmt", alpha ? "yuva420p" : "yuv420p", "-crf", String(q.vp9)], mux: [] };
  }
}

export interface OutputPlan { codec: VideoCodec; alpha: boolean; v: string[]; mux: string[]; a: string[]; warnings: string[]; transparent: boolean }

/** Resolve codec/alpha for a video output and validate the combination (throws EditError with a hint). */
export function planOutput(ext: string, tl: Timeline, o: { codec?: string; alpha?: boolean; quality?: string; hwEncode?: boolean } = {}): OutputPlan {
  const gif = ext === ".gif";
  const req = (o.codec ?? "auto").toLowerCase().replace(/[-\s]/g, "_") as Codec;
  const alias: Record<string, Codec> = { h265: "hevc", x265: "hevc", x264: "h264", avc: "h264", prores4444: "prores_4444", "4444": "prores_4444", vp09: "vp9" };
  const want = (alias[req] ?? req) as Codec;
  if (want !== "auto" && !(want in CODECS))
    throw new EditError(`unknown codec '${o.codec}'`, "bad_codec", `use one of: auto, ${Object.keys(CODECS).join(", ")}`);
  if (gif && want !== "auto") throw new EditError(`codec '${want}' does not apply to .gif`, "bad_codec", "omit codec for .gif, or export .mp4/.mov/.webm");
  const transparent = parseColor(tl.settings.background ?? "#000000")[3] === 0;
  const wantAlpha = o.alpha ?? transparent;
  let codec: VideoCodec = gif ? "h264" : want === "auto" ? FORMATS[ext].codec : want;
  if (want === "auto" && wantAlpha && ext === ".mov") codec = "prores_4444"; // transparent .mov -> ProRes 4444 with alpha
  if (!gif && !CODECS[codec].exts.includes(ext))
    throw new EditError(`codec '${codec}' can't be written to ${ext}`, "bad_codec",
      `${codec} goes in ${CODECS[codec].exts.join("/")}; for ${ext} use ${Object.entries(CODECS).filter(([, c]) => c.exts.includes(ext)).map(([k]) => k).join(" or ")} (or codec auto)`);
  const canAlpha = !gif && CODECS[codec].alpha.includes(ext);
  if (o.alpha === true && !canAlpha)
    throw new EditError(`${gif ? "gif" : `${codec} in ${ext}`} can't keep an alpha channel`, "bad_codec",
      "for transparent video export .mov (codec prores_4444) or .webm (codec vp9)");
  const alpha = wantAlpha && canAlpha;
  const warnings: string[] = [];
  if (transparent && !alpha && o.alpha !== false)
    warnings.push(`background is transparent but ${gif ? "gif" : `${codec} in ${ext}`} has no alpha: alpha dropped, frames composited on black (export .mov with codec prores_4444, or .webm, to keep transparency)`);
  if (alpha && !transparent)
    warnings.push("alpha is on but settings.background is opaque, so every pixel is opaque; set background to '#00000000' for a transparent export");
  const { v, mux } = videoArgs(codec, o.quality ?? "standard", !!o.hwEncode, alpha, ext);
  return { codec, alpha, v, mux, a: [...(FORMATS[gif ? ".mp4" : ext]?.audio ?? [])], warnings, transparent };
}

export interface SegmentJob { tl: Timeline; root: string; scale: number; fontDirs: string[]; t0: number; i0: number; i1: number; v: string[]; out: string }

/** Where a render writes before it is renamed to `output`: `<name>.part-<pid>-<rand><ext>` (ext kept so ffmpeg picks the muxer;
 *  cache.ts treats the name as in flight while the pid lives). `output` itself never holds a partial or truncated file. */
const partPath = (output: string) => { const ext = extname(output); return `${output.slice(0, output.length - ext.length)}.part-${process.pid}-${randomBytes(3).toString("hex")}${ext}`; };

/** Scratch dir of one render: `<project>/.agentcut/tmp/render-<pid>-<rand>/`. The pid lets cache.ts sweepStale remove it after a crash. */
const renderTmp = (root: string) => { const base = join(root, ".agentcut", "tmp"); mkdirSync(base, { recursive: true }); return mkdtempSync(join(base, `render-${process.pid}-`)); };

/** Render frames [i0, i1) to `out` (video only, or muxed with audio when given). `signal` stops the encoder and ends the loop. */
export async function encodeFrames(r: Renderer, t0: number, i0: number, i1: number, v: string[], out: string,
  audio?: { wav: string; a: string[] }, onFrame?: (done: number) => void, signal?: AbortSignal) {
  const fps = r.fps, n = i1 - i0;
  const args = ["-v", "error", "-y", "-nostdin", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${r.W}x${r.H}`, "-r", String(fps), "-i", "-"];
  if (audio) args.push("-i", audio.wav, "-map", "0:v", "-map", "1:a");
  args.push(...v, ...(audio ? audio.a : ["-an"]), "-t", (n / fps).toFixed(6), out);
  const enc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  enc.stderr!.on("data", (d) => { if (err.length < 4000) err += d; });
  const exited = once(enc, "exit");
  stopOnAbort(enc, signal);
  let broken = false, failed = true;
  enc.stdin!.on("error", () => { broken = true; });
  try {
    for (let i = i0; i < i1 && !broken && enc.exitCode === null; i++) {
      signal?.throwIfAborted();
      await r.frame(t0 + i / fps);
      // a stopped or crashed encoder never drains: wake up when it exits
      if (!enc.stdin!.write(r.pixels())) await Promise.race([once(enc.stdin!, "drain").catch(() => {}), exited]);
      onFrame?.(i - i0 + 1);
    }
    failed = false;
  } finally {
    enc.stdin!.end();
    r.close();
    // a frame/progress error: stop the encoder and wait for it, so the caller can delete `out` without ffmpeg touching it again
    if (failed) { enc.kill(); await exited; }
  }
  signal?.throwIfAborted();
  const [code] = await exited;
  if (code !== 0) throw new EditError(`encoder failed: ${err.slice(-600)}`, "encode_failed");
}

/** How to start a worker: compiled Bun binary re-invokes itself; otherwise run segment-worker with the same runtime. */
function workerCommand(): string[] {
  const here = fileURLToPath(import.meta.url);
  if (here.includes("$bunfs") || here.includes("~BUN")) return [process.execPath, "__segment"];
  const ext = extname(here);
  return [process.execPath, join(dirname(here), `segment-worker${ext}`)];
}

export function defaultWorkers(frames: number, fps: number) {
  const cpus = availableParallelism?.() ?? 4;
  return Math.max(1, Math.min(8, Math.floor(cpus / 2), Math.floor(frames / (fps * 3)) || 1));
}

export interface RenderOpts {
  start?: number; end?: number; scale?: number; quality?: string; workers?: number; hwEncode?: boolean;
  fontDirs?: string[]; progress?: (done: number, total: number) => void;
  /** Abort the render: encoders and workers are stopped, the tmp dir and part file are removed, the call rejects with signal.reason. */
  signal?: AbortSignal;
  /** Video codec; "auto" (default) picks by extension: .mp4/.m4v/.mkv h264, .mov prores (prores_4444 when alpha), .webm vp9. */
  codec?: Codec | string;
  /** Keep transparency. Default: on when settings.background is fully transparent and the codec/container supports alpha. */
  alpha?: boolean;
}

/** Audio-only export: mix the range and encode it; no frames are rendered. */
async function renderAudio(tl: Timeline, root: string, output: string, ext: string, o: RenderOpts) {
  const fmt = AUDIO_FORMATS[ext];
  if (o.codec && o.codec !== "auto") throw new EditError(`codec '${o.codec}' is a video codec; ${ext} is an audio-only export`, "bad_codec", "omit codec for audio exports");
  if (o.alpha) throw new EditError(`alpha doesn't apply to audio-only ${ext}`, "bad_codec", "omit alpha, or export .mov/.webm for transparent video");
  needEncoder(fmt.args[1], ext);
  const T = totalDuration(resolve(structuredClone(tl)));
  const start = o.start ?? 0, end = Math.min(o.end ?? T, T);
  if (end - start <= 0) throw new EditError("nothing to render (duration is 0 or range empty)", "empty", "add clips or fix --from/--to");
  const warnings: string[] = [];
  if (!audioSources(tl).length) warnings.push("timeline has no audible clips: the export is silence");
  mkdirSync(dirname(output), { recursive: true });
  const began = performance.now();
  const tmp = renderTmp(root), part = partPath(output);
  try {
    const wav = buildAudio(structuredClone(tl), join(tmp, "mix.wav"), start, end);
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-nostdin", "-i", wav, "-map", "0:a", ...fmt.args, "-t", (end - start).toFixed(6), part], { encoding: "utf8" });
    if (r.status !== 0) throw new EditError(`audio encode failed: ${(r.stderr || "").slice(-600)}`, "encode_failed");
    renameSync(part, output);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    rmSync(part, { force: true });
  }
  const el = (performance.now() - began) / 1000;
  const res: Record<string, unknown> = {
    output, duration: +(end - start).toFixed(3), audio_only: true, codec: fmt.codec, range: [start, end],
    render_seconds: +el.toFixed(2), speed_x: +((end - start) / el).toFixed(2), size_bytes: statSync(output).size,
  };
  if (warnings.length) res.warnings = warnings;
  return res;
}

export async function renderVideo(tl: Timeline, root: string, output: string, o: RenderOpts = {}) {
  needFfmpeg();
  o.signal?.throwIfAborted();
  const ext = extname(output).toLowerCase();
  if (AUDIO_FORMATS[ext]) return renderAudio(tl, root, output, ext, o);
  const gif = ext === ".gif";
  if (!gif && !FORMATS[ext]) throw new EditError(`unsupported output format '${ext}'`, "bad_format", `use ${ALL_EXTS}`);
  const quality = o.quality ?? "standard";
  const plan = planOutput(ext, tl, { codec: o.codec, alpha: o.alpha, quality, hwEncode: o.hwEncode });
  const { v, mux, a } = plan;
  // alpha dropped: render on opaque black so semi-transparent edges are composited, not shown at full strength
  const rtl = plan.transparent && !plan.alpha ? { ...tl, settings: { ...tl.settings, background: "#000000" } } : tl;
  mkdirSync(dirname(output), { recursive: true });
  const scale = gif ? Math.min(o.scale ?? 1, 0.5) : o.scale ?? 1;
  const probe = new Renderer(structuredClone(rtl), root, scale);
  const T = probe.duration, fps = probe.fps, W = probe.W, H = probe.H;
  probe.close();
  const start = o.start ?? 0, end = Math.min(o.end ?? T, T);
  if (end - start <= 0) throw new EditError("nothing to render (duration is 0 or range empty)", "empty", "add clips or fix --from/--to");
  const n = Math.round((end - start) * fps);
  const workers = Math.max(1, o.workers ?? defaultWorkers(n, fps));
  const began = performance.now();
  const tmp = renderTmp(root), part = partPath(output);
  try {
    const wav = join(tmp, "mix.wav");
    const audioJob = Promise.resolve().then(() => buildAudio(structuredClone(tl), wav, start, end));
    const target = gif ? join(tmp, "tmp.mp4") : part;
    if (workers <= 1) {
      await audioJob;
      await encodeFrames(new Renderer(structuredClone(rtl), root, scale), start, 0, n, [...v, ...mux], target, { wav, a }, (d) => o.progress?.(d, n), o.signal);
    } else {
      // segments are joined with `-c:v copy`, so their container must carry the codec (and alpha) losslessly
      const segExt = ext === ".mov" ? ".mov" : ext === ".webm" ? ".webm" : ".mkv";
      const bounds = Array.from({ length: workers + 1 }, (_, k) => Math.round((n * k) / workers));
      const jobs: SegmentJob[] = [];
      for (let k = 0; k < workers; k++) if (bounds[k + 1] > bounds[k])
        jobs.push({ tl: rtl, root, scale, fontDirs: o.fontDirs ?? [], t0: start, i0: bounds[k], i1: bounds[k + 1], v, out: join(tmp, `seg${String(k).padStart(3, "0")}${segExt}`) });
      const done = new Array(jobs.length).fill(0);
      const cmd = workerCommand();
      // the first failure (a worker, the audio mix, or the caller's abort) stops every other worker; all of them have exited
      // before the tmp dir is removed, and the first failure is the one reported
      const stop = new AbortController();
      const relay = () => stop.abort(o.signal!.reason);
      o.signal?.addEventListener("abort", relay, { once: true });
      let first: unknown;
      const guarded = <T,>(pr: Promise<T>) => pr.catch((e) => { first ??= e; stop.abort(); throw e; });
      await Promise.allSettled([guarded(audioJob), ...jobs.map((job, k) => guarded((async () => {
        const jf = join(tmp, `job${k}.json`);
        writeFileSync(jf, JSON.stringify(job));
        const p = spawn(cmd[0], [...cmd.slice(1), jf], { stdio: ["ignore", "pipe", "pipe"] });
        stopOnAbort(p, stop.signal);
        let err = "", buf = "";
        p.stderr!.on("data", (d) => { if (err.length < 4000) err += d; });
        p.stdout!.on("data", (d) => {
          buf += d;
          const lines = buf.split("\n"); buf = lines.pop()!;
          for (const l of lines) if (l.startsWith("P ")) { done[k] = +l.slice(2); o.progress?.(done.reduce((x, y) => x + y, 0), n); }
        });
        const [code] = await once(p, "exit");
        if (code !== 0) throw new EditError(`render worker ${k} failed: ${err.slice(-800)}`, "render_failed");
      })()))]);
      o.signal?.removeEventListener("abort", relay);
      o.signal?.throwIfAborted();
      if (first) throw first;
      const list = join(tmp, "list.txt");
      writeFileSync(list, jobs.map((j) => `file '${j.out.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`).join(""));
      const cc = spawnSync("ffmpeg", ["-v", "error", "-y", "-nostdin", "-f", "concat", "-safe", "0", "-i", list, "-i", wav,
        "-map", "0:v", "-map", "1:a", "-c:v", "copy", ...mux, ...a, "-t", (n / fps).toFixed(6), target], { encoding: "utf8" });
      if (cc.status !== 0) throw new EditError(`concat failed: ${(cc.stderr || "").slice(-600)}`, "encode_failed");
    }
    if (gif) {
      const g = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", target, "-vf",
        `fps=${Math.min(fps, 15)},scale=${Math.min(W, 540)}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, part], { encoding: "utf8" });
      if (g.status !== 0) throw new EditError(`gif conversion failed: ${(g.stderr || "").slice(-400)}`, "encode_failed");
    }
    renameSync(part, output);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    rmSync(part, { force: true });
  }
  const el = (performance.now() - began) / 1000;
  const res: Record<string, unknown> = {
    output, duration: +(n / fps).toFixed(3), frames: n, width: W, height: H, fps, range: [start, end], workers,
    codec: gif ? "gif" : plan.codec, alpha: plan.alpha, encoder: v[1],
    render_seconds: +el.toFixed(2), speed_x: +((n / fps) / el).toFixed(2), size_bytes: statSync(output).size,
  };
  if (plan.warnings.length) res.warnings = plan.warnings;
  return res;
}
