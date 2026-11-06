// Audio processing fields (clip + track): denoise, eq, compressor, pan, pitch, normalize.
// Validation and FFmpeg filter strings are pure; noiseFloor/loudness run FFmpeg once per processed clip.
// No model.ts import: model.ts imports this file for its field table and validation.
import { spawnSync } from "node:child_process";

export const AUDIO_FX_KEYS = ["denoise", "eq", "compressor", "pan", "pitch", "normalize"] as const;
/** Track-level keys applied to every clip on the track (they depend on each source); the rest process the track bus. */
export const PER_CLIP_KEYS = ["denoise", "normalize", "pitch"] as const;

export interface Band { type: string; f?: number; gain?: number; q?: number; intensity?: number }
export const EQ_BANDS: Record<string, { doc: string; keys: string[] }> = {
  high_pass: { doc: "{f: 80} cut below f Hz (rumble, handling noise)", keys: ["f"] },
  low_pass: { doc: "{f: 12000} cut above f Hz", keys: ["f"] },
  peak: { doc: "{f, gain dB, q: 1} bell boost/cut", keys: ["f", "gain", "q"] },
  low_shelf: { doc: "{f: 120, gain dB}", keys: ["f", "gain"] },
  high_shelf: { doc: "{f: 8000, gain dB}", keys: ["f", "gain"] },
  de_ess: { doc: "{intensity: 0.5} tame sibilance (s/sh)", keys: ["intensity"] },
};
export const EQ_PRESETS: Record<string, Band[]> = {
  voice_clarity: [{ type: "high_pass", f: 80 }, { type: "peak", f: 250, gain: -3, q: 1 }, { type: "peak", f: 3000, gain: 3, q: 1 }, { type: "high_shelf", f: 10000, gain: 2 }],
  low_cut: [{ type: "high_pass", f: 80 }],
  de_ess: [{ type: "de_ess", intensity: 0.5 }],
};
export interface Comp { threshold: number; ratio: number; attack: number; release: number; makeup: number; knee: number }
export const COMPRESSORS: Record<string, Comp> = {
  voice: { threshold: -20, ratio: 4, attack: 5, release: 80, makeup: 4, knee: 2.8 },
  music: { threshold: -16, ratio: 2, attack: 20, release: 250, makeup: 2, knee: 2.8 },
  gentle: { threshold: -12, ratio: 1.5, attack: 20, release: 200, makeup: 1, knee: 4 },
};
const COMP_RANGE: Record<keyof Comp, [number, number]> = { threshold: [-60, 0], ratio: [1, 20], attack: [0.01, 2000], release: [0.01, 9000], makeup: [0, 36], knee: [1, 8] };
const BAND_RANGE: Record<string, [number, number]> = { f: [20, 20000], gain: [-24, 24], q: [0.1, 10], intensity: [0, 1] };
export const NORMALIZE_LUFS = -16;
export const DENOISE_STRENGTH = 0.5;
const FLOOR_PLATEAU_DB = 5; // measured P10-P1: pauses <= 1.3 dB, speech under P10 >= 3.1 dB; the 3-5 dB band does not clip endings, so P1 only above 5

export const AUDIO_FX_DOC = {
  denoise: "true or strength 0..1 (0.5): FFT noise reduction + soft expander in pauses; the noise floor is measured per clip",
  eq: `preset or list of presets/bands: ${Object.keys(EQ_PRESETS).join("|")} | {type: ${Object.keys(EQ_BANDS).join("|")}, f, gain, q, intensity}`,
  compressor: `${Object.keys(COMPRESSORS).join("|")} or {type: preset (gentle), threshold dB, ratio, attack ms, release ms, makeup dB, knee}`,
  pan: "-1 (left) .. 0 .. 1 (right) stereo balance",
  pitch: "semitones -12..12; duration unchanged (resample + time-stretch: formants shift with it: large shifts sound chipmunk/giant)",
  normalize: `true (${NORMALIZE_LUFS} LUFS) or target LUFS -40..-5: loudness gain before volume`,
};

interface FxIssue { path: string; message: string; hint?: string }
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Range/name checks for the audio fields of a clip or track (types are checked by the field tables). */
export function audioFxIssues(o: Record<string, any>, path: string): FxIssue[] {
  const out: FxIssue[] = [];
  const range = (k: string, v: unknown, [lo, hi]: [number, number], p = `${path}.${k}`) => {
    if (isNum(v) && (v < lo || v > hi)) out.push({ path: p, message: `${k} ${v} is out of range ${lo}..${hi}` });
  };
  range("denoise", o.denoise, [0, 1]);
  range("pan", o.pan, [-1, 1]);
  range("pitch", o.pitch, [-12, 12]);
  range("normalize", o.normalize, [-40, -5]);
  if (o.eq != null) (Array.isArray(o.eq) ? o.eq : [o.eq]).forEach((b: any, i: number) => {
    const p = `${path}.eq${Array.isArray(o.eq) ? `[${i}]` : ""}`;
    if (typeof b === "string") {
      if (!EQ_PRESETS[b]) out.push({ path: p, message: `unknown eq preset '${b}'`, hint: `presets: ${Object.keys(EQ_PRESETS).join(", ")}; or a band {type: ${Object.keys(EQ_BANDS).join("|")}, ...}` });
    } else if (!b || typeof b !== "object" || !EQ_BANDS[b.type]) {
      out.push({ path: p, message: `unknown eq band ${JSON.stringify(b?.type ?? b)}`, hint: `bands: ${Object.entries(EQ_BANDS).map(([k, v]) => `${k} ${v.doc}`).join("; ")}` });
    } else for (const [k, v] of Object.entries(b)) {
      if (k === "type") continue;
      if (!EQ_BANDS[b.type].keys.includes(k)) out.push({ path: `${p}.${k}`, message: `'${k}' is not a ${b.type} parameter`, hint: `${b.type}: ${EQ_BANDS[b.type].doc}` });
      else if (!isNum(v)) out.push({ path: `${p}.${k}`, message: `${k} must be a number` });
      else range(k, v, BAND_RANGE[k], `${p}.${k}`);
    }
  });
  const c = o.compressor;
  if (typeof c === "string" && !COMPRESSORS[c]) out.push({ path: `${path}.compressor`, message: `unknown compressor preset '${c}'`, hint: `presets: ${Object.keys(COMPRESSORS).join(", ")}` });
  if (c && typeof c === "object") for (const [k, v] of Object.entries(c)) {
    const p = `${path}.compressor.${k}`;
    if (k === "type") { if (!COMPRESSORS[v as string]) out.push({ path: p, message: `unknown compressor preset '${v}'`, hint: `presets: ${Object.keys(COMPRESSORS).join(", ")}` }); }
    else if (!(k in COMP_RANGE)) out.push({ path: p, message: `unknown compressor parameter '${k}'`, hint: `parameters: type, ${Object.keys(COMP_RANGE).join(", ")}` });
    else if (!isNum(v)) out.push({ path: p, message: `${k} must be a number` });
    else range(k, v, COMP_RANGE[k as keyof Comp], p);
  }
  return out;
}

// ------------------------------------------------------------------ filter strings
const f3 = (x: number) => +x.toFixed(3);
export function eqFilters(eq: unknown): string[] {
  if (eq == null || eq === false) return [];
  const bands = (Array.isArray(eq) ? eq : [eq]).flatMap((b: any) => (typeof b === "string" ? EQ_PRESETS[b] : [b]));
  return bands.map((b: Band) => {
    switch (b.type) {
      case "high_pass": return `highpass=f=${b.f ?? 80}:p=2`;
      case "low_pass": return `lowpass=f=${b.f ?? 12000}:p=2`;
      case "peak": return `equalizer=f=${b.f ?? 1000}:t=q:w=${b.q ?? 1}:g=${b.gain ?? 0}`;
      case "low_shelf": return `lowshelf=f=${b.f ?? 120}:g=${b.gain ?? 0}`;
      case "high_shelf": return `highshelf=f=${b.f ?? 8000}:g=${b.gain ?? 0}`;
      case "de_ess": return `deesser=i=${b.intensity ?? 0.5}:m=0.5:f=0.5`;
      default: throw new Error(`unknown eq band '${b.type}'`); // validation rejects this earlier
    }
  });
}

export function compressorFilter(c: unknown): string[] {
  if (!c) return [];
  const p: Comp = typeof c === "string" ? COMPRESSORS[c] : { ...COMPRESSORS[(c as any).type ?? "gentle"], ...(c as object) };
  const lin = (db: number) => (10 ** (db / 20)).toFixed(6);
  return [`acompressor=threshold=${lin(p.threshold)}:ratio=${p.ratio}:attack=${p.attack}:release=${p.release}:makeup=${lin(p.makeup)}:knee=${p.knee}`];
}

/** Balance: the far side is attenuated linearly, centre stays at unity gain. */
export function panFilter(pan: unknown): string[] {
  const p = Number(pan ?? 0);
  if (!p) return [];
  return [`pan=stereo|c0=${f3(Math.min(1, 1 - p))}*c0|c1=${f3(Math.min(1, 1 + p))}*c1`];
}

export function atempo(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) { out.push("atempo=2.0"); s /= 2; }
  while (s < 0.5) { out.push("atempo=0.5"); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-4) out.push(`atempo=${s.toFixed(5)}`);
  return out;
}

/** Pitch shift without changing duration: resample-speed by r, then time-stretch back by 1/r. */
export function pitchFilters(semitones: unknown, sr: number): string[] {
  const s = Number(semitones ?? 0);
  if (!s) return [];
  const rate = Math.round(sr * 2 ** (s / 12));
  return [`asetrate=${rate}`, `aresample=${sr}`, ...atempo(sr / rate)];
}

/** Two afftdn stages (white-noise model, then a model that follows coloured noise) with the floor set just above the measured noise,
 * then a soft expander 6 dB above the measured floor: pauses lose the residual (musical) noise, speech passes untouched. */
export function denoiseFilters(strength: number, floorDb: number): string[] {
  const nf = Math.max(-80, Math.min(-20, floorDb + 6 * strength)), lin = (db: number) => (10 ** (db / 20)).toFixed(5);
  return [`afftdn=nr=${(6 + 24 * strength).toFixed(1)}:nf=${nf.toFixed(1)}`, `afftdn=nt=v:nr=${(12 + 12 * strength).toFixed(1)}:nf=${nf.toFixed(1)}`,
    `agate=threshold=${lin(Math.min(-20, floorDb + 6))}:ratio=2:range=${lin(-6 - 12 * strength)}:attack=10:release=250`];
}

export const denoiseStrength = (v: unknown) => (v === true ? DENOISE_STRENGTH : isNum(v) && v > 0 ? v : 0);
export const normalizeTarget = (v: unknown) => (v === true ? NORMALIZE_LUFS : isNum(v) ? v : null);

// ------------------------------------------------------------------ measurement
/** Noise floor estimate in dBFS: 10th percentile of 50 ms RMS windows (digital silence ignored); null when there is none.
 * Stationary noise gives a flat bottom (P10 within ~1.5 dB of P1). When P10 sits more than FLOOR_PLATEAU_DB above P1 there are no
 * pauses (continuous speech) and P10 is soft speech, which would set the gate and afftdn above quiet word endings: use P1 then. */
export function noiseFloor(path: string, start: number, len: number): number | null {
  const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", path, "-vn", "-af",
    `atrim=start=${start}:duration=${len},aresample=48000,aformat=channel_layouts=mono,asetnsamples=n=2400:p=0,` +
    "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const v = [...(r.stdout || "").matchAll(/RMS_level=(-?[\d.]+)/g)].map((m) => +m[1]).filter((x) => x > -100).sort((a, b) => a - b);
  if (!v.length) return null;
  const p10 = v[Math.floor(v.length * 0.1)], p1 = v[Math.floor(v.length * 0.01)];
  return p10 - p1 > FLOOR_PLATEAU_DB ? p1 : p10;
}

/** Integrated loudness (LUFS) of `input` args through filter chain `af`; null when too short/quiet to measure. */
export function loudness(input: string[], af: string): number | null {
  const r = spawnSync("ffmpeg", ["-v", "info", "-nostdin", ...input, "-vn", "-af", `${af ? af + "," : ""}ebur128`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const txt = (r.stderr || "").slice((r.stderr || "").lastIndexOf("Summary:"));
  const m = /I:\s+(-?[\d.]+)\s+LUFS/.exec(txt);
  return m && +m[1] > -70 ? +m[1] : null;
}
