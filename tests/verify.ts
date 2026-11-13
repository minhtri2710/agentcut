// Self-check tools: review (editorial lint), audio (waveform image + findings), motion (frame strips), via CLI and MCP.
// Run: bun tests/verify.ts          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CLI = [process.execPath, resolve(import.meta.dir, "../src/cli.ts")];
const tmp = mkdtempSync(join(tmpdir(), "agentcut-verify-"));
const env = { ...(process.env as Record<string, string>), AGENTCUT_HOME: join(tmp, "home"), AGENTCUT_CACHE: join(tmp, "cache") };
let fails = 0;
const check = (n: string, c: unknown, info?: unknown) => { console.log(`  ${c ? "✓" : "✗"} ${n}`, c ? "" : JSON.stringify(info).slice(0, 600)); if (!c) fails++; };
const ff = (...a: string[]) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a], { encoding: "utf8" }); if (r.status) throw new Error(r.stderr); };
function cli(...args: (string | number)[]): any {
  const r = spawnSync(CLI[0], [...CLI.slice(1), ...args.map(String)], { encoding: "utf8", env });
  const out = JSON.parse(r.stdout);
  if (!out.ok) throw new Error(`${args.join(" ")}: ${r.stdout.slice(0, 600)}`);
  return out;
}
const f = (n: string) => join(tmp, n);
const t0 = performance.now();

ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-shortest", "-pix_fmt", "yuv420p", f("a.mp4"));
ff("-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*220*t)':s=44100:d=12", "-ac", "2", f("music.wav"));
ff("-f", "lavfi", "-i", "sine=f=300:d=2", "-af", "volume=0.3", f("voice.wav"));
// 1 s tone hard-clipped at full scale, 2 s of silence, 1 s tone
ff("-f", "lavfi", "-i", "aevalsrc='if(lt(t,1),clip(3*sin(2*PI*500*t),-1,1),if(lt(t,3),0,0.3*sin(2*PI*500*t)))':s=48000:d=4", f("clip.wav"));

const P = f("p");
cli("init", P, "--preset", "reels");
const add = cli("apply", "-p", P, "--ops", JSON.stringify([
  { op: "add_clip", track: "main", src: f("a.mp4"), duration: 3 },
  { op: "add_clip", track: "main", src: f("a.mp4"), duration: 0.25 },
  { op: "add_clip", track: "main", type: "gap", duration: 1 },
  { op: "add_clip", track: "main", src: f("a.mp4"), in: 1, duration: 3.5, transition: "crossfade" },
  { op: "add_clip", track: "text", text: "This is a very long sentence nobody can read in time", at: 0.3, duration: 1, preset: "title_bold", position: "top", margin: "1%" },
  { op: "add_clip", track: "text", text: "Fine", at: 4, duration: 2, preset: "subtitle_box" },
  { op: "add_clip", track: "music", src: f("music.wav"), until_end: true },
  { op: "add_clip", track: "voice", src: f("voice.wav"), at: 0.5 },
]));
check("project built", add.ok, add);

console.log("review");
const rv = cli("review", "-p", P, "--beats", "0,1,2,3,4,5,6,7,8");
const by = (t: string) => rv.findings.filter((x: any) => x.type === t);
check("text too short to read (txt1 only)", by("text_too_short").map((x: any) => x.id).join() === "txt1", rv.findings);
check("text outside safe area / under top bar (txt1 only)", by("text_unsafe").map((x: any) => x.id).join() === "txt1" && /top bar/.test(by("text_unsafe")[0].message), by("text_unsafe"));
check("flash shot vid2 too short", by("shot_too_short").some((x: any) => x.id === "vid2"), rv.findings);
check("off-beat cuts flagged, on-beat cut (3.0s) not", by("cut_off_beat").length > 0 && !by("cut_off_beat").some((x: any) => Math.abs(x.t - 3) < 0.01), by("cut_off_beat"));
const black = by("black_frames")[0];
// gap 3.25-4.25, but vid3 crossfades in from 3.75 (its start is pulled back by the transition)
check("black frames in the gap (~3.25-3.75)", black && black.t >= 3.2 && black.t <= 3.45 && black.end >= 3.6 && black.end <= 3.9, by("black_frames"));
check("validation warning reused: vid3 needs more source than the media", by("validation_warning").some((x: any) => x.id === "vid3" && /source/.test(x.message)), rv.findings);
check("findings sorted by time", rv.findings.every((x: any, i: number) => !i || rv.findings[i - 1].t <= x.t));
const rvErr = (...a: string[]) => spawnSync(CLI[0], [...CLI.slice(1), "review", "-p", P, "--beats", "0,1,2,3,4,5,6,7,8", ...a], { encoding: "utf8", env }).stderr.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const lines = rvErr();
check("review prints progress lines on stderr, ending at 1; --quiet prints none", lines.length > 0 && lines.at(-1).progress === 1 && lines.at(-1).frame === lines.at(-1).frames && !rvErr("--quiet").length, lines.slice(-2));

// fix everything the review complained about -> those findings disappear
cli("apply", "-p", P, "--ops", JSON.stringify([
  { op: "update_clip", id: "txt1", set: { text: "Hook", duration: 2, position: null, margin: null, y: "45%" } },
  { op: "remove_clip", id: "vid2" }, { op: "remove_clip", id: "gap1" },
  { op: "update_clip", id: "vid3", set: { duration: 2.5 } },
]));
const rv2 = cli("review", "-p", P, "--beats", "0,1,2,3,4,5,6,7,8", "--no-black");
check("fixed project: no text/shot/validation findings", !rv2.findings.some((x: any) => /^text_|^shot_|^validation_/.test(x.type)), rv2.findings);
cli("undo", "-p", P);

console.log("audio");
cli("apply", "-p", P, "--ops", JSON.stringify([{ op: "update_track", id: "music", set: { duck: -6 } }])); // the default duck (-20) would already clear the finding this test pins
const au = cli("audio", "-p", P, "--spectrogram");
check("audio image written", au.ok && existsSync(au.image) && au.image.endsWith(".png"), au);
check("one lane per audible track + mix", ["main", "voice", "music", "mix"].every((t) => au.lanes.some((l: any) => l.track === t)), au.lanes);
check("music not ducked under the voice is reported", au.findings.some((x: any) => x.type === "music_not_ducked" && x.start < 1 && x.end > 2), au.findings);
check("music cut off at the end without fade", au.findings.some((x: any) => x.type === "cut_off" && x.track === "music"), au.findings);
cli("apply", "-p", P, "--ops", JSON.stringify([{ op: "update_track", id: "music", set: { duck: -30 } }, { op: "update_clip", id: "aud1", set: { fade_out: 1 } }]));
const au2 = cli("audio", "-p", P);
check("ducked + faded: those findings are gone", !au2.findings.some((x: any) => x.type === "music_not_ducked" || (x.type === "cut_off" && x.track === "music")), au2.findings);

console.log("music_not_ducked is judged by power over speech windows, hint is actionable");
{
  // speech-like voice: 0.15 s bursts, digital silence between (power over the bursts -9 dBFS, -12 in the stereo mix after the mono pan; mean of dB far lower); steady bed
  ff("-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*300*t)*lt(mod(t,0.3),0.15)':s=48000:d=4", "-ac", "1", f("gated.wav"));
  ff("-f", "lavfi", "-i", "aevalsrc='0.2*sin(2*PI*220*t)':s=48000:d=4", "-ac", "1", f("bed-quiet.wav")); // 8 dB under the bursts
  ff("-f", "lavfi", "-i", "aevalsrc='0.35*sin(2*PI*220*t)':s=48000:d=4", "-ac", "1", f("bed-loud.wav")); // 3 dB under the bursts
  const mixOf = (name: string, bed: string) => {
    const Q = f(name);
    cli("init", Q, "--preset", "reels");
    cli("apply", "-p", Q, "--ops", JSON.stringify([{ op: "update_track", id: "music", set: { duck: null } },
      { op: "add_clip", track: "voice", src: f("gated.wav"), at: 0, duration: 4 }, { op: "add_clip", track: "music", src: f(bed), at: 0, duration: 4 }]));
    return Q;
  };
  const notDucked = (Q: string) => cli("audio", "-p", Q).findings.filter((x: any) => x.type === "music_not_ducked");
  const quiet = notDucked(mixOf("q-quiet", "bed-quiet.wav"));
  check("bed 8 dB under the speech power (dB-mean gap < 6): clean", quiet.length === 0, quiet);
  const Q = mixOf("q-loud", "bed-loud.wav"), loud = notDucked(Q);
  check("bed 3 dB under the speech power: reported with power levels", loud.length === 1 && Math.abs(loud[0].voice_db + 12) < 1 && Math.abs(loud[0].music_db + 15) < 1, loud);
  const duck = /set duck=(-\d+)/.exec(loud[0]?.hint ?? "")?.[1];
  check(`hint names a duck value (${duck})`, !!duck, loud[0]);
  cli("apply", "-p", Q, "--ops", JSON.stringify([{ op: "update_track", id: "music", set: { duck: Number(duck) } }]));
  const fixed = notDucked(Q);
  check("applying the hinted duck clears the finding", fixed.length === 0, fixed);

  // a short stretch of un-ducked music inside long narration is judged locally, not averaged away over the whole run
  ff("-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*300*t)':s=48000:d=20", "-ac", "1", f("long-voice.wav")); // -12 dBFS in the mix, continuous
  ff("-f", "lavfi", "-i", "aevalsrc='if(between(t,8,11),0.397,0.0997)*sin(2*PI*220*t)':s=48000:d=20", "-ac", "1", f("swell.wav")); // 14 dB under the voice, 2 dB under for 8-11 s
  const Z = f("q-swell");
  cli("init", Z, "--preset", "reels");
  cli("apply", "-p", Z, "--ops", JSON.stringify([{ op: "update_track", id: "music", set: { duck: null } },
    { op: "add_clip", track: "voice", src: f("long-voice.wav"), at: 0, duration: 20 }, { op: "add_clip", track: "music", src: f("swell.wav"), at: 0, duration: 20 }]));
  const sw = notDucked(Z);
  check("3 s swell (2 dB under) inside 20 s of narration (14 dB under): one finding around 8-11 s", sw.length === 1 && sw[0].start > 7 && sw[0].start < 9 && sw[0].end > 10 && sw[0].end < 12 && sw[0].end - sw[0].start < 5, sw);
  const swDuck = /set duck=(-\d+)/.exec(sw[0]?.hint ?? "")?.[1];
  cli("apply", "-p", Z, "--ops", JSON.stringify([{ op: "update_track", id: "music", set: { duck: Number(swDuck) } }]));
  check(`the swell's hinted duck (${swDuck}) clears it`, !!swDuck && notDucked(Z).length === 0, notDucked(Z));

  // each voice clip is judged against its own level: a quiet dialogue clip next to a loud voiceover, with a bed under the dialogue
  ff("-f", "lavfi", "-i", "aevalsrc='0.5*sin(2*PI*300*t)':s=48000:d=6", "-ac", "1", f("vo-loud.wav")); // -12 dBFS in the mix
  ff("-f", "lavfi", "-i", "aevalsrc='0.035*sin(2*PI*300*t)':s=48000:d=6", "-ac", "1", f("dlg-quiet.wav")); // -35 dBFS in the mix
  ff("-f", "lavfi", "-i", "aevalsrc='0.0251*sin(2*PI*220*t)':s=48000:d=13", "-ac", "1", f("bed-low.wav")); // -38 dBFS: 3 dB under the dialogue, 26 dB under the voiceover
  const M = f("q-mixed");
  cli("init", M, "--preset", "reels");
  cli("apply", "-p", M, "--ops", JSON.stringify([{ op: "update_track", id: "music", set: { duck: null } }, { op: "add_track", id: "dlg", kind: "audio", role: "dialogue" },
    { op: "add_clip", track: "voice", src: f("vo-loud.wav"), at: 0, duration: 6 }, { op: "add_clip", track: "dlg", src: f("dlg-quiet.wav"), at: 6.5, duration: 6 },
    { op: "add_clip", track: "music", src: f("bed-low.wav"), at: 0, duration: 13 }]));
  const mixed = notDucked(M);
  check("bed 3 dB under a quiet dialogue clip is reported although a loud voiceover sets a high global level", mixed.length === 1 && mixed[0].start >= 6 && mixed[0].end <= 13, mixed);

  // music louder than the voice: the hint says so
  ff("-f", "lavfi", "-i", "aevalsrc='0.7*sin(2*PI*220*t)':s=48000:d=4", "-ac", "1", f("bed-hot.wav"));
  const hot = notDucked(mixOf("q-hot", "bed-hot.wav"));
  check("music above the voice: hint says 'above', not a negative 'under'", hot.length === 1 && /dB above the voice/.test(hot[0].hint) && !/-\d+(\.\d+)? dB under/.test(hot[0].hint), hot);
}

// a sample rate whose 20 ms window rounds up (11025 Hz: 220.5 -> 221 frames) makes the last read block start past the data
ff("-f", "lavfi", "-i", "sine=f=220:d=11", "-ac", "2", f("bed11.wav"));
{
  const Q = f("q-11025");
  cli("init", Q, "--preset", "reels");
  cli("apply", "-p", Q, "--ops", JSON.stringify([{ op: "set_settings", sample_rate: 11025, loudness: null }, { op: "add_clip", track: "music", src: f("bed11.wav"), at: 0, duration: 10.01 }]));
  let odd: any = null, err = "";
  try { odd = cli("audio", "-p", Q); } catch (e: any) { err = String(e.message); }
  check("audio_check at sample_rate 11025 on a 10.01 s project: mix lane present, no throw", !!odd && odd.lanes.some((l: any) => l.track === "mix"), err || odd?.lanes);
}

const src = cli("audio", "--source", f("clip.wav"), "-o", f("clip.png"));
check("source file: clipping found at 0-1s", src.findings.some((x: any) => x.type === "clipping" && x.start < 0.1 && x.end > 0.9), src.findings);
check("source file: 2s silence found at 1-3s", src.findings.some((x: any) => x.type === "silence" && Math.abs(x.start - 1) < 0.05 && Math.abs(x.end - 3) < 0.05), src.findings);

console.log("motion");
const mo = cli("motion", "-p", P, "--frames", 8);
check("one strip per transition", mo.ok && mo.strips.length === 1 && mo.strips[0].times.length === 8 && existsSync(mo.images[0]), mo);
const mr = cli("motion", "-p", P, "--start", 1, "--end", 2, "--frames", 5);
check("range strip: evenly spaced times", JSON.stringify(mr.strips[0].times) === "[1,1.25,1.5,1.75,2]", mr.strips);

console.log("mcp");
const client = new Client({ name: "verify-test", version: "1" });
await client.connect(new StdioClientTransport({ command: CLI[0], args: [resolve(import.meta.dir, "../src/mcp.ts")], env: { ...env, AGENTCUT_PROJECT: P } }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  return { json: JSON.parse(r.content.find((c: any) => c.type === "text").text), images: r.content.filter((c: any) => c.type === "image") };
};
const ma = await call("audio_check", {});
check("audio_check returns a PNG", ma.json.ok && ma.images.length === 1 && ma.images[0].mimeType === "image/png", ma.json);
const mm = await call("motion_strip", { frames: 6 });
check("motion_strip returns a JPEG per page", mm.json.ok && mm.images.length === 1 && mm.images[0].mimeType === "image/jpeg", mm.json);
const mv = await call("review", { beats: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
check("review over MCP", mv.json.ok && typeof mv.json.clean === "boolean" && Array.isArray(mv.json.findings), mv.json);
await client.close();

console.log(`${fails ? `✗ ${fails} failed` : "OK - verify checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true }); else console.log("kept", tmp);
process.exit(fails ? 1 : 0);
