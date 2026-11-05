// Video export: frames -> FFmpeg with back-pressure; long renders are split into segments rendered by
// parallel worker processes (one Skia compositor per core pair) and joined losslessly.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAudio } from "./audio.ts";
import { needFfmpeg } from "./media.ts";
import { EditError, type Timeline } from "./model.ts";
import { Renderer } from "./render.ts";

export const FORMATS: Record<string, [string[], string[]]> = {
  ".mp4": [["-c:v", "libx264", "-pix_fmt", "yuv420p"], ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]],
  ".m4v": [["-c:v", "libx264", "-pix_fmt", "yuv420p"], ["-c:a", "aac", "-b:a", "192k"]],
  ".mov": [["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"], ["-c:a", "pcm_s16le"]],
  ".webm": [["-c:v", "libvpx-vp9", "-b:v", "0", "-row-mt", "1", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p"], ["-c:a", "libopus", "-b:a", "160k"]],
  ".mkv": [["-c:v", "libx264", "-pix_fmt", "yuv420p"], ["-c:a", "aac", "-b:a", "192k"]],
};
export const QUALITY: Record<string, { crf: number; preset: string; vp9: number }> = {
  draft: { crf: 30, preset: "ultrafast", vp9: 40 },
  standard: { crf: 20, preset: "veryfast", vp9: 32 },
  high: { crf: 16, preset: "slow", vp9: 24 },
};

let vtChecked: boolean | null = null;
function hasVideoToolbox() {
  if (vtChecked === null) {
    const r = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
    vtChecked = process.platform === "darwin" && /h264_videotoolbox/.test(r.stdout || "");
  }
  return vtChecked;
}

export function videoArgs(ext: string, quality: string, hwEncode: boolean): { v: string[]; a: string[] } {
  const [v0, a] = FORMATS[ext];
  const q = QUALITY[quality] ?? QUALITY.standard;
  let v = [...v0];
  if (v.includes("libx264")) {
    if (hwEncode && hasVideoToolbox()) v = ["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", "-q:v", String(quality === "high" ? 75 : quality === "draft" ? 45 : 62), "-allow_sw", "1"];
    else v.push("-crf", String(q.crf), "-preset", q.preset);
  }
  if (v.includes("libvpx-vp9")) v.push("-crf", String(q.vp9));
  return { v, a: [...a] };
}

export interface SegmentJob { tl: Timeline; root: string; scale: number; fontDirs: string[]; t0: number; i0: number; i1: number; v: string[]; out: string }

/** Render frames [i0, i1) to `out` (video only, or muxed with audio when given). */
export async function encodeFrames(r: Renderer, t0: number, i0: number, i1: number, v: string[], out: string,
  audio?: { wav: string; a: string[] }, onFrame?: (done: number) => void) {
  const fps = r.fps, n = i1 - i0;
  const args = ["-v", "error", "-y", "-nostdin", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${r.W}x${r.H}`, "-r", String(fps), "-i", "-"];
  if (audio) args.push("-i", audio.wav, "-map", "0:v", "-map", "1:a");
  args.push(...v, ...(audio ? audio.a : ["-an"]), "-t", (n / fps).toFixed(6), out);
  const enc = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  enc.stderr!.on("data", (d) => { if (err.length < 4000) err += d; });
  const exited = once(enc, "exit");
  let broken = false;
  enc.stdin!.on("error", () => { broken = true; });
  try {
    for (let i = i0; i < i1 && !broken; i++) {
      await r.frame(t0 + i / fps);
      if (!enc.stdin!.write(r.pixels())) await once(enc.stdin!, "drain");
      onFrame?.(i - i0 + 1);
    }
  } finally {
    enc.stdin!.end();
    r.close();
  }
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
  return Math.max(1, Math.min(8, Math.floor(cpus / 2), Math.floor(frames / (fps * 1.5)) || 1));
}

export interface RenderOpts {
  start?: number; end?: number; scale?: number; quality?: string; workers?: number; hwEncode?: boolean;
  fontDirs?: string[]; progress?: (done: number, total: number) => void;
}

export async function renderVideo(tl: Timeline, root: string, output: string, o: RenderOpts = {}) {
  needFfmpeg();
  const ext = extname(output).toLowerCase();
  const gif = ext === ".gif";
  if (!gif && !FORMATS[ext]) throw new EditError(`unsupported output format '${ext}'`, "bad_format", "use .mp4, .mov, .webm, .mkv or .gif");
  mkdirSync(dirname(output), { recursive: true });
  const scale = gif ? Math.min(o.scale ?? 1, 0.5) : o.scale ?? 1;
  const probe = new Renderer(structuredClone(tl), root, scale);
  const T = probe.duration, fps = probe.fps, W = probe.W, H = probe.H;
  probe.close();
  const start = o.start ?? 0, end = Math.min(o.end ?? T, T);
  if (end - start <= 0) throw new EditError("nothing to render (duration is 0 or range empty)", "empty", "add clips or fix --from/--to");
  const n = Math.round((end - start) * fps);
  const quality = o.quality ?? "standard";
  const { v, a } = videoArgs(gif ? ".mp4" : ext, quality, !!o.hwEncode);
  const workers = Math.max(1, o.workers ?? defaultWorkers(n, fps));
  const began = performance.now();
  const tmp = mkdtempSync(join(tmpdir(), "agentcut-"));
  try {
    const wav = join(tmp, "mix.wav");
    const audioJob = Promise.resolve().then(() => buildAudio(structuredClone(tl), wav, start, end));
    const target = gif ? join(tmp, "tmp.mp4") : output;
    if (workers <= 1) {
      await audioJob;
      await encodeFrames(new Renderer(structuredClone(tl), root, scale), start, 0, n, v, target, { wav, a }, (d) => o.progress?.(d, n));
    } else {
      const segExt = ext === ".mov" ? ".mov" : ext === ".webm" ? ".webm" : ".mkv";
      const bounds = Array.from({ length: workers + 1 }, (_, k) => Math.round((n * k) / workers));
      const jobs: SegmentJob[] = [];
      for (let k = 0; k < workers; k++) if (bounds[k + 1] > bounds[k])
        jobs.push({ tl, root, scale, fontDirs: o.fontDirs ?? [], t0: start, i0: bounds[k], i1: bounds[k + 1], v, out: join(tmp, `seg${String(k).padStart(3, "0")}${segExt}`) });
      const done = new Array(jobs.length).fill(0);
      const cmd = workerCommand();
      await Promise.all([audioJob, ...jobs.map(async (job, k) => {
        const jf = join(tmp, `job${k}.json`);
        writeFileSync(jf, JSON.stringify(job));
        const p = spawn(cmd[0], [...cmd.slice(1), jf], { stdio: ["ignore", "pipe", "pipe"] });
        let err = "", buf = "";
        p.stderr!.on("data", (d) => { if (err.length < 4000) err += d; });
        p.stdout!.on("data", (d) => {
          buf += d;
          const lines = buf.split("\n"); buf = lines.pop()!;
          for (const l of lines) if (l.startsWith("P ")) { done[k] = +l.slice(2); o.progress?.(done.reduce((x, y) => x + y, 0), n); }
        });
        const [code] = await once(p, "exit");
        if (code !== 0) throw new EditError(`render worker ${k} failed: ${err.slice(-800)}`, "render_failed");
      })]);
      const list = join(tmp, "list.txt");
      writeFileSync(list, jobs.map((j) => `file '${j.out.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\n`).join(""));
      const cc = spawnSync("ffmpeg", ["-v", "error", "-y", "-nostdin", "-f", "concat", "-safe", "0", "-i", list, "-i", wav,
        "-map", "0:v", "-map", "1:a", "-c:v", "copy", ...a, "-t", (n / fps).toFixed(6), target], { encoding: "utf8" });
      if (cc.status !== 0) throw new EditError(`concat failed: ${(cc.stderr || "").slice(-600)}`, "encode_failed");
    }
    if (gif) {
      const g = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", target, "-vf",
        `fps=${Math.min(fps, 15)},scale=${Math.min(W, 540)}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, output], { encoding: "utf8" });
      if (g.status !== 0) throw new EditError(`gif conversion failed: ${(g.stderr || "").slice(-400)}`, "encode_failed");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const el = (performance.now() - began) / 1000;
  return {
    output, duration: +(n / fps).toFixed(3), frames: n, width: W, height: H, fps, range: [start, end], workers,
    encoder: v[1], render_seconds: +el.toFixed(2), speed_x: +((n / fps) / el).toFixed(2), size_bytes: statSync(output).size,
  };
}
