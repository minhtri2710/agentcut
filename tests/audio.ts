// Audio processing (denoise, eq, compressor, pan, pitch, normalize; clip + track bus), enhance_voice, subtitle export/embed.
// Measures rendered audio with FFmpeg. Run: bun tests/audio.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-audio-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store - set before importing the API
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("../src/api.ts");
const { buildAudio, kfExpr } = await import("../src/audio.ts");
const { noiseFloor } = await import("../src/audiofx.ts");

let failures = 0;
const t0 = performance.now();
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}
/** RMS dB of [a, b) of a file through an optional extra filter (channel: mono mix, or 0/1). */
function rms(f: string, a: number, b: number, ch?: 0 | 1): number {
  const pick = ch === undefined ? "pan=mono|c0=0.5*c0+0.5*c1" : `pan=mono|c0=c${ch}`;
  const r = spawnSync("ffmpeg", ["-v", "info", "-nostdin", "-i", f, "-af", `atrim=start=${a}:end=${b},${pick},astats=measure_overall=RMS_level:measure_perchannel=none`, "-f", "null", "-"], { encoding: "utf8" });
  const m = (r.stderr.match(/RMS level dB: (-?[\d.]+|-inf)/g) ?? []).pop();
  return m ? Number(m.split(": ")[1]) : NaN;
}
function lufs(f: string): number {
  const r = spawnSync("ffmpeg", ["-v", "info", "-nostdin", "-i", f, "-vn", "-af", "ebur128", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/I:\s+(-?[\d.]+)\s+LUFS/.exec(r.stderr.slice(r.stderr.lastIndexOf("Summary:")))?.[1]);
}
/** dominant frequency (Hz) by zero crossings of channel 0 in [a, b) */
function freq(f: string, a: number, b: number): number {
  const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", f, "-af", `atrim=start=${a}:end=${b},pan=mono|c0=c0`, "-f", "f32le", "-ar", "48000", "-"], { maxBuffer: 1 << 26 });
  const x = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
  let z = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) z++;
  return z / 2 / (x.length / 48000);
}
async function rejects(f: () => Promise<unknown> | unknown, code: string) {
  try { await f(); return false; } catch (e: any) { return e.code === code; }
}

const m = join(tmp, "media");
mkdirSync(m);
console.log("media ->", tmp);
// "talk": 440 Hz tone 0..2 s over pink noise for 4 s (the noise-only tail measures the noise floor)
ff("-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.03:seed=7:duration=4", "-f", "lavfi", "-i", "sine=f=440:duration=2",
  "-filter_complex", "[1]volume=0.4,apad[s];[0][s]amix=inputs=2:normalize=0:duration=first", "-ac", "2", "-ar", "48000", join(m, "talk.wav"));
ff("-f", "lavfi", "-i", "sine=f=440:duration=4", "-ac", "2", "-ar", "48000", join(m, "tone.wav"));
ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=4", "-i", join(m, "talk.wav"), "-shortest", "-pix_fmt", "yuv420p", join(m, "talk.mp4"));

const P = join(tmp, "proj");
api.create(P, { width: 320, height: 240, fps: 24 });
const apply = async (ops: any[]) => (await api.apply(P, ops)).results;
const mix = (tag: string, loud: number | null = null) => {
  const p = api.openProject(P), tl = p.absolutized(p.load()), w = join(tmp, `${tag}.wav`);
  tl.settings.loudness = loud; // off: compare raw levels between variants
  return buildAudio(tl, w);
};
const tracks = () => api.info(P, "json").timeline.tracks;
const clip = (id: string) => tracks().flatMap((t: any) => t.clips).find((c: any) => c.id === id);

await apply([{ op: "add_clip", track: "voice", src: join(m, "talk.wav"), at: 0, duration: 4 }]); // aud1
const base = mix("base");
const baseNoise = rms(base, 2.5, 4), baseTone = rms(base, 0.5, 1.5);

console.log("denoise");
await apply([{ op: "update_clip", id: "aud1", set: { denoise: true } }]);
const dn = mix("denoise");
check(`noise floor drops >= 6 dB (${baseNoise.toFixed(1)} -> ${rms(dn, 2.5, 4).toFixed(1)})`, baseNoise - rms(dn, 2.5, 4) >= 6);
check(`tone kept within 1.5 dB (${baseTone.toFixed(1)} -> ${rms(dn, 0.5, 1.5).toFixed(1)})`, Math.abs(baseTone - rms(dn, 0.5, 1.5)) < 1.5);
await apply([{ op: "update_clip", id: "aud1", set: { denoise: 1 } }]);
check("strength 1 removes more than 0.5", rms(mix("denoise1"), 2.5, 4) < rms(dn, 2.5, 4) - 2);

/** write a mono float signal as a stereo wav in the media dir */
const wavOf = (name: string, x: Float32Array) => {
  const f = join(m, name);
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "f32le", "-ar", "48000", "-ac", "1", "-i", "-", "-af", "pan=stereo|c0=c0|c1=c0", f], { input: Buffer.from(x.buffer, x.byteOffset, x.byteLength) });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return f;
};
/** one-clip project (denoise on/off), mixed with the loudness master off; returns the mixed wav */
const project = async (name: string, src: string, dur: number, denoise: boolean) => {
  const proj = join(tmp, name);
  api.create(proj, { width: 320, height: 240, fps: 24 });
  await api.apply(proj, [{ op: "add_clip", track: "voice", src, at: 0, duration: dur, ...(denoise ? { denoise: true } : {}) }]);
  const p = api.openProject(proj), tl = p.absolutized(p.load());
  tl.settings.loudness = null;
  return buildAudio(tl, join(tmp, `${name}.wav`));
};

console.log("denoise floor: continuous speech has no pauses to measure the noise in");
{
  // synthetic voiced words (buzz with formant-like tilt, jittered f0, aspiration), ~-20 dBFS; optional long fade-out at the end; white noise at noiseDb
  const SR = 48000;
  const synth = (gapMs: number, words: number, noiseDb: number, fadeSec: number) => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const out: number[] = [];
    const quiet = (n: number) => { for (let i = 0; i < n; i++) out.push(0); };
    quiet(0.3 * SR);
    for (let w = 0; w <= words; w++) {
      const last = w === words, f0 = 120 + ((w * 37) % 40), sus = Math.round((last ? 0.25 : 0.33) * SR), n = last ? sus + Math.round(fadeSec * SR) : Math.round(0.48 * SR);
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR, f = f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 5 * t + w));
        ph += 2 * Math.PI * f / SR;
        let v = 0;
        for (let h = 1; h <= 20; h++) v += Math.sin(h * ph) / h ** 1.2 * (1 + 0.6 * Math.exp(-((h * f - 700) ** 2) / 2e5) + 0.5 * Math.exp(-((h * f - 1800) ** 2) / 4e5));
        const env = i < 0.03 * SR ? i / (0.03 * SR) : i < sus ? 1 : last ? 10 ** (-20 / 20) : 10 ** (-22 * ((i - sus) / (n - sus)) / 20);
        out.push((v * 0.5 + 0.08 * rnd()) * env * 0.3);
      }
      quiet(Math.round(gapMs / 1000 * SR));
    }
    const x = Float32Array.from(out), a = 10 ** (noiseDb / 20) * Math.sqrt(3);
    for (let i = 0; i < x.length; i++) x[i] += a * rnd();
    return x;
  };
  // continuous clip, noise at -70 dBFS: the sentence-final fade (600 ms at -20 dB) must survive the gate and afftdn
  const cont = synth(40, 12, -70, 0.6), contSrc = wavOf("cont.wav", cont), contDur = cont.length / SR;
  const fadeEnd = contDur, fadeA = fadeEnd - 0.15; // last 150 ms of the fade
  const contRaw = await project("cont-raw", contSrc, contDur, false), contDn = await project("cont-dn", contSrc, contDur, true);
  const kept = rms(contDn, fadeA, fadeEnd) - rms(contRaw, fadeA, fadeEnd);
  check(`continuous speech: last 150 ms of a soft ending keeps its level (${kept.toFixed(1)} dB, tolerance 3)`, Math.abs(kept) <= 3, kept);
  const flo = noiseFloor(contSrc, 0, contDur);
  check(`noiseFloor of a clip with no pauses stays near the noise, not on the speech (${flo?.toFixed(1)} dBFS, true -70)`, flo !== null && flo < -60, flo);
  // clip with real pauses: the gate still has to take the noise out
  const talk = synth(600, 8, -50, 0.3), talkSrc = wavOf("talk-pauses.wav", talk), talkDur = talk.length / SR;
  const talkRaw = await project("pauses-raw", talkSrc, talkDur, false), talkDn = await project("pauses-dn", talkSrc, talkDur, true);
  const pa = 0.3 + 2 * 0.48 + 0.6 + 0.3, pb = pa + 0.2; // inside the second pause (1.86-2.46 s), past the gate's release
  const reduction = rms(talkRaw, pa, pb) - rms(talkDn, pa, pb);
  check(`pauses: noise in the gaps drops >= 15 dB (${reduction.toFixed(1)})`, reduction >= 15, reduction);
  const tflo = noiseFloor(talkSrc, 0, talkDur);
  check(`noiseFloor with pauses is the noise level (${tflo?.toFixed(1)} dBFS, true -50)`, tflo !== null && Math.abs(tflo + 50) < 1.5, tflo);
}

console.log("denoise: the clip stays aligned and complete (afftdn delays its output by 25 ms per stage)");
{
  const SR = 48000;
  let seed = 99;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  // 1 s: noise at -60 dBFS, a 1 kHz tone 0.5-0.8 s with a hard start, and a 1 kHz burst in the final 10 ms (inside the gate's release)
  const x = new Float32Array(SR);
  for (let i = 0; i < SR; i++) {
    const tone = (i >= 0.5 * SR && i < 0.8 * SR) || i >= SR - 0.01 * SR;
    x[i] = 10 ** (-60 / 20) * Math.sqrt(3) * rnd() + (tone ? 0.3 * Math.sin(2 * Math.PI * 1000 * i / SR) : 0);
  }
  const src = wavOf("align.wav", x);
  const raw = await project("align-raw", src, 1, false), dnA = await project("align-dn", src, 1, true);
  const onset = (f: string) => {
    const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", f, "-af", "pan=mono|c0=c0", "-f", "f32le", "-ar", "48000", "-"], { maxBuffer: 1 << 26 });
    const y = new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length));
    return y.findIndex((v) => Math.abs(v) > 0.05);
  };
  const shift = onset(dnA) - onset(raw);
  check(`tone onset lands where it does without denoise (${shift} samples, tolerance 48 = 1 ms)`, Math.abs(shift) <= 48, shift);
  const tailKept = rms(dnA, 0.99, 1) - rms(raw, 0.99, 1);
  check(`a burst in the final 10 ms survives (${tailKept.toFixed(1)} dB, tolerance 3)`, Math.abs(tailKept) <= 3, tailKept);
}

console.log("pan");
await apply([{ op: "update_clip", id: "aud1", set: { denoise: null, pan: -0.8 } }]);
const pl = mix("pan");
const bal = rms(pl, 0.5, 1.5, 0) - rms(pl, 0.5, 1.5, 1);
check(`pan -0.8: left louder by ~14 dB (${bal.toFixed(1)})`, Math.abs(bal - 20 * Math.log10(1 / 0.2)) < 1);
check("centre channel kept at unity", Math.abs(rms(pl, 0.5, 1.5, 0) - rms(base, 0.5, 1.5, 0)) < 0.2);

console.log("pitch");
await apply([
  { op: "update_clip", id: "aud1", set: { pan: null, muted: true } },
  { op: "update_track", id: "music", set: { duck: null } }, // levels below are absolute: no ducking under the (muted) voice clip
  { op: "add_clip", track: "music", src: join(m, "tone.wav"), at: 0, duration: 3, pitch: 12 }, // aud2
]);
const pt = mix("pitch");
check(`+12 semitones: 440 -> ~880 Hz (${freq(pt, 0.5, 2.5).toFixed(0)})`, Math.abs(freq(pt, 0.5, 2.5) - 880) < 15);
check("duration unchanged: tone stops at 3 s", rms(pt, 2.5, 2.95) > -40 && !(rms(pt, 3.05, 3.9) > -60));

console.log("normalize + eq + compressor");
await apply([{ op: "update_clip", id: "aud2", set: { pitch: null, volume: 0.1, normalize: -20 } }]);
const nl = lufs(mix("norm"));
check(`normalize -20 LUFS, then volume 0.1 (-20 dB) -> ~-40 LUFS (${nl.toFixed(1)})`, Math.abs(nl + 40) < 1);
await apply([{ op: "update_clip", id: "aud2", set: { volume: null, normalize: null, eq: [{ type: "high_pass", f: 2000 }] } }]);
const hp = rms(mix("hp"), 0.5, 2.5);
await apply([{ op: "update_clip", id: "aud2", set: { eq: null } }]);
const plain = rms(mix("plain"), 0.5, 2.5);
check(`high_pass 2 kHz cuts a 440 Hz tone by > 20 dB (${plain.toFixed(1)} -> ${hp.toFixed(1)})`, hp < plain - 20);
await apply([{ op: "update_clip", id: "aud2", set: { compressor: { type: "voice", makeup: 0, threshold: -30, ratio: 8 } } }]);
check(`compressor lowers a loud tone (${plain.toFixed(1)} -> ${rms(mix("comp"), 0.5, 2.5).toFixed(1)})`, rms(mix("comp"), 0.5, 2.5) < plain - 6);

console.log("track bus");
await apply([
  { op: "update_clip", id: "aud2", set: { compressor: null } },
  { op: "update_track", id: "music", set: { pan: 1, eq: "low_cut" } },
]);
const tb = mix("bus");
check(`track pan 1 silences the left channel (L ${rms(tb, 0.5, 2.5, 0)}, R ${rms(tb, 0.5, 2.5, 1).toFixed(1)})`, !(rms(tb, 0.5, 2.5, 0) > -80) && rms(tb, 0.5, 2.5, 1) > -40);
await apply([{ op: "update_track", id: "music", set: { pan: null, eq: null, denoise: true } }]);
check("track denoise reaches the clip (per-clip key inherited)", rms(mix("trackdn"), 0.5, 2.5) < plain + 1);

console.log("loudness after processing");
await apply([
  { op: "update_track", id: "music", set: { denoise: null } },
  { op: "remove_clip", id: "aud2" },
  { op: "update_clip", id: "aud1", set: { muted: null } },
  { op: "enhance_voice", track: "voice" },
]);
const target = mix("final", -14);
check(`final mix at -14 LUFS (${lufs(target).toFixed(2)})`, Math.abs(lufs(target) + 14) < 0.7);
const again = mix("final2", -14);
check("deterministic: two mixes are byte-identical", readFileSync(target).equals(readFileSync(again)));

console.log("enhance_voice");
const v = tracks().find((t: any) => t.id === "voice");
check("track carries the voice chain", v.denoise === 0.5 && v.compressor === "voice" && v.normalize === true && v.eq.includes("voice_clarity"), v);
await apply([{ op: "add_clip", track: "main", src: join(m, "talk.mp4"), duration: 4 }, { op: "detach_audio", id: "vid1" }]);
const ev = (await apply([{ op: "enhance_voice", id: "vid1", strength: 0.8 }]))[0];
check("video with detached audio -> enhances the audio clip", ev.id !== "vid1" && clip(ev.id).denoise === 0.8 && clip(ev.id).attach_to === "vid1" && clip("vid1").denoise === undefined, ev);
check("needs id or track", await rejects(() => apply([{ op: "enhance_voice" }]), "missing_arg"));
check("bad strength", await rejects(() => apply([{ op: "enhance_voice", track: "voice", strength: 3 }]), "bad_arg"));

console.log("validation");
for (const [set, name] of [[{ pan: 2 }, "pan out of range"], [{ pitch: 20 }, "pitch out of range"], [{ eq: "voice_clarty" }, "unknown eq preset"],
  [{ eq: [{ type: "peak", f: 1000, gain: 40 }] }, "eq gain out of range"], [{ eq: [{ type: "high_pass", gain: 3 }] }, "gain not a high_pass param"],
  [{ compressor: "vocal" }, "unknown compressor preset"], [{ compressor: { ratio: 50 } }, "compressor ratio out of range"], [{ normalize: 0 }, "normalize out of range"]] as const)
  check(`rejects ${name}`, await rejects(() => apply([{ op: "update_clip", id: "aud1", set }]), "validation_failed"));
check("rejects track eq typo", await rejects(() => apply([{ op: "update_track", id: "music", set: { eq: "lowcut" } }]), "validation_failed"));

console.log("subtitles");
await apply([{ op: "add_captions", words: [{ text: "Hello", start: 0.1, end: 0.5 }, { text: "world.", start: 0.5, end: 1 }, { text: "Second", start: 1.5, end: 2 }, { text: "page", start: 2, end: 2.6 }], preset: "clean", at: 0.5 }]);
const srt = api.exportCaptions(P, { out: join(tmp, "s.srt") });
const srtTxt = readFileSync(srt.output, "utf8");
check("srt: 2 cues in timeline time (captions start at 0.5)", srt.cues === 2 && srtTxt.startsWith("1\n00:00:00,600 --> 00:00:02,000\nHello world.\n\n2\n00:00:02,000 --> 00:00:03,400\nSecond page"), srtTxt);
const vtt = readFileSync(api.exportCaptions(P, { out: join(tmp, "s.vtt") }).output, "utf8");
check("vtt header + dot millis", vtt.startsWith("WEBVTT\n\n00:00:00.600 --> 00:00:02.000\n"), vtt);
check("no captions in ids -> empty", await rejects(() => api.exportCaptions(P, { out: join(tmp, "x.srt"), ids: ["nope"] }), "empty"));
const out = join(tmp, "sub.mp4");
const r: any = await api.render(P, { out, subtitles: true, start: 1, workers: 1, sheet: false });
const streams = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", out], { encoding: "utf8" }).stdout).streams;
check("mp4 has a mov_text subtitle stream", streams.some((s: any) => s.codec_name === "mov_text"), streams.map((s: any) => s.codec_name));
const dumped = spawnSync("ffmpeg", ["-v", "error", "-i", out, "-map", "0:s", "-f", "srt", "-"], { encoding: "utf8" }).stdout;
check("embedded cues shifted to the rendered range (start=1)", r.subtitles?.cues === 2 && dumped.includes("00:00:00,000 --> 00:00:01,000") && dumped.includes("00:00:01,000 --> 00:00:02,400"), dumped);
const mkv = join(tmp, "sub.mkv");
await api.render(P, { out: mkv, subtitles: true, end: 2, workers: 1, sheet: false });
check("mkv gets an srt stream", spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", mkv], { encoding: "utf8" }).stdout.includes("subrip"));
check("subtitles on .gif rejected before rendering", await rejects(() => api.render(P, { out: join(tmp, "x.gif"), subtitles: true }), "bad_format"));

console.log("frame-evaluated volume expressions follow their curve to within a frame of a few ms");
{
  // the gain expression is evaluated once per audio frame: with decoder-sized frames (~85 ms) the duck ramp and a fast keyframe drop lag by up to a frame
  const D = join(tmp, "duck");
  api.create(D, { width: 320, height: 240, fps: 24 });
  const dmix = (tag: string) => { const p = api.openProject(D), tl = p.absolutized(p.load()); tl.settings.loudness = null; return buildAudio(tl, join(tmp, `${tag}.wav`)); };
  const at = 1.013; // not a multiple of the 20 ms analysis window
  await api.apply(D, [
    { op: "update_track", id: "music", set: { duck: -30 } },
    { op: "add_clip", track: "music", src: join(m, "tone.wav"), at: 0, duration: 4 },
    { op: "add_clip", track: "voice", src: join(m, "tone.wav"), at, duration: 2, muted: true }, // muted: only the music is in the mix, the voice interval still ducks it
  ]);
  const dk = dmix("duck-onset"), full = rms(dk, 0.2, 0.7), steady = rms(dk, at + 0.5, at + 1.5);
  check(`duck -30: music steady ${full.toFixed(1)} -> ${steady.toFixed(1)} dB`, Math.abs(full - steady - 30) < 0.5);
  const first = rms(dk, at, at + 0.03);
  check(`music already at the ducked level in the first 30 ms of the voice (${first.toFixed(1)} vs ${steady.toFixed(1)} dB)`, Math.abs(first - steady) < 2);

  await api.apply(D, [{ op: "update_track", id: "music", set: { duck: null } }, { op: "set_keyframes", id: "aud1", prop: "volume", keyframes: [[0, 1], [1.1, 1], [1.12, 0.0316]] }]);
  const kf = dmix("kf-drop"), top = rms(kf, 0.2, 0.7), low = rms(kf, 2, 3), after = rms(kf, 1.13, 1.17);
  check(`volume keyframe drop 1.10 -> 1.12 s: ${top.toFixed(1)} -> ${low.toFixed(1)} dB, already there at 1.13-1.17 s (${after.toFixed(1)})`, Math.abs(top - low - 30) < 0.5 && Math.abs(after - low) < 2);

  // 130 separate voice intervals (ffmpeg rejects an expression nested ~100 deep) over a bed split in two clips: every interval ducks, the gaps do not
  ff("-f", "lavfi", "-i", "sine=f=220:d=140:r=8000", "-ac", "1", join(m, "bed140.wav"));
  const V = join(tmp, "many");
  api.create(V, { width: 320, height: 240, fps: 24 });
  await api.apply(V, [
    { op: "add_clip", track: "music", src: join(m, "bed140.wav"), at: 0, duration: 70 }, { op: "add_clip", track: "music", src: join(m, "bed140.wav"), at: 70, duration: 70 },
    ...Array.from({ length: 130 }, (_, i) => ({ op: "add_clip", track: "voice", src: join(m, "tone.wav"), at: 1 + i, duration: 0.3, muted: true })),
  ]);
  const pv = api.openProject(V), tv = pv.absolutized(pv.load());
  tv.settings.loudness = null;
  const many = buildAudio(tv, join(tmp, "many.wav"));
  const dips = [10, 69, 70, 100].map((t) => [rms(many, t + 1.1, t + 1.25), rms(many, t + 1.58, t + 1.72)]); // interval at 1+t.., gap after it
  check(`130 voice intervals: each sampled one ducks by ~20 dB and its gap does not (${dips.map(([a, b]) => `${a.toFixed(0)}/${b.toFixed(0)}`).join(" ")} dB)`, dips.every(([a, b]) => Math.abs(b - a - 20) < 1.5), dips);

  // 130 volume keyframes on one clip (beat-pumped volume): 65 plateaus of 0.1 s, alternating 1 and 0.25, joined by 0.1 s ramps (ffmpeg rejects an expression nested ~100 deep)
  const W = join(tmp, "pump");
  api.create(W, { width: 320, height: 240, fps: 24 });
  const plateau = (j: number) => (j % 2 ? 0.25 : 1);
  await api.apply(W, [
    { op: "add_clip", track: "music", src: join(m, "bed140.wav"), at: 0, duration: 14 },
    { op: "set_keyframes", id: "aud1", prop: "volume", keyframes: Array.from({ length: 130 }, (_, i) => [Math.round((Math.floor(i / 2) * 0.2 + (i % 2) * 0.1) * 100) / 100, plateau(Math.floor(i / 2))]) },
  ]);
  const pw = api.openProject(W), tw = pw.absolutized(pw.load());
  tw.settings.loudness = null;
  let pump: string | null = null;
  try { pump = buildAudio(tw, join(tmp, "pump.wav")); } catch (e: any) { check("130 volume keyframes: the mix succeeds", false, e.message); }
  if (pump) {
    const js = [0, 1, 2, 31, 63, 64].map((j) => rms(pump!, j * 0.2 + 0.02, j * 0.2 + 0.08) - rms(pump!, 0.02, 0.08)); // dB relative to plateau 0 (gain 1)
    check(`130 volume keyframes: sampled plateaus sit at their keyframe value (${js.map((x) => x.toFixed(1)).join(" ")} dB)`, [0, 1, 2, 31, 63, 64].every((j, k) => Math.abs(js[k] - 20 * Math.log10(plateau(j))) < 1), js);
  }

  // the expression is a binary tree over the keyframe times: same value as the plain definition (first segment with t < its end time, linear; before the first / after the last: held) for every t
  const evalExpr = (e: string, t: number): number => new Function("lt", "iff", "t", `return ${e.replace(/\bif\(/g, "iff(")}`)((a: number, b: number) => (a < b ? 1 : 0), (c: number, a: number, b: number) => (c ? a : b), t);
  const plain = (pts: number[][], t: number): number => {
    if (t < pts[0][0]) return pts[0][1];
    for (let i = 0; i < pts.length - 1; i++) {
      const [t0, v0] = pts[i], [t1, v1] = pts[i + 1];
      if (t < t1) return v0 + (v1 - v0) * (t - t0) / Math.max(1e-6, t1 - t0);
    }
    return pts[pts.length - 1][1];
  };
  const depth = (e: string): number => { let d = 0, max = 0; for (const ch of e) { if (ch === "(") max = Math.max(max, ++d); else if (ch === ")") d--; } return max; };
  const sets: number[][][] = [
    [[0.5, 0.7]], [[0, 1], [2, 0.2]], [[0, 1], [1, 0.5], [3, 0]], [[1, 0.2], [2, 1], [2.5, 1], [4, 0.1]], [[0, 0], [1, 1], [2, 0], [3, 1], [4, 0]],
    [[0, 1], [1, 1], [1, 0], [2, 0]], [[0.5, 1], [0.5, 0.3], [0.5, 0.9]], // zero-length segments: the step lands on the later keyframe's side at t = 1 / 0.5
  ];
  let worst = 0;
  for (const pts of sets) {
    const e = kfExpr(pts), times = [-1, ...pts.map(([t]) => t), ...pts.flatMap(([t]) => [t - 1e-9, t + 1e-9, t + 0.123]), 9];
    for (const t of times) worst = Math.max(worst, Math.abs(evalExpr(e, t) - plain(pts, t)));
  }
  check(`kfExpr: 1-5 keyframes (also at every keyframe time, duplicates, before the first, after the last) match the plain definition (max diff ${worst.toExponential(1)})`, worst < 1e-9);
  const big = Array.from({ length: 130 }, (_, i) => [i * 0.1, i % 2]), eb = kfExpr(big);
  check(`kfExpr: 130 keyframes nest ${depth(eb)} deep (<= 30) and still match at every keyframe and midway`, depth(eb) <= 30 && big.every(([t], i) => [t, t + 0.05].every((x) => Math.abs(evalExpr(eb, x) - plain(big, x)) < 1e-9)), depth(eb));
}

const el = ((performance.now() - t0) / 1000).toFixed(1);
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} check(s) FAILED in ${el}s`); process.exit(1); }
console.log(`\nOK - all audio checks passed in ${el}s`);
