// Regression checks for the review of the colour/audio/vision/ui/verify round: one block per fixed bug.
// Run: bun tests/review.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-review-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
for (const k of ["AGENTCUT_TTS_PROVIDER", "AGENTCUT_TTS_URL", "AGENTCUT_TTS_KEY"]) delete process.env[k];
const api = await import("../src/api.ts");
const AN = await import("../src/analyze.ts");
const { gradeChain } = await import("../src/color.ts");
const { kfValue } = await import("../src/anim.ts");
const { startUi } = await import("../src/ui.ts");

let failures = 0;
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
const ff = (...a: string[]) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a], { encoding: "utf8" }); if (r.status) throw new Error(r.stderr); };
const code = async (f: () => unknown) => { try { await f(); return "ok"; } catch (e: any) { return e.code ?? e.message; } };

const m = join(tmp, "media"); mkdirSync(m);
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=f=440:duration=4", "-shortest", "-pix_fmt", "yuv420p", "-c:a", "aac", join(m, "av.mp4"));
ff("-f", "lavfi", "-i", "sine=f=300:duration=2", join(m, "reply.wav"));
const P = join(tmp, "proj");
api.create(P, { preset: "reels" });
const tl = () => api.info(P, "json").timeline as any;
const clip = (id: string) => tl().tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id);

console.log("tts: script text never reaches argv");
{
  // a fake OS engine records its argv; a script starting with '-' used to be parsed as an option
  const bin = join(tmp, "bin"); mkdirSync(bin);
  const exe = process.platform === "darwin" ? "say" : "espeak-ng";
  const outFlag = process.platform === "darwin" ? "-o" : "-w";
  writeFileSync(join(bin, exe), `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\nprintf '%s\\n' "$@" > "${tmp}/tts.args"\n` +
    `while [ $# -gt 0 ]; do [ "$1" = "-f" ] && cp "$2" "${tmp}/tts.text"; [ "$1" = "${outFlag}" ] && cp "${join(m, "reply.wav")}" "$2"; shift; done\n`);
  chmodSync(join(bin, exe), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    if (process.platform !== "win32") {
      const r = AN.tts("-5% off today", join(tmp, "vo.wav"));
      const args = readFileSync(join(tmp, "tts.args"), "utf8").split("\n");
      check("dash-leading script is passed as a file", r.duration > 1 && !args.includes("-5% off today") && readFileSync(join(tmp, "tts.text"), "utf8") === "-5% off today", args);
    }
  } finally { process.env.PATH = PATH; }
  if (process.platform === "darwin") {
    const r = AN.tts("-5% off today", join(tmp, "say.wav"));
    check("real macOS say speaks a dash-leading script", r.duration > 0.5, r);
  }
}

console.log("colour: tint + gamma stay inside colorbalance's range");
{
  const g = gradeChain({ gamma: [1, 0, 1], tint: 1 }).join(",");
  const vals = [...g.matchAll(/[rgb][smh]=(-?[\d.]+)/g)].map((x) => Math.abs(+x[1]));
  const run = spawnSync("ffmpeg", ["-v", "error", "-i", join(m, "av.mp4"), "-frames:v", "1", "-vf", g, "-f", "null", "-"], { encoding: "utf8" });
  check("values clamped and ffmpeg accepts the chain", vals.every((v) => v <= 1) && run.status === 0, { g, err: run.stderr });
}

console.log("scopes: full-range luma");
{
  await api.apply(P, [{ op: "add_clip", track: "main", type: "color", color: "#FFFFFF", duration: 1 }]);
  const s = await api.scopes(P, 0.5, { out: join(tmp, "white-scopes.jpg") });
  check("pure white reads as luma 1.0 (was 0.92 = limited range)", s.stats.luma.max > 0.98 && s.stats.luma.avg > 0.98, s.stats);
  await api.apply(P, [{ op: "remove_clip", id: "col1" }]);
}

const add = await api.apply(P, [{ op: "add_clip", track: "main", src: join(m, "av.mp4"), fit: "contain" }]);
const vid = add.results[0].id as string;

console.log("remove_background.model is validated with the timeline");
check("unknown model in update_clip -> validation_failed", await code(() => api.apply(P, [{ op: "update_clip", id: vid, set: { remove_background: { model: "bogus" } } }])) === "validation_failed");
check("known model passes validation", api.validate(P).valid && (await code(() => api.apply(P, [{ op: "update_clip", id: vid, set: { remove_background: { model: "u2netp" } } }], { dryRun: true }))) === "ok");

console.log("detach_audio carries the audio processing");
{
  await api.apply(P, [{ op: "update_clip", id: vid, set: { eq: "voice_clarity", pan: -0.5, normalize: true } }]);
  const r = await api.apply(P, [{ op: "detach_audio", id: vid }]);
  const aud = clip(r.results[0].audio ?? r.results[0].id);
  const v = clip(vid);
  check("eq/pan/normalize moved to the audio clip", aud?.eq === "voice_clarity" && aud.pan === -0.5 && aud.normalize === true, aud);
  check("muted video keeps no audio fields", v.muted && v.eq === undefined && v.pan === undefined && v.normalize === undefined, v);
}

console.log("split keeps keyframes on the right half");
{
  await api.apply(P, [
    { op: "set_keyframes", id: vid, prop: "opacity", keyframes: [[0, 0], [4, 1]] },
    { op: "set_keyframes", id: vid, prop: "speed", keyframes: [[0, 1], [4, 1]] },
  ], { allowInvalid: true });
  await api.apply(P, [{ op: "set_keyframes", id: vid, prop: "speed", keyframes: null }]);
  const audId = tl().tracks.flatMap((t: any) => t.clips).find((c: any) => c.attach_to === vid).id;
  await api.apply(P, [{ op: "set_keyframes", id: audId, prop: "volume", keyframes: [[0, 1], [4, 0]] }]);
  const s = await api.apply(P, [{ op: "split_clip", id: vid, at: 1 }]);
  const right = clip(s.results[0].right), left = clip(vid);
  check("left half keeps its curve", kfValue(left.keyframes.opacity, 0.5) === 0.125, left.keyframes);
  check("right half continues the curve (was reset to static)", Math.abs(kfValue(right.keyframes.opacity, 0) - 0.25) < 1e-9 && Math.abs(kfValue(right.keyframes.opacity, 3) - 1) < 1e-9, right.keyframes);
  const ar = tl().tracks.flatMap((t: any) => t.clips).find((c: any) => c.attach_to === right.id);
  check("detached audio's right half continues its volume curve", ar && Math.abs(kfValue(ar.keyframes.volume, 0) - 0.75) < 1e-9, ar?.keyframes);
}

console.log("revision must be an integer");
check("fractional revision -> bad_revision", await code(() => api.apply(P, [{ op: "add_marker", t: 1 }], { revision: 1.5 })) === "bad_revision");
check("NaN revision (CLI --revision abc) -> bad_revision", await code(() => api.apply(P, [{ op: "add_marker", t: 1 }], { revision: Number("abc") })) === "bad_revision");
check("undo with NaN revision -> bad_revision", await code(() => api.undo(P, 1, NaN)) === "bad_revision");

console.log("render -o subs.srt writes captions (CLI and MCP agree)");
{
  await api.apply(P, [{ op: "add_captions", words: [{ text: "Hello", start: 0.2, end: 0.6 }, { text: "world", start: 0.6, end: 1 }] }]);
  const r: any = await api.render(P, { out: join(tmp, "subs.srt") });
  check("api.render .srt -> subtitle file", r.format === "srt" && r.cues === 1 && /hello world/i.test(readFileSync(join(tmp, "subs.srt"), "utf8")), r);
}

console.log("ui: concurrent play renders share one job, the cache never sees a partial file");
{
  const ui = await startUi(P, { port: 0 });
  try {
    const post = (body: unknown) => fetch(`${ui.url}api/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    const [a, b] = await Promise.all([post({ play: true, start: 0, end: 1 }), post({ play: true, start: 0, end: 1 })]);
    const rev = api.info(P).revision;
    const final = join(P, "previews", "ui", `play-r${rev}-0.00-1.00.mp4`);
    check("second request joins the running job", a.id === b.id, [a.id, b.id]);
    check("final path absent while rendering", a.status !== "running" || !existsSync(final));
    const uiDir = join(P, "previews", "ui"), parts = () => existsSync(uiDir) ? readdirSync(uiDir).filter((f) => f.includes(".part")) : [];
    let part: string[] = [], pruned = false;
    for (let i = 0; i < 3000 && !part.length; i++) { part = parts(); if (!part.length) await new Promise((ok) => setTimeout(ok, 5)); }
    if (part.length) { api.cache.prune(P); pruned = true; } // a prune while the render runs must not take its draft
    check("draft is named .part-<pid>- (protected as in flight) and survives a prune", pruned && part.every((f) => f.includes(`.part-${process.pid}-`)) && parts().length > 0, { part, now: parts() });
    let done: any = null;
    for (let i = 0; i < 300 && !done; i++) { const s: any = await fetch(`${ui.url}api/jobs/${a.id}`).then((r) => r.json()); if (s.status !== "running") done = s; else await new Promise((ok) => setTimeout(ok, 100)); }
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", final], { encoding: "utf8" });
    check("finished preview is complete and renamed into place", done?.status === "done" && Math.abs(Number(probe.stdout) - 1) < 0.1 && parts().length === 0, { done, d: probe.stdout, left: parts() });
    const again = await post({ play: true, start: 0, end: 1 });
    check("next request is a cache hit", again.status === "done" && again.url === done.url);
  } finally { ui.server.closeAllConnections?.(); await new Promise((ok) => ui.server.close(ok)); }
}

if (process.argv.includes("--keep")) console.log("kept", tmp); else rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall review checks passed");
process.exit(failures ? 1 : 0);
