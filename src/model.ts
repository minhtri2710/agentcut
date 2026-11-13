// Timeline data model: schema tables, parsing, validation, magnetic resolution.
// Pure functions only (file existence checks are optional) so they are cheap to call often.
import { ease, parseKfs } from "./anim.ts";
import { AUDIO_FX_DOC, audioFxIssues, PER_CLIP_KEYS } from "./audiofx.ts";
import { GRADE_FIELDS, gradeIssues, LOOKS } from "./color.ts";
import { own } from "./own.ts";

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
/** One source of truth per effect: its doc and the parameters it reads besides type, start and duration, so add_effect and validate refuse a misspelled one. */
export const EFFECT_SPECS: Record<string, { doc: string; params: string[] }> = {
  glitch: { doc: "digital glitch slices + colour split; intensity 0..1", params: ["intensity"] },
  rgb_split: { doc: "chromatic aberration; amount px (default 12)", params: ["amount"] },
  flash: { doc: "white flash; at (s, default 0), duration (0.25)", params: ["at"] },
  grain: { doc: "film grain; intensity 0..1 (0.25)", params: ["intensity"] },
  zoom_blur: { doc: "radial zoom blur; intensity 0..1", params: ["intensity"] },
  vignette: { doc: "dark edges; intensity 0..1 (0.5)", params: ["intensity"] },
  vhs: { doc: "scanlines + colour bleed + wobble; intensity 0..1", params: ["intensity"] },
  letterbox: { doc: "cinematic bars; ratio (2.39)", params: ["ratio"] },
  strobe: { doc: "on/off blink; freq Hz (8)", params: ["freq"] },
  blur: { doc: "gaussian blur; radius px", params: ["radius"] },
  bw: { doc: "black & white", params: [] },
  invert: { doc: "invert colours", params: [] },
  hue: { doc: "hue rotate; degrees", params: ["degrees"] },
  brightness: { doc: "multiplier (1.2)", params: ["amount"] },
  contrast: { doc: "multiplier (1.2)", params: ["amount"] },
  saturate: { doc: "multiplier (1.4)", params: ["amount"] },
};
export const EFFECTS: Record<string, string> = Object.fromEntries(Object.entries(EFFECT_SPECS).map(([k, s]) => [k, s.doc]));
/** The keys an effect entry may hold (add_effect and the `effects` lists of a clip and of the settings). */
export const effectKeys = (type: string) => ["type", "start", "duration", ...EFFECT_SPECS[type].params];
const effectTable = (type: string): F => Object.fromEntries(effectKeys(type).map((k) => [k, [k === "type" ? T("string") : T("number", "string"), k === "type" ? "effect name" : EFFECT_SPECS[type].doc]]));
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
  const spec = own(FILTER_SPECS, type), x = spec && own(spec.fields, key);
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
/** Environment for every child that runs onnxruntime (the vision helper, piper); it wins over an inherited value. */
export const ORT_ENV = { ORT_DISABLE_TELEMETRY: "1" };
export const sizeText = (mb: number | null | undefined) => (mb == null ? "size unknown" : `~${mb} MB`);
export const matteSize = (model: string) => sizeText(MATTE_MB[model]);
export const MATTE_SIZES = MATTE_MODELS.map((m) => `${m} ${matteSize(m)}`).join(", ");
export const ANIMATABLE = ["x", "y", "scale", "scale_x", "scale_y", "rotation", "opacity", "volume", "blur", "speed", "focus_x", "focus_y"];

type F = Record<string, [string[], string]>;
const T = (...t: string[]) => t; // allowed json types: number,string,boolean,object,array,null

/** Numeric clip fields with a documented range, one source: [predicate, description]. The field docs, the validate check of the value and the check of every keyframe value of the same prop read it (errors, never clamps).
 *  scale_x and scale_y are not here: a negative one mirrors the picture, so any number is legal. */
const CLIP_RANGES: Record<string, readonly [(n: number) => boolean, string]> = {
  opacity: [(n) => n >= 0 && n <= 1, "0..1"],
  volume: [(n) => n >= 0 && n <= 4, "0..4"],
  fade_in: [(n) => n >= 0, ">= 0"], fade_out: [(n) => n >= 0, ">= 0"],
  scale: [(n) => n > 0, "> 0"],
  radius: [(n) => n >= 0, ">= 0"],
  weight: [(n) => n >= 100 && n <= 900, "100..900"],
};
/** Where the values of a keyframe list may differ from the field's own range: a scale of 0 is a pop-in's first value, while a still scale of 0 draws nothing. */
const KEYFRAME_RANGES: Record<string, readonly [(n: number) => boolean, string]> = { scale: [(n) => n >= 0, ">= 0"] };
const keyframeRange = (k: string) => KEYFRAME_RANGES[k] ?? CLIP_RANGES[k];
const ranged = (k: string, doc: string, ...types: string[]): [string[], string] =>
  [types.length ? types : T("number"), `${doc} (${CLIP_RANGES[k][1]}${KEYFRAME_RANGES[k] ? `; keyframe values ${KEYFRAME_RANGES[k][1]}` : ""})`];
/** The number a ranged field holds, or undefined when there is none to check: a number, or for `weight` a numeric string ("bold" is a name, not a number). */
const rangeValue = (k: string, v: unknown) => typeof v === "number" ? v : k === "weight" && typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined;
/** Errors for the numeric fields of `obj` (a clip, or a track with only `keys`) that are outside their range. */
function rangeIssues(obj: Dict, path: string, issues: Issue[], keys = Object.keys(CLIP_RANGES)) {
  for (const k of keys) {
    const n = rangeValue(k, obj[k]);
    if (n !== undefined && !(Number.isFinite(n) && CLIP_RANGES[k][0](n)))
      issues.push({ level: "error", path: `${path}.${k}`, message: `${k} must be ${CLIP_RANGES[k][1]}, got ${JSON.stringify(obj[k])}` });
  }
}

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
  until_end: [T("boolean"), "duration follows the end of the rest of the timeline (e.g. music bed, watermark); an explicit length edit ends it"],
  attach_to: [T("string"), "connected clip (Final Cut): start = that clip's start + offset, follows it when it moves/retimes"],
  offset: [T("number", "string"), "seconds after the attach_to clip's start (default 0)"],
  match_duration: [T("boolean", "string"), "true with attach_to: duration = target duration - offset - end_offset; or a clip reference (\"<id>\" or \"track#n\"): duration = that clip's duration - end_offset, the start is untouched (works on magnetic tracks) and follows later changes to that clip"],
  end_offset: [T("number", "string"), "with match_duration: stop this many seconds before the target ends (negative holds longer)"],
};
export const VISUAL_FIELDS: F = {
  x: [T("number", "string"), "centre x in px or '50%'"],
  y: [T("number", "string"), "centre y in px or '50%'"],
  position: [T("string"), POSITIONS.join("|") + " (anchor preset, with margin)"],
  margin: [T("number", "string"), "distance from the edge for position presets (px or %)"],
  scale: ranged("scale", "uniform scale, 1 = fitted size"),
  scale_x: [T("number"), "extra horizontal scale (negative mirrors)"], scale_y: [T("number"), "extra vertical scale (negative mirrors)"],
  rotation: [T("number"), "degrees clockwise"],
  opacity: ranged("opacity", "opacity"),
  blend: [T("string"), BLENDS.join("|")],
  keyframes: [T("object"), "{prop: [[t, value, easing?], ...]} t relative to clip start; props: " + ANIMATABLE.join(",")],
  enter: [T("string", "object"), "entrance animation: name or {type, duration, ease}: " + ENTER_EXIT.join(",")],
  exit: [T("string", "object"), "exit animation: name or {type, duration, ease}"],
  transition: [T("string", "object"), "transition FROM the previous clip on the same track: " + TRANSITIONS.join(",")],
  motion: [T("string", "object"), "continuous motion: name or {type, amount}: " + MOTIONS.join(",")],
  radius: ranged("radius", "rounded corner radius px"),
  shadow: [T("object", "boolean"), "{color, x, y, blur} drop shadow"],
  border: [T("object"), "{color, width} outline around the layer box"],
  mask: [T("object", "string"), "{shape: " + MASKS.join("|") + ", x, y, width, height (0..1 of layer), feather px, invert, angle}"],
  effects: [T("array"), "list of {type, ...params, start?, duration?}: " + Object.keys(EFFECTS).join(",")],
  pending: [T("object"), "{op: args} vision requests (auto_reframe, track_to) waiting for prepare; written by those ops, cleared when prepared"],
};
/** The playback speed range, for the constant `speed` and for every keyframes.speed value. */
export const SPEED_MIN = 0.1, SPEED_MAX = 8;
/** Easings that leave [start, end] between two keyframes, so a ramp using one can pass the speed range. */
const OVERSHOOT = ["back_out", "elastic_out"];
/** Mixer sample rate in Hz: an integer ffmpeg takes at both ends (telephony 8 kHz .. pro audio 192 kHz); pitch shifts divide by round(rate * 2^(semitones/12)), so a tiny rate would make that zero. */
const SAMPLE_RATE_MIN = 8000, SAMPLE_RATE_MAX = 192000;
export const MEDIA_FIELDS: F = {
  asset: [T("string"), "asset id"], src: [T("string"), "file path (auto-imported)"],
  in: [T("number", "string"), "source in-point seconds"],
  speed: [T("number"), `playback speed ${SPEED_MIN}..${SPEED_MAX} (keyframes.speed for ramps on video; not together with speed != 1)`],
  volume: ranged("volume", "linear gain"), muted: [T("boolean"), "drop audio"],
  fade_in: ranged("fade_in", "audio fade-in s"), fade_out: ranged("fade_out", "audio fade-out s"),
  fit: [T("string"), FITS.join("|") + " (blur = contain over a blurred cover background, CapCut style)"],
  size: [T("array"), "[w, h] box px or % (default canvas)"],
  focus: [T("array"), "[fx, fy] the source point (0..1 of the picture after crop) that cover keeps at the centre of the view, clamped at the picture edges; [0.5, 0.5] = centre (reframe 16:9 -> 9:16); keyframes.focus_x/focus_y pan it (op auto_reframe)"],
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
  weight: ranged("weight", "a number or bold/black", "number", "string"),
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
  size: [T("array"), "[w, h] box"], speed: [T("number"), `playback speed ${SPEED_MIN}..${SPEED_MAX}`], loop: [T("boolean"), "loop (default true)"],
  in: [T("number", "string"), "start offset seconds"],
};
export const COMPOUND_FIELDS: F = {
  tracks: [T("array"), "nested tracks (same format as timeline tracks, shared assets; clip ids unique project-wide)"],
  in: [T("number", "string"), "seconds into the nested timeline (default 0)"],
  speed: [T("number"), `playback speed ${SPEED_MIN}..${SPEED_MAX} of the nested timeline (at a speed other than 1 nested audio is not mixed and nested captions are not exported as subtitles; validate warns)`],
  volume: ranged("volume", "gain applied to all nested audio"), muted: [T("boolean"), "drop nested audio"],
};

/** The clip types that play at a ramped speed (render.ts reads keyframes.speed only for a video clip; an audio clip with a ramp would drop out of the mix). */
const RAMPS = new Set(["video"]);

export function fieldsFor(t: string): F {
  const f: F = { ...COMMON_FIELDS };
  if (VISUAL_TYPES.has(t)) {
    Object.assign(f, VISUAL_FIELDS);
    if (!RAMPS.has(t)) f.keyframes = [T("object"), "{prop: [[t, value, easing?], ...]} t relative to clip start; props: " + ANIMATABLE.filter((k) => k !== "speed").join(",") + " (speed ramps only on video clips)"];
  }
  if (t === "video" || t === "image" || t === "audio") Object.assign(f, MEDIA_FIELDS);
  if (t === "video" || t === "audio") Object.assign(f, AUDIO_FX_FIELDS);
  if (t === "audio") {
    for (const k of ["fit", "size", "focus", "crop", "filters", "color", "freeze", "remove_background"]) delete f[k];
    f.keyframes = [T("object"), "{volume: [[t, gain]]}"];
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
  volume: ranged("volume", "track gain"), muted: [T("boolean"), "mute"], hidden: [T("boolean"), "do not draw"],
  clips: [T("array"), "clips (later ones draw on top within the track)"],
  ...Object.fromEntries(Object.entries(AUDIO_FX_FIELDS).map(([k, [t, d]]) => [k, [t, `${d} (${(PER_CLIP_KEYS as readonly string[]).includes(k) ? "applied to each clip without its own" : "applied to the track mix"})`]])),
};
export const SETTINGS_FIELDS: F = {
  width: [T("number"), "canvas width px"], height: [T("number"), "canvas height px"], fps: [T("number"), "frames per second"],
  background: [T("string"), "canvas colour"], duration: [T("number", "null"), "force total duration"],
  loudness: [T("number", "null"), "target LUFS (default -14, null = off)"], sample_rate: [T("number"), `Hz, an integer ${SAMPLE_RATE_MIN}..${SAMPLE_RATE_MAX} (default 48000)`],
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
    const lo = o.toLowerCase(), s = swapped(w, lo) ? 0.9 : Math.max(similarity(w, lo), abbreviation(w, lo) ? 0.6 : 0);
    if (s > bestScore) { bestScore = s; best = o; }
  }
  return bestScore >= 0.55 ? best : undefined;
}
/** The letters of `a` (3 or more) appear in `b` in order (idx/index): the bigram score misses these too. */
function abbreviation(a: string, b: string) {
  let i = 0;
  for (const ch of b) if (a[i] === ch) i++;
  return a.length >= 3 && i === a.length && a.length < b.length;
}
/** Two words that differ by one swap of neighbouring letters (scr/src): the bigram score misses them. */
function swapped(a: string, b: string) {
  if (a.length !== b.length) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

/** bad_arg for the first of `keys` that is not in `names`, with a did-you-mean hint. The message reads "unknown <where> <kind> '<key>'", so feedback.ts extractMisses logs the miss under the op (`where`) and not under a bare "argument" (among the names not given yet). A "_" key is a comment only where it is saved into the timeline (`stored`, as in checkFields); op arguments are not saved, so there it is refused like any other key. `list` replaces the allowed names in the hint when there are too many to print. */
export function refuseUnknown(keys: Iterable<string>, names: readonly string[], where: string, o: { kind?: string; stored?: boolean; list?: string } = {}) {
  const given = new Set(keys), key = [...given].find((k) => !names.includes(k) && !(o.stored && k.startsWith("_")));
  if (key === undefined) return;
  const s = suggest(key, names.filter((n) => !given.has(n)));
  throw new EditError(`unknown ${where} ${o.kind ?? "argument"} '${key}'`, "bad_arg", s ? `did you mean '${s}'?` : o.list ?? `allowed: ${names.join(", ")}`, `.${key}`);
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
  s = own(NAMED, s) ?? s;
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

/** The detached audio of a video (detach_audio, j_cut, l_cut): audio clips attached to it with its asset, in track order. Splitting or copying the audio clip itself leaves several pieces. */
export function linkedAudio(tl: Timeline, v: Clip): [Track, Clip][] {
  if (v.type !== "video") return [];
  return [...iterClips(tl)].filter(([, , , x]) => x.type === "audio" && x.attach_to === v.id && x.asset === v.asset).map(([tr, , , x]) => [tr, x]);
}

/** The one detached audio clip of a video; several pieces are refused, so that an op which edits "the" audio never picks one for the user. */
export function soleAudio(tl: Timeline, v: Clip, op: string): [Track, Clip] | undefined {
  const la = linkedAudio(tl, v);
  if (la.length > 1) throw new EditError(`'${v.id}' has ${la.length} detached audio clips (${la.map(([, x]) => x.id).join(", ")}), and ${op} edits one`, "audio_pieces",
    "edit the pieces by id, or remove_clip all but one; split_clip and duplicate_clip on the video handle every piece");
  return la[0];
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
  layout(tl);
  // until_end clips stretch to the end of everything else; a clip whose length follows one counts only at its floor length, a clip whose start moves with one not at all
  const { len, pos } = movesWithUntilEnd(tl);
  let end = 0, any = false;
  for (const [, , , c] of iterClips(tl)) {
    if (c.until_end) any = true;
    else if (c.enabled !== false && !pos.has(c)) end = Math.max(end, len.has(c) ? clipStart(c) + 0.1 : clipEnd(c));
  }
  if (any) { // an until_end clip is stretched where its start is final: on a magnetic track as the track is laid out, elsewhere once the attached starts are set; the lengths that follow it come last
    resolveMagnetic(tl, end);
    resolveAttached(tl);
    for (const tr of tl.tracks) if (!tr.magnetic) for (const c of tr.clips) if (c.until_end) c.duration = round6(Math.max(0.1, end - clipStart(c)));
    resolveLengths(tl);
  }
  return tl;
}

/** Every length settles before any start: a start (magnetic, attached) reads settled lengths, so one call gives the final answer. */
function layout(tl: Timeline) {
  resolveLengths(tl);
  resolveMagnetic(tl);
  resolveAttached(tl);
}

/** Visit each clip after the clip it depends on, so a chain of any depth settles in one call; a cycle (invalid) stops where it closes. */
function settleChains(tl: Timeline, dependsOn: (c: Clip) => string | undefined, settle: (c: Clip, t: Clip) => void) {
  const byId = new Map<string, Clip>(), done = new Set<Clip>();
  for (const [, , , c] of iterClips(tl)) byId.set(c.id, c);
  const visit = (c: Clip) => {
    if (done.has(c)) return;
    done.add(c);
    const id = dependsOn(c), t = id === undefined ? undefined : byId.get(id);
    if (!t || t === c) return;
    visit(t);
    settle(c, t);
  };
  for (const [, , , c] of iterClips(tl)) visit(c);
}

/** The clips whose end moves with the length of an until_end clip. `len`: their length follows it (match_duration). `pos`: their start moves with it, because they sit after such a clip on a magnetic track or attach to the start of a clip that does.
 *  Counted in the end an until_end clip stretches to, each resolve would grow both (a follower with a negative end_offset ends past it). */
function movesWithUntilEnd(tl: Timeline): { len: Set<Clip>; pos: Set<Clip> } {
  const byId = new Map<string, Clip>(), len = new Set<Clip>(), pos = new Set<Clip>();
  for (const [, , , c] of iterClips(tl)) { byId.set(c.id, c); if (c.until_end) len.add(c); }
  for (let grew = true; grew;) {
    grew = false;
    const add = (set: Set<Clip>, c: Clip) => { if (!set.has(c)) { set.add(c); grew = true; } };
    for (const tr of tl.tracks) tr.clips.forEach((c, i) => {
      const prev = tr.clips[i - 1], target = byId.get(lengthTarget(c)!), at = byId.get(c.attach_to);
      if (target && len.has(target)) add(len, c);
      if (at && pos.has(at)) add(pos, c);
      if (tr.magnetic && prev && (len.has(prev) || pos.has(prev))) add(pos, c);
    });
  }
  return { len, pos };
}

/** The id of the clip whose length this clip's length follows: match_duration naming a clip, or true with attach_to. */
export const lengthTarget = (c: Clip) => (typeof c.match_duration === "string" ? c.match_duration : c.match_duration === true ? c.attach_to : undefined);

/** A clip's length follows another clip: match_duration naming a clip (duration = its duration - end_offset, the start untouched), or true with attach_to (duration = the target's - offset - end_offset). */
function resolveLengths(tl: Timeline) {
  settleChains(tl, lengthTarget, (c, t) => {
    const off = typeof c.match_duration === "string" ? 0 : parseTime(c.offset ?? 0);
    c.duration = round6(Math.max(0.1, clipDur(t) - off - parseTime(c.end_offset ?? 0)));
  });
}

/** A clip whose duration is computed, not stored: it follows a clip (match_duration names one) or its attach_to target (match_duration true). */
export const computedDuration = (c: Clip) => typeof c.match_duration === "string" || (c.match_duration === true && !!c.attach_to);

/** clip types with source time (the model allows `in` on them): video, audio, lottie, compound */
export const hasSourceTime = (c: Clip) => "in" in fieldsFor(c.type);

/** An explicit duration edit of a computed-duration clip would be overwritten by resolve(): refuse it. An until_end clip gives up its stretch (the explicit length replaces it). */
export function ownDuration(c: Clip) {
  if (typeof c.match_duration === "string") throw new EditError(`'${c.id}' has a computed duration`, "computed_duration", `its length follows '${c.match_duration}': change end_offset, or update_clip id=${c.id} match_duration=null first`);
  if (c.match_duration === true && c.attach_to) throw new EditError(`'${c.id}' has a computed duration`, "computed_duration", `its length follows its attach_to target '${c.attach_to}': change offset or end_offset, or update_clip id=${c.id} match_duration=null first`);
  delete c.until_end;
}

/** Stop following: clips whose match_duration names a clip for which gone(id) is true keep the length they last resolved to. Returns their ids. */
export function unfollow(clips: Iterable<Clip>, gone: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const c of clips) if (typeof c.match_duration === "string" && gone(c.match_duration)) { delete c.match_duration; delete c.end_offset; out.push(c.id); }
  return out;
}

function resolveAttached(tl: Timeline) {
  settleChains(tl, (c) => c.attach_to, (c, t) => { c.start = round6(Math.max(0, clipStart(t) + parseTime(c.offset ?? 0))); });
  for (const tr of tl.tracks) if (!tr.magnetic && tr.clips.some((c) => c.attach_to)) tr.clips.sort((a, b) => clipStart(a) - clipStart(b));
}

/** `end`: where until_end clips stretch to. An until_end clip's overlap is not limited by its own length (that length is made from where it starts), so no start reads `end`; its length is at least the overlap, so the clips after it keep their place. */
function resolveMagnetic(tl: Timeline, end?: number) {
  for (const tr of tl.tracks) {
    if (!tr.magnetic) continue;
    let t = 0;
    tr.clips.forEach((c, i) => {
      const spec = i > 0 ? normAnim(c.transition, 0.5) : null;
      const over = spec ? Math.min(spec.duration, clipDur(tr.clips[i - 1])) : 0;
      const start = Math.max(0, t - Math.min(over, c.until_end ? Infinity : clipDur(c)));
      c.start = round6(start);
      if (end !== undefined && c.until_end) c.duration = round6(Math.max(0.1, end - c.start, over));
      t = start + clipDur(c);
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
    const spec = own(fields, k);
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
  // an object without a usable type would reach the renderer as a type it cannot draw
  if (v && typeof v === "object" && (typeof name !== "string" || !name)) { issues.push({ level: "error", path: `${path}.type`, message: `${what} needs a 'type'`, hint: `options: ${opts.join(", ")}` }); return; }
  if (name === undefined || name === null || name === false || name === "none" || name === "") return;
  if (!opts.includes(name as string)) {
    const s = suggest(name, opts);
    issues.push({ level: "error", path, message: `unknown ${what} '${name}'`, hint: s ? `did you mean '${s}'?` : `options: ${opts.join(", ")}` });
  }
}

export interface ValidateOpts { exists?: (p: string) => boolean; fontCheck?: (font: string | undefined, text: string) => { error?: string; hint?: string; fallback?: string; uncovered?: string } }

export function validate(tl: Timeline, o: ValidateOpts = {}): Issue[] {
  const issues: Issue[] = [];
  if (!tl || typeof tl !== "object") return [{ level: "error", path: "$", message: "timeline must be a JSON object" }];
  for (const k of Object.keys(tl)) if (!["version", "revision", "name", "settings", "assets", "tracks", "markers", "meta"].includes(k))
    issues.push({ level: "warning", path: `$.${k}`, message: `unknown top-level key '${k}' (ignored)` });
  const st = tl.settings || {};
  checkFields(st, SETTINGS_FIELDS, "$.settings", issues, "settings");
  if (st.effects != null && !Array.isArray(st.effects)) issues.push({ level: "error", path: "$.settings.effects", message: "effects must be a list", hint: `effects: ${Object.keys(EFFECTS).join(", ")}` });
  else (st.effects || []).forEach((f: any, fi: number) => {
    const ft = typeof f === "string" ? f : f?.type;
    if (!own(EFFECTS, ft)) issues.push({ level: "error", path: `$.settings.effects[${fi}]`, message: `unknown effect '${ft}'`, hint: `effects: ${Object.keys(EFFECTS).join(", ")}` });
    else if (f && typeof f === "object") checkFields(f, effectTable(ft), `$.settings.effects[${fi}]`, issues, `${ft} effect`);
  });
  for (const k of ["width", "height"]) {
    const v = st[k];
    if (!Number.isInteger(v) || v < 16 || v > 8192) issues.push({ level: "error", path: `$.settings.${k}`, message: `${k} must be an integer 16..8192` });
    else if (v % 2) issues.push({ level: "warning", path: `$.settings.${k}`, message: `${k} is odd; it is rounded to even on export` });
  }
  if (typeof st.fps !== "number" || st.fps < 1 || st.fps > 120) issues.push({ level: "error", path: "$.settings.fps", message: "fps must be 1..120" });
  if (typeof st.sample_rate === "number" && !(Number.isInteger(st.sample_rate) && st.sample_rate >= SAMPLE_RATE_MIN && st.sample_rate <= SAMPLE_RATE_MAX))
    issues.push({ level: "error", path: "$.settings.sample_rate", message: `sample_rate must be an integer ${SAMPLE_RATE_MIN}..${SAMPLE_RATE_MAX} Hz`, hint: "48000 (default) or 44100" });
  const assets = tl.assets || {};
  for (const [aid, a] of Object.entries(assets)) {
    const ap = `$.assets.${aid}`;
    if (!a || typeof a !== "object" || Array.isArray(a)) { issues.push({ level: "error", path: ap, message: "asset must be an object" }); continue; }
    checkFields(a, ASSET_FIELDS, ap, issues, "asset");
    if (typeof a.path !== "string" || !a.path) issues.push({ level: "error", path: `${ap}.path`, message: "asset needs a path" });
    if (!ASSET_KINDS.includes(a.kind)) issues.push({ level: "error", path: `${ap}.kind`, message: `asset kind must be one of ${ASSET_KINDS.join(", ")}` });
    for (const [k, [ok, what]] of Object.entries(ASSET_NUMBERS))
      if (typeof a[k] === "number" && !(Number.isFinite(a[k]) && ok(a[k]))) issues.push({ level: "error", path: `${ap}.${k}`, message: `${k} must be ${what}` });
    if (o.exists && typeof a.path === "string" && a.path && !o.exists(a.path)) issues.push({ level: "error", path: `${ap}.path`, message: `file not found: ${a.path}`, hint: `restore the file, or move the clips to the new path: import_media path=<new path> (it returns the new asset id), then update_clip set {"asset":"<new id>"} on each clip that uses '${aid}', then remove_asset id=${aid}` });
  }
  if (!Array.isArray(tl.tracks)) return [...issues, { level: "error", path: "$.tracks", message: "tracks must be a list" }];
  validateTracks(tl, o, issues, new Map(), "$", ROOT);
  if (!tl.tracks.some((t) => t.clips?.length)) issues.push({ level: "warning", path: "$.tracks", message: "timeline is empty" });
  return issues;
}

/** The text a font check looks at: a text clip's text, a captions clip's words (upper-cased when the clip is); null for any other clip. */
export function fontSample(c: Clip): string | null {
  if (c.type !== "text" && c.type !== "captions") return null;
  const s = String(c.text ?? (c.words || []).map((w: any) => w.text ?? "").join(" "));
  return c.uppercase ? s.toUpperCase() : s;
}

/** A compound at a speed other than 1: its nested audio is not mixed (audio.ts) and its nested captions are not cues (subtitles.ts). */
export const isRetimed = (c: Clip) => Math.abs((Number(c.speed ?? 1) || 1) - 1) > 1e-6;
/** A clip whose own sound is mixed (before track/compound gains): audio.ts audioSources and the retimed-compound warning share it. */
export const hasSound = (c: Clip, assets: Timeline["assets"]) => (c.type === "audio" || c.type === "video") && !c.muted && !c.freeze
  && !!own(assets, c.asset) && !!(assets[c.asset].has_audio || assets[c.asset].kind === "audio");

/** The part of [s, e] inside the window [w0, w1], or null when under 1 ms is left. audio.ts mapClip, subtitles.ts captionCues and the retimed-compound warning trim a nested clip to its compound's visible window with it. */
export const visibleSpan = (s: number, e: number, w0: number, w1: number): [number, number] | null => {
  const a = Math.max(s, w0), b = Math.min(e, w1);
  return b - a < 1e-3 ? null : [a, b];
};

/** What audio.ts and subtitles.ts reach at one level of validateTracks, ignoring the speed of the compounds above: the gain and caption visibility
 *  of the ancestors, the window of this level's time that is visible, and (inside the nearest retimed compound only) where to record what that compound drops. */
interface Flow { gain: number; captions: boolean; w0: number; w1: number; sink?: { audio: boolean; captions: boolean } }
const ROOT: Flow = { gain: 1, captions: true, w0: 0, w1: Infinity };
const DEAD: Flow = { gain: 0, captions: false, w0: 0, w1: 0 }; // below a disabled or outside-the-window compound: nothing is mixed or exported

/** [min, max] of an overshooting easing over t in 0..1, found once by dense sampling (the error is ~1e-6 of the span); lazy because anim.ts and this file import each other. */
const easeRange = new Map<string, [number, number]>();
function rangeOf(e: string): [number, number] {
  let r = easeRange.get(e);
  if (!r) {
    r = [Infinity, -Infinity];
    for (let j = 0; j <= 20000; j++) { const v = ease(e, j / 20000); r = [Math.min(r[0], v), Math.max(r[1], v)]; }
    easeRange.set(e, r);
  }
  return r;
}

/** A speed segment whose overshooting easing leaves SPEED_MIN..SPEED_MAX is an error naming the value it reaches: the curve is v0 + (v1 - v0) * ease(t), so its extremes are at the easing's extremes (O(1) per segment). Reads each segment as kfValue does (the easing of a keyframe shapes the segment ending at it, so the first keyframe's is ignored). */
function overshootIssues(kfs: any[], path: string, issues: Issue[]) {
  const pts = parseKfs([...kfs]); // a copy: parseKfs caches by array identity, and a validated list may have been edited in place
  const mid = (SPEED_MIN + SPEED_MAX) / 2;
  for (let i = 1; i < pts.length; i++) {
    const [t0, v0] = pts[i - 1], [t1, v1, e] = pts[i];
    if (!OVERSHOOT.includes(e as string) || t1 - t0 <= 1e-9) continue;
    const worst = rangeOf(e!).map((m) => v0 + (v1 - v0) * m).reduce((a, b) => (Math.abs(b - mid) > Math.abs(a - mid) ? b : a));
    if (!(worst >= SPEED_MIN && worst <= SPEED_MAX)) issues.push({ level: "error", path, message: `easing '${e}' between t=${t0} and t=${t1} takes the speed to ${+worst.toFixed(3)}, outside ${SPEED_MIN}..${SPEED_MAX}`, hint: "use ease_out or ease_in_out, or keep the keyframe values away from the limits" });
  }
}

/** Track + clip checks for one timeline level; compound clips recurse with their nested tracks (clip ids are project-wide). */
function validateTracks(tl: Timeline, o: ValidateOpts, issues: Issue[], clipIds: Map<string, string>, root: string, flow: Flow) {
  const assets = tl.assets || {};
  const ids = new Map<string, string>(); // track ids: unique per level
  const clips = tl.tracks.flatMap((x) => x.clips ?? []), byId = (id: string) => clips.find((x) => x.id === id);
  const dup = (id: string) => ids.get(id) ?? clipIds.get(id);
  tl.tracks.forEach((tr, ti) => {
    const tp = `${root}.tracks[${ti}]`;
    if (!tr || typeof tr !== "object" || !Array.isArray(tr.clips ?? [])) { issues.push({ level: "error", path: tp, message: "track must be an object with a clips list" }); return; }
    checkFields(tr, TRACK_FIELDS, tp, issues, "track");
    rangeIssues(tr, tp, issues, ["volume"]);
    for (const x of audioFxIssues(tr, tp)) issues.push({ level: "error", ...x });
    if (!tr.id) issues.push({ level: "error", path: `${tp}.id`, message: "track needs an id" });
    else if (dup(tr.id)) issues.push({ level: "error", path: `${tp}.id`, message: `duplicate id '${tr.id}'` });
    ids.set(tr.id, tp);
    const kind = tr.kind || "video", tf = { gain: tr.muted ? 0 : flow.gain * Number(tr.volume ?? 1), captions: flow.captions && !tr.hidden };
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
      rangeIssues(c, p, issues);
      if (typeof c.speed === "number" && !(Number.isFinite(c.speed) && c.speed >= SPEED_MIN && c.speed <= SPEED_MAX)) issues.push({ level: "error", path: `${p}.speed`, message: `speed must be ${SPEED_MIN}..${SPEED_MAX}` });
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
      const vis = c.enabled === false ? null : visibleSpan(start, start + dur, flow.w0, flow.w1); // null: audio.ts and subtitles.ts never reach this clip
      if (vis && flow.sink) {
        if (c.type === "captions") { if (tf.captions) flow.sink.captions = true; }
        else if (hasSound(c, assets) && Number(c.volume ?? 1) * tf.gain > 0) flow.sink.audio = true;
      }
      if (MEDIA_TYPES.has(c.type)) {
        const aid = c.asset;
        if (!aid) issues.push({ level: "error", path: `${p}.asset`, message: "media clip needs 'asset' (or 'src' when adding)" });
        else if (!own(assets, aid)) {
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
      (Array.isArray(c.filters) ? c.filters : []).forEach((f: any, fi: number) => { // a non-list is already a type error
        const ft = typeof f === "string" ? f : f?.type;
        if (!own(FILTERS, ft)) { const s = suggest(ft, Object.keys(FILTERS)); issues.push({ level: "error", path: `${p}.filters[${fi}]`, message: `unknown filter '${ft}'`, hint: s ? `did you mean '${s}'?` : `filters: ${Object.keys(FILTERS).join(", ")}` }); }
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
      (Array.isArray(c.effects) ? c.effects : []).forEach((f: any, fi: number) => { // a non-list is already a type error
        const ft = typeof f === "string" ? f : f?.type;
        if (!own(EFFECTS, ft)) { const s = suggest(ft, Object.keys(EFFECTS)); issues.push({ level: "error", path: `${p}.effects[${fi}]`, message: `unknown effect '${ft}'`, hint: s ? `did you mean '${s}'?` : `effects: ${Object.keys(EFFECTS).join(", ")}` }); }
        else if (f && typeof f === "object") checkFields(f, effectTable(ft), `${p}.effects[${fi}]`, issues, `${ft} effect`);
      });
      for (const [prop, kfs] of Object.entries(c.keyframes || {})) {
        const n0 = issues.length;
        if (!ANIMATABLE.includes(prop)) { const s = suggest(prop, ANIMATABLE); issues.push({ level: "error", path: `${p}.keyframes.${prop}`, message: `'${prop}' is not animatable`, hint: s ? `did you mean '${s}'?` : `animatable: ${ANIMATABLE.join(", ")}` }); continue; }
        if (prop === "speed" && !RAMPS.has(c.type)) { issues.push({ level: "error", path: `${p}.keyframes.speed`, message: `a ${c.type} clip cannot ramp its speed`, hint: "speed ramps work on video clips" + ("speed" in fieldsFor(c.type) ? "; this clip takes a constant `speed`" : "") }); continue; }
        if (!Array.isArray(kfs) || !kfs.length) { issues.push({ level: "error", path: `${p}.keyframes.${prop}`, message: "keyframes must be a non-empty list of [t, value, easing?]" }); continue; }
        for (const k of kfs as any[]) {
          const kk = Array.isArray(k) ? k : k && typeof k === "object" ? [k.t, k.v ?? k.value, k.ease] : null;
          if (!kk || kk.length < 2 || kk[1] === undefined) issues.push({ level: "error", path: `${p}.keyframes.${prop}`, message: `bad keyframe ${JSON.stringify(k)}; use [t, value] or [t, value, 'ease_out']` });
          else if (kk[2] && !EASINGS.includes(kk[2])) issues.push({ level: "error", path: `${p}.keyframes.${prop}`, message: `unknown easing '${kk[2]}'`, hint: `easings: ${EASINGS.join(", ")}` });
          else if (prop === "speed") {
            const v = Number(kk[1]);
            if (!(v >= SPEED_MIN && v <= SPEED_MAX)) issues.push({ level: "error", path: `${p}.keyframes.speed`, message: `speed keyframe ${JSON.stringify(kk[1])} must be ${SPEED_MIN}..${SPEED_MAX}` });
          } else if (own(CLIP_RANGES, prop) && !(Number.isFinite(Number(kk[1])) && keyframeRange(prop)[0](Number(kk[1]))))
            issues.push({ level: "error", path: `${p}.keyframes.${prop}`, message: `${prop} keyframe ${JSON.stringify(kk[1])} must be ${keyframeRange(prop)[1]}` });
        }
        const parsed = issues.length === n0; // every keyframe is well formed, so parseKfs reads them
        if (prop === "speed") {
          if (isRetimed(c)) issues.push({ level: "error", path: `${p}.speed`, message: `'${c.id}' has speed ${c.speed} and a speed ramp; the ramp sets the speed and \`speed\` would be ignored`, hint: "a ramp sets the speed; remove `speed` or the ramp" });
          const la = linkedAudio(tl, c).map(([, x]) => x.id);
          if (la.length) issues.push({ level: "error", path: `${p}.keyframes.speed`, message: `video '${c.id}' has a speed ramp and detached audio '${la.join("', '")}', which plays at constant speed and drifts from the picture`,
            hint: la.length > 1 ? `no op joins the ${la.length} audio pieces: ${la.map((id) => `remove_clip id=${id}`).join(", ")} to drop that audio and its processing, then update_clip id=${c.id} muted=false so the video's own sound (which follows the ramp) plays`
              : `attach_audio id=${c.id} puts the sound back on the video with its processing, and the video's own sound follows the ramp; if attach_audio refuses because the audio no longer lines up, make the field it names match the video's, or remove_clip id=${la[0]} to drop that audio and its processing` });
          if (parsed) overshootIssues(kfs as any[], `${p}.keyframes.speed`, issues);
        }
      }
      if (o.fontCheck && (c.type === "text" || c.type === "captions")) {
        const r = o.fontCheck(c.font, fontSample(c)!);
        if (r.error) issues.push({ level: "error", path: `${p}.font`, message: r.error, hint: r.hint });
        else {
          const named = c.font ? `font '${c.font}'` : "the default font";
          if (r.fallback) issues.push({ level: "info", path: `${p}.font`, message: `${named} lacks some characters; '${r.fallback}' is used for them` });
          if (r.uncovered) issues.push({ level: "warning", path: `${p}.font`, message: `no installed font has ${[...r.uncovered].map((x) => `'${x}'`).join(" ")}: ${named} draws them as empty boxes`,
            hint: "remove or replace them, or pass a font file (.ttf/.otf) that has them as `font`" });
        }
      }
      if (c.attach_to) {
        const t = byId(c.attach_to), at = `${p}.attach_to`;
        if (!t) issues.push({ level: "error", path: at, message: `attached to missing clip '${c.attach_to}'`, hint: "attach to an existing clip id, or remove attach_to" });
        else if (t === c) issues.push({ level: "error", path: at, message: "a clip cannot attach to itself", hint: "attach to another clip, or remove attach_to" });
        else for (let x: Clip | undefined = t, seen = new Set<Clip>(); x && !seen.has(x); x = x.attach_to ? byId(x.attach_to) : undefined) {
          seen.add(x);
          if (x.attach_to === c.id) { issues.push({ level: "error", path: at, message: `attached to '${t.id}', which is attached back to it`, hint: "break the cycle: remove attach_to from one of the clips" }); break; }
        }
        if (tr.magnetic && !c.until_end) issues.push({ level: "warning", path: `${p}.attach_to`, message: "on a magnetic track attach_to places this clip at its target, and with match_duration true takes its length from it, but the clips after it stay in track order (their starts are computed)" });
        if (tr.magnetic && c.until_end) issues.push({ level: "error", path: `${p}.attach_to`, message: "an until_end clip on a magnetic track is placed by track order, so attach_to cannot place it", hint: "remove attach_to, or put the clip on a track that is not magnetic" });
        if (tr.magnetic && c.match_duration === true) {
          let x = byId(c.attach_to);
          for (const seen = new Set<Clip>(); x && !x.until_end && !seen.has(x); x = lengthTarget(x) === undefined ? undefined : byId(lengthTarget(x)!)) seen.add(x);
          if (x?.until_end) issues.push({ level: "error", path: `${p}.match_duration`, message: `on a magnetic track this length follows '${x.id}', which has until_end, and its length is settled only after the track is laid out`, hint: "give the clip its own duration, or put it on a track that is not magnetic" });
        }
      }
      if (typeof c.match_duration === "string") {
        const at = `${p}.match_duration`;
        if (c.until_end) issues.push({ level: "error", path: at, message: "until_end and match_duration both set the length", hint: "keep one" });
        const t = byId(c.match_duration), bad = (message: string, hint: string) => issues.push({ level: "error", path: at, message, hint });
        if (!t) bad(`follows missing clip '${c.match_duration}'`, "name an existing clip id, or remove match_duration");
        else if (t === c) bad("a clip cannot follow its own duration", "name another clip");
        else if (t.until_end) bad(`'${t.id}' has until_end, so its length follows the timeline end`, "follow a clip with its own duration");
        else for (let x: Clip | undefined = t, seen = new Set<Clip>(); x && lengthTarget(x) !== undefined && !seen.has(x); x = byId(lengthTarget(x)!)) {
          seen.add(x);
          const next = byId(lengthTarget(x)!);
          if (next?.until_end) { bad(`'${t.id}' takes its length from '${next.id}', which has until_end`, "follow a clip with its own duration"); break; }
          if (lengthTarget(x) === c.id) { bad(`follows '${t.id}', which follows it back`, "break the cycle: give one of the clips its own duration"); break; }
        }
      }
      if (c.transition && ci > 0 && !tr.magnetic && !(prevEnd !== null && start < prevEnd - 1e-6)) issues.push({ level: "warning", path: `${p}.transition`, message: "on a non-magnetic track a transition only works if this clip overlaps the previous one" });
      if (!tr.magnetic && kind !== "audio" && prevEnd !== null && start < prevEnd - 1e-6 && !c.transition)
        issues.push({ level: "info", path: p, message: `overlaps the previous clip on '${tr.id}' (drawn on top)` });
      prevEnd = Math.max(prevEnd ?? 0, start + dur);
      if (c.type === "compound") {
        if (!Array.isArray(c.tracks)) { issues.push({ level: "error", path: `${p}.tracks`, message: "compound clip needs 'tracks' (a list of nested tracks)", hint: "create one with make_compound" }); return; }
        let cin = 0;
        try { cin = parseTime(c.in ?? 0); if (cin < 0) issues.push({ level: "error", path: `${p}.in`, message: "in must be >= 0" }); } catch (e: any) { issues.push({ level: "error", path: `${p}.in`, message: e.message, hint: e.hint }); }
        let down = DEAD, sink: Flow["sink"];
        if (vis) { // a retimed compound inside another one still warns for its own clips: they stay silent until both play at speed 1
          const sp = Number(c.speed ?? 1) || 1;
          if (isRetimed(c)) sink = { audio: false, captions: false };
          down = { gain: c.muted ? 0 : tf.gain * Number(c.volume ?? 1), captions: tf.captions, w0: cin + (vis[0] - start) * sp, w1: cin + (vis[1] - start) * sp, sink: sink ?? flow.sink };
        }
        validateTracks(subTimeline(tl, c), o, issues, clipIds, p, down);
        if (sink?.audio) issues.push({ level: "warning", path: `${p}.speed`, message: `compound plays at speed ${c.speed}: its nested audio is not mixed`, hint: "set speed 1, or detach the audio before retiming" });
        if (sink?.captions) issues.push({ level: "warning", path: `${p}.speed`, message: `compound plays at speed ${c.speed}: its nested captions are not exported as subtitles (export_captions, render subtitles=true)`, hint: "set speed 1, or move the captions out of the compound" });
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

/** Keys that would reach the prototype chain are refused wherever a patch or a dotted key walks into an object, and where an op argument is used as a key. */
export const isProtoKey = (k: string) => k === "__proto__" || k === "constructor" || k === "prototype";
export function plainKey(k: string) {
  if (isProtoKey(k)) throw new EditError(`field name '${k}' is not allowed`, "bad_key", "use a different field name");
  return k;
}

/** Op input is walked once for keys that would reach the prototype chain (JSON.parse makes them own data properties); the ops then copy keys without per-site guards. */
export function refuseProtoKeys(v: unknown): void {
  if (!v || typeof v !== "object") return;
  if (Array.isArray(v)) { for (const x of v) refuseProtoKeys(x); return; }
  for (const [k, x] of Object.entries(v)) { plainKey(k); refuseProtoKeys(x); }
}

export function deepMerge(dst: Dict, patch: Dict): Dict {
  for (const [k, v] of Object.entries(patch)) {
    plainKey(k);
    if (v === null) delete dst[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k]) && k !== "keyframes") deepMerge(dst[k], v);
    else dst[k] = structuredClone(v);
  }
  return dst;
}

export function setDotted(obj: Dict, key: string, value: unknown) {
  const parts = key.split(".").map(plainKey);
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  if (value === null) delete o[parts.at(-1)!];
  else o[parts.at(-1)!] = value;
}

export const clone = <X>(x: X): X => structuredClone(x);
