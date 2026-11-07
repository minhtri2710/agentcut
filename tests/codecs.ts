// Output codec / alpha / audio-only export tests: calls renderVideo directly on a tiny synthetic project.
// Run: bun tests/codecs.ts [--keep]          (needs ffmpeg on PATH)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-codecs-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store - set before importing the API
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
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
check("result codec/alpha", r.codec === "hevc" && r.alpha === false && r.encoder === "libx265" && r.has_audio === true, r);
r = await timed("hevc .mp4, 2 workers", () => renderVideo(tl(), p.root, out("hevc2.mp4"), { codec: "hevc", workers: 2 }));
v = probe(out("hevc2.mp4")).streams.find((s) => s.codec_type === "video");
check("hevc concat keeps hvc1 + audio", v?.codec_tag_string === "hvc1" && r.has_audio === true && probe(out("hevc2.mp4")).streams.some((s) => s.codec_type === "audio"), v?.codec_tag_string);
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

console.log("still image (.png / .webp)");
{
  const S = join(tmp, "still");
  api.create(S, { width: W, height: H, fps: 24 });
  await api.apply(S, [{ op: "set_settings", background: "#00000000" },
    { op: "add_clip", track: "overlay", type: "shape", shape: "rect", size: [100, 100], fill: "#ff0000", at: 0, duration: 1 },
    { op: "add_clip", track: "overlay", type: "shape", shape: "rect", size: [100, 100], fill: "#0000ff", at: 1, duration: 1 }]);
  const so = (f: string) => join(S, "renders", f);
  const sheets = () => ["renders", "previews"].flatMap((d) => (existsSync(join(S, d)) ? readdirSync(join(S, d)).filter((f) => f.endsWith(".sheet.jpg")) : [])); // a still render writes no contact sheet
  const chunks = (f: string) => { const s = readFileSync(f).toString("latin1"); return ["VP8L", "ALPH"].filter((k) => s.includes(k)); };
  const shot = async (f: string, o: any = {}) => ({ r: await api.render(S, { out: so(f), ...o }).catch((e: any) => e) as any, f: so(f) });
  const corner = (f: string, t = 0) => px(rgbaFrame(f, t), 4, 4), centre = (f: string, t = 0) => px(rgbaFrame(f, t), W / 2, H / 2);
  for (const [name, o, chunk] of [["png", {}, null], ["webp default (lossy)", {}, "ALPH"], ["webp quality=high (lossless)", { quality: "high" }, "VP8L"]] as const) {
    const f = name.startsWith("png") ? "a.png" : name.includes("lossless") ? "hi.webp" : "lo.webp";
    const { r } = await shot(f, o);
    const i = existsSync(so(f)) ? api.probe(so(f)) : null;
    check(`${name}: written, kind image, alpha, canvas size`, i?.kind === "image" && i.alpha === true && i.width === W && i.height === H && r.alpha === true && r.width === W && r.height === H, { r, i });
    check(`${name}: transparent corner, opaque centre`, existsSync(so(f)) && corner(so(f))[3] === 0 && centre(so(f)).join() === "255,0,0,255", existsSync(so(f)) && { c: corner(so(f)), m: centre(so(f)) });
    if (chunk) check(`${name}: ${chunk} chunk`, existsSync(so(f)) && chunks(so(f)).join() === chunk && (chunk === "VP8L" || !chunks(so(f)).includes("VP8L")), existsSync(so(f)) && chunks(so(f)));
    const dir = join(tmp, `still-in-${f}`);
    api.create(dir, { width: W, height: H, fps: 24 });
    await api.apply(dir, [{ op: "set_settings", background: "#00ff00" }, { op: "add_clip", track: "overlay", src: so(f), at: 0, duration: 1 }]).catch(() => {});
    const pv = join(dir, "previews", "x.png");
    await api.frame(dir, 0.5, { out: pv, scale: 1 }).catch(() => {});
    check(`${name}: re-imported, the transparent corner shows the background`, existsSync(pv) && px(rgbaFrame(pv, 0), 4, 4).join() === "0,255,0,255" && px(rgbaFrame(pv, 0), W / 2, H / 2).join() === "255,0,0,255", existsSync(pv) && px(rgbaFrame(pv, 0), 4, 4));
  }
  const { r: res, f: ff1 } = await shot("shape.png", { start: 0.25 });
  check("result: exactly output/t/width/height/alpha/bytes, bytes = file size, no sheet", JSON.stringify(Object.keys(res).sort()) === JSON.stringify(["alpha", "bytes", "height", "output", "t", "width"])
    && res.output === ff1 && res.t === 0.25 && existsSync(ff1) && res.bytes === statSync(ff1).size && sheets().length === 0, res);
  const at2 = await shot("t2.png", { start: 1.5 });
  check("start picks the frame (red at 0.25, blue at 1.5)", existsSync(ff1) && existsSync(at2.f) && centre(ff1).join() === "255,0,0,255" && centre(at2.f).join() === "0,0,255,255" && at2.r.t === 1.5, { a: existsSync(ff1) && centre(ff1), b: existsSync(at2.f) && centre(at2.f) });
  const flat = await shot("flat.png", { alpha: false });
  check("alpha=false composites on opaque black", flat.r.alpha === false && !flat.r.warnings && existsSync(flat.f) && corner(flat.f).join() === "0,0,0,255" && centre(flat.f).join() === "255,0,0,255", flat.r);
  const half = await shot("half.png", { scale: 0.5 }), draft = await shot("draft.png", { draft: true, scale: 1 });
  check("scale applies; draft caps it at 0.5", half.r.width === W / 2 && half.r.height === H / 2 && draft.r.width === W / 2, { h: half.r, d: draft.r });
  const wide = await shot("wide.png", { alpha: true, quality: "draft" });
  check("alpha=true on a transparent background is silent", wide.r.alpha === true && !wide.r.warnings, wide.r);
  for (const [label, o, code, file] of [["end", { end: 1 }, "bad_value", "e.png"], ["subtitles", { subtitles: true }, "bad_value", "s.webp"], ["codec h264", { codec: "h264" }, "bad_codec", "c.png"],
    ["start = duration", { start: 2 }, "bad_value", "d.png"], ["start past duration", { start: 5 }, "bad_value", "d2.webp"], ["negative start", { start: -1 }, "bad_value", "n.png"]] as const) {
    const { r, f } = await shot(file, o);
    check(`refused: ${label} -> ${code}, no file`, r.code === code && !!r.hint && !existsSync(f) && sheets().length === 0, r instanceof Error ? { msg: r.message } : r);
  }
  const reason = new Error("stop"), ab = so("aborted.png");
  const aborted: any = await api.render(S, { out: ab, signal: AbortSignal.abort(reason) }).catch((e: any) => e);
  check("an already-aborted signal rejects with its reason and writes no file", aborted === reason && !existsSync(ab), aborted);
  const gone: any = await api.render(join(tmp, "no-such-project"), { out: join(tmp, "gone.png"), signal: AbortSignal.abort(reason) }).catch((e: any) => e);
  check("an aborted signal is checked before the project is opened", gone === reason && !existsSync(join(tmp, "gone.png")), gone);
  let polls = 0; // passes the entry check, throws on the next one: the check before the write
  const late = { get aborted() { return polls > 1; }, get reason() { return reason; }, addEventListener() {}, removeEventListener() {}, throwIfAborted() { if (++polls > 1) throw reason; } } as unknown as AbortSignal;
  const lf = so("late.png"), lateRes: any = await api.render(S, { out: lf, signal: late }).catch((e: any) => e);
  check("an abort that lands after the frame is drawn rejects with its reason and writes no file", lateRes === reason && polls === 2 && !existsSync(lf), { polls, r: lateRes });
  const O = join(tmp, "still-opaque");
  api.create(O, { width: W, height: H, fps: 24 });
  await api.apply(O, [{ op: "set_settings", background: "#ff0000" }, { op: "add_clip", track: "overlay", type: "shape", shape: "rect", size: [100, 100], fill: "#0000ff", at: 0, duration: 1 }]);
  const op = await api.render(O, { out: join(O, "renders", "o.png") }).catch((e: any) => e) as any;
  const opf = join(O, "renders", "o.png");
  check("opaque background: alpha false, no warning, every pixel opaque", op.alpha === false && !op.warnings && existsSync(opf) && corner(opf).join() === "255,0,0,255", op);
  check("opaque background png is still stored as RGBA, so probe reports alpha (pinned)", existsSync(opf) && api.probe(opf).alpha === true);
  const forced = await api.render(O, { out: join(O, "renders", "o2.webp"), alpha: true }).catch((e: any) => e) as any;
  check("alpha=true on an opaque background warns (the video text)", forced.alpha === true && /settings\.background is opaque/.test(forced.warnings?.[0] ?? ""), forced);
}

console.log("timeline without an audible clip: no audio track");
{
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=2", "-pix_fmt", "yuv420p", join(m, "mute.mp4"));
  ff("-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-ac", "2", join(m, "tone.wav"));
  const SP = join(tmp, "mute");
  api.create(SP, { width: W, height: H, fps: 24 });
  await api.apply(SP, [{ op: "add_clip", track: "main", src: join(m, "mute.mp4"), at: 0, duration: 2 }]);
  const so = (f: string) => join(SP, "renders", f);
  const kinds = (f: string) => probe(f).streams.map((s) => s.codec_type).sort().join();
  const mute = (r: any) => r.has_audio === false && r.loudness === undefined && r.warnings?.some((w: string) => /no audible clips/.test(w));
  for (const workers of [1, 2]) {
    const rs: any = await timed(`silent .mp4, ${workers} worker(s)`, () => api.render(SP, { out: so(`mute${workers}.mp4`), workers }));
    check(`silent .mp4, ${workers} worker(s): no audio stream, has_audio false, warned, no loudness`, kinds(so(`mute${workers}.mp4`)) === "video" && mute(rs), { k: kinds(so(`mute${workers}.mp4`)), rs });
  }
  for (const f of ["mute.mov", "mute.webm", "mute.mkv"]) {
    const rs: any = await api.render(SP, { out: so(f), workers: 2, end: 1, sheet: false });
    check(`silent ${f}, joined segments: no audio stream, has_audio false`, kinds(so(f)) === "video" && rs.has_audio === false, { k: kinds(so(f)), rs });
  }
  const gf: any = await api.render(SP, { out: so("mute.gif"), end: 1 });
  check("gif: has_audio false, no no-audible-clips warning", gf.has_audio === false && !gf.warnings?.some((w: string) => /audible/.test(w)), gf);
  const hw: any = await api.render(SP, { out: so("mute-hw.mp4"), fast: true, workers: 1, end: 1, sheet: false });
  check("silent hardware-encode path (fast): no audio stream, has_audio false", kinds(so("mute-hw.mp4")) === "video" && hw.has_audio === false, { k: kinds(so("mute-hw.mp4")), hw });
  check("silent .mp4 keeps the faststart layout", (() => { const b = readFileSync(so("mute1.mp4")); return b.indexOf("moov") > 0 && b.indexOf("moov") < b.indexOf("mdat"); })());
  await api.apply(SP, [{ op: "add_captions", words: [{ text: "one", start: 0, end: 0.5 }, { text: "two", start: 0.5, end: 1 }] }]);
  for (const [f, workers] of [["mute-sub.mp4", 1], ["mute-sub2.mkv", 2]] as const) {
    const rs: any = await api.render(SP, { out: so(f), subtitles: true, workers, end: 1, sheet: false });
    check(`silent ${f} with subtitles: subtitle stream, no audio stream, has_audio false`, kinds(so(f)) === "subtitle,video" && rs.has_audio === false && rs.subtitles?.cues > 0, { k: kinds(so(f)), rs });
  }
  await api.apply(SP, [{ op: "add_clip", track: "music", src: join(m, "tone.wav"), at: 0, duration: 2, volume: 0.01 }]);
  const loud: any = await api.render(SP, { out: so("tone.mp4"), workers: 1 });
  check("a quiet audible clip keeps its track: audio stream, has_audio true, no warning, loudness measured", kinds(so("tone.mp4")) === "audio,video" && loud.has_audio === true && !loud.warnings && loud.loudness?.integrated_lufs != null, { k: kinds(so("tone.mp4")), loud });
}

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

console.log("alpha in vp8/vp9 webm sources");
{
  // half-transparent green source: over a red background the red channel must show through
  const alphaSrc = (name: string, codec: string, pix = "yuva420p") =>
    ff("-f", "lavfi", "-i", `color=c=0x00ff00@0.5:s=${W}x${H}:r=24:d=1,format=${pix}`, "-c:v", codec, "-pix_fmt", pix, "-auto-alt-ref", "0", join(m, name));
  alphaSrc("a9.webm", "libvpx-vp9");
  alphaSrc("a8.webm", "libvpx");
  alphaSrc("opaque9.webm", "libvpx-vp9", "yuv420p");
  for (const [f, codec] of [["a9.webm", "vp9"], ["a8.webm", "vp8"]]) {
    const i = api.probe(join(m, f));
    check(`probe: alpha ${codec} webm is alpha`, i.codec === codec && i.alpha === true, i);
  }
  check("probe: opaque vp9 webm is not alpha", api.probe(join(m, "opaque9.webm")).alpha === false);
  const over = async (src: string, name: string) => {
    const dir = join(tmp, name);
    api.create(dir, { width: W, height: H, fps: 24 });
    await api.apply(dir, [{ op: "set_settings", background: "#ff0000" }, { op: "add_clip", track: "overlay", src, at: 0, duration: 1 }]);
    return dir;
  };
  const framePx = async (dir: string, name: string) => {
    const img = join(dir, "previews", `${name}.png`);
    await api.frame(dir, 0.5, { out: img, scale: 1 });
    return px(rgbaFrame(img, 0), 40, 40);
  };
  for (const [f, codec] of [["a9.webm", "vp9"], ["a8.webm", "vp8"]]) {
    const c = await framePx(await over(join(m, f), `over-${codec}`), codec);
    check(`${codec} alpha webm composites over red (preview)`, c[0] > 100 && c[1] > 100 && c[1] < 160, c);
  }
  { // render, then import the render, then composite it over red
    const dir = join(tmp, "rt");
    api.create(dir, { width: W, height: H, fps: 24 });
    await api.apply(dir, [{ op: "set_settings", background: "#00000000" },
      { op: "add_clip", track: "overlay", src: join(m, "v.mp4"), at: 0, duration: 1, size: [120, 90], position: "top_left" }]);
    const rt = join(dir, "renders", "rt.webm");
    await renderVideo(api.openProject(dir).absolutized(api.openProject(dir).load()), api.openProject(dir).root, rt, { workers: 1 });
    check("round trip: render is flagged alpha on import", api.probe(rt).alpha === true, api.probe(rt));
    const over2 = await over(rt, "rt-over");
    const c = await framePx(over2, "rt");
    const corner = px(rgbaFrame(join(over2, "previews", "rt.png"), 0), W - 6, H - 6);
    check("round trip: transparent area shows the red background", corner[0] > 240 && corner[1] < 16 && corner[2] < 16, corner);
    check("round trip: opaque video area is not red", !(c[0] > 240 && c[1] < 16 && c[2] < 16), c);
  }
  if (process.platform !== "win32") { // an ffmpeg without the libvpx decoders: the alpha source fails closed
    const real = (process.env.PATH ?? "").split(":").map((d) => join(d, "ffmpeg")).find((f) => existsSync(f))!;
    const bin = join(tmp, "nolibvpx");
    mkdirSync(bin);
    writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\nif [ "$2" = "-decoders" ]; then "${real}" "$@" | grep -v libvpx; exit 0; fi\nexec "${real}" "$@"\n`, { mode: 0o755 });
    const code = `const {FrameSource}=await import(${JSON.stringify(join(import.meta.dir, "../src/media.ts"))});` +
      `const o={kind:"video",srcW:64,srcH:64,rate:24,fit:"fill",box:[64,64]};const t=(x)=>{try{new FrameSource({path:"a.webm",...o,...x});return "ok"}catch(e){return e.code+"|"+e.hint}};` +
      `console.log(JSON.stringify([t({codec:"vp9",alpha:true}),t({codec:"vp8",alpha:true}),t({codec:"vp9",alpha:false}),t({codec:"h264",alpha:true}),t({codec:"constructor",alpha:true})]))`;
    const c = spawnSync(process.execPath, ["--no-install", "-e", code], { cwd: tmp, encoding: "utf8",
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: tmp, AGENTCUT_HOME: join(tmp, "home"), AGENTCUT_CACHE: join(tmp, "cache") } });
    const [a9, a8, op, h2, inherited] = JSON.parse(c.stdout || "[]");
    const hint = (x: string) => x.slice(x.indexOf("|") + 1);
    check("no libvpx decoder: alpha vp9 fails with missing_dependency and a hint naming libvpx-vp9",
      a9?.startsWith("missing_dependency|") && hint(a9).includes("libvpx-vp9"), { a9, err: c.stderr.slice(0, 300) });
    check("no libvpx decoder: alpha vp8 fails with missing_dependency and a hint naming libvpx",
      a8?.startsWith("missing_dependency|") && hint(a8).includes("libvpx") && !hint(a8).includes("libvpx-vp9"), { a8 });
    check("no libvpx decoder: opaque sources are unaffected", op === "ok" && h2 === "ok", { op, h2 });
    check("an inherited object key is not a codec", inherited === "ok", { inherited });
    { // a failed `-decoders` listing is not kept: the first alpha source fails closed, the next one works once the listing succeeds
      const flaky = join(tmp, "flaky");
      mkdirSync(flaky);
      writeFileSync(join(flaky, "ffmpeg"), `#!/bin/sh\nif [ "$2" = "-decoders" ] && [ ! -e "${join(flaky, "tried")}" ]; then : > "${join(flaky, "tried")}"; exit 1; fi\nexec "${real}" "$@"\n`, { mode: 0o755 });
      const two = code.replace(/console\.log\(JSON\.stringify\(\[.*$/, `console.log(JSON.stringify([t({codec:"vp9",alpha:true}),t({codec:"vp9",alpha:true})]))`);
      const f = spawnSync(process.execPath, ["--no-install", "-e", two], { cwd: tmp, encoding: "utf8",
        env: { PATH: `${flaky}:${process.env.PATH}`, HOME: tmp, AGENTCUT_HOME: join(tmp, "home"), AGENTCUT_CACHE: join(tmp, "cache") } });
      const [first, second] = JSON.parse(f.stdout || "[]");
      check("a failed decoder listing is not cached", first?.startsWith("missing_dependency|") && second === "ok", { first, second, err: f.stderr.slice(0, 300) });
    }
  }
}

console.log("ffmpeg reads only local files and pipes");
{
  // the listener runs in a child process: this process blocks in spawnSync while ffmpeg runs
  const lis = spawn(process.execPath, ["--no-install", "-e",
    `const n=require("node:net");let c=0;const s=n.createServer(k=>{c++;k.destroy()});` +
    `s.listen(0,"127.0.0.1",()=>console.log(s.address().port));process.stdin.on("data",()=>console.log(c))`], { cwd: tmp, stdio: ["pipe", "pipe", "ignore"] });
  console.log(`  listener pid ${lis.pid}`);
  try {
    const lines: string[] = []; let wake: (() => void) | null = null;
    let buf = "";
    lis.stdout!.on("data", (d) => { buf += d; const p = buf.split("\n"); buf = p.pop()!; lines.push(...p); wake?.(); });
    const nextLine = async () => {
      const t = Date.now();
      while (!lines.length) {
        if (Date.now() - t > 10_000) throw new Error("listener child gave no line in 10 s");
        await new Promise<void>((r) => { wake = r; setTimeout(r, 200); });
      }
      return lines.shift()!;
    };
    const port = Number(await nextLine());
    const requests = async () => { lis.stdin!.write("\n"); return Number(await nextLine()); };
    const url = `tcp://127.0.0.1:${port}/a.wav`;
    const { beats, loudness } = await import("../src/analyze.ts");
    const { FrameSource, probe: probeMedia } = await import("../src/media.ts");
    const refused = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
    // probe is the only ffprobe caller: it checks the path exists first, so a URL never reaches ffprobe
    check("probe of a URL stops at not_found", (() => { try { probeMedia(url); return "opened"; } catch (e: any) { return e.code; } })() === "not_found");

    check("beats refuses a non-file source", refused(() => beats(url)));
    loudness(url);
    const fs = new FrameSource({ path: url, kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64] });
    check("decode refuses a non-file source", (await fs.readAt(0).catch((e) => e.code)) === "decode_failed");
    fs.close();
    const opened = await requests();
    check("a non-file source is never opened", opened === 0, opened);
    // a playlist that names a network URL: probe and decode both refuse it
    const list = join(m, "net.m3u8");
    writeFileSync(list, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhttp://127.0.0.1:${port}/seg.ts\n#EXT-X-ENDLIST\n`);
    check("probe refuses a playlist that names a network URL", refused(() => probeMedia(list)));
    const dec = new FrameSource({ path: list, kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64] });
    check("decode refuses a playlist that names a network URL", (await dec.readAt(0).catch((e) => e.code)) === "decode_failed");
    dec.close();
    const total = await requests();
    check("no request reached the listener", total === 0, total);
  } finally {
    lis.kill();
  }
}

console.log(`\n${failures ? `✗ ${failures} check(s) failed` : "OK - all checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s  (${tmp})`);
if (!process.argv.includes("--keep") && !failures) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
