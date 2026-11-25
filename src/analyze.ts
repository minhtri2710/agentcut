// Media analysis: beats (spectral flux + DP tracker, pure TS FFT), scene cuts, silence, loudness, TTS, transcription.
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitSentences } from "./captions.ts";
import { inp, VIDEO_MAP } from "./ffinput.ts";
import { needFfmpeg, probe, seekArgs } from "./media.ts";
import { EditError, suggest } from "./model.ts";
import { commit, createFile, tmpSibling } from "./safe-write.ts";
import type { Project } from "./project.ts";
import { run } from "./proc.ts";
import { has, httpSpeech, pickProvider, piperSpeech, providerInfo } from "./tts.ts";

async function decodeMono(path: string, sr: number, signal?: AbortSignal): Promise<Float32Array> {
  (await needFfmpeg());
  const r = await run("ffmpeg", ["-v", "error", "-nostdin", ...inp(path), "-vn", "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"], { signal, maxBuffer: 1 << 30, binary: true });
  if (r.status !== 0) throw new EditError(`cannot decode audio from ${path}: ${r.stderr.slice(0, 300)}`, "decode_failed");
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 4)));
}

/** The loudest sample per 1/rate s of a file's sound (mono mix), 0..255: the waveform the page draws on a clip. */
export async function peaks(path: string, rate = 50, signal?: AbortSignal): Promise<number[]> {
  const sr = 4000, y = await decodeMono(path, sr, signal), out = new Array<number>(Math.ceil((y.length * rate) / sr)).fill(0);
  for (let i = 0; i < y.length; i++) { const k = Math.floor((i * rate) / sr), v = Math.abs(y[i]); if (v > out[k]) out[k] = v; }
  return out.map((v) => Math.min(255, Math.round(v * 255)));
}

/** Where the samples of a 16-bit PCM WAV (what our ffmpeg calls write) open on fd lie: the data chunk's offset and byte length (bounded by the file), rate, channels, bits. */
export function wavData(fd: number, path: string) {
  const size = fstatSync(fd).size, h = Buffer.alloc(24);
  readSync(fd, h, 0, 12, 0);
  if (h.toString("ascii", 0, 4) !== "RIFF" || h.toString("ascii", 8, 12) !== "WAVE") throw new EditError(`not a WAV file: ${path}`, "decode_failed");
  let o = 12, channels = 0, rate = 0, bits = 0;
  while (o + 8 <= size) {
    h.fill(0); readSync(fd, h, 0, 24, o);
    const id = h.toString("ascii", 0, 4), n = h.readUInt32LE(4);
    if (id === "fmt ") { channels = h.readUInt16LE(10); rate = h.readUInt32LE(12); bits = h.readUInt16LE(22); }
    if (id === "data") {
      if (bits !== 16 || !channels) throw new EditError(`unsupported WAV (${bits}-bit, ${channels} ch): ${path}`, "decode_failed");
      return { offset: o + 8, bytes: Math.min(n, size - o - 8), rate, channels, bits };
    }
    o += 8 + n + (n % 2);
  }
  throw new EditError(`WAV has no data chunk: ${path}`, "decode_failed");
}

/** In-place iterative radix-2 FFT. re/im length must be a power of two. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

export async function beats(path: string, signal?: AbortSignal, minBpm = 60, maxBpm = 200) {
  const sr = 22050, hop = 512, nfft = 2048;
  const y = await decodeMono(path, sr, signal);
  if (y.length < nfft * 4) throw new EditError("audio too short for beat detection", "too_short");
  const nfr = 1 + Math.floor((y.length - nfft) / hop);
  const bins = Math.floor(8000 / (sr / nfft));
  const win = new Float64Array(nfft).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1)));
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  const mag = [new Float64Array(bins), new Float64Array(bins)];
  const flux = new Float64Array(nfr);
  // a plain function, not the async body: an await in a hot loop costs ~10% of the wall time (measured)
  const stft = (from: number, to: number) => {
    for (let f = from; f < to; f++) {
      const off = f * hop, cur = mag[f & 1], prev = mag[(f & 1) ^ 1];
      for (let i = 0; i < nfft; i++) { re[i] = y[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let s = 0;
      for (let b = 0; b < bins; b++) {
        cur[b] = Math.log1p(100 * Math.hypot(re[b], im[b]));
        if (f > 0) s += Math.max(0, cur[b] - prev[b]);
      }
      flux[f] = s / bins;
    }
  };
  // the STFT is all of the DSP's time (~50 us a frame): hand the loop back every 128 frames, so a call never holds it past ~10 ms and an abort lands within a batch
  for (let f = 0; f < nfr; f += 128) {
    if (f) { await new Promise((r) => setImmediate(r)); signal?.throwIfAborted(); }
    stft(f, Math.min(nfr, f + 128));
  }
  // remove slow trend, half-wave rectify, normalise
  const onset = new Float64Array(nfr);
  let acc = 0;
  const W = 16;
  const pre = new Float64Array(nfr + 1);
  for (let i = 0; i < nfr; i++) pre[i + 1] = pre[i] + flux[i];
  for (let i = 0; i < nfr; i++) {
    const a = Math.max(0, i - W / 2), b = Math.min(nfr, i + W / 2);
    onset[i] = Math.max(0, flux[i] - (pre[b] - pre[a]) / W);
    acc += onset[i] * onset[i];
  }
  const sd = Math.sqrt(acc / nfr) + 1e-9;
  for (let i = 0; i < nfr; i++) onset[i] /= sd;
  const fps = sr / hop;
  const lo = Math.floor((fps * 60) / maxBpm), hi = Math.floor((fps * 60) / minBpm);
  let bestLag = lo, best = -Infinity;
  for (let lag = lo; lag < hi; lag++) {
    let s = 0;
    for (let i = lag; i < nfr; i++) s += onset[i] * onset[i - lag];
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (s * prior > best) { best = s * prior; bestLag = lag; }
  }
  const period = bestLag;
  // dynamic programming (Ellis 2007)
  const alpha = 100, score = Float64Array.from(onset), back = new Int32Array(nfr).fill(-1);
  const pr: number[] = [], cost: number[] = [];
  for (let d = -2 * period; d <= -Math.floor(period / 2); d++) { pr.push(d); cost.push(-alpha * Math.log(-d / period) ** 2); }
  for (let i = 0; i < nfr; i++) {
    let bv = -Infinity, bj = -1;
    for (let k = 0; k < pr.length; k++) {
      const j = i + pr[k];
      if (j < 0) continue;
      const v = score[j] + cost[k];
      if (v > bv) { bv = v; bj = j; }
    }
    if (bj >= 0) { score[i] = onset[i] + bv; back[i] = bj; }
  }
  let i = Math.max(0, nfr - period * 2);
  for (let j = i; j < nfr; j++) if (score[j] > score[i]) i = j;
  const bt: number[] = [];
  while (i >= 0) { bt.push(i); i = back[i]; }
  bt.reverse();
  // sub-frame refinement + window-centre time
  const times: number[] = [], strength: number[] = [];
  for (const b of bt) {
    let j = b;
    for (let x = Math.max(1, b - 2); x <= Math.min(nfr - 2, b + 2); x++) if (onset[x] > onset[j]) j = x;
    const y0 = onset[j - 1] ?? onset[j], y1 = onset[j], y2 = onset[j + 1] ?? onset[j];
    const den = y0 - 2 * y1 + y2;
    const frac = Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
    times.push(+(((j + frac) * hop + nfft / 2) / sr).toFixed(3));
    strength.push(onset[j]);
  }
  const med = [...strength].sort((a, b) => a - b)[Math.floor(strength.length / 2)] ?? 0;
  while (times.length && strength[0] < 0.1 * med) { times.shift(); strength.shift(); }
  let tempo = (60 * fps) / period;
  if (times.length >= 4) {
    const d = times.slice(1).map((t, k) => t - times[k]).sort((a, b) => a - b);
    tempo = 60 / d[Math.floor(d.length / 2)];
  }
  let phase = 0;
  if (times.length >= 8) {
    let bs = -1;
    for (let o = 0; o < 4; o++) { let s = 0; for (let k = o; k < strength.length; k += 4) s += strength[k]; if (s > bs) { bs = s; phase = o; } }
  }
  return {
    source: path, tempo_bpm: +tempo.toFixed(2), beat_interval: +(60 / tempo).toFixed(4), count: times.length,
    beats: times, bars: times.filter((_, k) => k % 4 === phase), duration: +(y.length / sr).toFixed(3),
  };
}

export async function scenes(path: string, threshold = 0.3, signal?: AbortSignal) {
  (await needFfmpeg());
  const info = (await probe(path));
  const r = await run("ffmpeg", ["-v", "info", "-nostdin", ...inp(path), ...VIDEO_MAP, "-an", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { signal, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new EditError(`scene analysis failed: ${r.stderr.slice(-600)}`, "decode_failed", "check that the file contains decodable video");
  const cuts = [...r.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => +(+m[1]).toFixed(3));
  const dur = info.duration ?? 0;
  const b = [0, ...cuts, dur];
  const shots = b.slice(0, -1).map((s, i) => ({ start: s, end: b[i + 1], duration: +(b[i + 1] - s).toFixed(3) })).filter((s) => s.duration > 0.05);
  return { source: path, threshold, cuts, shots, duration: dur };
}

export async function silence(path: string, noiseDb = -35, minSilence = 0.4, signal?: AbortSignal) {
  (await needFfmpeg());
  const info = (await probe(path));
  if (!info.has_audio && info.kind !== "audio") throw new EditError("file has no audio", "no_audio");
  const r = await run("ffmpeg", ["-v", "info", "-nostdin", ...inp(path), "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, "-f", "null", "-"], { signal, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new EditError(`silence analysis failed: ${r.stderr.slice(-600)}`, "decode_failed", "check that the file contains decodable audio");
  const st = [...r.stderr.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => +m[1]);
  const en = [...r.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const dur = Number(info.duration ?? 0);
  const sil = st.map((s, i) => [+Math.max(0, s).toFixed(3), +(en[i] ?? dur).toFixed(3)]);
  const speech: number[][] = [];
  let t = 0;
  for (const [s, e] of sil) { if (s - t > 0.05) speech.push([+t.toFixed(3), s]); t = e; }
  if (dur - t > 0.05) speech.push([+t.toFixed(3), +dur.toFixed(3)]);
  return { source: path, noise_db: noiseDb, min_silence: minSilence, silences: sil, speech, duration: dur };
}

/** EBU R128 loudness of a file. A failed spawn leaves the metrics null, so a render that already ended is not failed for it; an abort rejects. */
export async function loudness(path: string, signal?: AbortSignal) {
  const { stderr } = await run("ffmpeg", ["-v", "info", "-nostdin", ...inp(path), "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], { signal, maxBuffer: 1 << 28 });
  const txt = stderr.slice(stderr.lastIndexOf("Summary:"));
  const grab = (l: string) => { const m = new RegExp(`${l}:\\s+(-?[\\d.]+|-inf)`).exec(txt); return m && m[1] !== "-inf" ? +m[1] : null; };
  return { source: path, integrated_lufs: grab("I"), range_lu: grab("LRA"), true_peak_dbfs: grab("Peak") };
}

export interface QaIssue { type: string; message: string; t?: number; end?: number; ids?: string[] }
/** Seconds a picture must hold still to count as frozen. */
const FREEZE_MIN = 1;

/** QA of a written video render against what was asked: the streams (picture, size, frame rate, length, sound) and pictures that hold still while a
 *  video clip plays (`moving`: timeline spans of the video clips that play footage; times are the output's plus `offset`, the range start).
 *  One probe and one low-resolution decode of the picture. */
export async function outputQa(path: string, want: { duration: number; width: number; height: number; fps: number; has_audio: boolean }, moving: { id: string; start: number; end: number }[], offset: number, signal?: AbortSignal) {
  const info = await probe(path), issues: QaIssue[] = [];
  if (!info.width) return { ok: false, issues: [{ type: "missing_video", message: `${path} has no picture stream` }] };
  if (info.width !== want.width || info.height !== want.height) issues.push({ type: "size_mismatch", message: `the file is ${info.width}x${info.height}, the render asked for ${want.width}x${want.height}` });
  if (Math.abs(Number(info.fps) - want.fps) > 0.01) issues.push({ type: "fps_mismatch", message: `the file plays at ${info.fps} fps, the render asked for ${want.fps}` });
  const len = Number(info.video_duration ?? info.duration ?? 0);
  if (Math.abs(len - want.duration) > Math.max(2 / want.fps, 0.05)) issues.push({ type: "duration_mismatch", message: `the picture lasts ${len.toFixed(3)} s, the render asked for ${want.duration.toFixed(3)} s` });
  if (info.has_audio !== want.has_audio) issues.push({ type: want.has_audio ? "missing_audio" : "unexpected_audio", message: want.has_audio ? "the timeline has audible clips but the file has no sound" : "the file has sound but the timeline has no audible clip" });
  const r = await run("ffmpeg", ["-v", "info", "-nostdin", ...inp(path), ...VIDEO_MAP, "-an", "-sn", "-vf", `scale=160:-2,freezedetect=n=-60dB:d=${FREEZE_MIN}`, "-f", "null", "-"], { signal, maxBuffer: 1 << 28 });
  if (r.status !== 0) issues.push({ type: "decode_failed", message: `the file's picture does not decode to its end: ${r.stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}` });
  const starts = [...r.stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => +m[1] + offset), ends = [...r.stderr.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => +m[1] + offset);
  starts.forEach((s, i) => {
    const e = ends[i] ?? offset + len, ids = [...new Set(moving.filter((c) => c.start < e - 1e-6 && c.end > s + 1e-6).map((c) => c.id))];
    if (ids.length) issues.push({ type: "frozen_picture", t: +s.toFixed(3), end: +e.toFixed(3), ids, message: `the picture holds still ${s.toFixed(2)}-${e.toFixed(2)} s while ${ids.join(", ")} ${ids.length > 1 ? "play" : "plays"}: still footage, or frames the decode repeated` });
  });
  return { ok: !issues.length, issues };
}

// ------------------------------------------------------------------ TTS
type Voice = { name: string; provider: string; full_name?: string; lang: string; sample: string };
function systemEngine(): { engine: "say" | "sapi" | "espeak"; exe: string | null } {
  const mac = process.platform === "darwin", win = process.platform === "win32";
  const bins = mac ? ["say"] : win ? ["powershell"] : ["espeak-ng", "espeak"];
  return { engine: mac ? "say" : win ? "sapi" : "espeak", exe: bins.find(has) ?? null };
}
function systemVoices(): Voice[] {
  const { engine, exe } = systemEngine();
  if (engine === "say") {
    const r = spawnSync("say", ["-v", "?"], { encoding: "utf8" });
    const out: Voice[] = [], seen = new Set<string>();
    for (const line of (r.stdout || "").split("\n")) {
      const m = /^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#\s*(.*)$/.exec(line);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ name: m[1].trim().replace(/\s*\(.*\)$/, ""), provider: "system", full_name: m[1].trim(), lang: m[2], sample: m[3] });
    }
    return out;
  }
  if (engine === "sapi") return exe ? [{ name: "default", provider: "system", lang: "system", sample: "Windows SAPI (PowerShell System.Speech)" }] : [];
  if (exe) return [{ name: "default", provider: "system", lang: "en", sample: "espeak" }, { name: "vi", provider: "system", lang: "vi", sample: "espeak Vietnamese" }];
  return [];
}

/** Every TTS provider (available or not, with a setup hint) and the default one. A lookup only: no engine is started. */
export function ttsProviders(extra = providerInfo()) {
  const { engine, exe } = systemEngine();
  return {
    default_provider: pickProvider().provider,
    providers: [{ name: "system", available: exe !== null, engine }, ...extra.providers],
  };
}

/** The providers and the voices usable now (lists the system voices, which may run `say`). */
export function ttsVoices() {
  const extra = providerInfo();
  return { ...ttsProviders(extra), voices: [...systemVoices(), ...extra.voices] };
}

/** Runs f(0..count-1) with at most n at once; results by index. After a failure no new task starts, the running ones settle, and the lowest-index error is thrown. */
async function pool<T>(n: number, count: number, f: (i: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count), errors: { index: number; error: unknown }[] = [];
  let next = 0, stopped = false;
  const worker = async () => {
    while (!stopped) {
      const index = next++;
      if (index >= count) return;
      try { results[index] = await f(index); }
      catch (error) { errors.push({ index, error }); stopped = true; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, count) }, worker));
  if (errors.length) throw errors.sort((a, b) => a.index - b.index)[0].error;
  return results;
}

/** One TTS entry point. voice "piper[:model.onnx]" / "openai:<voice>" / "system:<name>" picks the provider, else AGENTCUT_TTS_PROVIDER (default system).
 *  Each sentence is synthesized separately (rate applies to each; up to 4 concurrent for openai/piper, system voices serially), converted to 48 kHz stereo and joined in order, so `sentences` carries
 *  the real [start, end] of each one in the output. `base`: the project folder when outPath is inside it. */
export async function tts(text: string | undefined, outPath: string, voice?: string, rate?: number | null, base?: string, signal?: AbortSignal) {
  if (typeof text !== "string" || !text.trim()) throw new EditError("tts needs the text to speak", "missing_input", "pass the text to speak, e.g. \"Hello\"");
  if (rate != null && !(typeof rate === "number" && Number.isFinite(rate) && rate > 0)) throw new EditError(`rate must be a number of words per minute above 0, got ${typeof rate === "string" ? JSON.stringify(rate) : String(rate)}`, "bad_value", "e.g. 175 (a number, not a string); leave it out for the voice's default");
  (await needFfmpeg());
  const part = tmpSibling(outPath, base);
  const { provider, voice: v } = pickProvider(voice);
  const tmp = mkdtempSync(join(tmpdir(), "agentcut-tts-"));
  const sentences: { text: string; start: number; end: number }[] = [];
  try {
    const parts = splitSentences(text);
    const wavs = await pool(provider === "system" ? 1 : 4, parts.length, async (i) => {
      const s = parts[i];
      const dir = join(tmp, `s${i}`);
      mkdirSync(dir);
      const raw = provider === "piper" ? await piperSpeech(s, dir, v, rate ?? undefined, undefined, signal) : provider === "openai" ? await httpSpeech(s, dir, v, rate ?? undefined, undefined, signal) : await systemSpeech(s, dir, v, rate ?? undefined, signal);
      const wav = join(tmp, `p${i}.wav`);
      const c = await run("ffmpeg", ["-v", "error", "-y", ...inp(raw), "-ar", "48000", "-ac", "2", wav], { signal });
      if (c.status !== 0) throw new EditError(`tts convert failed: ${c.stderr.slice(0, 300)}`, "tts_failed");
      return wav;
    });
    for (const [i, wav] of wavs.entries()) {
      const fd = openSync(wav, "r");
      let duration: number;
      try {
        const { bytes, channels, bits, rate } = wavData(fd, wav);
        const frame = (channels * bits) / 8;
        duration = +((Math.floor(bytes / frame) / rate).toFixed(6));
      } finally { closeSync(fd); }
      const start = sentences.length ? sentences[sentences.length - 1].end : 0;
      sentences.push({ text: parts[i], start, end: start + duration });
    }
    const list = join(tmp, "parts.txt");
    createFile(list, wavs.map((w) => `file '${w.replace(/'/g, "'\\''")}'\n`).join(""));
    const j = await run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-ar", "48000", "-ac", "2", part], { signal });
    if (j.status !== 0) throw new EditError(`tts join failed: ${j.stderr.slice(0, 300)}`, "tts_failed");
    commit(part, outPath);
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(part, { force: true }); }
  return { path: outPath, duration: (await probe(outPath)).duration, voice: voice ?? null, provider, sentences };
}

const SAPI_VOICE = "AGENTCUT_SAPI_VOICE", SAPI_OUT = "AGENTCUT_SAPI_OUT", SAPI_NO_VOICE = 3; // SAPI_NO_VOICE: PowerShell exit code for a voice that is not installed

/** Every name a voice may be given as (language, voice name, file, other languages) in espeak's plain and mbrola listings; null when a listing cannot be read, so no verdict is drawn. */
async function espeakVoices(exe: string, signal?: AbortSignal): Promise<Set<string> | null> {
  const names = new Set<string>();
  for (const arg of ["--voices", "--voices=mb"]) { // plain --voices omits the mbrola voices
    const l = await run(exe, [arg], { signal });
    if (l.status !== 0) return null;
    for (const line of l.stdout.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/); // priority, language, age/gender, voice name, file
      for (const col of [c[1], c[3], c[4]]) if (col) names.add(col.toLowerCase()).add(col.split("/").pop()!.toLowerCase());
      for (const m of line.matchAll(/\(([^\s()]+) \d+\)/g)) names.add(m[1].toLowerCase()); // "(zh-cmn 5)(zh 5)": groups run together
    }
  }
  return names.size ? names : null;
}

/** OS voice: macOS `say`, Windows SAPI, Linux espeak. Returns the raw audio path in tmp. */
async function systemSpeech(text: string, tmp: string, voice?: string, rate?: number, signal?: AbortSignal): Promise<string> {
  let raw = join(tmp, "tts.aiff");
  // text goes in a file, never argv: a script starting with "-" would be parsed as an option
  const txt = join(tmp, "tts.txt");
  createFile(txt, text);
  let r;
  if (process.platform === "darwin") {
    const args = ["-o", raw];
    if (voice) {
      const vs = systemVoices();
      if (!vs.some((v) => v.name === voice || v.full_name === voice)) {
        const s = suggest(voice, vs.map((v) => v.name));
        throw new EditError(`voice '${voice}' not installed`, "bad_voice", `${s ? `did you mean '${s}'? ` : ""}list them with list_voices (CLI: agentcut voices); for Vietnamese try 'Linh'`);
      }
      args.push("-v", voice);
    }
    if (rate) args.push("-r", String(rate));
    r = await run("say", [...args, "-f", txt], { signal });
  } else if (process.platform === "win32") {
    raw = join(tmp, "tts.wav");
    if (voice?.includes("\0")) throw new EditError("invalid voice: contains a NUL character", "bad_voice", "voice names are plain text");
    // the voice and the output path reach PowerShell as data (two environment variables), never as script text; only the integer rate is interpolated
    const pick = `$n=@($s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }); if ($n -cnotcontains $env:${SAPI_VOICE}) { [Console]::Out.Write($n -join "\`n"); exit ${SAPI_NO_VOICE} }; $s.SelectVoice($env:${SAPI_VOICE});`;
    const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voice ? pick : ""}${rate ? `$s.Rate=${Math.round((rate - 175) / 25)};` : ""}$s.SetOutputToWaveFile($env:${SAPI_OUT}); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`;
    r = await run("powershell", ["-NoProfile", "-Command", ps], { input: Buffer.from(text), signal, env: { ...process.env, [SAPI_VOICE]: voice ?? "", [SAPI_OUT]: raw } });
    if (r.status === SAPI_NO_VOICE) {
      const installed = r.stdout.split("\n").map((n) => n.trim()).filter(Boolean);
      const s = suggest(voice!, installed);
      throw new EditError(`voice '${voice}' not installed`, "bad_voice", `${s ? `did you mean '${s}'? ` : ""}installed voices: ${installed.join(", ") || "none"}`);
    }
  } else {
    raw = join(tmp, "tts.wav");
    if (voice && !/^[A-Za-z0-9][A-Za-z0-9_+.-]*$/.test(voice)) throw new EditError(`invalid voice '${voice}'`, "bad_voice", "espeak voice names are letters, digits and _ + . - (for example en-us, vi)");
    const { exe } = systemEngine();
    if (!exe) throw new EditError("no TTS engine found", "missing_dependency", "install espeak-ng (apt install espeak-ng), or generate audio elsewhere and import it");
    r = await run(exe, ["-w", raw, ...(voice ? ["-v", voice] : []), ...(rate ? ["-s", String(rate)] : []), "-f", txt], { signal });
    if (r.status !== 0 && voice) { // diagnose only after a failure, so a good synthesis pays no extra call
      const known = await espeakVoices(exe, signal);
      if (known && !known.has(voice.split("+")[0].toLowerCase())) // "en+f3" is the voice en with the f3 variant
        throw new EditError(`voice '${voice}' not installed (${exe}: ${r.stderr.trim().slice(0, 300)})`, "bad_voice", `list them with list_voices (CLI: agentcut voices), or run \`${exe} --voices\``);
    }
  }
  if (r.status !== 0) throw new EditError(`tts failed: ${r.stderr.slice(0, 300)}`, "tts_failed");
  return raw;
}

const WHISPER_CLIS = ["whisper-cli", "whisper-cpp", "main"];

/** What transcription can run: whisper.cpp when a CLI is on PATH and a model is named, else OpenAI whisper on PATH. The one place that decides; transcribe() and `capabilities` both read it. A lookup only. */
type Asr = { kind: "cli"; cli: string; model: string } | { kind: "python" } | { kind: "bad_model"; cli: string; model: string } | { kind: "no_model"; cli: string } | { kind: "none" };
function asrState(model = process.env.AGENTCUT_WHISPER_MODEL): Asr {
  const cli = WHISPER_CLIS.find(has);
  if (cli && model) return existsSync(model) ? { kind: "cli", cli, model } : { kind: "bad_model", cli, model };
  if (has("whisper")) return { kind: "python" };
  return cli ? { kind: "no_model", cli } : { kind: "none" };
}

/** What to do about a state that cannot transcribe. */
const asrHint = (a: Asr) => a.kind === "bad_model" ? `whisper model ${a.model} does not exist: name an existing ggml model file (AGENTCUT_WHISPER_MODEL=/path/ggml-model.bin)`
  : a.kind === "no_model" ? `${a.cli} found: set AGENTCUT_WHISPER_MODEL=/path/ggml-model.bin`
  : "install whisper.cpp (`brew install whisper-cpp`) and set AGENTCUT_WHISPER_MODEL=/path/ggml-model.bin, or `pip install openai-whisper`";

/** What `capabilities` says about transcription (same state as transcribe(); nothing is started). */
export function transcribeEngine() {
  const a = asrState(), available = a.kind === "cli" || a.kind === "python";
  return {
    // engine is named only when one is selected
    available, engine: a.kind === "python" ? "whisper" : a.kind === "cli" || a.kind === "bad_model" ? a.cli : null, model: a.kind === "cli" ? a.model : null,
    languages: "auto, or a whisper language code such as vi or en",
    ...(available ? {} : { hint: asrHint(a) }),
  };
}

/** A failed engine run, by the engine's own words: its first `error:` line, else its first `<name>: error:` line (an argument parser's), else (python) its last exception line, else its exit status; never its usage text or its list of choices. A language it does not know is bad_value. */
function asrError(name: string, r: { status: number | null; stderr: string }, language?: string) {
  const lines = r.stderr.split("\n").map((l) => l.trim());
  const line = (lines.find((l) => l.startsWith("error:")) ?? lines.find((l) => /^[\w.-]+: error: /.test(l))?.replace(/^[\w.-]+: error: /, "") ?? lines.reverse().find((l) => /^\w+(Error|Exception):/.test(l)))
    ?.replace(/ \(choose from .*\)$/, "");
  if (line && (/(unknown|unsupported) language/i.test(line) || /^argument --language: invalid choice/.test(line))) return new EditError(`unknown language '${language ?? "auto"}'`, "bad_value", "a whisper language code such as vi or en, or leave language out to detect it");
  return new EditError(line ?? (r.status ? `${name} exited ${r.status}` : `${name} wrote no output`), "asr_failed", `check the model and the language, or run ${name} by hand on the audio for its full output`);
}

/** The level (dBFS) below which the extracted 16-bit wav is taken as silence: GATE_MARGIN dB over its noise floor (the window at the 10th percentile of
 *  the peak level of its 50 ms windows: silencedetect compares samples, not RMS), never below -35 dB (analyze_silence's default). A steady hiss or
 *  room tone above -35 dB otherwise leaves no silence, and whisper times words into it. A floor that is a steady tone (peak under 4 dB over its RMS, a sine is 3 dB, noise 5 to 10:
 *  hum, a held note, a test tone) is not taken as noise: the gate stays at -35 dB. */
export function speechGate(wav: string): number {
  const fd = openSync(wav, "r");
  try {
    const { offset, bytes, rate, channels } = wavData(fd, wav), win = Math.max(1, Math.round(rate * 0.05)) * channels, buf = Buffer.alloc(bytes - (bytes % 2));
    readSync(fd, buf, 0, buf.length, offset);
    const wins: { peak: number; rms: number }[] = [];
    for (let i = 0; i + win * 2 <= buf.length; i += win * 2) {
      let p = 0, sq = 0;
      for (let j = i; j < i + win * 2; j += 2) { const v = buf.readInt16LE(j); p = Math.max(p, Math.abs(v)); sq += v * v; }
      wins.push({ peak: p, rms: Math.sqrt(sq / win) });
    }
    if (!wins.length) return -35;
    wins.sort((a, b) => a.peak - b.peak);
    const floor = wins[Math.floor(wins.length * 0.1)];
    if (floor.rms <= 0 || 20 * Math.log10(floor.peak / floor.rms) < 4) return -35;
    return Math.max(-35, +(20 * Math.log10(floor.peak / 32768) + GATE_MARGIN).toFixed(1));
  } finally { closeSync(fd); }
}
const GATE_MARGIN = 6;
/** Seconds of silence put between the speech pieces joined for the engine: a word it times early lands there, not at the end of the piece before. */
const JOIN_GAP = 0.25;

/** What is kept of a silence on each side of the speech sent to the engine. */
const LEAD_PAD = 0.1;

/** Each bracket that opens a sound note, and its closer. */
const CLOSER: Record<string, string> = { "[": "]", "(": ")", "（": "）", "【": "】" };

/** The engine's words without its sound notes, and their text. A span from a word whose first bracket ([, (, （ or 【) comes before any letter or digit to the
 *  first word ending in the matching closer and non-letters is a note ([BLANK_AUDIO], (upbeat music), （笑）) and goes whole, with the punctuation on it; with no
 *  closer before the next such opener nothing goes, except that a word opening the other kind and closing this one is inside it ([Music, (upbeat)]). A word
 *  with speech after its own closer ((laughs)Hello, （笑）そうですね（笑）) opens no span: a note glued to speech in one word stays, at either end or inside
 *  (a CJK run has no spaces); a further whole note is not speech, so notes glued together ([Music][Applause]) go. An inner note split over two words still leaves the outer opener. Music notes (♩♪♫♬) and two or more < or > opening a word
 *  with no letter or digit (caption speaker marks: >>, >>,) are taken out, and a word left with no letter or digit goes. Times are untouched. */
function spoken(words: { text: string; start: number; end: number }[]) {
  // whole notes after k are not speech: [Music][Applause] is notes only
  const speechFrom = (t: string, k: number) => k >= 0 && /[\p{L}\p{N}]/u.test(t.slice(k).replace(/\[[^[\]()（）【】]*\]|\([^[\]()（）【】]*\)|（[^[\]()（）【】]*）|【[^[\]()（）【】]*】/gu, ""));
  const closes = (t: string, open: string) => { const k = t.lastIndexOf(CLOSER[open]); return k >= 0 && !speechFrom(t, k); };
  const opener = (t: string) => { const m = /^[^\p{L}\p{N}]*?([[(（【])/u.exec(t); return m && !speechFrom(t, t.indexOf(CLOSER[m[1]], m[0].length)) ? m[1] : undefined; };
  const kept: typeof words = [];
  for (let i = 0; i < words.length; i++) {
    const open = opener(words[i].text);
    if (open) {
      const continuesSpan = (t: string, o = opener(t)) => !o || (o !== open && closes(t, open));
      let j = i;
      while (j + 1 < words.length && !closes(words[j].text, open) && continuesSpan(words[j + 1].text)) j++;
      if (closes(words[j].text, open)) { i = j; continue; }
    }
    const text = words[i].text.replace(/[♩♪♫♬]|^[<>]{2,}(?=[^\p{L}\p{N}]*$)/gu, "");
    if (text === words[i].text) kept.push(words[i]);
    else if (/[\p{L}\p{N}]/u.test(text)) kept.push({ ...words[i], text });
  }
  return { text: kept.map((w) => w.text).join(" "), words: kept };
}

/**
 * Word-level transcription via whisper.cpp (`whisper-cli`) or OpenAI whisper (`whisper`) if installed.
 * range = [start, end] seconds of the media (end open: to the media's end): only that stretch is transcribed and the word times stay in media seconds, within [start, end].
 * Checks run cheapest first: the media (not_found, bad_media, no_audio), the range, the engine (missing_dependency, not_found for a model file), then the extraction.
 * The engine hears the speech only: every silence (below speechGate's level) is left out but LEAD_PAD on each side of the speech, the pieces are
 * joined with JOIN_GAP of silence between them and the engine's times are mapped back piece by piece (a word started in a gap starts at the next piece;
 * a word's end stays in the piece that holds its start); whisper times words into a silence it is given. `skipped_leading` is the seconds left out at the start. A music lead-in or bed is not silence; give a range.
 * Whisper may invent text over a long music-only stretch and times words early after a music lead-in; no engine option prevents it.
 * Its sound notes are not words (spoken()): a spoken aside it puts in brackets or parentheses goes with them.
 */
export async function transcribe(path: string, language?: string, model?: string, range?: [number, number | undefined], signal?: AbortSignal) {
  const info = (await probe(path));
  if (!info.has_audio && info.kind !== "audio") throw new EditError(`${path} has no audio`, "no_audio");
  const length = Number(info.duration ?? 0);
  if (Array.isArray(range) && length > 0 && range[0] >= length)
    throw new EditError(`transcribe start ${range[0]} s is at or past the end of the media (${length} s)`, "bad_value", `start below ${length} s`);
  if (range !== undefined && !(Array.isArray(range) && range.length === 2 && Number.isFinite(range[0]) && range[0] >= 0 && (range[1] === undefined || (Number.isFinite(range[1]) && range[1] > range[0]))))
    throw new EditError("transcribe range must be [start, end] in seconds with 0 <= start < end", "bad_value", "e.g. [0, 12.5]: the speech only; analyze_silence or the voiceover's length gives it");
  const asr = asrState(model);
  if (asr.kind === "bad_model") throw new EditError(`whisper model not found: ${asr.model}`, "not_found", asrHint(asr));
  if (asr.kind === "no_model" || asr.kind === "none") throw new EditError(asr.kind === "none" ? "transcription needs whisper" : `${asr.cli} found, but no model is set`, "missing_dependency", `${asrHint(asr)}; or give add_captions words or srt`);
  const from = range?.[0] ?? 0, to = range ? (range[1] ?? (length > 0 ? length : undefined)) : undefined; // an open end is the media's end
  const tmp = mkdtempSync(join(tmpdir(), "agentcut-asr-"));
  try {
    const raw = join(tmp, "raw.wav"), wav = join(tmp, "a.wav"); // python whisper names its output after the wav it is given
    const ss = seekArgs(from, info.kind === "video" ? info : undefined, info.fps);
    const cut = await run("ffmpeg", ["-v", "error", "-y", ...ss.input, ...inp(path), ...ss.output, ...(to !== undefined ? ["-t", String(to - from)] : []), "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", raw], { signal });
    if (cut.status !== 0) throw new EditError(`cannot extract audio from ${path}: ${cut.stderr.trim().slice(0, 300)}`, "decode_failed");
    const { speech, duration: heard } = await silence(raw, speechGate(raw), undefined, signal);
    const pieces = speech.map(([a, b]) => [Math.max(0, +(a - LEAD_PAD).toFixed(3)), Math.min(heard, +(b + LEAD_PAD).toFixed(3))]);
    if (!pieces.length) pieces.push([0, heard]);
    let joinGap = 0;
    if (pieces.length > 1 || pieces[0][0] || pieces[0][1] < heard) {
      // the pieces' samples are copied into one wav in process, so nothing grows with their count; edges are whole samples, so the time map below is exact
      let src = -1, out = -1;
      try {
        src = openSync(raw, "r"); out = openSync(wav, "w");
        const { offset, bytes, rate, channels, bits } = wavData(src, raw), frame = (channels * bits) / 8, frames = Math.floor(bytes / frame), block = 65536;
        const spans = pieces.map(([a, b]) => [Math.min(frames, Math.round(a * rate)), Math.min(frames, Math.round(b * rate))]), gap = Math.round(JOIN_GAP * rate);
        spans.forEach(([a, b], k) => { pieces[k] = [a / rate, b / rate]; });
        joinGap = gap / rate;
        const size = spans.reduce((n, [a, b]) => n + (b - a) * frame, 0) + (spans.length - 1) * gap * frame, h = Buffer.alloc(44);
        h.write("RIFF", 0, "ascii"); h.writeUInt32LE(36 + size, 4); h.write("WAVEfmt ", 8, "ascii"); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
        h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * frame, 28); h.writeUInt16LE(frame, 32); h.writeUInt16LE(bits, 34); h.write("data", 36, "ascii"); h.writeUInt32LE(size, 40);
        writeSync(out, h);
        const buf = Buffer.allocUnsafe(block * frame);
        const zeros = Buffer.alloc(gap * frame);
        spans.forEach(([a, b], k) => {
          if (k) writeSync(out, zeros);
          for (let f = a; f < b; f += block) writeSync(out, buf, 0, readSync(src, buf, 0, Math.min(b - f, block) * frame, offset + f * frame));
        });
      } catch (e: any) { throw e instanceof EditError ? e : new EditError(`cannot prepare the audio extracted from ${path}: ${e.message}`, "decode_failed"); }
      finally { if (src >= 0) closeSync(src); if (out >= 0) closeSync(out); }
    } else renameSync(raw, wav);
    const skipped = +pieces[0][0].toFixed(3);
    const starts: number[] = []; // where each piece begins in what the engine hears (JOIN_GAP of silence between pieces)
    pieces.reduce((t, [a, b]) => (starts.push(t), t + b - a + joinGap), 0);
    // the piece a time belongs to: one in the gap after a piece belongs to the next (whisper times a word early, into the silence before it)
    const holder = (x: number) => {
      let lo = 0, hi = starts.length - 1;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= x) lo = m; else hi = m - 1; }
      return lo + 1 < starts.length && x > starts[lo] + pieces[lo][1] - pieces[lo][0] ? lo + 1 : lo;
    };
    const media = (x: number) => { const k = holder(x); return Math.max(0, x - starts[k]) + pieces[k][0] + from; };
    const last = Math.min(to ?? Infinity, from + pieces[pieces.length - 1][1]); // no word time past the range or the last thing the engine heard
    const at = (x: number) => +Math.min(Math.max(media(x), from), last).toFixed(3); // engine time -> media time, inside the range
    const till = (x: number, start: number) => Math.min(at(x), +(pieces[holder(start)][1] + from).toFixed(3)); // a word's end stays in the piece that holds its start
    const late = (x: number) => to !== undefined && media(x) >= to;
    if (asr.kind === "cli") {
      const { cli, model: mdl } = asr;
      // -ml 1 alone splits inside a syllable ("ch","ào"); -sow splits only on whole words
      const r = await run(cli, ["-m", mdl, "-f", wav, "-oj", "-ojf", "-ml", "1", "-sow", "-of", join(tmp, "out"), ...(language ? ["-l", language] : ["-l", "auto"])], { signal, maxBuffer: 1 << 28 });
      if (r.status !== 0 || !existsSync(join(tmp, "out.json"))) throw asrError(cli, r, language);
      const j = JSON.parse(readFileSync(join(tmp, "out.json"), "utf8"));
      // punctuation comes back as timed tokens of its own: it joins the previous word and stretches its end; opening punctuation (and a leading one) joins the next
      const words: { text: string; start: number; end: number }[] = [];
      let lead = "", began = 0;
      for (const s of j.transcription || []) {
        const text = String(s.text).trim();
        if (!text) continue;
        const prev = words[words.length - 1];
        if (!/^\p{P}+$/u.test(text)) { if (late(s.offsets.from / 1000)) break; began = s.offsets.from / 1000; words.push({ text: lead + text, start: at(began), end: till(s.offsets.to / 1000, began) }); lead = ""; }
        else if (prev && !/^[\p{Ps}\p{Pi}]+$/u.test(text)) { prev.text += text; prev.end = till(s.offsets.to / 1000, began); }
        else lead += text;
      }
      return { source: path, language: j.result?.language ?? language ?? null, ...spoken(words), skipped_leading: skipped };
    }
    const r = await run("whisper", [wav, "--word_timestamps", "True", "--output_format", "json", "--output_dir", tmp, ...(language ? ["--language", language] : []), ...(model ? ["--model", model] : [])], { signal, maxBuffer: 1 << 28 });
    if (r.status !== 0 || !existsSync(join(tmp, "a.json"))) throw asrError("whisper", r, language);
    const j = JSON.parse(readFileSync(join(tmp, "a.json"), "utf8"));
    const words = j.segments.flatMap((s: any) => (s.words || []).filter((w: any) => !late(w.start)).map((w: any) => ({ text: String(w.word).trim(), start: at(w.start), end: till(w.end, w.start) })));
    return { source: path, language: j.language, ...spoken(words), skipped_leading: skipped };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ analyses inside apply_ops
// Ops are synchronous, so an op that needs transcribe, tts, silence or beats asks the Project's memo (`analysis`). A miss throws NeedsAnalysis;
// api.apply computes it (`compute`, async, with the call's signal), keeps the outcome in the memo and re-runs the batch from a fresh load.
// A failed analysis is kept as its EditError, so the re-run throws it from the same op and the batch error names that op as before.
export type Request =
  | { kind: "transcribe"; path: string; language?: string; range?: [number, number] }
  | { kind: "tts"; text: string | undefined; voice?: string; rate?: number | null }
  | { kind: "silence"; path: string; noiseDb: number; minSilence: number }
  | { kind: "beats"; path: string };
type Answers = { transcribe: Awaited<ReturnType<typeof transcribe>>; tts: Awaited<ReturnType<typeof tts>>; silence: Awaited<ReturnType<typeof silence>>; beats: Awaited<ReturnType<typeof beats>> };

/** The one cross-call cache: the beats of an audio file, one entry per path holding the mtime and size it was decoded at (a replaced file
 *  replaces its entry, as probeCache does), so repeated snap_to_beats calls on one server decode a track once. Only `compute` reads it;
 *  a direct `beats` call (analyze_beats, review) never shares it. */
const beatCache = new Map<string, { mtime: number; size: number; value: Awaited<ReturnType<typeof beats>> }>();
async function cachedBeats(path: string, signal?: AbortSignal) {
  const st = statSync(path), hit = beatCache.get(path);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = await beats(path, signal);
  beatCache.set(path, { mtime: st.mtimeMs, size: st.size, value });
  return value;
}

/** Thrown by an op on a memo miss. Not an EditError: it never leaves api.apply (any other caller of applyOps gets this internal error). */
export class NeedsAnalysis extends Error {
  constructor(readonly req: Request) { super(`internal: the ${req.kind} analysis must be computed before the op runs; only api.apply does that`); }
}

const keyOf = (r: Request) => JSON.stringify(r);

/** The result of `r` from this call's memo. */
export function analysis<R extends Request>(p: Project, r: R): Answers[R["kind"]] {
  const hit = p.analyses.get(keyOf(r));
  if (!hit) throw new NeedsAnalysis(r);
  if (hit.error) throw hit.error;
  return hit.value as Answers[R["kind"]];
}

/** Compute `r` into the memo. An abort rejects; a failure that is an EditError is kept for the op to throw. Speech goes to a temp folder
 *  (released by `release`), because the op copies it into media/ itself and every round discards what is staged there. */
export async function compute(p: Project, r: Request, signal?: AbortSignal) {
  const key = keyOf(r);
  if (p.analyses.has(key)) throw new Error(`internal: the ${r.kind} analysis was requested again after it ran`);
  const tmp = r.kind === "tts" ? mkdtempSync(join(tmpdir(), "agentcut-vo-")) : undefined;
  try {
    const value = r.kind === "transcribe" ? await transcribe(r.path, r.language, undefined, r.range, signal)
      : r.kind === "tts" ? await tts(r.text, join(tmp!, "vo.wav"), r.voice, r.rate, undefined, signal)
      : r.kind === "silence" ? await silence(r.path, r.noiseDb, r.minSilence, signal)
      : await cachedBeats(r.path, signal);
    p.analyses.set(key, { value, tmp });
  } catch (e) {
    if (!(e instanceof EditError) || signal?.aborted) { if (tmp) rmSync(tmp, { recursive: true, force: true }); throw e; }
    p.analyses.set(key, { error: e, tmp });
  }
}

/** Forget the memo and delete the temp folders it holds. */
export function release(p: Project) {
  for (const { tmp } of p.analyses.values()) if (tmp) rmSync(tmp, { recursive: true, force: true });
  p.analyses.clear();
}
