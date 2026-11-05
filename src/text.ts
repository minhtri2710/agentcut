// Text layout + rendering on Skia. Word-level layout so captions can highlight / reveal words.
import * as Skia from "@napi-rs/canvas";
import { type Canvas, createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { setCanvas } from "./canvas.ts";
import { cssFont, type FontSpec, resolveFont } from "./fonts.ts";
import { css, type Dict, parseColor, parseLen } from "./model.ts";

setCanvas(Skia);
export { captionPages, captionWords, type CWord, pageSpans, parseSrt, phrasesToWords } from "./captions.ts";

export class TextStyle {
  font: FontSpec; size: number; fill: string; gradient?: Dict; strokeW: number; strokeC?: string;
  bg?: Dict; shadow?: { color: string; x: number; y: number; blur: number }; glow?: { color: string; blur: number };
  align: "left" | "center" | "right"; lineHeight: number; letterSpacing: number; uppercase: boolean; k: number;
  constructor(c: Dict, k: number, baseMin: number) {
    this.k = k;
    this.font = resolveFont(c.font, c.weight, c.italic);
    this.size = Number(c.font_size ?? Math.round(0.065 * baseMin)) * k;
    this.fill = css(c.color ?? "white");
    this.gradient = c.gradient;
    const st = c.stroke;
    this.strokeW = st ? Number(st.width ?? 0) * k : 0;
    this.strokeC = st ? css(st.color ?? "black") : undefined;
    this.bg = typeof c.background === "string" ? { color: c.background } : c.background ?? undefined;
    const sh = c.shadow === true ? {} : c.shadow;
    if (sh) this.shadow = { color: css(sh.color ?? "#000000aa"), x: Number(sh.x ?? 0) * k, y: Number(sh.y ?? 4) * k, blur: Number(sh.blur ?? 10) * k };
    const gl = typeof c.glow === "string" ? { color: c.glow } : c.glow;
    if (gl) this.glow = { color: css(gl.color ?? "#00e5ff"), blur: Number(gl.blur ?? 24) * k };
    this.align = c.align ?? "center";
    this.lineHeight = Number(c.line_height ?? 1.15);
    this.letterSpacing = Number(c.letter_spacing ?? 0) * k;
    this.uppercase = !!c.uppercase;
  }
  get css() { return cssFont(this.font, this.size); }
}

interface Word { text: string; x: number; w: number; i: number }
interface Line { words: Word[]; w: number }

let mctx: SKRSContext2D | null = null;
function measure(style: TextStyle, s: string) {
  mctx ??= createCanvas(4, 4).getContext("2d");
  mctx.font = style.css;
  return mctx.measureText(s).width + style.letterSpacing * Math.max(0, [...s].length - 1);
}
function metrics(style: TextStyle) {
  mctx ??= createCanvas(4, 4).getContext("2d");
  mctx.font = style.css;
  const m = mctx.measureText("Ágjy");
  const asc = m.fontBoundingBoxAscent || style.size * 0.9, desc = m.fontBoundingBoxDescent || style.size * 0.25;
  return { asc, desc };
}

export function layout(text: string, style: TextStyle, maxWidth: number) {
  const space = measure(style, " ") + style.letterSpacing;
  const lines: Line[] = [];
  let idx = 0;
  for (const para of text.split("\n")) {
    let cur: Word[] = [], curW = 0;
    for (const word of para.split(" ")) {
      if (!word) continue;
      const ww = measure(style, word);
      if (cur.length && curW + space + ww > maxWidth) { lines.push({ words: cur, w: curW }); cur = []; curW = 0; }
      const x = curW + (cur.length ? space : 0);
      cur.push({ text: word, x, w: ww, i: idx++ });
      curW = x + ww;
    }
    lines.push({ words: cur, w: curW });
  }
  const { asc, desc } = metrics(style);
  const lh = (asc + desc) * style.lineHeight;
  return { lines, width: Math.max(1, ...lines.map((l) => l.w)), lh, asc, glyphH: asc + desc, count: idx };
}

export interface TextOpts { visibleChars?: number | null; visibleWords?: number | null; activeWord?: number | null; highlightColor?: string; highlightBg?: string }

export function renderText(text: string, style: TextStyle, maxWidth: number, o: TextOpts = {}): Canvas {
  if (style.uppercase) text = text.toUpperCase();
  const L = layout(text, style, maxWidth);
  const bg = style.bg;
  const bpad = bg ? (bg.padding !== undefined ? Number(bg.padding) * style.k : 0.35 * style.size) : 0;
  const sh = style.shadow, gl = style.glow;
  const fx = Math.max(sh ? Math.abs(sh.x) + Math.abs(sh.y) + sh.blur * 2 : 0, gl ? gl.blur * 2 : 0);
  const margin = Math.ceil(style.strokeW + 2 + bpad + fx + (o.highlightBg ? style.size * 0.25 : 0));
  const textH = L.lh * (L.lines.length - 1) + L.glyphH;
  const W = Math.ceil(L.width + 2 * margin + 2), H = Math.ceil(textH + 2 * margin + 2);
  const cv = createCanvas(W, H);
  const ctx = cv.getContext("2d");
  if (bg) {
    const r = bg.radius !== undefined ? Number(bg.radius) * style.k : 0.2 * style.size;
    ctx.fillStyle = css(bg.color ?? "#000000aa");
    ctx.beginPath();
    ctx.roundRect(margin - bpad, margin - bpad, L.width + 2 * bpad, textH + 2 * bpad, r);
    ctx.fill();
  }
  ctx.font = style.css;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  let fill: any = style.fill;
  if (style.gradient) {
    const g = style.gradient, ang = ((Number(g.angle ?? 90) - 90) * Math.PI) / 180;
    const cx = W / 2, cy = H / 2, rx = (Math.cos(ang) * L.width) / 2, ry = (Math.sin(ang) * textH) / 2;
    const grad = ctx.createLinearGradient(cx - rx, cy - ry, cx + rx, cy + ry);
    const cols: any[] = g.colors ?? ["#ffffff", "#888888"];
    cols.forEach((c, i) => grad.addColorStop(cols.length === 1 ? 0 : i / (cols.length - 1), css(c)));
    fill = grad;
  }
  const hlC = o.highlightColor ? css(o.highlightColor) : null;
  const hlBg = o.highlightBg ? css(o.highlightBg) : null;
  // collect glyph runs once, then draw passes (shadow/glow -> stroke -> fill)
  const runs: { s: string; x: number; y: number; color: any; word: Word }[] = [];
  let charsLeft = o.visibleChars ?? null;
  L.lines.forEach((line, li) => {
    const ox = style.align === "left" ? margin : style.align === "right" ? margin + L.width - line.w : margin + (L.width - line.w) / 2;
    const y = margin + li * L.lh + L.asc;
    for (const w of line.words) {
      if (o.visibleWords != null && w.i >= o.visibleWords) continue;
      let s = w.text;
      if (charsLeft !== null) {
        if (charsLeft <= 0) break;
        const ch = [...w.text];
        s = ch.slice(0, charsLeft).join("");
        charsLeft -= ch.length + 1;
      }
      let color = fill;
      if (o.activeWord != null && w.i === o.activeWord) {
        if (hlBg) {
          const p = 0.12 * style.size;
          ctx.fillStyle = hlBg;
          ctx.beginPath();
          ctx.roundRect(ox + w.x - p * 1.5, y - L.asc - p * 0.6, w.w + p * 3, L.glyphH + p * 1.2, 0.25 * style.size);
          ctx.fill();
        }
        if (hlC) color = hlC;
      }
      runs.push({ s, x: ox + w.x, y, color, word: w });
    }
  });
  const drawRuns = (mode: "fill" | "stroke", colorOverride?: string) => {
    for (const r of runs) {
      if (mode === "fill") ctx.fillStyle = colorOverride ?? r.color; else ctx.strokeStyle = colorOverride ?? style.strokeC!;
      if (style.letterSpacing) {
        let x = r.x;
        for (const ch of r.s) { mode === "fill" ? ctx.fillText(ch, x, r.y) : ctx.strokeText(ch, x, r.y); x += ctx.measureText(ch).width + style.letterSpacing; }
      } else mode === "fill" ? ctx.fillText(r.s, r.x, r.y) : ctx.strokeText(r.s, r.x, r.y);
    }
  };
  ctx.lineWidth = style.strokeW * 2;
  if (gl) {
    ctx.save(); ctx.shadowColor = gl.color; ctx.shadowBlur = gl.blur;
    drawRuns("fill", gl.color); drawRuns("fill", gl.color);
    ctx.restore();
  }
  if (sh) {
    ctx.save(); ctx.shadowColor = sh.color; ctx.shadowBlur = sh.blur; ctx.shadowOffsetX = sh.x; ctx.shadowOffsetY = sh.y;
    if (style.strokeW) drawRuns("stroke"); else drawRuns("fill");
    ctx.restore();
  }
  if (style.strokeW) drawRuns("stroke");
  drawRuns("fill");
  return cv;
}

export const maxWidthPx = (c: Dict, W0: number, k: number, d = "88%") => parseLen(c.max_width ?? d, W0) * k;
export { parseColor };
