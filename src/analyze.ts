// Media analysis: beats (spectral flux + DP tracker, pure TS FFT), scene cuts, silence, loudness, TTS, transcription.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { needFfmpeg, probe } from "./media.ts";
import { EditError, suggest } from "./model.ts";
import { has, httpSpeech, pickProvider, piperSpeech, providerInfo } from "./tts.ts";

function decodeMono(path: string, sr = 22050): Float32Array {
  needFfmpeg();
  const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", path, "-vn", "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
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

export function scenes(path: string, threshold = 0.3) {
  needFfmpeg();
  const info = probe(path);
  const r = spawnSync("ffmpeg", ["-v", "info", "-nostdin", "-i", path, "-an", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const cuts = [...(r.stderr || "").matchAll(/pts_time:([\d.]+)/g)].map((m) => +(+m[1]).toFixed(3));
  const dur = info.duration ?? 0;
  const b = [0, ...cuts, dur];
  const shots = b.slice(0, -1).map((s, i) => ({ start: s, end: b[i + 1], duration: +(b[i + 1] - s).toFixed(3) })).filter((s) => s.duration > 0.05);
  return { source: path, threshold, cuts, shots, duration: dur };
}

export function silence(path: string, noiseDb = -35, minSilence = 0.4) {
  needFfmpeg();
  const info = probe(path);
  if (!info.has_audio && info.kind !== "audio") throw new EditError("file has no audio", "no_audio");
  const r = spawnSync("ffmpeg", ["-v", "info", "-nostdin", "-i", path, "-vn", "-af", `silencedetect=noise=${noiseDb}dB:d=${minSilence}`, "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const st = [...(r.stderr || "").matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => +m[1]);
  const en = [...(r.stderr || "").matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const dur = Number(info.duration ?? 0);
  const sil = st.map((s, i) => [+Math.max(0, s).toFixed(3), +(en[i] ?? dur).toFixed(3)]);
  const speech: number[][] = [];
  let t = 0;
  for (const [s, e] of sil) { if (s - t > 0.05) speech.push([+t.toFixed(3), s]); t = e; }
  if (dur - t > 0.05) speech.push([+t.toFixed(3), +dur.toFixed(3)]);
  return { source: path, noise_db: noiseDb, min_silence: minSilence, silences: sil, speech, duration: dur };
}

export function loudness(path: string) {
  needFfmpeg();
  const r = spawnSync("ffmpeg", ["-v", "info", "-nostdin", "-i", path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 });
  const txt = (r.stderr || "").slice((r.stderr || "").lastIndexOf("Summary:"));
  const grab = (l: string) => { const m = new RegExp(`${l}:\\s+(-?[\\d.]+|-inf)`).exec(txt); return m && m[1] !== "-inf" ? +m[1] : null; };
  return { source: path, integrated_lufs: grab("I"), range_lu: grab("LRA"), true_peak_dbfs: grab("Peak") };
}

/** Non-blocking variant (used right after renders so it overlaps with the contact sheet). */
export function loudnessAsync(path: string): Promise<ReturnType<typeof loudness>> {
  return new Promise((res) => {
    const p = spawn("ffmpeg", ["-v", "info", "-nostdin", "-i", path, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]);
    let err = "";
    p.stderr.on("data", (d) => { err += d; if (err.length > 1e6) err = err.slice(-20000); });
    p.on("close", () => {
      const txt = err.slice(err.lastIndexOf("Summary:"));
      const grab = (l: string) => { const m = new RegExp(`${l}:\\s+(-?[\\d.]+|-inf)`).exec(txt); return m && m[1] !== "-inf" ? +m[1] : null; };
      res({ source: path, integrated_lufs: grab("I"), range_lu: grab("LRA"), true_peak_dbfs: grab("Peak") });
    });
  });
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

/** Every TTS provider (available or not, with a setup hint) and the voices usable now. */
export function ttsVoices() {
  const sys = systemVoices(), extra = providerInfo();
  return {
    default_provider: pickProvider().provider,
    providers: [{ name: "system", available: sys.length > 0, engine: process.platform === "darwin" ? "say" : process.platform === "win32" ? "sapi" : "espeak" }, ...extra.providers],
    voices: [...sys, ...extra.voices],
  };
}

/** One TTS entry point. voice "piper[:model.onnx]" / "openai:<voice>" / "system:<name>" picks the provider, else AGENTCUT_TTS_PROVIDER (default system). */
export function tts(text: string, outPath: string, voice?: string, rate?: number) {
  needFfmpeg();
  mkdirSync(dirname(outPath), { recursive: true });
  const { provider, voice: v } = pickProvider(voice);
  const tmp = mkdtempSync(join(tmpdir(), "agentcut-tts-"));
  try {
    const raw = provider === "piper" ? piperSpeech(text, tmp, v, rate) : provider === "openai" ? httpSpeech(text, tmp, v, rate) : systemSpeech(text, tmp, v, rate);
    const c = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-ar", "48000", "-ac", "2", outPath], { encoding: "utf8" });
    if (c.status !== 0) throw new EditError(`tts convert failed: ${(c.stderr || "").slice(0, 300)}`, "tts_failed");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  return { path: outPath, duration: probe(outPath).duration, voice: voice ?? null, provider };
}

/** OS voice: macOS `say`, Windows SAPI, Linux espeak. Returns the raw audio path in tmp. */
function systemSpeech(text: string, tmp: string, voice?: string, rate?: number): string {
  let raw = join(tmp, "tts.aiff");
  // text goes in a file, never argv: a script starting with "-" would be parsed as an option
  const txt = join(tmp, "tts.txt");
  writeFileSync(txt, text);
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
    r = spawnSync("say", [...args, "-f", txt], { encoding: "utf8" });
  } else if (process.platform === "win32") {
    raw = join(tmp, "tts.wav");
    const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ${voice ? `$s.SelectVoice('${voice.replace(/'/g, "''")}');` : ""}${rate ? `$s.Rate=${Math.round((rate - 175) / 25)};` : ""}$s.SetOutputToWaveFile('${raw.replace(/'/g, "''")}'); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`;
    r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { input: text, encoding: "utf8" });
  } else {
    raw = join(tmp, "tts.wav");
    const exe = has("espeak-ng") ? "espeak-ng" : has("espeak") ? "espeak" : null;
    if (!exe) throw new EditError("no TTS engine found", "missing_dependency", "install espeak-ng (apt install espeak-ng), or generate audio elsewhere and import it");
    r = spawnSync(exe, ["-w", raw, ...(voice ? ["-v", voice] : []), ...(rate ? ["-s", String(rate)] : []), "-f", txt], { encoding: "utf8" });
  }
  if (r.status !== 0) throw new EditError(`tts failed: ${(r.stderr || "").slice(0, 300)}`, "tts_failed");
  return raw;
}

/** Word-level transcription via whisper.cpp (`whisper-cli`) or OpenAI whisper (`whisper`) if installed. */
export function transcribe(path: string, language?: string, model?: string) {
  needFfmpeg();
  const tmp = mkdtempSync(join(tmpdir(), "agentcut-asr-"));
  try {
    const wav = join(tmp, "a.wav");
    spawnSync("ffmpeg", ["-v", "error", "-y", "-i", path, "-ar", "16000", "-ac", "1", wav]);
    const cli = ["whisper-cli", "whisper-cpp", "main"].find((b) => !spawnSync(b, ["--help"], { stdio: "ignore" }).error);
    const mdl = model ?? process.env.AGENTCUT_WHISPER_MODEL;
    if (cli && mdl) {
      const r = spawnSync(cli, ["-m", mdl, "-f", wav, "-oj", "-ojf", "-ml", "1", "-of", join(tmp, "out"), ...(language ? ["-l", language] : ["-l", "auto"])], { encoding: "utf8", maxBuffer: 1 << 28 });
      if (r.status !== 0) throw new EditError(`whisper failed: ${(r.stderr || "").slice(-300)}`, "asr_failed");
      const j = JSON.parse(readFileSync(join(tmp, "out.json"), "utf8"));
      const words = (j.transcription || []).map((s: any) => ({ text: String(s.text).trim(), start: s.offsets.from / 1000, end: s.offsets.to / 1000 })).filter((w: any) => w.text);
      return { source: path, language: j.result?.language ?? language ?? null, text: words.map((w: any) => w.text).join(" "), words };
    }
    if (!spawnSync("whisper", ["--help"], { stdio: "ignore" }).error) {
      const r = spawnSync("whisper", [wav, "--word_timestamps", "True", "--output_format", "json", "--output_dir", tmp, ...(language ? ["--language", language] : []), ...(model ? ["--model", model] : [])], { encoding: "utf8", maxBuffer: 1 << 28 });
      if (r.status !== 0) throw new EditError(`whisper failed: ${(r.stderr || "").slice(-300)}`, "asr_failed");
      const j = JSON.parse(readFileSync(join(tmp, "a.json"), "utf8"));
      const words = j.segments.flatMap((s: any) => (s.words || []).map((w: any) => ({ text: String(w.word).trim(), start: +w.start.toFixed(3), end: +w.end.toFixed(3) })));
      return { source: path, language: j.language, text: j.text, words };
    }
    throw new EditError("transcription needs whisper", "missing_dependency",
      "install whisper.cpp (`brew install whisper-cpp`) and set AGENTCUT_WHISPER_MODEL=/path/ggml-model.bin, or `pip install openai-whisper`; or supply an .srt to add_captions");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
