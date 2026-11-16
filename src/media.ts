// Media probing and decoding through FFmpeg pipes (async, back-pressured, exact-size frame reads).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { gradeChain, type Grade } from "./color.ts";
import { inp } from "./ffinput.ts";
import { COLOR_SPACES, EditError, FILTER_SPECS, filterParam, matrixFor, missingFacts, NO_MATRIX, seeksBefore, type VideoFacts } from "./model.ts";

export const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".avif"]);
export const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif"]);

let ffChecked = false;
export function needFfmpeg() {
  if (ffChecked) return;
  for (const b of ["ffmpeg", "ffprobe"]) {
    const r = spawnSync(b, ["-version"], { stdio: "ignore" });
    if (r.error) throw new EditError(`'${b}' not found on PATH`, "missing_dependency",
      "install FFmpeg: macOS `brew install ffmpeg` · Windows `winget install Gyan.FFmpeg` · Linux `apt install ffmpeg`");
  }
  ffChecked = true;
}

let ffVersion: string | undefined;
/** The first line of `ffmpeg -version` (version and build), read once per process: a different FFmpeg may decode other pixels. */
export function ffmpegVersion(): string {
  if (ffVersion === undefined) {
    needFfmpeg();
    ffVersion = (spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout ?? "").split("\n")[0].trim();
  }
  return ffVersion;
}

/** FFmpeg's native vp8/vp9 decoders drop the alpha plane of a webm; the libvpx decoders keep it. */
const VPX_DECODER = new Map([["vp8", "libvpx"], ["vp9", "libvpx-vp9"]]);

const codecLists: Partial<Record<"encoders" | "decoders", string>> = {};
/** Whether this FFmpeg build lists `name` among its encoders or decoders. The list is read once per process, and only a successful read is kept. */
export function hasCodec(kind: "encoders" | "decoders", name: string): boolean {
  if (codecLists[kind] === undefined) {
    needFfmpeg();
    const r = spawnSync("ffmpeg", ["-hide_banner", `-${kind}`], { encoding: "utf8" });
    if (r.status !== 0) return false;
    codecLists[kind] = r.stdout;
  }
  return new RegExp(`^\\s*\\S+\\s+${name.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}\\s`, "m").test(codecLists[kind]!);
}

/** The decoder to force (before -i) for a source whose alpha the default decoder would lose, else null. Fails closed when this FFmpeg lacks it. */
export function alphaDecoder(codec: string | undefined, alpha: boolean | undefined, path: string): string | null {
  const name = alpha && codec ? VPX_DECODER.get(codec) : undefined;
  if (!name) return null;
  if (!hasCodec("decoders", name)) throw new EditError(`this FFmpeg build has no ${name} decoder (needed for the alpha channel of ${path})`,
    "missing_dependency", `install an FFmpeg build with the ${name} decoder (e.g. a full static build)`);
  return name;
}

/** A video stream shorter than the container by less than this (s) is the container's own rounding, not a longer sound. Same slack as the 'clip needs more source' warning. */
const VIDEO_END_SLACK = 0.05;
/** How far (s) the period of an un-sought loop may differ from the pass length (FrameSource.fillsPass). In a render both come from the same recorded length, so they cancel and what this bounds is `video_start`:
 *  a video that starts up to this late after the container makes the one-stream loop drift that much per wrap. It is one tick of a matroska clock (1 ms), so a start offset above it is read pass by pass. */
const PERIOD_TOLERANCE = 1e-3;
const probeCache = new Map<string, { mtime: number; size: number; info: any }>();
/** vp8/vp9 in webm carry alpha as a side plane that pix_fmt does not show; the muxer flags it with an alpha_mode tag (key case varies). */
const hasAlphaTag = (tags: Record<string, unknown> | undefined) => Object.entries(tags ?? {}).some(([k, x]) => k.toLowerCase() === "alpha_mode" && String(x) === "1");
/** The longest stretch between two keyframes of the first video stream, counting the one after the last keyframe (packets only, nothing is decoded). `whole` stands for a stream with no stretch to measure. */
function keyGap(path: string, whole: number): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,dts_time,flags", "-of", "csv=p=0", ...inp(path)], { encoding: "utf8", maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new EditError(`ffprobe cannot read the packets of ${path}: ${(r.stderr || "").trim().slice(0, 300)}`, "bad_media");
  const keys: number[] = []; let end = -Infinity;
  for (const line of r.stdout.split("\n")) {
    const [pts, dts, flags = ""] = line.split(","), t = Number.isFinite(Number(pts)) && pts !== "" ? Number(pts) : Number(dts); // a stream without pts (mpeg-ps) is timed by its dts
    if (!Number.isFinite(t) || dts === undefined) continue;
    end = Math.max(end, t);
    if (flags.includes("K")) keys.push(t);
  }
  keys.sort((x, y) => x - y);
  const gap = Math.max(0, ...keys.map((t, i) => (i + 1 < keys.length ? keys[i + 1] : end) - t));
  return gap > 0 ? Math.ceil(gap * 1000) / 1000 : whole;
}
/** Seconds kept to the microsecond, the resolution ffprobe prints: a loop's passes are n times this length, so a millisecond of rounding shows as a wrong frame in a late pass. */
const sec = (x: number) => +x.toFixed(6);
/** The length a stream's own `DURATION` tag gives (matroska writers), or 0 when it has none. */
function tagLength(tags: Record<string, unknown> | undefined): number {
  const t = Object.entries(tags ?? {}).find(([k]) => /^duration(-.*)?$/i.test(k))?.[1];
  const m = /^(\d+):(\d\d):(\d\d(?:\.\d+)?)$/.exec(String(t ?? ""));
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}
/** Where the packets of one stream end (largest pts + duration, s, on the container's clock), 0 when it has none. The whole file is read, no packet decoded. */
function packetEnd(path: string, stream: "v:0" | "a:0"): number {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", "packet=pts_time,dts_time,duration_time", "-of", "csv=p=0", ...inp(path)], { encoding: "utf8", maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new EditError(`ffprobe cannot read the packets of ${path}: ${(r.stderr || "").trim().slice(0, 300)}`, "bad_media");
  let end = 0;
  for (const line of r.stdout.split("\n")) {
    const [pts, dts, d] = line.split(","), t = Number.isFinite(Number(pts)) && pts !== "" ? Number(pts) : Number(dts); // a stream without pts is timed by its dts
    if (Number.isFinite(t) && dts !== undefined) end = Math.max(end, t + (Number(d) || 0));
  }
  return end;
}
export function probe(path: string): any {
  if (!existsSync(path)) throw new EditError(`file not found: ${path}`, "not_found");
  const st = statSync(path), mtime = st.mtimeMs, size = st.size;
  const hit = probeCache.get(path);
  if (hit && hit.mtime === mtime && hit.size === size) return { ...hit.info };
  const ext = extname(path).toLowerCase();
  let info: any;
  if (ext === ".json" || ext === ".lottie") {
    let j: any;
    try { j = JSON.parse(readFileSync(path, "utf8")); } catch { throw new EditError(`${path} is not valid JSON`, "bad_media"); }
    if (!j || !Array.isArray(j.layers) || !(j.fr > 0) || !(j.w > 0) || !(j.h > 0) || !Number.isFinite(j.op - j.ip)) throw new EditError(`${path} is not a Lottie animation`, "bad_media");
    info = { path, kind: "lottie", width: Math.round(j.w), height: Math.round(j.h), fps: +j.fr, duration: Math.max(0, +((j.op - j.ip) / j.fr).toFixed(3)), has_audio: false, alpha: true };
  } else {
    needFfmpeg();
    const r = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", ...inp(path)], { encoding: "utf8", maxBuffer: 32 << 20 });
    if (r.status !== 0) throw new EditError(`ffprobe cannot read ${path}: ${(r.stderr || "").trim().slice(0, 300)}`, "bad_media");
    const j = JSON.parse(r.stdout);
    const streams: any[] = j.streams || [];
    const v = streams.find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic));
    const a = streams.find((s) => s.codec_type === "audio");
    let dur = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0;
    const cStart = Number(j.format?.start_time) || 0, ends: Record<string, number> = {};
    const end = (s: "v:0" | "a:0") => (ends[s] ??= packetEnd(path, s) - cStart); // read once per stream, on the container's clock
    // a file with no length in it (a webm written to a pipe): the packets give it
    const measured = () => Math.max(v ? end("v:0") : 0, a ? end("a:0") : 0);
    info = { path, has_audio: !!a };
    if (v) {
      let w = +v.width, h = +v.height, rot = 0;
      for (const sd of v.side_data_list || []) if (sd.rotation !== undefined) rot = Math.round(+sd.rotation);
      if (v.tags?.rotate) rot = +v.tags.rotate;
      if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
      const [num, den] = String(v.avg_frame_rate || v.r_frame_rate || "0/1").split("/").map(Number);
      const fps = den ? num / den : 0;
      const nb = +(v.nb_frames || 0);
      const still = IMAGE_EXT.has(ext) || (["png", "mjpeg", "webp", "bmp", "tiff"].includes(v.codec_name) && nb <= 1 && dur < 0.1) || (ext === ".gif" && nb <= 1);
      Object.assign(info, {
        kind: still ? "image" : "video", width: w, height: h, codec: v.codec_name,
        fps: still || !(fps > 0) ? null : +fps.toFixed(3), alpha: /^(rgba|yuva|argb|bgra|ya|pal8|gbrap)/.test(v.pix_fmt || "") || ext === ".gif" || (VPX_DECODER.has(v.codec_name) && hasAlphaTag(v.tags)),
      });
      if (!still && !(dur > 0)) dur = measured();
      if (!still) info.duration = sec(dur);
      // The picture ends before the container when the sound is longer: compared as end times (stream start + length against container start + length, a missing start is 0),
      // since a stream that starts late is not short. Recorded as seconds from the container start, the clock `in` is on. Matroska gives no per-stream duration: then, for a file with sound,
      // the stream's own DURATION tag counts when the picture starts with the container (a writer may put a length or an end time there, which differ only for a late start), else the packets' end.
      // A file with no sound ends with its picture, so no field is recorded.
      const vd = Number(v.duration), vStart = (Number(v.start_time) || 0) - cStart;
      let vEnd = vd > 0 ? vStart + vd : 0;
      if (!(vd > 0) && a) { const tag = tagLength(v.tags); vEnd = tag > 0 && vStart <= VIDEO_END_SLACK ? vStart + tag : end("v:0"); }
      if (!still && vEnd > 0 && vEnd < dur - VIDEO_END_SLACK) info.video_duration = sec(vEnd);
      // What FrameSource needs to give a slot the same source frame wherever its stream starts (see seeksBefore in model.ts).
      if (!still) {
        // a matrix name ffprobe prints that the decode filter has no word for is refused here, so the record only ever holds a name matrixFor accepts
        const cs = String(v.color_space ?? "unknown");
        if (!COLOR_SPACES.includes(cs) && !NO_MATRIX.includes(cs)) throw new EditError(`${path} names the colour matrix '${cs}', which AgentCut cannot read with`, "bad_media", `supported: ${[...NO_MATRIX, ...COLOR_SPACES].join(", ")}; re-encode the file with a tag from that list`);
        Object.assign(info, { container_start: cStart, video_start: Math.max(0, vStart), format: String(j.format?.format_name), reorder: Number(v.has_b_frames) || 0, color_space: cs });
        if (!seeksBefore(info.format)) info.key_gap = keyGap(path, dur);
      }
    } else if (a || AUDIO_EXT.has(ext)) {
      if (!(dur > 0) && a) dur = measured();
      Object.assign(info, { kind: "audio", duration: sec(dur), sample_rate: a ? +a.sample_rate : null, channels: a?.channels ?? null });
    } else throw new EditError(`no audio or video stream in ${path}`, "bad_media");
  }
  probeCache.set(path, { mtime, size, info });
  return { ...info };
}

/** A file path as a filter option value: escaped for the option level (\ ' : whitespace), then for the graph level (\ ' [ ] , ; whitespace). */
const filterPath = (p: string) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p).replace(/[\\':\s]/g, "\\$&").replace(/[\\'[\],;\s]/g, "\\$&");

/** Clip filters -> FFmpeg filters. Every parameter goes through filterParam (finite, in range, or 0xRRGGBB); only a LUT path is text, escaped by filterPath. */
export function filterChain(filters: any[] | undefined): string[] {
  const out: string[] = [];
  for (let f of filters || []) {
    if (typeof f === "string") f = { type: f };
    const n = (k: string) => filterParam(f.type, k, f[k]) as number;
    switch (f.type) {
      case "eq": {
        const ks = Object.keys(FILTER_SPECS.eq.fields).filter((k) => f[k] != null);
        if (ks.length) out.push("eq=" + ks.map((k) => `${k}=${n(k)}`).join(":"));
        break;
      }
      case "lut": out.push(`lut3d=file=${filterPath(String(f.path))}`); break;
      case "blur": out.push(`gblur=sigma=${(n("radius") / 2).toFixed(2)}`); break;
      case "sharpen": out.push(`unsharp=5:5:${n("amount").toFixed(2)}`); break;
      case "grayscale": out.push("hue=s=0"); break;
      case "vignette": out.push(`vignette=angle=${(0.2 + 0.6 * n("strength")).toFixed(3)}`); break;
      case "hflip": out.push("hflip"); break;
      case "vflip": out.push("vflip"); break;
      case "denoise": out.push(`hqdn3d=${n("strength").toFixed(1)}`); break;
      case "stabilize": out.push("deshake"); break;
      case "chromakey": out.push(`format=rgba,chromakey=${filterParam("chromakey", "color", f.color)}:${n("similarity")}:${n("blend")}`); break;
      default: throw new EditError(`unknown filter '${f.type}'`, "bad_filter");
    }
  }
  return out;
}

export function fitBox(sw: number, sh: number, bw: number, bh: number, fit: string) {
  if (fit === "fill") return { w: bw, h: bh, ow: bw, oh: bh, crop: false };
  if (fit === "none") return { w: sw, h: sh, ow: sw, oh: sh, crop: false };
  const s = (fit === "cover" ? Math.max : Math.min)(bw / sw, bh / sh);
  const w = Math.max(2, Math.round(sw * s)), h = Math.max(2, Math.round(sh * s));
  if (fit === "cover") return { w, h, ow: Math.min(w, bw), oh: Math.min(h, bh), crop: true };
  return { w, h, ow: w, oh: h, crop: false };
}

/** Offset (px) of a `view`-wide window in a cover-scaled picture `full` px wide that centres the picture point `f` (0..1), clamped to the picture.
 *  The one formula behind `focus`: the static crop, the animated pan and the vision mappings all use it. */
export const coverOffset = (f: number, full: number, view: number) => Math.min(full - view, Math.max(0, f * full - view / 2));

/** Accumulates a byte stream and hands out exact-size frames with back-pressure. */
class FrameStream {
  private chunks: Buffer[] = [];
  private len = 0;
  private ended = false;
  private wake: (() => void) | null = null;
  private bufs: [Buffer, Buffer];
  private flip = 0;
  constructor(private proc: ChildProcess, private frameBytes: number) {
    // double buffer: the frame returned by read() stays valid until the read after next
    this.bufs = [Buffer.allocUnsafe(frameBytes), Buffer.allocUnsafe(frameBytes)];
    const s = proc.stdout!;
    s.on("data", (c: Buffer) => {
      this.chunks.push(c); this.len += c.length;
      if (this.len > frameBytes * 3) s.pause();
      this.wake?.();
    });
    // end on the pipe, not on process exit: 'exit' can arrive before the last bytes are read
    const end = () => { this.ended = true; this.wake?.(); };
    s.on("end", end); s.on("close", end); s.on("error", end); proc.on("error", end);
  }
  async read(): Promise<Buffer | null> {
    const n = this.frameBytes;
    while (this.len < n && !this.ended) {
      this.proc.stdout!.resume();
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
    if (this.len < n) return null;
    const out = this.bufs[(this.flip ^= 1)];
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const take = Math.min(c.length, n - off);
      c.copy(out, off, 0, take);
      off += take;
      if (take === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(take);
    }
    this.len -= n;
    if (this.len < n * 2) this.proc.stdout!.resume();
    return out;
  }
}

const LOOP_REACH = new Map<string, Promise<boolean>>(); // FrameSource.checkLoopLength: does the file hold a frame at the point, by file and point
const HWACCEL = process.env.AGENTCUT_HWACCEL !== "0" && process.platform === "darwin";

export interface SourceOpts {
  path: string; kind: string; srcW: number; srcH: number; srcFps?: number | null;
  srcIn?: number; segLen?: number; // source seconds used by the clip (for reverse)
  rate: number; // output frames per SOURCE second
  fit: string; box: [number, number]; focus?: [number, number]; crop?: any; filters?: any[]; color?: Grade;
  pan?: boolean; // animated focus: emit the whole cover-scaled frame (view = visible size), the caller crops per frame
  loop?: boolean; srcDuration?: number; /* the picture's length (the asset's video_duration, else its duration) */ reverse?: boolean; freeze?: boolean;
  codec?: string; alpha?: boolean; // the asset's probe info: decides the decoder
  facts?: VideoFacts; // the asset's probe info: where the file's streams start, and how far a seek may miss; required for a video
}

/** The facts of a background-removal matte: AgentCut writes it as intra-only ProRes in a mov file that starts at 0 (vision-py.ts), so nothing is held back or starts late. */
export const MATTE_FACTS: VideoFacts = { container_start: 0, video_start: 0, format: "mov,mp4,m4a,3gp,3g2,mj2", reorder: 0, color_space: "smpte170m" }; // the writer converts with the BT.601 matrix and writes no tag: named here, so the picture is read as it was written, at any size

/** The tie rule of the slot grid. The stream's timestamps are shifted by TIE_BIAS slots before `fps` rounds them to slots, so slot j shows the latest source frame at or
 *  before the slot's time plus (0.5 - TIE_BIAS) slots: the nearest frame, and a frame exactly halfway between two slots belongs to the later slot (the slot before it keeps the older frame).
 *  The shift is made in microseconds (`settb=1/1000000`), so two clips cut from one source differ by at most 1 us of rounding (1e-6 x rate slots), never by a tick of the container (1 ms in mkv/webm).
 *  The value is off the grids where frames land on the boundary: 0.001 slot (29.97 on 30, a millisecond container at most rates) and rate/1000 slot. For frame times on a millisecond,
 *  an exact NTSC tick or a whole fps, and in-points in whole milliseconds, a frame stays at least 1e-4 slot (24 fps), 2e-4 (25-60), 7e-4 (120) from the boundary, 3.3 times the rounding
 *  or more, at the timeline rates 24, 25, 30, 50, 60, 120 and the exact NTSC rates 24000/1001, 30000/1001, 60000/1001. A rate on a finer grid than that (119 fps) has no margin to give,
 *  and neither has a decimal NTSC rate as a project stores it (settings.fps 29.97 is 2997/100: a millisecond in-point steps the phase by 1e-5 slot, so a frame can sit on the boundary). */
export const TIE_BIAS = 0.0327;

/** RGBA frames of a video/image fitted to an exact size. readAt(u) = frame at u source-seconds after the in-point. */
export class FrameSource {
  w: number; h: number; view: [number, number];
  private vf: string[];
  private proc: ChildProcess | null = null;
  private stream: FrameStream | null = null;
  private pos = -1;
  private last: Buffer | null = null;
  private tip: Buffer | null = null; // the newest frame the running stream produced (`last` is only the frame asked for)
  private eof = false;
  // What the running ffmpeg reports once it is done. fail: why it failed ("" for a clean exit whose text was only about frames never shown). retry: what a software retry answers
  // (as fail, but a run that put out no frame answers for all its text). all: everything it printed, for the message of a check that throws instead.
  private ended: Promise<{ fail: string; retry: string; all: string }> | null = null;
  private still: Buffer | null = null;
  private lengthCheck: Promise<void> | undefined; // a loop source: does the file hold its probed length (the first spawn starts it)
  private tail: { frame: Buffer | null } | undefined; // tailFrame's answer, constant for the source: back-seeks into a held region do not decode again
  private hw = HWACCEL;
  private input: string[];
  private dec: string | null;
  private pre = 0; // seconds of source decoded before a stream's first slot
  private passEnd = Infinity; // a loop clip: the last slot of the pass the running stream reads (Infinity: it is the un-sought looping stream, which wraps by itself)
  private dry = false; // a loop clip: the running stream ended before its pass did, so the slots up to the pass's end hold `hold`
  private hold: Buffer | null = null;
  constructor(private o: SourceOpts) {
    if (!Number.isFinite(o.rate) || o.rate <= 0) throw new EditError(`frame rate must be a number > 0, got ${JSON.stringify(o.rate)}`, "bad_media", "check the asset's fps in project.json");
    // a pass of a loop ends at the picture's length: without it there is no slot where a pass ends (a freeze reads no pass)
    if (o.loop && o.kind === "video" && !o.reverse && !o.freeze && !(o.srcDuration! > 0))
      throw new EditError(`${o.path} cannot loop: its probe record has no picture length, so there is no point where a pass ends`, "bad_media",
        "remux the file to mkv (ffmpeg -i <file> -c copy <file>.mkv), then relink_asset with the new path; or set loop false");
    if (o.kind !== "image") {
      const miss = missingFacts(o.facts ?? {});
      if (miss.length) throw new EditError(`the probe record of ${o.path} has no ${miss.join(", ")}`, "bad_media", "relink_asset with the file's path probes it again");
      // Decoding starts this far before the first slot, so the frames a slot depends on (the reorder delay and, after a seek, the open-GOP frames before its keyframe) are decoded:
      // at least a quarter second and the frames held back, plus, in a format whose seek can land after the target, the longest keyframe gap, so a keyframe lies in the stretch.
      const f = o.facts!;
      this.pre = Math.max(0.25, o.srcFps ? (f.reorder + 1) / o.srcFps : 0) + (seeksBefore(f.format) ? 0 : f.key_gap!);
    }
    const crop = o.crop || {};
    const [cl, cr, ct, cb] = ["left", "right", "top", "bottom"].map((k) => Number(crop[k] ?? 0));
    const cw = Math.max(2, Math.round(o.srcW * (1 - cl - cr))), ch = Math.max(2, Math.round(o.srcH * (1 - ct - cb)));
    // the picture is tagged with the matrix it is read with first (the asset's own name, else bt709 for an untagged HD one), so every conversion after it (a filter's own `format=rgba` included) uses that matrix
    const matrix = o.kind === "video" ? matrixFor(o.facts!.color_space, o.srcW, o.srcH) : undefined;
    const vf: string[] = matrix ? [`setparams=colorspace=${matrix}`] : [];
    if (cl || cr || ct || cb) vf.push(`crop=${cw}:${ch}:${Math.round(o.srcW * cl)}:${Math.round(o.srcH * ct)}`);
    vf.push(...filterChain(o.filters), ...gradeChain(o.color));
    const fb = fitBox(cw, ch, Math.max(1, Math.round(o.box[0])), Math.max(1, Math.round(o.box[1])), o.fit);
    vf.push(`scale=${fb.w}:${fb.h}:flags=bicubic`);
    if (fb.crop && (fb.w > fb.ow || fb.h > fb.oh) && !o.pan) {
      const [fx, fy] = o.focus ?? [0.5, 0.5];
      vf.push(`crop=${fb.ow}:${fb.oh}:${Math.round(coverOffset(fx, fb.w, fb.ow))}:${Math.round(coverOffset(fy, fb.h, fb.oh))}`);
    }
    vf.push("format=rgba");
    this.vf = vf; this.view = [fb.ow, fb.oh];
    [this.w, this.h] = o.pan ? [fb.w, fb.h] : this.view;
    // VideoToolbox saves ~2.6x CPU on 4K/HEVC but costs more than it saves on small sources
    if (o.kind === "image" || o.srcW * o.srcH < 2560 * 1440) this.hw = false;
    // an alpha vp8/vp9 source needs libvpx, which hwaccel does not replace
    const dec = alphaDecoder(o.codec, o.alpha, o.path);
    if (dec) this.hw = false;
    this.dec = dec;
    this.input = [...(dec ? ["-c:v", dec] : []), ...inp(o.path)];
  }

  /** Everything but the file, the in-point and the frame number that shapes a decoded frame: the filter chain, the forced decoder, hwaccel,
   *  the output rate, the source's own length and rate (they pick the held last frame), the rule that maps a slot to a source frame (TIE_BIAS), and the FFmpeg that decodes. */
  get pixelKey(): string { return JSON.stringify([this.vf, this.dec, this.hw, this.o.rate, this.o.srcDuration ?? null, this.o.srcFps ?? null, TIE_BIAS, ffmpegVersion()]); }

  /** A loop clip with a known picture length: it is read pass by pass (see `passOf`). */
  private get wraps() { return !!this.o.loop && !this.o.reverse && this.o.kind === "video" && !!this.o.srcDuration && this.o.srcDuration > 0; }
  /** The first slot of pass n of a loop: the slot of the picture's first frame, `n` lengths of the picture after the clip's in-point (the rule of `TIE_BIAS`, with the frame at `video_start`). */
  private passStart(n: number) { const o = this.o; return Math.floor((o.facts!.video_start + n * o.srcDuration! - (o.srcIn ?? 0)) * o.rate + 0.5 + TIE_BIAS); }
  /** The pass slot k belongs to: the last whose first slot is at or before k. Every stream is bounded by these slots, never by where it happens to end. */
  private passOf(k: number) {
    const o = this.o, D = o.srcDuration!;
    let n = Math.ceil(((k + 0.5 - TIE_BIAS) / o.rate + (o.srcIn ?? 0) - o.facts!.video_start) / D) - 1;
    while (this.passStart(n + 1) <= k) n++;
    while (this.passStart(n) > k) n--;
    return n;
  }
  /** Whether the passes after a stream's first may come from one un-sought `-stream_loop -1` stream: only when the period such a stream would have is the pass length.
   *  That period runs from the video's first packet to the picture's end: the picture's recorded length (`video_duration`, else the container's `duration`) less `video_start`. It must equal `srcDuration` within
   *  PERIOD_TOLERANCE. In a render `srcDuration` is that same recorded length, so the two lengths cancel and the live test is `video_start` within the tolerance; the length comparison only bites for a `srcDuration`
   *  passed by hand, and a record that leaves the length out says nothing, so it is not trusted. Otherwise every pass is its own bounded stream, at `n * srcDuration` apart. */
  private fillsPass() {
    const f = this.o.facts as VideoFacts & { duration?: number; video_duration?: number | null };
    return Math.abs((f.video_duration ?? f.duration)! - f.video_start - this.o.srcDuration!) <= PERIOD_TOLERANCE;
  }

  /** The ffmpeg command whose first frame is slot k of the clip (a reverse clip: its first slot), the same source frame whether the stream starts here or earlier, and with or without an audio track.
   *  It seeks to the keyframe before `pre` seconds ahead of the slot (`-noaccurate_seek` keeps the frames from there on, a gap in a variable-rate file included), puts every timestamp on the
   *  clip's clock (container start and in-point subtracted, TIE_BIAS added, the passes of a loop before the slot's added) and lets `fps` assign the slots, so the frame of a slot does not depend on the first frame decoded.
   *  A stream whose first frame is later than its slot grid (the seek lands before the video starts, or in a format whose seek can land after the target) is filled back with that frame,
   *  from a whole number of slots before the slot, which keeps the grid's phase. A loop clip's stream reads the pass of its first slot and no loop, except `unsought`: a read from the file's start
   *  (no seek, so ffmpeg's loop restarts at 0) that carries on through the passes after. */
  private args(k: number, mode: "stream" | "still" | "tail" | "reach", at?: number, unsought = false): string[] {
    // still: the first frame only, as a forward clip (a freeze holds the frame the clip's first slot shows). tail: the clip read to the end of the picture without looping,
    // from at most two slots before it, whose last frame is the one a running clip holds there. reach: the still at source time `at` (default: a loop clip's in-point inside one pass),
    // with no wrap, to see whether the file really holds that stretch.
    const o = this.o, f = o.facts!, r = o.rate, D = o.srcDuration, reverse = !!o.reverse && mode === "stream", loop = !!o.loop && mode !== "tail" && mode !== "reach" && !reverse;
    const srcIn = mode === "tail" && D ? this.tailIn(D) : mode === "reach" && D ? at ?? (o.srcIn ?? 0) % D : (o.srcIn ?? 0);
    const a = ["-v", "error", "-nostdin"];
    if (mode === "stream" && this.hw) a.push("-hwaccel", "videotoolbox");
    let n = 0, ss = Math.max(0, srcIn + k / r - this.pre); // n: the pass of the slot; ss: where the seek aims, inside that pass
    if (loop && D) { n = this.passOf(k); ss = unsought ? 0 : Math.max(0, srcIn + k / r - n * D - this.pre); } // a slot's pre-roll in the pass before is not read: the fill below stands in for it
    if (unsought) a.push("-stream_loop", "-1");
    const shift = n * (D ?? 0) - srcIn - f.container_start + TIE_BIAS / r;
    const fill = ss <= f.video_start || !seeksBefore(f.format) ? `:start_time=${((k - Math.ceil(this.pre * r)) / r).toFixed(6)}` : "";
    const slots = reverse // reverse buffers the whole segment, so it always streams from its start and keeps the slots of the clip
      ? [`trim=start=${(-0.25 / r).toFixed(6)}:end=${((Math.round((o.segLen ?? 1) * r) - 0.25) / r).toFixed(6)}`, "reverse"]
      : [`trim=start=${((k - 0.25) / r).toFixed(6)}`];
    a.push("-noaccurate_seek", "-copyts", "-ss", ss.toFixed(6), ...this.input, "-an", "-sn",
      "-vf", ["settb=1/1000000", `setpts=PTS+(${shift.toFixed(6)})/TB`, `fps=${r}${fill}`, ...slots, ...this.vf].join(","));
    if (reverse) a.push("-to", ((o.segLen ?? 1) - 0.25 / r).toFixed(6));
    a.push("-fps_mode", "passthrough");
    if (mode === "still" || mode === "reach") a.push("-frames:v", "1");
    return [...a, "-f", "rawvideo", "-pix_fmt", "rgba", "-"];
  }

  /** The in-point the tail is read from: the clip's own, or two slots before the end of the picture when the clip starts later (its grid holds no slot of the picture then). */
  private tailIn(end: number) { return Math.max(0, Math.min(this.o.srcIn ?? 0, end - 2 / this.o.rate)); }

  private spawnAt(k: number) {
    this.close();
    this.passEnd = Infinity; this.dry = false; this.hold = null;
    let unsought = false;
    if (this.wraps) { // a stream that starts at a pass's first slot may carry on through the later passes by itself; any other reads its own pass only
      const n = this.passOf(k);
      unsought = k === this.passStart(n) && this.fillsPass();
      if (!unsought) this.passEnd = this.passStart(n + 1) - 1;
    }
    this.proc = spawn("ffmpeg", this.args(this.o.reverse ? 0 : k, "stream", undefined, unsought), { stdio: ["ignore", "pipe", "pipe"] });
    const proc = this.proc;
    if (!this.lengthCheck) { this.lengthCheck = this.checkLoopLength(); this.lengthCheck.catch(() => {}); } // awaited by readAt; this keeps a read that fails first from leaving it unhandled
    // Decoder text printed before the first frame is out belongs to the frames decoded ahead of the first slot (after a seek into a format whose seek can land mid-GOP, they miss their references)
    // and is never shown: on a clean exit only the text after it fails the read. A run that put out no frame showed nothing, so no text fails it: the length checks and the held last frame decide.
    const frameBytes = this.w * this.h * 4;
    let before = "", after = "", seen = 0, framed = false;
    proc.stderr?.on("data", (d) => { if (framed ? after.length < 2000 : before.length < 2000) { if (framed) after += d; else before += d; } });
    proc.stdout?.on("data", (d: Buffer) => { seen += d.length; if (seen >= frameBytes) framed = true; });
    // a spawn failure ('error') and a non-zero exit both count as a failed decode, before or after the first frame
    this.ended = new Promise((res) => {
      proc.once("error", (e) => { const t = `${before}${after}${e}`.trim(); res({ fail: t, retry: t, all: t }); });
      proc.once("close", (code, sig) => {
        const text = `${before}${after}`;
        if (code !== 0) { const t = `${text}ffmpeg exited with ${code ?? sig}`.trim(); res({ fail: t, retry: t, all: t }); }
        else res({ fail: after.trim(), retry: (framed ? after : before).trim(), all: text.trim() });
      });
    });
    this.stream = new FrameStream(this.proc, frameBytes);
    this.pos = this.o.reverse ? -1 : k - 1;
    this.tip = null;
    this.eof = false;
  }

  /** One frame: an image, or the clip's first slot (the frame its first slot shows when it plays). endOk: a clean ffmpeg exit with no frame (the in-point is at or past the video's end) answers null instead of an error. */
  private async decodeStill(endOk = false, mode: "still" | "reach" = "still", at?: number): Promise<Buffer | null> {
    const o = this.o;
    const a = o.kind === "image" ? ["-v", "error", "-nostdin", ...this.input, "-frames:v", "1", "-vf", this.vf.join(","), "-f", "rawvideo", "-pix_fmt", "rgba", "-"] : this.args(0, mode, at);
    const n = this.w * this.h * 4;
    // async so several layers / contact-sheet tiles decode concurrently
    const r = await new Promise<{ status: number | null; out: Buffer; err: string }>((res) => {
      const p = spawn("ffmpeg", a, { stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = []; let err = "";
      p.stdout!.on("data", (d: Buffer) => chunks.push(d));
      p.stderr!.on("data", (d) => { if (err.length < 2000) err += d; });
      p.on("error", (e) => res({ status: -1, out: Buffer.alloc(0), err: String(e) }));
      p.on("close", (status) => res({ status, out: Buffer.concat(chunks), err }));
    });
    if (endOk && r.status === 0 && !r.out.length) return null;
    if (r.status !== 0 || r.out.length < n) throw new EditError(`cannot decode ${o.path}: ${r.err.slice(0, 300)}`, "decode_failed");
    return r.out.subarray(0, n);
  }

  /** The last frame of the clip's own stream (null: none), the one a clip that plays to the end of the picture holds: the clip's command started two slots before the end, keeping the final frame. */
  private async tailFrame(): Promise<Buffer | null> {
    return (this.tail ??= { frame: await this.decodeTail() }).frame;
  }

  private async decodeTail(): Promise<Buffer | null> {
    const o = this.o, end = o.srcDuration;
    // a source with no known length has no slot to start from: its last second, whichever frame the grid starts at
    const a = end ? this.args(Math.max(0, Math.floor((end - this.tailIn(end)) * o.rate) - 2), "tail")
      : ["-v", "error", "-nostdin", "-sseof", "-1", ...this.input, "-an", "-sn", "-vf", [`fps=${o.rate}`, ...this.vf].join(","), "-f", "rawvideo", "-pix_fmt", "rgba", "-"];
    const p = spawn("ffmpeg", a, { stdio: ["ignore", "pipe", "pipe"] });
    p.stderr!.resume();
    const fs = new FrameStream(p, this.w * this.h * 4);
    let out: Buffer | null = null;
    for (let f = await fs.read(); f; f = await fs.read()) out = Buffer.from(f); // read() hands out a reused buffer
    try { p.stdout!.destroy(); p.kill("SIGKILL"); } catch { /* ignore */ }
    return out;
  }

  /** A source that ends well inside its probed picture length (at `at` source seconds) is damaged or was replaced, and holding its last frame would hide that. */
  private endedEarly(at: number, absolute = false) { // absolute: `at` is a source time (a freeze), also for a loop or reverse clip
    const o = this.o;
    return (absolute || (!o.reverse && !o.loop)) && !!o.srcDuration && at < o.srcDuration - 0.5 - 1 / o.rate;
  }

  private gone(why: string, at: number, text = "") { // text: what the run printed, so a check that throws after a clean exit keeps the decoder's words
    return new EditError(`decode failed for ${this.o.path}: ${why} at ${at.toFixed(2)}s${text ? `: ${text.slice(0, 300)}` : ""}`, "decode_failed", "relink_asset with the same path probes the file again, which records a shorter picture when the file reports one; otherwise trim the clip to the picture's length. The file may be truncated or have changed");
  }

  /** A loop clip repeats the probed length: a source that holds no frame at the point where a plain clip would call it ended early (`endedEarly`) loops at its real length and shows other frames than the clip's slots name. */
  private async checkLoopLength(): Promise<void> {
    const o = this.o, D = o.srcDuration, at = D ? D - 0.5 - 1 / o.rate : 0;
    if (!o.loop || o.reverse || !D || at <= 0) return;
    // the answer is the file's: a preview or a render segment builds a new FrameSource per read, so it is kept per file, size, mtime and point (a failed read is not kept)
    let key: string | null = null;
    try { const st = statSync(o.path); key = `${o.path}|${st.size}|${st.mtimeMs}|${at}`; } catch { /* a path that cannot be stat'ed (a missing file, a URL): no key, the answer is not kept */ }
    let held = key ? LOOP_REACH.get(key) : undefined;
    if (!held) {
      held = this.decodeStill(true, "reach", at).then((f) => !!f);
      if (key) {
        if (LOOP_REACH.size >= 256) LOOP_REACH.delete(LOOP_REACH.keys().next().value!);
        LOOP_REACH.set(key, held);
        held.catch(() => LOOP_REACH.delete(key!));
      }
    }
    if (!(await held)) throw new EditError(`decode failed for ${o.path}: the source ended before its probed length at ${at.toFixed(2)}s (the project records ${D.toFixed(2)}s of picture)`, "decode_failed",
      "relink_asset with the same path probes the file again. If the error stays, the file's recorded length is longer than its picture (a truncated file, or an mkv/webm whose sound outlasts its picture): remux it to mp4 and relink, or set loop false");
  }

  /** The frame a freeze holds: the one at the in-point (wrapped into the source for a loop clip); at or past the video's end, its last frame, as a playing clip holds it (a source that ends well inside its probed length stays decode_failed). */
  private async frozenFrame(): Promise<Buffer> {
    const o = this.o;
    let at = o.srcIn ?? 0;
    if (o.loop && o.srcDuration) at %= o.srcDuration;
    // the still below reads only the pass of slot 0, which can end before the picture starts (an in-point in a late video's lead-in) and then holds no frame of its own: a loop first reads its in-point
    // inside one pass, which alone tells a source that ends well inside its probed length from that gap
    const passes = !!o.loop && !!o.srcDuration;
    if (passes && !(await this.decodeStill(true, "reach")) && this.endedEarly(at, true)) throw this.gone("the source ended before the frozen frame", at);
    const f = await this.decodeStill(true);
    if (f) return f;
    // an empty still of a loop whose reach read held is the gap before the pass's picture: the clip shows the tail frame there, as it does while it plays
    if (!passes && this.endedEarly(at, true)) throw this.gone("the source ended before the frozen frame", at);
    const last = await this.tailFrame();
    if (!last) throw this.gone("the source has no frame", at);
    return last;
  }

  /** u: source seconds since the in-point (>= 0). */
  async readAt(u: number): Promise<Buffer> {
    const o = this.o;
    if (o.kind === "image") return (this.still ??= (await this.decodeStill())!);
    if (o.freeze) return (this.still ??= await this.frozenFrame());
    const frame = await this.readFrame(u);
    await this.lengthCheck; // started beside the first spawn: no frame of a loop source is handed out before its length is known to hold
    return frame;
  }

  private async readFrame(u: number): Promise<Buffer> {
    const o = this.o;
    const k = Math.max(0, Math.round(u * o.rate));
    if (this.eof && k > this.pos) return this.last!;
    if (k === this.pos && this.last) return this.last;
    if (!this.proc || k < this.pos || k - this.pos > Math.max(4, o.rate * 2)) {
      if (o.reverse && this.proc && k > this.pos) { /* keep streaming */ } else this.spawnAt(k);
    }
    while (this.pos < k) {
      if (this.pos + 1 > this.passEnd) { this.spawnAt(this.pos + 1); continue; } // a loop clip: the next pass starts at its own first slot
      if (this.dry) { this.pos++; this.tip = this.hold; if (this.pos === k) this.last = this.hold; continue; }
      const f = await this.stream!.read();
      if (!f) {
        const end = await this.ended!;
        if (end.retry && this.hw) { this.hw = false; this.spawnAt(k); continue; } // retry once in software
        if (end.fail) throw new EditError(`decode failed for ${o.path}: ${end.fail.slice(0, 300)}`, "decode_failed");
        // a clean end: past the probed length the last frame is held (the documented 'clip needs more source' warning);
        // a source that ends well inside its probed length is damaged or was replaced, and a hold would hide that
        const at = (o.srcIn ?? 0) + k / o.rate;
        if (this.endedEarly(at)) throw this.gone(`the source ended after ${this.pos + 1} frames`, at, end.all);
        if (this.wraps) { // a loop clip: the stream ended before its pass did (a file shorter than the pass, or a pass that starts after the picture): its last frame holds to the pass's end
          const held = this.tip ?? await this.tailFrame();
          if (!held) throw this.gone("the source has no frame", at, end.all);
          this.dry = true; this.hold = held;
          continue;
        }
        // a fresh source read at or past the end (preview, still, sheet tile, a later render segment) holds the source's last frame, like a streamed one
        // (a jump that runs off the end holds the stream's newest frame: `last` may be a recycled buffer by then)
        this.last = this.tip ?? (o.reverse ? null : await this.tailFrame());
        if (!this.last) throw this.gone("the source has no frame", at, end.all);
        this.eof = true;
        return this.last;
      }
      this.pos++;
      this.tip = f;
      if (this.pos === k) this.last = f;
    }
    return this.last!;
  }

  close() {
    if (this.proc) { try { this.proc.stdout?.destroy(); this.proc.kill("SIGKILL"); } catch { /* ignore */ } }
    this.proc = null; this.stream = null;
  }
}
