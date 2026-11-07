// Audio / subtitle / TTS features on real speech (macOS `say`, Vietnamese voice Linh) mixed with noise, room reverb and a
// music-like bed: enhance_voice, pitch on speech, soft subtitles in mp4/mov/mkv/webm, add_voiceover -> captions -> render.
// Skips (exit 0) when `say` or the Linh voice is unavailable (Linux CI). Run: bun tests/realmedia.ts [--keep]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const voices = spawnSync("say", ["-v", "?"], { encoding: "utf8" });
if (voices.error || !/^Linh\b/m.test(voices.stdout ?? "")) {
  console.log(`SKIP realmedia: ${voices.error ? "`say` not available (macOS only)" : "macOS voice 'Linh' not installed"}`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "agentcut-realmedia-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("../src/api.ts");
const { buildAudio } = await import("../src/audio.ts");
const AN = await import("../src/analyze.ts");

let failures = 0;
const t0 = performance.now();
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-nostdin", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}
/** mono 48 kHz samples of [a, b) */
function pcm(f: string, a = 0, b = 1e9): Float32Array {
  const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", f, "-af", `atrim=start=${a}:end=${b},pan=mono|c0=0.5*c0+0.5*c1`, "-f", "f32le", "-ar", "48000", "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
}
const db = (x: number) => 10 * Math.log10(x + 1e-20);
/** RMS dB over [a, b) and the spread (std, dB) of its 50 ms windows */
function level(f: string, a: number, b: number) {
  const x = pcm(f, a, b), n = 2400, w: number[] = [];
  for (let i = 0; i + n <= x.length; i += n) { let s = 0; for (let j = i; j < i + n; j++) s += x[j] ** 2; w.push(db(s / n)); }
  const mean = w.reduce((p, q) => p + q, 0) / w.length;
  return { rms: db(x.reduce((p, q) => p + q * q, 0) / x.length), std: Math.sqrt(w.reduce((p, q) => p + (q - mean) ** 2, 0) / w.length) };
}
/** median F0 (Hz) of voiced 40 ms frames, autocorrelation 70..500 Hz */
function f0(x: Float32Array): number {
  const n = 1920, out: number[] = [];
  for (let i = 0; i + 2 * n < x.length; i += n) {
    let e = 0;
    for (let j = 0; j < n; j++) e += x[i + j] ** 2;
    if (e / n < 1e-4) continue;
    let best = 0, lag = 0;
    for (let L = 96; L < 686; L++) { let s = 0; for (let j = 0; j < n; j++) s += x[i + j] * x[i + j + L]; if (s > best) { best = s; lag = L; } }
    if (best / e > 0.5) out.push(48000 / lag);
  }
  return out.sort((a, b) => a - b)[out.length >> 1];
}
/** largest |2nd difference| over its 99.9th percentile: a click or splice discontinuity sticks far out (> ~3) */
function clickRatio(x: Float32Array): number {
  const d = new Float32Array(x.length - 2);
  for (let i = 2; i < x.length; i++) d[i - 2] = Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]);
  const s = d.slice().sort();
  return s[s.length - 1] / s[Math.floor(s.length * 0.999)];
}
const probeJson = (f: string) => JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", f], { encoding: "utf8" }).stdout);

const m = join(tmp, "media");
mkdirSync(m);
console.log("media ->", tmp);
// speech: three sentences with ~1 s pauses (slnc) so the noise floor can be measured between them
const speech = join(m, "linh.aiff");
spawnSync("say", ["-v", "Linh", "-o", speech, "Xin chào các bạn. [[slnc 900]] Hôm nay chúng ta sẽ học cách dựng video. [[slnc 900]] Đừng quên đăng ký kênh nhé."]);
const pauses = AN.silence(speech, -45, 0.4).silences.filter(([s, e]) => e - s > 0.8).map(([s, e]) => [s + 0.2, e - 0.2]);
check("fixture: speech has two ~1 s pauses", pauses.length >= 2, pauses);
// noisy room: early reflections + brown/white noise (~10 dB SNR)
const noisy = join(m, "noisy.wav");
ff("-i", speech, "-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=0.08:seed=5:duration=20", "-f", "lavfi", "-i", "anoisesrc=color=white:amplitude=0.02:seed=9:duration=20",
  "-filter_complex", "[0]aresample=48000,aecho=0.8:0.7:60|110|170:0.4|0.3|0.2,volume=0.7,apad=pad_dur=1[s];[1][2]amix=inputs=2:normalize=0[n];[s][n]amix=inputs=2:normalize=0:duration=first",
  "-ac", "2", "-ar", "48000", noisy);
// music-like bed: A major chord + decaying 55 Hz pulse every 0.5 s + pink noise
const music = join(m, "music.wav");
ff("-f", "lavfi", "-i", "aevalsrc='0.2*sin(2*PI*220*t)+0.15*sin(2*PI*277.2*t)+0.15*sin(2*PI*329.6*t)+0.5*sin(2*PI*55*t)*exp(-8*mod(t,0.5))':s=48000:d=12",
  "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.05:seed=1:d=12", "-filter_complex", "[0][1]amix=inputs=2:normalize=0", "-ac", "2", music);
const video = join(m, "bars.mp4");
ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=8", "-pix_fmt", "yuv420p", video);

const project = (name: string) => { const P = join(tmp, name); api.create(P, { width: 320, height: 240, fps: 24 }); return P; };
const mix = (P: string, tag: string, loud: number | null = null) => {
  const p = api.openProject(P), tl = p.absolutized(p.load()), w = join(tmp, `${tag}.wav`);
  tl.settings.loudness = loud;
  return buildAudio(tl, w);
};

console.log("enhance_voice on noisy speech");
{
  const P = project("enhance");
  await api.apply(P, [{ op: "add_clip", track: "voice", src: noisy, at: 0 }]);
  const raw = mix(P, "raw");
  const pauseLevel = (f: string) => pauses.map(([a, b]) => level(f, a, b));
  const speechDb = (f: string) => level(f, 0.1, pauses[0][0] - 0.3).rms;
  const rawPause = pauseLevel(raw)[0].rms, rawSnr = speechDb(raw) - rawPause;
  await api.apply(P, [{ op: "enhance_voice", track: "voice" }]);
  const enh = mix(P, "enh");
  const ep = pauseLevel(enh), snr = speechDb(enh) - ep[0].rms;
  check(`noise floor in pauses down >= 15 dB (${rawPause.toFixed(1)} -> ${ep.map((x) => x.rms.toFixed(1)).join(", ")} dBFS)`, ep.every((x) => x.rms < rawPause - 15));
  check(`speech-to-pause ratio up >= 20 dB (${rawSnr.toFixed(1)} -> ${snr.toFixed(1)} dB)`, snr > rawSnr + 20);
  check(`no pumping: pause level steady (window std ${ep.map((x) => x.std.toFixed(1)).join(", ")} dB < 4)`, ep.every((x) => x.std < 4));
  const L = AN.loudness(enh);
  check(`clip normalised near -16 LUFS before the master (${L.integrated_lufs})`, Math.abs(L.integrated_lufs! + 16) < 2.5);
  const fin = mix(P, "enh-final", -14), FL = AN.loudness(fin);
  check(`final mix -14 LUFS, true peak < -1 dBTP (${FL.integrated_lufs} LUFS, ${FL.true_peak_dbfs} dBTP)`, Math.abs(FL.integrated_lufs! + 14) < 0.7 && FL.true_peak_dbfs! < -1);
  // listen-proxy: before/after spectrograms (kept with --keep) and audio_check findings
  await api.audioCheck(undefined, { source: noisy, spectrogram: true, out: join(tmp, "spec-before.png") });
  const after = await api.audioCheck(P, { spectrogram: true, out: join(tmp, "spec-after.png") });
  const bad = after.findings.filter((f: any) => ["clipping", "over", "true_peak", "cut_off"].includes(f.type));
  check("audio_check after enhance: no clipping/overs/cut-offs", !bad.length, bad);
}

console.log("pitch on speech");
{
  const { pitchFilters } = await import("../src/audiofx.ts");
  const src = pcm(speech), base = f0(src);
  for (const s of [-7, -3, 3, 7]) {
    const out = join(tmp, `pitch${s}.wav`);
    ff("-i", speech, "-af", ["aresample=48000", ...pitchFilters(s, 48000)].join(","), out);
    const x = pcm(out), want = base * 2 ** (s / 12), got = f0(x);
    check(`${s > 0 ? "+" : ""}${s} st: F0 ${base.toFixed(0)} -> ${got.toFixed(0)} Hz (want ${want.toFixed(0)}, within 3%), no clicks (${clickRatio(x).toFixed(2)})`,
      Math.abs(got / want - 1) < 0.03 && clickRatio(x) < 3);
  }
  // the clip sounds to its end: unpadded, atempo dropped the last ~7 ms; with input padding <= 5 ms (its overlap window) remains
  const P = project("pitch");
  const tone = join(m, "tone.wav");
  ff("-f", "lavfi", "-i", "sine=f=300:duration=2", "-ar", "48000", tone);
  await api.apply(P, [{ op: "add_clip", track: "music", src: tone, at: 0, duration: 2, pitch: 7 }]);
  const x = pcm(mix(P, "pitch-tone"));
  let last = 0;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.01) last = i;
  check(`pitched clip sounds to its very end (last sample ${(last / 48000).toFixed(4)} s of 2 s)`, last / 48000 > 1.995);
}

console.log("soft subtitles with Vietnamese text");
{
  const P = project("subs");
  const words = [["Xin", 0.2, 0.5], ["chào", 0.5, 0.9], ["các bạn.", 0.9, 1.4], ["Đừng", 2, 2.4], ["quên", 2.4, 2.8], ["nhé!", 2.8, 3.3]].map(([text, start, end]) => ({ text, start, end }));
  await api.apply(P, [{ op: "add_clip", track: "main", src: video, duration: 4 }, { op: "add_captions", words, preset: "clean" }]);
  const want = "1\n00:00:00,200 --> 00:00:02,000\nXin chào các bạn.\n\n2\n00:00:02,000 --> 00:00:03,600\nĐừng quên nhé!\n";
  for (const [ext, codec] of [["mp4", "mov_text"], ["mov", "mov_text"], ["mkv", "subrip"], ["webm", "webvtt"]]) {
    const out = join(tmp, `subs.${ext}`);
    await api.render(P, { out, subtitles: true, workers: 1, sheet: false });
    const subs = probeJson(out).streams.filter((s: any) => s.codec_type === "subtitle");
    const dump = spawnSync("ffmpeg", ["-v", "error", "-i", out, "-map", "0:s", "-f", "srt", "-"], { encoding: "utf8" }).stdout;
    check(`${ext}: one ${codec} stream, cue times + UTF-8 diacritics round-trip`, subs.length === 1 && subs[0].codec_name === codec && dump.startsWith(want), { codecs: subs.map((s: any) => s.codec_name), dump });
  }
}

console.log("TTS: add_voiceover (Linh) -> captions -> render");
{
  const P = project("tts");
  const text = "Xin chào các bạn. Hôm nay chúng ta sẽ học cách dựng video thật nhanh. Đừng quên đăng ký kênh nhé!";
  const r = (await api.apply(P, [{ op: "add_voiceover", text, voice: "Linh", captions: "clean" }])).results[0];
  const vo = join(P, r.path), segs = AN.silence(vo, -40, 0.15).speech;
  const cap = api.info(P, "json").timeline.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === "captions");
  const firsts = cap.words.filter((_: any, i: number) => i === 0 || /[.!?]$/.test(cap.words[i - 1].text));
  check(`voiceover ${r.duration.toFixed(2)} s, ${segs.length} speech segments for 3 sentences`, r.duration > 3 && segs.length === 3, segs);
  check("each sentence's caption starts with its speech segment (not inside a pause)",
    firsts.length === 3 && firsts.every((w: any, i: number) => Math.abs(w.start - segs[i][0]) < 0.05), { firsts, segs });
  check("caption words keep their diacritics", cap.words.map((w: any) => w.text).join(" ") === text);
  await api.apply(P, [{ op: "add_clip", track: "main", src: video }, { op: "add_clip", track: "music", src: music, at: 0, until_end: true, fade_out: 1 }, { op: "enhance_voice", track: "voice" }]);
  const out = join(tmp, "tts.mp4");
  const res: any = await api.render(P, { out, subtitles: true, workers: 2, sheet: false });
  const L = AN.loudness(out);
  check(`final render -14 LUFS (${L.integrated_lufs}), true peak < -1 dBTP (${L.true_peak_dbfs})`, Math.abs(L.integrated_lufs! + 14) < 1 && L.true_peak_dbfs! < -1);
  check(`render embeds ${res.subtitles?.cues} caption cues`, probeJson(out).streams.some((s: any) => s.codec_name === "mov_text") && res.subtitles?.cues >= 3);
  // default music duck (no override): the check is clean and the voice sits >= 15 LU over the bed across the voiced span (convention, not a listening test)
  const ac = await api.audioCheck(P, {});
  check("audio_check at the default duck: music is ducked", !ac.findings.some((x: any) => x.type === "music_not_ducked"), ac.findings);
  const pr = api.openProject(P), base = pr.absolutized(pr.load()), span = [segs[0][0], segs[segs.length - 1][1]];
  const stemLufs = (track: string) => {
    const tl: any = structuredClone(base);
    tl.settings.loudness = null;
    tl.tracks = tl.tracks.map((t: any) => ({ ...t, volume: t.id === track ? t.volume : 0 }));
    return AN.loudness(buildAudio(tl, join(tmp, `stem-${track}.wav`), span[0], span[1])).integrated_lufs!;
  };
  const vL = stemLufs("voice"), mL = stemLufs("music");
  check(`voice ${vL} LUFS vs ducked bed ${mL} LUFS over the voiced span: >= 15 LU`, vL - mL >= 15, { vL, mL });
  if (!(api.capabilities() as any).engines.transcribe.available)
    console.log("  - transcribe round-trip skipped: no whisper (whisper-cli + AGENTCUT_WHISPER_MODEL, or openai-whisper)");
  else {
    const tr = AN.transcribe(out, "vi");
    // Share of script words returned as whole tokens, in order (LCS over normalised words). Measured on this mix with whisper base,
    // -ml 1: 10/21 (48%) when words split mid-syllable (no -sow), 21/21 (100%) with -sow. 80% sits between, 4 words under the green result.
    // Fixed before the fix; a miss is a measurement limit of the model, not a reason to retune it.
    const MIN_SHARE = 0.8;
    const norm = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);
    const want = norm(text), got = tr.words.map((w: any) => norm(w.text).join(" ")).filter(Boolean);
    const lcs = want.map(() => new Array(got.length + 1).fill(0)).concat([new Array(got.length + 1).fill(0)]);
    for (let i = want.length - 1; i >= 0; i--) for (let j = got.length - 1; j >= 0; j--) lcs[i][j] = want[i] === got[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const share = lcs[0][0] / want.length;
    check(`whisper returns ${lcs[0][0]}/${want.length} script words whole and in order (${(share * 100).toFixed(0)}%, need ${MIN_SHARE * 100}%): ${tr.text.slice(0, 80)}`, share >= MIN_SHARE);
    check("no transcribed word is punctuation only", tr.words.every((w: any) => !/^\p{P}+$/u.test(w.text)), tr.words.filter((w: any) => /^\p{P}+$/u.test(w.text)));
  }
}

const el = ((performance.now() - t0) / 1000).toFixed(1);
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} check(s) FAILED in ${el}s`); process.exit(1); }
console.log(`\nOK - all realmedia checks passed in ${el}s`);
