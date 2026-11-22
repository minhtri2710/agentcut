// Which source frame a timeline slot shows: the same one wherever the clip's stream started, with or without an audio track, in any container.
// Every source frame carries its own number in the picture (16 blocks of 10 px), so FrameSource is compared with the choice rule built from the file's own timestamps.
// Run: bun tests/frames.ts [--keep]          (needs ffmpeg and ffprobe on PATH)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, failures, ff } from "./harness.ts";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-frames-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store - set before importing the api
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("./author-api.ts");
const { FrameSource, TIE_BIAS } = await import("../src/media.ts");

const t0 = performance.now();

const W = 160, H = 120;
const m = join(tmp, "media");
mkdirSync(m);
console.log("media ->", tmp);

const pic = (rate: string, secs: number, w = W, h = H, bw = 10) =>
  `color=c=gray:s=${w}x${h}:r=${rate}:d=${secs},format=yuv420p,geq=lum='if(lt(Y,${h >> 3}),255*bitand(floor(N/pow(2,floor(X/${bw}))),1),128)':cb=128:cr=128`;
const X264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p"];
const X264_CLOSED = [...X264, "-g", "25", "-bf", "2", "-x264-params", "open-gop=0"];
const X264_OPEN = [...X264, "-g", "25", "-bf", "3", "-x264-params", "open-gop=1:bframes=3:b-adapt=0"];
const MPEG2 = ["-c:v", "mpeg2video", "-qscale:v", "2", "-g", "12", "-bf", "2", "-pix_fmt", "yuv420p"];
const VP9 = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "20", "-deadline", "realtime", "-cpu-used", "8", "-pix_fmt", "yuv420p"];
/** A numbered clip: `audio` adds an AAC track (mp2 for mpeg-ps), `late` starts the picture that many seconds after the sound, `mux` is the output's own options. */
function make(file: string, rate: string, secs: number, enc: string[], o: { audio?: boolean; late?: number; sound?: number; mux?: string[] } = {}): string {
  const out = join(m, file);
  // sound: the sound's length in seconds, when it outlasts the picture (no -shortest)
  ff(...(o.late ? ["-itsoffset", String(o.late)] : []), "-f", "lavfi", "-i", pic(rate, secs), ...(o.audio ? ["-f", "lavfi", "-i", `sine=f=440:r=48000${o.sound ? `:d=${o.sound}` : ""}`] : []), ...enc,
    ...(o.audio ? ["-c:a", file.endsWith(".mpg") ? "mp2" : "aac", ...(o.sound ? [] : ["-shortest"])] : ["-an"]), "-fps_mode", "passthrough", ...(o.mux ?? []), out);
  if (o.late) {
    const { pts, S } = timingOf(out), [n, d = 1] = rate.split("/").map(Number);
    check(`${file}: first picture really starts ${o.late} s after the container`, pts.length > 0 && pts[0] > S && Math.abs(pts[0] - S - o.late) <= d / n + 1024 / 48000, { first: pts[0], start: S }); // one video slot plus AAC priming on the container clock
  }
  return out;
}

// ---- the oracle: the rule from the file's own timestamps
const timing = new Map<string, { pts: number[]; S: number }>();
function timingOf(file: string) {
  let t = timing.get(file);
  if (!t) {
    const f = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time", "-of", "csv=p=0", file], { encoding: "utf8", maxBuffer: 1 << 26 });
    const pts = f.stdout.split("\n").map((s) => s.replace(/,$/, "").trim()).filter(Boolean).map(Number).sort((a, b) => a - b);
    const g = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=start_time", "-of", "json", file], { encoding: "utf8" });
    t = { pts, S: Number(JSON.parse(g.stdout).format.start_time) || 0 };
    timing.set(file, t);
  }
  return t;
}
const TIE = TIE_BIAS ?? 0;
/** Slot k shows the latest source frame whose slot (its time on the clip's clock times the rate, plus half a slot and the tie bias, rounded down) is at most k; before the first frame, the first frame. */
function rule(file: string, srcIn: number, r: number, k: number, loop?: number): number {
  const { pts, S } = timingOf(file);
  let best = -1, bestSlot = -Infinity;
  const passes = loop ? Math.ceil((srcIn + (k + 2) / r) / loop) + 1 : 0;
  for (let n = loop ? -1 : 0; n <= passes; n++) for (let i = 0; i < pts.length; i++) {
    const slot = Math.floor((pts[i] - S + n * (loop ?? 0) - srcIn) * r + 0.5 + TIE);
    if (slot <= k && slot >= bestSlot) { bestSlot = slot; best = i; }
  }
  return best < 0 ? 0 : best;
}
/** The frame number in a picture: blocks of `bw` px, least significant bit first, read at the middle of the top band. */
function num(b: Buffer, w: number, h: number, bw = 10, px = 4): number {
  let n = 0;
  for (let i = 0; i < 16; i++) if (b[(Math.floor(h / 16) * w + i * bw + (bw >> 1)) * px] > 128) n |= 1 << i;
  return n;
}

interface Opts { loop?: boolean; reverse?: boolean; freeze?: boolean; segLen?: number; srcDuration?: number; facts?: any }
async function source(file: string, r: number, srcIn: number, o: Opts = {}) {
  const info = (await api.probe(file));
  return new FrameSource({ path: file, kind: "video", srcW: W, srcH: H, srcFps: info.fps, srcIn, rate: r, fit: "fill", box: [W, H], srcDuration: info.video_duration ?? info.duration, facts: info, ...o });
}
const read = async (s: InstanceType<typeof FrameSource>, k: number, r: number) => num(await s.readAt(k / r), W, H);

/** Fresh reads (a new stream per slot) and one stream read in order, against the rule: the mismatches. */
async function sweep(label: string, file: string, r: number, bases: number[], phases: number[], slots: number[], o: Opts = {}): Promise<string[]> {
  const bad: string[] = [];
  const D = o.loop ? ((await api.probe(file)).video_duration ?? (await api.probe(file)).duration) : undefined;
  for (const base of bases) for (const ph of phases) {
    const srcIn = base + ph / r, last = Math.max(...slots), want = new Set(slots), streamed = new Map<number, number>();
    try {
      const st = (await source(file, r, srcIn, o));
      for (let k = 0; k <= last; k++) { const n = await read(st, k, r); if (want.has(k)) streamed.set(k, n); }
      st.close();
      for (const k of slots) {
        const f = (await source(file, r, srcIn, o)), fresh = await read(f, k, r); f.close();
        const exp = rule(file, srcIn, r, k, D);
        if (fresh !== exp || streamed.get(k) !== exp) bad.push(`${label} in=${srcIn.toFixed(4)} k=${k}: fresh ${fresh} stream ${streamed.get(k)} rule ${exp}`);
      }
    } catch (e: any) { bad.push(`${label} in=${srcIn.toFixed(4)}: ${e?.code ?? "threw"} ${String(e?.message).slice(0, 120)}`); }
  }
  return bad;
}
/** A row whose body may throw (a decode that fails): the failure is the row's mismatch, and the next rows still run. */
const attempt = async (body: () => Promise<string[]>) => { try { return await body(); } catch (e: any) { return [`${e?.code ?? "threw"} ${String(e?.message).slice(0, 160)}`]; } };
const SLOTS = [0, 1, 2, 5, 6, 7, 12, 13, 24, 31];
const PHASES = [0, 0.3, 0.5, 0.77];
const row = (name: string, bad: string[]) => check(name, bad.length === 0, { n: bad.length, first: bad.slice(0, 6) });

// ---- media
const v = (fps: string, secs = 6) => ({ plain: make(`v${fps.replace("/", "_")}.mp4`, fps, secs, X264, { mux: ["-g", "50"] }), aac: make(`v${fps.replace("/", "_")}a.mp4`, fps, secs, X264, { audio: true, mux: ["-g", "50"] }) });
const v25 = v("25"), v30 = v("30"), v50 = v("50"), v24 = v("24"), v2997 = v("30000/1001");
const nz25 = make("nz25.mp4", "25", 6, X264, { audio: true, mux: ["-output_ts_offset", "10"] });
const mkv24 = make("v24.mkv", "24", 8, X264, { audio: true }), mkv25 = make("v25.mkv", "25", 6, X264, { audio: true });
const loopSlack = make("loopslack.mp4", "25", 4, X264, { audio: true, sound: 4.04, mux: ["-g", "50"] }); // 4 s of picture over 4.04 s of sound: no video_duration is recorded, the length is 0.04 s past the picture
const webm24 = make("v24.webm", "24", 8, VP9);
const mkvLate = make("late.mkv", "25", 8, X264, { audio: true, late: 2 });
const ntsc30 = make("ntsc30.mp4", "30000/1001", 20, X264);
const ntsc24 = make("ntsc24.mp4", "24000/1001", 24, X264);
const op25 = make("op25.mp4", "25", 8, X264_OPEN, { audio: true });
const low10 = make("low10.mp4", "10", 6, [...X264, "-bf", "3"]);
const tsc = make("tsc.ts", "25", 8, X264_CLOSED, { audio: true, mux: ["-f", "mpegts"] });
const tso = make("tso.ts", "25", 8, X264_OPEN, { audio: true, mux: ["-f", "mpegts"] });
const tsLate = make("tslate.ts", "25", 8, X264_CLOSED, { audio: true, late: 0.54, mux: ["-f", "mpegts"] });
const tsoLate = make("tsolate.ts", "25", 8, X264_OPEN, { audio: true, late: 0.54, mux: ["-f", "mpegts"] });
const m2ts = make("o.m2ts", "25", 8, X264_OPEN, { audio: true, mux: ["-f", "mpegts", "-mpegts_m2ts_mode", "1"] });
const m2tsLate = make("olate.m2ts", "25", 8, X264_CLOSED, { audio: true, late: 0.54, mux: ["-f", "mpegts", "-mpegts_m2ts_mode", "1"] });
const mpg = make("o.mpg", "25", 8, MPEG2, { audio: true, mux: ["-f", "mpeg"] });
const mpgLate = make("olate.mpg", "25", 8, MPEG2, { audio: true, late: 0.54, mux: ["-f", "mpeg", "-fps_mode", "passthrough"] });
const tsLong = make("tslong.ts", "25", 12, [...X264, "-g", "100", "-bf", "2", "-x264-params", "open-gop=0:scenecut=0"], { audio: true, mux: ["-f", "mpegts"] });
const loop2 = make("loop2.mp4", "25", 2, X264), loop2a = make("loop2a.mp4", "25", 2, X264, { audio: true });
// loop fixtures with more than one keyframe (a seek then lands past the first one): 2 s with a keyframe every 1 s (mp4 with AAC, mov), a gap that does not divide the length, a 0.4 s loop, video that starts late
const X264_KEY = (g: number) => [...X264, "-g", String(g), "-x264-params", `keyint=${g}:min-keyint=${g}:scenecut=0`];
const loop2k = make("loop2k.mp4", "25", 2, X264_KEY(25), { audio: true }), loop2kMov = make("loop2k.mov", "25", 2, X264_KEY(25));
const loop18 = make("loop18.mp4", "25", 2, X264_KEY(18)), loop04 = make("loop04.mp4", "25", 0.4, X264_KEY(5));
const loopLate = make("looplate.mp4", "25", 2, X264_KEY(25), { audio: true, late: 0.54 }), loopShort = make("loopshort.mp4", "25", 1.7, X264);
const loopSound = make("loopsound.mp4", "25", 2, X264_KEY(25), { audio: true, sound: 3 }); // 2 s of picture over 3 s of sound: the record has video_duration
const loopSoundMkv = make("loopsound.mkv", "25", 2, X264_KEY(25), { audio: true, sound: 3 }); // matroska keeps no per-stream length: the record's video_duration comes from the stream's own tag
const gif = join(m, "loop.gif");
ff("-f", "lavfi", "-i", pic("10", 2), gif);

console.log("a slot shows the same source frame whatever the stream's start, the audio track or the rates");
for (const [name, plain, aac, src, tl] of [["25 fps", v25.plain, v25.aac, 25, 24], ["25 fps", v25.plain, v25.aac, 25, 30], ["29.97 fps", v2997.plain, v2997.aac, 30000 / 1001, 30],
  ["30 fps", v30.plain, v30.aac, 30, 24], ["50 fps", v50.plain, v50.aac, 50, 30], ["25 fps", v25.plain, v25.aac, 25, 25]] as const) {
  const bad: string[] = [];
  for (const f of [plain, aac]) bad.push(...await sweep(`${src.toFixed(2)}->${tl} ${f.endsWith("a.mp4") ? "aac" : "video"}`, f, tl, [1], PHASES, SLOTS), ...await sweep("clamped", f, tl, [0], [0, 0.5], [0, 1, 2, 7, 13]));
  row(`${name} source on a ${tl} fps timeline, in-points at phases 0, .3, .5, .77 of a slot and at the file's start, video only and with AAC: fresh reads, a stream read in order and the rule agree`, bad);
}
row("a file whose container starts at 10 s (video and AAC): fresh, streamed and the rule agree at 24 and 30", [...await sweep("nz24", nz25, 24, [1], PHASES, SLOTS), ...await sweep("nz30", nz25, 30, [1], [0, 0.5], SLOTS)]);
check("the probe records the container's start (10 s, less the AAC priming)", Math.abs((await api.probe(nz25)).container_start - 10) < 0.05 &&(await api.probe(v25.plain)).container_start === 0, [(await api.probe(nz25)).container_start, (await api.probe(v25.plain)).container_start]);

console.log("millisecond containers, NTSC rates, ties and the highest timeline rate");
for (const [label, file] of [["mkv", mkv24], ["webm", webm24]] as const) for (const tl of [30, 60, 120])
  row(`${label} 24 fps on ${tl}: fresh, streamed and the rule agree`, await sweep(`${label}${tl}`, file, tl, [1], PHASES, tl === 120 ? [0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15, 40, 41] : SLOTS));
row("29.97 fps on 30 across the frame where the drift passes half a slot (source frame 500): fresh, streamed and the rule agree", await sweep("ntsc30", ntsc30, 30, [16.3], PHASES, [...Array(16).keys()].map((i) => i * 2)));
row("23.976 fps on 24 across the frame where the drift passes half a slot (source frame 500): fresh, streamed and the rule agree", await sweep("ntsc24", ntsc24, 24, [20.7], PHASES, [...Array(16).keys()].map((i) => i * 2)));
row("30 and 25 fps sources on 120 fps: fresh, streamed and the rule agree", [...await sweep("30on120", v30.aac, 120, [1], [0, 0.5], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 40, 41]), ...await sweep("25on120", v25.plain, 120, [1], [0, 0.5], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 40, 41])]);
{ // a frame exactly halfway between two slots (24 fps source frame 2 at slot 2.5 of a 30 fps timeline) belongs to the later slot: the older frame shows through the tie
  const s = await Promise.all([2, 3].map(() => source(v24.plain, 30, 0))), got = [await read(s[0], 2, 30), await read(s[1], 3, 30)];
  s.forEach((x) => x.close());
  check("a source frame halfway between two slots shows from the later slot: slot 2 holds frame 1, slot 3 shows frame 2", got[0] === 1 && got[1] === 2, got);
}
row("split equals unsplit: 24 fps on 30 and 60 in mp4, mkv and webm, cut at slot 7 and 20", await attempt(async () => {
  const bad: string[] = [];
  for (const file of [v24.plain, v24.aac, mkv24, webm24]) for (const tl of [30, 60]) for (const cut of [7, 20]) {
    const a = 1.013, whole = (await source(file, tl, a)), tail = (await source(file, tl, a + cut / tl));
    for (let s = cut; s < cut + 12; s++) {
      const x = await read(whole, s, tl), y = await read(tail, s - cut, tl);
      if (x !== y) bad.push(`${file.split("/").pop()} ${tl} cut ${cut} slot ${s}: whole ${x} cut ${y}`);
    }
    whole.close(); tail.close();
  }
  return bad;
}));

console.log("containers that seek past their target, long keyframe gaps, open GOPs and late video");
for (const [label, file] of [["closed-GOP ts", tsc], ["open-GOP ts", tso], ["ts with video 0.54 s after the sound", tsLate], ["open-GOP ts with late video", tsoLate], ["m2ts", m2ts], ["m2ts with late video", m2tsLate],
  ["mpeg-ps", mpg], ["mpeg-ps with late video", mpgLate]] as const)
  row(`${label}: fresh, streamed and the rule agree at 24 and 30, mid-file and at the file's start`, [...await sweep(label, file, 24, [1, 0], [0, 0.5], [0, 1, 2, 7, 13, 24]), ...await sweep(label, file, 30, [1.5], [0, 0.3], [0, 1, 7, 13])]);
row("a ts with 4 s between keyframes: a slot's own stream equals the clip read in order, before, on and after each keyframe", [...await sweep("tslong24", tsLong, 24, [3.9, 4, 4.1, 7.95], [0, 0.5], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), ...await sweep("tslong30", tsLong, 30, [3.95, 8.02], [0, 0.3], [0, 1, 5, 6, 7, 8, 9, 10])]);
row("h264 with open GOPs beside keyframes (mp4): fresh, streamed and the rule agree at slots around each keyframe", await sweep("open-gop", op25, 24, [0.96, 1.96, 2.96], [0, 0.5], [0, 1, 2, 3, 4, 5, 6, 7, 8]));
row("a 10 fps source with three B-frames on 30 fps: fresh, streamed and the rule agree", await sweep("low10", low10, 30, [0.9, 1, 2.05], [0, 0.5], [0, 1, 2, 3, 4, 6, 9, 12]));
row("video that starts 2 s after the sound, with the in-point in the empty stretch (mkv): fresh, streamed and the rule agree", [...await sweep("late-mkv", mkvLate, 24, [0, 0.9, 1.9], [0, 0.5], [0, 1, 2, 12, 24, 30, 60]), ...await sweep("late-mkv", mkvLate, 30, [2.1], [0], [0, 1, 7])]);
{
  const p = async (f: string) => (await api.probe(f));
  check("the probe records what a read needs: the video's start, the reorder delay, and the keyframe gap only where a seek may land late",
    Math.abs((await p(mkvLate)).video_start - 2) < 0.05 && (await p(low10)).reorder >= 2 && (await p(v25.plain)).key_gap === undefined && Math.abs((await p(tsLong)).key_gap - 4) < 0.15 && (await p(tsLong)).format === "mpegts" && (await p(gif)).key_gap === undefined && (await p(gif)).format === "gif" && (await p(v25.plain)).color_space === "unknown" && (await p(v25.plain)).color_primaries === "unknown" && (await p(v25.plain)).color_transfer === "unknown",
    { cs: (await p(v25.plain)).color_space, prim: (await p(v25.plain)).color_primaries, trc: (await p(v25.plain)).color_transfer, late: (await p(mkvLate)).video_start, reorder: (await p(low10)).reorder, mp4: (await p(v25.plain)).key_gap, ts: (await p(tsLong)).key_gap, fmt: (await p(tsLong)).format, gif: (await p(gif)).format });
}
{
  // an avi's stream header can start a stream late (1/rate units): ffprobe still reports 0, the packets carry the shift. ffmpeg cannot write one, so the test sets the video header's start in a copy of its own avi
  const headerStart = (src: string, dst: string, stream: number, start: number) => {
    const b = readFileSync(src), end = b.indexOf("movi");
    let n = 0;
    for (let i = b.indexOf("strh"); i >= 0 && i < end; i = b.indexOf("strh", i + 4)) if (n++ === stream) b.writeUInt32LE(start, i + 36);
    writeFileSync(dst, b);
    return dst;
  };
  const MPEG4 = ["-c:v", "mpeg4", "-q:v", "2"];
  const aviPlain = make("av.avi", "25", 4, MPEG4, { audio: true }), aviLate = headerStart(aviPlain, join(m, "av-late.avi"), 0, 35); // 35 frames of 1/25 s: the picture starts at 1.4 s, the sound at 0
  const aviVideo = make("v.avi", "25", 4, MPEG4), aviVideoLate = headerStart(aviVideo, join(m, "v-late.avi"), 0, 35); // video only: the picture starts at 1.4 s
  row("an avi whose picture starts 1.4 s after its sound: fresh, streamed and the rule agree, before the picture, at its start, at its last frame and on the held frame after it",
    [...await sweep("late-avi", aviLate, 24, [0, 0.9], [0, 0.5], [0, 1, 2, 12, 24, 35, 36, 60, 90]), ...await sweep("late-avi-end", aviLate, 25, [0, 0.9], [0, 0.3], [0, 36, 100, 133, 134, 135, 136, 140])]);
  row("a video-only avi whose picture starts at 1.4 s: fresh, streamed and the rule agree, from the first slot to the held frame after the last", await sweep("late-avi-v", aviVideoLate, 25, [0, 0.9], [0, 0.5], [0, 1, 34, 35, 36, 100, 133, 134, 135, 140]));
  row("a loop over a video-only avi whose picture starts at 1.4 s: fresh, streamed and the rule agree across the wrap", await sweep("loop-avi-v", aviVideoLate, 25, [0, 0.9], [0, 0.5], [0, 1, 134, 135, 136, 137, 138, 170, 171, 172, 270, 271], { loop: true }));
  const a = (await api.probe(aviLate)), vo = (await api.probe(aviVideoLate)), pl = (await api.probe(aviPlain)), last = timingOf(aviVideoLate).pts.length - 1;
  const close = (x: number, want: number) => Math.abs(x - want) < 0.01;
  const formatLen = (f: string) => Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout);
  const pictureLen = (f: string) => Number(spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout); // the unshifted file's own picture length: the avi header's, which counts a frame more than the file holds when it has sound
  check("the probe reads an avi's picture start from its first packet: the container keeps the start ffmpeg applies, the picture starts 1.4 s in and the length counts from there; an avi with no shift is unchanged",
    a.container_start === 0 && close(a.video_start, 1.4) && close(a.duration, 1.4 + pictureLen(aviPlain)) && vo.container_start === 0 && close(vo.video_start, 1.4) && close(vo.duration, 1.4 + pictureLen(aviVideo))
    && pl.container_start === 0 && pl.video_start === 0 && Math.abs(pl.duration - formatLen(aviPlain)) < 0.001, [a, vo, pl].map((i) => [i.duration, i.container_start, i.video_start]).concat([[pictureLen(aviPlain), pictureLen(aviVideo), formatLen(aviPlain)]])); // an unshifted avi records the length ffprobe gives (the sound encoder varies it between runs)
  row("a video-only avi that starts at 1.4 s holds its first frame to the picture's start and shows its last frame at the slot after the picture's", await attempt(async () => {
    const f = (await source(aviVideoLate, 25, 0)), l = (await source(aviVideoLate, 25, 0)), h = (await source(aviVideoLate, 25, 0));
    const first = await read(f, 0, 25), end = await read(l, 35 + last, 25), held = await read(h, 35 + last + 5, 25);
    f.close(); l.close(); h.close();
    return first === 0 && end === last && held === last ? [] : [`first slot frame ${first}, slot ${35 + last} frame ${end}, slot ${35 + last + 5} frame ${held}; want 0, ${last}, ${last}`];
  }));
  // A source faster than the grid leaves a window of 1 - rate/source rate of a slot in which the last frame ends inside its own slot: an in-point that puts the frame at the middle of it
  const endBad: string[] = [];
  // the last two pairs loop a picture 0.04 s shorter than its recorded length (sound outlasts it by less than VIDEO_END_SLACK): the pass runs dry at the last frame's slot, which the pass then holds
  for (const [file, r, o] of [[v25.plain, 24], [v25.aac, 24], [mkv25, 24], [aviPlain, 24], [aviLate, 24], [aviVideo, 24], [aviVideoLate, 24], [v25.plain, 20], [mkv25, 20], [aviLate, 20], [v30.aac, 24], [v50.plain, 30], [mkv24, 20],
    [loopSlack, 24, { loop: true }], [loopSlack, 20, { loop: true }]] as [string, number, Opts?][]) {
    const { pts, S } = timingOf(file), pl = pts[pts.length - 1] - S, kl = Math.floor((pl - 0.5) * r), w = 1 - r / (await api.probe(file)).fps;
    endBad.push(...await sweep(`${file.split("/").pop()}->${r}${o ? " loop" : ""}`, file, r, [pl - (kl + w / 2 - 0.5 - TIE) / r], [0], [kl - 1, kl, kl + 1, kl + 2, kl + 8], o));
  }
  const slack = (await api.probe(loopSlack)), slackEnd = timingOf(loopSlack).pts.at(-1)! + 1 / slack.fps; // the loop pairs need a recorded length past the picture and no video_duration, which the sound encoder's length can change
  if (slack.video_duration != null || !(slack.duration > slackEnd)) endBad.push(`loopslack.mp4 no longer runs dry: duration ${slack.duration}, video_duration ${slack.video_duration}, picture ends ${slackEnd}`);
  row("a last frame that ends inside its own slot is shown there and held after it: mp4, mkv and avi, 25 to 24 and 20, 30 to 24, 50 to 30, 24 to 20, and a loop pass that runs dry there", endBad);
  row("a source read past its end and then at the slot before gives the held last frame, not nothing", await attempt(async () => {
    const s = (await source(v25.plain, 24, 0)), want = rule(v25.plain, 0, 24, 154), got = [await read(s, 154, 24), await read(s, 153, 24)];
    s.close();
    return got.every((n) => n === want) ? [] : [`slots 154, 153 read ${got}; want ${want}`];
  }));
}

console.log("loops, reverse, freeze and the held last frame");
row("a loop over mp4, video only and with AAC: fresh, streamed and the rule agree across the wrap", [...await sweep("loop", loop2, 24, [0, 1.5], [0, 0.5], [0, 20, 47, 48, 49, 50, 51, 60, 95, 96, 97], { loop: true }),
  ...await sweep("loopa", loop2a, 30, [0, 1.5], [0, 0.5], [0, 20, 59, 60, 61, 100, 119, 120, 121], { loop: true })]);
row("a looping GIF is accepted and its frames follow the rule across a wrap", await sweep("gif", gif, 24, [0, 1.5], [0, 0.5], [0, 10, 20, 47, 48, 49, 50, 51, 60, 90, 100], { loop: true }));
{ // a keyframe inside the file: a seek lands past the first one, and a loop used to restart there instead of at the file's start
  const wraps = (r: number) => { const n = Math.round(2 * r); return [0, 20, n - 1, n, n + 1, 2 * n, 2 * n + 1, 3 * n - 1, 3 * n, 3 * n + 2]; }; // three wraps
  row("a loop over a file with a keyframe at 1 s (mp4 with AAC at 24 and 30 fps, mov at 25): fresh, streamed and the rule agree across three wraps", [
    ...await sweep("loopk24", loop2k, 24, [0, 1.5], [0, 0.5], wraps(24), { loop: true }),
    ...await sweep("loopk30", loop2k, 30, [0, 1.5], [0, 0.5], wraps(30), { loop: true }),
    ...await sweep("loopkmov", loop2kMov, 25, [0, 1.5], [0], wraps(25), { loop: true })]);
  row("a loop whose in-point is just before, on and just after its keyframe, and just before the end of a pass", await sweep("loopk-in", loop2k, 25, [0.96, 1, 1.04, 1.99], [0], [0, 1, 12, 49, 50, 51, 99, 100, 101, 150], { loop: true }));
  row("a loop over keyframes 0.72 s apart (the gap does not divide the length): fresh, streamed and the rule agree across wraps", [
    ...await sweep("loop18", loop18, 25, [0, 0.7, 1.44], [0], wraps(25), { loop: true }), ...await sweep("loop18-30", loop18, 30, [0.75, 1.9], [0], wraps(30), { loop: true })]);
  row("a 0.4 s loop (a keyframe every 0.2 s) over thirteen wraps: a stream and fresh reads in late passes agree with the rule", await sweep("loop04", loop04, 25, [0, 0.2], [0, 0.5], [0, 1, 9, 10, 11, 60, 97, 111, 129], { loop: true }));
  row("a loop whose video starts 0.54 s after the sound (the pass is the container's length, the gap holds the last frame): fresh, streamed and the rule agree across wraps at 25 and 30 fps", [
    ...await sweep("looplate25", loopLate, 25, [0, 1.5], [0, 0.5], [0, 12, 13, 14, 25, 49, 63, 64, 65, 100, 126, 127, 128, 150], { loop: true }),
    ...await sweep("looplate30", loopLate, 30, [0, 1.99], [0], [0, 16, 17, 18, 40, 76, 77, 78, 120, 152, 153, 154, 180], { loop: true })]);
  row("a loop over a picture shorter than its sound (the record has video_duration, the pass is the picture; mp4 at 25 and 30 fps, mkv at 25): fresh, streamed and the rule agree across three wraps", [
    ...await sweep("loopsoundmkv", loopSoundMkv, 25, [0, 1.5], [0, 0.5], [0, 20, 49, 50, 51, 99, 100, 101, 149, 150, 151], { loop: true }),
    ...await sweep("loopsound25", loopSound, 25, [0, 1.5], [0, 0.5], [0, 20, 49, 50, 51, 99, 100, 101, 149, 150, 151], { loop: true }),
    ...await sweep("loopsound30", loopSound, 30, [0, 1.99], [0], [0, 20, 59, 60, 61, 119, 120, 121, 179, 180], { loop: true })]);
  const fills = async (f: string, o: Opts = {}) => ((await source(f, 25, 0, { loop: true, ...o })) as any).fillsPass();
  check("the probe record of a file whose picture fills its pass lets later passes come from one looping stream, a picture shorter than the sound included; a late video (0.54 s, or 0.02 s), a longer recorded pass or a shorter picture does not",
    (await api.probe(loopSound)).video_duration > 1.9 && (await fills(loop2k)) && (await fills(loop2kMov)) && (await fills(loop18)) && (await fills(loop04)) && (await fills(loopSound)) && !(await fills(loopLate)) && !(await fills(nz25)) && !(await fills(loop2k, { srcDuration: 2.2 })) && !(await fills(loop2k, { facts: { ...(await api.probe(loop2k)), video_duration: 1.9 } })),
    [(await api.probe(loopSound)).video_duration, (await fills(loop2k)), (await fills(loop2kMov)), (await fills(loop18)), (await fills(loop04)), (await fills(loopSound)), (await fills(loopLate)), (await fills(nz25)), (await fills(loop2k, { srcDuration: 2.2 })), (await fills(loop2k, { facts: { ...(await api.probe(loop2k)), video_duration: 1.9 } }))]);
  { // a named limit (not a defect): a record whose picture is shorter than its length (the picture is 1.7 s, the record says 2 s) passes the check above, so the first wrap is at the record's length and later wraps at the file's own period
    const bad = await attempt(async () => {
      const s = (await source(loopShort, 25, 0.5, { loop: true, srcDuration: 2, facts: { ...(await api.probe(loopShort)), duration: 2 } })), got: number[] = [];
      for (let k = 0; k < 124; k++) got.push(await read(s, k, 25));
      s.close();
      const want = [...Array.from({ length: 31 }, (_, i) => 12 + i), ...Array(7).fill(42), ...Array.from({ length: 43 }, (_, i) => i), ...Array.from({ length: 43 }, (_, i) => i)];
      return got.flatMap((n, k) => n === want[k] ? [] : [`slot ${k}: ${n} want ${want[k]}`]);
    });
    row("NAMED LIMIT, pinned as it is: a clip whose record says 2 s over a 1.7 s picture holds the last frame to the first wrap at the record's length, and wraps at the file's own length after", bad);
  }
  { // a webm written to a pipe has no length in the file: the probe measures it from the packets, and the clip loops; a record without a length (written by hand) is still refused
    const live = join(m, "live.webm");
    writeFileSync(live, spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", pic("25", 1), ...VP9, "-f", "webm", "-"], { maxBuffer: 1 << 26 }).stdout);
    const err = async (f: () => unknown) => { try { await f(); return null; } catch (e: any) { return e; } };
    const refused: any = await err(() => source(live, 25, 0, { loop: true, srcDuration: 0 })), freezeBare = await err(() => source(live, 25, 0, { loop: true, freeze: true, srcDuration: 0 }));
    row("a loop over a webm written to a pipe: fresh, streamed and the rule agree across three wraps", await sweep("live", live, 25, [0, 0.5], [0, 0.5], [0, 12, 24, 25, 26, 49, 50, 51, 74, 75, 76], { loop: true }));
    check("a looping video whose record has no length is refused with bad_media and a hint that names the cure; a freeze reads no pass and is built",
      refused?.code === "bad_media" && /cannot loop/.test(refused.message) && /relink_asset the file to probe it again/.test(refused.hint) && /export it again from its source/.test(refused.hint) && freezeBare === null,
      { code: refused?.code, hint: refused?.hint, freeze: freezeBare?.message });
    // the one file that gives a record with no length: a stream with no frames (a remux of it to mkv cannot be read, so the old hint's cure fails)
    const empty = join(m, "empty.avi");
    ff("-f", "lavfi", "-i", pic("25", 1), "-frames:v", "0", "-an", "-c:v", "mpeg4", "-pix_fmt", "yuv420p", empty);
    const emptyInfo = (await api.probe(empty)), emptyRefused: any = await err(() => source(empty, 25, 0, { loop: true }));
    check("a video file with no frames records no length, and a loop over it is refused with the hint that names the cure",
      emptyInfo.kind === "video" && emptyInfo.duration === 0 && emptyRefused?.code === "bad_media" && /export it again from its source/.test(emptyRefused.hint), { duration: emptyInfo.duration, code: emptyRefused?.code, hint: emptyRefused?.hint });
  }
  { // a picture whose length is not a whole millisecond (7 frames at 29.97 fps: 7 x 1001/30000 = 0.2335667 s): the record keeps it to the microsecond, and a read that starts in a late pass shows the frame the exact period gives
    const f7 = make("ntsc7.mp4", "30000/1001", 1, [...X264, "-frames:v", "7"]);
    const exact = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f7], { encoding: "utf8" }).stdout);
    const tick = 1001 / 30000, D7 = 7 * tick;
    /** The frame slot k shows by the exact period and frame times (this fixture's frames are i ticks apart); the file's own timestamps are printed to 6 digits, which drifts past a near-tie after tens of passes. */
    const exactFrame = (k: number) => {
      let best = 0, bestSlot = -Infinity;
      for (let n = 0; n <= Math.ceil((k + 2) / 30 / D7) + 1; n++) for (let i = 0; i < 7; i++) { const slot = Math.floor((n * 7 + i) * tick * 30 + 0.5 + TIE); if (slot <= k && slot >= bestSlot) { bestSlot = slot; best = i; } }
      return best;
    };
    const fresh = async (k: number) => { const s = (await source(f7, 30, 0, { loop: true })), got = await read(s, k, 30); s.close(); return got; };
    const bad = await attempt(async () => {
      const out: string[] = [];
      for (let n = 60; n < 64; n++) for (const k of [-1, 0, 1].map((d) => Math.round(n * D7 * 30) + d)) { const got = await fresh(k), want = exactFrame(k); if (got !== want) out.push(`pass ${n} slot ${k}: ${got} want ${want}`); }
      return out;
    });
    check("the record of a picture that is not a whole millisecond long holds ffprobe's length to the microsecond", Math.abs((await api.probe(f7)).duration - exact) <= 1e-6, { record: (await api.probe(f7)).duration, exact });
    row("a fresh read in the 60th to 63rd pass of that loop (the pass starts and a slot either side) shows the frame the exact period gives", bad);
    // the limit (see `sec` in media.ts): a pass starts at n times a decimal length, up to 5e-7 s off per wrap (1.5e-5 slot at 30 fps; 1e-5 slot here), so a slot whose margin to a frame boundary is below n x 1e-5 slot (3e-4 at slot 467) can differ between a fresh and a streamed read after n wraps
    const bad467 = await attempt(async () => {
      const s = (await source(f7, 30, 0, { loop: true })), streamed: number[] = [];
      for (let k = 0; k <= 467; k++) streamed.push(await read(s, k, 30));
      s.close();
      const got = { exact: exactFrame(467), streamed: streamed[467], fresh: await fresh(467) };
      return got.exact === 5 && got.streamed === 5 && got.fresh === 4 ? [] : [JSON.stringify(got)];
    });
    row("NAMED LIMIT, pinned as it is: slot 467 (pass 66) of that loop shows frame 5 in a read that streams from the start and frame 4 in a fresh read, the exact period gives frame 5", bad467);
  }
}
{
  const bad = await attempt(async () => {
  const bad: string[] = [];
  for (const f of [v25.plain, v25.aac]) for (const tl of [24, 30]) for (const srcIn of [1, 1.013, 0.05]) {
    const len = 2, n = Math.round(len * tl), s = (await source(f, tl, srcIn, { reverse: true, segLen: len })), got: number[] = [];
    for (let j = 0; j < n; j++) got.push(await read(s, j, tl));
    s.close();
    for (let j = 0; j < n; j++) { const exp = rule(f, srcIn, tl, n - 1 - j); if (got[j] !== exp) bad.push(`${f.split("/").pop()} ${tl} in=${srcIn} j=${j}: ${got[j]} rule ${exp}`); }
  }
  return bad; });
  row("a reverse clip shows the frames of the forward rule, last slot first (video only and with AAC)", bad);
}
{
  const bad = await attempt(async () => {
  const bad: string[] = [];
  for (const [f, tl] of [[v25.plain, 24], [v25.aac, 30], [v50.aac, 30], [v2997.plain, 30], [tsc, 24], [mkv24, 30]] as const) for (const srcIn of [1, 1.013, 2.37]) {
    const stream = (await source(f, tl, srcIn)), still = (await source(f, tl, srcIn, { freeze: true })), first = await read(stream, 0, tl), held = await read(still, 3, tl);
    stream.close(); still.close();
    if (first !== held || first !== rule(f, srcIn, tl, 0)) bad.push(`${f.split("/").pop()} ${tl} in=${srcIn}: slot 0 ${first} still ${held} rule ${rule(f, srcIn, tl, 0)}`);
  }
  return bad; });
  row("a freeze holds the frame slot 0 of the same clip shows", bad);
}
{ // a frozen loop clip: in-points just after a pass start (inside the pre-roll), in a later pass, and just before a pass end (the next pass's first frame is the nearest)
  const bad = await attempt(async () => {
  const bad: string[] = [];
  for (const [f, tl] of [[loop2, 24], [loop2a, 30], [loop2k, 24], [loop2kMov, 30], [loopLate, 25], [loopLate, 30]] as const) {
    const info = (await api.probe(f)), D = info.video_duration ?? info.duration;
    for (const srcIn of [0, 0.1, 0.2, D + 0.1, D - 0.01, D + 1.04]) { // the late file's first 0.54 s are before its picture: in 0, 0.1 and 0.2 lie there
      const stream = (await source(f, tl, srcIn, { loop: true })), still = (await source(f, tl, srcIn, { loop: true, freeze: true }));
      const first = await read(stream, 0, tl), held = await still.readAt(0).then((b) => num(b, W, H), (e) => e?.code ?? "threw");
      stream.close(); still.close();
      if (first !== held || first !== rule(f, srcIn, tl, 0, D)) bad.push(`${f.split("/").pop()} ${tl} in=${srcIn.toFixed(3)}: slot 0 ${first} still ${held} rule ${rule(f, srcIn, tl, 0, D)}`);
    }
  }
  return bad; });
  row("a frozen loop clip holds the frame slot 0 of the same clip shows, at in 0, in the second pass, past the second keyframe of a later pass and just before a pass end", bad);
}
{
  const bad = await attempt(async () => {
  const bad: string[] = [];
  // the ts and m2ts files start these streams by a seek that lands mid-GOP: their decoder text about frames never shown is not a failure of the clip
  for (const f of [v25.plain, v25.aac, v50.aac, mkv24, webm24, tsc, tso, tsLate, m2ts]) for (const tl of [24, 30]) for (const srcIn of [4, 4.013]) {
    const { pts, S } = timingOf(f), D = pts[pts.length - 1] - S + (pts[1] - pts[0]), s = (await source(f, tl, srcIn, { srcDuration: D }));
    let streamed = -1;
    for (let k = 0; k < Math.ceil((D - srcIn) * tl) + 40; k++) { const n = await read(s, k, tl); if ((s as any).eof) { streamed = n; break; } }
    s.close();
    const fr = (await source(f, tl, srcIn, { srcDuration: D })), fresh = num(await fr.readAt(((D - srcIn) * tl + 70) / tl), W, H); fr.close();
    if (streamed !== fresh) bad.push(`${f.split("/").pop()} ${tl} in=${srcIn}: streamed end ${streamed} fresh past the end ${fresh}`);
  }
  return bad; });
  row("the held last frame: a clip read to its end and a fresh read past it show the same frame", bad);
}
if (process.platform === "darwin" && process.env.AGENTCUT_HWACCEL !== "0") {
  const big = join(m, "big.mp4");
  ff("-f", "lavfi", "-i", pic("25", 2, 2560, 1440, 160), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20", "-pix_fmt", "yuv420p", big);
  const bad: string[] = [];
  const mk = async (hw: boolean) => { const info = (await api.probe(big)), s = new FrameSource({ path: big, kind: "video", srcW: 2560, srcH: 1440, srcFps: 25, srcIn: 0.31, rate: 30, fit: "fill", box: [2560, 1440], srcDuration: info.duration, facts: info }); (s as any).hw = hw; return s; };
  const sw = (await mk(false)), hw = (await mk(true)), usesHw = (hw as any).hw;
  for (let k = 0; k < 20; k++) { const a = num(await sw.readAt(k / 30), 2560, 1440, 160), b = num(await hw.readAt(k / 30), 2560, 1440, 160); if (a !== b) bad.push(`k=${k} software ${a} hwaccel ${b}`); }
  sw.close(); hw.close();
  row("a 2560x1440 source decoded with hwaccel shows the frames software decoding shows", bad);
  check("hwaccel was in use for that row", usesHw === true);
} else console.log("  - hwaccel row skipped: this platform or AGENTCUT_HWACCEL=0 has no hwaccel decode");

console.log("exports, validation and relinking");
{
  const P = join(tmp, "proj");
  const made = api.create(P, { width: W, height: H, fps: 30 });
  const built = await api.apply(P, [
    { op: "add_clip", track: "main", src: v25.aac, in: 1.013, duration: 2 }, { op: "add_clip", track: "main", src: v50.plain, in: 0.5, duration: 2 },
    { op: "add_clip", track: "main", src: v2997.aac, in: 2.2, duration: 2 }, { op: "add_clip", track: "main", src: mkv24, in: 1.1, duration: 1.5 }], { revision: made.revision });
  const frames = (file: string) => {
    const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 28 });
    const out: number[] = [];
    for (let o = 0; o + W * H <= r.stdout.length; o += W * H) out.push(num(r.stdout.subarray(o, o + W * H), W, H, 10, 1));
    return out;
  };
  const one: any = await api.render(P, { out: join(tmp, "w1.mp4"), workers: 1, sheet: false }), three: any = await api.render(P, { out: join(tmp, "w3.mp4"), workers: 3, sheet: false });
  const a = frames(join(tmp, "w1.mp4")), b = frames(join(tmp, "w3.mp4"));
  check("an export with 1 worker shows the same source frame in every slot as one with 3 workers", one.workers === 1 && three.workers === 3 && a.length > 200 && JSON.stringify(a) === JSON.stringify(b),
    { frames: [a.length, b.length], firstDiff: a.findIndex((x, i) => x !== b[i]) });

  const fixed = JSON.parse(readFileSync(join(P, "project.json"), "utf8"));
  const ids = Object.keys(fixed.assets), first = ids[0];
  for (const k of ["container_start", "video_start", "format", "reorder", "color_space", "color_primaries", "color_transfer"]) delete fixed.assets[first][k];
  writeFileSync(join(P, "project.json"), JSON.stringify(fixed, null, 2));
  const bare: any = await api.validate(P);
  check("a video asset without the probe fields is a validation error that names them and points at relink_asset", !bare.valid && /container_start, video_start, format, reorder, color_space, color_primaries, color_transfer/.test(JSON.stringify(bare)) && /relink_asset id=\S+ path=/.test(JSON.stringify(bare)), bare);
  const rendered = await api.render(P, { out: join(tmp, "bare.mp4"), sheet: false }).then(() => "rendered", (e: any) => e?.code ?? String(e));
  check("and it does not render", rendered !== "rendered", rendered);
  const again: any = JSON.parse(readFileSync(join(P, "project.json"), "utf8")).assets[first];
  await api.apply(P, [{ op: "relink_asset", id: first, path: again.path }], { revision: built.revision }); // project.json was edited in place: no save since the build
  const healed: any = await api.validate(P);
  check("relink_asset with the same path records them and the project validates", healed.valid === true, healed);
  // the matrix recorded for an asset can be named by hand: only a name from the fixed list (or unknown / reserved) validates, and the error names the field and the list
  const named = JSON.parse(readFileSync(join(P, "project.json"), "utf8"));
  const was = named.assets[first].color_space;
  const withName = async (v: unknown) => {
    named.assets[first].color_space = v;
    writeFileSync(join(P, "project.json"), JSON.stringify(named, null, 2));
    return (await api.validate(P)) as any;
  };
  const accepted: (readonly [string, boolean])[] = [], warned: (readonly [string, string[]])[] = [];
  for (const v of ["bt709", "bt470bg", "smpte170m", "bt2020nc", "gbr", "reserved", "unknown"]) {
    const r = await withName(v);
    accepted.push([v, r.valid] as const);
    warned.push([v, (r.issues ?? []).filter((i: any) => i.level === "warning" && /\.color_(space|primaries|transfer)$/.test(i.path) && i.message.includes(`'${first}'`)).map((i: any) => i.path)] as const);
  }
  const refusedNames: (readonly [unknown, any])[] = [];
  for (const v of ["bt.709", "709", "BT709", "", "bt709,format=gray", "bt2020c", 709, null]) refusedNames.push([v, await withName(v)] as const);
  check("a matrix named by hand on a video asset validates when it is in the list (or unknown, reserved)", accepted.every(([, ok]) => ok), accepted);
  check("a BT.2020 matrix on a video asset with no primaries or transfer tag gives one warning on its color_primaries, naming the asset; the other names give none",
    warned.every(([v, paths]) => (v === "bt2020nc" ? paths.join() === `$.assets.${first}.color_primaries` : paths.length === 0)), warned);
  check("any other name or an empty one is a validation error naming color_space and the list; another type is an error naming color_space",
    refusedNames.every(([v, r]) => !r.valid && /color_space/.test(JSON.stringify(r)) && (typeof v !== "string" || (r.issues ?? []).some((i: any) => i.path?.endsWith("color_space") && /bt709/.test(i.message)))), refusedNames.map(([v, r]) => [v, r.valid, JSON.stringify(r).slice(0, 160)]));
  await withName(was);
  // the colour tags a warning goes by: [matrix, primaries, transfer, the field the warning is on, or null for none]. Converted: PQ, HLG, BT.2020 primaries with an SDR curve.
  const tagged: [string, string, string, string | null][] = [["bt709", "bt709", "smpte428", "color_transfer"], ["bt709", "smpte432", "bt709", "color_primaries"], ["bt2020nc", "unknown", "bt709", "color_primaries"], ["bt2020nc", "bt2020", "bt470bg", "color_transfer"],
    ["unknown", "bt709", "smpte2084", "color_space"], ["unknown", "bt2020", "smpte2084", null], ["bt2020nc", "bt2020", "smpte2084", null], ["bt2020nc", "unknown", "arib-std-b67", null], ["bt2020nc", "bt2020", "bt709", null], ["bt709", "bt709", "bt709", null]];
  const seen: unknown[] = [], wasTags = [named.assets[first].color_primaries, named.assets[first].color_transfer];
  for (const [cs, prim, trc, field] of tagged) {
    named.assets[first].color_space = cs; named.assets[first].color_primaries = prim; named.assets[first].color_transfer = trc;
    writeFileSync(join(P, "project.json"), JSON.stringify(named, null, 2));
    const r: any = await api.validate(P), paths = (r.issues ?? []).filter((i: any) => i.level === "warning" && i.message.includes(`'${first}' `) && /colo|BT\.2020/.test(i.message)).map((i: any) => i.path);
    seen.push([cs, prim, trc, r.valid, paths.join()]);
    if (!r.valid || paths.join() !== (field ? `$.assets.${first}.${field}` : "")) seen.push("WRONG");
  }
  check("a colour the conversion does not cover warns once on the field to fix: an unconverted transfer, unconverted primaries, BT.2020 signalled (by the primaries, or by the matrix with no primaries tag) with a curve that has no conversion, and PQ read through another matrix; PQ, HLG (with or without a primaries tag) and BT.2020 primaries with an SDR curve do not",
    !seen.includes("WRONG"), seen);
  [named.assets[first].color_space, named.assets[first].color_primaries, named.assets[first].color_transfer] = [was, ...wasTags];
  writeFileSync(join(P, "project.json"), JSON.stringify(named, null, 2));
  const dciFile = join(m, "dci.mp4");
  ff("-f", "lavfi", "-i", "color=c=0x30a060:s=160x120:r=24:d=1,format=rgba", "-vf", "scale=out_color_matrix=bt709:out_range=tv,setparams=colorspace=bt709:color_primaries=bt709:color_trc=smpte428:range=tv,format=yuv420p", "-c:v", "libx264", dciFile);
  const WP = join(tmp, "dci-import"), wq = api.create(WP, { width: W, height: H, fps: 24 });
  const imported: any = await api.apply(WP, [{ op: "import_media", path: dciFile, id: "dci" }], { revision: wq.revision });
  check("import_media records the file's primaries and transfer, and lists the warning for an unconverted one in its issues", imported.results[0].color_primaries === "bt709" && imported.results[0].color_transfer === "smpte428"
    && imported.issues.filter((i: any) => i.level === "warning" && i.path === "$.assets.dci.color_transfer" && i.message.includes("'dci'")).length === 1, imported.issues);
  // the colour warning is listed after the clip warnings, so a cut list (apply shows 15) drops its repeats first: here a clip longer than the 1 s file warns
  await api.apply(WP, [{ op: "add_clip", track: "main", asset: "dci", duration: 2 }], { revision: imported.revision });
  const ordered: any = (await api.validate(WP)).issues, colourAt = ordered.findIndex((i: any) => i.path === "$.assets.dci.color_transfer"), clipAt = ordered.findIndex((i: any) => i.level === "warning" && /^\$\.tracks.*\.duration$/.test(i.path));
  check("a clip's warning comes before the colour warning in validate's issues", clipAt >= 0 && colourAt > clipAt, ordered.map((i: any) => `${i.level} ${i.path}`));

  const ops = (src: string, extra: object = {}) => [{ op: "add_clip", track: "main", src, duration: 1, ...extra }];
  const refused = async (name: string, src: string, loop: boolean) => {
    const Q = join(tmp, `loop-${name}`);
    const q = api.create(Q, { width: W, height: H, fps: 24 });
    const added = await api.apply(Q, ops(src), { allowInvalid: true, revision: q.revision });
    const clip = Object.values<any>(JSON.parse(readFileSync(join(Q, "project.json"), "utf8")).tracks).flatMap((t: any) => t.clips)[0];
    const set: any = await api.apply(Q, [{ op: "update_clip", id: clip.id, set: { loop } }], { allowInvalid: true, revision: added.revision }).catch((e: any) => ({ error: e }));
    return JSON.stringify(await api.validate(Q)) + JSON.stringify(set.error?.message ?? "");
  };
  const tsLoop = await refused("ts", tsLong, true), mp4Loop = await refused("mp4", loop2, true), gifLoop = await refused("gif", gif, true), mkvLoop = await refused("mkv", mkv24, true);
  check("loop is refused on a ts with a hint to remux, and accepted on mp4, mkv and gif", /loop is not available/.test(tsLoop) && /remux/.test(tsLoop) && ![mp4Loop, mkvLoop, gifLoop].some((x) => /loop is not available/.test(x)), { tsLoop, mp4Loop, gifLoop, mkvLoop });
  const unlisted = JSON.parse(readFileSync(join(P, "project.json"), "utf8"));
  const ua = ids.find((id) => unlisted.assets[id].path.endsWith("v24.mkv"))!;
  unlisted.assets[ua].format = "mpegts";
  writeFileSync(join(P, "project.json"), JSON.stringify(unlisted, null, 2));
  const noGap: any = await api.validate(P);
  check("a video asset in a format outside the measured list needs the keyframe gap too", !noGap.valid && /key_gap/.test(JSON.stringify(noGap)), noGap);
}

console.log(`\n${failures() ? `✗ ${failures()} check(s) failed` : "OK - all checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s  (${tmp})`);
if (!process.argv.includes("--keep") && !failures()) rmSync(tmp, { recursive: true, force: true });
process.exit(failures() ? 1 : 0);
