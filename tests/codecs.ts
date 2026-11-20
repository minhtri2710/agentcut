// Output codec / alpha / audio-only export tests: calls renderVideo directly on a tiny synthetic project.
// Run: bun tests/codecs.ts [--keep]          (needs ffmpeg on PATH)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { VIDEO_FACTS } from "./video-facts.ts";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-codecs-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store - set before importing the API
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("./author-api.ts");
// this suite's rows are about media and rendering, not concurrency: a write reads the project's revision (info) and applies at it
const applyLatest = async (project: string, ops: Parameters<typeof api.apply>[1], o: { label?: string; allowInvalid?: boolean; dryRun?: boolean } = {}) => api.apply(project, ops, { ...o, revision: (await api.info(project)).revision });
const { renderVideo, workerFailure } = await import("../src/encode.ts");
const { HOST_TAG } = await import("../src/safe-write.ts");
const { openProject } = api;

let failures = 0;
const t0 = performance.now();
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info) : ""); }
}
function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}
function probe(f: string): { streams: any[]; format: any } {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f], { encoding: "utf8" });
  return JSON.parse(r.stdout);
}
/** The colour tags of a file's video stream: range, matrix, transfer, primaries. Every video output carries the BT.709 set. */
const tagsOf = (f: string) => { const s = probe(f).streams.find((x) => x.codec_type === "video"); return [s?.color_range, s?.color_space, s?.color_transfer, s?.color_primaries].join(","); };
const BT709 = "tv,bt709,bt709,bt709";
/** The centre pixel of a file's first picture, read with the BT.709 matrix as a tagged player does. */
function centreAs709(f: string): number[] {
  const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", f, "-frames:v", "1", "-vf", "scale=in_color_matrix=bt709:in_range=tv,format=rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`decode failed: ${r.stderr}`);
  const b = r.stdout as Buffer, o = ((H / 2) * W + W / 2) * 3;
  return [b[o], b[o + 1], b[o + 2]];
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
await applyLatest(P, [
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
check("hevc export carries the BT.709 tags", tagsOf(out("hevc.mp4")) === BT709, tagsOf(out("hevc.mp4")));
r = await timed("hevc .mp4, 2 workers", () => renderVideo(tl(), p.root, out("hevc2.mp4"), { codec: "hevc", workers: 2 }));
v = probe(out("hevc2.mp4")).streams.find((s) => s.codec_type === "video");
check("hevc concat keeps hvc1 + audio", v?.codec_tag_string === "hvc1" && r.has_audio === true && probe(out("hevc2.mp4")).streams.some((s) => s.codec_type === "audio"), v?.codec_tag_string);
check("the file joined from two workers and muxed with audio carries the BT.709 tags", tagsOf(out("hevc2.mp4")) === BT709, tagsOf(out("hevc2.mp4")));
if (process.platform === "darwin") {
  r = await timed("hevc .mov hwEncode", () => renderVideo(tl(), p.root, out("hevc_hw.mov"), { codec: "h265", hwEncode: true, workers: 1 }));
  v = probe(out("hevc_hw.mov")).streams.find((s) => s.codec_type === "video");
  check("hevc_videotoolbox .mov (alias h265)", r.encoder === "hevc_videotoolbox" && v?.codec_name === "hevc" && v?.codec_tag_string === "hvc1", { e: r.encoder, t: v?.codec_tag_string });
  check("the hardware hevc export carries the BT.709 tags", tagsOf(out("hevc_hw.mov")) === BT709, tagsOf(out("hevc_hw.mov")));
  r = await timed("h264 .mp4 hwEncode, draft", () => renderVideo(tl(), p.root, out("h264_hw_draft.mp4"), { quality: "draft", hwEncode: true, workers: 1, end: 0.5 }));
  check("the hardware draft h264 export carries the BT.709 tags", r.encoder === "h264_videotoolbox" && tagsOf(out("h264_hw_draft.mp4")) === BT709, { e: r.encoder, t: tagsOf(out("h264_hw_draft.mp4")) });
}

console.log("opaque defaults unchanged");
r = await timed("auto .mov", () => renderVideo(tl(), p.root, out("auto.mov"), { workers: 1 }));
v = probe(out("auto.mov")).streams.find((s) => s.codec_type === "video");
check("auto .mov = prores 422 HQ, no alpha", r.codec === "prores" && r.alpha === false && v?.profile === "HQ" && !/a/.test(v?.pix_fmt.replace("yuv", "")), v && { p: v.profile, f: v.pix_fmt });
check("the prores export carries the BT.709 tags", tagsOf(out("auto.mov")) === BT709, tagsOf(out("auto.mov")));

console.log("transparent background");
await applyLatest(P, { op: "set_settings", background: "#00000000" });
r = await timed("prores_4444 .mov", () => renderVideo(tl(), p.root, out("alpha.mov"), { codec: "prores_4444", workers: 1 }));
v = probe(out("alpha.mov")).streams.find((s) => s.codec_type === "video");
check("prores 4444 with alpha pix_fmt", v?.profile === "4444" && /^yuva/.test(v?.pix_fmt), v && { p: v.profile, f: v.pix_fmt });
check("result alpha on, no warnings", r.alpha === true && r.codec === "prores_4444" && !r.warnings, r);
check("the prores 4444 export with alpha carries the BT.709 tags", tagsOf(out("alpha.mov")) === BT709, tagsOf(out("alpha.mov")));
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
check("  and the joined file carries the BT.709 tags", tagsOf(out("alpha3.mov")) === BT709, tagsOf(out("alpha3.mov")));
check("duration 2s with audio", Math.abs(Number(probe(out("alpha3.mov")).format.duration) - 2) < 0.06 && probe(out("alpha3.mov")).streams.some((s) => s.codec_type === "audio"));

r = await timed("vp9 .webm, 2 workers", () => renderVideo(tl(), p.root, out("alpha.webm"), { workers: 2 }));
v = probe(out("alpha.webm")).streams.find((s) => s.codec_type === "video");
f = rgbaFrame(out("alpha.webm"), 1.5, true);
check("vp9 alpha_mode tag", v?.codec_name === "vp9" && (v?.tags?.alpha_mode ?? v?.tags?.ALPHA_MODE) === "1", v?.tags);
check("vp9 decoded alpha", r.alpha === true && px(f, W - 6, H - 6)[3] < 8 && px(f, 30, 30)[3] > 245, { c: px(f, W - 6, H - 6), v: px(f, 30, 30) });
check("the vp9 export with alpha carries the BT.709 tags", tagsOf(out("alpha.webm")) === BT709, tagsOf(out("alpha.webm")));
r = await timed("vp9 .webm, no alpha", () => renderVideo(tl(), p.root, out("plain.webm"), { alpha: false, workers: 1, end: 0.5 }));
check("a plain (no alpha) vp9 export carries the BT.709 tags", r.codec === "vp9" && r.alpha === false && tagsOf(out("plain.webm")) === BT709, { c: r.codec, t: tagsOf(out("plain.webm")) });

r = await timed("h264 .mp4 (alpha dropped)", () => renderVideo(tl(), p.root, out("flat.mp4"), { workers: 1 }));
f = rgbaFrame(out("flat.mp4"), 1);
check("mp4 warns alpha dropped", r.alpha === false && r.codec === "h264" && /alpha dropped/.test(r.warnings?.[0] ?? ""), r.warnings);
check("mp4 composited on black", px(f, W - 6, H - 6).slice(0, 3).every((c) => c < 24) && px(f, W - 6, H - 6)[3] === 255, px(f, W - 6, H - 6));
r = await renderVideo(tl(), p.root, out("flat2.mp4"), { workers: 1, alpha: false, end: 0.5 });
check("alpha:false is silent", r.alpha === false && !r.warnings, r.warnings);
check("the h264 export carries the BT.709 tags", tagsOf(out("flat.mp4")) === BT709, tagsOf(out("flat.mp4")));

console.log("colour: the pixels agree with the tags");
{
  const G = join(tmp, "green");
  api.create(G, { width: W, height: H, fps: 10 });
  await applyLatest(G, [{ op: "add_clip", track: "main", type: "color", color: "#00ff00", duration: 0.5 }]);
  const gp = openProject(G), gtl = () => gp.absolutized(openProject(G).load());
  await renderVideo(gtl(), gp.root, join(G, "renders", "green.mp4"), { workers: 1 });
  const c = centreAs709(join(G, "renders", "green.mp4"));
  check("a pure green frame, read with the BT.709 matrix the file is tagged with, is green (the BT.601 matrix made G 216)", c[1] >= 250 && c[0] <= 6 && c[2] <= 6, c);
  await renderVideo(gtl(), gp.root, join(G, "renders", "green.gif"), { workers: 1 });
  const g = Array.from(rgbaFrame(join(G, "renders", "green.gif"), 0).subarray(0, 4)); // a gif is made at half size, and every pixel is the same green
  check("a gif made from the same frame keeps the green", g[1] >= 250 && g[0] <= 6 && g[2] <= 6, g);
}

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
  await applyLatest(S, [{ op: "set_settings", background: "#00000000" },
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
    await applyLatest(dir, [{ op: "set_settings", background: "#00ff00" }, { op: "add_clip", track: "overlay", src: so(f), at: 0, duration: 1 }]).catch(() => {});
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
  await applyLatest(O, [{ op: "set_settings", background: "#ff0000" }, { op: "add_clip", track: "overlay", type: "shape", shape: "rect", size: [100, 100], fill: "#0000ff", at: 0, duration: 1 }]);
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
  await applyLatest(SP, [{ op: "add_clip", track: "main", src: join(m, "mute.mp4"), at: 0, duration: 2 }]);
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
  await applyLatest(SP, [{ op: "add_captions", words: [{ text: "one", start: 0, end: 0.5 }, { text: "two", start: 0.5, end: 1 }] }]);
  for (const [f, workers] of [["mute-sub.mp4", 1], ["mute-sub2.mkv", 2]] as const) {
    const rs: any = await api.render(SP, { out: so(f), subtitles: true, workers, end: 1, sheet: false });
    check(`silent ${f} with subtitles: subtitle stream, no audio stream, has_audio false`, kinds(so(f)) === "subtitle,video" && rs.has_audio === false && rs.subtitles?.cues > 0, { k: kinds(so(f)), rs });
  }
  await applyLatest(SP, [{ op: "add_clip", track: "music", src: join(m, "tone.wav"), at: 0, duration: 2, volume: 0.01 }]);
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
  check("kinsoku: no line starts with a closing mark or ends with an opening one", bad.length === 0, { n: bad.length, first: bad.slice(0, 2) });
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
    await applyLatest(dir, [{ op: "set_settings", background: "#ff0000" }, { op: "add_clip", track: "overlay", src, at: 0, duration: 1 }]);
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
    await applyLatest(dir, [{ op: "set_settings", background: "#00000000" },
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
      `const o={kind:"video",srcW:64,srcH:64,rate:24,fit:"fill",box:[64,64],facts:${JSON.stringify({ ...VIDEO_FACTS, format: "matroska,webm" })}};const t=(x)=>{try{new FrameSource({path:"a.webm",...o,...x});return "ok"}catch(e){return e.code+"|"+e.hint}};` +
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
    const fs = new FrameSource({ path: url, kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], facts: VIDEO_FACTS });
    check("decode refuses a non-file source", (await fs.readAt(0).catch((e) => e.code)) === "decode_failed");
    fs.close();
    const opened = await requests();
    check("a non-file source is never opened", opened === 0, opened);
    // a playlist that names a network URL: probe and decode both refuse it
    const list = join(m, "net.m3u8");
    writeFileSync(list, `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhttp://127.0.0.1:${port}/seg.ts\n#EXT-X-ENDLIST\n`);
    check("probe refuses a playlist that names a network URL", await refused(() => probeMedia(list)));
    const dec = new FrameSource({ path: list, kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], facts: VIDEO_FACTS });
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
    await applyLatest(fileP, { op: "add_clip", track: "text", text: "Hamburg", at: 0, duration: 1, font_size: 60, font: join(fa, "Brand.ttf") });
    await applyLatest(refP, { op: "add_clip", track: "text", text: "Hamburg", at: 0, duration: 1, font_size: 60, font: "Arial", weight: 400 });
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
  await applyLatest(D, [{ op: "add_clip", track: "text", id: "t", text: NONE, at: 0, duration: 1, font_size: 60 }]);
  const draw = async (text: string) => { await applyLatest(D, [{ op: "update_clip", id: "t", set: { text } }]); return Buffer.from((await api.frameImage(D, 0, { scale: 1, format: "png" })).data); };
  if (!cjkFont) console.log("  - skipped: no CJK font installed");
  else {
    const none = await draw(NONE);
    const T1 = "你好，世界！今天我们一起做视频。日本語のテキストも、한국어 텍스트도";
    const boxes: string[] = [];
    for (const ch of new Set([...T1])) if (ch.trim() && !/[\x20-\x7e]/.test(ch) && (await draw(ch)).equals(none)) boxes.push(ch);
    check("every Chinese, Japanese and Korean character of the sample draws a glyph with the default font (none looks like a missing glyph)", boxes.length === 0, boxes);
  }
  await applyLatest(D, [{ op: "update_clip", id: "t", set: { text: `Hello ${NONE} there` } }, { op: "add_clip", track: "text", id: "e", text: "👨‍👩‍👧 family 🇻🇳 flag 1️⃣ keycap 👍🏽 tone ❤️ heart", at: 1, duration: 1 }]);
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
  await applyLatest(U, [{ op: "add_clip", track: "text", text: "Hello", at: 0, duration: 1, font: "NoSuchFontXyz" }], { allowInvalid: true });
  const cold = gate(U, join(tmp, "gate-cache")), warm = gate(U, join(tmp, "gate-cache"));
  check("empty cache, ASCII text, unknown font: validate and info both report it (Skia is loaded to learn the families)", cold.valid === false && cold.errors === 1 && cold.infoErrors === 1 && /not found/.test(cold.issues[0].message) && cold.loaded === true, cold);
  check("warm cache: the same answer, and Skia is not loaded", warm.valid === false && warm.errors === 1 && warm.infoErrors === 1 && warm.issues[0].message === cold.issues[0].message && warm.loaded === false, warm);
  const FILE = "/System/Library/Fonts/Supplemental/Andale Mono.ttf";
  if (!existsSync(FILE)) console.log("  - skipped: no system .ttf for the font-file row");
  else {
    const F = join(tmp, "gate-font-file");
    api.create(F, { width: 320, height: 120, fps: 24 });
    await applyLatest(F, [{ op: "add_clip", track: "text", text: "Hello", at: 0, duration: 1, font: FILE }]);
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
  const short = (srcDuration?: number) => new FrameSource({ path: join(m, "short.ts"), kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], srcDuration, facts: api.probe(join(m, "short.ts")) });
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
  // an H.264 ts read after a seek prints decoder text about frames it decodes ahead of the first slot (they miss their references): that is no failure of the clip
  const ts264 = join(m, "h264.ts");
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=4", "-c:v", "libx264", "-preset", "veryfast", "-g", "12", "-bf", "2", "-x264-params", "open-gop=0", "-pix_fmt", "yuv420p", "-f", "mpegts", ts264);
  const h264 = (path: string, srcIn: number) => new FrameSource({ path, kind: "video", srcW: 64, srcH: 64, rate: 25, fit: "fill", box: [64, 64], srcIn, srcDuration: 4, facts: api.probe(path) });
  const streamed = h264(ts264, 0);
  for (let k = 0; k <= 108; k++) await streamed.readAt(k / 25);
  const heldTs = await streamed.readAt(4.4);
  streamed.close();
  for (const srcIn of [0, 3]) {
    const f = h264(ts264, srcIn), got = await f.readAt((4.4 - srcIn)).catch((e) => e?.code); f.close();
    check(`a fresh H.264 ts read past the end (in ${srcIn}) holds the last frame the stream shows`, Buffer.isBuffer(got) && got.equals(heldTs), Buffer.isBuffer(got) ? got.length : got);
  }
  // a source that gives no frame well inside its probed length still fails (a ts cut after its first packets, read from a seek), and keeps the decoder's text in the message;
  // text from a frame that is shown fails the read (40 packets overwritten after the first second, read from the file's start)
  const tsBytes = readFileSync(ts264), packets = Math.floor(tsBytes.length / 188);
  writeFileSync(join(m, "h264-head.ts"), tsBytes.subarray(0, 188 * 12));
  const broken = Buffer.from(tsBytes);
  for (let i = 150; i < 190 && i < packets; i++) broken.fill(0x55, i * 188 + 8, i * 188 + 188); // which packets make the decoder print is a property of this stream: the row checks that it did
  writeFileSync(join(m, "h264-damaged.ts"), broken);
  const noFrame = h264(join(m, "h264-head.ts"), 1.5), noFrameErr: any = await noFrame.readAt(0).catch((x) => x); noFrame.close();
  check("a plain clip whose ts gives no frame inside its probed length is decode_failed, with the decoder's text kept in the message", noFrameErr?.code === "decode_failed" && /the source ended after 0 frames at 1\.50s: [\s\S]*\[h264/.test(noFrameErr.message), noFrameErr?.message ?? "no error");
  const damaged = h264(join(m, "h264-damaged.ts"), 0), damagedErr: any = await (async () => { for (let k = 0; k <= 108; k++) await damaged.readAt(k / 25); })().catch((x) => x); damaged.close();
  check("a ts whose packets are damaged in a shown frame is decode_failed with the decoder's words", damagedErr?.code === "decode_failed" && /\[h264/.test(damagedErr.message), damagedErr?.message ?? "no error");
  // a loop clip repeats the probed length (2 s here): a source that ends well inside it fails as a plain clip's does, within the plain clip's allowance it is read
  for (const [name, secs] of [["loop-short", 1], ["loop-near", 1.7]] as const) ff("-f", "lavfi", "-i", `testsrc2=size=64x64:rate=30:duration=${secs}`, "-pix_fmt", "yuv420p", join(m, `${name}.mp4`));
  const looped = (name: string, srcIn: number) => new FrameSource({ path: join(m, `${name}.mp4`), kind: "video", srcW: 64, srcH: 64, rate: 30, fit: "fill", box: [64, 64], srcIn, srcDuration: 2, loop: true, facts: api.probe(join(m, `${name}.mp4`)) });
  const short1 = looped("loop-short", 0), shortErr: any = await short1.readAt(0).catch((x) => x); short1.close(); // the check reads at D - 0.5 - 1/r whatever the in-point: one in-point runs the same branch as any
  check("a loop source that ends well inside its probed length is decode_failed, naming the recorded length, with the relink, remux and loop false hint",
    shortErr?.code === "decode_failed" && /the project records 2\.00s of picture/.test(shortErr.message) && /relink_asset/.test(shortErr.hint) && /remux/.test(shortErr.hint) && /loop false/.test(shortErr.hint), shortErr?.message ?? "no error");
  // a source whose frame interval (1 s) is above the allowance: its last frame starts before the check's point, and the loop must still read across the wrap
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=1:duration=4", "-pix_fmt", "yuv420p", join(m, "loop-slow.mp4"));
  const slowInfo = api.probe(join(m, "loop-slow.mp4")), slow = new FrameSource({ path: join(m, "loop-slow.mp4"), kind: "video", srcW: 64, srcH: 64, srcFps: slowInfo.fps, rate: 30, fit: "fill", box: [64, 64], srcDuration: slowInfo.video_duration ?? slowInfo.duration, loop: true, facts: slowInfo });
  const slowWrap = await slow.readAt(4.5).catch((x) => x?.code); slow.close();
  check("a 1 fps loop source is read across the wrap, not refused by the length check", Buffer.isBuffer(slowWrap), slowWrap);
  const near = looped("loop-near", 0), nearFrame = await near.readAt(0).catch((x) => x?.code); near.close();
  check("a loop source short by less than the allowance of a plain clip (0.5 s) is read", Buffer.isBuffer(nearFrame), nearFrame);
  // a freeze at or past the video's end holds its last frame, as a playing clip does (the seek of a still lands past the last frame's interval)
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=30:duration=2", "-pix_fmt", "yuv420p", join(m, "endclip.mp4"));
  const frz = (srcIn: number, srcDuration = 2, mode: { loop?: boolean; reverse?: boolean } = {}) => new FrameSource({ path: join(m, "endclip.mp4"), kind: "video", srcW: 64, srcH: 64, rate: 30, fit: "fill", box: [64, 64], srcDuration, freeze: true, srcIn, facts: api.probe(join(m, "endclip.mp4")), ...mode });
  const lastPlayed = new FrameSource({ path: join(m, "endclip.mp4"), kind: "video", srcW: 64, srcH: 64, rate: 30, fit: "fill", box: [64, 64], srcDuration: 2, facts: api.probe(join(m, "endclip.mp4")) });
  const tailRef = await lastPlayed.readAt(5);
  const inside = frz(1.0), insideFrame = await inside.readAt(0);
  check("a freeze well inside the source still holds the frame at its in-point", insideFrame.length === 64 * 64 * 4 && !insideFrame.equals(tailRef));
  for (const at of [2, 2.2, 6]) {
    const fz = frz(at);
    const got = await fz.readAt(0).catch((e) => e?.code);
    check(`a freeze with in ${at} (source 2 s) holds the source's last frame`, Buffer.isBuffer(got) && got.equals(tailRef), Buffer.isBuffer(got) ? got.length : got);
    fz.close();
  }
  for (const [name, mode, at] of [["reverse", { reverse: true }, 2], ["reverse", { reverse: true }, 6]] as const) {
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
      await applyLatest(d, [{ op: "add_clip", track: "main", src: join(m, "endclip.mp4"), ...op }, { op: "freeze_frame", id: "vid1", at, duration: 1 }]);
    }
    const fl = await api.frameImage(L, 2.7, { scale: 1 }).catch((e: any) => e), fp = await api.frameImage(P, 0.7, { scale: 1 }).catch((e: any) => e);
    check("freeze_frame in the second pass of a looping clip holds the frame that was playing", fl?.data?.length > 100 && fp?.data?.length > 100 && Buffer.from(fl.data).equals(Buffer.from(fp.data)), fl?.code ?? fp?.code);
  }
  const cutOf = (mode: { loop?: boolean; reverse?: boolean }) => new FrameSource({ path: join(m, "short.ts"), kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], srcDuration: 1.6, freeze: true, srcIn: 1, facts: api.probe(join(m, "short.ts")), ...mode });
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
    await applyLatest(F, [{ op: "add_clip", track: "main", src: join(m, "endclip.mp4") }, { op: "freeze_frame", id: "vid1", at: "end", duration: 1 }]);
    const fr = await api.frameImage(F, 2.5, { scale: 1 }).catch((e: any) => e);
    check("freeze_frame at the end of a clip that runs to the end of its file renders", fr?.data?.length > 100, fr?.code ?? fr?.message);
  }
  {
    // matroska and webm give no per-stream length: the picture's end comes from the stream's own tag (when it starts with the container) or its packets, and a file written to a pipe has no length anywhere
    const pic = ["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=2"], sine = (d: number) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=${d}`];
    const VP9 = ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8"], MKV = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"], WEBM = [...VP9, "-c:a", "libopus"];
    const made = (name: string, args: string[]) => { ff(...args, join(m, name)); return api.probe(join(m, name)); };
    const piped = (name: string, args: string[]) => { writeFileSync(join(m, name), spawnSync("ffmpeg", ["-v", "error", "-y", ...args, "-f", "webm", "-"], { maxBuffer: 1 << 26 }).stdout); return api.probe(join(m, name)); };
    const is = (x: number | undefined, want: number) => x !== undefined && Math.abs(x - want) < 0.01;
    const longer = [made("mk-long.mkv", [...pic, ...sine(2.5), ...MKV]), made("mk-long.webm", [...pic, ...sine(2.5), ...WEBM])];
    check("an mkv and a webm whose sound outlasts the picture record the picture's length and the container's", longer.every((i) => is(i.video_duration, 2) && i.duration > 2.4), longer.map((i) => [i.video_duration, i.duration]));
    const shorter = [made("mk-short.mkv", [...pic, ...sine(1.5), ...MKV]), made("mk-short.webm", [...pic, ...sine(1.5), ...WEBM])];
    check("an mkv and a webm whose sound is shorter record no picture length: the container's is the picture's", shorter.every((i) => i.video_duration === undefined && is(i.duration, 2)), shorter.map((i) => [i.video_duration, i.duration]));
    const late = made("mk-late.mkv", ["-itsoffset", "1", ...pic, ...sine(3.5), ...MKV]); // the stream's tag is an end time here, not a length: the picture ends at 3 s
    check("an mkv whose picture starts 1 s late and ends before its sound records where the picture ends on the container's clock", is(late.video_start, 1) && is(late.video_duration, 3) && late.duration > 3.4, late);
    const shifted = made("mk-shift.mkv", [...pic, ...sine(2.5), ...MKV, "-output_ts_offset", "1.4"]); // every stream starts at 1.4 s on the file's own clock: an end-time tag would read 3.4
    check("an mkv whose streams all start at 1.4 s, with sound longer, records the picture's length, not its end on the file's clock", is(shifted.container_start, 1.4) && is(shifted.video_start, 0) && is(shifted.video_duration, 2) && Math.abs(shifted.duration - 2.5) < 0.05, shifted); // the AAC track adds its priming (23 ms) to the 2.5 s of sound
    // matroska, ogg, nut and asf report the end on the file's clock as the length; the file's length is that less the container's start
    const offset = ["-output_ts_offset", "1.4"], shiftedWebm = made("mk-shift.webm", [...pic, ...sine(2.5), ...WEBM, ...offset]);
    const shiftedAudio = [made("ao-shift.mkv", [...sine(2.5), "-c:a", "libopus", ...offset]), made("ao-shift.ogg", [...sine(2.5), "-c:a", "libopus", ...offset]),
      made("ao-shift.nut", [...sine(2.5), "-c:a", "pcm_s16le", ...offset]), made("ao-shift.wma", [...sine(2.5), "-c:a", "wmav2", ...offset])];
    check("a webm, an audio-only mkv, ogg, nut and asf whose streams all start at 1.4 s record the length of the sound (2.5 s), not its end on the file's clock",
      is(shiftedWebm.duration, 2.5) && is(shiftedWebm.video_duration, 2) && shiftedAudio.every((i) => i.kind === "audio" && Math.abs(i.duration - 2.5) < 0.05), [shiftedWebm.duration, shiftedWebm.video_duration, ...shiftedAudio.map((i) => i.duration)]);
    // a stream that starts before 0 on the file's clock (a cut, an edit list): the end on the clock is that much shorter than the length
    const early = ["-output_ts_offset", "-0.5", "-avoid_negative_ts", "disabled"], earlySound = made("ao-early.mka", [...sine(2.5), "-c:a", "libopus", ...early]), earlyOgg = made("ao-early.ogg", [...sine(2.5), "-c:a", "libopus", ...early]);
    const earlyMkv = made("mk-early.mkv", [...pic, "-itsoffset", "-0.5", ...sine(2.5), ...MKV.slice(0, 4), "-c:a", "libopus", "-avoid_negative_ts", "disabled"]); // the sound starts at -0.5 s, the picture at 0 s
    check("an mka and an ogg whose sound starts at -0.5 s, and an mkv whose sound does, record the 2.5 s of sound, not its end on the file's clock",
      [earlySound, earlyOgg, earlyMkv].every((i) => Math.abs(i.duration - 2.5) < 0.05) && is(earlyMkv.container_start, -0.5) && is(earlyMkv.video_start, 0.5), [earlySound.duration, earlyOgg.duration, earlyMkv]);
    // the matroska demuxer gives no time to a block before 0: a picture that starts at -0.5 s has unstamped first packets
    const refused = (name: string, args: string[]) => { try { return made(name, args); } catch (e: any) { return { code: e.code, message: e.message, hint: e.hint }; } };
    const unstamped = [refused("mk-unstamped.mkv", [...pic, ...sine(2.5), ...MKV.slice(0, 4), "-c:a", "libopus", ...early]), refused("mk-unstamped-pic.mkv", [...pic, ...MKV.slice(0, 4), ...early])];
    check("an mkv whose first picture packets carry no timestamp, with sound and without, is refused when probed", unstamped.every((i) => i.code === "bad_media"), unstamped);
    const longPcm = made("avi-long-pcm.avi", [...pic, ...sine(3), "-c:v", "mpeg4", "-c:a", "pcm_s16le"]);
    check("an avi whose uncompressed sound outlasts its picture records the sound's length and the picture's", is(longPcm.duration, 3) && is(longPcm.video_duration, 2), longPcm);
    // a file cut off mid-write keeps its header's planned length (3 s); its 200000 bytes hold at most 2.27 s of this sound (88200 bytes/s)
    writeFileSync(join(m, "avi-cut-pcm.avi"), readFileSync(join(m, "avi-long-pcm.avi")).subarray(0, 200000));
    const cutPcm = api.probe(join(m, "avi-cut-pcm.avi"));
    check("an avi cut off mid-write records the sound its packets hold, not the length its header plans", cutPcm.duration > 1.4 && cutPcm.duration < 200000 / 88200, cutPcm);
    // mov/mp4 report their length, not an end: the same offset must leave the length alone (a wrong subtraction would give about 1.1 s)
    const shiftedMp4 = made("mp4-shift.mp4", ["-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=2.5", ...sine(2.5), ...MKV, ...offset]);
    check("an mp4 whose streams all start at 1.4 s records its length (2.5 s), the container's start is not taken from it", Math.abs(shiftedMp4.duration - 2.5) < 0.05 && Math.abs(shiftedMp4.container_start - 1.4) < 0.05, shiftedMp4);
    const live = [piped("pipe-video.webm", [...pic, ...VP9]), piped("pipe-sound.webm", [...pic, ...sine(2.5), ...WEBM]), piped("pipe-audio.webm", [...sine(1), "-c:a", "libopus"])];
    check("a webm written to a pipe records the length its packets show: the picture's, the longer sound's with the picture's apart, an audio-only file's",
      is(live[0].duration, 2) && live[0].video_duration === undefined && live[1].duration > 2.4 && is(live[1].video_duration, 2) && live[2].kind === "audio" && is(live[2].duration, 1), live.map((i) => [i.kind, i.duration, i.video_duration]));
  }
  // audio longer than video: srcDuration is the picture's length (the asset's video_duration), not the container's
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-pix_fmt", "yuv420p", join(m, "longaudio.mp4"));
  const la = new FrameSource({ path: join(m, "longaudio.mp4"), kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], srcDuration: 1, facts: api.probe(join(m, "longaudio.mp4")) });
  await la.readAt(0.5);
  check("a video clip that runs past its picture holds the last frame while the sound goes on", (await code(la.readAt(2))) === "ok");
  // a fresh source (later render segment, preview) read past the picture's end of the same file holds the picture's last frame
  const la2 = new FrameSource({ path: join(m, "longaudio.mp4"), kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], srcDuration: 1, facts: api.probe(join(m, "longaudio.mp4")) });
  const lh = await la2.readAt(2).catch(() => Buffer.alloc(0));
  check("a fresh read past the video's end of a file with longer audio holds the last frame", lh.length === 64 * 64 * 4 && lh.some((x) => x !== 0), lh.length);
  la2.close();
  la.close();
  {
    // a looped clip of a file with longer sound wraps at the picture's length, not the container's
    ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", "-pix_fmt", "yuv420p", join(m, "loop-al.mp4"));
    const LP = join(tmp, "loop-al");
    api.create(LP, { width: 64, height: 64, fps: 24 });
    await applyLatest(LP, [{ op: "add_clip", track: "main", src: join(m, "loop-al.mp4"), loop: true, duration: 12 }]);
    const at = async (t: number) => Buffer.from((await api.frameImage(LP, t, { scale: 1 })).data);
    const [f05, f29, f35, f95] = [await at(0.5), await at(2.9), await at(3.5), await at(9.5)];
    check("a looped video clip of a file with longer sound wraps at the picture's length (3.5 s and 9.5 s show the picture of 0.5 s), so no cycle holds a frozen frame", f35.equals(f05) && f95.equals(f05) && !f35.equals(f29), [f05.length, f29.length]);
  }
  {
    // a looping clip over a file with a keyframe at 1 s (every frame carries its number): a render shows the file's frames in order across three wraps, and the second worker's segment (it starts inside a pass) shows the same
    const W2 = 160, H2 = 120, numbered = `color=c=gray:s=${W2}x${H2}:r=25:d=2,format=yuv420p,geq=lum='if(lt(Y,${H2 >> 3}),255*bitand(floor(N/pow(2,floor(X/10))),1),128)':cb=128:cr=128`;
    ff("-f", "lavfi", "-i", numbered, "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", "-g", "25", "-x264-params", "keyint=25:min-keyint=25:scenecut=0", join(m, "loop-kf.mp4"));
    const LK = join(tmp, "loop-kf");
    api.create(LK, { width: W2, height: H2, fps: 25 });
    await applyLatest(LK, [{ op: "add_clip", track: "main", src: join(m, "loop-kf.mp4"), at: 0, in: 1.5, duration: 5.2, loop: true }]);
    const shown = async (workers: number) => {
      const out = join(tmp, `loop-kf-${workers}.mp4`);
      await api.render(LK, { out, workers, sheet: false });
      const raw = spawnSync("ffmpeg", ["-v", "error", "-i", out, "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 28 }).stdout, fb = W2 * H2 * 4;
      return Array.from({ length: Math.floor(raw.length / fb) }, (_, k) => { let n = 0; for (let i = 0; i < 16; i++) if (raw[k * fb + (Math.floor(H2 / 16) * W2 + i * 10 + 5) * 4] > 128) n |= 1 << i; return n; });
    };
    const one = await shown(1), two = await shown(2), want = Array.from({ length: 130 }, (_, k) => (37 + k) % 50); // in 1.5 = frame 37.5: the older frame at the tie
    check("a render of a looping clip over a file with a keyframe inside shows the file's frames across three wraps, with one worker and with two", one.length === 130 && JSON.stringify(one) === JSON.stringify(want) && JSON.stringify(two) === JSON.stringify(one), { one, two });
  }
  {
    // a record without video_duration (written by hand) on a 2 s picture with 4 s of sound: the early end is decode_failed, and its hint names the action that works
    ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-pix_fmt", "yuv420p", join(m, "p2s4.mp4"));
    const H = join(tmp, "hint-early");
    api.create(H, { width: 64, height: 64, fps: 24 });
    await applyLatest(H, [{ op: "add_clip", track: "main", src: join(m, "p2s4.mp4"), duration: 4, id: "v" }]);
    const pj = JSON.parse(readFileSync(join(H, "project.json"), "utf8"));
    const aid = Object.keys(pj.assets)[0], had = pj.assets[aid].video_duration;
    delete pj.assets[aid].video_duration;
    writeFileSync(join(H, "project.json"), JSON.stringify(pj, null, 2));
    const early: any = await api.frameImage(H, 3, { scale: 1 }).catch((e: any) => e);
    check("a source that ends early names relink_asset with the same path, trim_clip's alternative, and not re-import", early.code === "decode_failed" && /relink_asset/.test(early.hint) && /same path/.test(early.hint) && !/re-import/.test(early.hint), { had, code: early.code, hint: early.hint });
    await applyLatest(H, [{ op: "relink_asset", id: aid, path: join(m, "p2s4.mp4") }]);
    const after: any = await api.frameImage(H, 3, { scale: 1 }).catch((e: any) => e);
    check("relink_asset with the same path records the picture's length, and the frame past it is then held", after?.data?.length > 100, after?.code ?? after?.message);
  }
  // N3/N4: the picture's last frame is decoded once per source, however often a jump past the end repeats, and nothing asks ffprobe
  if (process.platform !== "win32") {
    const bin = join(tmp, "shim-bin"), log = join(tmp, "shim.log");
    mkdirSync(bin);
    for (const tool of ["ffmpeg", "ffprobe"]) {
      const real = spawnSync("which", [tool], { encoding: "utf8" }).stdout.trim();
      writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
    }
    const PATH1 = process.env.PATH;
    process.env.PATH = `${bin}:${PATH1}`;
    const rs = new FrameSource({ path: join(m, "longaudio.mp4"), kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], srcDuration: 1, facts: api.probe(join(m, "longaudio.mp4")) });
    const first = await rs.readAt(2.6).catch(() => Buffer.alloc(0));
    await rs.readAt(0.5);
    const again = await rs.readAt(2.6).catch(() => Buffer.alloc(0));
    process.env.PATH = PATH1;
    rs.close();
    const lines = readFileSync(log, "utf8").split("\n");
    check("a back-seek and a second jump past the end decodes the picture's last frame once and asks ffprobe nothing",
      lines.filter((l) => l.startsWith("ffprobe ")).length === 0 && lines.filter((l) => l.startsWith("ffmpeg ") && l.includes("-ss 0.666667 ")).length === 1 /* the tail: slot 22 of a 1 s picture at 24 fps, less the 0.25 s pre-roll */ && first.length === 64 * 64 * 4 && again.equals(first), lines);
  }
  b.close();
  const sk = new FrameSource({ path: join(m, "v.mp4"), kind: "video", srcW: W, srcH: H, rate: 24, fit: "fill", box: [W, H], facts: api.probe(join(m, "v.mp4")) });
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
  await applyLatest(Q, [{ op: "add_clip", track: "overlay", src: join(m, "bad.mp4"), at: 0, duration: 2 }]);
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
  await applyLatest(H1, [{ op: "add_clip", track: "overlay", src: join(m, "onesec.mp4"), at: 0, duration: 2 }]);
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
  await applyLatest(D, [
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
  await applyLatest(G, [{ op: "add_clip", track: "overlay", src: join(m, "s30.mp4"), at: 0, duration: 3 }]);
  const [g1, g2] = await renderTwice(G, [1, 2]);
  check("a held frame of a 30 fps source on a 24 fps timeline is the same for one and two workers", g1.length === 72 && differ(g1, g2).length === 0, [g1.length, g2.length, differ(g1, g2)]);


  // A-27: a layer that has ended keeps no canvas
  const C = join(tmp, "projc");
  api.create(C, { width: W, height: H, fps: 24 });
  await applyLatest(C, Array.from({ length: 6 }, (_, i) => ({ op: "add_clip", track: "overlay", src: join(m, "v.mp4"), at: i * 0.5, duration: 0.5, scale: 0.9 })));
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

console.log("colour: a source with no matrix tag is read as BT.709 when it is HD");
{
  const { FrameSource, MATTE_FACTS } = await import("../src/media.ts");
  // flat green, converted to YUV with the named matrix, then the tags are set or cleared: "none" writes no tag, "709" and "601" write the set that goes with that matrix
  const SET = { none: "colorspace=unknown:color_primaries=unknown:color_trc=unknown:range=unknown", "709": "colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv", "601": "colorspace=smpte170m:color_primaries=smpte170m:color_trc=smpte170m:range=tv", "2020": "colorspace=bt2020nc:color_primaries=bt2020:color_trc=bt709:range=tv", dci: "colorspace=bt709:color_primaries=bt709:color_trc=smpte428:range=tv", "2020none": "colorspace=unknown:color_primaries=bt2020:color_trc=bt709:range=tv" };
  const mk = (name: string, size: string, matrix: "bt709" | "bt601" | "bt2020", tags: keyof typeof SET, colour = "00ff00") => {
    const f = join(m, `${name}.mp4`);
    ff("-f", "lavfi", "-i", `color=c=0x${colour}:s=${size}:r=24:d=1,format=rgba`, "-vf", `scale=out_color_matrix=${matrix}:out_range=tv,setparams=${SET[tags]},format=yuv420p`, "-c:v", "libx264", f);
    return f;
  };
  const hd709 = mk("hd709-untagged", "1280x720", "bt709", "none"), sd601 = mk("sd601-untagged", "640x360", "bt601", "none");
  const hd709t = mk("hd709-tagged", "1280x720", "bt709", "709"), hd601t = mk("hd601-tagged", "1280x720", "bt601", "601"), hd601 = mk("hd601-untagged", "1280x720", "bt601", "none");
  const hd2020t = mk("hd2020-tagged", "1280x720", "bt2020", "2020"), hdDci = mk("hd-dci", "1280x720", "bt709", "dci");
  const tagsRecorded = [hd709, sd601, hd709t, hd601t, hd2020t, hdDci].map((f) => `${api.probe(f).color_space} ${api.probe(f).color_primaries}/${api.probe(f).color_transfer}`);
  check("the probe records the stream's own matrix, primaries and transfer tags, and one fixed word for each it has not",
    tagsRecorded.join() === "unknown unknown/unknown,unknown unknown/unknown,bt709 bt709/bt709,smpte170m smpte170m/smpte170m,bt2020nc bt2020/bt709,bt709 bt709/smpte428", tagsRecorded);
  // a matrix the FFmpeg scaler cannot convert to RGB is refused when the file is probed: the tag is written into the stream directly, since the encoder cannot make a picture with it
  const refusedTag = join(m, "matrix-bt2020c.mp4");
  ff("-f", "lavfi", "-i", "color=c=0x00ff00:s=64x64:r=24:d=1,format=yuv420p", "-c:v", "libx264", "-bsf:v", "h264_metadata=matrix_coefficients=10", refusedTag);
  const refusedProbe = (() => { try { api.probe(refusedTag); return "accepted"; } catch (e: any) { return `${e.code}: ${e.message}`; } })();
  check("a file whose matrix tag the pipeline cannot convert (bt2020c) is refused when probed, naming the matrix", /^bad_media: .*bt2020c/.test(refusedProbe), refusedProbe);
  // a render names a source whose colours are not converted in its warnings (the export is tagged BT.709); a BT.709 source, and a BT.2020 one that is converted, add nothing
  const warnsOf = async (name: string, src: string) => {
    const D = join(tmp, `warn-${name}`);
    api.create(D, { width: W, height: H, fps: 10 });
    await applyLatest(D, [{ op: "import_media", path: src, id: name }, { op: "add_clip", track: "main", asset: name, duration: 0.5 }]);
    const dp = openProject(D);
    return [((await renderVideo(dp.absolutized(dp.load()), dp.root, join(D, "renders", "o.mp4"), { workers: 1 })) as any).warnings as string[],
      ((await api.render(D, { out: join(D, "renders", "o.png"), sheet: false })) as any).warnings as string[] | undefined ?? []];
  };
  const [[warn709, still709], [warnDci, stillDci], [warn2020, still2020]] = [await warnsOf("ctl", hd709t), await warnsOf("dci", hdDci), await warnsOf("wide", hd2020t)];
  check("a render of a source with an unconverted transfer warns once, naming the asset; the BT.709 control and a converted BT.2020 source get no such warning",
    warnDci.length === warn709.length + 1 && warnDci.filter((w) => w.includes("'dci'")).length === 1 && !warn709.some((w) => w.includes("'ctl'")) && !warn2020.some((w) => w.includes("'wide'")), { warn709, warnDci, warn2020 });
  check("so does a still render of it (.png), and the control's and the converted source's stills get none",
    stillDci.filter((w) => w.includes("'dci'")).length === 1 && still709.length === 0 && still2020.length === 0, { still709, stillDci, still2020 });
  const centre = async (f: string, facts: Record<string, unknown> = {}) => {
    const info = api.probe(f), src = new FrameSource({ path: f, kind: "video", srcW: info.width, srcH: info.height, rate: 24, fit: "fill", box: [64, 64], facts: { ...info, ...facts } as any });
    try { const b = await src.readAt(0), o = (32 * 64 + 32) * 4; return [b[o], b[o + 1], b[o + 2]]; } finally { src.close(); }
  };
  const green = (c: number[]) => c[1] >= 250 && c[0] <= 6 && c[2] <= 6;
  const sd709 = mk("sd709-untagged", "640x360", "bt709", "none");
  const got = { hd709: await centre(hd709), sd601: await centre(sd601), hd709t: await centre(hd709t), hd601t: await centre(hd601t), hd601: await centre(hd601), hd601set: await centre(hd601, { color_space: "smpte170m" }),
    hd709set: await centre(hd709, { color_space: "bt709" }), sd709: await centre(sd709), sd709set: await centre(sd709, { color_space: "bt709" }), tagSame: await centre(hd709t, { color_space: "bt709" }) };
  check("an untagged HD source made with the BT.709 matrix renders green (read as BT.601 it gave R 20, B 9)", green(got.hd709), got.hd709);
  check("an untagged SD source made with the BT.601 matrix still renders green", green(got.sd601), got.sd601);
  check("a source tagged BT.709 renders green, and an HD source tagged BT.601 keeps its own tag (the rule never overrides a tag)", green(got.hd709t) && green(got.hd601t), { t709: got.hd709t, t601: got.hd601t });
  check("an untagged HD source made with BT.601 is read as BT.709 (G 216), and the asset naming smpte170m reads it as BT.601 (green)", got.hd601[1] > 205 && got.hd601[1] < 225 && green(got.hd601set), { rule: got.hd601, byHand: got.hd601set });
  check("the asset naming bt709 reads an untagged HD file and an untagged SD file as BT.709 (green); the SD file with no name is still read as BT.601 (R 20, B 9)",
    green(got.hd709set) && green(got.sd709set) && got.sd709[0] >= 12 && got.sd709[2] >= 5, { hd: got.hd709set, sd: got.sd709set, sdUnnamed: got.sd709 });
  check("the asset naming the tag a file already has changes nothing", green(got.tagSame), got.tagSame);
  // every matrix name an asset accepts is one a frame can be read with
  const { COLOR_SPACES } = await import("../src/model.ts"), tiny = mk("tiny709", "64x64", "bt709", "709");
  const unreadable: string[] = [];
  for (const name of COLOR_SPACES) await centre(tiny, { color_space: name }).catch((e) => unreadable.push(`${name}: ${String(e?.message ?? e).slice(0, 80)}`));
  check("every matrix name in the accepted list decodes a frame", unreadable.length === 0, unreadable);
  // an untagged matrix with BT.2020 primaries and an SDR curve is read as bt2020nc: a mid-saturation picture comes back the same as with the matrix tagged (read as BT.709 it was 8 off in one channel)
  const [wideTagged, wideUntagged] = [mk("wide-mid-tagged", "1280x720", "bt2020", "2020", "c03030"), mk("wide-mid-untagged", "1280x720", "bt2020", "2020none", "c03030")];
  const [pxTagged, pxUntagged] = [await centre(wideTagged), await centre(wideUntagged)];
  check("an untagged matrix with BT.2020 primaries and an SDR curve is read as bt2020nc (within 3 per channel of the same picture tagged bt2020nc)", api.probe(wideUntagged).color_space === "unknown" && pxTagged.every((v, i) => Math.abs(v - pxUntagged[i]) <= 3), { untaggedMatrix: api.probe(wideUntagged).color_space, pxTagged, pxUntagged });
  // which matrix a picture is read with, from the decode chain (pixelKey), so no decode runs: the asset's own name; else BT.709 for HD (a short side from 720 or a long side from 1280); else none
  const read = (w: number, h: number, color_space = "unknown", extra: object = {}) =>
    /setparams=colorspace=([a-z0-9-]+)/.exec(new FrameSource({ path: hd709, kind: "video", srcW: w, srcH: h, rate: 24, fit: "fill", box: [64, 64], facts: { ...VIDEO_FACTS, color_space } as any, ...extra }).pixelKey)?.[1];
  const sizes: [number, number, string | undefined][] = [[1279, 719, undefined], [1280, 719, "bt709"], [1279, 720, "bt709"], [719, 1279, undefined], [719, 1280, "bt709"], [720, 1279, "bt709"], [480, 854, undefined], [720, 1280, "bt709"],
    [640, 360, undefined], [1920, 1080, "bt709"], [1280, 544, "bt709"]];
  const wrong = sizes.filter(([w, h, want]) => read(w, h) !== want);
  check("an unnamed picture is read as BT.709 when it is HD: a short side of 720 or more, or a long side of 1280 or more, in either orientation", wrong.length === 0, wrong);
  check("a name on the asset is the matrix at any size ('reserved' counts as no name); an image is never read by it",
    read(1920, 1080, "bt470bg") === "bt470bg" && read(640, 360, "bt709") === "bt709" && read(1920, 1080, "reserved") === "bt709" && read(640, 360, "reserved") === undefined
    && read(1920, 1080, "unknown", { kind: "image" }) === undefined && read(1920, 1080, "bt709", { kind: "image" }) === undefined);
  check("a background-removal matte is read as its writer made it (BT.601), at any size",
    /setparams=colorspace=smpte170m/.test(new FrameSource({ path: hd709, kind: "video", srcW: 1920, srcH: 1080, rate: 24, fit: "fill", box: [64, 64], facts: MATTE_FACTS }).pixelKey));
  const refusal = (color_space: string) => { try { new FrameSource({ path: hd709, kind: "video", srcW: 64, srcH: 64, rate: 24, fit: "fill", box: [64, 64], facts: { ...VIDEO_FACTS, color_space } as any }); return "built"; } catch (e: any) { return e.code; } };
  check("a name outside the list never reaches the decode chain: the source is refused", ["bt.709", "709", "", "bt709,format=gray", "BT709"].every((n) => refusal(n) === "bad_media"), ["bt.709", "709", "", "bt709,format=gray", "BT709"].map(refusal));
  // an HD gif (a palette picture): the rule puts its tag on it too, and it must still decode to the colour drawn
  const gifHd = join(m, "hd.gif");
  ff("-f", "lavfi", "-i", "color=c=0x00ff00:s=1280x720:r=5:d=0.4,format=rgb24", "-frames:v", "2", gifHd);
  const gifInfo = api.probe(gifHd), gifPx = await centre(gifHd).catch((e) => String(e?.message ?? e).slice(0, 200));
  check("an HD gif (probe: kind video, color_space recorded as given) decodes through FrameSource to the colour drawn", gifInfo.kind === "video" && Array.isArray(gifPx) && green(gifPx), { kind: gifInfo.kind, color_space: gifInfo.color_space, gifPx });

  // PQ, HLG and BT.2020 with an SDR curve are converted to BT.709 before anything else: six flat patches of known SDR colour are authored into each
  // (SDR RGB -> linear light -> BT.2020 primaries -> the curve, from the published formulas; 8-bit signal in a 10-bit 4:4:4 ProRes file), and each comes back as the colour it was made from.
  const PATCHES = [[0xc0, 0x30, 0x30], [0x30, 0xa0, 0x60], [0x30, 0x50, 0xe0], [0x80, 0x80, 0x80], [0xff, 0xff, 0xff], [0x20, 0x20, 0x20]];
  const TO2020 = [[0.627404, 0.329283, 0.043313], [0.069097, 0.919540, 0.011362], [0.016391, 0.088013, 0.895595]]; // linear BT.709 to BT.2020 (BT.2087)
  const pqInv = (nit: number) => { const y = (nit / 10000) ** 0.1593017578125; return ((0.8359375 + 18.8515625 * y) / (1 + 18.6875 * y)) ** 78.84375; };
  const hlgOetf = (e: number) => (e <= 1 / 12 ? Math.sqrt(3 * e) : 0.17883277 * Math.log(12 * e - 0.28466892) + 0.55991073);
  const TRC = { pq: "smpte2084", hlg: "arib-std-b67", sdr: "bt709" };
  const signal = (kind: keyof typeof TRC, rgb: number[]) => {
    const lin = TO2020.map((r) => r.reduce((s, v, j) => s + v * (rgb[j] / 255) ** 2.4, 0)), nit = lin.map((v) => v * 203); // 1.0 = SDR white = 203 nit
    if (kind === "sdr") return lin.map((v) => v ** (1 / 2.4));
    if (kind === "pq") return nit.map(pqInv);
    const k = 1000 * ((0.2627 * nit[0] + 0.678 * nit[1] + 0.0593 * nit[2]) / 1000) ** (0.2 / 1.2); // BT.2100: display light = 1000 * Ys^0.2 * Es (Y from the BT.2020 luma weights), inverted
    return nit.map((n) => hlgOetf(n / k));
  };
  const authored = (kind: keyof typeof TRC) => {
    const f = join(m, `patches-${kind}.mov`), box = PATCHES.map((p, i) => `drawbox=x=${i * 16}:y=0:w=16:h=32:c=0x${signal(kind, p).map((v) => Math.round(Math.min(Math.max(v, 0), 1) * 255).toString(16).padStart(2, "0")).join("")}:t=fill`).join(",");
    ff("-f", "lavfi", "-i", `color=c=black:s=96x32:r=24:d=1,format=gbrp,${box}`, "-vf", `scale=out_color_matrix=bt2020:out_range=tv,setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=${TRC[kind]}:range=tv,format=yuv444p10le`, "-c:v", "prores_ks", "-profile:v", "4", f);
    return f;
  };
  const bandsOf = async (f: string, facts: Record<string, unknown> = {}) => {
    const src = new FrameSource({ path: f, kind: "video", srcW: 96, srcH: 32, rate: 24, fit: "fill", box: [96, 32], facts: { ...api.probe(f), ...facts } as any });
    try { const b = await src.readAt(0); return PATCHES.map((_, i) => [0, 1, 2].map((c) => b[(16 * 96 + i * 16 + 8) * 4 + c])); } finally { src.close(); }
  };
  const off = (got: number[][]) => Math.max(...got.flatMap((p, i) => p.map((v, c) => Math.abs(v - PATCHES[i][c]))));
  const files = { pq: authored("pq"), hlg: authored("hlg"), sdr: authored("sdr") };
  check("the probe records PQ, HLG and BT.2020 primaries as the file tags them", `${api.probe(files.pq).color_primaries}/${api.probe(files.pq).color_transfer}` === "bt2020/smpte2084"
    && `${api.probe(files.hlg).color_primaries}/${api.probe(files.hlg).color_transfer}` === "bt2020/arib-std-b67" && `${api.probe(files.sdr).color_primaries}/${api.probe(files.sdr).color_transfer}` === "bt2020/bt709");
  for (const [kind, what] of [["pq", "PQ"], ["hlg", "HLG"], ["sdr", "BT.2020 with an SDR curve"]] as const) {
    const got = await bandsOf(files[kind]), raw = await bandsOf(files[kind], { color_primaries: "unknown", color_transfer: "unknown" });
    check(`a ${what} source is read as the BT.709 colours it was made from (within 6 per channel); with its tags unknown it is not (the same file, off by tens)`, off(got) <= 6 && off(raw) > 20, { got, off: off(got), unconverted: off(raw) });
  }
  const keyOf = (color_space: string, color_primaries: string, color_transfer: string) =>
    new FrameSource({ path: hd709, kind: "video", srcW: 1920, srcH: 1080, rate: 24, fit: "fill", box: [64, 64], facts: { ...VIDEO_FACTS, color_space, color_primaries, color_transfer } as any }).pixelKey;
  const keys = [keyOf("bt2020nc", "bt2020", "smpte2084"), keyOf("bt2020nc", "bt2020", "arib-std-b67"), keyOf("bt2020nc", "bt2020", "bt709"), keyOf("bt2020nc", "bt709", "smpte2084"), keyOf("bt2020nc", "unknown", "unknown")];
  check("the pixel key follows the conversion: PQ, HLG, BT.2020 with an SDR curve and PQ on BT.709 primaries differ from each other and from an unconverted source; PQ and HLG with no primaries tag are read as BT.2020; an SDR BT.709 source and an untagged one share a key",
    new Set(keys).size === 5 && keyOf("bt2020nc", "unknown", "smpte2084") === keys[0] && keyOf("bt2020nc", "unknown", "arib-std-b67") === keys[1] && keyOf("bt709", "bt709", "bt709") === keyOf("bt709", "unknown", "unknown"), keys.map((k) => k.length));
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
