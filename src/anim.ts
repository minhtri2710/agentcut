// Easing, keyframes and animation presets (enter/exit, transitions, motion).
import { type Clip, normAnim, parseTime } from "./model.ts";
import { own } from "./own.ts";

const backOut = (t: number, s = 1.70158) => { t -= 1; return t * t * ((s + 1) * t + s) + 1; };
function bounceOut(t: number) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
  t -= 2.625 / d; return n * t * t + 0.984375;
}
const elasticOut = (t: number) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1);

export const EASE: Record<string, (t: number) => number> = {
  linear: (t) => t,
  ease_in: (t) => t ** 3,
  ease_out: (t) => 1 - (1 - t) ** 3,
  ease_in_out: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  back_out: backOut, bounce_out: bounceOut, elastic_out: elasticOut,
  hold: (t) => (t < 1 ? 0 : 1),
};
export const ease = (name: string | undefined, t: number) => (own(EASE, name || "linear") ?? EASE.linear)(Math.min(1, Math.max(0, t)));

type KF = [number, number, string | undefined];
const kfCache = new WeakMap<object, KF[]>();
export function parseKfs(kfs: any[]): KF[] {
  let pts = kfCache.get(kfs);
  if (!pts) {
    pts = kfs.map((k): KF => (Array.isArray(k) ? [parseTime(k[0]), Number(k[1]), k[2]] : [parseTime(k.t ?? 0), Number(k.v ?? k.value ?? 0), k.ease]))
      .sort((a, b) => a[0] - b[0]);
    kfCache.set(kfs, pts);
  }
  return pts;
}

export function kfValue(kfs: any[], t: number): number {
  const pts = parseKfs(kfs);
  if (t <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [t0, v0] = pts[i - 1], [t1, v1, e] = pts[i];
    if (t <= t1) return t1 - t0 <= 1e-9 ? v1 : v0 + (v1 - v0) * ease(e || "linear", (t - t0) / (t1 - t0));
  }
  return pts[pts.length - 1][1];
}

/** Integral of a keyframed speed curve from 0..t (source seconds consumed), numerically. */
export function speedIntegral(kfs: any[], t: number, step = 1 / 240): number {
  let acc = 0;
  for (let x = 0; x < t; x += step) acc += kfValue(kfs, Math.min(t, x + step / 2)) * Math.min(step, t - x);
  return acc;
}

/** speedIntegral(kfs, t) for many t at once: one pass over 0..tmax, then O(1) per query (audio.ts samples it at every picture frame of a ramped clip). */
export function speedSampler(kfs: any[], tmax: number, step = 1 / 240): (t: number) => number {
  const cum = [0];
  for (let x = 0; x < tmax; x += step) cum.push(cum[cum.length - 1] + kfValue(kfs, Math.min(tmax, x + step / 2)) * Math.min(step, tmax - x));
  return (t) => {
    const k = Math.min(cum.length - 1, Math.floor(t / step + 1e-9)), x = k * step;
    return cum[k] + (t > x ? kfValue(kfs, Math.min(t, x + step / 2)) * (t - x) : 0);
  };
}

export class Mods {
  opacity = 1; dx = 0; dy = 0; scale = 1; sx = 1; sy = 1; rotation = 0; blur = 0;
  masks: any[] = [];
  chars: number | null = null; words: number | null = null;
  fx: { type: string; p: number }[] = []; // transient transition effects (flash, glitch, zoom_blur)
}

const DEFAULT_EASE: Record<string, string> = { pop: "back_out", drop: "bounce_out", bounce: "elastic_out", typewriter: "linear", words: "linear" };

export function applyAnim(kind: string, p: number, m: Mods, W: number, H: number) {
  const q = 1 - p, mn = Math.min(W, H);
  switch (kind) {
    case "fade": m.opacity *= p; break;
    case "slide_up": m.dy += q * 0.08 * H; m.opacity *= Math.min(1, p * 1.5); break;
    case "slide_down": m.dy -= q * 0.08 * H; m.opacity *= Math.min(1, p * 1.5); break;
    case "slide_left": m.dx += q * 0.1 * W; m.opacity *= Math.min(1, p * 1.5); break;
    case "slide_right": m.dx -= q * 0.1 * W; m.opacity *= Math.min(1, p * 1.5); break;
    case "pop": m.scale *= Math.max(0, 0.3 + 0.7 * p); m.opacity *= Math.min(1, Math.max(0, p) * 3); break;
    case "bounce": m.scale *= Math.max(0, p); break;
    case "zoom_in": m.scale *= 1.3 - 0.3 * p; m.opacity *= p; break;
    case "zoom_out": m.scale *= 0.7 + 0.3 * p; m.opacity *= p; break;
    case "blur": m.blur += q * 0.03 * mn; m.opacity *= p; break;
    case "drop": m.dy -= q * 0.3 * H; m.opacity *= Math.min(1, p * 4); break;
    case "spin": m.rotation -= q * 120; m.scale *= 0.5 + 0.5 * p; m.opacity *= p; break;
    case "flip": m.sx *= Math.max(0.001, Math.abs(Math.cos((q * Math.PI) / 2))); m.opacity *= Math.min(1, p * 2); break;
    case "typewriter": m.chars = p; break;
    case "words": m.words = p; break;
    default:
      if (kind.startsWith("wipe_")) m.masks.push({ kind: "wipe", dir: kind.slice(5), p });
  }
}

export function enterExit(c: Clip, tl: number, D: number, m: Mods, W: number, H: number) {
  for (const key of ["enter", "exit"] as const) {
    const spec = normAnim(c[key], 0.5);
    if (!spec) continue;
    const kind = spec.type;
    let d = spec.duration;
    if ((kind === "typewriter" || kind === "words") && !(typeof c[key] === "object" && "duration" in c[key])) d = Math.min(1.5, D * 0.6);
    d = Math.max(1e-3, Math.min(d, D));
    const e = spec.ease || own(DEFAULT_EASE, kind) || "ease_out";
    if (key === "enter" && tl < d) applyAnim(kind, ease(e, tl / d), m, W, H);
    else if (key === "exit" && tl > D - d) applyAnim(kind, ease(["back_out", "bounce_out", "elastic_out"].includes(e) ? "ease_in_out" : e, (D - tl) / d), m, W, H);
  }
}

/** Modify incoming B and outgoing A at eased progress p. Returns a solid overlay [rgb, alpha] or null. */
export function transitionMods(kind: string, p: number, mB: Mods, mA: Mods | null, W: number, H: number): [[number, number, number], number] | null {
  const q = 1 - p, mn = Math.min(W, H);
  if (kind === "crossfade") mB.opacity *= p;
  else if (kind === "dip_black" || kind === "dip_white") {
    if (p < 0.5) mB.opacity = 0; else if (mA) mA.opacity = 0;
    return [kind === "dip_black" ? [0, 0, 0] : [255, 255, 255], 1 - Math.abs(2 * p - 1)];
  } else if (kind === "flash") {
    if (p < 0.5) mB.opacity = 0; else if (mA) mA.opacity = 0;
    return [[255, 255, 255], Math.max(0, 1 - Math.abs(2 * p - 1) * 1.6)];
  } else if (kind.startsWith("slide_") || kind.startsWith("push_")) {
    const d = kind.split("_")[1];
    const [vx, vy] = ({ left: [W, 0], right: [-W, 0], up: [0, H], down: [0, -H] } as Record<string, number[]>)[d];
    mB.dx += q * vx; mB.dy += q * vy;
    if (kind.startsWith("push_") && mA) { mA.dx -= p * vx; mA.dy -= p * vy; }
  } else if (kind.startsWith("wipe_")) mB.masks.push({ kind: "wipe", dir: kind.slice(5), p });
  else if (kind === "zoom") { mB.scale *= 1.25 - 0.25 * p; mB.opacity *= p; if (mA) mA.scale *= 1 + 0.15 * p; }
  else if (kind === "circle") mB.masks.push({ kind: "circle", p });
  else if (kind === "blur") { mB.blur += q * 0.04 * mn; mB.opacity *= p; if (mA) mA.blur += p * 0.04 * mn; }
  else if (kind === "spin") { mB.rotation += q * 180; mB.scale *= 0.3 + 0.7 * p; mB.opacity *= Math.min(1, p * 2); if (mA) { mA.rotation -= p * 180; mA.scale *= 1 - 0.7 * p; } }
  else if (kind === "glitch") {
    if (p < 0.5) mB.opacity = 0; else if (mA) mA.opacity = 0;
    const amt = 1 - Math.abs(2 * p - 1);
    mB.fx.push({ type: "glitch", p: amt }); mA?.fx.push({ type: "glitch", p: amt });
  } else if (kind === "zoom_blur") {
    mB.opacity *= p; mB.fx.push({ type: "zoom_blur", p: q }); mB.scale *= 1 + 0.2 * q;
    if (mA) { mA.fx.push({ type: "zoom_blur", p }); mA.scale *= 1 + 0.2 * p; }
  }
  return null;
}

export function motionMods(c: Clip, tl: number, D: number, m: Mods, W: number, H: number) {
  let spec: any = c.motion;
  if (!spec) return;
  if (typeof spec === "string") spec = { type: spec };
  const kind = spec.type, a = Number(spec.amount ?? 1);
  const u = D > 0 ? Math.min(1, Math.max(0, tl / D)) : 0;
  const ue = ease("ease_in_out", u);
  switch (kind) {
    case "ken_burns": m.scale *= 1 + 0.12 * a * ue; break;
    case "ken_burns_out": m.scale *= 1 + 0.12 * a * (1 - ue); break;
    case "zoom_slow": m.scale *= 1 + 0.05 * a * u; break;
    case "pan_left": case "pan_right": case "pan_up": case "pan_down": {
      m.scale *= 1 + 0.12 * a;
      const off = 0.05 * a * (1 - 2 * ue);
      if (kind === "pan_left") m.dx += off * W; else if (kind === "pan_right") m.dx -= off * W;
      else if (kind === "pan_up") m.dy += off * H; else m.dy -= off * H;
      break;
    }
    case "pulse": m.scale *= 1 + 0.04 * a * (0.5 - 0.5 * Math.cos(2 * Math.PI * Number(spec.freq ?? 1) * tl)); break;
    case "float": m.dy += 0.012 * H * a * Math.sin(2 * Math.PI * Number(spec.freq ?? 0.4) * tl); break;
    case "sway": m.rotation += 3 * a * Math.sin(2 * Math.PI * Number(spec.freq ?? 0.5) * tl); break;
    case "shake": {
      const amp = 0.008 * Math.min(W, H) * a;
      m.dx += amp * (Math.sin(tl * 37.1) + 0.6 * Math.sin(tl * 71.3 + 1.3));
      m.dy += amp * (Math.sin(tl * 43.7 + 0.7) + 0.6 * Math.sin(tl * 59.9 + 2.1));
      m.rotation += 0.4 * a * Math.sin(tl * 29.3);
    }
  }
}
