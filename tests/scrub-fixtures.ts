// The fixtures the scrub measurement (tests/scrub-measure.ts) runs on, built from parameters kept here so that numbers can be compared.
//   src.mp4    1920x1080 30 fps 60 s H.264 High + AAC, a test pattern with temporal noise, about 42 MB, a keyframe every 5-6 s
//   music.m4a  30 min AAC tone
//   k4.mp4     3840x2160 30 fps 60 s HEVC with a keyframe every 10 s (VideoToolbox: the size and the GOP are reproducible, the bytes are not)
//   tl1 one 60 s clip; tl2 40 cuts of 1.5 s; tl3 six 10 s clips with 0.6 s crossfades, a grade each, a whole-video vignette and two titles;
//   tl10 / tl30 100 / 300 clips of 6.02 s with a crossfade on every 5th, titles and the music (590 s / 1770 s); k4 one clip of k4.mp4.
// Run: bun --no-install tests/scrub-fixtures.ts <dir>    (needs ffmpeg and ffprobe; AGENTCUT_HOME and AGENTCUT_CACHE must already point at isolated dirs)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const NAMES = ["tl1", "tl2", "tl3", "tl10", "tl30", "k4"] as const;
export type Name = (typeof NAMES)[number];

/** Source picture and encode. The noise strength and the bitrate were tuned until the file matched the measured one (about 42 MB, a keyframe every 5-6 s). */
const SRC = { noise: 3, kbps: 5500, preset: "medium" };
const NOISE = (n: number) => `noise=alls=${n}:allf=t:all_seed=1`;
const PATTERN = (w: number, h: number, secs: number) => `testsrc2=s=${w}x${h}:r=30:d=${secs},${NOISE(SRC.noise)},format=yuv420p`;
const TONE = (f: number, secs: number) => `sine=f=${f}:r=48000:d=${secs}`;

function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

const sha256 = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** The times (s) of the keyframes of a video file. */
function keyframes(f: string): number[] {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", f], { encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return r.stdout.split("\n").map((s) => s.replace(/,$/, "").trim()).filter(Boolean).map(Number).sort((a, b) => a - b);
}

export const mediaDir = (dir: string) => join(dir, "media");
export const projectDir = (dir: string, name: Name) => join(dir, "projects", name);
const SRC_FILE = (dir: string) => join(mediaDir(dir), "src.mp4");
const MUSIC_FILE = (dir: string) => join(mediaDir(dir), "music.m4a");
const K4_FILE = (dir: string) => join(mediaDir(dir), "k4.mp4");

export function buildMedia(dir: string) {
  mkdirSync(mediaDir(dir), { recursive: true });
  ff("-f", "lavfi", "-i", PATTERN(1920, 1080, 60), "-f", "lavfi", "-i", TONE(440, 60), "-c:v", "libx264", "-profile:v", "high", "-b:v", `${SRC.kbps}k`, "-preset", SRC.preset,
    "-c:a", "aac", "-b:a", "128k", "-shortest", SRC_FILE(dir));
  ff("-f", "lavfi", "-i", TONE(220, 1800), "-c:a", "aac", "-b:a", "128k", MUSIC_FILE(dir));
  ff("-f", "lavfi", "-i", PATTERN(3840, 2160, 60), "-f", "lavfi", "-i", TONE(440, 60), "-c:v", "hevc_videotoolbox", "-b:v", "45M", "-g", "300", "-tag:v", "hvc1",
    "-c:a", "aac", "-b:a", "128k", "-shortest", K4_FILE(dir));
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const SEG = 6.02, XF = 0.6;

type Ops = Record<string, unknown>[];
const clip = (src: string, at: number, dur: number, extra: Record<string, unknown> = {}) => ({ op: "add_clip", track: "main", src, in: round3(at), duration: dur, ...extra });
const title = (text: string, at: number, dur: number, preset: string, extra: Record<string, unknown> = {}) => ({ op: "add_clip", track: "text", text, at: round3(at), duration: dur, preset, ...extra });
const crossfade = { type: "crossfade", duration: XF };

/** The ops of each timeline and the length it must come to. */
function plan(dir: string, name: Name): { ops: Ops; duration: number } {
  const src = SRC_FILE(dir), music = MUSIC_FILE(dir);
  if (name === "tl1") return { ops: [clip(src, 0, 60)], duration: 60 };
  if (name === "k4") return { ops: [clip(K4_FILE(dir), 0, 60)], duration: 60 };
  if (name === "tl2") return { ops: Array.from({ length: 40 }, (_, i) => clip(src, ((7 * i) % 39) * 1.5, 1.5)), duration: 60 };
  if (name === "tl3") {
    const grade = { exposure: 0.15, contrast: 1.12, saturation: 1.2 };
    return {
      ops: [
        ...Array.from({ length: 6 }, (_, i) => clip(src, i * 10, 10, { color: grade, ...(i ? { transition: crossfade } : {}) })),
        title("OPENING TITLE", 1, 8, "title_bold", { position: "top", margin: "14%" }),
        title("SUBTITLE", 2, 6, "subtitle_box", { y: "62%" }),
        { op: "add_effect", type: "vignette", intensity: 0.6 },
      ],
      duration: 57,
    };
  }
  const n = name === "tl10" ? 100 : 300, titles = name === "tl10" ? 4 : 10;
  const fades = n / 5, duration = round3(n * SEG - fades * XF);
  return {
    ops: [
      ...Array.from({ length: n }, (_, i) => clip(src, (i * 13.7) % (60 - SEG), SEG, i % 5 === 4 ? { transition: crossfade } : {})),
      { op: "add_clip", track: "music", src: music, until_end: true },
      ...Array.from({ length: titles }, (_, k) => title(`TITLE ${k + 1}`, ((k + 0.5) * duration) / titles, 4, "title_bold", { position: "top" })),
    ],
    duration,
  };
}

export async function buildProjects(dir: string) {
  const api = await import("./author-api.ts"); // after the caller's isolated AGENTCUT_HOME is in place
  const out: Record<string, { duration: number; revision: number }> = {};
  for (const name of NAMES) {
    const root = projectDir(dir, name);
    api.create(root, { name });
    const { ops, duration } = plan(dir, name);
    const r = await api.apply(root, ops, { revision: 0, label: `build ${name}` }); // a new project is at revision 0; the result's revision is the next one to pass
    if (Math.abs(r.duration - duration) > 1e-6) throw new Error(`${name}: duration ${r.duration}, expected ${duration}`);
    out[name] = { duration: r.duration, revision: r.revision };
  }
  return out;
}

export function manifest(dir: string, projects: Record<string, unknown>) {
  const files = [SRC_FILE(dir), MUSIC_FILE(dir), K4_FILE(dir)].map((f) => {
    const kf = keyframes(f);
    return { file: f, bytes: statSync(f).size, sha256: sha256(f), keyframes: kf.length, keyframe_gaps_s: kf.slice(1).map((t, i) => Math.round((t - kf[i]) * 100) / 100).slice(0, 12) };
  });
  const m = { ffmpeg: spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0], src: SRC, files, projects };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  return m;
}

if (import.meta.main) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : "", part = process.argv[3] ?? "all";
  if (!dir || !["all", "media", "projects"].includes(part)) throw new Error("usage: bun tests/scrub-fixtures.ts <dir> [media|projects]");
  if (!process.env.AGENTCUT_HOME || !process.env.AGENTCUT_CACHE) throw new Error("AGENTCUT_HOME and AGENTCUT_CACHE must point at isolated dirs");
  if (part !== "media" && existsSync(join(dir, "projects"))) throw new Error(`${dir}/projects exists: remove it by hand first (this build creates projects, it does not overwrite them)`);
  const t0 = performance.now();
  if (part !== "projects") buildMedia(dir);
  const t1 = performance.now();
  const projects = part === "media" ? {} : await buildProjects(dir);
  console.log(JSON.stringify({ media_s: Math.round((t1 - t0) / 100) / 10, projects_s: Math.round((performance.now() - t1) / 100) / 10, ...manifest(dir, projects) }, null, 1));
}
