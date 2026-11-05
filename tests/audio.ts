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
const { buildAudio } = await import("../src/audio.ts");

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

const el = ((performance.now() - t0) / 1000).toFixed(1);
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} check(s) FAILED in ${el}s`); process.exit(1); }
console.log(`\nOK - all audio checks passed in ${el}s`);
