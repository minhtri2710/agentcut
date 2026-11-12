// Media analysis: beats (spectral flux + DP tracker, pure TS FFT), scene cuts, silence, loudness, TTS, transcription.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

function decodeMono(path: string, sr = 22050): Float32Array {
  needFfmpeg();
  const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", ...inp(path), "-vn", "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new EditError(`cannot decode audio from ${path}: ${String(r.stderr).slice(0, 300)}`, "decode_failed");
  const b = r.stdout as Buffer;
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

export function beats(path: string, minBpm = 60, maxBpm = 200) {
  const sr = 22050, hop = 512, nfft = 2048;
  const y = decodeMono(path, sr);
  if (y.length < nfft * 4) throw new EditError("audio too short for beat detection", "too_short");
  const nfr = 1 + Math.floor((y.length - nfft) / hop);
  const bins = Math.floor(8000 / (sr / nfft));
  const win = new Float64Array(nfft).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1)));
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  let prev = new Float64Array(bins), cur = new Float64Array(bins);
  const flux = new Float64Array(nfr);
  for (let f = 0; f < nfr; f++) {
    const off = f * hop;
    for (let i = 0; i < nfft; i++) { re[i] = y[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let s = 0;
    for (let b = 0; b < bins; b++) {
      cur[b] = Math.log1p(100 * Math.hypot(re[b], im[b]));
      if (f > 0) s += Math.max(0, cur[b] - prev[b]);
    }
    flux[f] = s / bins;
    [prev, cur] = [cur, prev];
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
  if (typeof text !== "string" || !text.trim()) throw new EditError("tts needs the text to speak", "missing_input", "e.g. agentcut tts \"Hello\" -o out.wav");
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
        throw new EditError(`voice '${voice}' not installed`, "bad_voice", `${s ? `did you mean '${s}'? ` : ""}list voices with \`agentcut voices\` (Vietnamese: 'Linh')`);
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
  }
  if (r.status !== 0) throw new EditError(`tts failed: ${r.stderr.slice(0, 300)}`, "tts_failed");
  return raw;
}

const WHISPER_CLIS = ["whisper-cli", "whisper-cpp", "main"];

/** The engine transcribe() uses: whisper.cpp when a CLI is on PATH and a model is set, else OpenAI whisper on PATH, else none. A lookup only. */
function asrEngine(model = process.env.AGENTCUT_WHISPER_MODEL): { cli: string; model: string } | { python: true } | null {
  const cli = WHISPER_CLIS.find(has);
  if (cli && model) return { cli, model };
  return has("whisper") ? { python: true } : null;
}

/** What `capabilities` says about transcription (same selection as transcribe(); nothing is started). */
export function transcribeEngine() {
  const e = asrEngine(), model = process.env.AGENTCUT_WHISPER_MODEL, cli = WHISPER_CLIS.find(has);
  const modelOk = !!model && existsSync(model), available = !!e && ("python" in e || modelOk);
  return {
    available, engine: e ? ("cli" in e ? e.cli : "whisper") : null, model: e && "cli" in e && modelOk ? model : null,
    languages: "auto, or a whisper language code such as vi or en",
    ...(available ? {} : { hint: e && "cli" in e ? `AGENTCUT_WHISPER_MODEL=${model} does not exist: point it at a ggml model file` : cli ? `${cli} found: set AGENTCUT_WHISPER_MODEL=/path/ggml-model.bin` : "install whisper.cpp (`brew install whisper-cpp`) and set AGENTCUT_WHISPER_MODEL=/path/ggml-model.bin, or `pip install openai-whisper`" }),
  };
}

/**
 * Word-level transcription via whisper.cpp (`whisper-cli`) or OpenAI whisper (`whisper`) if installed.
 * range = [start, end] seconds of the media: only that stretch is transcribed and the word times stay in media seconds.
 * Whisper may invent text over a long music-only stretch and times words early after a music lead-in; no engine option prevents it.
 */
export async function transcribe(path: string, language?: string, model?: string, range?: [number, number], signal?: AbortSignal) {
  if (range !== undefined && !(Array.isArray(range) && range.length === 2 && range.every((x) => typeof x === "number" && Number.isFinite(x)) && range[0] >= 0 && range[1] > range[0]))
    throw new EditError("transcribe range must be [start, end] in seconds with 0 <= start < end", "bad_value", "e.g. [0, 12.5]: the speech only; analyze_silence or the voiceover's length gives it");
  const [from, to] = range ?? [0, undefined];
  const shift = (x: number) => +(x + from).toFixed(3);
  needFfmpeg();
  const tmp = mkdtempSync(join(tmpdir(), "agentcut-asr-"));
  try {
    const wav = join(tmp, "a.wav");
    await run("ffmpeg", ["-v", "error", "-y", ...(range ? ["-ss", String(from)] : []), ...inp(path), ...(to !== undefined ? ["-t", String(to - from)] : []), "-ar", "16000", "-ac", "1", wav], { signal });
    const asr = asrEngine(model);
    if (asr && "cli" in asr) {
      const { cli, model: mdl } = asr;
      // -ml 1 alone splits inside a syllable ("ch","ào"); -sow splits only on whole words
      const r = await run(cli, ["-m", mdl, "-f", wav, "-oj", "-ojf", "-ml", "1", "-sow", "-of", join(tmp, "out"), ...(language ? ["-l", language] : ["-l", "auto"])], { signal, maxBuffer: 1 << 28 });
      if (r.status !== 0) throw new EditError(`whisper failed: ${r.stderr.slice(-300)}`, "asr_failed");
      const j = JSON.parse(readFileSync(join(tmp, "out.json"), "utf8"));
      // punctuation comes back as timed tokens of its own: it joins the previous word (a leading one, the next) and stretches its end
      const words: { text: string; start: number; end: number }[] = [];
      let lead = "";
      for (const s of j.transcription || []) {
        const text = String(s.text).trim();
        if (!text) continue;
        const prev = words[words.length - 1];
        if (!/^\p{P}+$/u.test(text)) { words.push({ text: lead + text, start: shift(s.offsets.from / 1000), end: shift(s.offsets.to / 1000) }); lead = ""; }
        else if (prev) { prev.text += text; prev.end = shift(s.offsets.to / 1000); }
        else lead += text;
      }
      return { source: path, language: j.result?.language ?? language ?? null, text: words.map((w) => w.text).join(" "), words };
    }
    if (asr) {
      const r = await run("whisper", [wav, "--word_timestamps", "True", "--output_format", "json", "--output_dir", tmp, ...(language ? ["--language", language] : []), ...(model ? ["--model", model] : [])], { signal, maxBuffer: 1 << 28 });
      if (r.status !== 0) throw new EditError(`whisper failed: ${r.stderr.slice(-300)}`, "asr_failed");
      const j = JSON.parse(readFileSync(join(tmp, "a.json"), "utf8"));
      const words = j.segments.flatMap((s: any) => (s.words || []).map((w: any) => ({ text: String(w.word).trim(), start: shift(w.start), end: shift(w.end) })));
      return { source: path, language: j.language, text: j.text, words };
    }
    throw new EditError("transcription needs whisper", "missing_dependency",
      "install whisper.cpp (`brew install whisper-cpp`) and set AGENTCUT_WHISPER_MODEL=/path/ggml-model.bin, or `pip install openai-whisper`; or supply an .srt to add_captions");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ analyses inside apply_ops
// Ops are synchronous, so an op that needs transcribe, tts or silence asks the Project's memo (`analysis`). A miss throws NeedsAnalysis;
// api.apply computes it (`compute`, async, with the call's signal), keeps the outcome in the memo and re-runs the batch from a fresh load.
// A failed analysis is kept as its EditError, so the re-run throws it from the same op and the batch error names that op as before.
export type Request =
  | { kind: "transcribe"; path: string; language?: string; range?: [number, number] }
  | { kind: "tts"; text: string | undefined; voice?: string; rate?: number | null }
  | { kind: "silence"; path: string; noiseDb: number; minSilence: number };
type Answers = { transcribe: Awaited<ReturnType<typeof transcribe>>; tts: Awaited<ReturnType<typeof tts>>; silence: Awaited<ReturnType<typeof silence>> };

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
      : await silence(r.path, r.noiseDb, r.minSilence, signal);
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
