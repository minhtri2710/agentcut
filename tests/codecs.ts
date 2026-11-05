// Output codec / alpha / audio-only export tests: calls renderVideo directly on a tiny synthetic project.
// Run: bun tests/codecs.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-codecs-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store - set before importing the API
const api = await import("../src/api.ts");
const { renderVideo } = await import("../src/encode.ts");
const { openProject } = api;

let failures = 0;
const t0 = performance.now();
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}
function probe(f: string): { streams: any[]; format: any } {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f], { encoding: "utf8" });
  return JSON.parse(r.stdout);
}
/** Decode one frame at t to straight RGBA bytes. */
function rgbaFrame(f: string, t: number, vp9 = false): Buffer {
  const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", ...(vp9 ? ["-c:v", "libvpx-vp9"] : []), "-ss", String(t), "-i", f,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
  return r.stdout as Buffer;
}
const W = 320, H = 240;
const px = (b: Buffer, x: number, y: number) => Array.from(b.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));
const maxAlpha = (b: Buffer) => { let m = 0; for (let i = 3; i < b.length; i += 4) if (b[i] > m) m = b[i]; return m; };
async function timed<T>(label: string, f: () => Promise<T>): Promise<T> {
  const s = performance.now();
  const r = await f();
  console.log(`  - ${label}: ${((performance.now() - s) / 1000).toFixed(2)}s`);
  return r;
}
async function expectError(f: () => Promise<unknown>) {
  try { await f(); return null; } catch (e: any) { return e; }
}

const m = join(tmp, "media");
mkdirSync(m);
console.log("media ->", tmp);
ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", "-pix_fmt", "yuv420p", join(m, "v.mp4"));
ff("-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-ac", "2", join(m, "music.wav"));

const P = join(tmp, "proj");
api.create(P, { width: W, height: H, fps: 24 });
await api.apply(P, [
  // video in the top-left quarter, text in the middle: the bottom-right corner stays background
  { op: "add_clip", track: "overlay", src: join(m, "v.mp4"), at: 0, duration: 2, size: [120, 90], position: "top_left" },
  { op: "add_clip", track: "text", text: "ALPHA", at: 0, duration: 2, font_size: 48 },
  { op: "add_clip", track: "music", src: join(m, "music.wav"), volume: 0.5, until_end: true },
]);
const p = openProject(P);
const tl = () => p.absolutized(api.openProject(P).load());
const out = (f: string) => join(P, "renders", f);

console.log("hevc");
let r: any = await timed("hevc .mp4", () => renderVideo(tl(), p.root, out("hevc.mp4"), { codec: "hevc", workers: 1 }));
let v = probe(out("hevc.mp4")).streams.find((s) => s.codec_type === "video");
check("hevc codec + hvc1 tag", v?.codec_name === "hevc" && v?.codec_tag_string === "hvc1", v && { c: v.codec_name, t: v.codec_tag_string });
check("result codec/alpha", r.codec === "hevc" && r.alpha === false && r.encoder === "libx265", r);
r = await timed("hevc .mp4, 2 workers", () => renderVideo(tl(), p.root, out("hevc2.mp4"), { codec: "hevc", workers: 2 }));
v = probe(out("hevc2.mp4")).streams.find((s) => s.codec_type === "video");
check("hevc concat keeps hvc1 + audio", v?.codec_tag_string === "hvc1" && probe(out("hevc2.mp4")).streams.some((s) => s.codec_type === "audio"), v?.codec_tag_string);
if (process.platform === "darwin") {
  r = await timed("hevc .mov hwEncode", () => renderVideo(tl(), p.root, out("hevc_hw.mov"), { codec: "h265", hwEncode: true, workers: 1 }));
  v = probe(out("hevc_hw.mov")).streams.find((s) => s.codec_type === "video");
  check("hevc_videotoolbox .mov (alias h265)", r.encoder === "hevc_videotoolbox" && v?.codec_name === "hevc" && v?.codec_tag_string === "hvc1", { e: r.encoder, t: v?.codec_tag_string });
}

console.log("opaque defaults unchanged");
r = await timed("auto .mov", () => renderVideo(tl(), p.root, out("auto.mov"), { workers: 1 }));
v = probe(out("auto.mov")).streams.find((s) => s.codec_type === "video");
check("auto .mov = prores 422 HQ, no alpha", r.codec === "prores" && r.alpha === false && v?.profile === "HQ" && !/a/.test(v?.pix_fmt.replace("yuv", "")), v && { p: v.profile, f: v.pix_fmt });

console.log("transparent background");
await api.apply(P, { op: "set_settings", background: "#00000000" });
r = await timed("prores_4444 .mov", () => renderVideo(tl(), p.root, out("alpha.mov"), { codec: "prores_4444", workers: 1 }));
v = probe(out("alpha.mov")).streams.find((s) => s.codec_type === "video");
check("prores 4444 with alpha pix_fmt", v?.profile === "4444" && /^yuva/.test(v?.pix_fmt), v && { p: v.profile, f: v.pix_fmt });
check("result alpha on, no warnings", r.alpha === true && r.codec === "prores_4444" && !r.warnings, r);
let f = rgbaFrame(out("alpha.mov"), 1);
check("corner transparent", px(f, W - 6, H - 6)[3] === 0, px(f, W - 6, H - 6));
check("video area opaque", px(f, 30, 30)[3] === 255, px(f, 30, 30));
check("text drawn (some opaque pixel near centre)", maxAlpha(f.subarray((H / 2 - 20) * W * 4, (H / 2 + 20) * W * 4)) === 255);
{ // antialiased white text edges must be straight (unpremultiplied) alpha: bright colour, partial alpha
  const edge: number[] = [];
  for (let y = H / 2 - 30; y < H / 2 + 30; y++) for (let x = 0; x < W; x++) { const [r0, g0, b0, a0] = px(f, x, y); if (a0 > 40 && a0 < 215) edge.push(Math.min(r0, g0, b0)); }
  const avg = edge.reduce((s, x) => s + x, 0) / Math.max(1, edge.length);
  check("text edges are straight alpha (not dark fringes)", edge.length > 10 && avg > 170, { n: edge.length, avg });
}

r = await timed("auto .mov, 3 workers", () => renderVideo(tl(), p.root, out("alpha3.mov"), { workers: 3 }));
f = rgbaFrame(out("alpha3.mov"), 1.6);
v = probe(out("alpha3.mov")).streams.find((s) => s.codec_type === "video");
check("auto .mov -> prores_4444 when transparent", r.codec === "prores_4444" && r.alpha === true && r.workers === 3, r);
check("multi-worker concat keeps alpha", /^yuva/.test(v?.pix_fmt) && px(f, W - 6, H - 6)[3] === 0 && px(f, 30, 30)[3] === 255, { f: v?.pix_fmt, c: px(f, W - 6, H - 6) });
check("duration 2s with audio", Math.abs(Number(probe(out("alpha3.mov")).format.duration) - 2) < 0.06 && probe(out("alpha3.mov")).streams.some((s) => s.codec_type === "audio"));

r = await timed("vp9 .webm, 2 workers", () => renderVideo(tl(), p.root, out("alpha.webm"), { workers: 2 }));
v = probe(out("alpha.webm")).streams.find((s) => s.codec_type === "video");
f = rgbaFrame(out("alpha.webm"), 1.5, true);
check("vp9 alpha_mode tag", v?.codec_name === "vp9" && (v?.tags?.alpha_mode ?? v?.tags?.ALPHA_MODE) === "1", v?.tags);
check("vp9 decoded alpha", r.alpha === true && px(f, W - 6, H - 6)[3] < 8 && px(f, 30, 30)[3] > 245, { c: px(f, W - 6, H - 6), v: px(f, 30, 30) });

r = await timed("h264 .mp4 (alpha dropped)", () => renderVideo(tl(), p.root, out("flat.mp4"), { workers: 1 }));
f = rgbaFrame(out("flat.mp4"), 1);
check("mp4 warns alpha dropped", r.alpha === false && r.codec === "h264" && /alpha dropped/.test(r.warnings?.[0] ?? ""), r.warnings);
check("mp4 composited on black", px(f, W - 6, H - 6).slice(0, 3).every((c) => c < 24) && px(f, W - 6, H - 6)[3] === 255, px(f, W - 6, H - 6));
r = await renderVideo(tl(), p.root, out("flat2.mp4"), { workers: 1, alpha: false, end: 0.5 });
check("alpha:false is silent", r.alpha === false && !r.warnings, r.warnings);

console.log("invalid combos");
const bad = async (label: string, o: any, file: string, code = "bad_codec") => {
  const e = await expectError(() => renderVideo(tl(), p.root, out(file), o));
  check(label, e?.code === code && !!e?.hint, e && { code: e.code, msg: e.message, hint: e.hint });
};
await bad("hevc in .webm", { codec: "hevc" }, "x.webm");
await bad("prores_4444 in .mp4", { codec: "prores_4444" }, "x.mp4");
await bad("alpha:true in .mp4", { alpha: true }, "x.mp4");
await bad("alpha:true with vp9 .mkv", { codec: "vp9", alpha: true }, "x.mkv");
await bad("unknown codec", { codec: "av2" }, "x.mp4");
await bad("codec on audio export", { codec: "hevc" }, "x.mp3");
await bad("unknown extension", {}, "x.avi", "bad_format");

console.log("audio only");
for (const [file, codec] of [["mix.mp3", "mp3"], ["mix.wav", "pcm_s16le"], ["mix.m4a", "aac"], ["mix.flac", "flac"], ["mix.aac", "aac"]]) {
  r = await timed(file, () => renderVideo(tl(), p.root, out(file), {}));
  const pr = probe(out(file));
  const a = pr.streams.find((s) => s.codec_type === "audio");
  check(`${file}: audio only, ${codec}, 2s`, r.audio_only === true && r.codec === codec && !pr.streams.some((s) => s.codec_type === "video")
    && a?.codec_name === codec && Math.abs(Number(pr.format.duration ?? a?.duration) - 2) < 0.1 && r.size_bytes > 1000, { r, d: pr.format.duration, c: a?.codec_name });
}
r = await renderVideo(tl(), p.root, out("part.mp3"), { start: 0.5, end: 1.5 });
check("audio range 1s", Math.abs(Number(probe(out("part.mp3")).format.duration) - 1) < 0.1 && r.duration === 1, r);

console.log(`\n${failures ? `✗ ${failures} check(s) failed` : "OK - all checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s  (${tmp})`);
if (!process.argv.includes("--keep") && !failures) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
