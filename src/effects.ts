// CapCut-style effects on Skia canvases + layer masks. All deterministic (seeded by time) so renders are reproducible.
import { type Canvas, createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { type Dict, parseTime } from "./model.ts";

const pool = new Map<string, Canvas[]>();
/** Reusable scratch canvases keyed by size (avoids allocating 8 MB per frame). */
export function scratch(w: number, h: number, slot = 0): Canvas {
  const key = `${w}x${h}`;
  let arr = pool.get(key);
  if (!arr) pool.set(key, (arr = []));
  while (arr.length <= slot) arr.push(createCanvas(w, h));
  const c = arr[slot];
  const ctx = c.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over"; ctx.filter = "none";
  ctx.clearRect(0, 0, w, h);
  return c;
}

function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => ((s = (s ^ (s << 13)) >>> 0, s = (s ^ (s >>> 17)) >>> 0, s = (s ^ (s << 5)) >>> 0) / 4294967296);
}

// Grain = signed noise: random white or black pixels with random alpha, composited source-over
// (5x cheaper than an 'overlay' blend on Skia's raster backend, visually equivalent).
let grainTile: Canvas | null = null;
function grain(): Canvas {
  if (grainTile) return grainTile;
  grainTile = createCanvas(256, 256);
  const ctx = grainTile.getContext("2d");
  const img = ctx.createImageData(256, 256);
  const r = rng(7);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = r() - 0.5, c = v > 0 ? 255 : 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = c; img.data[i + 3] = Math.min(255, Math.abs(v) * 2 * 255) | 0;
  }
  ctx.putImageData(img, 0, 0);
  return grainTile;
}

const vignettes = new Map<string, Canvas>();
function vignette(w: number, h: number, intensity: number): Canvas {
  const key = `${w}x${h}@${intensity.toFixed(3)}`;
  let v = vignettes.get(key);
  if (!v) {
    v = createCanvas(w, h);
    const c = v.getContext("2d");
    const g = c.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) / 2);
    g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(0,0,0,${0.85 * intensity})`);
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    if (vignettes.size > 16) vignettes.clear();
    vignettes.set(key, v);
  }
  return v;
}

let scanTile: Canvas | null = null;
function scanlines(): Canvas {
  if (scanTile) return scanTile;
  scanTile = createCanvas(4, 4);
  const ctx = scanTile.getContext("2d");
  ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(0, 0, 4, 2);
  return scanTile;
}

const CSS_FX: Record<string, (f: Dict) => string> = {
  blur: (f) => `blur(${Number(f.radius ?? 8) * (f._k ?? 1)}px)`,
  bw: () => "grayscale(1)",
  invert: () => "invert(1)",
  hue: (f) => `hue-rotate(${Number(f.degrees ?? 90)}deg)`,
  brightness: (f) => `brightness(${Number(f.amount ?? 1.2)})`,
  contrast: (f) => `contrast(${Number(f.amount ?? 1.2)})`,
  saturate: (f) => `saturate(${Number(f.amount ?? 1.4)})`,
};

function rgbSplit(src: Canvas, amount: number, slot: number): Canvas {
  const w = src.width, h = src.height;
  const out = scratch(w, h, slot), tmp = scratch(w, h, slot + 1);
  const o = out.getContext("2d"), t = tmp.getContext("2d");
  const chans: [string, number, number][] = [["#ff0000", -amount, 0], ["#00ff00", 0, 0], ["#0000ff", amount, amount * 0.3]];
  o.globalCompositeOperation = "lighter";
  for (const [col, dx, dy] of chans) {
    t.globalCompositeOperation = "source-over"; t.clearRect(0, 0, w, h); t.drawImage(src, 0, 0);
    t.globalCompositeOperation = "multiply"; t.fillStyle = col; t.fillRect(0, 0, w, h);
    t.globalCompositeOperation = "destination-in"; t.drawImage(src, 0, 0);
    o.drawImage(tmp, dx, dy);
  }
  return out;
}

/** Window test for effects with optional start/duration (seconds relative to the clip). */
function active(f: Dict, t: number) {
  const s = f.start !== undefined ? parseTime(f.start) : 0;
  const d = f.duration !== undefined && f.type !== "flash" ? parseTime(f.duration) : Infinity; // a flash's duration is its own length, not a window
  return t >= s && t < s + d ? (t - s) : null;
}

/**
 * Apply effects to a layer canvas. Returns the (possibly new) canvas and an opacity multiplier.
 * t = seconds since clip start, k = render scale (px params), slot = scratch namespace.
 */
export function applyEffects(src: Canvas, effects: Dict[], t: number, fps: number, k: number, slot = 2, mutable = false): { canvas: Canvas; opacity: number } {
  let cur = src, opacity = 1;
  const w = src.width, h = src.height;
  const cssParts: string[] = [];
  const post: Dict[] = [];
  for (let f of effects) {
    if (typeof f === "string") f = { type: f };
    const lt = active(f, t);
    if (lt === null) continue;
    if (CSS_FX[f.type]) cssParts.push(CSS_FX[f.type]({ ...f, _k: k }));
    else post.push({ ...f, _lt: lt });
  }
  if (cssParts.length) {
    const out = scratch(w, h, slot++);
    const c = out.getContext("2d");
    c.filter = cssParts.join(" ");
    c.drawImage(cur, 0, 0);
    c.filter = "none";
    cur = out;
  }
  for (const f of post) {
    const I = Number(f.intensity ?? f.p ?? 1);
    switch (f.type) {
      case "rgb_split": cur = rgbSplit(cur, Number(f.amount ?? 12) * k * (f.p ?? 1), slot); slot += 2; break;
      case "glitch": {
        const step = Math.floor(t * fps / 2);
        const r = rng(step + 13);
        if (r() > 0.35 + 0.5 * (1 - I)) { // glitch is intermittent
          const out = scratch(w, h, slot++);
          const c = out.getContext("2d");
          c.drawImage(cur, 0, 0);
          const n = 3 + Math.floor(r() * 6 * I);
          for (let i = 0; i < n; i++) {
            const y = Math.floor(r() * h), bh = Math.max(2, Math.floor(r() * h * 0.08 * I));
            const dx = (r() - 0.5) * w * 0.12 * I;
            c.drawImage(cur, 0, y, w, bh, dx, y, w, bh);
          }
          cur = rgbSplit(out, (6 + 14 * r()) * k * I, slot); slot += 2;
        }
        break;
      }
      case "zoom_blur": {
        const out = scratch(w, h, slot++);
        const c = out.getContext("2d");
        c.drawImage(cur, 0, 0);
        const n = 6;
        for (let i = 1; i <= n; i++) {
          const s = 1 + (0.12 * I * i) / n;
          c.globalAlpha = 0.5 / i;
          c.drawImage(cur, (w - w * s) / 2, (h - h * s) / 2, w * s, h * s);
        }
        c.globalAlpha = 1;
        cur = out;
        break;
      }
      case "flash": {
        const at = parseTime(f.at ?? 0), d = parseTime(f.duration ?? 0.25);
        const lt = f._lt;
        if (lt >= at && lt < at + d) {
          const a = 1 - (lt - at) / d;
          const out = cur === src && mutable ? cur : scratch(w, h, slot++);
          const c = out.getContext("2d");
          if (out !== cur) c.drawImage(cur, 0, 0);
          c.globalCompositeOperation = "source-atop";
          c.fillStyle = `rgba(255,255,255,${a * I})`; c.fillRect(0, 0, w, h);
          cur = out;
        }
        break;
      }
      case "grain": case "vhs": case "vignette": case "letterbox": {
        // overlay-type effects draw straight onto the canvas when it may be modified (no copy)
        const out = cur === src && !mutable ? scratch(w, h, slot++) : cur;
        const c = out.getContext("2d");
        if (out !== cur) c.drawImage(cur, 0, 0);
        c.save();
        c.globalCompositeOperation = "source-atop";
        if (f.type === "grain" || f.type === "vhs") {
          const r = rng(Math.floor(t * fps));
          const pat = c.createPattern(grain(), "repeat")!;
          c.translate(-r() * 256, -r() * 256);
          c.globalAlpha = 0.45 * Number(f.intensity ?? 0.25) * (f.type === "vhs" ? 0.5 : 1);
          c.fillStyle = pat; c.fillRect(0, 0, w + 256, h + 256);
          c.setTransform(1, 0, 0, 1, 0, 0);
        }
        if (f.type === "vhs") {
          c.globalAlpha = 0.6 * I; c.globalCompositeOperation = "source-atop";
          c.fillStyle = c.createPattern(scanlines(), "repeat")!; c.fillRect(0, 0, w, h);
        }
        if (f.type === "vignette") { c.globalAlpha = 1; c.drawImage(vignette(w, h, Number(f.intensity ?? 0.5)), 0, 0); }
        if (f.type === "letterbox") {
          const ratio = Number(f.ratio ?? 2.39), bar = Math.max(0, (h - w / ratio) / 2);
          c.globalAlpha = 1; c.globalCompositeOperation = "source-over"; c.fillStyle = "#000";
          c.fillRect(0, 0, w, bar); c.fillRect(0, h - bar, w, bar);
        }
        c.restore();
        cur = out;
        if (f.type === "vhs") { cur = rgbSplit(cur, 3 * k * I, slot); slot += 2; }
        break;
      }
      case "strobe": {
        const fr = Number(f.freq ?? 8);
        if (Math.sin(2 * Math.PI * fr * t) < 0) opacity = 0;
        break;
      }
    }
  }
  return { canvas: cur, opacity };
}

// ------------------------------------------------------------------ masks (layer space)
function shapePath(ctx: SKRSContext2D, shape: string, x: number, y: number, w: number, h: number, radius = 0) {
  ctx.beginPath();
  const cx = x + w / 2, cy = y + h / 2;
  switch (shape) {
    case "circle": { const r = Math.min(w, h) / 2; ctx.arc(cx, cy, r, 0, Math.PI * 2); break; }
    case "ellipse": ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case "star": {
      const R = Math.min(w, h) / 2, r = R * 0.45;
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r : R; ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
      ctx.closePath(); break;
    }
    case "heart": {
      const s = Math.min(w, h);
      const top = cy - s * 0.3;
      ctx.moveTo(cx, cy + s * 0.45);
      ctx.bezierCurveTo(cx - s * 0.75, cy - s * 0.05, cx - s * 0.35, top - s * 0.45, cx, top);
      ctx.bezierCurveTo(cx + s * 0.35, top - s * 0.45, cx + s * 0.75, cy - s * 0.05, cx, cy + s * 0.45);
      ctx.closePath(); break;
    }
    case "triangle": ctx.moveTo(cx, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath(); break;
    default: ctx.roundRect(x, y, w, h, radius);
  }
}
export { shapePath };

export function applyMask(src: Canvas, mask: Dict | string, k: number, slot = 8): Canvas {
  const m = typeof mask === "string" ? { shape: mask } : mask;
  const w = src.width, h = src.height;
  const out = scratch(w, h, slot);
  const c = out.getContext("2d");
  const feather = Number(m.feather ?? 0) * k;
  const mw = Number(m.width ?? 1) * w, mh = Number(m.height ?? 1) * h;
  const mx = Number(m.x ?? 0.5) * w - mw / 2, my = Number(m.y ?? 0.5) * h - mh / 2;
  if (m.shape === "linear" || m.shape === "mirror") {
    // band: linear keeps one side of a line through (x,y) at `angle`; mirror keeps a band of `height`
    const ang = (Number(m.angle ?? 0) * Math.PI) / 180;
    c.translate(Number(m.x ?? 0.5) * w, Number(m.y ?? 0.5) * h); c.rotate(ang);
    const big = Math.hypot(w, h);
    const f = Math.max(1, feather);
    const g = m.shape === "linear" ? c.createLinearGradient(0, -f / 2, 0, f / 2) : c.createLinearGradient(0, -mh / 2 - f / 2, 0, mh / 2 + f / 2);
    if (m.shape === "linear") { g.addColorStop(0, "#000"); g.addColorStop(1, "rgba(0,0,0,0)"); }
    else { const e = f / (mh + f); g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(e, "#000"); g.addColorStop(1 - e, "#000"); g.addColorStop(1, "rgba(0,0,0,0)"); }
    c.fillStyle = g;
    if (m.shape === "linear") c.fillRect(-big, -big, big * 2, big + f / 2);
    else c.fillRect(-big, -mh / 2 - f / 2, big * 2, mh + f);
    c.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    if (feather > 0) c.filter = `blur(${feather / 2}px)`;
    c.fillStyle = "#000";
    shapePath(c, m.shape ?? "rect", mx, my, mw, mh, Number(m.radius ?? 0) * k);
    c.fill();
    c.filter = "none";
  }
  c.globalCompositeOperation = m.invert ? "source-out" : "source-in";
  c.drawImage(src, 0, 0);
  c.globalCompositeOperation = "source-over";
  return out;
}
