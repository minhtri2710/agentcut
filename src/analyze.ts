// Media analysis: beats (spectral flux + DP tracker, pure TS FFT), scene cuts, silence, loudness, TTS, transcription.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitSentences } from "./captions.ts";
import { inp } from "./ffinput.ts";
import { needFfmpeg, probe } from "./media.ts";
import { EditError, suggest } from "./model.ts";
import { commit, createFile, tmpSibling } from "./safe-write.ts";
import type { Project } from "./project.ts";
import { run } from "./proc.ts";
import { has, httpSpeech, pickProvider, piperSpeech, providerInfo } from "./tts.ts";

async function decodeMono(path: string, sr: number, signal?: AbortSignal): Promise<Float32Array> {
  needFfmpeg();
  const r = await run("ffmpeg", ["-v", "error", "-nostdin", ...inp(path), "-vn", "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"], { signal, maxBuffer: 1 << 30, binary: true });
  if (r.status !== 0) throw new EditError(`cannot decode audio from ${path}: ${r.stderr.slice(0, 300)}`, "decode_failed");
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength - (b.byteLength % 4)));
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
  needFfmpeg();
  const info = probe(path);
  const r = await run("ffmpeg", ["-v", "info", "-nostdin", ...inp(path), "-an", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { signal, maxBuffer: 1 << 28 });
  const cuts = [...r.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => +(+m[1]).toFixed(3));
  const dur = info.duration ?? 0;
  const b = [0, ...cuts, dur];
  const shots = b.slice(0, -1).map((s, i) => ({ start: s, end: b[i + 1], duration: +(b[i + 1] - s).toFixed(3) })).filter((s) => s.duration > 0.05);
  return { source: path, threshold, cuts, shots, duration: dur };
}

export async function silence(path: string, noiseDb = -35, minSilence = 0.4, signal?: AbortSignal) {
  needFfmpeg();
  const info = probe(path);
  if (!info.has_audio && info.kind !== "audio") throw new EditError("file has no audio", "no_audio");
  const r = await run("ffmpeg", ["-v", "info", "-nostdin", ...inp(path), "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, "-f", "null", "-"], { signal, maxBuffer: 1 << 28 });
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

// ------------------------------------------------------------------ TTS
type Voice = { name: string; provider: string; full_name?: string; lang: string; sample: string };
function systemVoices(): Voice[] {
  if (process.platform === "darwin") {
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
  if (process.platform === "win32") return [{ name: "default", provider: "system", lang: "system", sample: "Windows SAPI (PowerShell System.Speech)" }];
  if (has("espeak-ng") || has("espeak")) return [{ name: "default", provider: "system", lang: "en", sample: "espeak" }, { name: "vi", provider: "system", lang: "vi", sample: "espeak Vietnamese" }];
  return [];
}

/** Every TTS provider (available or not, with a setup hint) and the default one. A lookup only: no engine is started. */
export function ttsProviders(extra = providerInfo()) {
  const win = process.platform === "win32", mac = process.platform === "darwin", bins = mac ? ["say"] : win ? ["powershell"] : ["espeak-ng", "espeak"];
  return {
    default_provider: pickProvider().provider,
    providers: [{ name: "system", available: bins.some(has), engine: mac ? "say" : win ? "sapi" : "espeak" }, ...extra.providers],
  };
}

/** The providers and the voices usable now (lists the system voices, which may run `say`). */
export function ttsVoices() {
  const extra = providerInfo();
  return { ...ttsProviders(extra), voices: [...systemVoices(), ...extra.voices] };
}

/** One TTS entry point. voice "piper[:model.onnx]" / "openai:<voice>" / "system:<name>" picks the provider, else AGENTCUT_TTS_PROVIDER (default system).
 *  Each sentence is synthesized on its own (rate applies to each), converted to 48 kHz stereo and joined in order, so `sentences` carries
 *  the real [start, end] of each one in the output. `base`: the project folder when outPath is inside it. */
export async function tts(text: string | undefined, outPath: string, voice?: string, rate?: number | null, base?: string, signal?: AbortSignal) {
  if (typeof text !== "string" || !text.trim()) throw new EditError("tts needs the text to speak", "missing_input", "pass the text to speak, e.g. \"Hello\"");
  if (rate != null && !(typeof rate === "number" && Number.isFinite(rate) && rate > 0)) throw new EditError(`rate must be a number of words per minute above 0, got ${typeof rate === "string" ? JSON.stringify(rate) : String(rate)}`, "bad_value", "e.g. 175 (a number, not a string); leave it out for the voice's default");
  needFfmpeg();
  const part = tmpSibling(outPath, base);
  const { provider, voice: v } = pickProvider(voice);
  const tmp = mkdtempSync(join(tmpdir(), "agentcut-tts-"));
  const sentences: { text: string; start: number; end: number }[] = [];
  try {
    const wavs: string[] = [];
    for (const [i, s] of splitSentences(text).entries()) {
      const dir = join(tmp, `s${i}`);
      mkdirSync(dir);
      const raw = provider === "piper" ? await piperSpeech(s, dir, v, rate ?? undefined, undefined, signal) : provider === "openai" ? await httpSpeech(s, dir, v, rate ?? undefined, undefined, signal) : await systemSpeech(s, dir, v, rate ?? undefined, signal);
      const wav = join(tmp, `p${i}.wav`);
      const c = await run("ffmpeg", ["-v", "error", "-y", ...inp(raw), "-ar", "48000", "-ac", "2", wav], { signal });
      if (c.status !== 0) throw new EditError(`tts convert failed: ${c.stderr.slice(0, 300)}`, "tts_failed");
      const start = sentences.length ? sentences[sentences.length - 1].end : 0;
      sentences.push({ text: s, start, end: start + probe(wav).duration });
      wavs.push(wav);
    }
    const list = join(tmp, "parts.txt");
    createFile(list, wavs.map((w) => `file '${w.replace(/'/g, "'\\''")}'\n`).join(""));
    const j = await run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-ar", "48000", "-ac", "2", part], { signal });
    if (j.status !== 0) throw new EditError(`tts join failed: ${j.stderr.slice(0, 300)}`, "tts_failed");
    commit(part, outPath);
  } finally { rmSync(tmp, { recursive: true, force: true }); rmSync(part, { force: true }); }
  return { path: outPath, duration: probe(outPath).duration, voice: voice ?? null, provider, sentences };
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
    const exe = has("espeak-ng") ? "espeak-ng" : has("espeak") ? "espeak" : null;
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

/** A failed engine run, by the engine's own words: its first `error:` line, else (python) its last exception line, else its exit status; never its usage text. A language it does not know is bad_value. */
function asrError(name: string, r: { status: number | null; stderr: string }, language?: string) {
  const lines = r.stderr.split("\n").map((l) => l.trim());
  const line = lines.find((l) => l.startsWith("error:")) ?? lines.reverse().find((l) => /^\w+(Error|Exception):/.test(l));
  if (line && /(unknown|unsupported) language/i.test(line)) return new EditError(`unknown language '${language ?? "auto"}'`, "bad_value", "a whisper language code such as vi or en, or leave language out to detect it");
  return new EditError(line ?? (r.status ? `${name} exited ${r.status}` : `${name} wrote no output`), "asr_failed", `check the model and the language, or run ${name} by hand on the audio for its full output`);
}

/** What is kept of a silent start: the stretch sent to the engine begins this long before the first sound. */
const LEAD_PAD = 0.1;

/**
 * Word-level transcription via whisper.cpp (`whisper-cli`) or OpenAI whisper (`whisper`) if installed.
 * range = [start, end] seconds of the media (end open: to the media's end): only that stretch is transcribed and the word times stay in media seconds, within [start, end].
 * Checks run cheapest first: the media (not_found, bad_media, no_audio), the range, the engine (missing_dependency, not_found for a model file), then the extraction.
 * The stretch handed to the engine starts at the first sound (silence()'s default threshold) less LEAD_PAD, never before `start`: after a silent
 * start whisper times the first words early. `skipped_leading` is the seconds left out. A music lead-in is not silence; give a range.
 * Whisper may invent text over a long music-only stretch and times words early after a music lead-in; no engine option prevents it.
 */
export async function transcribe(path: string, language?: string, model?: string, range?: [number, number | undefined], signal?: AbortSignal) {
  const info = probe(path);
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
    const ffFail = (r: { status: number | null; stderr: string }) => new EditError(`cannot extract audio from ${path}: ${r.stderr.trim().slice(0, 300)}`, "decode_failed");
    const cut = await run("ffmpeg", ["-v", "error", "-y", ...(range ? ["-ss", String(from)] : []), ...inp(path), ...(to !== undefined ? ["-t", String(to - from)] : []), "-ar", "16000", "-ac", "1", raw], { signal });
    if (cut.status !== 0) throw ffFail(cut);
    const first = (await silence(raw, undefined, undefined, signal)).speech[0]?.[0] ?? 0;
    const skipped = Math.max(0, +(first - LEAD_PAD).toFixed(3));
    if (skipped) {
      const trim = await run("ffmpeg", ["-v", "error", "-y", "-ss", String(skipped), "-i", raw, "-c", "copy", wav], { signal });
      if (trim.status !== 0) throw ffFail(trim);
    } else renameSync(raw, wav);
    const at = (x: number) => +Math.min(Math.max(x + from + skipped, from), to ?? Infinity).toFixed(3); // engine time -> media time, inside the range
    const late = (x: number) => to !== undefined && x + from + skipped >= to;
    if (asr.kind === "cli") {
      const { cli, model: mdl } = asr;
      // -ml 1 alone splits inside a syllable ("ch","ào"); -sow splits only on whole words
      const r = await run(cli, ["-m", mdl, "-f", wav, "-oj", "-ojf", "-ml", "1", "-sow", "-of", join(tmp, "out"), ...(language ? ["-l", language] : ["-l", "auto"])], { signal, maxBuffer: 1 << 28 });
      if (r.status !== 0 || !existsSync(join(tmp, "out.json"))) throw asrError(cli, r, language);
      const j = JSON.parse(readFileSync(join(tmp, "out.json"), "utf8"));
      // punctuation comes back as timed tokens of its own: it joins the previous word (a leading one, the next) and stretches its end
      const words: { text: string; start: number; end: number }[] = [];
      let lead = "";
      for (const s of j.transcription || []) {
        const text = String(s.text).trim();
        if (!text) continue;
        const prev = words[words.length - 1];
        if (!/^\p{P}+$/u.test(text)) { if (late(s.offsets.from / 1000)) break; words.push({ text: lead + text, start: at(s.offsets.from / 1000), end: at(s.offsets.to / 1000) }); lead = ""; }
        else if (prev) { prev.text += text; prev.end = at(s.offsets.to / 1000); }
        else lead += text;
      }
      return { source: path, language: j.result?.language ?? language ?? null, text: words.map((w) => w.text).join(" "), words, skipped_leading: skipped };
    }
    const r = await run("whisper", [wav, "--word_timestamps", "True", "--output_format", "json", "--output_dir", tmp, ...(language ? ["--language", language] : []), ...(model ? ["--model", model] : [])], { signal, maxBuffer: 1 << 28 });
    if (r.status !== 0 || !existsSync(join(tmp, "a.json"))) throw asrError("whisper", r, language);
    const j = JSON.parse(readFileSync(join(tmp, "a.json"), "utf8"));
    const words = j.segments.flatMap((s: any) => (s.words || []).filter((w: any) => !late(w.start)).map((w: any) => ({ text: String(w.word).trim(), start: at(w.start), end: at(w.end) })));
    return { source: path, language: j.language, text: words.map((w: any) => w.text).join(" "), words, skipped_leading: skipped };
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
