// AI vision ops: auto_reframe, remove_background, track_to (+ path smoothing, caching, missing-tool errors).
// The Python helper is replaced by a fake `uv` (AGENTCUT_UV) returning known tracks and a real alpha matte, so pixel checks
// are exact and the suite runs offline. AGENTCUT_TEST_VISION=1 also runs the real helper through uv (downloads packages).
// Run: bun tests/vision.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync as lstat, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync as symlink, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-vision-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("../src/api.ts");
const V = await import("../src/vision.ts");

let failures = 0;
const t0 = performance.now();
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
const near = (a: unknown, b: number, eps = 1e-3) => typeof a === "number" && Math.abs(a - b) < eps;
function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}
/** RGB of the pixel (x, y) in an image file */
function px(img: string, x: number, y: number): number[] {
  const r = spawnSync("ffmpeg", ["-v", "error", "-i", img, "-vf", `crop=1:1:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  return [...r.stdout];
}
const isColor = (p: number[], c: number[], tol = 40) => p.length === 3 && p.every((v, i) => Math.abs(v - c[i]) < tol);

const m = join(tmp, "media");
mkdirSync(m);
console.log("media ->", tmp);
// left half red, right half blue, 16:9, 4 s
ff("-f", "lavfi", "-i", "color=c=red:s=640x360:r=30:d=4", "-vf", "drawbox=x=320:y=0:w=320:h=360:color=blue:t=fill", "-pix_fmt", "yuv420p", join(m, "rb.mp4"));
ff("-f", "lavfi", "-i", "color=c=0x00ff00:s=320x180:r=30:d=2", "-pix_fmt", "yuv420p", join(m, "green.mp4"));
ff("-f", "lavfi", "-i", "color=c=gray:s=640x360", "-frames:v", "1", join(m, "still.png"));
ff("-f", "lavfi", "-i", "color=c=gray:s=640x360:r=30:d=2", "-pix_fmt", "yuv420p", join(m, "empty.mp4"));

// ---------------------------------------------------------------- fake uv
const calls = join(tmp, "calls.log");
const fake = join(tmp, "fake-uv.mjs");
writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const job = JSON.parse(process.argv.at(-1));
appendFileSync(${JSON.stringify(calls)}, job.cmd + "\\n");
const n = job.fps ? Math.max(2, Math.round((job.duration ?? 4) * job.fps)) : 1;
const ts = Array.from({ length: n }, (_, i) => +((job.start ?? 0) + i / (job.fps ?? 6)).toFixed(4));
let out;
if (job.cmd === "subject" && job.path.includes("empty")) out = { samples: [] };
else if (job.cmd === "subject" && n === 1) out = { samples: [{ t: 0, x: 0.8, y: 0.5, kind: "face", score: 1 }] };
else if (job.cmd === "subject") // subject walks 0.1 -> 0.9 with jitter, one outlier and one empty sample
  out = { samples: ts.map((t, i) => i === 3 ? { t, kind: "none", score: 0 }
    : { t, x: i === 6 ? 0.02 : 0.1 + (0.8 * i) / (n - 1) + (i % 2 ? 0.02 : -0.02), y: 0.5, kind: "saliency", score: 0.5 }) };
else if (job.cmd === "track") // box centre moves linearly from x 0.25 to 0.75 over the range, y fixed 0.5
  out = { samples: ts.map((t, i) => ({ t, x: 0.25 + (0.5 * i) / (n - 1), y: 0.5, w: job.box[2], h: job.box[3], ok: i !== 2 })) };
else { // matte: source with its LEFT half transparent
  const vf = "scale=" + job.w + ":" + job.h + ",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,W/2),0,255)'";
  const enc = job.kind === "image" ? ["-frames:v", "1", "-f", "image2", "-c:v", "png"] : ["-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-f", "mov"];
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", job.path, "-an", "-vf", vf, ...enc, job.out], { encoding: "utf8" });
  if (r.status) { process.stderr.write(r.stderr); process.exit(1); }
  out = { out: job.out, frames: 1 };
}
process.stdout.write(JSON.stringify(out));
`);
chmodSync(fake, 0o755);
process.env.AGENTCUT_UV = fake;
/** a model file as the matte models dir holds it: <cache>/models/<name>/<name>.onnx (the content is never read by the fake uv) */
const modelFile = (name: string) => join(process.env.AGENTCUT_CACHE!, "models", name, `${name}.onnx`);
const seedModel = (name: string) => { mkdirSync(join(process.env.AGENTCUT_CACHE!, "models", name), { recursive: true }); writeFileSync(modelFile(name), ""); };
for (const name of ["u2netp", "u2net"]) seedModel(name); // the models the suite's mattes use are cached
const nCalls =(cmd?: string) => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((l) => l && (!cmd || l === cmd)).length : 0);

// ---------------------------------------------------------------- pure path helpers
console.log("smoothPath / simplify");
{
  const ts = Array.from({ length: 41 }, (_, i) => i / 10);
  const noisy = ts.map((t, i) => 0.5 + (i % 2 ? 0.05 : -0.05));
  const sm = V.smoothPath(ts, noisy, 0.5);
  const span = (v: number[]) => Math.max(...v) - Math.min(...v);
  check("jitter removed (0.1 peak-to-peak -> < 0.01, ends included)", span(sm) < 0.01, span(sm));
  const spike = ts.map((_, i) => (i === 20 ? 1 : 0.3));
  check("median kills a one-sample outlier", V.smoothPath(ts, spike, 0).every((v) => near(v, 0.3)));
  const gap = V.smoothPath([0, 1, 2, 3], [0.2, undefined, undefined, 0.8], 0);
  check("gaps interpolate", near(gap[1], 0.4) && near(gap[2], 0.6), gap);
  check("no detections -> centre", V.smoothPath([0, 1], [undefined, undefined], 0.5).every((v) => v === 0.5));
  const lin = ts.map((t) => t / 4), keep = V.simplify(ts, [lin], 0.001);
  check("simplify: straight line -> 2 points", keep.length === 2 && keep[0] === 0 && keep[1] === 40, keep);
  const vee = ts.map((t) => Math.abs(t - 2)), kv = V.simplify(ts, [vee], 0.001);
  check("simplify: keeps the corner", kv.length === 3 && kv[1] === 20, kv);
}

// ---------------------------------------------------------------- auto_reframe
console.log("auto_reframe");
const P = join(tmp, "reel");
api.create(P, { preset: "reels" });
const apply = async (proj: string, ops: any[]) => (await api.apply(proj, ops)).results;
async function fails(proj: string, ops: any[], code: string, name: string) {
  try { await apply(proj, ops); check(name, false, "no error"); }
  catch (e: any) { check(name, e.code === code && !!e.hint, { code: e.code, message: e.message, hint: e.hint }); }
}
/** apply, then prepare when the batch recorded vision requests; returns the op results after prepare */
async function applyPrep(proj: string, ops: any[]) {
  const r = await api.apply(proj, ops);
  if (!r.results.some((x: any) => x.pending)) return r.results;
  const pr = await api.prepare(proj);
  return r.results.map((x: any) => (x.pending ? pr.applied.find((y: any) => y.op === x.op && y.id === x.id) ?? x : x));
}
async function prepFails(proj: string, ops: any[], code: string, name: string) {
  await apply(proj, ops);
  try { await api.prepare(proj); check(name, false, "no error"); }
  catch (e: any) { check(name, e.code === code && !!e.hint, { code: e.code, message: e.message, hint: e.hint }); }
  await api.undo(proj);
}
const clip = (proj: string, id: string) => api.info(proj, "json").timeline.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id);

await apply(P, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4 }]);
const t1 = performance.now(), a1: any = await api.apply(P, [{ op: "auto_reframe", id: "vid1" }]);
check("apply only records the request (no helper run, pending + hint)", a1.results[0].pending === true && a1.prepare_needed && nCalls() === 0 && clip(P, "vid1").pending?.auto_reframe && !clip(P, "vid1").keyframes, a1);
check("apply stays fast", performance.now() - t1 < 1000, performance.now() - t1);
const nf: any = await api.frame(P, 0.05, { scale: 0.25 }).catch((e) => e);
check("preview before prepare -> not_prepared with prepare hint", nf.code === "not_prepared" && /prepare/.test(nf.hint) && nf.details?.pending?.[0] === "auto_reframe vid1", nf);
check("prepare status lists the missing analysis", (api.prepareStatus(P) as any).missing[0]?.kind === "subject", api.prepareStatus(P));
const prog: number[] = [], pr1: any = await api.prepare(P, { progress: (d, n) => prog.push(d / n) });
const r1 = pr1.applied[0];
check("prepare computes, applies and clears pending (progress reaches 1)", pr1.computed.length === 1 && pr1.computed[0].cached === false && !clip(P, "vid1").pending && prog.at(-1) === 1, { pr1, prog });
const fx = clip(P, "vid1").keyframes?.focus_x;
check("writes focus_x keyframes (9:16 pans horizontally only)", Array.isArray(fx) && fx.length >= 2 && !clip(P, "vid1").keyframes.focus_y, clip(P, "vid1"));
check("focus within 0..1 and moves right", fx && fx.every((k: any) => k[1] >= 0 && k[1] <= 1) && fx.at(-1)[1] > fx[0][1] + 0.5, fx);
// subject 0.1 -> 0.9 of a 3413 px wide cover frame (640x360 into 1080x1920) seen through a 1080 px window
const steps = fx ? fx.slice(1).map((k: any, i: number) => (k[1] - fx[i][1]) / (k[0] - fx[i][0])) : [];
check("smooth: no backwards steps (jitter gone)", steps.every((s: number) => s >= -1e-6), steps);
check("result reports samples", r1.samples === 24 && nCalls("subject") === 1, r1);
const r2 = (await apply(P, [{ op: "auto_reframe", id: "vid1" }]))[0];
check("cached analysis applies at once in apply_ops (no pending)", !r2.pending && r2.samples === 24 && nCalls("subject") === 1, r2);
check("prepare with nothing pending is a no-op", (await api.prepare(P)).computed.length === 0 && nCalls("subject") === 1);
await applyPrep(P, [{ op: "auto_reframe", id: "vid1", fps: 4 }]);
check("other params -> new analysis", nCalls("subject") === 2);

const f0 = await api.frame(P, 0.05, { scale: 0.25, out: join(tmp, "rf0.png") });
const f1 = await api.frame(P, 3.9, { scale: 0.25, out: join(tmp, "rf1.png") });
check("render follows: start shows the left (red) side", isColor(px(f0.image, 135, 240), [255, 0, 0]), px(f0.image, 135, 240));
check("render follows: end shows the right (blue) side", isColor(px(f1.image, 135, 240), [0, 0, 255]), px(f1.image, 135, 240));

const ri = (await applyPrep(P, [{ op: "add_clip", track: "main", src: join(m, "still.png"), duration: 1 }, { op: "auto_reframe", id: "img1" }]))[1];
// subject at 0.8 of 3413 px; window 1080 -> focus = (0.8 * 3413 - 540) / (3413 - 1080)
check("image: one sample -> static focus, no keyframes", ri.samples === 1 && near(clip(P, "img1").focus[0], (0.8 * 3413 - 540) / 2333, 2e-3) && !clip(P, "img1").keyframes, { ri, c: clip(P, "img1") });
await apply(P, [{ op: "remove_clip", id: "img1" }]);
await prepFails(P, [{ op: "add_clip", track: "main", src: join(m, "empty.mp4"), duration: 1 }, { op: "auto_reframe", id: "vid2" }], "vision_failed", "no decoded frames -> vision_failed at prepare");
await fails(P, [{ op: "update_clip", id: "vid1", set: { fit: "contain" } }, { op: "auto_reframe", id: "vid1" }], "unsupported", "fit contain -> unsupported");
await fails(P, [{ op: "update_clip", id: "vid1", set: { motion: "ken_burns" } }, { op: "auto_reframe", id: "vid1" }], "unsupported", "animated clip -> unsupported");
await fails(P, [{ op: "add_clip", track: "text", text: "hi", at: 0, duration: 1 }, { op: "auto_reframe", id: "txt1" }], "bad_type", "text clip -> bad_type");
const Y = join(tmp, "yt");
api.create(Y, { preset: "youtube" });
await apply(Y, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4 }]);
await fails(Y, [{ op: "auto_reframe", id: "vid1" }], "nothing_to_do", "16:9 in 16:9 -> nothing_to_do");
await fails(P, [{ op: "auto_reframe", id: "vid1", axis: "z" }], "bad_value", "bad axis -> bad_value");

// ---------------------------------------------------------------- track_to
console.log("track_to");
await apply(Y, [{ op: "add_clip", track: "overlay", type: "shape", shape: "circle", size: [40, 40], fill: "white", at: 1, duration: 2 }]);
const tr = (await applyPrep(Y, [{ op: "track_to", id: "shp1", target: "vid1", box: [400, 400, 200, 200], at: 1.5, fps: 10 }]))[0];
const sh = clip(Y, "shp1");
check("attached to the target at the same start", sh.attach_to === "vid1" && near(sh.offset, 1) && tr.lost === 1, { sh, tr });
// fake track: centre x 0.25 -> 0.75 of the source over the follower's 2 s; 1920 px canvas shows the whole frame
check("x keyframes map source -> canvas", near(sh.keyframes.x[0][1], 480, 0.6) && near(sh.keyframes.x.at(-1)[1], 1440, 0.6) && near(sh.keyframes.y[0][1], 540, 0.6), sh.keyframes);
check("keyframes thinned (straight path)", sh.keyframes.x.length <= 4, sh.keyframes.x.length);
await apply(Y, [{ op: "trim_clip", id: "vid1", trim_start: 0 }, { op: "update_clip", id: "vid1", set: { duration: 4 } }]);
await fails(Y, [{ op: "track_to", id: "shp1", target: "vid1", box: [400, 400, 200, 200], at: 3.5 }], "out_of_range", "'at' outside the overlap -> out_of_range");
await fails(Y, [{ op: "track_to", id: "shp1", target: "vid1", box: [10, 10] }], "bad_value", "box needs 4 numbers");
await fails(Y, [{ op: "track_to", id: "shp1", target: "vid1", box: [400, 400, 200, 200], tracker: "nope" }], "bad_value", "unknown tracker -> bad_value");
await fails(Y, [{ op: "track_to", id: "shp1", target: "shp1" }], "bad_value", "self-tracking -> bad_value");
await fails(Y, [{ op: "add_track", id: "mag", kind: "video", magnetic: true }, { op: "add_clip", track: "mag", type: "shape", shape: "circle", size: [40, 40], fill: "white", duration: 2, id: "shpm" }, { op: "track_to", id: "shpm", target: "vid1", box: [400, 400, 200, 200], at: 1.5 }], "attached_magnetic", "track_to on a follower of a magnetic track -> attached_magnetic");

// on a reframed (panning) target the follower must account for the moving crop window
// both pending in one batch (new reframe params): track_to waits for the reframe, prepare runs them in order
const both: any = await api.apply(P, [{ op: "update_clip", id: "vid1", set: { motion: null } }, { op: "auto_reframe", id: "vid1", fps: 5 },
  { op: "add_clip", track: "overlay", type: "shape", shape: "rect", size: [20, 20], fill: "white", at: 0, duration: 4 },
  { op: "track_to", id: "shp1", target: "vid1", box: [500, 900, 100, 100], at: 0 }]);
check("track_to on a pending reframe waits for it", both.results[3].waiting_for === "auto_reframe vid1", both.results[3]);
const pb: any = await api.prepare(P);
check("prepare resolves the chain (reframe, then track)", pb.applied.map((x: any) => x.op).join() === "auto_reframe,track_to" && !clip(P, "shp1").pending, pb);
{
  const v = clip(P, "vid1"), s = clip(P, "shp1"), A = await import("../src/anim.ts");
  const full = Math.round(640 * (1920 / 360)), k = s.keyframes.x[0], t = k[0];
  const u = 0.25 + (0.5 * t * 15) / 59, want = u * full - (full - 1080) * A.kfValue(v.keyframes.focus_x, t);
  check("track_to on a reframed clip subtracts the pan", near(k[1], want, 2), { got: k[1], want });
}

// ---------------------------------------------------------------- remove_background
console.log("remove_background");
const B = join(tmp, "bg");
api.create(B, { preset: "720p" });
await apply(B, [
  { op: "add_clip", track: "main", src: join(m, "green.mp4"), duration: 2 },
  { op: "add_clip", track: "overlay", src: join(m, "rb.mp4"), at: 0, duration: 2 },
]);
const before = await api.frame(B, 1, { scale: 0.5, out: join(tmp, "rb-before.png") });
check("without matte the overlay covers the background", isColor(px(before.image, 40, 180), [255, 0, 0]));
const rb = (await apply(B, [{ op: "remove_background", id: "vid2" }]))[0];
check("remove_background only sets the field (pending, no helper run)", rb.pending === true && clip(B, "vid2").remove_background === true && nCalls("matte") === 0, rb);
const nr: any = await api.render(B, { out: join(tmp, "bg0.mp4"), quality: "draft" }).catch((e) => e);
check("render before prepare -> not_prepared", nr.code === "not_prepared" && nr.details?.mattes?.[0] === "vid2" && !existsSync(join(tmp, "bg0.mp4")), nr);
const nrs: any = await api.render(B, { out: join(tmp, "bg0.png") }).catch((e) => e);
check("a still render before prepare -> not_prepared, no file", nrs.code === "not_prepared" && !existsSync(join(tmp, "bg0.png")), nrs);
const nrb: any = await api.render(B, { out: join(tmp, "bg1.png"), start: 99 }).catch((e) => e);
check("a bad start on an unprepared project -> bad_value, not not_prepared, no file", nrb.code === "bad_value" && !existsSync(join(tmp, "bg1.png")), nrb);
const pm: any = await api.prepare(B);
check("prepare writes the matte into the project cache dir", pm.computed[0]?.kind === "matte" && pm.computed[0].file.startsWith(join(B, ".agentcut", "cache")) && existsSync(pm.computed[0].file), pm);
check("prepared matte is reported by a repeated op", (await apply(B, [{ op: "remove_background", id: "vid2" }]))[0].matte === pm.computed[0].file);
const after = await api.frame(B, 1, { scale: 0.5, out: join(tmp, "rb-after.png") });
check("matte: transparent half shows the background", isColor(px(after.image, 40, 180), [0, 255, 0]), px(after.image, 40, 180));
check("matte: opaque half keeps the clip", isColor(px(after.image, 600, 180), [0, 0, 255]), px(after.image, 600, 180));
const mc = nCalls("matte");
const rend: any = await api.render(B, { out: join(tmp, "bg.mp4"), quality: "draft" });
check("render reuses the cached matte", nCalls("matte") === mc && rend.frames === 60, { calls: nCalls("matte"), rend });
rmSync(join(B, ".agentcut", "cache"), { recursive: true });
const gone: any = await api.frame(B, 1, { scale: 0.5, out: join(tmp, "rb-again.png") }).catch((e) => e);
check("deleted cache -> preview fails fast, never computes", gone.code === "not_prepared" && nCalls("matte") === mc, gone);
await api.prepare(B);
check("prepare rebuilds a deleted matte", nCalls("matte") === mc + 1 && readdirSync(join(B, ".agentcut", "cache")).some((f) => f.startsWith("matte-")));
{ // the project cache dir as a link: prepare refuses it before the helper runs, and the target is unchanged (content, entries, mtimes)
  const t = join(tmp, "cache-link-target"), cacheD = join(B, ".agentcut", "cache");
  mkdirSync(t);
  writeFileSync(join(t, "keep.txt"), "keep");
  utimesSync(t, 1e9, 1e9);
  const snap = () => [".", ...readdirSync(t, { recursive: true }).map(String).sort()].map((e) => { const st = lstat(join(t, e)); return `${e}:${st.isSymbolicLink() ? "->" + readlinkSync(join(t, e)) : st.isDirectory() ? "/" + st.mtimeMs : readFileSync(join(t, e), "utf8")}`; }).join("\n");
  const was = snap(), calls = nCalls("matte");
  rmSync(cacheD, { recursive: true });
  symlink(t, cacheD);
  const lk: any = await api.prepare(B).catch((e) => e);
  check(".agentcut/cache as a link: prepare -> unsafe_path, the helper is not run, the target is unchanged", lk.code === "unsafe_path" && nCalls("matte") === calls && snap() === was, { code: lk.code, calls: nCalls("matte") - calls, now: snap() });
  unlinkSync(cacheD);
  await api.prepare(B);
}
await fails(B, [{ op: "remove_background", id: "vid2", model: "bogus" }], "bad_value", "unknown model -> bad_value");
const off = (await apply(B, [{ op: "remove_background", id: "vid2", off: true }]))[0];
check("off=true removes the field", off.remove_background === false && clip(B, "vid2").remove_background === undefined);
const ex = await api.exportTimeline(B, { out: join(tmp, "x.fcpxml") }).catch((e: any) => e);
await apply(B, [{ op: "remove_background", id: "vid2" }]);
const ex2: any = await api.exportTimeline(B, { out: join(tmp, "x.fcpxml") });
check("interchange export reports background removal as skipped", JSON.stringify(ex2.skipped).includes("background removal") && !JSON.stringify(ex.skipped ?? "").includes("background removal"), ex2.skipped);

// audio-only outputs need no prepared analysis; video outputs still fail fast
console.log("audio-only render vs not_prepared");
ff("-f", "lavfi", "-i", "sine=frequency=440:duration=2", join(m, "tone.wav"));
const AO = join(tmp, "audio-only");
api.create(AO, { preset: "reels" });
await apply(AO, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 2 }, { op: "add_clip", track: "music", src: join(m, "tone.wav"), duration: 2 }]);
await apply(AO, [{ op: "auto_reframe", id: "vid1" }]);
check("audio-only: pending reframe recorded", !!clip(AO, "vid1").pending?.auto_reframe);
const wavP: any = await api.render(AO, { out: join(tmp, "pend.wav") }).catch((e: any) => e);
check("audio-only: render -o .wav with a pending reframe succeeds", wavP.audio_only === true && existsSync(join(tmp, "pend.wav")) && wavP.size_bytes > 0, wavP);
const vidP: any = await api.render(AO, { out: join(tmp, "pend.mp4"), quality: "draft" }).catch((e: any) => e);
check("audio-only: video render with the pending reframe still fails not_prepared", vidP.code === "not_prepared" && vidP.details?.pending?.[0] === "auto_reframe vid1" && !existsSync(join(tmp, "pend.mp4")), vidP);
await apply(B, [{ op: "remove_background", id: "vid2" }]);
rmSync(join(B, ".agentcut", "cache"), { recursive: true, force: true });
const wavM: any = await api.render(B, { out: join(tmp, "matte.wav") }).catch((e: any) => e);
check("audio-only: render -o .wav with a missing matte succeeds", wavM.audio_only === true && existsSync(join(tmp, "matte.wav")), wavM);
await api.prepare(B);

// pending reframe / track in interchange export: listed in skipped per clip
console.log("interchange export vs pending");
const EP = join(tmp, "export-pending");
api.create(EP, { preset: "reels" });
await apply(EP, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4 },
  { op: "add_clip", track: "overlay", type: "shape", shape: "circle", size: [40, 40], fill: "white", at: 0, duration: 4 }]);
await apply(EP, [{ op: "auto_reframe", id: "vid1" }, { op: "track_to", id: "shp1", target: "vid1", box: [400, 400, 200, 200], at: 1 }]);
check("export-pending: both clips carry pending requests", !!clip(EP, "vid1").pending?.auto_reframe && !!clip(EP, "shp1").pending?.track_to, [clip(EP, "vid1").pending, clip(EP, "shp1").pending]);
for (const ext of ["fcpxml", "otio"]) {
  const e: any = await api.exportTimeline(EP, { out: join(tmp, `pending.${ext}`) }).catch((x: any) => x);
  const mine = (id: string) => (e.skipped ?? []).filter((s: any) => s.id === id && s.type === "pending");
  check(`export-pending (${ext}): auto_reframe listed once for vid1`, mine("vid1").length === 1 && /auto_reframe/.test(mine("vid1")[0].reason), e.skipped ?? e);
  check(`export-pending (${ext}): track_to listed once for shp1`, mine("shp1").length === 1 && /track_to/.test(mine("shp1")[0].reason), e.skipped ?? e);
}
await api.prepare(EP);
const eDone: any = await api.exportTimeline(EP, { out: join(tmp, "prepared.fcpxml") });
check("export-pending: nothing pending after prepare", !JSON.stringify(eDone.skipped).includes("pending"), eDone.skipped);

// ---------------------------------------------------------------- helper location
// A recording uv: logs where the helper script lives (and its hash), the spawn's cwd and argv, then hands over to the fake above.
console.log("the vision helper always runs from a private per-user dir");
{
  const { VISION_PY } = await import("../src/vision-py.ts");
  const { createHash } = await import("node:crypto");
  const { chmodSync: chmod, lstatSync, realpathSync, statSync, symlinkSync } = await import("node:fs");
  const { dirname, basename, isAbsolute, relative, sep } = await import("node:path");
  const want = createHash("sha256").update(VISION_PY).digest("hex");
  const log = join(tmp, "helper-runs.jsonl");
  const rec = join(tmp, "recording-uv.mjs");
  writeFileSync(rec, `#!/usr/bin/env node
import { appendFileSync, chmodSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
const argv = process.argv.slice(2), script = argv.at(-2);
let sha = null; try { sha = createHash("sha256").update(readFileSync(script)).digest("hex"); } catch {}
let mode = null; try { mode = statSync(dirname(script)).mode & 0o777; } catch {}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, script, sha, mode, cwd: process.cwd() }) + "\\n");
if (process.env.FAKE_UV_FAIL) { process.stderr.write("boom\\n"); process.exit(3); }
if (process.env.FAKE_UV_HANG) setInterval(() => {}, 1000), await new Promise(() => {});
if (process.env.FAKE_UV_LOCK) chmodSync(dirname(script), 0o500); // the run dir can no longer be emptied
const r = spawnSync(${JSON.stringify(fake)}, argv, { encoding: "utf8" });
process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);
`);
  chmodSync(rec, 0o755);
  type Run = { argv: string[]; script: string; sha: string | null; mode: number | null; cwd: string };
  const runs = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as Run[];
  const within = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);
  const posix = process.platform !== "win32";
  const staleScript = "# stale helper\nraise SystemExit(99)\n", oldPath = (dir: string) => join(dir, `vision-${want.slice(0, 12)}.py`);
  const cacheEnv = process.env.AGENTCUT_CACHE!;
  mkdirSync(cacheEnv, { recursive: true });
  /** analyze_subject against its own user cache dir `cache` (a fresh cache never hits a stored result); resolves to "ok" or the error code */
  const subject = async (cache: string, fps = 5) => {
    const keep = process.env.AGENTCUT_CACHE;
    process.env.AGENTCUT_CACHE = cache;
    try { await api.analyze.subject(join(m, "rb.mp4"), fps); return "ok"; } catch (e: any) { return e.code as string; } finally { process.env.AGENTCUT_CACHE = keep; }
  };
  const fresh = (name: string) => { const d = join(tmp, `hc-${name}`); mkdirSync(d, { recursive: true }); return d; };
  process.env.AGENTCUT_UV = rec;
  try {
    // with a project: a file at the old cache path is not used and not changed; the helper lives under the per-user root
    const H = join(tmp, "helper-proj"), root = join(realpathSync(cacheEnv), "helper-runs");
    api.create(H, { preset: "reels" });
    await apply(H, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4 }, { op: "auto_reframe", id: "vid1" }]);
    mkdirSync(join(H, ".agentcut", "cache"), { recursive: true });
    writeFileSync(oldPath(join(H, ".agentcut", "cache")), staleScript);
    await api.prepare(H);
    const r1 = runs()[0];
    check("project: the helper ran once", runs().length === 1, runs());
    check("project: script is outside the project and the cache dirs and is not the old cache path", !!r1 && !within(r1.script, H) && !within(r1.script, join(cacheEnv, "vision")) && r1.script !== oldPath(join(H, ".agentcut", "cache")), r1?.script);
    check("project: the script that ran is exactly the embedded helper", r1?.sha === want, r1?.sha);
    check("project: a pre-existing file at the old cache path is not modified", readFileSync(oldPath(join(H, ".agentcut", "cache")), "utf8") === staleScript);
    check("project: the run dir is <cache>/helper-runs/vision-<pid>-xxxxxx, the script and cwd are absolute paths in it",
      !!r1 && dirname(dirname(r1.script)) === root && basename(dirname(r1.script)).startsWith(`vision-${process.pid}-`) && isAbsolute(r1.script) && r1.cwd === dirname(r1.script), r1);
    check("project: uv is told not to read config files", !!r1 && r1.argv.includes("--no-config"), r1?.argv);
    if (posix) check("project: the run dir is mode 0700", r1?.mode === 0o700, r1?.mode?.toString(8));
    if (posix) check("project: helper-runs is mode 0700", existsSync(root) && (lstatSync(root).mode & 0o777) === 0o700);
    check("project: the run dir is removed after the run", !!r1 && !existsSync(dirname(r1.script)), r1?.script);

    // no helper script is written to a project cache: a project with no file there to begin with
    const H2 = join(tmp, "helper-proj-clean");
    api.create(H2, { preset: "reels" });
    await apply(H2, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4 }, { op: "auto_reframe", id: "vid1" }]);
    await api.prepare(H2);
    check("project: no helper script is written to the project cache", runs().length === 2 && readdirSync(join(H2, ".agentcut", "cache")).every((f) => !f.endsWith(".py")), readdirSync(join(H2, ".agentcut", "cache")));

    // without a project (analyze_subject): same, against the user cache
    const userCache = join(cacheEnv, "vision");
    mkdirSync(userCache, { recursive: true });
    writeFileSync(oldPath(userCache), staleScript);
    const s: any = await api.analyze.subject(join(m, "rb.mp4"), 3);
    const r2 = runs()[2];
    check("no project: analyze_subject computed through the helper", s.cached === false && runs().length === 3, s);
    check("no project: script is in the per-user root, unchanged, and not the old cache path", !!r2 && dirname(dirname(r2.script)) === root && r2.sha === want && r2.script !== oldPath(userCache), r2);
    check("no project: a pre-existing file at the old cache path is not modified", readFileSync(oldPath(userCache), "utf8") === staleScript);
    check("no project: the run dir is removed after the run", !!r2 && !existsSync(dirname(r2.script)));

    // the run dir does not depend on the temp dir
    const otherTmp = fresh("tmpdir"), keepTmp = process.env.TMPDIR;
    process.env.TMPDIR = otherTmp;
    const codeTmp = await subject(fresh("c-tmpdir"));
    process.env.TMPDIR = keepTmp;
    const rt = runs().at(-1)!;
    check("a different TMPDIR changes nothing: the script and cwd are not under it", codeTmp === "ok" && !within(rt.script, otherTmp) && !within(rt.cwd, otherTmp), { codeTmp, rt });

    // a relative AGENTCUT_CACHE is resolved once: the checked path and the run path are the same absolute string
    const relCache = fresh("c-rel"), before = runs().length;
    const codeRel = await subject(relative(process.cwd(), relCache));
    const rr = runs().at(-1)!;
    check("relative AGENTCUT_CACHE: one absolute script path, checked and run", codeRel === "ok" && runs().length === before + 1 && isAbsolute(rr.script) && isAbsolute(rr.cwd) && rr.sha === want && within(rr.script, join(realpathSync(relCache), "helper-runs")), { codeRel, rr });

    // refusals come before anything is written and before uv runs
    const refused = async (name: string, cache: string, watch: string[]) => {
      const n = runs().length, code = await subject(cache);
      check(`${name}: refused with unsafe_helper_dir, uv not run, nothing written`, code === "unsafe_helper_dir" && runs().length === n && watch.every((d) => !existsSync(d) || readdirSync(d).length === 0), { code, ran: runs().length - n });
    };
    if (posix) {
      const cSym = fresh("c-symlink"), elsewhere = fresh("elsewhere");
      symlinkSync(elsewhere, join(cSym, "helper-runs"));
      await refused("helper-runs is a symlink", cSym, [elsewhere]);
      const cMode = fresh("c-mode");
      mkdirSync(join(cMode, "helper-runs"));
      chmod(join(cMode, "helper-runs"), 0o755);
      await refused("helper-runs has mode 0755", cMode, [join(cMode, "helper-runs")]);
      const open = fresh("open");
      mkdirSync(join(open, "sub"));
      chmod(open, 0o777);
      const under = (name: string) => join(open, "sub", name); // each case gets its own cache path, so a red result is never read through a cached one
      await refused("an ancestor is world-writable without the sticky bit", under("cache-open"), [under("cache-open")]);
      chmod(open, 0o1777);
      await refused("an ancestor that is world-writable with the sticky bit", under("cache-sticky"), [under("cache-sticky")]);
      chmod(open, 0o775);
      await refused("an ancestor that is group-writable", under("cache-group"), [under("cache-group")]);
      chmod(open, 0o755);
      if (existsSync("/tmp") && (statSync("/tmp").mode & 0o022) !== 0) { // the shared temp dir itself: refused, and the check never creates anything there
        const shared = join("/tmp", `agentcut-never-created-${process.pid}`);
        try { await refused("a cache dir under the shared /tmp", shared, [shared]); }
        finally { rmSync(shared, { recursive: true, force: true }); } // if the refusal ever regresses, nothing is left in the real /tmp
      }
    }

    // without AGENTCUT_CACHE the root is ~/.cache/agentcut/helper-runs; the walk continues to "/", and only the home dir itself may be
    // group-writable (not world-writable). A child process: the runtime reads HOME at start, and this suite must never touch the real home.
    if (posix) {
      const home = fresh("home"), cli = join(import.meta.dir, "../src/cli.ts");
      const inHome = (h = home) => {
        const e: Record<string, string | undefined> = { ...process.env, HOME: h, AGENTCUT_UV: rec };
        delete e.AGENTCUT_CACHE;
        return JSON.parse(spawnSync(process.execPath, [cli, "subject", join(m, "rb.mp4"), "--fps", "7"], { encoding: "utf8", env: e as NodeJS.ProcessEnv }).stdout || "{}");
      };
      chmod(home, 0o775);
      const nHome = runs().length, okHome = inHome(), rh = runs().at(-1)!;
      check("default root: ~/.cache/agentcut/helper-runs under a group-writable home", okHome.ok === true && runs().length === nHome + 1 && dirname(dirname(rh.script)) === join(realpathSync(home), ".cache", "agentcut", "helper-runs"), { okHome, rh });
      chmod(home, 0o777);
      rmSync(join(home, ".cache"), { recursive: true, force: true });
      const openHome = inHome();
      check("default root: a world-writable home dir is refused (unsafe_helper_dir), nothing created", openHome.ok === false && openHome.error?.code === "unsafe_helper_dir" && !existsSync(join(home, ".cache", "agentcut", "helper-runs")), openHome);
      chmod(home, 0o755);
      // the walk does not stop at the home dir: a writable directory above it counts too
      const open2 = fresh("open-above-home"), home2 = join(open2, "home");
      mkdirSync(home2);
      chmod(home2, 0o755);
      chmod(open2, 0o777);
      const n2 = runs().length, above = inHome(home2);
      check("default root: a world-writable directory above the home dir is refused (unsafe_helper_dir), uv not run, nothing created",
        above.ok === false && above.error?.code === "unsafe_helper_dir" && runs().length === n2 && !existsSync(join(home2, ".cache", "agentcut", "helper-runs")), above);
      chmod(open2, 0o755);
    }

    // the check run before every spawn refuses any file that is not the embedded helper
    const odd = join(tmp, "odd-helper.py");
    writeFileSync(odd, VISION_PY);
    V.checkHelper(odd);
    writeFileSync(odd, VISION_PY + "\n# extra\n");
    const refuse = (f: string) => { try { V.checkHelper(f); return "ran"; } catch (e: any) { return e.code; } };
    check("checkHelper: a changed file and a missing file are refused (unsafe_helper)", refuse(odd) === "unsafe_helper" && refuse(join(tmp, "no-such.py")) === "unsafe_helper");

    // a failing helper run still removes its dir
    process.env.FAKE_UV_FAIL = "1";
    await apply(H, [{ op: "auto_reframe", id: "vid1", fps: 2 }]);
    let code = "";
    try { await api.prepare(H); } catch (e: any) { code = e.code; }
    delete process.env.FAKE_UV_FAIL;
    const r3 = runs().at(-1)!;
    check("project: a failed run reports vision_failed and removes the helper dir", code === "vision_failed" && !existsSync(dirname(r3.script)), { code, r3 });
    await api.undo(H);

    // an aborted run rejects with the abort reason and removes its dir
    process.env.FAKE_UV_HANG = "1";
    await apply(H, [{ op: "auto_reframe", id: "vid1", fps: 2 }]);
    const n0 = runs().length, ac = new AbortController(), pr = api.prepare(H, { signal: ac.signal }).then(() => "done", (e: any) => e.name ?? e.code);
    for (let i = 0; i < 100 && runs().length === n0; i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    const outcome = await pr;
    delete process.env.FAKE_UV_HANG;
    const r4 = runs().at(-1)!;
    check("project: an aborted run rejects (not a cleanup error) and removes the helper dir", outcome === "AbortError" && !existsSync(dirname(r4.script)) && runs().length === n0 + 1, { outcome, r4 });
    await api.undo(H);

    // a cleanup that fails (the run dir cannot be emptied) never replaces the result
    if (posix && process.getuid?.() !== 0) {
      process.env.FAKE_UV_LOCK = "1";
      const codeLock = await subject(fresh("c-lock"));
      delete process.env.FAKE_UV_LOCK;
      const r5 = runs().at(-1)!, left = existsSync(dirname(r5.script));
      if (left) { chmod(dirname(r5.script), 0o700); rmSync(dirname(r5.script), { recursive: true, force: true }); }
      check("a failing cleanup does not mask the result", codeLock === "ok" && left, { codeLock, left });
    }
  } finally { process.env.AGENTCUT_UV = fake; delete process.env.FAKE_UV_FAIL; delete process.env.FAKE_UV_HANG; delete process.env.FAKE_UV_LOCK; }
}

// ---------------------------------------------------------------- asset values are typed and validated before they reach ffmpeg
console.log("asset record");
{
  const { FrameSource } = await import("../src/media.ts");
  const W = join(tmp, "assetfps");
  api.create(W, { preset: "720p" });
  await apply(W, [{ op: "add_clip", track: "main", src: join(m, "green.mp4"), duration: 2 }, { op: "remove_background", id: "vid1" }]);
  const file = join(W, "project.json"), good = readFileSync(file, "utf8"), tlj = JSON.parse(good), aid = Object.keys(tlj.assets)[0];
  const rev0 = api.info(W, "json").revision;
  // 1. validate types the asset record; apply and replace_timeline reject the batch and change nothing
  const badFps = { ...tlj, assets: { [aid]: { ...tlj.assets[aid], fps: "30,more" } } };
  const rejected = await api.apply(W, [{ op: "replace_timeline", timeline: badFps }]).catch((e) => e);
  check("a non-numeric asset fps is rejected by replace_timeline and nothing changes", rejected.code === "validation_failed" && rejected.details?.issues?.some((i: any) => i.path === `$.assets.${aid}.fps`) && api.info(W, "json").revision === rev0, rejected.details ?? rejected);
  for (const [what, patch, key] of [["a zero fps", { fps: 0 }, "fps"], ["a fractional width", { width: 320.5 }, "width"], ["a negative duration", { duration: -1 }, "duration"],
    ["an unknown kind", { kind: "movie" }, "kind"], ["a string sample rate", { sample_rate: "48000" }, "sample_rate"], ["an unknown asset field", { zoom: 2 }, "zoom"]] as const) {
    const r = await api.apply(W, [{ op: "replace_timeline", timeline: { ...tlj, assets: { [aid]: { ...tlj.assets[aid], ...patch } } } }]).catch((e) => e);
    check(`${what} in the asset record is rejected`, r.code === "validation_failed" && r.details?.issues?.some((i: any) => i.path === `$.assets.${aid}.${key}`), r.details ?? r);
  }
  check("a valid asset record has no asset issues", api.validate(W).valid === true);
  // 2. a project.json edited by hand: validate reports it, prepare refuses before any job is built
  const calls0 = nCalls();
  writeFileSync(file, JSON.stringify({ ...tlj, assets: { [aid]: { ...tlj.assets[aid], fps: "30,more" } } }));
  check("validate reports a non-numeric asset fps in project.json", api.validate(W).valid === false);
  const pe: any = await api.prepare(W).catch((e) => e);
  check("prepare refuses an invalid asset record before any job is built", pe.code === "invalid_timeline" && nCalls() === calls0, { code: pe.code, calls: nCalls() - calls0 });
  const ps: any = (() => { try { return api.prepareStatus(W); } catch (e) { return e; } })();
  check("prepare status refuses the same record", ps.code === "invalid_timeline", ps);
  const rf: any = await api.frame(W, 0.5, { scale: 0.25 }).catch((e) => e);
  check("preview refuses the same record", rf.code === "invalid_timeline", rf);
  writeFileSync(file, good);
  check("the restored project prepares again", (await api.prepare(W)).ready === true);
  // 3. fail closed where the values are built, whatever validate saw
  const code = (f: () => unknown) => { try { f(); return "none"; } catch (e: any) { return e.code; } };
  const base = { srcW: 640, srcH: 360 };
  for (const bad of ["30,more", Number.NaN, Infinity, 0, -5]) {
    check(`matteJob refuses fps ${String(bad)}`, code(() => V.matteJob(join(m, "green.mp4"), { kind: "video", fps: bad as any, duration: 2, ...base })) === "bad_media");
    check(`subjectJob refuses fps ${String(bad)}`, code(() => V.subjectJob(join(m, "green.mp4"), { start: 0, duration: 2, fps: bad as any, ...base })) === "bad_media");
    check(`trackJob refuses fps ${String(bad)}`, code(() => V.trackJob(join(m, "green.mp4"), { start: 0, duration: 2, at: 0, box: [0, 0, 0.1, 0.1], fps: bad as any, ...base })) === "bad_media");
    check(`FrameSource refuses rate ${String(bad)}`, code(() => new FrameSource({ path: join(m, "green.mp4"), kind: "video", ...base, rate: bad as any, fit: "fill", box: [64, 64] })) === "bad_media");
  }
  check("subjectJob refuses a non-numeric start", code(() => V.subjectJob(join(m, "green.mp4"), { start: "1,more" as any, duration: 2, fps: 6, ...base })) === "bad_media");
  check("matteJob keeps null fps for an image and a finite fps for video", V.matteJob(join(m, "still.png"), { kind: "image", fps: null, ...base }).job.fps === null && V.matteJob(join(m, "green.mp4"), { kind: "video", fps: null, duration: 2, ...base }).job.fps === 30);
}

// ---------------------------------------------------------------- matte models are downloaded only on request
console.log("matte models: prepare refuses an uncached model unless allow_download is set");
{
  const gateLog = join(tmp, "gate-runs.jsonl"), gateUv = join(tmp, "gate-uv.mjs");
  // records the job's allow_download and the U2NET_HOME variable only, then hands over to the fake above
  writeFileSync(gateUv, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const job = JSON.parse(process.argv.at(-1));
appendFileSync(${JSON.stringify(gateLog)}, JSON.stringify({ cmd: job.cmd, allow: job.allow_download, home: process.env.U2NET_HOME ?? null, ort: process.env.ORT_DISABLE_TELEMETRY ?? null }) + "\\n");
const r = spawnSync(${JSON.stringify(fake)}, process.argv.slice(2), { encoding: "utf8" });
process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);
`);
  chmodSync(gateUv, 0o755);
  const gateRuns = () => (existsSync(gateLog) ? readFileSync(gateLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as { cmd: string; allow: unknown; home: string | null; ort: string | null }[];
  const MODEL = "u2net_human_seg", cacheRoot = process.env.AGENTCUT_CACHE!, modelDir = join(cacheRoot, "models");
  const G = join(tmp, "gate");
  api.create(G, { preset: "720p" });
  await apply(G, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 2 }, { op: "remove_background", id: "vid1", model: MODEL }]);
  process.env.AGENTCUT_UV = gateUv;
  try {
    const caps = () => (api.capabilities() as any).matte_models as { name: string; approx_mb: number; cached: boolean }[];
    check("capabilities lists the 5 matte models with a size and cached flags", caps()?.length === 5 && caps().every((x) => x.approx_mb === null || x.approx_mb > 0) && caps().filter((x) => x.approx_mb === null).map((x) => x.name).join() === "u2net,isnet-general-use"
      && caps().find((x) => x.name === "u2netp")?.cached === true && caps().find((x) => x.name === MODEL)?.cached === false, caps());
    const st: any = api.prepareStatus(G);
    check("prepare status lists the model that would be downloaded", st.models_to_download?.length === 1 && st.models_to_download[0].model === MODEL && st.models_to_download[0].approx_mb === 176
      && st.models_to_download[0].path === modelFile(MODEL), st);
    const nf: any = await api.prepare(G).catch((e) => e);
    check("uncached model -> model_not_cached naming the model", nf.code === "model_not_cached" && nf.message.includes(MODEL), { code: nf.code, message: nf.message });
    check("  the hint has the size, the cache path and allow_download", nf.hint?.includes("176") && nf.hint.includes(modelFile(MODEL)) && nf.hint.includes("allow_download"), nf.hint);
    check("  the helper never ran and nothing was written to the models dir", gateRuns().length === 0 && !existsSync(join(modelDir, MODEL)), { runs: gateRuns(), listing: existsSync(modelDir) ? readdirSync(modelDir) : null });
    { // a model whose size is not known offline: the text says so and never prints a placeholder
      const U = join(tmp, "gate-unknown");
      api.create(U, { preset: "720p" });
      await apply(U, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 2 }, { op: "remove_background", id: "vid1", model: "isnet-general-use" }]);
      const un: any = await api.prepare(U).catch((e) => e), us: any = api.prepareStatus(U);
      check("uncached model of unknown size: model_not_cached says 'size unknown', never null or undefined, status size is null",
        un.code === "model_not_cached" && un.message.includes("isnet-general-use (size unknown)") && un.hint.includes("size unknown") && !/null|undefined|NaN/.test(un.message + un.hint)
        && us.models_to_download[0]?.approx_mb === null && gateRuns().length === 0, { code: un.code, message: un.message, hint: un.hint, us: us.models_to_download });
    }
    seedModel(MODEL);
    check("cached model: capabilities say so and prepare status lists nothing to download", caps().find((x) => x.name === MODEL)?.cached === true && (api.prepareStatus(G) as any).models_to_download.length === 0);
    process.env.ORT_DISABLE_TELEMETRY = "0"; // an inherited value must not win over the helper's own
    let ok: any;
    try { ok = await api.prepare(G); } finally { delete process.env.ORT_DISABLE_TELEMETRY; }
    const run = gateRuns();
    check("cached model: the gate passes, the helper ran with allow_download false and U2NET_HOME = the user cache (models live in <cache>/models)",
      ok.computed[0]?.kind === "matte" && run.length === 1 && run[0].allow === false && run[0].home === cacheRoot, { ok: ok.ready, run });
    check("the helper is spawned with ORT_DISABLE_TELEMETRY=1, whatever the inherited value", run[0].ort === "1", run);
    rmSync(modelFile(MODEL)); rmSync(join(G, ".agentcut", "cache"), { recursive: true });
    const al: any = await api.prepare(G, { allowDownload: true });
    check("allow_download with the model missing: the gate passes and the helper is told allow_download true", al.computed[0]?.kind === "matte" && gateRuns().length === 2 && gateRuns()[1].allow === true, { al: al.ready, run: gateRuns() });
    check("allow_download is not part of the matte cache key", V.matteJob(join(m, "rb.mp4"), { kind: "video", fps: 30, duration: 2, srcW: 640, srcH: 360, model: MODEL, root: G }).file === al.computed[0].file);

    // the CLI and MCP spellings reach the same gate
    rmSync(join(G, ".agentcut", "cache"), { recursive: true });
    const cli = (...a: string[]) => spawnSync(process.execPath, ["--no-install", join(import.meta.dir, "../src/cli.ts"), "prepare", "-p", G, "--quiet", ...a], { encoding: "utf8", env: { ...process.env } });
    const c1 = cli(), c1j = JSON.parse(c1.stdout || "{}");
    check("CLI prepare without --allow-download: model_not_cached, non-zero exit", c1.status !== 0 && c1j.error?.code === "model_not_cached", { status: c1.status, out: c1.stdout.slice(0, 300) });
    const c2 = cli("--allow-download"), c2j = JSON.parse(c2.stdout || "{}");
    check("CLI prepare --allow-download passes the gate", c2.status === 0 && c2j.ready === true && gateRuns().at(-1)?.allow === true, { status: c2.status, out: c2.stdout.slice(0, 300) });

    // a matte helper that fails: the hint names the model file only when that file exists (rembg does not re-check an existing file)
    {
      const failUv = join(tmp, "fail-uv.mjs");
      writeFileSync(failUv, `#!/usr/bin/env node\nprocess.stderr.write("stub load failure\\n"); process.exit(1);\n`);
      chmodSync(failUv, 0o755);
      const F = join(tmp, "gate-fail");
      api.create(F, { preset: "720p" });
      await apply(F, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 2 }, { op: "remove_background", id: "vid1", model: MODEL }]);
      process.env.AGENTCUT_UV = failUv;
      rmSync(modelFile(MODEL), { force: true });
      const gone: any = await api.prepare(F, { allowDownload: true }).catch((e) => e);
      check("matte helper fails with the model file absent: vision_failed, the hint does not name a damaged file", gone.code === "vision_failed" && !/damaged/.test(gone.hint) && !gone.hint.includes(modelFile(MODEL)), { code: gone.code, hint: gone.hint });
      seedModel(MODEL);
      const bad: any = await api.prepare(F).catch((e) => e);
      check("matte helper fails with the model file present: vision_failed, the hint names the file and allow_download", bad.code === "vision_failed" && bad.hint.includes(modelFile(MODEL)) && bad.hint.includes("if the error is about loading the model, the model file " + modelFile(MODEL) + " may be damaged") && bad.hint.includes("allow_download=true"), { code: bad.code, hint: bad.hint });
      check("  the original hint text is kept", /probe_media/.test(bad.hint), bad.hint);
      process.env.AGENTCUT_UV = gateUv;
    }

    // the helper itself: with allow_download false it points the HTTP clients at an unreachable proxy before importing rembg.
    // The real helper text runs under system python3 against stub numpy / PIL / rembg modules; the stub rembg records the proxy
    // variables it sees when it is imported, so nothing here reaches a network.
    const py = spawnSync("python3", ["-B", "-c", "pass"]);
    if (py.status !== 0) check("python3 available for the helper guard check (skipped: not found)", true);
    else {
      const stubs = join(tmp, "stubs"), run = join(tmp, "stub-run");
      mkdirSync(join(stubs, "PIL"), { recursive: true }); mkdirSync(run);
      writeFileSync(join(stubs, "numpy.py"), "");
      writeFileSync(join(stubs, "PIL", "__init__.py"), "");
      writeFileSync(join(stubs, "PIL", "Image.py"), "");
      writeFileSync(join(stubs, "rembg.py"), `import json, os
open(os.environ["STUB_OUT"], "w").write(json.dumps({k: os.environ.get(k) for k in ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "NO_PROXY", "no_proxy"]}))
def new_session(model): raise SystemExit("stub rembg: " + model)
def remove(*a, **k): raise SystemExit("stub rembg")
`);
      const { VISION_PY } = await import("../src/vision-py.ts");
      const script = join(run, "helper.py");
      writeFileSync(script, VISION_PY);
      // python -I -S (no PYTHON* variables, no user site, no site-packages, no script dir) + only the stub dir on sys.path: the stub rembg is the only rembg; onnxruntime is not findable at all.
      // HOME is set at spawn into the test tmp; the environment is spelled out key by key.
      const boot = "import sys, runpy; sys.path.insert(0, sys.argv[1]); s = sys.argv[2]; sys.argv = sys.argv[2:]; runpy.run_path(s, run_name='__main__')";
      const childEnv = (extra: Record<string, string>) => ({ PATH: process.env.PATH ?? "", HOME: join(run, "home"), ...extra });
      const guarded = (allow: boolean) => {
        const out = join(run, `seen-${allow}.json`);
        const job = JSON.stringify({ cmd: "matte", kind: "image", model: "u2netp", w: 2, h: 2, path: "x", out: join(run, "o.png"), allow_download: allow });
        const r = spawnSync("python3", ["-I", "-S", "-B", "-c", boot, stubs, script, job], { cwd: run, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
          env: childEnv({ STUB_OUT: out, HTTPS_PROXY: "http://allowed.example:3128", HTTP_PROXY: "http://allowed.example:3128", NO_PROXY: "*" }) });
        return { status: r.status, seen: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null, stderr: r.stderr.slice(-200) };
      };
      mkdirSync(join(run, "home"));
      const noStubs = spawnSync("python3", ["-I", "-S", "-B", "-c", "import importlib.util as u; print(u.find_spec('onnxruntime'), u.find_spec('rembg'))"], { cwd: run, encoding: "utf8", env: childEnv({}) });
      check("the helper child cannot find the real onnxruntime or rembg without the stub dir", noStubs.status === 0 && noStubs.stdout.trim() === "None None", { out: noStubs.stdout, err: noStubs.stderr });
      const closed = guarded(false), open = guarded(true);
      const dead = (v: string | null) => typeof v === "string" && /^http:\/\/127\.0\.0\.1:9\/?$/.test(v);
      check("helper, allow_download false: the proxy variables point at an unreachable address and NO_PROXY is cleared when rembg is imported",
        !!closed.seen && ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].every((k) => dead(closed.seen[k])) && !closed.seen.NO_PROXY && !closed.seen.no_proxy, closed);
      check("helper, allow_download true: the proxy variables are left as they were", open.seen?.HTTPS_PROXY === "http://allowed.example:3128" && open.seen?.NO_PROXY === "*", open);
    }
  } finally { process.env.AGENTCUT_UV = fake; }
}

// ---------------------------------------------------------------- missing tool
console.log("missing uv");
process.env.AGENTCUT_UV = join(tmp, "no-such-uv");
await prepFails(P, [{ op: "auto_reframe", id: "vid1", fps: 3 }], "missing_dependency", "no uv -> missing_dependency with install hint (prepare)");
await prepFails(B, [{ op: "remove_background", id: "vid2", model: "u2net" }], "missing_dependency", "no uv (matte) -> missing_dependency (prepare)");
check("core edits still work without uv", (await apply(B, [{ op: "update_clip", id: "vid2", set: { opacity: 0.5 } }]))[0].id === "vid2");

// ---------------------------------------------------------------- real helper (opt-in: downloads opencv/rembg via uv)
if (process.env.AGENTCUT_TEST_VISION === "1") {
  console.log("real helper (uv)");
  delete process.env.AGENTCUT_UV;
  ff("-f", "lavfi", "-i", "color=c=0x203040:s=640x360:r=30:d=3", "-f", "lavfi", "-i", "testsrc2=s=80x80:r=30:d=3",
    "-filter_complex", "[0][1]overlay=x='40+t*130':y=140", "-pix_fmt", "yuv420p", join(m, "mover.mp4"));
  const R = join(tmp, "real");
  api.create(R, { preset: "reels" });
  await apply(R, [{ op: "add_clip", track: "main", src: join(m, "mover.mp4"), duration: 3 }]);
  const res = (await applyPrep(R, [{ op: "auto_reframe", id: "vid1" }]))[0];
  const kx = clip(R, "vid1").keyframes.focus_x;
  check("real: subject found and followed left -> right", res.samples === 18 && kx[0][1] < 0.2 && kx.at(-1)[1] > 0.7, { res, kx });
  await apply(R, [{ op: "add_clip", track: "overlay", type: "shape", shape: "circle", size: [30, 30], fill: "red", at: 0, duration: 3 }]);
  const Q = join(tmp, "real-yt");
  api.create(Q, { preset: "youtube" });
  await apply(Q, [{ op: "add_clip", track: "main", src: join(m, "mover.mp4"), duration: 3 },
    { op: "add_clip", track: "overlay", type: "shape", shape: "circle", size: [30, 30], fill: "red", at: 0, duration: 3 }]);
  const tk = (await applyPrep(Q, [{ op: "track_to", id: "shp1", target: "vid1", box: [120, 420, 240, 240], at: 0 }]))[0];
  const kxs = clip(Q, "shp1").keyframes.x, end = kxs.at(-1);
  check("real: CSRT follows the box (within 25 px)", tk.lost === 0 && near(end[1], (40 + end[0] * 130 + 40) * 3, 25), { tk, end });
  await apply(Q, [{ op: "remove_background", id: "vid1" }]);
  const mt: any = await api.prepare(Q, { allowDownload: true }), again = await V.compute(V.matteJob(join(m, "mover.mp4"), { kind: "video", fps: 30, duration: 3, srcW: 640, srcH: 360, root: Q }));
  check("real: matte produced and cached", existsSync(mt.computed[0].file) && again.cached === true, mt);
}

console.log(`\n${failures ? `✗ ${failures} failure(s)` : "✓ all vision checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
