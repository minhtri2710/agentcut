// Media probing and decoding through FFmpeg pipes (async, back-pressured, exact-size frame reads).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { EditError } from "./model.ts";

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

const probeCache = new Map<string, { mtime: number; info: any }>();
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
    if (!j || !Array.isArray(j.layers) || !j.fr) throw new EditError(`${path} is not a Lottie animation`, "bad_media");
    info = { path, kind: "lottie", width: j.w, height: j.h, fps: j.fr, duration: +((j.op - j.ip) / j.fr).toFixed(3), has_audio: false, alpha: true };
  } else {
    needFfmpeg();
    const r = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8", maxBuffer: 32 << 20 });
    if (r.status !== 0) throw new EditError(`ffprobe cannot read ${path}: ${(r.stderr || "").trim().slice(0, 300)}`, "bad_media");
    const j = JSON.parse(r.stdout);
    const streams: any[] = j.streams || [];
    const v = streams.find((s) => s.codec_type === "video" && !(s.disposition?.attached_pic));
    const a = streams.find((s) => s.codec_type === "audio");
    const dur = Number(j.format?.duration ?? v?.duration ?? a?.duration ?? 0);
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
        fps: still ? null : +fps.toFixed(3), alpha: /^(rgba|yuva|argb|bgra|ya|pal8|gbrap)/.test(v.pix_fmt || "") || ext === ".gif",
      });
      if (!still) info.duration = +dur.toFixed(3);
    } else if (a || AUDIO_EXT.has(ext)) {
      Object.assign(info, { kind: "audio", duration: +dur.toFixed(3), sample_rate: a ? +a.sample_rate : null, channels: a?.channels ?? null });
    } else throw new EditError(`no audio or video stream in ${path}`, "bad_media");
  }
  probeCache.set(path, { mtime, info });
  return { ...info };
}

export const LOOKS: Record<string, string> = {
  warm: "colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.05:bm=-0.05,eq=saturation=1.1",
  cool: "colorbalance=rs=-0.06:bs=0.08:rm=-0.04:bm=0.06",
  vintage: "curves=preset=vintage,eq=saturation=0.85",
  bw: "hue=s=0,eq=contrast=1.15",
  cinematic: "eq=contrast=1.12:saturation=0.9,colorbalance=rs=-0.05:bs=0.06:rh=0.06:bh=-0.04",
  teal_orange: "colorbalance=rs=-0.1:bs=0.1:rh=0.1:bh=-0.1,eq=saturation=1.15",
  vivid: "eq=saturation=1.35:contrast=1.08",
  fade: "curves=all='0/0.08 1/0.92',eq=saturation=0.85",
  moody: "eq=contrast=1.15:brightness=-0.04:saturation=0.75,colorbalance=bs=0.05:bm=0.03",
  pastel: "eq=saturation=0.7:brightness=0.05,curves=all='0/0.1 1/1'",
};

export function filterChain(filters: any[] | undefined): string[] {
  const out: string[] = [];
  for (let f of filters || []) {
    if (typeof f === "string") f = { type: f };
    switch (f.type) {
      case "eq": {
        const ks = ["brightness", "contrast", "saturation", "gamma"].filter((k) => k in f);
        if (ks.length) out.push("eq=" + ks.map((k) => `${k}=${f[k]}`).join(":"));
        break;
      }
      case "look":
        if (!LOOKS[f.name ?? "cinematic"]) throw new EditError(`unknown look '${f.name}'`, "bad_filter", `looks: ${Object.keys(LOOKS).join(", ")}`);
        out.push(LOOKS[f.name ?? "cinematic"]); break;
      case "lut": out.push(`lut3d=file='${String(f.path).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'")}'`); break;
      case "blur": out.push(`gblur=sigma=${(Number(f.radius ?? 5) / 2).toFixed(2)}`); break;
      case "sharpen": out.push(`unsharp=5:5:${Number(f.amount ?? 1).toFixed(2)}`); break;
      case "grayscale": out.push("hue=s=0"); break;
      case "vignette": out.push(`vignette=angle=${(0.2 + 0.6 * Number(f.strength ?? 0.5)).toFixed(3)}`); break;
      case "hflip": out.push("hflip"); break;
      case "vflip": out.push("vflip"); break;
      case "denoise": out.push(`hqdn3d=${Number(f.strength ?? 4).toFixed(1)}`); break;
      case "stabilize": out.push("deshake"); break;
      case "chromakey":
        out.push(`format=rgba,chromakey=${String(f.color ?? "#00ff00").replace("#", "0x")}:${Number(f.similarity ?? 0.1)}:${Number(f.blend ?? 0.05)}`); break;
      case "ffmpeg": out.push(String(f.value)); break;
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
  fit: string; box: [number, number]; focus?: [number, number]; crop?: any; filters?: any[];
  loop?: boolean; srcDuration?: number; reverse?: boolean; freeze?: boolean;
}

/** RGBA frames of a video/image fitted to an exact size. readAt(u) = frame at u source-seconds after the in-point. */
export class FrameSource {
  w: number; h: number;
  private vf: string[];
  private proc: ChildProcess | null = null;
  private stream: FrameStream | null = null;
  private pos = -1;
  private last: Buffer | null = null;
  private eof = false;
  private still: Buffer | null = null;
  private hw = HWACCEL;
  constructor(private o: SourceOpts) {
    const crop = o.crop || {};
    const [cl, cr, ct, cb] = ["left", "right", "top", "bottom"].map((k) => Number(crop[k] ?? 0));
    const cw = Math.max(2, Math.round(o.srcW * (1 - cl - cr))), ch = Math.max(2, Math.round(o.srcH * (1 - ct - cb)));
    const vf: string[] = [];
    if (cl || cr || ct || cb) vf.push(`crop=${cw}:${ch}:${Math.round(o.srcW * cl)}:${Math.round(o.srcH * ct)}`);
    vf.push(...filterChain(o.filters));
    const fb = fitBox(cw, ch, Math.max(1, Math.round(o.box[0])), Math.max(1, Math.round(o.box[1])), o.fit);
    vf.push(`scale=${fb.w}:${fb.h}:flags=bicubic`);
    if (fb.crop && (fb.w > fb.ow || fb.h > fb.oh)) {
      const [fx, fy] = o.focus ?? [0.5, 0.5];
      vf.push(`crop=${fb.ow}:${fb.oh}:${Math.round((fb.w - fb.ow) * fx)}:${Math.round((fb.h - fb.oh) * fy)}`);
    }
    vf.push("format=rgba");
    this.vf = vf; this.w = fb.ow; this.h = fb.oh;
    // VideoToolbox saves ~2.6x CPU on 4K/HEVC but costs more than it saves on small sources
    if (o.kind === "image" || o.srcW * o.srcH < 2560 * 1440) this.hw = false;
  }

  private args(k: number, single: boolean): string[] {
    const o = this.o;
    const a = ["-v", "error", "-nostdin"];
    if (this.hw && !single) a.push("-hwaccel", "videotoolbox");
    if (o.reverse) {
      const len = o.segLen ?? 1;
      // reverse buffers the whole segment, so it always streams from its start
      a.push("-ss", (o.srcIn ?? 0).toFixed(6), "-t", len.toFixed(6), "-i", o.path, "-an", "-sn",
        "-vf", [`fps=${o.rate}`, "reverse", ...this.vf].join(","));
      return [...a, "-f", "rawvideo", "-pix_fmt", "rgba", "-"];
    }
    let t0 = (o.srcIn ?? 0) + k / o.rate;
    if (o.loop && o.srcDuration) t0 %= o.srcDuration;
    if (o.loop) a.push("-stream_loop", "-1");
    a.push("-ss", t0.toFixed(6), "-i", o.path, "-an", "-sn", "-vf", [`fps=${o.rate}`, ...this.vf].join(","));
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
    const a = ["-v", "error", "-nostdin", ...(o.kind === "image" ? [] : ["-ss", t.toFixed(6)]), "-i", o.path, "-frames:v", "1",
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

export function ffmpegRun(args: string[], opts: { input?: Buffer } = {}) {
  needFfmpeg();
  return spawnSync("ffmpeg", args, { input: opts.input, maxBuffer: 1 << 30, encoding: "buffer" });
}
