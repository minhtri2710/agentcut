// Audio processing (denoise, eq, compressor, pan, pitch, normalize; clip + track bus), enhance_voice, subtitle export/embed.
// Measures rendered audio with FFmpeg. Run: bun tests/audio.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-audio-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store - set before importing the API
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("../src/api.ts");
const { buildAudio, kfExpr } = await import("../src/audio.ts");
const { hasCodec } = await import("../src/media.ts");
const { run } = await import("../src/proc.ts");
const { noiseFloor, denoiseFilters, eqFilters, compressorFilter } = await import("../src/audiofx.ts");

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
const base = await mix("base");
const baseNoise = rms(base, 2.5, 4), baseTone = rms(base, 0.5, 1.5);

console.log("denoise");
await apply([{ op: "update_clip", id: "aud1", set: { denoise: true } }]);
const dn = await mix("denoise");
check(`noise floor drops >= 6 dB (${baseNoise.toFixed(1)} -> ${rms(dn, 2.5, 4).toFixed(1)})`, baseNoise - rms(dn, 2.5, 4) >= 6);
check(`tone kept within 1.5 dB (${baseTone.toFixed(1)} -> ${rms(dn, 0.5, 1.5).toFixed(1)})`, Math.abs(baseTone - rms(dn, 0.5, 1.5)) < 1.5);
await apply([{ op: "update_clip", id: "aud1", set: { denoise: 1 } }]);
check("strength 1 removes more than 0.5", rms(await mix("denoise1"), 2.5, 4) < rms(dn, 2.5, 4) - 2);

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
  const flo = await noiseFloor(contSrc, 0, contDur);
  check(`noiseFloor of a clip with few pauses (300 ms of noise before the first word) stays near the noise, not on the speech (${flo?.toFixed(1)} dBFS, true -70)`, flo !== null && flo < -60, flo);
  // 30 words (16.8 s) with only the 300 ms lead-in as noise-only windows: still found, and the ending still survives
  const long = synth(40, 30, -70, 0.6), longSrc = wavOf("cont-long.wav", long), longDur = long.length / SR;
  const llo = await noiseFloor(longSrc, 0, longDur);
  check(`${longDur.toFixed(1)} s clip, 6 noise-only windows: noiseFloor is within 3 dB of the noise (${llo?.toFixed(1)} dBFS, true -70)`, llo !== null && Math.abs(llo + 70) <= 3, llo);
  const longRaw = await project("long-raw", longSrc, longDur, false), longDn = await project("long-dn", longSrc, longDur, true);
  const lkept = rms(longDn, longDur - 0.15, longDur) - rms(longRaw, longDur - 0.15, longDur);
  check(`${longDur.toFixed(1)} s clip: the soft ending keeps its level (${lkept.toFixed(1)} dB, tolerance 3)`, Math.abs(lkept) <= 3, lkept);
  // a clean recording: real noise at -95 dBFS (between the 16-bit floor and -100), normal pauses, an ending 20 dB down
  const clean = synth(600, 8, -95, 0.6), cleanSrc = wavOf("clean95.wav", clean), cleanDur = clean.length / SR;
  const cflo = await noiseFloor(cleanSrc, 0, cleanDur);
  check(`noise at -95 dBFS with pauses: noiseFloor stays at the noise, not on the speech (${cflo?.toFixed(1)} dBFS, expect <= -88)`, cflo !== null && cflo <= -88, cflo);
  const cleanRaw = await project("clean-raw", cleanSrc, cleanDur, false), cleanDn = await project("clean-dn", cleanSrc, cleanDur, true);
  const fadeEnd2 = cleanDur - 0.6, ckept = rms(cleanDn, fadeEnd2 - 0.15, fadeEnd2) - rms(cleanRaw, fadeEnd2 - 0.15, fadeEnd2); // the last word's 600 ms fade ends 0.6 s (one gap) before the clip end
  check(`noise at -95 dBFS: the ending 20 dB down keeps its level (${ckept.toFixed(1)} dB, tolerance 3)`, Math.abs(ckept) <= 3, ckept);
  // clip with real pauses: the gate still has to take the noise out
  const talk = synth(600, 8, -50, 0.3), talkSrc = wavOf("talk-pauses.wav", talk), talkDur = talk.length / SR;
  const talkRaw = await project("pauses-raw", talkSrc, talkDur, false), talkDn = await project("pauses-dn", talkSrc, talkDur, true);
  const pa = 0.3 + 2 * 0.48 + 0.6 + 0.3, pb = pa + 0.2; // inside the second pause (1.86-2.46 s), past the gate's release
  const reduction = rms(talkRaw, pa, pb) - rms(talkDn, pa, pb);
  check(`pauses: noise in the gaps drops >= 15 dB (${reduction.toFixed(1)})`, reduction >= 15, reduction);
  const tflo = await noiseFloor(talkSrc, 0, talkDur);
  check(`noiseFloor with pauses is the noise level (${tflo?.toFixed(1)} dBFS, true -50)`, tflo !== null && Math.abs(tflo + 50) < 1.5, tflo);
  // the same clip plus 2% and 6% windows of dithered silence (-96 dBFS, the 16-bit floor) appended: those windows are not the noise
  for (const share of [0.02, 0.06]) {
    const win = 2400, k = Math.ceil(share * Math.floor(talk.length / win)), padded = new Float32Array(talk.length + k * win);
    padded.set(talk);
    { let seed = 7; const a = 10 ** (-96 / 20) * Math.sqrt(3); for (let i = talk.length; i < padded.length; i++) padded[i] = a * (((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1); }
    const dithSrc = wavOf(`talk-dither${k}.wav`, padded), dithDur = padded.length / SR;
    const dflo = await noiseFloor(dithSrc, 0, dithDur);
    check(`pauses + ${k} windows of dithered silence: noiseFloor is still the noise (${dflo?.toFixed(1)} dBFS, true -50)`, dflo !== null && Math.abs(dflo + 50) < 1.5, dflo);
    const dithRaw = await project(`dither${k}-raw`, dithSrc, dithDur, false), dithDn = await project(`dither${k}-dn`, dithSrc, dithDur, true);
    const dred = rms(dithRaw, pa, pb) - rms(dithDn, pa, pb);
    check(`pauses + ${k} windows of dithered silence: noise in the gaps still drops >= 15 dB (${dred.toFixed(1)})`, dred >= 15, dred);
  }
  // a clip under 5 s (fewer than 100 windows) with one window that is 90% zero inside a pause
  const shortClip = synth(600, 3, -50, 0.3);
  shortClip.fill(0, 1.2 * SR, 1.2 * SR + 2160);
  const shortSrc = wavOf("short-dropout.wav", shortClip), sflo = await noiseFloor(shortSrc, 0, shortClip.length / SR);
  check(`${(shortClip.length / SR).toFixed(1)} s clip with one mostly-zero window: noiseFloor is still the noise (${sflo?.toFixed(1)} dBFS, true -50)`, sflo !== null && Math.abs(sflo + 50) < 1.5, sflo);
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
  // the delay is a whole number of samples per rate (2*floor(sr/80) per stage): a click must stay within 1 sample at rates other than 48 kHz
  for (const rate of [44100, 22050]) {
    const click = new Float32Array(rate); click[rate >> 1] = 0.8;
    const o = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-f", "f32le", "-ar", String(rate), "-ac", "1", "-i", "-", "-af", denoiseFilters(0.5, -50, rate).join(","), "-f", "f32le", "-"], { input: Buffer.from(click.buffer), maxBuffer: 1 << 26 });
    const y = new Float32Array(o.stdout.buffer.slice(o.stdout.byteOffset, o.stdout.byteOffset + o.stdout.length));
    let at = 0;
    for (let i = 0; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[at])) at = i;
    check(`${rate} Hz: a click keeps its position through the denoise chain (${at - (rate >> 1)} samples, tolerance 1)`, y.length === rate && Math.abs(at - (rate >> 1)) <= 1, [y.length, at]);
  }
}

console.log("pan");
await apply([{ op: "update_clip", id: "aud1", set: { denoise: null, pan: -0.8 } }]);
const pl = await mix("pan");
const bal = rms(pl, 0.5, 1.5, 0) - rms(pl, 0.5, 1.5, 1);
check(`pan -0.8: left louder by ~14 dB (${bal.toFixed(1)})`, Math.abs(bal - 20 * Math.log10(1 / 0.2)) < 1);
check("centre channel kept at unity", Math.abs(rms(pl, 0.5, 1.5, 0) - rms(base, 0.5, 1.5, 0)) < 0.2);

console.log("pitch");
await apply([
  { op: "update_clip", id: "aud1", set: { pan: null, muted: true } },
  { op: "update_track", id: "music", set: { duck: null } }, // levels below are absolute: no ducking under the (muted) voice clip
  { op: "add_clip", track: "music", src: join(m, "tone.wav"), at: 0, duration: 3, pitch: 12 }, // aud2
]);
const pt = await mix("pitch");
check(`+12 semitones: 440 -> ~880 Hz (${freq(pt, 0.5, 2.5).toFixed(0)})`, Math.abs(freq(pt, 0.5, 2.5) - 880) < 15);
check("duration unchanged: tone stops at 3 s", rms(pt, 2.5, 2.95) > -40 && !(rms(pt, 3.05, 3.9) > -60));

console.log("normalize + eq + compressor");
await apply([{ op: "update_clip", id: "aud2", set: { pitch: null, volume: 0.1, normalize: -20 } }]);
const nl = lufs(await mix("norm"));
check(`normalize -20 LUFS, then volume 0.1 (-20 dB) -> ~-40 LUFS (${nl.toFixed(1)})`, Math.abs(nl + 40) < 1);
await apply([{ op: "update_clip", id: "aud2", set: { volume: null, normalize: null, eq: [{ type: "high_pass", f: 2000 }] } }]);
const hp = rms(await mix("hp"), 0.5, 2.5);
await apply([{ op: "update_clip", id: "aud2", set: { eq: null } }]);
const plain = rms(await mix("plain"), 0.5, 2.5);
check(`high_pass 2 kHz cuts a 440 Hz tone by > 20 dB (${plain.toFixed(1)} -> ${hp.toFixed(1)})`, hp < plain - 20);
await apply([{ op: "update_clip", id: "aud2", set: { compressor: { type: "voice", makeup: 0, threshold: -30, ratio: 8 } } }]);
check(`compressor lowers a loud tone (${plain.toFixed(1)} -> ${rms(await mix("comp"), 0.5, 2.5).toFixed(1)})`, rms(await mix("comp"), 0.5, 2.5) < plain - 6);

console.log("track bus");
await apply([
  { op: "update_clip", id: "aud2", set: { compressor: null } },
  { op: "update_track", id: "music", set: { pan: 1, eq: "low_cut" } },
]);
const tb = await mix("bus");
check(`track pan 1 silences the left channel (L ${rms(tb, 0.5, 2.5, 0)}, R ${rms(tb, 0.5, 2.5, 1).toFixed(1)})`, !(rms(tb, 0.5, 2.5, 0) > -80) && rms(tb, 0.5, 2.5, 1) > -40);
// the pure-tone aud2 has no noise to remove, so measure on a noisy clip (talk.wav, its noise-only tail is 6.5-8 s here)
await apply([{ op: "update_track", id: "music", set: { pan: null, eq: null } }, { op: "add_clip", track: "music", src: join(m, "talk.wav"), at: 4, duration: 4 }]); // aud3
const tailPlain = rms(await mix("trackdn0"), 6.5, 8);
await apply([{ op: "update_track", id: "music", set: { denoise: true } }]);
const tailDn = rms(await mix("trackdn"), 6.5, 8);
check(`track denoise reaches the clip: noise floor drops >= 6 dB (${tailPlain.toFixed(1)} -> ${tailDn.toFixed(1)})`, tailPlain - tailDn >= 6);
await apply([{ op: "remove_clip", id: "aud3" }]);

console.log("loudness after processing");
await apply([
  { op: "update_track", id: "music", set: { denoise: null } },
  { op: "remove_clip", id: "aud2" },
  { op: "update_clip", id: "aud1", set: { muted: null } },
  { op: "enhance_voice", track: "voice" },
]);
const target = await mix("final", -14);
check(`final mix at -14 LUFS (${lufs(target).toFixed(2)})`, Math.abs(lufs(target) + 14) < 0.7);
const again = await mix("final2", -14);
check("deterministic: two mixes are byte-identical", readFileSync(target).equals(readFileSync(again)));

console.log("a speed-ramped video clip plays its sound, time-mapped by the curve its picture follows");
{
  const { speedIntegral } = await import("../src/anim.ts");
  // 20 ms 1 kHz bursts every 0.25 s of source time (phase 0 at each onset), under a test picture
  ff("-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,0.25),0.02),0.9*sin(2*PI*1000*t),0)':s=48000:d=6", "-ac", "2", join(m, "clicks.wav"));
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=6", "-i", join(m, "clicks.wav"), "-shortest", "-pix_fmt", "yuv420p", join(m, "clicks.mp4"));
  const FPS = 30, DUR = 3, kfs = [[0, 1], [1, 0.5], [2, 2]];
  const RP = join(tmp, "ramp-proj");
  api.create(RP, { width: 320, height: 240, fps: FPS });
  await api.apply(RP, [{ op: "add_clip", track: "main", src: join(m, "clicks.mp4"), at: 0, duration: DUR }, { op: "set_keyframes", id: "vid1", prop: "speed", keyframes: kfs }]);
  const rmix = (tag: string, edit?: (tl: any) => void) => { const p = api.openProject(RP), tl = p.absolutized(p.load()); tl.settings.loudness = null; edit?.(tl); return buildAudio(tl, join(tmp, `${tag}.wav`)); };
  const onsets = (f: string) => { // times of the first sample over 0.2 in each burst (bursts are >= 10 ms long and >= 0.1 s apart in output time)
    const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-i", f, "-af", "pan=mono|c0=c0", "-f", "f32le", "-ar", "48000", "-"], { maxBuffer: 1 << 26 });
    const x = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4), out: number[] = [];
    let last = -1e9;
    for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > 0.2) { if (i - last > 4800) out.push(i / 48000); last = i; }
    return out;
  };
  const ramped = await rmix("ramp");
  // the output time at which the picture shows source time u: the inverse of speedIntegral
  const expected: number[] = [];
  for (let j = 0; 0.25 * j < speedIntegral(kfs, DUR); j++) {
    let lo = 0, hi = DUR;
    for (let q = 0; q < 40; q++) { const mid = (lo + hi) / 2; if (speedIntegral(kfs, mid) < 0.25 * j) lo = mid; else hi = mid; }
    expected.push(hi);
  }
  const got = onsets(ramped), errs = expected.map((e, k) => Math.abs((got[k] ?? Infinity) - e));
  check(`every click lands within one frame of where the picture shows it (${got.length} of ${expected.length}, worst ${(Math.max(...errs) * 1000).toFixed(1)} ms)`, got.length === expected.length && Math.max(...errs) < 1 / FPS, { got: got.map((x) => +x.toFixed(3)), expected: expected.map((x) => +x.toFixed(3)) });
  // reversed: the picture shows source time in + duration - integral, so each burst, played backwards, starts at its end (0.02 s after its source onset)
  const kr = [[0, 1], [1, 0.5], [2, 1]], CIN = 0.5, rev = await rmix("ramp-rev", (tl) => { Object.assign(tl.tracks.find((t: any) => t.id === "main").clips[0], { reverse: true, in: CIN, keyframes: { speed: kr } }); });
  const rexp: number[] = [];
  for (let j = 0; 0.25 * j + 0.02 <= CIN + DUR; j++) {
    const s = 0.25 * j + 0.02;
    if (s < CIN + DUR - speedIntegral(kr, DUR)) continue;
    let lo = 0, hi = DUR;
    for (let q = 0; q < 40; q++) { const mid = (lo + hi) / 2; if (CIN + DUR - speedIntegral(kr, mid) > s) lo = mid; else hi = mid; }
    rexp.push(hi);
  }
  rexp.sort((a, b) => a - b);
  const rgot = onsets(rev), rerrs = rexp.map((e, k) => Math.abs((rgot[k] ?? Infinity) - e));
  check(`reversed: every click lands within one frame of where the picture shows it (${rgot.length} of ${rexp.length}, worst ${(Math.max(...rerrs) * 1000).toFixed(1)} ms)`, rgot.length === rexp.length && Math.max(...rerrs) < 1 / FPS, { got: rgot.map((x) => +x.toFixed(3)), expected: rexp.map((x) => +x.toFixed(3)) });
  const half = await rmix("ramp-half", (tl) => { tl.tracks.find((t: any) => t.id === "main").clips[0].volume = 0.5; });
  const d = rms(half, 0, DUR) - rms(ramped, 0, DUR);
  check(`volume 0.5 on a ramped clip is -6 dB (${d.toFixed(2)})`, Math.abs(d + 6.02) < 0.3, d);
  // a source whose rate differs from the project's: each run is labelled at the project rate, so the clip keeps its speed and its place
  ff("-i", join(m, "clicks.wav"), "-ar", "44100", join(m, "clicks44.wav"));
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=6", "-i", join(m, "clicks44.wav"), "-shortest", "-pix_fmt", "yuv420p", join(m, "clicks44.mp4"));
  const worst = (g: number[], e: number[]) => (g.length === e.length ? Math.max(...e.map((x, k) => Math.abs(g[k] - x))) : Infinity);
  const P44 = join(tmp, "ramp-proj44");
  api.create(P44, { width: 320, height: 240, fps: FPS });
  await api.apply(P44, [{ op: "add_clip", track: "main", src: join(m, "clicks44.mp4"), at: 0, duration: DUR }, { op: "set_keyframes", id: "vid1", prop: "speed", keyframes: kfs }]);
  const p44 = api.openProject(P44), tl44 = p44.absolutized(p44.load());
  tl44.settings.loudness = null;
  const w44 = worst(onsets(await buildAudio(tl44, join(tmp, "ramp44.wav"))), expected);
  check(`a 44.1 kHz source in a 48 kHz project: every click within one frame (worst ${(w44 * 1000).toFixed(1)} ms)`, w44 < 1 / FPS, w44);
  const w48 = worst(onsets(await rmix("ramp-rev44", (tl) => { tl.settings.sample_rate = 44100; Object.assign(tl.tracks.find((t: any) => t.id === "main").clips[0], { reverse: true, in: CIN, keyframes: { speed: kr } }); })), rexp);
  check(`reversed, a 48 kHz source in a 44.1 kHz project: every click within one frame (worst ${(w48 * 1000).toFixed(1)} ms)`, w48 < 1 / FPS, w48);
  // a reversed ramped clip inside a compound whose window starts after the clip's head: the picture shows source time in + 5 - integral (held at `in` once the ramp has used the segment up),
  // so the sound covers exactly the source the picture shows over the window: from its entry point down to where the ramp ends (a cut tail included), and nothing below `in`
  const { newTimeline, resolve: res } = await import("../src/model.ts"), ND = 5, k2 = [[0, 2], [ND, 2]];
  const nestedRev = async (tag: string, srcIn: number, head: number, cdur: number) => {
    const t2 = newTimeline(320, 240, FPS);
    t2.assets.v = { path: join(m, "clicks.mp4"), kind: "video", duration: 6, has_audio: true } as any;
    t2.tracks.push({ id: "main", kind: "video", clips: [{ id: "RC", type: "compound", start: 0, duration: cdur, in: head, tracks: [{ id: "n", kind: "video", clips: [{ id: "rv", type: "video", asset: "v", start: 0, duration: ND, in: srcIn, reverse: true, keyframes: { speed: k2 } }] }] }] } as any);
    res(t2); t2.settings.loudness = null;
    const exp: number[] = [];
    for (let j = 0; 0.25 * j + 0.02 <= 6; j++) { // each burst, played backwards, starts at its end
      const s = 0.25 * j + 0.02, at = (x: number) => srcIn + ND - speedIntegral(k2, head + x);
      if (s < srcIn || at(0) < s || at(cdur) > s) continue;
      let lo = 0, hi = cdur;
      for (let q = 0; q < 40; q++) { const mid = (lo + hi) / 2; if (at(mid) > s) lo = mid; else hi = mid; }
      exp.push(hi);
    }
    return { got: onsets(await buildAudio(t2, join(tmp, `${tag}.wav`))), exp: exp.sort((a, b) => a - b) };
  };
  for (const [what, srcIn, head, cdur] of [["in-point below the clip's own `in`", 0.5, 2.2, 2.8], ["window past the segment's start", 0, 3, 2], ["tail cut", 0, 0, 2], ["head and tail cut", 0, 1, 2]] as const) {
    const r = await nestedRev(`ramp-nest-${srcIn}-${head}-${cdur}`, srcIn, head, cdur), w = worst(r.got, r.exp);
    check(`reversed in a compound window, ${what}: every click within one frame of the picture (${r.got.length} of ${r.exp.length})`, w < 1 / FPS, r);
  }
  // the graph is one ffmpeg argument (the OS caps it: linux 128 KiB for one argument, win32 32767 chars for the command line, darwin 1 MiB for argv plus environment, see ARGV_LIMITS):
  // a curve with hundreds of runs is refused by name before ffmpeg starts; a short one mixes with its graph under the smallest bound
  const zigProject = async (name: string, secs: number) => {
    const Z = join(tmp, name);
    api.create(Z, { width: 320, height: 240, fps: FPS });
    await api.apply(Z, [{ op: "add_clip", track: "main", src: join(m, "clicks.mp4"), at: 0, duration: secs, loop: true }, { op: "set_keyframes", id: "vid1", prop: "speed", keyframes: Array.from({ length: secs * 2 + 1 }, (_, i) => [i * 0.5, i % 2 ? 4 : 0.2]) }]);
    const pz = api.openProject(Z), tlz = pz.absolutized(pz.load());
    tlz.settings.loudness = null;
    return tlz;
  };
  const okOut = join(tmp, "zig10.wav"), copy = join(tmp, "graph-copy.txt");
  let graphChars = -1; // the length of the -filter_complex argument of that mix, read through a stand-in ffmpeg (not on win32)
  if (process.platform !== "win32") {
    const gbin = join(tmp, "graphbin"), realF = process.env.PATH!.split(delimiter).map((d) => join(d, "ffmpeg")).find((f) => existsSync(f))!;
    mkdirSync(gbin);
    writeFileSync(join(gbin, "ffmpeg"), `#!/bin/sh\np=; for a in "$@"; do [ "$p" = "-filter_complex" ] && printf '%s' "$a" > '${copy}'; p=$a; done\nexec '${realF}' "$@"\n`, { mode: 0o755 });
    const tlz = await zigProject("ramp-zig10", 10), realPath = process.env.PATH!;
    hasCodec("encoders", "pcm_s16le"); // read once from the real ffmpeg before the stand-in takes PATH
    process.env.PATH = gbin + delimiter + realPath;
    try { await buildAudio(tlz, okOut); } finally { process.env.PATH = realPath; }
    graphChars = readFileSync(copy, "utf8").length;
  } else await buildAudio(await zigProject("ramp-zig10", 10), okOut);
  check(`a 10 s zigzag ramp mixes with its graph under the smallest bound (${graphChars} chars of 30000)`, existsSync(okOut) && (graphChars === -1 || (graphChars > 1000 && graphChars < 25000)), graphChars);
  const bigOut = join(tmp, "zig600.wav");
  let big: any;
  try { await buildAudio(await zigProject("ramp-zig600", 600), bigOut); } catch (e: any) { big = e; }
  check("a 600 s zigzag ramp (over every platform's bound) is refused as too_complex, names the clip, and leaves no mix file behind", big?.code === "too_complex" && /vid1/.test(big.message) && /speed keyframes/.test(big.hint) && !existsSync(bigOut) && !existsSync(bigOut + ".raw.wav"), big && { code: big.code, message: big.message.slice(0, 200) });
  const muted = await rmix("ramp-muted", (tl) => { tl.tracks.find((t: any) => t.id === "main").clips[0].muted = true; });
  check("muted: a ramped clip is silent", onsets(muted).length === 0, onsets(muted));
}

console.log("the mix leaves the event loop free and an abort stops its ffmpeg");
{
  let ticks = 0;
  const iv = setInterval(() => ticks++, 10); // a blocking mix fires none: the 5 ffmpeg runs of this mix take well over 50 ms
  await mix("loop", -14);
  clearInterval(iv);
  check(`timers fire while the mix runs (${ticks} ticks)`, ticks >= 5, ticks);
  if (process.platform !== "win32") {
    // a stand-in ffmpeg records its pid and then waits: the abort must end that very process
    const bin = join(tmp, "fakebin"), pidFile = join(tmp, "fake.pid"), Q = join(tmp, "abort-proj");
    mkdirSync(bin);
    const realFfmpeg = process.env.PATH!.split(delimiter).map((d) => join(d, "ffmpeg")).find((f) => existsSync(f))!;
    // the stand-in waits only when an argument contains `key` (any call when key is empty); every other call runs the real ffmpeg
    const standIn = (key: string) => writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\n[ "$1" = "-version" ] && exit 0\ncase "$*" in *'${key}'*) echo $$ > '${pidFile}'; exec sleep 60;; esac\nexec '${realFfmpeg}' "$@"\n`, { mode: 0o755 });
    api.create(Q, { width: 320, height: 240, fps: 24 });
    await api.apply(Q, [{ op: "add_clip", track: "voice", src: join(m, "tone.wav"), at: 0, duration: 2 }]);
    hasCodec("encoders", "pcm_s16le"); // the encoder list is read once per process: read it from the real ffmpeg before the stand-in takes PATH
    const pq = api.openProject(Q), realPath = process.env.PATH!;
    // the stand-in sleeps 60 s, so a rejection within 5 s of the abort shows the abort stopped it rather than the child ending on its own
    // `tool`: the stand-in is that tool's own binary (it waits when an argument contains `key`, else exits `other`), and ffmpeg runs for real around it
    const stallTool = (tool: string, key: string, other: number) => writeFileSync(join(bin, tool), `#!/bin/sh\ncase "$*" in *'${key}'*) echo $$ > '${pidFile}'; exec sleep 60;; esac\nexit ${other}\n`, { mode: 0o755 });
    const abortRun = async (name: string, key: string, start: (signal: AbortSignal) => Promise<unknown>, tool?: { name: string; other?: number }) => {
      const ac = new AbortController();
      if (tool) { rmSync(join(bin, "ffmpeg"), { force: true }); stallTool(tool.name, key, tool.other ?? 0); } else standIn(key);
      let err: any, pid = 0, aliveBefore = false, took = -1;
      rmSync(pidFile, { force: true });
      process.env.PATH = bin + delimiter + realPath;
      try {
        const done = start(ac.signal).catch((e) => { err = e; });
        for (let i = 0; i < 200 && !pid; i++) { await new Promise((r) => setTimeout(r, 25)); if (existsSync(pidFile)) pid = Number(readFileSync(pidFile, "utf8")) || 0; }
        try { process.kill(pid, 0); aliveBefore = true; } catch { /* not running */ }
        const t0 = Date.now();
        ac.abort();
        await done;
        took = Date.now() - t0;
      } finally { process.env.PATH = realPath; }
      let aliveAfter = true;
      try { process.kill(pid, 0); } catch { aliveAfter = false; }
      check(`abort during ${name}: the call rejects with the abort within 5 s and the child it started is gone`, pid > 0 && aliveBefore && err?.name === "AbortError" && took >= 0 && took < 5000 && !aliveAfter, { pid, aliveBefore, aliveAfter, took, err: err?.message });
    };
    await abortRun("the mix", "", (signal) => buildAudio(pq.absolutized(pq.load()), join(tmp, "abort.wav"), 0, undefined, signal));
    await abortRun("an audio render", "", (signal) => api.render(Q, { out: join(tmp, "abort-render.wav"), signal }));
    // the render tail: the stand-in waits only at the step under test, so the render reaches it with the real frames and segments
    const R = join(tmp, "abort-video");
    api.create(R, { width: 320, height: 240, fps: 24 });
    await api.apply(R, [{ op: "add_clip", track: "main", src: join(m, "talk.mp4"), duration: 1 }]);
    await abortRun("the segment concat", "concat", (signal) => api.render(R, { out: join(tmp, "abort-concat.mp4"), workers: 2, sheet: false, signal }));
    await abortRun("the gif conversion", "palettegen", (signal) => api.render(R, { out: join(tmp, "abort.gif"), workers: 1, sheet: false, signal }));
    const { embedSubtitles } = await import("../src/subtitles.ts"), { loudness } = await import("../src/analyze.ts");
    const subbed = join(tmp, "abort-sub.mp4");
    await abortRun("the subtitle mux", "-c:s", async (signal) => { copyFileSync(join(m, "talk.mp4"), subbed); await embedSubtitles(subbed, [{ start: 0, end: 1, text: "x", clip: "c" }], undefined, signal); });
    await abortRun("a loudness measurement", "ebur128", (signal) => loudness(join(m, "talk.mp4"), signal));
    // the same steps reached through api.render, which hands o.signal to each
    await abortRun("the audio-render encode", "-map 0:a", (signal) => api.render(Q, { out: join(tmp, "abort-encode.wav"), signal }));
    await abortRun("the multi-worker mix", "pcm_f32le", (signal) => api.render(R, { out: join(tmp, "abort-mix.mp4"), workers: 2, sheet: false, signal }));
    await abortRun("the single-worker mix", "pcm_f32le", (signal) => api.render(R, { out: join(tmp, "abort-mix1.mp4"), workers: 1, sheet: false, signal }));
    const S = join(tmp, "abort-subs");
    api.create(S, { width: 320, height: 240, fps: 24 });
    await api.apply(S, [{ op: "add_clip", track: "main", src: join(m, "talk.mp4"), duration: 1 }, { op: "add_captions", words: [{ text: "Hello", start: 0.1, end: 0.5 }], preset: "clean", at: 0 }]);
    await abortRun("the render subtitle mux", "-c:s", (signal) => api.render(S, { out: join(tmp, "abort-render-sub.mp4"), workers: 1, sheet: false, subtitles: true, signal }));
    // the contact sheet is drawn while the loudness measurement runs: the render still rejects with the abort
    await abortRun("the render-tail loudness", "ebur128", (signal) => api.render(R, { out: join(tmp, "abort-tail.mp4"), workers: 1, signal }));
    // audio_check, scenes and scopes: the signal reaches each of their ffmpeg steps
    const src = join(m, "tone.wav");
    await abortRun("audio_check decoding a source", "pcm_s16le", (signal) => api.audioCheck(undefined, { source: src, out: join(tmp, "abort-check.png"), signal }));
    await abortRun("audio_check's loudness", "ebur128", (signal) => api.audioCheck(undefined, { source: src, out: join(tmp, "abort-check.png"), signal }));
    await abortRun("audio_check's spectrogram", "showspectrumpic", (signal) => api.audioCheck(undefined, { source: src, spectrogram: true, out: join(tmp, "abort-check.png"), signal }));
    await abortRun("audio_check's project mix", "", (signal) => api.audioCheck(Q, { out: join(tmp, "abort-check.png"), signal }));
    // the stems run with loudness null and the final mix does not, so this key reaches only the final mix's normalisation
    await abortRun("audio_check's final mix normalisation", "loudnorm", (signal) => api.audioCheck(Q, { out: join(tmp, "abort-check.png"), signal }));
    await abortRun("a scene scan", "scene", (signal) => api.analyze.scenes(join(m, "talk.mp4"), 0.3, signal));
    await abortRun("the scopes", "signalstats", (signal) => api.scopes(R, 0.2, { out: join(tmp, "abort-scopes.jpg"), signal }));
    // silence, transcribe and tts: the signal reaches the ffmpeg step each starts (a stand-in speech engine writes the tone, so tts reaches its convert step)
    await abortRun("a silence scan", "silencedetect", (signal) => api.analyze.silence(src, -35, 0.4, signal));
    // beats: f32le is the argument only its decode carries
    const BM = join(tmp, "abort-music");
    api.create(BM, { width: 320, height: 240, fps: 24 });
    await api.apply(BM, [{ op: "add_clip", track: "music", src, duration: 2 }]);
    await abortRun("a beat analysis", "-f f32le", (signal) => api.analyze.beats(src, signal));
    await abortRun("review's music beats", "-f f32le", (signal) => api.review(BM, { beats: "music", signal }));
    await abortRun("snap_to_beats reading an audio file", "-f f32le", (signal) => api.apply(BM, [{ op: "snap_to_beats", track: "main", beats: src }], { signal }));
    await abortRun("a transcription's audio extraction", "-ar 16000", (signal) => api.analyze.transcribe(src, "vi", undefined, undefined, undefined, signal));
    const speaker = join(bin, process.platform === "darwin" ? "say" : "espeak-ng");
    writeFileSync(speaker, `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "${process.platform === "darwin" ? "-o" : "-w"}" ] && cp '${src}' "$2"; shift; done\n`, { mode: 0o755 });
    await abortRun("the speech conversion", "p0.wav", (signal) => api.analyze.tts("Hello there.", join(tmp, "abort-tts.wav"), undefined, undefined, Q, signal));
    await abortRun("the speech join", "parts.txt", (signal) => api.analyze.tts("Hello there.", join(tmp, "abort-join.wav"), undefined, undefined, Q, signal));
    // each speech tool: the stand-in is the tool and the key an argument only that call has. An engine's branch is chosen by process.platform, so a row presents the platform whose engine it stops
    const asPlatform = async (platform: string, f: () => Promise<unknown>) => {
      const was = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: platform });
      try { return await f(); } finally { Object.defineProperty(process, "platform", was); }
    };
    const withEnv = async (vars: Record<string, string | undefined>, f: () => Promise<unknown>) => {
      const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
      const set = (v: Record<string, string | undefined>) => { for (const [k, x] of Object.entries(v)) if (x === undefined) delete process.env[k]; else process.env[k] = x; };
      set(vars);
      try { return await f(); } finally { set(was); }
    };
    const speak = (voice?: string) => (signal: AbortSignal) => api.analyze.tts("Hello there.", join(tmp, "abort-tool.wav"), voice, undefined, Q, signal);
    await abortRun("say", " -f ", (signal) => asPlatform("darwin", () => speak()(signal)), { name: "say" });
    await abortRun("espeak-ng", "-w ",(signal) => asPlatform("linux", () => speak()(signal)), { name: "espeak-ng" });
    await abortRun("espeak-ng's voice listing", "--voices", (signal) => asPlatform("linux", () => speak("vi")(signal)), { name: "espeak-ng", other: 1 });
    await abortRun("powershell", "-NoProfile", (signal) => asPlatform("win32", () => speak()(signal)), { name: "powershell" });
    await abortRun("piper", "--output_file", (signal) => withEnv({ AGENTCUT_PIPER_MODEL: src }, () => speak("piper")(signal)), { name: "piper" });
    await abortRun("curl", "--max-time", (signal) => withEnv({ AGENTCUT_TTS_URL: "http://127.0.0.1:9/v1" }, () => speak("openai:alloy")(signal)), { name: "curl" }); // the stand-in answers in place of curl: the URL is never dialled
    await abortRun("whisper-cli", "-oj", (signal) => api.analyze.transcribe(src, "vi", src, undefined, undefined, signal), { name: "whisper-cli" });
    await abortRun("whisper", "--word_timestamps", (signal) => withEnv({ AGENTCUT_WHISPER_MODEL: undefined }, () => api.analyze.transcribe(src, "vi", undefined, undefined, undefined, signal)), { name: "whisper" });
    // output past the cap stops a child that ignores SIGTERM: the call settles with status null and the child is gone
    {
      let pid = 0, res: any, took = -1;
      rmSync(pidFile, { force: true });
      const t1 = Date.now();
      const settled = await Promise.race([
        run("sh", ["-c", `echo $$ > '${pidFile}'; trap '' TERM; exec yes`], { maxBuffer: 4096 }).then((r) => { res = r; took = Date.now() - t1; return true; }),
        new Promise((r) => setTimeout(() => r(false), 5000)),
      ]);
      if (existsSync(pidFile)) pid = Number(readFileSync(pidFile, "utf8")) || 0;
      let alive = pid > 0;
      if (alive) try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) process.kill(pid, "SIGKILL"); // a child that outlived the bound is the failure; do not leave it running
      check("output past the cap: a child that ignores SIGTERM is killed and the call settles with status null within 5 s", pid > 0 && settled === true && res?.status === null && !alive && took < 5000, { pid, settled, status: res?.status, alive, took });
    }
  }
}

console.log("beats: the DSP hands the event loop back and stops on an abort");
{
  // 7 s mono 16-bit clip at 22.05 kHz (the decode's own rate, so ffmpeg does not resample it): a 100 bpm click and a seeded noise bed; 301 frames, so three batches
  const sr = 22050, n = sr * 7, pcm = Buffer.alloc(44 + 2 * n);
  pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + 2 * n, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
  pcm.writeUInt32LE(sr, 24); pcm.writeUInt32LE(2 * sr, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(2 * n, 40);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const click = Math.sin((2 * Math.PI * 1000 * i) / sr) * Math.exp(-60 * ((i / sr) % 0.6));
    pcm.writeInt16LE(Math.round(8000 * click + 800 * (seed / 2 ** 32 - 0.5)), 44 + 2 * i);
  }
  const clip = join(tmp, "beats-clip.wav");
  writeFileSync(clip, pcm);
  const { beats } = await import("../src/analyze.ts");
  // generated by the synchronous DSP before it was split into batches
  const EXPECT = { source: "clip", tempo_bpm: 99.83, beat_interval: 0.601, count: 12, beats: [0.075, 0.582, 1.184, 1.786, 2.387, 2.982, 3.58, 4.181, 4.783, 5.386, 5.989, 6.584], bars: [1.184, 3.58, 5.989], duration: 7 };
  const got = { ...(await beats(clip)), source: "clip" };
  check("beats of the 7 s clip equal the stored result", JSON.stringify(got) === JSON.stringify(EXPECT), got);
  // the DSP is the only code that yields to setImmediate: abort at its first yield and count the yields up to the rejection
  const realImmediate = globalThis.setImmediate;
  let yields = 0, err: any;
  const ac = new AbortController();
  (globalThis as any).setImmediate = (fn: () => void, ...a: unknown[]) => { if (++yields === 1) ac.abort(); return realImmediate(fn, ...a); };
  const t1 = Date.now();
  try { await beats(clip, ac.signal); } catch (e) { err = e; } finally { globalThis.setImmediate = realImmediate; }
  check(`an abort at the DSP's first yield rejects with the abort within 2 s, before the next yield (${yields} yield, ${Date.now() - t1} ms)`, err?.name === "AbortError" && yields === 1 && Date.now() - t1 < 2000, { name: err?.name, yields });
}

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
  const dk = await dmix("duck-onset"), full = rms(dk, 0.2, 0.7), steady = rms(dk, at + 0.5, at + 1.5);
  check(`duck -30: music steady ${full.toFixed(1)} -> ${steady.toFixed(1)} dB`, Math.abs(full - steady - 30) < 0.5);
  const first = rms(dk, at, at + 0.03);
  check(`music already at the ducked level in the first 30 ms of the voice (${first.toFixed(1)} vs ${steady.toFixed(1)} dB)`, Math.abs(first - steady) < 2);

  await api.apply(D, [{ op: "update_track", id: "music", set: { duck: null } }, { op: "set_keyframes", id: "aud1", prop: "volume", keyframes: [[0, 1], [1.1, 1], [1.12, 0.0316]] }]);
  const kf = await dmix("kf-drop"), top = rms(kf, 0.2, 0.7), low = rms(kf, 2, 3), after = rms(kf, 1.13, 1.17);
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
  const many = await buildAudio(tv, join(tmp, "many.wav"));
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
  try { pump = await buildAudio(tw, join(tmp, "pump.wav")); } catch (e: any) { check("130 volume keyframes: the mix succeeds", false, e.message); }
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

{
  const throws = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  check("eq and compressor build the same filters from numbers", eqFilters({ type: "peak", f: 1000, q: 2, gain: 3 })[0] === "equalizer=f=1000:t=q:w=2:g=3"
    && compressorFilter("voice")[0].startsWith("acompressor=threshold=0.100000:ratio=4:"), [eqFilters({ type: "peak", f: 1000, q: 2, gain: 3 }), compressorFilter("voice")]);
  check("eq refuses a non-numeric value", throws(() => eqFilters({ type: "peak", f: "1000,more" })) && throws(() => eqFilters([{ type: "high_pass", f: Number.NaN }])) && throws(() => eqFilters({ type: "de_ess", intensity: Infinity })));
  check("compressor refuses a non-numeric value", throws(() => compressorFilter({ ratio: "4,more" })) && throws(() => compressorFilter({ type: "voice", threshold: Number.NaN })));
}

const el = ((performance.now() - t0) / 1000).toFixed(1);
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} check(s) FAILED in ${el}s`); process.exit(1); }
console.log(`\nOK - all audio checks passed in ${el}s`);
