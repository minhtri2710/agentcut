// Audio processing fields (clip + track): denoise, eq, compressor, pan, pitch, normalize.
// Validation and FFmpeg filter strings are pure; noiseFloor/loudness run FFmpeg once per processed clip.
// No model.ts import: model.ts imports this file for its field table and validation.
import { inp } from "./ffinput.ts";
import { run } from "./proc.ts";

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
// noiseFloor constants (see the docstring). Measured on ~21k synthetic and Linh clips: pauses, 5-30 s clips with a 300 ms lead-in, -95..-40 dBFS noise,
// dither, partly-zero windows, fades and dropouts.
const FLOOR_SILENCE_DB = -90, FLOOR_RUN = 3, FLOOR_BAND_DB = 1, FLOOR_SPAN_DB = 3;

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
/** An audio parameter as the only form that enters a filter graph: a finite number (null/undefined gives the default). */
function fin(v: unknown, dflt: number | undefined, what: string): number {
  const n = Number(v ?? dflt);
  if (!Number.isFinite(n)) throw new Error(`${what} must be a finite number`); // validation rejects this earlier
  return n;
}
export function eqFilters(eq: unknown): string[] {
  if (eq == null || eq === false) return [];
  const bands = (Array.isArray(eq) ? eq : [eq]).flatMap((b: any) => (typeof b === "string" ? EQ_PRESETS[b] : [b]));
  return bands.map((b: Band) => {
    const n = (k: "f" | "q" | "gain" | "intensity", d: number) => fin(b[k], d, `eq ${b.type} ${k}`);
    switch (b.type) {
      case "high_pass": return `highpass=f=${n("f", 80)}:p=2`;
      case "low_pass": return `lowpass=f=${n("f", 12000)}:p=2`;
      case "peak": return `equalizer=f=${n("f", 1000)}:t=q:w=${n("q", 1)}:g=${n("gain", 0)}`;
      case "low_shelf": return `lowshelf=f=${n("f", 120)}:g=${n("gain", 0)}`;
      case "high_shelf": return `highshelf=f=${n("f", 8000)}:g=${n("gain", 0)}`;
      case "de_ess": return `deesser=i=${n("intensity", 0.5)}:m=0.5:f=0.5`;
      default: throw new Error(`unknown eq band '${b.type}'`); // validation rejects this earlier
    }
  });
}

export function compressorFilter(c: unknown): string[] {
  if (!c) return [];
  const p: Comp = typeof c === "string" ? COMPRESSORS[c] : { ...COMPRESSORS[(c as any).type ?? "gentle"], ...(c as object) };
  const n = (k: keyof Comp) => fin(p[k], undefined, `compressor ${k}`);
  const lin = (db: number) => (10 ** (db / 20)).toFixed(6);
  return [`acompressor=threshold=${lin(n("threshold"))}:ratio=${n("ratio")}:attack=${n("attack")}:release=${n("release")}:makeup=${lin(n("makeup"))}:knee=${n("knee")}`];
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
 * then a soft expander 6 dB above the measured floor: pauses lose the residual (musical) noise, speech passes untouched.
 * Each afftdn stage delays its output by 2*floor(sr/80) samples (25 ms; measured at 8-96 kHz) and keeps the length, so the end is padded by the delay and the start
 * trimmed after the stages: the clip stays sample-aligned and keeps its last 50 ms. agate, EQ and compressor add no delay (measured). */
export function denoiseFilters(strength: number, floorDb: number, sr: number): string[] {
  const nf = Math.max(-80, Math.min(-20, floorDb + 6 * strength)), lin = (db: number) => (10 ** (db / 20)).toFixed(5), delay = 4 * Math.floor(sr / 80);
  return [`apad=pad_len=${delay}`, `afftdn=nr=${(6 + 24 * strength).toFixed(1)}:nf=${nf.toFixed(1)}`, `afftdn=nt=v:nr=${(12 + 12 * strength).toFixed(1)}:nf=${nf.toFixed(1)}`,
    `atrim=start_sample=${delay}`, "asetpts=PTS-STARTPTS",
    `agate=threshold=${lin(Math.min(-20, floorDb + 6))}:ratio=2:range=${lin(-6 - 12 * strength)}:attack=10:release=250`];
}

export const denoiseStrength = (v: unknown) => (v === true ? DENOISE_STRENGTH : isNum(v) && v > 0 ? v : 0);
export const normalizeTarget = (v: unknown) => (v === true ? NORMALIZE_LUFS : isNum(v) ? v : null);

// ------------------------------------------------------------------ measurement
/** Noise floor estimate in dBFS from 50 ms RMS windows; null when there is no signal. Two bounds hold in every branch: the result is never above
 * the plain 10th percentile of all windows > -100 dBFS (final window included, the estimate before the plateau rule), and it is taken from
 * the noise, not from soft speech, whenever the clip has 3+ noise-only windows above -90 dBFS and fewer than 10% of windows at or below -90
 * (see Limits).
 * Stationary noise is a flat bottom of the sorted windows (3 windows within 1 dB), speech is not. The floor is the median of the lowest such
 * run, taken with every window up to FLOOR_SPAN_DB above its start. The final window (may be partial) is ignored for the run, and so are
 * windows at or below FLOOR_SILENCE_DB (-90, under the 16-bit floor): dither or digital padding, not noise.
 * Clean recording: only when that 10th percentile is itself at or below FLOOR_SILENCE_DB are the windows below -90 the pauses, and the floor
 * is their median.
 * Limits (measured on the D-i grid, 3162 cells; each leaves the floor too LOW, i.e. less noise reduction, never extra clipping, unless noted):
 * - 3 equal dropouts inside pauses: up to 4.1 dB low; 8: up to 5.0 dB; dither or gated pauses at 3-7% of the clip, aligned to
 *   the 50 ms windows: up to 1.5 dB low; unaligned blocks (edits, mutes, gate release ramps) leave partial boundary windows below the noise,
 *   up to 6.9 dB low (measured on the earlier grid, not rerun on the D-i grid);
 * - fades baked into the source: 1 s linear up to 13.0 dB low, 1 s linear in dB up to 29.1; 2 s linear 2.5 dB low on median and up to 19.0,
 *   2 s linear in dB 16.8 on median and up to 29.9;
 * - dither or a closed upstream gate at 10% of the clip or more: the 10th percentile lands in it, so the floor is that percentile (about
 *   -91..-96 dBFS, as before) and the gate and afftdn do almost nothing;
 * - a clip with no 3 noise-only windows (150 ms) returns the 10th percentile, and so does a clean recording (noise below -90) whose lead-in
 *   is under 10% of the clip, where the lead-in counts as dither: the floor then sits on speech and can clip soft endings, but it is
 *   never higher than before. */
export async function noiseFloor(path: string, start: number, len: number, signal?: AbortSignal): Promise<number | null> {
  const r = await run("ffmpeg", ["-v", "error", "-nostdin", ...inp(path), "-vn", "-af",
    `atrim=start=${start}:duration=${len},aresample=48000,aformat=channel_layouts=mono,asetnsamples=n=2400:p=0,` +
    "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f", "null", "-"], { signal, maxBuffer: 1 << 28 });
  const all = [...r.stdout.matchAll(/RMS_level=(-?[\d.]+)/g)].map((m) => +m[1]).filter((x) => x > -100);
  if (!all.length) return null;
  const byLevel = (a: number[]) => a.sort((x, y) => x - y), p10 = byLevel([...all])[Math.floor(all.length * 0.1)]; // c98537e's estimate: the ceiling
  const kept = all.length > 1 ? all.slice(0, -1) : all, low = byLevel(kept.filter((x) => x <= FLOOR_SILENCE_DB));
  if (p10 <= FLOOR_SILENCE_DB) return low.length ? Math.min(low[low.length >> 1], p10) : p10;
  const v = byLevel(kept.filter((x) => x > FLOOR_SILENCE_DB));
  for (let i = 0; i + FLOOR_RUN <= v.length; i++) {
    if (v[i + FLOOR_RUN - 1] - v[i] > FLOOR_BAND_DB) continue;
    let j = i + FLOOR_RUN;
    while (j < v.length && v[j] - v[i] <= FLOOR_SPAN_DB) j++;
    return Math.min(v[i + ((j - i) >> 1)], p10);
  }
  return p10;
}

/** Integrated loudness (LUFS) of `input` args through filter chain `af`; null when too short/quiet to measure. */
export async function loudness(input: string[], af: string, signal?: AbortSignal): Promise<number | null> {
  const r = await run("ffmpeg", ["-v", "info", "-nostdin", ...input, "-vn", "-af", `${af ? af + "," : ""}ebur128`, "-f", "null", "-"], { signal, maxBuffer: 1 << 28 });
  const txt = r.stderr.slice(r.stderr.lastIndexOf("Summary:"));
  const m = /I:\s+(-?[\d.]+)\s+LUFS/.exec(txt);
  return m && +m[1] > -70 ? +m[1] : null;
}
