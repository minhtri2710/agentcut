// Output codec / alpha / audio-only export tests: calls renderVideo directly on a tiny synthetic project.
// Run: bun tests/codecs.ts [--keep]          (needs ffmpeg on PATH)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-codecs-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store - set before importing the API
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("../src/api.ts");
const { renderVideo, workerFailure } = await import("../src/encode.ts");
const { HOST_TAG } = await import("../src/safe-write.ts");
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
await bad("codec named like a prototype member", { codec: "constructor" }, "x.mp4");
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
  // an output in previews/ and its sheet are capped together: neither evicts the other, the older sheets go
  process.env.AGENTCUT_PREVIEWS_MAX_MB = "0.001";
  try {
    const pv: any = await api.render(SP, { out: join(SP, "previews", "capped.mp4"), workers: 1, end: 1 });
    const left = readdirSync(join(SP, "previews")).sort();
    check("an output in previews/ under the cap keeps itself and its sheet; older previews go", existsSync(pv.output) && existsSync(pv.contact_sheet ?? "")
      && JSON.stringify(left) === JSON.stringify([basename(pv.contact_sheet), "capped.mp4"].sort()), { left, pv });
  } finally { delete process.env.AGENTCUT_PREVIEWS_MAX_MB; }
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

console.log("text wrap: a word wider than the line breaks into pieces");
{
  const { TextStyle, layout, renderText } = await import("../src/text.ts");
  const st = new TextStyle({ font_size: 40, color: "#ffffff" }, 1, 360);
  const MAX = 300;
  const fits = (t: string) => layout(t, st, MAX).lines.every((l) => l.w <= MAX + 1e-6);
  const cjk = "今日は天気がとても良いので公園へ散歩に行きましょう";
  const long = "supercalifragilisticexpialidocious_and_more_letters_without_a_space";
  check("a CJK sentence with no spaces wraps within maxWidth", layout(cjk, st, MAX).lines.length > 1 && fits(cjk), layout(cjk, st, MAX).lines.map((l) => l.w));
  check("one Latin token wider than the line wraps within maxWidth", layout(long, st, MAX).lines.length > 1 && fits(long), layout(long, st, MAX).lines.map((l) => l.w));
  const L = layout(`a ${long} b`, st, MAX);
  const idxs = L.lines.flatMap((l) => l.words.map((w) => w.i));
  const pieces = L.lines.flatMap((l) => l.words).filter((w) => w.i === 1);
  check("the pieces of one word share one index and the words around it keep theirs", pieces.length > 1 && pieces.map((w) => w.text).join("") === long && idxs.filter((i) => i !== 1).join() === "0,2" && L.count === 3, { idxs, count: L.count });
  const shortWords = "the quick brown fox jumps over the lazy dog again and again";
  const S = layout(shortWords, st, MAX);
  check("text whose words all fit still wraps at the spaces, one word per piece", S.lines.length > 1 && S.lines.map((l) => l.words.map((w) => w.text).join(" ")).join(" ") === shortWords && S.lines.every((l) => l.words.every((w) => !w.more)));
  const white = (cv: any, y0: number, y1: number) => { const d = cv.getContext("2d").getImageData(0, y0, cv.width, y1 - y0).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++; return n; };
  const red = (cv: any) => { const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) n++; return n; };
  const mixed = [`Hello ${cjk}`, `第一章 ${cjk}`];
  for (const t of mixed) {
    const M = layout(t, st, MAX), w1 = M.lines[0].words.filter((w) => w.i === 1);
    check(`CJK text fills the line it starts on: ${t.slice(0, 5)}…`, w1.length === 1 && w1[0].more === true && M.lines.every((l) => l.w <= MAX + 1e-6)
      && M.lines.flatMap((l) => l.words).filter((w) => w.i === 1).map((w) => w.text).join("") === cjk && M.count === 2, M.lines.map((l) => l.words.map((w) => w.text)));
  }
  // only ASCII whitespace separates words: a Unicode space stays in its word and keeps its width, yet a CJK run may still break there
  const ideo = layout("第一章　はじめに", st, 100000), indent = layout("　はじめに", st, 100000), narrow = layout("第一章　はじめに", st, 200);
  check("an ideographic space stays inside its word (a leading one is kept) and keeps its own width", ideo.count === 1 && ideo.lines[0].words[0].text === "第一章　はじめに" && indent.lines[0].words[0].text === "　はじめに"
    && Math.abs(ideo.lines[0].w - layout("第一章", st, 1e5).lines[0].w - layout("はじめに", st, 1e5).lines[0].w - layout("　", st, 1e5).lines[0].w) < 1e-6, { ideo: ideo.lines[0].words, indent: indent.lines[0].words });
  check("a CJK run still breaks at the ideographic space when it does not fit", narrow.lines.length > 1 && narrow.lines.flatMap((l) => l.words).map((w) => w.text).join("") === "第一章　はじめに" && narrow.lines.every((l) => l.w <= 200 + 1e-6), narrow.lines.map((l) => l.words.map((w) => w.text)));
  const closing = "、。，．・：；？！）」』】〕〉》", opening = "（「『【〔〈《";
  const marked = "今日は天気がとても良いので、公園へ散歩に行きましょう。「楽しい」と彼は言った。（本当に）";
  const bad: unknown[] = [];
  for (let max = 90; max <= 400; max += 7)
    for (const t of [marked, `a ${marked}`]) for (const l of layout(t, st, max).lines) {
      const first = [...l.words[0].text][0], last = [...l.words[l.words.length - 1].text].pop()!;
      if (closing.includes(first) || opening.includes(last)) bad.push({ max, l: l.words.map((w) => w.text) });
    }
  check("kinsoku: no line starts with a closing mark or ends with an opening one", bad.length === 0, bad.slice(0, 2));
  const hl = renderText(long, st, MAX, { activeWord: 0, highlightColor: "#ff0000" });
  check("a highlighted word that was broken is marked on every piece", red(hl) > 0 && white(hl, 0, hl.height) === 0, { red: red(hl), white: white(hl, 0, hl.height) });
  const hl2 = renderText(`ab ${long}`, st, MAX, { activeWord: 1, highlightColor: "#ff0000" });
  const first = Math.ceil(layout("ab", st, MAX).glyphH) + 4; // the first line holds only "ab"
  check("only the active word's pieces are marked", white(hl2, 0, first) > 0 && white(hl2, first + 4, hl2.height) === 0, { first, h: hl2.height });
  const ink = (cv: any, y0: number, y1: number, isRed: boolean) => { const d = cv.getContext("2d").getImageData(0, y0, cv.width, y1 - y0).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 60 && d[i] > 150 && (d[i + 1] < 100) === isRed) n++; return n; }; // thin CJK strokes are partly transparent
  const hc = renderText(mixed[1], st, MAX, { activeWord: 1, highlightColor: "#ff0000" });
  const row0 = Math.ceil(layout("第一章", st, MAX).glyphH) + 4;
  check("a highlighted CJK word split over lines is marked on every piece, the word before it is not", ink(hc, 0, row0, false) > 0 && ink(hc, 0, row0, true) > 0 && ink(hc, row0 + 4, hc.height, false) === 0 && ink(hc, row0 + 4, hc.height, true) > 0, { w0: ink(hc, 0, row0, false), w1: ink(hc, row0 + 4, hc.height, false), red1: ink(hc, row0 + 4, hc.height, true) });
  check("a plain frame has no highlight colour", red(renderText(long, st, MAX, { activeWord: null, highlightColor: "#ff0000" })) === 0);
}

console.log("text box: a glyph taller than the font's ascent is not clipped");
{
  const { TextStyle, layout, renderText } = await import("../src/text.ts");
  const st = new TextStyle({ font_size: 600, color: "#ffffff" }, 1, 1080);
  const cv = renderText("😀", st, 1e5), d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
  const rows: number[] = [];
  for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (d[(y * cv.width + x) * 4 + 3] > 0) { rows.push(y); break; }
  if (!rows.length) console.log("  - skipped: no emoji font draws the glyph");
  else {
    check("a 600 px emoji has transparent rows above and below its ink (its top was cut flat at row 0)", rows[0] > 0 && rows.at(-1)! < cv.height - 1, { first: rows[0], last: rows.at(-1), height: cv.height });
  }
  check("the line pitch is the font's, so a tall glyph does not change it", layout("😀\nx", st, 1e5).lh === layout("x\nx", st, 1e5).lh, [layout("😀\nx", st, 1e5).lh, layout("x\nx", st, 1e5).lh]);
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
  { // a file replaced by one of another size whose mtime was set back to the old value is probed again
    const f = join(m, "swap.mp4");
    ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30:duration=1", "-pix_fmt", "yuv420p", f);
    const was = statSync(f), old = api.probe(f);
    ff("-f", "lavfi", "-i", "testsrc2=size=96x96:rate=30:duration=2", "-pix_fmt", "yuv420p", f);
    utimesSync(f, was.atimeMs / 1000, was.mtimeMs / 1000);
    const now = statSync(f), fresh = api.probe(f);
    check("probe: a replacement of another size with the old mtime is probed again", now.mtimeMs === was.mtimeMs && now.size !== was.size && old.width === 64 && fresh.width === 96, { old: old.width, fresh: fresh.width });
  }
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
    const refused = async (f: () => unknown) => { try { await f(); return false; } catch { return true; } };
    // probe is the only ffprobe caller: it checks the path exists first, so a URL never reaches ffprobe
    check("probe of a URL stops at not_found", (() => { try { probeMedia(url); return "opened"; } catch (e: any) { return e.code; } })() === "not_found");

    check("beats refuses a non-file source", await refused(() => beats(url)));
    await loudness(url);
    const fs = new FrameSource({ path: url, kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64] });
    check("decode refuses a non-file source", (await fs.readAt(0).catch((e) => e.code)) === "decode_failed");
    fs.close();
    const opened = await requests();
    check("a non-file source is never opened", opened === 0, opened);
    // a playlist that names a network URL: probe and decode both refuse it
    const list = join(m, "net.m3u8");
    writeFileSync(list, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhttp://127.0.0.1:${port}/seg.ts\n#EXT-X-ENDLIST\n`);
    check("probe refuses a playlist that names a network URL", await refused(() => probeMedia(list)));
    const dec = new FrameSource({ path: list, kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64] });
    check("decode refuses a playlist that names a network URL", (await dec.readAt(0).catch((e) => e.code)) === "decode_failed");
    dec.close();
    const total = await requests();
    check("no request reached the listener", total === 0, total);
  } finally {
    lis.kill();
  }
}

console.log("font given by file path");
{
  const FD = "/System/Library/Fonts/Supplemental";
  const srcA = join(FD, "Apple Chancery.ttf"), srcB = join(FD, "Andale Mono.ttf");
  if (!existsSync(srcA) || !existsSync(srcB)) console.log("  - skipped: no system .ttf to copy");
  else {
    const fa = join(tmp, "fontsA"), fb = join(tmp, "fontsB");
    mkdirSync(fa); mkdirSync(fb);
    writeFileSync(join(fa, "Brand.ttf"), readFileSync(srcA));
    writeFileSync(join(fb, "Brand.ttf"), readFileSync(srcB));
    const { resolveFont, refreshFonts } = await import("../src/fonts.ts");
    const a = resolveFont(join(fa, "Brand.ttf")), b = resolveFont(join(fb, "Brand.ttf"));
    check("same-named font files get different families", a.family !== b.family, { a: a.family, b: b.family });
    check("weight '700' (string) is 700", resolveFont("Arial", "700").weight === 700 && resolveFont("Arial", "bold").weight === 700);
    const before = resolveFont("Arial");
    refreshFonts();
    check("refreshFonts drops resolved fonts", resolveFont("Arial") !== before);
    // validation runs before Skia loads (CLI frame/sheet/review, 1-worker render): the preview must still use the file
    const pf = (name: string) => {
      const d = join(tmp, name);
      api.create(d, { width: 320, height: 120, fps: 24 });
      return d;
    };
    const fileP = pf("fontp"), refP = pf("fontref");
    await api.apply(fileP, { op: "add_clip", track: "text", text: "Hamburg", at: 0, duration: 1, font_size: 60, font: join(fa, "Brand.ttf") });
    await api.apply(refP, { op: "add_clip", track: "text", text: "Hamburg", at: 0, duration: 1, font_size: 60, font: "Arial", weight: 400 });
    const childJs = join(tmp, "frame-child.ts");
    writeFileSync(childJs, `import { writeFileSync } from "node:fs";
const api = await import(${JSON.stringify(join(import.meta.dir, "../src/api.ts"))});
const r = await api.frameImage(process.argv[2], 0);
writeFileSync(process.argv[3], r.data);\n`);
    const shot = (proj: string, o: string) => spawnSync(process.execPath, ["--no-install", childJs, proj, o], { encoding: "utf8" });
    // the first run of a project writes the family cache that its later runs validate against (the cache is keyed by the project's fonts dir)
    shot(refP, join(tmp, "font-ref.png")); const rb = shot(refP, join(tmp, "font-ref.png"));
    shot(fileP, join(tmp, "font-file.png")); const ra = shot(fileP, join(tmp, "font-file.png"));
    check("frame children ran", ra.status === 0 && rb.status === 0, { a: ra.stderr?.slice(0, 300), b: rb.stderr?.slice(0, 300) });
    check("a frame drawn after validation uses the file font, not the fallback",
      ra.status === 0 && rb.status === 0 && !readFileSync(join(tmp, "font-file.png")).equals(readFileSync(join(tmp, "font-ref.png"))));
  }
}

console.log("CJK text: an installed CJK font fills in, and glyphs no font has are reported");
{
  const { loadCanvas, C } = await import("../src/canvas.ts");
  await loadCanvas();
  const NONE = "\u{10FFFD}"; // a private-use code point in plane 16: no font maps it
  const CJK_RE = /^(Hiragino Sans|Heiti|Noto Sans CJK|Microsoft YaHei|Yu Gothic|Apple SD Gothic Neo|Malgun Gothic)/;
  const families = (C().GlobalFonts.families as { family: string }[]).map((f) => f.family);
  const cjkFont = families.find((f) => CJK_RE.test(f));
  {
    // symbols that an emoji font and a CJK font both have, and no other font of the stack: they keep the colour emoji glyph, drawn as the emoji font alone draws them
    const { resolveFont, cssFont, missingChars } = await import("../src/fonts.ts");
    const f = resolveFont(undefined), emoji = f.stack.find((s) => /Emoji/.test(s));
    const cv = C().createCanvas(80, 80), cx = cv.getContext("2d");
    const ink = (font: string, ch: string) => { cx.clearRect(0, 0, 80, 80); cx.font = font; cx.fillText(ch, 8, 60); return Buffer.from(cx.getImageData(0, 0, 80, 80).data.buffer); };
    const beforeEmoji = f.stack.slice(0, f.stack.indexOf(emoji ?? "")).filter((s) => !CJK_RE.test(s));
    const syms = [..."▶➡⬇☎"].filter((ch) => emoji && cjkFont && !missingChars(emoji, ch) && beforeEmoji.every((s) => missingChars(s, ch)));
    const { firstCovering } = await import("../src/fonts.ts");
    const bold = ["Arial Bold", "Helvetica Neue Bold", "Segoe UI Bold", "Noto Sans Bold", "DejaVu Sans Bold"];
    check("a preset font is chosen the same for text with symbols, emoji or CJK as for plain text", firstCovering(bold, "▶️ Watch ➡️ 🔥 你好") === firstCovering(bold, "Watch") && firstCovering(bold, "Watch") !== undefined, [firstCovering(bold, "▶️ Watch ➡️ 🔥 你好"), firstCovering(bold, "Watch")]);
    if (!syms.length) console.log("  - skipped: no emoji font or no symbol only the emoji and CJK fonts have");
    else check("symbols the emoji font has keep their colour glyph with a CJK font installed", syms.every((ch) => ink(cssFont(f, 48), ch).equals(ink(`400 48px "${emoji}"`, ch))), syms);
  }
  const D = join(tmp, "cjk");
  api.create(D, { width: 320, height: 120, fps: 24 });
  await api.apply(D, [{ op: "add_clip", track: "text", id: "t", text: NONE, at: 0, duration: 1, font_size: 60 }]);
  const draw = async (text: string) => { await api.apply(D, [{ op: "update_clip", id: "t", set: { text } }]); return Buffer.from((await api.frameImage(D, 0, { scale: 1, format: "png" })).data); };
  if (!cjkFont) console.log("  - skipped: no CJK font installed");
  else {
    const none = await draw(NONE);
    const T1 = "你好，世界！今天我们一起做视频。日本語のテキストも、한국어 텍스트도";
    const boxes: string[] = [];
    for (const ch of new Set([...T1])) if (ch.trim() && !/[\x20-\x7e]/.test(ch) && (await draw(ch)).equals(none)) boxes.push(ch);
    check("every Chinese, Japanese and Korean character of the sample draws a glyph with the default font (none looks like a missing glyph)", boxes.length === 0, boxes);
  }
  await api.apply(D, [{ op: "update_clip", id: "t", set: { text: `Hello ${NONE} there` } }, { op: "add_clip", track: "text", id: "e", text: "👨‍👩‍👧 family 🇻🇳 flag 1️⃣ keycap 👍🏽 tone ❤️ heart", at: 1, duration: 1 }]);
  const v = spawnSync(process.execPath, ["--no-install", join(import.meta.dir, "../src/cli.ts"), "validate", "-p", D], { encoding: "utf8" }); // a fresh process: Skia is not loaded when it starts
  const vj = JSON.parse(v.stdout);
  check("validate in a fresh process warns, naming the character no font has", vj.warnings === 1 && vj.issues[0].level === "warning" && vj.issues[0].message.includes(NONE) && vj.issues[0].path.includes("<t>"), vj);
  const ij = JSON.parse(spawnSync(process.execPath, ["--no-install", join(import.meta.dir, "../src/cli.ts"), "info", "-p", D], { encoding: "utf8" }).stdout);
  check("info in a fresh process counts the same warnings as validate", ij.warnings === vj.warnings && ij.errors === vj.errors, { info: [ij.errors, ij.warnings], validate: [vj.errors, vj.warnings] });
  check("an emoji sequence, a flag, a keycap, a skin tone and a heart give no warning", !vj.issues.some((i: any) => i.path.includes("<e>")), vj);

  // when Skia is loaded for the font checks: a child process validates and reads info, and says whether it loaded Skia (no test-only export: canvasLoaded is the module's own)
  const gateJs = join(tmp, "gate-child.ts");
  writeFileSync(gateJs, `const api = await import(${JSON.stringify(join(import.meta.dir, "../src/api.ts"))});
const { canvasLoaded } = await import(${JSON.stringify(join(import.meta.dir, "../src/canvas.ts"))});
const v = await api.validate(process.argv[2]), i = await api.info(process.argv[2]);
console.log(JSON.stringify({ valid: v.valid, errors: v.errors, warnings: v.warnings, issues: v.issues, infoErrors: i.errors, infoWarnings: i.warnings, loaded: canvasLoaded() }));\n`);
  const gate = (proj: string, cache: string) => JSON.parse(spawnSync(process.execPath, ["--no-install", gateJs, proj], { encoding: "utf8", env: { ...process.env, AGENTCUT_CACHE: cache } }).stdout);
  const U = join(tmp, "gate-unknown-font");
  api.create(U, { width: 320, height: 120, fps: 24 });
  await api.apply(U, [{ op: "add_clip", track: "text", text: "Hello", at: 0, duration: 1, font: "NoSuchFontXyz" }], { allowInvalid: true });
  const cold = gate(U, join(tmp, "gate-cache")), warm = gate(U, join(tmp, "gate-cache"));
  check("empty cache, ASCII text, unknown font: validate and info both report it (Skia is loaded to learn the families)", cold.valid === false && cold.errors === 1 && cold.infoErrors === 1 && /not found/.test(cold.issues[0].message) && cold.loaded === true, cold);
  check("warm cache: the same answer, and Skia is not loaded", warm.valid === false && warm.errors === 1 && warm.infoErrors === 1 && warm.issues[0].message === cold.issues[0].message && warm.loaded === false, warm);
  const FILE = "/System/Library/Fonts/Supplemental/Andale Mono.ttf";
  if (!existsSync(FILE)) console.log("  - skipped: no system .ttf for the font-file row");
  else {
    const F = join(tmp, "gate-font-file");
    api.create(F, { width: 320, height: 120, fps: 24 });
    await api.apply(F, [{ op: "add_clip", track: "text", text: "Hello", at: 0, duration: 1, font: FILE }]);
    gate(F, join(tmp, "gate-cache-file")); // the family cache is kept per project (its fonts folder is part of the key): the first run writes it
    const without = gate(F, join(tmp, "gate-cache-file")), withSkia = await api.validate(F);
    check("ASCII text in a font file: validate gives the same issues without Skia as with it", without.loaded === false && without.valid === true && JSON.stringify(without.issues) === JSON.stringify(withSkia.issues) && without.errors === withSkia.errors && without.warnings === withSkia.warnings, { without, withSkia });
  }
}

console.log("decode and render failures");
{
  const { FrameSource } = await import("../src/media.ts");
  const code = (pr: Promise<unknown>) => pr.then(() => "ok", (e) => e?.code);
  // A-19: a decoder that ends early or fails becomes decode_failed instead of a held or zero frame
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=1", "-pix_fmt", "yuv420p", join(m, "short.ts"));
  const short = (srcDuration?: number) => new FrameSource({ path: join(m, "short.ts"), kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], srcDuration });
  const a = short(3);
  await a.readAt(0.5);
  check("a source that ends well inside its probed length is decode_failed, not a held frame", (await code(a.readAt(2))) === "decode_failed");
  a.close();
  const b = short(1.2);
  await b.readAt(0.5);
  check("past the probed length the last frame is still held", (await b.readAt(2)).length === 64 * 64 * 4);
  const z = short(3);
  check("a fresh source that ends with no frame well inside its probed length is decode_failed, not a zero frame", (await code(z.readAt(2))) === "decode_failed");
  z.close();
  // a fresh source (preview, still, sheet tile, later render segment) read past the end holds the last frame, like the streamed one
  const fresh = short(), held = await fresh.readAt(5).catch(() => Buffer.alloc(0));
  check("a fresh source read past the end returns the held last frame", held.length === 64 * 64 * 4 && held.some((x) => x !== 0) && held.equals(await b.readAt(2)), held.length);
  fresh.close();
  // a freeze at or past the video's end holds its last frame, as a playing clip does (the seek of a still lands past the last frame's interval)
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30:duration=2", "-pix_fmt", "yuv420p", join(m, "endclip.mp4"));
  const frz = (srcIn: number, srcDuration = 2, mode: { loop?: boolean; reverse?: boolean } = {}) => new FrameSource({ path: join(m, "endclip.mp4"), kind: "video", srcW: 64, srcH: 64, rate: 30, fit: "fill", box: [64, 64], srcDuration, freeze: true, srcIn, ...mode });
  const lastPlayed = new FrameSource({ path: join(m, "endclip.mp4"), kind: "video", srcW: 64, srcH: 64, rate: 30, fit: "fill", box: [64, 64], srcDuration: 2 });
  const tailRef = await lastPlayed.readAt(5);
  const inside = frz(1.0), insideFrame = await inside.readAt(0);
  check("a freeze well inside the source still holds the frame at its in-point", insideFrame.length === 64 * 64 * 4 && !insideFrame.equals(tailRef));
  for (const at of [2, 2.2, 6]) {
    const fz = frz(at);
    const got = await fz.readAt(0).catch((e) => e?.code);
    check(`a freeze with in ${at} (source 2 s) holds the source's last frame`, Buffer.isBuffer(got) && got.equals(tailRef), Buffer.isBuffer(got) ? got.length : got);
    fz.close();
  }
  for (const [name, mode, at] of [["loop", { loop: true }, 1.99], ["reverse", { reverse: true }, 2], ["reverse", { reverse: true }, 6]] as const) {
    const fz = frz(at, 2, mode);
    const got = await fz.readAt(0).catch((e) => e?.code);
    check(`a frozen ${name} clip with in ${at} (source 2 s) holds the source's last frame`, Buffer.isBuffer(got) && got.equals(tailRef), Buffer.isBuffer(got) ? got.length : got);
    fz.close();
  }
  { // a looping clip's in past the source length wraps into it (freeze_frame in the second pass), and holds the frame that was playing, not the last one
    const wrapped = frz(2.5, 2, { loop: true }), base = frz(0.5), w = await wrapped.readAt(0).catch((e) => e?.code), b = await base.readAt(0);
    check("a frozen loop clip with in 2.5 (source 2 s) holds the frame at 0.5 s, not the last frame", Buffer.isBuffer(w) && w.equals(b) && !w.equals(tailRef), Buffer.isBuffer(w) ? w.length : w);
    wrapped.close(); base.close();
    const L = join(tmp, "freeze-loop"), P = join(tmp, "freeze-plain");
    for (const [d, op, at] of [[L, { loop: true, duration: 4 }, 2.5], [P, {}, 0.5]] as const) {
      api.create(d, { width: 64, height: 64, fps: 30 });
      await api.apply(d, [{ op: "add_clip", track: "main", src: join(m, "endclip.mp4"), ...op }, { op: "freeze_frame", id: "vid1", at, duration: 1 }]);
    }
    const fl = await api.frameImage(L, 2.7, { scale: 1 }).catch((e: any) => e), fp = await api.frameImage(P, 0.7, { scale: 1 }).catch((e: any) => e);
    check("freeze_frame in the second pass of a looping clip holds the frame that was playing", fl?.data?.length > 100 && fp?.data?.length > 100 && Buffer.from(fl.data).equals(Buffer.from(fp.data)), fl?.code ?? fp?.code);
  }
  const cutOf = (mode: { loop?: boolean; reverse?: boolean }) => new FrameSource({ path: join(m, "short.ts"), kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], srcDuration: 1.6, freeze: true, srcIn: 1, ...mode });
  const cut = cutOf({});
  check("a freeze in a source that ends well inside its probed length is decode_failed, not a held frame", (await code(cut.readAt(0))) === "decode_failed");
  for (const mode of [{ loop: true }, { reverse: true }]) {
    const c = cutOf(mode);
    check(`a frozen ${Object.keys(mode)[0]} clip in a source that ends well inside its probed length is decode_failed`, (await code(c.readAt(0))) === "decode_failed");
    c.close();
  }
  for (const x of [inside, lastPlayed, cut]) x.close();
  {
    const F = join(tmp, "freeze-end");
    api.create(F, { width: 64, height: 64, fps: 30 });
    await api.apply(F, [{ op: "add_clip", track: "main", src: join(m, "endclip.mp4") }, { op: "freeze_frame", id: "vid1", at: "end", duration: 1 }]);
    const fr = await api.frameImage(F, 2.5, { scale: 1 }).catch((e: any) => e);
    check("freeze_frame at the end of a clip that runs to the end of its file renders", fr?.data?.length > 100, fr?.code ?? fr?.message);
  }
  // audio longer than video: the container length is not the video's end
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-pix_fmt", "yuv420p", join(m, "longaudio.mp4"));
  const la = new FrameSource({ path: join(m, "longaudio.mp4"), kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], srcDuration: 3 });
  await la.readAt(0.5);
  check("a video shorter than its audio holds its last frame at the container's length", (await code(la.readAt(2))) === "ok");
  // a fresh source (later render segment, preview) read past the video's end of the same file: the held frame comes from the video's end, not the container's
  const la2 = new FrameSource({ path: join(m, "longaudio.mp4"), kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], srcDuration: 3 });
  const lh = await la2.readAt(2).catch(() => Buffer.alloc(0));
  check("a fresh read past the video's end of a file with longer audio holds the last frame", lh.length === 64 * 64 * 4 && lh.some((x) => x !== 0), lh.length);
  la2.close();
  la.close();
  // N3/N4: the video's end and its last frame are asked once per source, however often a jump past the end repeats
  if (process.platform !== "win32") {
    const bin = join(tmp, "shim-bin"), log = join(tmp, "shim.log");
    mkdirSync(bin);
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const real = spawnSync("which", [tool], { encoding: "utf8" }).stdout.trim();
      writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    }
    const PATH1 = process.env.PATH;
    process.env.PATH = `${bin}:${PATH1}`;
    const rs = new FrameSource({ path: join(m, "longaudio.mp4"), kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], srcDuration: 3 });
    const first = await rs.readAt(2.6).catch(() => Buffer.alloc(0));
    await rs.readAt(0.5);
    const again = await rs.readAt(2.6).catch(() => Buffer.alloc(0));
    process.env.PATH = PATH1;
    rs.close();
    const lines = readFileSync(log, "utf8").split("\n");
    check("a back-seek and a second jump past the end asks the video's end and decodes its last frame once",
      lines.filter((l) => l.startsWith("ffprobe ")).length === 1 && lines.filter((l) => l.startsWith("ffmpeg ") && l.includes("-ss 0.000000 ")).length === 1 && first.length === 64 * 64 * 4 && again.equals(first), lines);
  }
  b.close();
  const sk = new FrameSource({ path: join(m, "v.mp4"), kind: "video", srcW: W, srcH: H, rate: 24, fit: "fill", box: [W, H] });
  await sk.readAt(0);
  const PATH0 = process.env.PATH;
  process.env.PATH = join(tmp, "no-such-bin"); // the re-seek cannot start ffmpeg
  const seek = await code(sk.readAt(2.5));
  process.env.PATH = PATH0;
  check("a decoder that fails to start on a re-seek is decode_failed, not a held frame", seek === "decode_failed", seek);
  sk.close();

  // A-26: a worker's EditError reaches the caller with its code and no stack trace
  const Q = join(tmp, "projq");
  api.create(Q, { width: W, height: H, fps: 24 });
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=3", "-pix_fmt", "yuv420p", join(m, "bad.mp4")); // no audio stream: only the decode can fail
  await api.apply(Q, [{ op: "add_clip", track: "overlay", src: join(m, "bad.mp4"), at: 0, duration: 2 }]);
  writeFileSync(join(m, "bad.mp4"), "not media at all");
  const qp = openProject(Q), qtl = () => qp.absolutized(openProject(Q).load());
  const one = await expectError(() => renderVideo(qtl(), qp.root, join(Q, "renders", "w1.mp4"), { workers: 1 }));
  const two = await expectError(() => renderVideo(qtl(), qp.root, join(Q, "renders", "w2.mp4"), { workers: 2 }));
  check("one worker keeps the decode error code", one?.code === "decode_failed", one?.code);
  check("several workers keep the decode error code", two?.code === "decode_failed", two?.code);
  check("a worker error carries no stack frames", !!two && !/\n\s+at /.test(two.message), two?.message);

  // 1 vs several workers: a segment that starts inside the held region gives the same frames
  const H1 = join(tmp, "projh");
  api.create(H1, { width: W, height: H, fps: 24 });
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=1", "-pix_fmt", "yuv420p", join(m, "onesec.mp4"));
  await api.apply(H1, [{ op: "add_clip", track: "overlay", src: join(m, "onesec.mp4"), at: 0, duration: 2 }]);
  const hp = openProject(H1), htl = () => hp.absolutized(openProject(H1).load());
  const h1 = await expectError(() => renderVideo(htl(), hp.root, join(H1, "renders", "h1.mp4"), { workers: 1 }));
  const h2 = await expectError(() => renderVideo(htl(), hp.root, join(H1, "renders", "h2.mp4"), { workers: 2 }));
  check("one and two workers both render a clip held past its source", h1 === null && h2 === null, { h1: h1?.message, h2: h2?.message });
  if (h1 === null && h2 === null) {
    const f1 = rgbaFrame(join(H1, "renders", "h1.mp4"), 1.5), f2 = rgbaFrame(join(H1, "renders", "h2.mp4"), 1.5);
    let d = 0; for (let i = 0; i < f1.length; i++) d += Math.abs(f1[i] - f2[i]);
    check("the held frame is the same for one and two workers", f1.length === f2.length && d / f1.length < 2, d / f1.length);
  }

  // A-26 on the compiled path: the binary starts a worker as `cli __segment <job>`; its EditError is one E line on stdout
  {
    const job = join(tmp, "seg-job.json");
    writeFileSync(job, JSON.stringify({ tl: qtl(), root: qp.root, scale: 1, fontDirs: [], t0: 0, i0: 0, i1: 24, v: ["-c:v", "libx264", "-pix_fmt", "yuv420p"], out: join(tmp, "seg-out.mkv") }));
    const sg = spawnSync(process.execPath, ["--no-install", "--no-env-file", `--config=${join(import.meta.dir, "../scripts/bunfig.empty.toml")}`, join(import.meta.dir, "../src/cli.ts"), "__segment", job], { encoding: "utf8" });
    const eLine = sg.stdout.split("\n").find((l) => l.startsWith("E "));
    check("the __segment entry reports an EditError as an E line with its code", sg.status === 1 && JSON.parse(eLine?.slice(2) ?? "{}").code === "decode_failed", { s: sg.status, o: sg.stdout.slice(0, 200), e: sg.stderr.slice(0, 200) });
  }

  // A-39: bounds
  for (const workers of [0, 2.5, -1, Number.NaN]) {
    const e = await expectError(() => renderVideo(tl(), p.root, out("bw.mp4"), { workers, end: 0.5 }));
    check(`workers ${workers} is refused`, e?.code === "bad_value", e?.code);
  }
  for (const scale of [0, -1, 5]) check(`frame scale ${scale} is refused`, (await code(api.frameImage(P, 0, { scale }))) === "bad_value");
  check("a still render refuses scale 5", (await code(api.render(P, { out: join(tmp, "s5.png"), scale: 5 }))) === "bad_value");
  check("sheet count above the tile cap is refused", (await code(api.sheet(P, { count: 65, tileWidth: 32 }))) === "bad_value");
  check("sheet count 2.5 is refused", (await code(api.sheet(P, { count: 2.5, tileWidth: 32 }))) === "bad_value");
  check("sheet times below 0 are refused", (await code(api.sheet(P, { times: [0, -1], tileWidth: 32 }))) === "bad_value" && (await code(api.sheet(P, { times: "-0.5", tileWidth: 32 }))) === "bad_value");
  check("sheet times above the tile cap are refused", (await code(api.sheet(P, { times: Array.from({ length: 65 }, () => 0), tileWidth: 32 }))) === "bad_value");

  // A-52: a failed tile stops the other renderers; a throwing progress callback is the render's error; dead renders' parts are swept
  const R = await import("../src/render.ts");
  const orig = R.Renderer.prototype.frame;
  let calls = 0;
  R.Renderer.prototype.frame = async function (this: any, ...args: any[]) {
    if (++calls === 1) throw Object.assign(new Error("tile boom"), { code: "decode_failed" });
    await new Promise((r) => setTimeout(r, 30));
    return (orig as any).apply(this, args);
  } as any;
  let sheetErr: any;
  try { await api.sheet(P, { times: [0, 0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4], tileWidth: 32 }); } catch (e) { sheetErr = e; }
  await new Promise((r) => setTimeout(r, 400)); // renderers that were not stopped would still be calling frame()
  R.Renderer.prototype.frame = orig;
  check("a failed tile reports its own error", sheetErr?.code === "decode_failed", sheetErr?.message);
  check("a failed tile stops the other renderers after their current tile", calls <= 4, calls);
  let progressCalls = 0;
  const pe = await expectError(() => renderVideo(tl(), p.root, out("pg.mp4"), { workers: 2, end: 1, progress: () => { progressCalls++; throw new Error("progress boom"); } }));
  check("a throwing progress callback fails the render with its own error", pe?.message === "progress boom", pe?.message);
  check("a progress callback that threw is not called again", progressCalls === 1, progressCalls);

  const dir = join(tmp, "sweep"); mkdirSync(dir);
  const dead = spawnSync(process.execPath, ["-e", "0"]).pid;
  const stale = join(dir, `o.part-${dead}-${HOST_TAG}-0123456789ab.mp4`), liveP = join(dir, `o.part-${process.pid}-${HOST_TAG}-0123456789ab.mp4`);
  const otherName = join(dir, `x.part-${dead}-${HOST_TAG}-0123456789ab.mp4`), odd = join(dir, `o.part-${dead}-${HOST_TAG}-xyz.mp4`), target = join(tmp, "sweep-target.mp4"), link = join(dir, `o.part-${dead}-${HOST_TAG}-ba9876543210.mp4`);
  const otherHost = join(dir, `o.part-${dead}-${HOST_TAG === "00000000" ? "11111111" : "00000000"}-0123456789ab.mp4`), untagged = join(dir, `o.part-${dead}-0123456789ab.mp4`);
  for (const f of [stale, liveP, otherName, odd, target, otherHost, untagged]) writeFileSync(f, "x");
  symlinkSync(target, link);
  await renderVideo(tl(), p.root, join(dir, "o.mp4"), { workers: 1, end: 0.5 });
  check("a dead render's part file of this host beside the output is swept", !existsSync(stale));
  check("a part file of another host, and one with no host tag, stay although their pid is dead", existsSync(otherHost) && existsSync(untagged), readdirSync(dir));
  check("a live render's part file, another output's part file, an odd name, a link and its target stay",
    [liveP, otherName, odd, target].every((f) => existsSync(f)) && lstatSync(link).isSymbolicLink(), readdirSync(dir));

  { // the subtitle sidecar a killed mux left beside the output: its name is derived from what embedSubtitles really uses
    const sdir = join(tmp, "sweep-sub"), bin = join(tmp, "fakebin-sub"), rec = join(tmp, "mux-args.txt"), video = join(sdir, "s.mp4");
    mkdirSync(sdir); mkdirSync(bin);
    writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\nfor a; do echo "$a"; done > '${rec}'\nexit 1\n`, { mode: 0o755 });
    const { embedSubtitles } = await import("../src/subtitles.ts"), pathNow = process.env.PATH;
    process.env.PATH = `${bin}:${pathNow}`;
    try { await embedSubtitles(video, [{ start: 0, end: 1, text: "x", clip: "c" }]); } catch { /* the stand-in fails the mux */ } finally { process.env.PATH = pathNow; }
    const args = readFileSync(rec, "utf8").trim().split("\n"), sidecar = basename(args[args.lastIndexOf("-i") + 1]);
    const other = HOST_TAG === "00000000" ? "11111111" : "00000000";
    const gone = join(sdir, sidecar.replace(`part-${process.pid}-`, `part-${dead}-`));
    const keep = [gone.replace(`-${HOST_TAG}-`, `-${other}-`), gone.replace(`-${HOST_TAG}-`, "-")];
    for (const f of [gone, ...keep]) writeFileSync(f, "x");
    await renderVideo(tl(), p.root, video, { workers: 1, end: 0.5 });
    check("a dead mux's subtitle sidecar of this host beside the output is swept by the next render", gone !== keep[0] && !existsSync(gone), { sidecar, left: readdirSync(sdir) });
    check("a sidecar-shaped file of another host, and one with no host tag, stay", keep.every((f) => existsSync(f)), readdirSync(sdir));
  }

  const bw = workerFailure('E {"message":"m","code":"c","hint":"h"}', 0), bad = workerFailure("E not json", 3);
  check("a worker's E line keeps its message, code and hint", bw.message === "m" && bw.code === "c" && bw.hint === "h", bw);
  check("an unreadable E line is a render_failed error that names the line", bad.code === "render_failed" && bad.message.includes("E not json") && bad.message.includes("worker 3"), bad);
  // A-29 / N5: a render does not depend on the worker count. prores is intra-only, so equal pixels give equal decoded frames.
  const { createHash } = await import("node:crypto");
  const frameHashes = (f: string) => {
    const raw = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", f, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 29 }).stdout as Buffer;
    const size = W * H * 4;
    return Array.from({ length: Math.floor(raw.length / size) }, (_, i) => createHash("sha1").update(raw.subarray(i * size, (i + 1) * size)).digest("hex"));
  };
  const differ = (a: string[], b: string[]) => a.length !== b.length ? [-1] : a.flatMap((h, i) => (h === b[i] ? [] : [i]));
  const renderTwice = async (dir: string, workers: number[]) => {
    const pr = openProject(dir), full = () => pr.absolutized(openProject(dir).load()), hashes: string[][] = [];
    for (const [i, w] of workers.entries()) {
      const f = join(dir, "renders", `det${i}.mov`);
      const e = await expectError(() => renderVideo(full(), pr.root, f, { workers: w, codec: "prores" }));
      if (e) throw e;
      hashes.push(frameHashes(f));
    }
    return hashes;
  };
  // 30 fps sources on a 24 fps timeline: a clip crossing the segment boundary, and a crossfade across it (boundary 1.75 s, fade 1.5-2.0 s)
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30:duration=3", "-pix_fmt", "yuv420p", join(m, "a30.mp4"));
  ff("-f", "lavfi", "-i", "testsrc=size=64x64:rate=30:duration=3", "-pix_fmt", "yuv420p", join(m, "b30.mp4"));
  const D = join(tmp, "projd");
  api.create(D, { width: W, height: H, fps: 24 });
  await api.apply(D, [
    { op: "add_clip", track: "main", src: join(m, "a30.mp4"), duration: 2 },
    { op: "add_clip", track: "main", src: join(m, "b30.mp4"), duration: 2, transition: { type: "crossfade", duration: 0.5 } },
  ]);
  const [d1, d1b, d2] = await renderTwice(D, [1, 1, 2]);
  check("a clip and a crossfade across the segment boundary render 84 frames", d1.length === 84 && d2.length === 84, [d1.length, d2.length]);
  check("two one-worker renders have identical frames", differ(d1, d1b).length === 0, differ(d1, d1b));
  check("one and two workers render identical frames across a segment boundary and a transition", differ(d1, d2).length === 0, differ(d1, d2));
  // N5: a 1 s 30 fps source held for 3 s; the second segment (from 1.5 s) starts inside the held region
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30:duration=1", "-pix_fmt", "yuv420p", join(m, "s30.mp4"));
  const G = join(tmp, "projg");
  api.create(G, { width: W, height: H, fps: 24 });
  await api.apply(G, [{ op: "add_clip", track: "overlay", src: join(m, "s30.mp4"), at: 0, duration: 3 }]);
  const [g1, g2] = await renderTwice(G, [1, 2]);
  check("a held frame of a 30 fps source on a 24 fps timeline is the same for one and two workers", g1.length === 72 && differ(g1, g2).length === 0, [g1.length, g2.length, differ(g1, g2).slice(0, 5)]);


  // A-27: a layer that has ended keeps no canvas
  const C = join(tmp, "projc");
  api.create(C, { width: W, height: H, fps: 24 });
  await api.apply(C, Array.from({ length: 6 }, (_, i) => ({ op: "add_clip", track: "overlay", src: join(m, "v.mp4"), at: i * 0.5, duration: 0.5, scale: 0.9 })));
  const cp = openProject(C);
  await api.frameImage(C, 0); // loads Skia
  const rend = new R.Renderer(structuredClone(cp.absolutized(openProject(C).load())), cp.root, 1);
  let most = 0;
  for (let i = 0; i < 6; i++) { await rend.frame(i * 0.5 + 0.25); most = Math.max(most, (rend as any).layerCanvases.size); }
  await rend.frame(2.9);
  const during = (rend as any).layerCanvases.size;
  rend.close();
  check("finished layers release their canvases while rendering", during <= 2 && most <= 2, { during, most });
  check("closing the renderer releases every layer canvas", (rend as any).layerCanvases.size === 0);
}

console.log("the JPEG side limit render.ts refuses at");
{
  const { loadCanvas, C } = await import("../src/canvas.ts");
  await loadCanvas();
  const { encodeStill, JPEG_MAX_SIDE } = await import("../src/render.ts");
  const enc = (w: number, h: number) => { try { return encodeStill(C().createCanvas(w, h), "jpeg").length > 0; } catch { return false; } };
  check("a blank canvas encodes as JPEG at the limit on either side and fails one pixel past it", enc(JPEG_MAX_SIDE, 1) && enc(1, JPEG_MAX_SIDE) && !enc(JPEG_MAX_SIDE + 1, 1) && !enc(1, JPEG_MAX_SIDE + 1), { limit: JPEG_MAX_SIDE });
}

console.log(`\n${failures ? `✗ ${failures} check(s) failed` : "OK - all checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s  (${tmp})`);
if (!process.argv.includes("--keep") && !failures) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
