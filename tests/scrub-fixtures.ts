// The fixtures the scrub measurement (tests/scrub-measure.ts) runs on, built from parameters kept here so that numbers can be compared.
//   src.mp4    1920x1080 30 fps 60 s H.264 High + AAC, a test pattern with temporal noise, about 42 MB, a keyframe every 5-6 s
//   short.mp4  the same picture and encode as src.mp4 with a keyframe forced every 1.5 s
//   music.m4a  30 min AAC tone
//   k4.mp4     3840x2160 30 fps 60 s HEVC with a keyframe every 10 s (VideoToolbox: one build shows its size and GOP, not that they reproduce; the bytes are not expected to)
//   tl1 one 60 s clip; tl2 40 cuts of 1.5 s; tl1s / tl2s the same two on short.mp4; tl3 six 10 s clips with 0.6 s crossfades, a grade each, a whole-video vignette and two titles;
//   tl10 / tl30 100 / 300 clips of 6.02 s with a crossfade on every 5th, titles and the music (590 s / 1770 s); k4 one clip of k4.mp4.
//   p540-gop.mp4 / p540-intra.mp4  src.mp4 scaled to 960x540, video only, libx264 veryfast crf 23, a keyframe every 1.5 s / every frame (the proxy-like files; one build each, its wall time, load and size are printed)
// Run: bun --no-install tests/scrub-fixtures.ts <dir> [all|media|projects|floor|proxy]    (needs ffmpeg and ffprobe; AGENTCUT_HOME and AGENTCUT_CACHE must already point at isolated dirs)
//   floor builds src.mp4 and short.mp4 only (what the floor modes of tests/scrub-measure.ts need); proxy builds the two p540 files from an existing src.mp4.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const NAMES = ["tl1", "tl2", "tl1s", "tl2s", "tl3", "tl10", "tl30", "k4"] as const;
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

const load = () => spawnSync("uptime", { encoding: "utf8" }).stdout.trim().replace(/^.*load averages?: /, "");

/** The times (s) of the keyframes of a video file. */
export function keyframes(f: string): number[] {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", f], { encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error(`ffprobe failed: ${r.stderr}`);
  return r.stdout.split("\n").map((s) => s.replace(/,$/, "").trim()).filter(Boolean).map(Number).sort((a, b) => a - b);
}

export const mediaDir = (dir: string) => join(dir, "media");
export const projectDir = (dir: string, name: Name) => join(dir, "projects", name);
export const SRC_FILE = (dir: string) => join(mediaDir(dir), "src.mp4");
export const SHORT_FILE = (dir: string) => join(mediaDir(dir), "short.mp4");
export const GOP_PROXY_FILE = (dir: string) => join(mediaDir(dir), "p540-gop.mp4");
export const INTRA_PROXY_FILE = (dir: string) => join(mediaDir(dir), "p540-intra.mp4");
const MUSIC_FILE = (dir: string) => join(mediaDir(dir), "music.m4a");
const K4_FILE = (dir: string) => join(mediaDir(dir), "k4.mp4");

/** src.mp4 and short.mp4: the 1080p sources the floor modes read. */
export function buildSources(dir: string) {
  mkdirSync(mediaDir(dir), { recursive: true });
  const h264 = (out: string, ...gop: string[]) => ff("-f", "lavfi", "-i", PATTERN(1920, 1080, 60), "-f", "lavfi", "-i", TONE(440, 60), "-c:v", "libx264", "-profile:v", "high", "-b:v", `${SRC.kbps}k`, "-preset", SRC.preset,
    ...gop, "-c:a", "aac", "-b:a", "128k", "-shortest", out);
  h264(SRC_FILE(dir));
  h264(SHORT_FILE(dir), "-g", "45", "-keyint_min", "45", "-sc_threshold", "0"); // a keyframe every 45 frames = 1.5 s
}

/** The proxy-like files, built from src.mp4: 960x540 (the frame of a scale=0.5 request on a 1080p project), video only. veryfast because a prepare step would trade size for speed.
 *  Each is one build; its wall time, the load around it and its size are returned. */
export function buildProxies(dir: string) {
  if (!existsSync(SRC_FILE(dir))) throw new Error(`${SRC_FILE(dir)} is missing: build it first with: bun tests/scrub-fixtures.ts ${dir} floor`);
  const out: Record<string, { build_s: number; bytes: number; load_before: string; load_after: string; gop: string[] }> = {};
  for (const [f, gop] of [[GOP_PROXY_FILE(dir), ["-g", "45", "-keyint_min", "45", "-sc_threshold", "0"]], [INTRA_PROXY_FILE(dir), ["-g", "1", "-sc_threshold", "0"]]] as const) {
    const load_before = load(), t = performance.now();
    ff("-i", SRC_FILE(dir), "-an", "-vf", "scale=960:540:flags=bicubic,format=yuv420p", "-c:v", "libx264", "-profile:v", "high", "-preset", "veryfast", "-crf", "23", ...gop, f);
    out[basename(f)] = { build_s: Math.round((performance.now() - t) / 100) / 10, bytes: statSync(f).size, load_before, load_after: load(), gop: [...gop] };
  }
  return out;
}

export function buildMedia(dir: string) {
  buildSources(dir);
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
  const music = MUSIC_FILE(dir), src = name === "tl1s" || name === "tl2s" ? SHORT_FILE(dir) : SRC_FILE(dir);
  if (name === "tl1" || name === "tl1s") return { ops: [clip(src, 0, 60)], duration: 60 };
  if (name === "k4") return { ops: [clip(K4_FILE(dir), 0, 60)], duration: 60 };
  if (name === "tl2" || name === "tl2s") return { ops: Array.from({ length: 40 }, (_, i) => clip(src, ((7 * i) % 39) * 1.5, 1.5)), duration: 60 }; // on short.mp4 every in-point is a keyframe
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

/** Lists the media files that exist, each with its full keyframe list, so a keyframe distance can be checked from the manifest alone. */
export function manifest(dir: string, projects: Record<string, unknown>, name = "manifest.json", builds: Record<string, unknown> = {}) {
  const files = [SRC_FILE(dir), SHORT_FILE(dir), GOP_PROXY_FILE(dir), INTRA_PROXY_FILE(dir), MUSIC_FILE(dir), K4_FILE(dir)].filter(existsSync).map((f) => {
    const kf = keyframes(f);
    return { file: f, bytes: statSync(f).size, sha256: sha256(f), keyframes: kf.length, keyframes_s: kf };
  });
  const m = { ffmpeg: spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0], src: SRC, files, projects, builds };
  writeFileSync(join(dir, name), JSON.stringify(m, null, 2));
  return m;
}

const PARTS = ["all", "media", "projects", "floor", "proxy"];
if (import.meta.main) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : "", part = process.argv[3] ?? "all";
  if (!dir || !PARTS.includes(part)) throw new Error(`usage: bun tests/scrub-fixtures.ts <dir> [${PARTS.join("|")}]`);
  if (!process.env.AGENTCUT_HOME || !process.env.AGENTCUT_CACHE) throw new Error("AGENTCUT_HOME and AGENTCUT_CACHE must point at isolated dirs");
  if ((part === "all" || part === "projects") && existsSync(join(dir, "projects"))) throw new Error(`${dir}/projects exists: remove it by hand first (this build creates projects, it does not overwrite them)`);
  const r1 = (ms: number) => Math.round(ms / 100) / 10;
  if (part === "floor" || part === "proxy") {
    const load_before = load(), t0 = performance.now();
    const builds = part === "floor" ? (buildSources(dir), {}) : buildProxies(dir);
    console.log(JSON.stringify({ part, build_s: r1(performance.now() - t0), load_before, load_after: load(), ...manifest(dir, {}, `manifest-${part}.json`, builds) }, null, 1));
  } else {
    const t0 = performance.now();
    if (part !== "projects") buildMedia(dir);
    const t1 = performance.now();
    const projects = part === "media" ? {} : await buildProjects(dir);
    console.log(JSON.stringify({ media_s: r1(t1 - t0), projects_s: r1(performance.now() - t1), ...manifest(dir, projects) }, null, 1));
  }
}
