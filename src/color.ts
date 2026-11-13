// Colour grading: clip `color` field -> FFmpeg decode-time filters. Imports only own.ts: model.ts uses it for validation.
import { own } from "./own.ts";

export type Grade = Record<string, any>;
type Rgb = [number, number, number];
type Pts = [number, number][];

export const HSL_RANGES: Record<string, string> = { reds: "r", yellows: "y", greens: "g", cyans: "c", blues: "b", magentas: "m", all: "a" };

/** Same shape as the model.ts field tables: [allowed json types, doc]. */
export const GRADE_FIELDS: Record<string, [string[], string]> = {
  look: [["string"], "preset grade as a base (explicit fields override it): cinematic|warm|cool|vintage|bw|vivid|fade|teal_orange|moody|pastel"],
  exposure: [["number"], "stops -3..3 (0)"],
  contrast: [["number"], "0..3 (1)"],
  saturation: [["number"], "0..3 (1; 0 = black & white)"],
  vibrance: [["number"], "-2..2 (0): boosts muted colours more than saturated ones"],
  temperature: [["number"], "-1..1 (0): + warmer (orange), - cooler (blue)"],
  tint: [["number"], "-1..1 (0): + magenta, - green"],
  lift: [["array"], "[r,g,b] -1..1 colour balance of the shadows"],
  gamma: [["array"], "[r,g,b] -1..1 colour balance of the midtones"],
  gain: [["array"], "[r,g,b] -1..1 colour balance of the highlights"],
  curves: [["object"], "{master|r|g|b: [[x,y],...]} 0..1 points, e.g. master [[0,0.05],[0.5,0.55],[1,1]]"],
  hsl: [["object"], "{reds|yellows|greens|cyans|blues|magentas|all: {hue -180..180, saturation -1..1, lightness -1..1}}"],
};

const VINTAGE: Grade = {
  curves: { r: [[0, 0.11], [0.42, 0.51], [1, 0.95]], g: [[0, 0], [0.5, 0.48], [1, 1]], b: [[0, 0.22], [0.49, 0.44], [1, 0.8]] },
  saturation: 0.85,
};
export const LOOKS: Record<string, Grade> = {
  warm: { lift: [0.08, 0.02, -0.08], gamma: [0.05, 0, -0.05], saturation: 1.1 },
  cool: { lift: [-0.06, 0, 0.08], gamma: [-0.04, 0, 0.06] },
  vintage: VINTAGE,
  bw: { saturation: 0, contrast: 1.15 },
  cinematic: { contrast: 1.12, saturation: 0.9, lift: [-0.05, 0, 0.06], gain: [0.06, 0, -0.04] },
  teal_orange: { lift: [-0.1, 0, 0.1], gain: [0.1, 0, -0.1], saturation: 1.15 },
  vivid: { saturation: 1.35, contrast: 1.08 },
  fade: { curves: { master: [[0, 0.08], [1, 0.92]] }, saturation: 0.85 },
  moody: { contrast: 1.15, exposure: -0.15, saturation: 0.75, lift: [0, 0, 0.05], gamma: [0, 0, 0.03] },
  pastel: { saturation: 0.7, curves: { master: [[0, 0.15], [1, 1]] } },
};

const RANGES: Record<string, [number, number]> = {
  exposure: [-3, 3], contrast: [0, 3], saturation: [0, 3], vibrance: [-2, 2], temperature: [-1, 1], tint: [-1, 1],
};
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isRgb = (v: unknown): v is Rgb => Array.isArray(v) && v.length === 3 && v.every((x) => isNum(x) && x >= -1 && x <= 1);
const isPts = (v: unknown): v is Pts => Array.isArray(v) && v.length >= 2 &&
  v.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => isNum(x) && x >= 0 && x <= 1)) &&
  v.every((p, i) => i === 0 || p[0] > v[i - 1][0]);

/** Value checks beyond field names/types (model.ts checks those). Returns [field path suffix, message]. */
export function gradeIssues(g: Grade): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, [lo, hi]] of Object.entries(RANGES))
    if (k in g && !(isNum(g[k]) && g[k] >= lo && g[k] <= hi)) out.push([k, `${k} must be a number ${lo}..${hi}`]);
  for (const k of ["lift", "gamma", "gain"]) if (k in g && !isRgb(g[k])) out.push([k, `${k} must be [r, g, b] with each -1..1`]);
  if (g.curves && typeof g.curves === "object") for (const [ch, pts] of Object.entries(g.curves)) {
    if (!["master", "r", "g", "b"].includes(ch)) out.push([`curves.${ch}`, `unknown curve '${ch}' (master, r, g, b)`]);
    else if (!isPts(pts)) out.push([`curves.${ch}`, "curve must be >= 2 [x, y] points in 0..1 with increasing x"]);
  }
  if (g.hsl && typeof g.hsl === "object") for (const [range, adj] of Object.entries<any>(g.hsl)) {
    if (!own(HSL_RANGES, range)) { out.push([`hsl.${range}`, `unknown colour range '${range}' (${Object.keys(HSL_RANGES).join(", ")})`]); continue; }
    if (!adj || typeof adj !== "object") { out.push([`hsl.${range}`, "expected {hue, saturation, lightness}"]); continue; }
    for (const [k, v] of Object.entries(adj)) {
      const lim = k === "hue" ? 180 : 1;
      if (!["hue", "saturation", "lightness"].includes(k)) out.push([`hsl.${range}.${k}`, `unknown hsl field '${k}' (hue, saturation, lightness)`]);
      else if (!(isNum(v) && Math.abs(v) <= lim)) out.push([`hsl.${range}.${k}`, `${k} must be a number -${lim}..${lim}`]);
    }
  }
  return out;
}

const f3 = (x: number) => +x.toFixed(4);
const pts = (p: Pts) => `'${p.map(([x, y]) => `${f3(x)}/${f3(y)}`).join(" ")}'`;
const nz = (v: Rgb | undefined) => !!v && v.some((x) => x !== 0);

/** Grade -> FFmpeg filters, in grading order: exposure, white balance, lift/gamma/gain, curves, contrast/saturation, hsl, vibrance. */
export function gradeChain(color: Grade | undefined): string[] {
  if (!color || typeof color !== "object") return [];
  const g: Grade = { ...(own(LOOKS, color.look) ?? {}), ...color };
  const out: string[] = [];
  if (g.exposure) out.push(`exposure=exposure=${f3(g.exposure)}`);
  // ponytail: temperature is a fixed Kelvin mapping (+1 ~ 3500 K, -1 ~ 12000 K) via colortemperature with lightness kept
  if (g.temperature) out.push(`colortemperature=temperature=${Math.round(6500 * 2 ** (-0.9 * g.temperature))}:pl=1`);
  const t = Number(g.tint ?? 0) * 0.15, lift: Rgb = g.lift ?? [0, 0, 0], gain: Rgb = g.gain ?? [0, 0, 0];
  const gam: Rgb = [(g.gamma?.[0] ?? 0) + t, (g.gamma?.[1] ?? 0) - t, (g.gamma?.[2] ?? 0) + t];
  if (nz(lift) || nz(gam) || nz(gain)) {
    // tint is added on top of gamma, so the sum can leave colorbalance's -1..1 (ffmpeg refuses the filter)
    const kv = (p: string, v: Rgb) => ["r", "g", "b"].map((c, i) => (v[i] ? `${c}${p}=${f3(Math.max(-1, Math.min(1, v[i])))}` : "")).filter(Boolean);
    out.push("colorbalance=" + [...kv("s", lift), ...kv("m", gam), ...kv("h", gain)].join(":"));
  }
  if (g.curves) {
    const names: Record<string, string> = { master: "master", r: "red", g: "green", b: "blue" };
    const parts = Object.entries<Pts>(g.curves).map(([ch, p]) => `${names[ch]}=${pts(p)}`);
    if (parts.length) out.push("curves=" + parts.join(":"));
  }
  const eq = [["contrast", g.contrast], ["saturation", g.saturation]].filter(([, v]) => v !== undefined && v !== 1);
  if (eq.length) out.push("eq=" + eq.map(([k, v]) => `${k}=${f3(v)}`).join(":"));
  for (const [range, adj] of Object.entries<any>(g.hsl ?? {})) {
    const p = [`colors=${own(HSL_RANGES, range)}`];
    if (adj.hue) p.push(`hue=${f3(adj.hue)}`);
    if (adj.saturation) p.push(`saturation=${f3(adj.saturation)}`);
    if (adj.lightness) p.push(`intensity=${f3(adj.lightness)}`);
    if (p.length > 1) out.push("huesaturation=" + p.join(":"));
  }
  if (g.vibrance) out.push(`vibrance=intensity=${f3(g.vibrance)}`);
  return out;
}
