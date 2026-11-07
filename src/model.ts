// Timeline data model: schema tables, parsing, validation, magnetic resolution.
// Pure functions only (file existence checks are optional) so they are cheap to call often.
import { AUDIO_FX_DOC, audioFxIssues, PER_CLIP_KEYS } from "./audiofx.ts";
import { GRADE_FIELDS, gradeIssues, LOOKS } from "./color.ts";

export const SCHEMA_VERSION = 1;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Dict = Record<string, any>;
export interface Clip extends Dict { id: string; type: string; start?: number | string; duration: number | string }
export interface Track extends Dict { id: string; kind?: "video" | "audio"; magnetic?: boolean; clips: Clip[] }
export interface Asset extends Dict { path: string; kind: "video" | "image" | "audio" | "lottie"; duration?: number; width?: number; height?: number }
export interface Timeline { version: number; revision: number; name: string; settings: Dict; assets: Record<string, Asset>; tracks: Track[]; markers: Dict[]; meta?: Dict }
export interface Issue { level: "error" | "warning" | "info"; path: string; message: string; hint?: string }

export const PRESETS: Record<string, [number, number]> = {
  reels: [1080, 1920], tiktok: [1080, 1920], shorts: [1080, 1920], story: [1080, 1920],
  youtube: [1920, 1080], landscape: [1920, 1080], "720p": [1280, 720], "4k": [3840, 2160],
  square: [1080, 1080], portrait: [1080, 1350],
};

export const CLIP_TYPES = ["video", "image", "text", "captions", "shape", "color", "audio", "lottie", "compound", "gap"];
export const VISUAL_TYPES = new Set(["video", "image", "text", "captions", "shape", "color", "lottie", "compound"]);
export const MEDIA_TYPES = new Set(["video", "image", "audio", "lottie"]);
export const ENTER_EXIT = ["fade", "slide_up", "slide_down", "slide_left", "slide_right", "pop", "zoom_in", "zoom_out",
  "wipe_left", "wipe_right", "wipe_up", "wipe_down", "blur", "drop", "spin", "typewriter", "words", "bounce", "flip"];
export const TRANSITIONS = ["crossfade", "dip_black", "dip_white", "slide_left", "slide_right", "slide_up", "slide_down",
  "push_left", "push_right", "push_up", "push_down", "wipe_left", "wipe_right", "wipe_up", "wipe_down", "zoom", "circle",
  "blur", "flash", "glitch", "spin", "zoom_blur"];
export const MOTIONS = ["ken_burns", "ken_burns_out", "pan_left", "pan_right", "pan_up", "pan_down", "pulse", "float",
  "shake", "zoom_slow", "sway"];
export const EASINGS = ["linear", "ease_in", "ease_out", "ease_in_out", "back_out", "bounce_out", "elastic_out", "hold"];
export const FITS = ["cover", "contain", "fill", "none", "blur"];
export const BLENDS = ["normal", "multiply", "screen", "add", "overlay", "darken", "lighten", "color_dodge", "soft_light", "difference"];
export const POSITIONS = ["center", "top", "bottom", "left", "right", "top_left", "top_right", "bottom_left", "bottom_right"];
export const CAPTION_STYLES = ["karaoke", "word", "reveal", "line"];
export const SHAPES = ["rect", "circle", "ellipse", "line", "triangle", "star", "heart", "arrow"];
export const MASKS = ["rect", "circle", "ellipse", "linear", "mirror", "heart", "star"];
export const EFFECTS: Record<string, string> = {
  glitch: "digital glitch slices + colour split; intensity 0..1",
  rgb_split: "chromatic aberration; amount px (default 12)",
  flash: "white flash; at (s, default 0), duration (0.25)",
  grain: "film grain; intensity 0..1 (0.25)",
  zoom_blur: "radial zoom blur; intensity 0..1",
  vignette: "dark edges; intensity 0..1 (0.5)",
  vhs: "scanlines + colour bleed + wobble; intensity 0..1",
  letterbox: "cinematic bars; ratio (2.39)",
  strobe: "on/off blink; freq Hz (8)",
  blur: "gaussian blur; radius px",
  bw: "black & white",
  invert: "invert colours",
  hue: "hue rotate; degrees",
  brightness: "multiplier (1.2)",
  contrast: "multiplier (1.2)",
  saturate: "multiplier (1.4)",
};
type FilterField = { kind: "number"; lo: number; hi: number; def: number } | { kind: "color"; def: string } | { kind: "path" };
const fnum = (lo: number, hi: number, def: number): FilterField => ({ kind: "number", lo, hi, def });
/** One source of truth for the clip filters: each parameter's kind, range and default. Validation, the filter graph and the
 *  FILTERS docs all come from it; no project value reaches an FFmpeg graph except through filterParam. */
export const FILTER_SPECS: Record<string, { doc?: string; fields: Record<string, FilterField> }> = {
  eq: { fields: { brightness: fnum(-1, 1, 0), contrast: fnum(0, 3, 1), saturation: fnum(0, 3, 1), gamma: fnum(0.1, 10, 1) } },
  lut: { doc: "path to a .cube 3D LUT file", fields: { path: { kind: "path" } } },
  blur: { fields: { radius: fnum(0, 500, 5) } },
  sharpen: { fields: { amount: fnum(0, 3, 1) } },
  grayscale: { doc: "no params", fields: {} },
  vignette: { fields: { strength: fnum(0, 1, 0.5) } },
  hflip: { doc: "mirror horizontally", fields: {} },
  vflip: { doc: "mirror vertically", fields: {} },
  chromakey: { fields: { color: { kind: "color", def: "#00ff00" }, similarity: fnum(0.01, 1, 0.1), blend: fnum(0, 1, 0.05) } },
  denoise: { fields: { strength: fnum(1, 10, 4) } },
  stabilize: { doc: "deshake (FFmpeg deshake filter)", fields: {} },
};
export const FILTERS: Record<string, string> = Object.fromEntries(Object.entries(FILTER_SPECS).map(([k, s]) => [k, s.doc ?? Object.entries(s.fields)
  .map(([f, x]) => (x.kind === "number" ? `${f} (${x.lo}..${x.hi}, ${x.def})` : `${f} (${x.kind === "color" ? x.def : "path"})`)).join(", ")]));
const filterTable = (type: string): Record<string, [string[], string]> => ({
  type: [["string"], "filter name"],
  ...Object.fromEntries(Object.entries(FILTER_SPECS[type].fields).map(([f, x]) => [f, [[x.kind === "number" ? "number" : "string"], FILTERS[type]]])),
});

/** A filter parameter as the only form that enters an FFmpeg graph: a finite number within its range, or a colour as 0xRRGGBB.
 *  `v` null/undefined gives the default. Throws bad_filter. */
export function filterParam(type: string, key: string, v: unknown): number | string {
  const x = FILTER_SPECS[type]?.fields[key];
  if (!x || x.kind === "path") throw new EditError(`'${type}.${key}' is not a value parameter`, "bad_filter");
  if (x.kind === "number") {
    const n = Number(v ?? x.def);
    if (!Number.isFinite(n) || n < x.lo || n > x.hi) throw new EditError(`${type}.${key} must be a number ${x.lo}..${x.hi}`, "bad_filter", FILTERS[type]);
    return n;
  }
  let c: number[];
  try { c = parseColor(v ?? x.def).slice(0, 3); } catch { throw new EditError(`${type}.${key} must be a colour (#RRGGBB)`, "bad_filter", FILTERS[type]); }
  if (!c.every((q) => Number.isFinite(q) && q >= 0 && q <= 255)) throw new EditError(`${type}.${key} must be a colour (#RRGGBB)`, "bad_filter", FILTERS[type]);
  return "0x" + c.map((q) => Math.round(q).toString(16).padStart(2, "0")).join("");
}
export const ASSET_KINDS = ["video", "image", "audio", "lottie"];
/** The asset record (filled by import_media). Every field some code path reads is typed here; fps, width, height and the rest reach ffmpeg or its helper, so validate checks them. */
export const ASSET_FIELDS: Record<string, [string[], string]> = {
  path: [["string"], "file path"], kind: [["string"], ASSET_KINDS.join("|")],
  duration: [["number"], "seconds, a number >= 0"], width: [["number"], "px, a positive integer"], height: [["number"], "px, a positive integer"],
  fps: [["number"], "a number > 0 (null: a still or unknown)"], has_audio: [["boolean"], "has an audio stream"], alpha: [["boolean"], "has an alpha channel"],
  codec: [["string"], "video codec name"], sample_rate: [["number"], "Hz, a positive integer"], channels: [["number"], "audio channels, a positive integer"],
};
const posInt = [(n: number) => Number.isInteger(n) && n > 0, "a positive integer"] as const;
const ASSET_NUMBERS: Record<string, readonly [(n: number) => boolean, string]> = {
  duration: [(n) => n >= 0, "a number >= 0"], fps: [(n) => n > 0, "a number > 0"], width: posInt, height: posInt, sample_rate: posInt, channels: posInt,
};
// Download size in MB, one source per number; null = not known offline. u2net_human_seg: 175,997,641 B, measured; silueta: 43 MB, rembg 2.0.86 README;
// u2netp: ~4.7 MB, recorded in an earlier dogfood run. u2net and isnet-general-use have no local source.
export const MATTE_MB: Record<string, number | null> = { u2netp: 5, u2net: null, u2net_human_seg: 176, "isnet-general-use": null, silueta: 43 };
export const MATTE_MODELS = Object.keys(MATTE_MB);
export const matteSize = (model: string) => (MATTE_MB[model] == null ? "size unknown" : `~${MATTE_MB[model]} MB`);
export const MATTE_SIZES = MATTE_MODELS.map((m) => `${m} ${matteSize(m)}`).join(", ");
export const ANIMATABLE = ["x", "y", "scale", "scale_x", "scale_y", "rotation", "opacity", "volume", "blur", "speed", "focus_x", "focus_y"];

type F = Record<string, [string[], string]>;
const T = (...t: string[]) => t; // allowed json types: number,string,boolean,object,array,null

export const COMMON_FIELDS: F = {
  id: [T("string"), "unique id (auto-assigned)"],
  type: [T("string"), CLIP_TYPES.join("|")],
  name: [T("string"), "free label"],
  start: [T("number", "string"), "timeline start seconds (computed on magnetic tracks)"],
  duration: [T("number", "string"), "seconds on the timeline"],
  enabled: [T("boolean"), "false hides/mutes the clip"],
  note: [T("string"), "free-form note, ignored by the renderer"],
  group: [T("object"), "{id, name?, track, parent?}: written by expand_compound on every clip and gap it places (parent = the stamp the expanded compound carried); make_compound from=<id> regroups them (split_clip keeps it, duplicate_clip drops it)"],
  preset: [T("string"), "style preset expanded when the clip is added (see capabilities.presets)"],
  until_end: [T("boolean"), "duration follows the end of the rest of the timeline (e.g. music bed, watermark)"],
  attach_to: [T("string"), "connected clip (Final Cut): start = that clip's start + offset, follows it when it moves/retimes"],
  offset: [T("number", "string"), "seconds after the attach_to clip's start (default 0)"],
  match_duration: [T("boolean"), "with attach_to: duration = target duration - offset - end_offset"],
  end_offset: [T("number", "string"), "with match_duration: stop this many seconds before the target ends"],
};
export const VISUAL_FIELDS: F = {
  x: [T("number", "string"), "centre x in px or '50%'"],
  y: [T("number", "string"), "centre y in px or '50%'"],
  position: [T("string"), POSITIONS.join("|") + " (anchor preset, with margin)"],
  margin: [T("number", "string"), "distance from the edge for position presets (px or %)"],
  scale: [T("number"), "uniform scale (1 = fitted size)"],
  scale_x: [T("number"), "extra horizontal scale"], scale_y: [T("number"), "extra vertical scale"],
  rotation: [T("number"), "degrees clockwise"],
  opacity: [T("number"), "0..1"],
  blend: [T("string"), BLENDS.join("|")],
  keyframes: [T("object"), "{prop: [[t, value, easing?], ...]} t relative to clip start; props: " + ANIMATABLE.join(",")],
  enter: [T("string", "object"), "entrance animation: name or {type, duration, ease}: " + ENTER_EXIT.join(",")],
  exit: [T("string", "object"), "exit animation: name or {type, duration, ease}"],
  transition: [T("string", "object"), "transition FROM the previous clip on the same track: " + TRANSITIONS.join(",")],
  motion: [T("string", "object"), "continuous motion: name or {type, amount}: " + MOTIONS.join(",")],
  radius: [T("number"), "rounded corner radius px"],
  shadow: [T("object", "boolean"), "{color, x, y, blur} drop shadow"],
  border: [T("object"), "{color, width} outline around the layer box"],
  mask: [T("object", "string"), "{shape: " + MASKS.join("|") + ", x, y, width, height (0..1 of layer), feather px, invert, angle}"],
  effects: [T("array"), "list of {type, ...params, start?, duration?}: " + Object.keys(EFFECTS).join(",")],
  pending: [T("object"), "{op: args} vision requests (auto_reframe, track_to) waiting for prepare; written by those ops, cleared when prepared"],
};
export const MEDIA_FIELDS: F = {
  asset: [T("string"), "asset id"], src: [T("string"), "file path (auto-imported)"],
  in: [T("number", "string"), "source in-point seconds"],
  speed: [T("number"), "playback speed 0.1..8 (keyframes.speed for ramps)"],
  volume: [T("number"), "linear gain 0..4"], muted: [T("boolean"), "drop audio"],
  fade_in: [T("number"), "audio fade-in s"], fade_out: [T("number"), "audio fade-out s"],
  fit: [T("string"), FITS.join("|") + " (blur = contain over a blurred cover background, CapCut style)"],
  size: [T("array"), "[w, h] box px or % (default canvas)"],
  focus: [T("array"), "[fx, fy] 0..1 crop focus for cover (reframe 16:9 -> 9:16); keyframes.focus_x/focus_y pan it (op auto_reframe)"],
  remove_background: [T("boolean", "object"), `true or {model: ${MATTE_MODELS.join("|")}}: AI alpha matte (cached; needs uv; a model is downloaded only by prepare with allow_download: ${MATTE_SIZES}; see op remove_background)`],
  crop: [T("object"), "{left, right, top, bottom} fractions removed"],
  filters: [T("array"), "FFmpeg filters applied at decode: " + Object.keys(FILTERS).join(",")],
  color: [T("object"), "colour grade (decode-time, after filters): {look, exposure, contrast, saturation, vibrance, temperature, tint, lift, gamma, gain, curves, hsl}"],
  loop: [T("boolean"), "loop the source when the clip is longer"],
  reverse: [T("boolean"), "play backwards (video+audio)"],
  freeze: [T("boolean"), "hold the frame at 'in' for the whole clip"],
};
/** Audio processing on video/audio clips and on tracks (see audiofx.ts). */
export const AUDIO_FX_FIELDS: F = {
  denoise: [T("boolean", "number"), AUDIO_FX_DOC.denoise], eq: [T("string", "array", "object"), AUDIO_FX_DOC.eq],
  compressor: [T("string", "object"), AUDIO_FX_DOC.compressor], pan: [T("number"), AUDIO_FX_DOC.pan],
  pitch: [T("number"), AUDIO_FX_DOC.pitch], normalize: [T("boolean", "number"), AUDIO_FX_DOC.normalize],
};
export const TEXT_FIELDS: F = {
  text: [T("string"), "the text; \\n for line breaks; emoji ok"],
  font: [T("string"), "family + style e.g. 'Arial Bold', 'Avenir Next Heavy' or a .ttf/.otf path (see fonts)"],
  font_size: [T("number"), "px (default 6.5% of the short side)"],
  color: [T("string"), "fill colour"],
  gradient: [T("object"), "{colors: [...], angle} gradient text fill"],
  stroke: [T("object"), "{color, width}"],
  glow: [T("object", "string"), "{color, blur} neon glow"],
  background: [T("object", "string"), "box behind text: colour or {color, padding, radius}"],
  align: [T("string"), "left|center|right"],
  max_width: [T("number", "string"), "wrap width px or % (default 88%)"],
  line_height: [T("number"), "multiplier (1.15)"],
  uppercase: [T("boolean"), "force upper case"],
  letter_spacing: [T("number"), "extra px between characters"],
  italic: [T("boolean"), "italic style"],
  weight: [T("number", "string"), "100..900 or bold/black"],
};
export const CAPTION_FIELDS: F = {
  words: [T("array"), "[{text, start, end}] seconds relative to clip start"],
  srt: [T("string"), "path to .srt/.vtt"],
  style: [T("string"), CAPTION_STYLES.join("|")],
  max_words: [T("number"), "words per page (3)"],
  highlight_color: [T("string"), "active word colour"],
  highlight_bg: [T("string"), "pill behind the active word"],
};
export const SHAPE_FIELDS: F = {
  shape: [T("string"), SHAPES.join("|")], size: [T("array"), "[w, h] px or %"], fill: [T("string"), "fill colour"],
  stroke: [T("object"), "{color, width}"], gradient: [T("object"), "{colors, angle} gradient fill"],
};
export const COLOR_FIELDS: F = {
  color: [T("string"), "solid colour"], gradient: [T("object"), "{colors: [...], angle}"], size: [T("array"), "[w, h]"],
};
export const LOTTIE_FIELDS: F = {
  asset: [T("string"), "lottie asset id"], src: [T("string"), "path to a Lottie .json"],
  size: [T("array"), "[w, h] box"], speed: [T("number"), "playback speed"], loop: [T("boolean"), "loop (default true)"],
  in: [T("number", "string"), "start offset seconds"],
};
export const COMPOUND_FIELDS: F = {
  tracks: [T("array"), "nested tracks (same format as timeline tracks, shared assets; clip ids unique project-wide)"],
  in: [T("number", "string"), "seconds into the nested timeline (default 0)"],
  speed: [T("number"), "playback speed of the nested timeline (nested audio is only mixed at speed 1)"],
  volume: [T("number"), "gain applied to all nested audio"], muted: [T("boolean"), "drop nested audio"],
};

export function fieldsFor(t: string): F {
  const f: F = { ...COMMON_FIELDS };
  if (VISUAL_TYPES.has(t)) Object.assign(f, VISUAL_FIELDS);
  if (t === "video" || t === "image" || t === "audio") Object.assign(f, MEDIA_FIELDS);
  if (t === "video" || t === "audio") Object.assign(f, AUDIO_FX_FIELDS);
  if (t === "audio") {
    for (const k of ["fit", "size", "focus", "crop", "filters", "color", "freeze", "remove_background"]) delete f[k];
    f.keyframes = [T("object"), "{volume: [[t, gain]], speed: [[t, s]]}"];
  }
  if (t === "image") for (const k of ["in", "speed", "volume", "muted", "fade_in", "fade_out", "loop", "reverse", "freeze"]) delete f[k];
  if (t === "text" || t === "captions") Object.assign(f, TEXT_FIELDS);
  if (t === "captions") Object.assign(f, CAPTION_FIELDS);
  if (t === "shape") Object.assign(f, SHAPE_FIELDS);
  if (t === "color") Object.assign(f, COLOR_FIELDS);
  if (t === "lottie") Object.assign(f, LOTTIE_FIELDS);
  if (t === "compound") Object.assign(f, COMPOUND_FIELDS);
  return f;
}

export const TRACK_FIELDS: F = {
  id: [T("string"), "unique track id"], kind: [T("string"), "video|audio (audio tracks are not drawn)"],
  name: [T("string"), "label"],
  magnetic: [T("boolean"), "clips play back-to-back in list order; starts are computed (Final Cut primary storyline)"],
  role: [T("string"), "dialogue|voice|music|sfx|titles|other (ducking/mixing)"],
  duck: [T("number"), "dB to lower this track while voice/dialogue plays (e.g. -20)"],
  volume: [T("number"), "track gain"], muted: [T("boolean"), "mute"], hidden: [T("boolean"), "do not draw"],
  clips: [T("array"), "clips (later ones draw on top within the track)"],
  ...Object.fromEntries(Object.entries(AUDIO_FX_FIELDS).map(([k, [t, d]]) => [k, [t, `${d} (${(PER_CLIP_KEYS as readonly string[]).includes(k) ? "applied to each clip without its own" : "applied to the track mix"})`]])),
};
export const SETTINGS_FIELDS: F = {
  width: [T("number"), "canvas width px"], height: [T("number"), "canvas height px"], fps: [T("number"), "frames per second"],
  background: [T("string"), "canvas colour"], duration: [T("number", "null"), "force total duration"],
  loudness: [T("number", "null"), "target LUFS (default -14, null = off)"], sample_rate: [T("number"), "48000"],
  effects: [T("array"), "whole-frame effects, times relative to the timeline: " + Object.keys(EFFECTS).join(",")],
};

// ------------------------------------------------------------------ errors
export class EditError extends Error {
  constructor(message: string, public code = "invalid", public hint?: string, public path?: string, public details?: Dict) { super(message); }
  toJSON() {
    const d: Dict = { code: this.code, message: this.message };
    if (this.hint) d.hint = this.hint;
    if (this.path) d.path = this.path;
    if (this.details) Object.assign(d, this.details);
    return d;
  }
}

export function suggest(word: unknown, options: Iterable<string>): string | undefined {
  const w = String(word ?? "").toLowerCase();
  let best: string | undefined, bestScore = 0;
  for (const o of options) {
    const s = similarity(w, o.toLowerCase());
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return bestScore >= 0.55 ? best : undefined;
}
export function similarity(a: string, b: string) { // Ratcliff/Obershelp-like via LCS of bigrams + prefix bonus
  if (a === b) return 1;
  if (!a || !b) return 0;
  const bg = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = bg(a), B = bg(b); let inter = 0;
  for (const [g, n] of A) inter += Math.min(n, B.get(g) || 0);
  const dice = (2 * inter) / Math.max(1, a.length - 1 + b.length - 1);
  return b.startsWith(a) || a.startsWith(b) ? Math.max(dice, 0.7) : dice;
}

// ------------------------------------------------------------------ parsing
const TIME_RE = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/;
export function parseTime(v: unknown, field = "time"): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    let n = NaN;
    if (s.endsWith("ms")) n = parseFloat(s) / 1000;
    else if (s.endsWith("s")) n = parseFloat(s);
    else { const m = TIME_RE.exec(s); n = m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] : Number(s); }
    if (Number.isFinite(n)) return n;
  }
  throw new EditError(`${field}: cannot parse time ${JSON.stringify(v)}`, "bad_time", "use seconds (2.5), '2.5s', '1500ms' or 'mm:ss.ms'");
}

export function parseLen(v: unknown, ref: number, dflt?: number): number {
  if (v === undefined || v === null) {
    if (dflt === undefined) throw new EditError("missing length", "bad_length");
    return dflt;
  }
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (s.endsWith("%")) return (parseFloat(s) / 100) * ref;
  const n = parseFloat(s.replace(/px$/, ""));
  if (Number.isFinite(n)) return n;
  throw new EditError(`cannot parse length ${JSON.stringify(v)}`, "bad_length", "use px (120) or percent ('10%')");
}

const NAMED: Record<string, string> = {
  white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", lime: "#00ff00", blue: "#0000ff", yellow: "#ffff00",
  orange: "#ffa500", purple: "#800080", pink: "#ffc0cb", gray: "#808080", grey: "#808080", cyan: "#00ffff", magenta: "#ff00ff",
  navy: "#000080", teal: "#008080", gold: "#ffd700", silver: "#c0c0c0", brown: "#a52a2a", transparent: "#00000000",
};
/** -> [r,g,b,a] 0..255 */
export function parseColor(v: unknown, dflt: [number, number, number, number] = [255, 255, 255, 255]): [number, number, number, number] {
  if (v === undefined || v === null) return dflt;
  if (Array.isArray(v)) return [v[0] | 0, v[1] | 0, v[2] | 0, v.length > 3 ? v[3] | 0 : 255];
  let s = String(v).trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
      return [n(0), n(2), n(4), h.length === 8 ? n(6) : 255];
    }
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    return [p[0], p[1], p[2], p.length > 3 ? Math.round((p[3] <= 1 ? p[3] * 255 : p[3])) : 255];
  }
  throw new EditError(`unknown colour ${JSON.stringify(v)}`, "bad_color", "use #RRGGBB, #RRGGBBAA, rgba(r,g,b,a) or a basic name like 'white'");
}
export const css = (v: unknown, d?: [number, number, number, number]) => { const [r, g, b, a] = parseColor(v, d); return `rgba(${r},${g},${b},${(a / 255).toFixed(4)})`; };

export interface Anim { type: string; duration: number; ease?: string; [k: string]: any }
export function normAnim(v: unknown, dflt: number): Anim | null {
  if (v === undefined || v === null || v === false || v === "none" || v === "") return null;
  if (typeof v === "string") return { type: v, duration: dflt };
  if (typeof v === "object") {
    const d: any = { ...(v as Dict) };
    d.duration = parseTime(d.duration ?? dflt, "duration");
    return d;
  }
  throw new EditError(`bad animation spec ${JSON.stringify(v)}`, "bad_anim");
}

// ------------------------------------------------------------------ timeline helpers
export function newTimeline(width = 1920, height = 1080, fps = 30, name = "untitled"): Timeline {
  return {
    version: SCHEMA_VERSION, revision: 0, name,
    settings: { width, height, fps, background: "#000000", duration: null, loudness: -14, sample_rate: 48000 },
    assets: {},
    tracks: [
      { id: "main", kind: "video", magnetic: true, clips: [] },
      { id: "overlay", kind: "video", clips: [] },
      { id: "text", kind: "video", role: "titles", clips: [] },
      { id: "voice", kind: "audio", role: "voice", clips: [] },
      { id: "music", kind: "audio", role: "music", duck: -20, clips: [] },
    ],
    markers: [],
  };
}

export function* iterClips(tl: Timeline): Generator<[Track, number, number, Clip]> {
  for (let ti = 0; ti < tl.tracks.length; ti++) {
    const tr = tl.tracks[ti];
    for (let ci = 0; ci < (tr.clips || []).length; ci++) yield [tr, ti, ci, tr.clips[ci]];
  }
}

/** Every clip, including clips nested inside compound clips (depth-first). */
export function* allClips(tracks: Track[]): Generator<Clip> {
  for (const tr of tracks) for (const c of tr.clips || []) { yield c; if (c.type === "compound" && Array.isArray(c.tracks)) yield* allClips(c.tracks); }
}

/** The nested timeline of a compound clip (shares settings/assets with the parent). */
export const subTimeline = (tl: Timeline, c: Clip): Timeline =>
  ({ version: tl.version, revision: tl.revision, name: c.name ?? c.id, settings: { ...tl.settings, duration: null }, assets: tl.assets, tracks: c.tracks ?? [], markers: [] });

export function findClip(tl: Timeline, id: string): [Track, number, Clip] {
  for (const [tr, , ci, c] of iterClips(tl)) if (c.id === id) return [tr, ci, c];
  for (const [, , , c] of iterClips(tl)) if (c.type === "compound" && [...allClips(c.tracks ?? [])].some((x) => x.id === id))
    throw new EditError(`clip '${id}' is inside compound clip '${c.id}'`, "nested", `edit the compound as a whole, or expand_compound id=${c.id} first`);
  const ids = [...iterClips(tl)].map((x) => x[3].id);
  const s = suggest(id, ids);
  throw new EditError(`clip '${id}' not found`, "not_found", s ? `did you mean '${s}'?` : `existing clips: ${ids.slice(0, 30).join(", ") || "(none)"}`);
}

export function findTrack(tl: Timeline, id: string): Track {
  const t = tl.tracks.find((x) => x.id === id);
  if (t) return t;
  const ids = tl.tracks.map((x) => x.id);
  const s = suggest(id, ids);
  throw new EditError(`track '${id}' not found`, "not_found", `${s ? `did you mean '${s}'? ` : ""}tracks: ${ids.join(", ")}; create one with add_track`);
}

export function newId(tl: Timeline, prefix: string): string {
  const used = new Set<string>([...tl.tracks.map((t) => t.id), ...Object.keys(tl.assets)]);
  for (const c of allClips(tl.tracks)) used.add(c.id);
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export const clipStart = (c: Clip) => parseTime(c.start ?? 0);
export const clipDur = (c: Clip) => parseTime(c.duration ?? 0);
export const clipEnd = (c: Clip) => clipStart(c) + clipDur(c);
export const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export function resolve(tl: Timeline): Timeline {
  for (const [, , , c] of iterClips(tl)) if (c.type === "compound" && Array.isArray(c.tracks)) resolve(subTimeline(tl, c));
  resolveMagnetic(tl);
  resolveAttached(tl);
  // until_end clips stretch to the end of everything else
  let end = 0, any = false;
  for (const [, , , c] of iterClips(tl)) { if (c.until_end) any = true; else if (c.enabled !== false) end = Math.max(end, clipEnd(c)); }
  if (any) {
    for (const [, , , c] of iterClips(tl)) if (c.until_end) c.duration = round6(Math.max(0.1, end - clipStart(c)));
    resolveMagnetic(tl);
    resolveAttached(tl);
  }
  return tl;
}

function resolveAttached(tl: Timeline) {
  const byId = new Map<string, Clip>();
  for (const [, , , c] of iterClips(tl)) byId.set(c.id, c);
  for (let pass = 0; pass < 3; pass++) { // allows short chains (A attached to B attached to C)
    for (const [, , , c] of iterClips(tl)) {
      if (!c.attach_to) continue;
      const t = byId.get(c.attach_to);
      if (!t || t === c) continue;
      const off = parseTime(c.offset ?? 0);
      c.start = round6(Math.max(0, clipStart(t) + off));
      if (c.match_duration) c.duration = round6(Math.max(0.1, clipDur(t) - off - parseTime(c.end_offset ?? 0)));
    }
  }
  for (const tr of tl.tracks) if (!tr.magnetic && tr.clips.some((c) => c.attach_to)) tr.clips.sort((a, b) => clipStart(a) - clipStart(b));
}

function resolveMagnetic(tl: Timeline) {
  for (const tr of tl.tracks) {
    if (!tr.magnetic) continue;
    let t = 0;
    tr.clips.forEach((c, i) => {
      const dur = clipDur(c);
      let td = 0;
      const spec = i > 0 ? normAnim(c.transition, 0.5) : null;
      if (spec) td = Math.min(spec.duration, dur, clipDur(tr.clips[i - 1]));
      const start = Math.max(0, t - td);
      c.start = round6(start);
      t = start + dur;
    });
  }
}

export function totalDuration(tl: Timeline): number {
  if (tl.settings?.duration) return parseTime(tl.settings.duration);
  let end = 0;
  for (const [, , , c] of iterClips(tl)) if (c.enabled !== false) end = Math.max(end, clipEnd(c));
  return round6(end);
}

// ------------------------------------------------------------------ validation
const jtype = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function checkFields(obj: Dict, fields: F, path: string, issues: Issue[], what: string) {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("_")) continue; // private/comment keys
    const spec = fields[k];
    if (!spec) {
      const s = suggest(k, Object.keys(fields));
      issues.push({ level: "error", path: `${path}.${k}`, message: `unknown ${what} field '${k}'`, hint: s ? `did you mean '${s}'?` : `allowed: ${Object.keys(fields).join(", ")}` });
      continue;
    }
    const t = jtype(v);
    if (v !== null && !spec[0].includes(t)) issues.push({ level: "error", path: `${path}.${k}`, message: `'${k}' is ${t}, expected ${spec[0].join("/")}` });
  }
}

/** group stamp {id, name?, track, parent?}: id and track are non-empty strings, name a string; parent is a stamp too (recursively) */
function groupIssues(g: any, path: string): { path: string; message: string; hint: string }[] {
  const hint = "group: {id, name?, track, parent?}";
  if (!g || typeof g !== "object" || Array.isArray(g)) return [{ path, message: "group must be an object", hint }];
  const out = (["id", "track"] as const).filter((k) => typeof g[k] !== "string" || !g[k])
    .map((k) => ({ path: `${path}.${k}`, message: `group needs a ${k} (${k === "id" ? "the expanded compound's id" : "the track it was expanded onto"})`, hint }));
  if (g.name !== undefined && typeof g.name !== "string") out.push({ path: `${path}.name`, message: "group name must be a string", hint });
  if (g.parent !== undefined) out.push(...groupIssues(g.parent, `${path}.parent`));
  return out;
}

function checkName(v: unknown, opts: string[], path: string, issues: Issue[], what: string) {
  const name = v && typeof v === "object" ? (v as Dict).type : v;
  if (name === undefined || name === null || name === false || name === "none" || name === "") return;
  if (!opts.includes(name as string)) {
    const s = suggest(name, opts);
    issues.push({ level: "error", path, message: `unknown ${what} '${name}'`, hint: s ? `did you mean '${s}'?` : `options: ${opts.join(", ")}` });
  }
}

export interface ValidateOpts { exists?: (p: string) => boolean; fontCheck?: (font: string | undefined, text: string) => { error?: string; hint?: string; fallback?: string } }

export function validate(tl: Timeline, o: ValidateOpts = {}): Issue[] {
  const issues: Issue[] = [];
  if (!tl || typeof tl !== "object") return [{ level: "error", path: "$", message: "timeline must be a JSON object" }];
  for (const k of Object.keys(tl)) if (!["version", "revision", "name", "settings", "assets", "tracks", "markers", "meta"].includes(k))
    issues.push({ level: "warning", path: `$.${k}`, message: `unknown top-level key '${k}' (ignored)` });
  const st = tl.settings || {};
  checkFields(st, SETTINGS_FIELDS, "$.settings", issues, "settings");
  (st.effects || []).forEach((f: any, fi: number) => {
    const ft = typeof f === "string" ? f : f?.type;
    if (!(ft in EFFECTS)) issues.push({ level: "error", path: `$.settings.effects[${fi}]`, message: `unknown effect '${ft}'`, hint: `effects: ${Object.keys(EFFECTS).join(", ")}` });
  });
  for (const k of ["width", "height"]) {
    const v = st[k];
    if (!Number.isInteger(v) || v < 16 || v > 8192) issues.push({ level: "error", path: `$.settings.${k}`, message: `${k} must be an integer 16..8192` });
    else if (v % 2) issues.push({ level: "warning", path: `$.settings.${k}`, message: `${k} is odd; it is rounded to even on export` });
  }
  if (typeof st.fps !== "number" || st.fps < 1 || st.fps > 120) issues.push({ level: "error", path: "$.settings.fps", message: "fps must be 1..120" });
  const assets = tl.assets || {};
  for (const [aid, a] of Object.entries(assets)) {
    const ap = `$.assets.${aid}`;
    if (!a || typeof a !== "object" || Array.isArray(a)) { issues.push({ level: "error", path: ap, message: "asset must be an object" }); continue; }
    checkFields(a, ASSET_FIELDS, ap, issues, "asset");
    if (typeof a.path !== "string" || !a.path) issues.push({ level: "error", path: `${ap}.path`, message: "asset needs a path" });
    if (!ASSET_KINDS.includes(a.kind)) issues.push({ level: "error", path: `${ap}.kind`, message: `asset kind must be one of ${ASSET_KINDS.join(", ")}` });
    for (const [k, [ok, what]] of Object.entries(ASSET_NUMBERS))
      if (typeof a[k] === "number" && !(Number.isFinite(a[k]) && ok(a[k]))) issues.push({ level: "error", path: `${ap}.${k}`, message: `${k} must be ${what}` });
    if (o.exists && typeof a.path === "string" && a.path && !o.exists(a.path)) issues.push({ level: "error", path: `${ap}.path`, message: `file not found: ${a.path}`, hint: "re-import the file or fix the path" });
  }
  if (!Array.isArray(tl.tracks)) return [...issues, { level: "error", path: "$.tracks", message: "tracks must be a list" }];
  validateTracks(tl, o, issues, new Map(), "$");
  if (!tl.tracks.some((t) => t.clips?.length)) issues.push({ level: "warning", path: "$.tracks", message: "timeline is empty" });
  return issues;
}

/** Track + clip checks for one timeline level; compound clips recurse with their nested tracks (clip ids are project-wide). */
function validateTracks(tl: Timeline, o: ValidateOpts, issues: Issue[], clipIds: Map<string, string>, root: string) {
  const assets = tl.assets || {};
  const ids = new Map<string, string>(); // track ids: unique per level
  const dup = (id: string) => ids.get(id) ?? clipIds.get(id);
  tl.tracks.forEach((tr, ti) => {
    const tp = `${root}.tracks[${ti}]`;
    if (!tr || typeof tr !== "object" || !Array.isArray(tr.clips ?? [])) { issues.push({ level: "error", path: tp, message: "track must be an object with a clips list" }); return; }
    checkFields(tr, TRACK_FIELDS, tp, issues, "track");
    for (const x of audioFxIssues(tr, tp)) issues.push({ level: "error", ...x });
    if (!tr.id) issues.push({ level: "error", path: `${tp}.id`, message: "track needs an id" });
    else if (dup(tr.id)) issues.push({ level: "error", path: `${tp}.id`, message: `duplicate id '${tr.id}'` });
    ids.set(tr.id, tp);
    const kind = tr.kind || "video";
    let prevEnd: number | null = null;
    (tr.clips || []).forEach((c, ci) => {
      let p = `${tp}.clips[${ci}]`;
      if (!c || typeof c !== "object") { issues.push({ level: "error", path: p, message: "clip must be an object" }); return; }
      if (!CLIP_TYPES.includes(c.type)) {
        const s = suggest(c.type, CLIP_TYPES);
        issues.push({ level: "error", path: `${p}.type`, message: `unknown clip type ${JSON.stringify(c.type)}`, hint: s ? `did you mean '${s}'?` : `types: ${CLIP_TYPES.join(", ")}` });
        return;
      }
      p = `${p}<${c.id ?? "?"}>`;
      checkFields(c, fieldsFor(c.type), p, issues, c.type);
      if (c.group && typeof c.group === "object") for (const x of groupIssues(c.group, `${p}.group`)) issues.push({ level: "error", ...x });
      if (c.type === "video" || c.type === "audio") for (const x of audioFxIssues(c, p)) issues.push({ level: "error", ...x });
      if (!c.id) issues.push({ level: "error", path: `${p}.id`, message: "clip needs an id" });
      else if (dup(c.id)) issues.push({ level: "error", path: `${p}.id`, message: `duplicate id '${c.id}' (also ${dup(c.id)})`, hint: "clip ids must be unique across the project, including inside compound clips" });
      clipIds.set(c.id, p);
      if (kind === "audio" && !["audio", "video", "gap"].includes(c.type)) issues.push({ level: "warning", path: p, message: `${c.type} clip on audio track '${tr.id}' will not be drawn` });
      let start = 0, dur = 0;
      try {
        dur = clipDur(c); start = clipStart(c);
        if (dur <= 0) issues.push({ level: "error", path: `${p}.duration`, message: "duration must be > 0" });
        if (start < 0) issues.push({ level: "error", path: `${p}.start`, message: "start must be >= 0" });
      } catch (e: any) { issues.push({ level: "error", path: p, message: e.message, hint: e.hint }); return; }
      if (MEDIA_TYPES.has(c.type)) {
        const aid = c.asset;
        if (!aid) issues.push({ level: "error", path: `${p}.asset`, message: "media clip needs 'asset' (or 'src' when adding)" });
        else if (!assets[aid]) {
          const s = suggest(aid, Object.keys(assets));
          issues.push({ level: "error", path: `${p}.asset`, message: `asset '${aid}' not in project`, hint: s ? `did you mean '${s}'?` : "import it first (import_media) or add with 'src'" });
        } else {
          const a = assets[aid];
          if ((c.type === "video" || c.type === "audio") && typeof a.duration === "number" && a.duration > 0 && !c.loop && !c.freeze && !(c.keyframes?.speed)) {
            const need = parseTime(c.in ?? 0) + dur * Number(c.speed ?? 1);
            if (need > a.duration + 0.05) issues.push({ level: "warning", path: `${p}.duration`, message: `clip needs ${need.toFixed(2)}s of source but '${aid}' is ${a.duration.toFixed(2)}s; the last frame is held`, hint: "shorten duration, lower 'in', or set loop: true" });
          }
          if (c.type === "video" && a.kind === "image") issues.push({ level: "warning", path: `${p}.type`, message: "asset is an image; use type 'image'" });
          if (c.type === "audio" && a.kind === "image") issues.push({ level: "error", path: `${p}.type`, message: "asset is an image, cannot be audio" });
          if (c.type === "lottie" && a.kind !== "lottie") issues.push({ level: "error", path: `${p}.asset`, message: "asset is not a Lottie animation" });
          if (c.reverse && dur * Number(c.speed ?? 1) > 60) issues.push({ level: "warning", path: `${p}.reverse`, message: "reversing more than 60 s of video uses a lot of memory" });
        }
      }
      if (c.type === "text" && !String(c.text ?? "").trim()) issues.push({ level: "error", path: `${p}.text`, message: "text clip has empty text" });
      if (c.type === "captions" && !(c.words?.length || c.srt)) issues.push({ level: "error", path: p, message: "captions need 'words' or 'srt'" });
      if (c.type === "captions" && c.srt && o.exists && !o.exists(c.srt)) issues.push({ level: "error", path: `${p}.srt`, message: `file not found: ${c.srt}` });
      for (const [key, opts, what] of [["enter", ENTER_EXIT, "animation"], ["exit", ENTER_EXIT, "animation"], ["transition", TRANSITIONS, "transition"], ["motion", MOTIONS, "motion"]] as const)
        if (key in c) checkName(c[key], opts as unknown as string[], `${p}.${key}`, issues, what);
      if (c.transition && ci === 0) issues.push({ level: "warning", path: `${p}.transition`, message: "first clip on a track has no previous clip; use 'enter' instead" });
      for (const [key, opts] of [["fit", FITS], ["blend", BLENDS], ["position", POSITIONS], ["style", CAPTION_STYLES], ["shape", SHAPES]] as const)
        if (key in c && c[key] != null && !(opts as readonly string[]).includes(c[key])) {
          const s = suggest(c[key], opts);
          issues.push({ level: "error", path: `${p}.${key}`, message: `invalid ${key} '${c[key]}'`, hint: s ? `did you mean '${s}'?` : `options: ${opts.join(", ")}` });
        }
      if (c.mask) checkName(typeof c.mask === "string" ? c.mask : c.mask.shape, MASKS, `${p}.mask`, issues, "mask shape");
      (c.filters || []).forEach((f: any, fi: number) => {
        const ft = typeof f === "string" ? f : f?.type;
        if (!(ft in FILTERS)) { const s = suggest(ft, Object.keys(FILTERS)); issues.push({ level: "error", path: `${p}.filters[${fi}]`, message: `unknown filter '${ft}'`, hint: s ? `did you mean '${s}'?` : `filters: ${Object.keys(FILTERS).join(", ")}` }); }
        else {
          if (typeof f === "object") {
            const tbl = filterTable(ft), fp = `${p}.filters[${fi}]`;
            checkFields(f, tbl, fp, issues, `${ft} filter`);
            for (const [k, x] of Object.entries(FILTER_SPECS[ft].fields)) if (x.kind !== "path" && f[k] != null && tbl[k][0].includes(jtype(f[k])))
              try { filterParam(ft, k, f[k]); } catch (e: any) { issues.push({ level: "error", path: `${fp}.${k}`, message: e.message, hint: e.hint }); }
          }
          if (ft === "lut" && o.exists && !o.exists(String(f.path ?? ""))) issues.push({ level: "error", path: `${p}.filters[${fi}].path`, message: "LUT file not found" });
        }
      });
      if ((c.type === "video" || c.type === "image") && c.remove_background && typeof c.remove_background === "object") {
        checkFields(c.remove_background, { model: [T("string"), MATTE_MODELS.join("|")] }, `${p}.remove_background`, issues, "remove_background");
        checkName(c.remove_background.model, MATTE_MODELS, `${p}.remove_background.model`, issues, "matte model");
      }
      if ((c.type === "video" || c.type === "image") && c.color && typeof c.color === "object") {
        checkFields(c.color, GRADE_FIELDS, `${p}.color`, issues, "color grade");
        if ("look" in c.color) checkName(c.color.look, Object.keys(LOOKS), `${p}.color.look`, issues, "look");
        for (const [k, message] of gradeIssues(c.color)) issues.push({ level: "error", path: `${p}.color.${k}`, message });
      }
      (c.effects || []).forEach((f: any, fi: number) => {
        const ft = typeof f === "string" ? f : f?.type;
        if (!(ft in EFFECTS)) { const s = suggest(ft, Object.keys(EFFECTS)); issues.push({ level: "error", path: `${p}.effects[${fi}]`, message: `unknown effect '${ft}'`, hint: s ? `did you mean '${s}'?` : `effects: ${Object.keys(EFFECTS).join(", ")}` }); }
      });
      for (const [prop, kfs] of Object.entries(c.keyframes || {})) {
        if (!ANIMATABLE.includes(prop)) { const s = suggest(prop, ANIMATABLE); issues.push({ level: "error", path: `${p}.keyframes.${prop}`, message: `'${prop}' is not animatable`, hint: s ? `did you mean '${s}'?` : `animatable: ${ANIMATABLE.join(", ")}` }); continue; }
        if (!Array.isArray(kfs) || !kfs.length) { issues.push({ level: "error", path: `${p}.keyframes.${prop}`, message: "keyframes must be a non-empty list of [t, value, easing?]" }); continue; }
        for (const k of kfs as any[]) {
          const kk = Array.isArray(k) ? k : k && typeof k === "object" ? [k.t, k.v ?? k.value, k.ease] : null;
          if (!kk || kk.length < 2 || kk[1] === undefined) issues.push({ level: "error", path: `${p}.keyframes.${prop}`, message: `bad keyframe ${JSON.stringify(k)}; use [t, value] or [t, value, 'ease_out']` });
          else if (kk[2] && !EASINGS.includes(kk[2])) issues.push({ level: "error", path: `${p}.keyframes.${prop}`, message: `unknown easing '${kk[2]}'`, hint: `easings: ${EASINGS.join(", ")}` });
        }
      }
      if (o.fontCheck && (c.type === "text" || c.type === "captions")) {
        let sample = c.text ?? (c.words || []).map((w: any) => w.text ?? "").join(" ");
        if (c.uppercase) sample = String(sample).toUpperCase();
        const r = o.fontCheck(c.font, String(sample));
        if (r.error) issues.push({ level: "error", path: `${p}.font`, message: r.error, hint: r.hint });
        else if (r.fallback) issues.push({ level: "info", path: `${p}.font`, message: `font '${c.font}' lacks some characters; '${r.fallback}' is used for them` });
      }
      if (c.attach_to) {
        const exists = tl.tracks.some((t2) => t2.clips.some((x) => x.id === c.attach_to));
        if (!exists) issues.push({ level: "error", path: `${p}.attach_to`, message: `attached to missing clip '${c.attach_to}'`, hint: "attach to an existing clip id, or remove attach_to" });
        if (tr.magnetic) issues.push({ level: "warning", path: `${p}.attach_to`, message: "attach_to is ignored on magnetic tracks (their starts are computed)" });
      }
      if (c.transition && ci > 0 && !tr.magnetic && !(prevEnd !== null && start < prevEnd - 1e-6)) issues.push({ level: "warning", path: `${p}.transition`, message: "on a non-magnetic track a transition only works if this clip overlaps the previous one" });
      if (!tr.magnetic && kind !== "audio" && prevEnd !== null && start < prevEnd - 1e-6 && !c.transition)
        issues.push({ level: "info", path: p, message: `overlaps the previous clip on '${tr.id}' (drawn on top)` });
      prevEnd = Math.max(prevEnd ?? 0, start + dur);
      if (c.type === "compound") {
        if (!Array.isArray(c.tracks)) { issues.push({ level: "error", path: `${p}.tracks`, message: "compound clip needs 'tracks' (a list of nested tracks)", hint: "create one with make_compound" }); return; }
        if (Number(c.speed ?? 1) <= 0) issues.push({ level: "error", path: `${p}.speed`, message: "speed must be > 0" });
        try { if (parseTime(c.in ?? 0) < 0) issues.push({ level: "error", path: `${p}.in`, message: "in must be >= 0" }); } catch (e: any) { issues.push({ level: "error", path: `${p}.in`, message: e.message, hint: e.hint }); }
        validateTracks(subTimeline(tl, c), o, issues, clipIds, p);
      }
    });
  });
}

export function schemaDoc() {
  const f = (d: F) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v[1]]));
  return {
    timeline: {
      version: SCHEMA_VERSION, revision: "integer, +1 on every save (optimistic concurrency: a write based on a stale revision fails with code conflict)",
      settings: f(SETTINGS_FIELDS),
      assets: "{asset_id: {path, kind: video|image|audio|lottie, duration, width, height, fps, has_audio, alpha}} - filled by import_media",
      tracks: "list; index 0 is drawn FIRST (bottom), later tracks on top",
      markers: "[{t, label}]",
    },
    track: f(TRACK_FIELDS),
    clip_types: Object.fromEntries(CLIP_TYPES.map((t) => [t, f(Object.fromEntries(Object.entries(fieldsFor(t)).filter(([k]) => !(k in COMMON_FIELDS))))])),
    common_clip_fields: f(COMMON_FIELDS),
    units: { time: "seconds (2.5, '2.5s', '1500ms', '00:02.5')", length: "px or '10%' of canvas", color: "#RRGGBB / #RRGGBBAA / rgba() / basic names" },
    enums: { enter_exit: ENTER_EXIT, transitions: TRANSITIONS, motions: MOTIONS, easings: EASINGS, fit: FITS, blend: BLENDS, position: POSITIONS, caption_styles: CAPTION_STYLES, shapes: SHAPES, masks: MASKS, effects: EFFECTS, filters: FILTERS, color_grade: f(GRADE_FIELDS), looks: Object.keys(LOOKS), presets: Object.fromEntries(Object.entries(PRESETS).map(([k, [w, h]]) => [k, `${w}x${h}`])) },
  };
}

export function deepMerge(dst: Dict, patch: Dict): Dict {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete dst[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k]) && k !== "keyframes") deepMerge(dst[k], v);
    else dst[k] = structuredClone(v);
  }
  return dst;
}

export function setDotted(obj: Dict, key: string, value: unknown) {
  const parts = key.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  if (value === null) delete o[parts.at(-1)!];
  else o[parts.at(-1)!] = value;
}

export const clone = <X>(x: X): X => structuredClone(x);
