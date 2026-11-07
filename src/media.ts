// Media probing and decoding through FFmpeg pipes (async, back-pressured, exact-size frame reads).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { gradeChain, type Grade } from "./color.ts";
import { inp } from "./ffinput.ts";
import { EditError, FILTER_SPECS, filterParam } from "./model.ts";

/** Stop `ch` when `signal` aborts: close its stdin (EOF is the stop request for ffmpeg and the vision helper), SIGTERM it, and
 *  SIGKILL it after `graceMs` if it is still running. Only the direct child is signalled (no process-group kill): what uv forwards
 *  to python is unverified, which is why the helper also watches its stdin. */
export function stopOnAbort(ch: ChildProcess, signal?: AbortSignal, graceMs = 1500) {
  if (!signal) return;
  const stop = () => {
    try { ch.stdin?.end(); } catch { /* already closed */ }
    ch.kill();
    const t = setTimeout(() => ch.kill("SIGKILL"), graceMs);
    ch.once("close", () => clearTimeout(t));
  };
  if (signal.aborted) return stop();
  signal.addEventListener("abort", stop, { once: true });
  ch.once("close", () => signal.removeEventListener("abort", stop));
}

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

/** FFmpeg's native vp8/vp9 decoders drop the alpha plane of a webm; the libvpx decoders keep it. */
const VPX_DECODER: Record<string, string> = { vp8: "libvpx", vp9: "libvpx-vp9" };

let decoderList: string | null = null;
/** The decoder to force (before -i) for a source whose alpha the default decoder would lose, else null. Fails closed when this FFmpeg lacks it. */
export function alphaDecoder(codec: string | undefined, alpha: boolean | undefined, path: string): string | null {
  const name = alpha && codec ? VPX_DECODER[codec] : undefined;
  if (!name) return null;
  if (decoderList === null) decoderList = spawnSync("ffmpeg", ["-hide_banner", "-decoders"], { encoding: "utf8" }).stdout || "";
  if (!new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(decoderList)) throw new EditError(`this FFmpeg build has no ${name} decoder (needed for the alpha channel of ${path})`,
    "missing_dependency", "install an FFmpeg build with libvpx (e.g. a full static build)");
  return name;
}

const probeCache = new Map<string, { mtime: number; info: any }>();
/** vp8/vp9 in webm carry alpha as a side plane that pix_fmt does not show; the muxer flags it with an alpha_mode tag (key case varies). */
const hasAlphaTag = (tags: Record<string, unknown> | undefined) => Object.entries(tags ?? {}).some(([k, x]) => k.toLowerCase() === "alpha_mode" && String(x) === "1");
export function probe(path: string): any {
  if (!existsSync(path)) throw new EditError(`file not found: ${path}`, "not_found");
  const mtime = statSync(path).mtimeMs;
  const hit = probeCache.get(path);
  if (hit && hit.mtime === mtime) return { ...hit.info };
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
    const dur = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0) || 0;
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
        fps: still || !(fps > 0) ? null : +fps.toFixed(3), alpha: /^(rgba|yuva|argb|bgra|ya|pal8|gbrap)/.test(v.pix_fmt || "") || ext === ".gif" || (v.codec_name in VPX_DECODER && hasAlphaTag(v.tags)),
      });
      if (!still) info.duration = +dur.toFixed(3);
    } else if (a || AUDIO_EXT.has(ext)) {
      Object.assign(info, { kind: "audio", duration: +dur.toFixed(3), sample_rate: a ? +a.sample_rate : null, channels: a?.channels ?? null });
    } else throw new EditError(`no audio or video stream in ${path}`, "bad_media");
  }
  probeCache.set(path, { mtime, info });
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
    const end = () => { this.ended = true; this.wake?.(); };
    s.on("end", end); s.on("error", end); proc.on("exit", end);
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

const HWACCEL = process.env.AGENTCUT_HWACCEL !== "0" && process.platform === "darwin";

export interface SourceOpts {
  path: string; kind: string; srcW: number; srcH: number; srcFps?: number | null;
  srcIn?: number; segLen?: number; // source seconds used by the clip (for reverse)
  rate: number; // output frames per SOURCE second
  fit: string; box: [number, number]; focus?: [number, number]; crop?: any; filters?: any[]; color?: Grade;
  pan?: boolean; // animated focus: emit the whole cover-scaled frame (view = visible size), the caller crops per frame
  loop?: boolean; srcDuration?: number; reverse?: boolean; freeze?: boolean;
  codec?: string; alpha?: boolean; // the asset's probe info: decides the decoder
}

/** RGBA frames of a video/image fitted to an exact size. readAt(u) = frame at u source-seconds after the in-point. */
export class FrameSource {
  w: number; h: number; view: [number, number];
  private vf: string[];
  private proc: ChildProcess | null = null;
  private stream: FrameStream | null = null;
  private pos = -1;
  private last: Buffer | null = null;
  private eof = false;
  private still: Buffer | null = null;
  private hw = HWACCEL;
  private input: string[];
  constructor(private o: SourceOpts) {
    if (!Number.isFinite(o.rate) || o.rate <= 0) throw new EditError(`frame rate must be a number > 0, got ${JSON.stringify(o.rate)}`, "bad_media", "check the asset's fps in project.json");
    const crop = o.crop || {};
    const [cl, cr, ct, cb] = ["left", "right", "top", "bottom"].map((k) => Number(crop[k] ?? 0));
    const cw = Math.max(2, Math.round(o.srcW * (1 - cl - cr))), ch = Math.max(2, Math.round(o.srcH * (1 - ct - cb)));
    const vf: string[] = [];
    if (cl || cr || ct || cb) vf.push(`crop=${cw}:${ch}:${Math.round(o.srcW * cl)}:${Math.round(o.srcH * ct)}`);
    vf.push(...filterChain(o.filters), ...gradeChain(o.color));
    const fb = fitBox(cw, ch, Math.max(1, Math.round(o.box[0])), Math.max(1, Math.round(o.box[1])), o.fit);
    vf.push(`scale=${fb.w}:${fb.h}:flags=bicubic`);
    if (fb.crop && (fb.w > fb.ow || fb.h > fb.oh) && !o.pan) {
      const [fx, fy] = o.focus ?? [0.5, 0.5];
      vf.push(`crop=${fb.ow}:${fb.oh}:${Math.round((fb.w - fb.ow) * fx)}:${Math.round((fb.h - fb.oh) * fy)}`);
    }
    vf.push("format=rgba");
    this.vf = vf; this.view = [fb.ow, fb.oh];
    [this.w, this.h] = o.pan ? [fb.w, fb.h] : this.view;
    // VideoToolbox saves ~2.6x CPU on 4K/HEVC but costs more than it saves on small sources
    if (o.kind === "image" || o.srcW * o.srcH < 2560 * 1440) this.hw = false;
    // an alpha vp8/vp9 source needs libvpx, which hwaccel does not replace
    const dec = alphaDecoder(o.codec, o.alpha, o.path);
    if (dec) this.hw = false;
    this.input = [...(dec ? ["-c:v", dec] : []), ...inp(o.path)];
  }

  private args(k: number, single: boolean): string[] {
    const o = this.o;
    const a = ["-v", "error", "-nostdin"];
    if (this.hw && !single) a.push("-hwaccel", "videotoolbox");
    if (o.reverse) {
      const len = o.segLen ?? 1;
      // reverse buffers the whole segment, so it always streams from its start
      a.push("-ss", (o.srcIn ?? 0).toFixed(6), "-t", len.toFixed(6), ...this.input, "-an", "-sn",
        "-vf", [`fps=${o.rate}`, "reverse", ...this.vf].join(","));
      return [...a, "-f", "rawvideo", "-pix_fmt", "rgba", "-"];
    }
    let t0 = (o.srcIn ?? 0) + k / o.rate;
    if (o.loop && o.srcDuration) t0 %= o.srcDuration;
    if (o.loop) a.push("-stream_loop", "-1");
    a.push("-ss", t0.toFixed(6), ...this.input, "-an", "-sn", "-vf", [`fps=${o.rate}`, ...this.vf].join(","));
    if (single) a.push("-frames:v", "1");
    return [...a, "-f", "rawvideo", "-pix_fmt", "rgba", "-"];
  }

  private spawnAt(k: number) {
    this.close();
    this.proc = spawn("ffmpeg", this.args(this.o.reverse ? 0 : k, false), { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    this.proc.stderr!.on("data", (d) => { if (err.length < 2000) err += d; });
    (this.proc as any)._err = () => err;
    this.stream = new FrameStream(this.proc, this.w * this.h * 4);
    this.pos = this.o.reverse ? -1 : k - 1;
    this.eof = false;
  }

  private async decodeStill(t: number): Promise<Buffer> {
    const o = this.o;
    const a = ["-v", "error", "-nostdin", ...(o.kind === "image" ? [] : ["-ss", t.toFixed(6)]), ...this.input, "-frames:v", "1",
      "-vf", this.vf.join(","), "-f", "rawvideo", "-pix_fmt", "rgba", "-"];
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
    if (r.status !== 0 || r.out.length < n) throw new EditError(`cannot decode ${o.path}: ${r.err.slice(0, 300)}`, "decode_failed");
    return r.out.subarray(0, n);
  }

  /** u: source seconds since the in-point (>= 0). */
  async readAt(u: number): Promise<Buffer> {
    const o = this.o;
    if (o.kind === "image" || o.freeze) return (this.still ??= await this.decodeStill(o.srcIn ?? 0));
    const k = Math.max(0, Math.round(u * o.rate));
    if (this.eof && k > this.pos) return this.last ?? Buffer.alloc(this.w * this.h * 4);
    if (k === this.pos && this.last) return this.last;
    if (!this.proc || k < this.pos || k - this.pos > Math.max(4, o.rate * 2)) {
      if (o.reverse && this.proc && k > this.pos) { /* keep streaming */ } else this.spawnAt(k);
    }
    while (this.pos < k) {
      const f = await this.stream!.read();
      if (!f) {
        if (!this.last) {
          const err = (this.proc as any)?._err?.() ?? "";
          if (this.hw) { this.hw = false; this.spawnAt(k); continue; } // retry once in software

          if (err.trim()) throw new EditError(`decode failed for ${o.path}: ${err.slice(0, 300)}`, "decode_failed");
          this.last = Buffer.alloc(this.w * this.h * 4);
        }
        this.eof = true;
        return this.last;
      }
      this.pos++;
      if (this.pos === k) this.last = f;
    }
    return this.last!;
  }

  close() {
    if (this.proc) { try { this.proc.stdout?.destroy(); this.proc.kill("SIGKILL"); } catch { /* ignore */ } }
    this.proc = null; this.stream = null;
  }
}
