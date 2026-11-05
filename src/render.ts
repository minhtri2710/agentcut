// Skia compositor. Sources are decoded+fitted by FFmpeg (or drawn natively), composited with full keyframe
// control on a 2D canvas, and streamed to an FFmpeg encoder with back-pressure.
import * as Skia from "@napi-rs/canvas";
import { type Canvas, createCanvas, ImageData, LottieAnimation, type SKRSContext2D } from "@napi-rs/canvas";
import { setCanvas } from "./canvas.ts";
import * as A from "./anim.ts";
import { applyEffects, applyMask, scratch, shapePath } from "./effects.ts";
import { FrameSource } from "./media.ts";
import {
  type Clip, css, type Dict, EditError, normAnim, parseColor, parseLen, parseTime, resolve, type Timeline, totalDuration,
  type Track, VISUAL_TYPES,
} from "./model.ts";
import { captionPages, captionWords, type CWord, maxWidthPx, renderText, TextStyle } from "./text.ts";

setCanvas(Skia);

const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: "source-over", multiply: "multiply", screen: "screen", add: "lighter", overlay: "overlay", darken: "darken",
  lighten: "lighten", color_dodge: "color-dodge", soft_light: "soft-light", difference: "difference",
} as any;
type GlobalCompositeOperation = string;

const even = (v: number) => { const r = Math.round(v); return r + (r % 2); };

interface Frame { canvas?: Canvas; buf?: Buffer; w: number; h: number; under?: { img: Canvas; w: number; h: number } }

class LRU<V> extends Map<string, V> {
  constructor(private n = 24) { super(); }
  getOr(k: string, f: () => V): V {
    const v = super.get(k);
    if (v !== undefined) { super.delete(k); super.set(k, v); return v; }
    const nv = f(); super.set(k, nv);
    if (this.size > this.n) super.delete(this.keys().next().value!);
    return nv;
  }
}

// ------------------------------------------------------------------ per-clip layer
export class Layer {
  type: string; start: number; dur: number; end: number;
  prev: Layer | null = null; next: Layer | null = null;
  q = 1; opaque = false; box: [number, number] = [0, 0];
  asset?: Dict; src?: FrameSource; cache = new LRU<Canvas>(32);
  words: CWord[] = []; pages: number[][] = [];
  private lottie?: LottieAnimation; private canvasBuf?: Canvas; private tinyBuf?: Canvas; private style?: TextStyle;
  private ramp?: any[]; private rampT = 0; private rampU = 0;
  constructor(public r: Renderer, public track: Track, public c: Clip) {
    this.type = c.type; this.start = parseTime(c.start ?? 0); this.dur = parseTime(c.duration ?? 0); this.end = this.start + this.dur;
    const k = r.k;
    if (this.type === "video" || this.type === "image" || this.type === "lottie") {
      this.asset = r.tl.assets[c.asset];
      const size = c.size;
      this.box = [size ? parseLen(size[0], r.W0) * k : r.W, size ? parseLen(size[1], r.H0) * k : r.H];
      const sk = c.keyframes?.scale;
      let mx = Number(c.scale ?? 1) * (sk ? Math.max(...sk.map((x: any) => A.parseKfs([x])[0][1])) : 1);
      if (c.motion) mx *= 1.15;
      this.q = Math.min(1.5, Math.max(1, mx > 1.06 ? mx : 1)); // oversample only for real zoom-ins
      const fit = c.fit ?? "cover";
      const keyed = (c.filters || []).some((f: any) => (typeof f === "string" ? f : f?.type) === "chromakey");
      this.opaque = this.type !== "lottie" && !this.asset?.alpha && !keyed && ["cover", "fill", "blur"].includes(fit);
      if (c.keyframes?.speed) this.ramp = c.keyframes.speed;
    }
    if (this.type === "captions") {
      this.words = captionWords(c);
      this.pages = captionPages(this.words, Number(c.max_words ?? 3));
    }
    if (this.type === "color") this.opaque = !c.size && (c.gradient ? (c.gradient.colors || []).every((x: any) => parseColor(x)[3] === 255) : parseColor(c.color ?? "black")[3] === 255);
  }

  /** source seconds since the in-point at clip-local time tl */
  private srcOffset(tl: number) {
    if (this.ramp) {
      if (tl < this.rampT) { this.rampT = 0; this.rampU = 0; }
      this.rampU += A.speedIntegral(this.ramp, tl, 1 / 240) - A.speedIntegral(this.ramp, this.rampT, 1 / 240);
      this.rampT = tl;
      return this.rampU;
    }
    return tl * Number(this.c.speed ?? 1);
  }

  private media(): FrameSource {
    if (!this.src) {
      const c = this.c, a = this.asset!, r = this.r;
      const speed = Number(c.speed ?? 1) || 1;
      const fit = c.fit === "blur" ? "contain" : c.fit ?? "cover";
      this.src = new FrameSource({
        path: r.path(a.path), kind: a.kind, srcW: a.width!, srcH: a.height!, srcFps: a.fps,
        srcIn: parseTime(c.in ?? 0), segLen: this.dur * speed,
        rate: this.ramp ? (a.fps || r.fps) : r.fps / speed,
        fit, box: [this.box[0] * this.q, this.box[1] * this.q], focus: c.focus, crop: c.crop, filters: c.filters,
        loop: !!c.loop, srcDuration: a.duration, reverse: !!c.reverse, freeze: !!c.freeze,
      });
    }
    return this.src;
  }

  textStyle(): TextStyle {
    if (!this.style) {
      this.style = new TextStyle(this.c, this.r.k, Math.min(this.r.W0, this.r.H0));
    }
    return this.style;
  }

  async frame(tl: number, m: A.Mods): Promise<Frame | null> {
    const c = this.c, r = this.r;
    switch (this.type) {
      case "video": case "image": {
        const s = this.media();
        const buf = await s.readAt(this.srcOffset(tl));
        if (c.fit !== "blur") return { buf, w: s.w, h: s.h };
        return this.blurFill(buf, s.w, s.h);
      }
      case "lottie": {
        this.lottie ??= LottieAnimation.loadFromFile(r.path(this.asset!.path));
        const an = this.lottie;
        const bw = Math.round(this.box[0] * this.q), bh = Math.round(this.box[1] * this.q);
        const cv = (this.canvasBuf ??= createCanvas(bw, bh));
        const ctx = cv.getContext("2d");
        ctx.clearRect(0, 0, bw, bh);
        let t = parseTime(c.in ?? 0) + tl * Number(c.speed ?? 1);
        if (c.loop !== false && an.duration > 0) t %= an.duration; else t = Math.min(t, an.duration - 1e-3);
        an.seekTime(t);
        const s = Math.min(bw / an.width, bh / an.height);
        an.render(ctx as any, { x: (bw - an.width * s) / 2, y: (bh - an.height * s) / 2, width: an.width * s, height: an.height * s });
        return { canvas: cv, w: bw, h: bh };
      }
      case "text": {
        const st = this.textStyle();
        const text = String(c.text ?? "");
        const mw = maxWidthPx(c, r.W0, r.k);
        const n = [...(st.uppercase ? text.toUpperCase() : text)].length;
        const vc = m.chars === null ? null : Math.floor(m.chars * n + 1e-6);
        const nw = text.split(/\s+/).filter(Boolean).length;
        const vw = m.words === null ? null : Math.ceil(m.words * nw - 1e-6);
        const cv = this.cache.getOr(`t${vc}|${vw}`, () => renderText(text, st, mw, { visibleChars: vc, visibleWords: vw }));
        return { canvas: cv, w: cv.width, h: cv.height };
      }
      case "captions": { const cv = this.captionFrame(tl, m); return cv ? { canvas: cv, w: cv.width, h: cv.height } : null; }
      case "shape": { const cv = this.cache.getOr("shape", () => this.drawShape()); return { canvas: cv, w: cv.width, h: cv.height }; }
      case "color": { const cv = this.cache.getOr("color", () => this.drawColor()); return { canvas: cv, w: cv.width, h: cv.height }; }
    }
    return null;
  }

  /** fit "blur": the contained frame + a tiny blurred cover copy that draw() stretches underneath (no full-res temp). */
  private blurFill(buf: Buffer, w: number, h: number): Frame {
    const bw = Math.round(this.box[0] * this.q), bh = Math.round(this.box[1] * this.q);
    const fg = (this.canvasBuf ??= createCanvas(w, h));
    fg.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, w * h * 4), w, h), 0, 0);
    const tw = Math.max(8, Math.round(bw / 16)), th = Math.max(8, Math.round(bh / 16));
    const tiny = (this.tinyBuf ??= createCanvas(tw, th));
    const tc = tiny.getContext("2d");
    const s = Math.max(tw / w, th / h);
    tc.filter = "blur(1.5px)";
    tc.drawImage(fg, (tw - w * s) / 2, (th - h * s) / 2, w * s, h * s);
    tc.filter = "none";
    tc.fillStyle = "rgba(0,0,0,0.18)"; tc.fillRect(0, 0, tw, th);
    return { canvas: fg, w, h, under: { img: tiny, w: bw, h: bh } };
  }

  private captionFrame(tl: number, m: A.Mods): Canvas | null {
    const c = this.c, r = this.r, words = this.words, pages = this.pages;
    if (!words.length) return null;
    let cur = -1;
    for (let pi = 0; pi < pages.length; pi++) {
      const pg = pages[pi];
      const s = words[pg[0]].start, e = words[pg[pg.length - 1]].end;
      const nxt = pi + 1 < pages.length ? words[pages[pi + 1][0]].start : null;
      const hold = nxt !== null ? Math.min(nxt, e + 0.6) : e + 0.3;
      if (s <= tl && tl < Math.max(e, hold)) { cur = pi; break; }
    }
    if (cur < 0) return null;
    const pg = pages[cur];
    let active: number | null = null;
    pg.forEach((wi, j) => { if (words[wi].start <= tl) active = j; });
    const style = c.style ?? "karaoke";
    const st = this.textStyle();
    const mw = maxWidthPx(c, r.W0, r.k, "84%");
    const pageStart = words[pg[0]].start;
    if (style === "word") {
      const j = active ?? 0;
      const w = words[pg[j]];
      const since = tl - w.start;
      if (since < 0.12) m.scale *= 0.8 + 0.2 * A.ease("back_out", since / 0.12);
      return this.cache.getOr(`w${cur}|${j}`, () => renderText(w.text, st, mw, { activeWord: c.highlight_color ? 0 : null, highlightColor: c.highlight_color }));
    }
    if (tl - pageStart < 0.1) m.scale *= 0.92 + 0.08 * A.ease("ease_out", (tl - pageStart) / 0.1);
    const text = pg.map((i) => words[i].text).join(" ");
    if (style === "reveal") { const vis = (active ?? 0) + 1; return this.cache.getOr(`r${cur}|${vis}`, () => renderText(text, st, mw, { visibleWords: vis })); }
    if (style === "line") return this.cache.getOr(`l${cur}`, () => renderText(text, st, mw));
    return this.cache.getOr(`k${cur}|${active}`, () => renderText(text, st, mw, { activeWord: active, highlightColor: c.highlight_color ?? "#FFD60A", highlightBg: c.highlight_bg }));
  }

  private drawShape(): Canvas {
    const c = this.c, r = this.r, k = r.k;
    const size = c.size ?? [200, 200];
    const w = Math.max(1, Math.round(parseLen(size[0], r.W0) * k)), h = Math.max(1, Math.round(parseLen(size[1], r.H0) * k));
    const sw = c.stroke ? Number(c.stroke.width ?? 0) * k : 0;
    const cv = createCanvas(Math.ceil(w + 2 * sw), Math.ceil(h + 2 * sw));
    const ctx = cv.getContext("2d");
    const shape = c.shape ?? "rect";
    if (shape === "arrow") {
      ctx.beginPath();
      const y0 = sw + h * 0.3, y1 = sw + h * 0.7, hx = sw + w * 0.6;
      ctx.moveTo(sw, y0); ctx.lineTo(hx, y0); ctx.lineTo(hx, sw); ctx.lineTo(sw + w, sw + h / 2); ctx.lineTo(hx, sw + h); ctx.lineTo(hx, y1); ctx.lineTo(sw, y1); ctx.closePath();
    } else shapePath(ctx, shape === "line" ? "rect" : shape, sw, sw, w, h, Number(c.radius ?? 0) * k);
    if (c.gradient) ctx.fillStyle = gradient(ctx, c.gradient, cv.width, cv.height);
    else ctx.fillStyle = css(c.fill ?? c.color ?? "white");
    ctx.fill();
    if (sw) { ctx.lineWidth = sw; ctx.strokeStyle = css(c.stroke.color ?? "black"); ctx.stroke(); }
    return cv;
  }

  private drawColor(): Canvas {
    const c = this.c, r = this.r, k = r.k;
    const w = c.size ? Math.round(parseLen(c.size[0], r.W0) * k) : r.W, h = c.size ? Math.round(parseLen(c.size[1], r.H0) * k) : r.H;
    const cv = createCanvas(w, h);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = c.gradient ? gradient(ctx, c.gradient, w, h) : css(c.color ?? "black");
    ctx.fillRect(0, 0, w, h);
    return cv;
  }

  close() { this.src?.close(); this.src = undefined; }
}

function gradient(ctx: SKRSContext2D, g: Dict, w: number, h: number) {
  const ang = (Number(g.angle ?? 90) * Math.PI) / 180;
  const dx = Math.sin(ang), dy = -Math.cos(ang);
  const span = Math.abs((w / 2) * dx) + Math.abs((h / 2) * dy);
  const gr = ctx.createLinearGradient(w / 2 - dx * span, h / 2 - dy * span, w / 2 + dx * span, h / 2 + dy * span);
  const cols: any[] = g.colors ?? ["#000", "#fff"];
  cols.forEach((col, i) => gr.addColorStop(cols.length === 1 ? 0 : i / (cols.length - 1), css(col)));
  return gr;
}

// ------------------------------------------------------------------ compositor
export class Renderer {
  W0: number; H0: number; W: number; H: number; k: number; fps: number; duration: number;
  layers: Layer[] = [];
  canvas: Canvas; ctx: SKRSContext2D; bg: string;
  private layerCanvases = new Map<Layer, Canvas>();
  constructor(public tl: Timeline, public root: string, scale = 1) {
    resolve(tl);
    const st = tl.settings;
    this.W0 = st.width; this.H0 = st.height;
    this.W = even(this.W0 * scale); this.H = even(this.H0 * scale);
    this.k = this.W / this.W0;
    this.fps = Number(st.fps);
    this.bg = css(st.background ?? "#000000");
    this.duration = totalDuration(tl);
    this.canvas = createCanvas(this.W, this.H);
    this.ctx = this.canvas.getContext("2d");
    for (const tr of tl.tracks) {
      if (tr.hidden || (tr.kind ?? "video") === "audio") continue;
      let prev: Layer | null = null;
      for (const c of tr.clips) {
        if (c.enabled === false || c.type === "gap" || !VISUAL_TYPES.has(c.type)) { prev = null; continue; }
        const L = new Layer(this, tr, c);
        if (prev) { L.prev = prev; prev.next = L; }
        this.layers.push(L);
        prev = L;
      }
    }
  }

  path(p: string) { return p; }

  close() { for (const L of this.layers) L.close(); }

  private center(c: Clip, lw: number, lh: number): [number, number] {
    const { W0, H0, k, W, H } = this;
    const pos: string | undefined = c.position;
    const mn = Math.min(W0, H0);
    const mg = parseLen(c.margin, mn, pos ? 0.06 * mn : 0) * k;
    let cx = W / 2, cy = H / 2;
    if (c.type === "captions" && !pos && c.y === undefined) cy = H * (H > W ? 0.7 : 0.84);
    if (pos) {
      if (pos.includes("top")) cy = mg + lh / 2;
      if (pos.includes("bottom")) cy = H - mg - lh / 2;
      if (pos.includes("left")) cx = mg + lw / 2;
      if (pos.includes("right")) cx = W - mg - lw / 2;
    }
    if (c.x !== undefined) cx = parseLen(c.x, W0) * k;
    if (c.y !== undefined) cy = parseLen(c.y, H0) * k;
    return [cx, cy];
  }

  private trans(L: Layer): [string, number, string] | null {
    const spec = normAnim(L.c.transition, 0.5);
    if (!spec || !L.prev) return null;
    const d = Math.min(spec.duration, L.dur, L.prev.dur);
    return d > 0 ? [spec.type, d, spec.ease || "ease_in_out"] : null;
  }

  async frame(t: number, guides = false): Promise<Canvas> {
    const { ctx, W, H } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.filter = "none";
    ctx.fillStyle = this.bg; ctx.fillRect(0, 0, W, H);
    for (const L of this.layers) {
      if (!(L.start - 1e-9 <= t && t < L.end - 1e-9)) { if (t > L.end + 1) L.close(); continue; }
      const c = L.c, tl = t - L.start;
      const m = new A.Mods();
      const kf = c.keyframes || {};
      const P = (p: string, d: number) => (kf[p] ? A.kfValue(kf[p], tl) : Number(c[p] ?? d));
      A.motionMods(c, tl, L.dur, m, W, H);
      A.enterExit(c, tl, L.dur, m, W, H);
      let overlay: ReturnType<typeof A.transitionMods> = null;
      const tr = this.trans(L);
      if (tr && tl < tr[1]) overlay = A.transitionMods(tr[0], A.ease(tr[2], tl / tr[1]), m, null, W, H);
      if (L.next) {
        const tn = this.trans(L.next);
        if (tn && L.next.start - 1e-9 <= t && t < L.next.start + tn[1]) A.transitionMods(tn[0], A.ease(tn[2], (t - L.next.start) / tn[1]), new A.Mods(), m, W, H);
      }
      let opacity = P("opacity", 1) * m.opacity;
      if (opacity <= 0.001) { if (overlay) this.overlay(overlay); continue; }
      const fr = await L.frame(tl, m);
      if (!fr) { if (overlay) this.overlay(overlay); continue; }
      const base = P("scale", 1);
      const bw = fr.under ? fr.under.w : fr.w, bh = fr.under ? fr.under.h : fr.h;
      const sx = base * P("scale_x", 1) * m.scale * m.sx / L.q, sy = base * P("scale_y", 1) * m.scale * m.sy / L.q;
      let [cx, cy] = this.center(c, (bw * base * P("scale_x", 1)) / L.q, (bh * base * P("scale_y", 1)) / L.q);
      if (kf.x) cx = A.kfValue(kf.x, tl) * this.k;
      if (kf.y) cy = A.kfValue(kf.y, tl) * this.k;
      cx += m.dx; cy += m.dy;
      const rot = P("rotation", 0) + m.rotation;
      const blur = P("blur", 0) * this.k + m.blur;
      const blend = c.blend ?? "normal";
      const fx = [...(c.effects || []), ...m.fx.map((f) => ({ type: f.type, intensity: f.p, p: f.p }))];
      const simple = Math.abs(rot) < 1e-3 && Math.abs(sx - 1) < 1e-3 && Math.abs(sy - 1) < 1e-3;
      // fast path: opaque full-canvas frame, nothing fancy -> raw copy
      if (fr.buf && L.opaque && simple && opacity >= 0.999 && blend === "normal" && !m.masks.length && !fx.length && !c.mask
        && !c.radius && !c.shadow && !c.border && blur < 0.5 && fr.w === W && fr.h === H && Math.abs(cx - W / 2) < 0.5 && Math.abs(cy - H / 2) < 0.5) {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(fr.buf.buffer, fr.buf.byteOffset, W * H * 4), W, H), 0, 0);
        if (overlay) this.overlay(overlay);
        continue;
      }
      let img: Canvas;
      if (fr.canvas) img = fr.canvas;
      else {
        let lc = this.layerCanvases.get(L);
        if (!lc || lc.width !== fr.w || lc.height !== fr.h) { lc = createCanvas(fr.w, fr.h); this.layerCanvases.set(L, lc); }
        lc.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(fr.buf!.buffer, fr.buf!.byteOffset, fr.w * fr.h * 4), fr.w, fr.h), 0, 0);
        img = lc;
      }
      const mutable = !!fr.buf || L.type === "video"; // per-frame canvases may be modified in place
      if (fx.length) { const r = applyEffects(img, fx, tl, this.fps, this.k * L.q, 2, mutable); img = r.canvas; opacity *= r.opacity; }
      if (c.mask) img = applyMask(img, c.mask, this.k * L.q, 20);
      this.draw(img, c, cx, cy, sx, sy, rot, opacity, blend, blur, m.masks, L.q, fr.under);
      if (overlay) this.overlay(overlay);
    }
    const gfx = this.tl.settings.effects;
    if (gfx?.length) {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.filter = "none";
      const r = applyEffects(this.canvas, gfx, t, this.fps, this.k, 41, true);
      if (r.opacity < 1) { ctx.fillStyle = this.bg; ctx.fillRect(0, 0, W, H); }
      else if (r.canvas !== this.canvas) ctx.drawImage(r.canvas, 0, 0);
    }
    if (guides) this.guides();
    return this.canvas;
  }

  private overlay([col, a]: [[number, number, number], number]) {
    if (a <= 0.001) return;
    const ctx = this.ctx;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`; ctx.fillRect(0, 0, this.W, this.H);
    ctx.restore();
  }

  private draw(img: Canvas, c: Clip, cx: number, cy: number, sx: number, sy: number, rot: number, opacity: number, blend: string,
    blur: number, masks: any[], q: number, under?: { img: Canvas; w: number; h: number }) {
    const ctx = this.ctx;
    const lw = under ? under.w : img.width, lh = under ? under.h : img.height;
    if (Math.abs(sx) < 1e-4 || Math.abs(sy) < 1e-4) return;
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0, opacity));
    ctx.globalCompositeOperation = (BLEND[blend] ?? "source-over") as any;
    if (masks.length) { // transition masks in canvas space over the layer's bounding box
      const a = (rot * Math.PI) / 180, ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a));
      const bw = lw * Math.abs(sx) * ca + lh * Math.abs(sy) * sa, bh = lw * Math.abs(sx) * sa + lh * Math.abs(sy) * ca;
      const x0 = cx - bw / 2, y0 = cy - bh / 2;
      ctx.beginPath();
      for (const mk of masks) {
        if (mk.kind === "wipe") {
          const p = mk.p;
          if (mk.dir === "left") ctx.rect(x0 + bw * (1 - p), y0, bw * p, bh);
          else if (mk.dir === "right") ctx.rect(x0, y0, bw * p, bh);
          else if (mk.dir === "up") ctx.rect(x0, y0 + bh * (1 - p), bw, bh * p);
          else ctx.rect(x0, y0, bw, bh * p);
        } else if (mk.kind === "circle") ctx.arc(cx, cy, Math.max(0.01, (mk.p * Math.hypot(bw, bh)) / 2), 0, Math.PI * 2);
      }
      ctx.clip();
    }
    ctx.translate(cx, cy);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(sx, sy);
    if (blur > 0.5) ctx.filter = `blur(${(blur / Math.max(1e-3, Math.abs(sx))).toFixed(2)}px)`;
    const radius = c.radius ? Number(c.radius) * this.k * q : 0;
    const sh = c.shadow === true ? {} : c.shadow;
    if (sh) {
      ctx.shadowColor = css(sh.color ?? "#00000099");
      ctx.shadowBlur = Number(sh.blur ?? 30) * this.k;
      ctx.shadowOffsetX = Number(sh.x ?? 0) * this.k; ctx.shadowOffsetY = Number(sh.y ?? 12) * this.k;
      if (radius) { ctx.fillStyle = "#000"; ctx.beginPath(); ctx.roundRect(-lw / 2, -lh / 2, lw, lh, radius); ctx.fill(); ctx.shadowColor = "transparent"; }
    }
    if (radius) { ctx.beginPath(); ctx.roundRect(-lw / 2, -lh / 2, lw, lh, radius); ctx.clip(); }
    if (under) {
      ctx.drawImage(under.img, -lw * 0.55, -lh * 0.55, lw * 1.1, lh * 1.1);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);
    } else ctx.drawImage(img, -lw / 2, -lh / 2);
    ctx.shadowColor = "transparent";
    if (c.border) {
      ctx.filter = "none";
      ctx.lineWidth = Number(c.border.width ?? 4) * this.k * q;
      ctx.strokeStyle = css(c.border.color ?? "white");
      const mk = typeof c.mask === "string" ? { shape: c.mask } : c.mask;
      if (mk && !["linear", "mirror"].includes(mk.shape) && !mk.invert) {
        const mw = Number(mk.width ?? 1) * lw, mh = Number(mk.height ?? 1) * lh;
        shapePath(ctx, mk.shape ?? "rect", -lw / 2 + Number(mk.x ?? 0.5) * lw - mw / 2, -lh / 2 + Number(mk.y ?? 0.5) * lh - mh / 2, mw, mh, Number(mk.radius ?? 0) * this.k * q);
      } else { ctx.beginPath(); ctx.roundRect(-lw / 2, -lh / 2, lw, lh, radius); }
      ctx.stroke();
    }
    ctx.restore();
  }

  private guides() {
    const { ctx, W, H } = this;
    ctx.save();
    ctx.fillStyle = "rgba(255,0,80,0.25)";
    if (H > W) { ctx.fillRect(0, 0, W, H * 0.1); ctx.fillRect(0, H * 0.8, W, H * 0.2); ctx.fillRect(W * 0.86, H * 0.45, W * 0.14, H * 0.35); }
    ctx.strokeStyle = "rgba(0,255,255,0.9)"; ctx.lineWidth = Math.max(1, W / 600);
    ctx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);
    ctx.restore();
  }

  /** RGBA bytes of the current canvas (opaque). */
  pixels(): Buffer {
    const d = this.ctx.getImageData(0, 0, this.W, this.H).data;
    return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
  }
}

export async function renderFrame(tl: Timeline, root: string, t: number, scale = 1, guides = false): Promise<Buffer> {
  const r = new Renderer(tl, root, scale);
  try { const cv = await r.frame(t, guides); return cv.encodeSync("png"); } finally { r.close(); }
}

export async function contactSheet(tl: Timeline, root: string, times: number[], cols = 4, tileW = 360, guides = false): Promise<Buffer> {
  const r = new Renderer(tl, root, Math.min(1, tileW / tl.settings.width));
  const tiles: Canvas[] = [];
  try {
    for (const t of [...times].sort((a, b) => a - b)) {
      const cv = await r.frame(Math.min(t, Math.max(0, r.duration - 1 / r.fps)), guides);
      const tile = createCanvas(r.W, r.H);
      const tc = tile.getContext("2d");
      tc.drawImage(cv, 0, 0);
      const label = `${t.toFixed(2)}s`;
      tc.font = "600 14px Menlo, Consolas, monospace";
      tc.fillStyle = "rgba(0,0,0,0.75)"; tc.fillRect(0, 0, tc.measureText(label).width + 12, 22);
      tc.fillStyle = "#fff"; tc.fillText(label, 6, 16);
      tiles.push(tile);
    }
  } finally { r.close(); }
  if (!tiles.length) throw new EditError("no frames", "empty");
  cols = Math.max(1, Math.min(cols, tiles.length));
  const rows = Math.ceil(tiles.length / cols), gap = 4;
  const sheet = createCanvas(cols * r.W + (cols - 1) * gap, rows * r.H + (rows - 1) * gap);
  const sc = sheet.getContext("2d");
  sc.fillStyle = "#1e1e1e"; sc.fillRect(0, 0, sheet.width, sheet.height);
  tiles.forEach((tile, i) => sc.drawImage(tile, (i % cols) * (r.W + gap), Math.floor(i / cols) * (r.H + gap)));
  return sheet.encodeSync("png");
}
