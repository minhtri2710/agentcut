// AI vision ops: auto_reframe, remove_background, track_to (+ path smoothing, caching, missing-tool errors).
// The Python helper is replaced by a fake `uv` (AGENTCUT_UV) returning known tracks and a real alpha matte, so pixel checks
// are exact and the suite runs offline. AGENTCUT_TEST_VISION=1 also runs the real helper through uv (downloads packages).
// Run: bun tests/vision.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-vision-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
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
const nCalls = (cmd?: string) => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter((l) => l && (!cmd || l === cmd)).length : 0);

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
const clip = (proj: string, id: string) => api.info(proj, "json").timeline.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id);

await apply(P, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4 }]);
const r1 = (await apply(P, [{ op: "auto_reframe", id: "vid1" }]))[0];
const fx = clip(P, "vid1").keyframes?.focus_x;
check("writes focus_x keyframes (9:16 pans horizontally only)", Array.isArray(fx) && fx.length >= 2 && !clip(P, "vid1").keyframes.focus_y, clip(P, "vid1"));
check("focus within 0..1 and moves right", fx && fx.every((k: any) => k[1] >= 0 && k[1] <= 1) && fx.at(-1)[1] > fx[0][1] + 0.5, fx);
// subject 0.1 -> 0.9 of a 3413 px wide cover frame (640x360 into 1080x1920) seen through a 1080 px window
const steps = fx ? fx.slice(1).map((k: any, i: number) => (k[1] - fx[i][1]) / (k[0] - fx[i][0])) : [];
check("smooth: no backwards steps (jitter gone)", steps.every((s: number) => s >= -1e-6), steps);
check("result reports samples, not cached", r1.samples === 24 && r1.cached === false && nCalls("subject") === 1, r1);
const r2 = (await apply(P, [{ op: "auto_reframe", id: "vid1" }]))[0];
check("second run hits the cache (same file+params)", r2.cached === true && nCalls("subject") === 1, r2);
await apply(P, [{ op: "auto_reframe", id: "vid1", fps: 4 }]);
check("other params -> new analysis", nCalls("subject") === 2);

const f0 = await api.frame(P, 0.05, { scale: 0.25, out: join(tmp, "rf0.png") });
const f1 = await api.frame(P, 3.9, { scale: 0.25, out: join(tmp, "rf1.png") });
check("render follows: start shows the left (red) side", isColor(px(f0.image, 135, 240), [255, 0, 0]), px(f0.image, 135, 240));
check("render follows: end shows the right (blue) side", isColor(px(f1.image, 135, 240), [0, 0, 255]), px(f1.image, 135, 240));

const ri = (await apply(P, [{ op: "add_clip", track: "main", src: join(m, "still.png"), duration: 1 }, { op: "auto_reframe", id: "img1" }]))[1];
// subject at 0.8 of 3413 px; window 1080 -> focus = (0.8 * 3413 - 540) / (3413 - 1080)
check("image: one sample -> static focus, no keyframes", ri.samples === 1 && near(clip(P, "img1").focus[0], (0.8 * 3413 - 540) / 2333, 2e-3) && !clip(P, "img1").keyframes, { ri, c: clip(P, "img1") });
await apply(P, [{ op: "remove_clip", id: "img1" }]);
await fails(P, [{ op: "add_clip", track: "main", src: join(m, "empty.mp4"), duration: 1 }, { op: "auto_reframe", id: "vid2" }], "vision_failed", "no decoded frames -> vision_failed");
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
const tr = (await apply(Y, [{ op: "track_to", id: "shp1", target: "vid1", box: [400, 400, 200, 200], at: 1.5, fps: 10 }]))[0];
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

// on a reframed (panning) target the follower must account for the moving crop window
await apply(P, [{ op: "update_clip", id: "vid1", set: { motion: null } }, { op: "auto_reframe", id: "vid1" },
  { op: "add_clip", track: "overlay", type: "shape", shape: "rect", size: [20, 20], fill: "white", at: 0, duration: 4 },
  { op: "track_to", id: "shp1", target: "vid1", box: [500, 900, 100, 100], at: 0 }]);
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
check("matte cached in the project cache dir", rb.cached === false && rb.matte.startsWith(join(B, ".agentcut", "cache")) && existsSync(rb.matte), rb);
const after = await api.frame(B, 1, { scale: 0.5, out: join(tmp, "rb-after.png") });
check("matte: transparent half shows the background", isColor(px(after.image, 40, 180), [0, 255, 0]), px(after.image, 40, 180));
check("matte: opaque half keeps the clip", isColor(px(after.image, 600, 180), [0, 0, 255]), px(after.image, 600, 180));
const mc = nCalls("matte");
const rend: any = await api.render(B, { out: join(tmp, "bg.mp4"), quality: "draft" });
check("render reuses the cached matte", nCalls("matte") === mc && rend.frames === 60, { calls: nCalls("matte"), rend });
rmSync(join(B, ".agentcut", "cache"), { recursive: true });
await api.frame(B, 1, { scale: 0.5, out: join(tmp, "rb-again.png") });
check("deleted cache is rebuilt on the next preview", nCalls("matte") === mc + 1 && readdirSync(join(B, ".agentcut", "cache")).some((f) => f.startsWith("matte-")));
await fails(B, [{ op: "remove_background", id: "vid2", model: "bogus" }], "bad_value", "unknown model -> bad_value");
const off = (await apply(B, [{ op: "remove_background", id: "vid2", off: true }]))[0];
check("off=true removes the field", off.remove_background === false && clip(B, "vid2").remove_background === undefined);
const ex = await api.exportTimeline(B, { out: join(tmp, "x.fcpxml") }).catch((e: any) => e);
await apply(B, [{ op: "remove_background", id: "vid2" }]);
const ex2: any = await api.exportTimeline(B, { out: join(tmp, "x.fcpxml") });
check("interchange export reports background removal as skipped", JSON.stringify(ex2.skipped).includes("background removal") && !JSON.stringify(ex.skipped ?? "").includes("background removal"), ex2.skipped);

// ---------------------------------------------------------------- missing tool
console.log("missing uv");
process.env.AGENTCUT_UV = join(tmp, "no-such-uv");
await fails(P, [{ op: "auto_reframe", id: "vid1", fps: 3 }], "missing_dependency", "no uv -> missing_dependency with install hint");
await fails(B, [{ op: "remove_background", id: "vid2", model: "u2net" }], "missing_dependency", "no uv (matte) -> missing_dependency");
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
  const res = (await apply(R, [{ op: "auto_reframe", id: "vid1" }]))[0];
  const kx = clip(R, "vid1").keyframes.focus_x;
  check("real: subject found and followed left -> right", res.samples === 18 && kx[0][1] < 0.2 && kx.at(-1)[1] > 0.7, { res, kx });
  await apply(R, [{ op: "add_clip", track: "overlay", type: "shape", shape: "circle", size: [30, 30], fill: "red", at: 0, duration: 3 }]);
  const Q = join(tmp, "real-yt");
  api.create(Q, { preset: "youtube" });
  await apply(Q, [{ op: "add_clip", track: "main", src: join(m, "mover.mp4"), duration: 3 },
    { op: "add_clip", track: "overlay", type: "shape", shape: "circle", size: [30, 30], fill: "red", at: 0, duration: 3 }]);
  const tk = (await apply(Q, [{ op: "track_to", id: "shp1", target: "vid1", box: [120, 420, 240, 240], at: 0 }]))[0];
  const kxs = clip(Q, "shp1").keyframes.x, end = kxs.at(-1);
  check("real: CSRT follows the box (within 25 px)", tk.lost === 0 && near(end[1], (40 + end[0] * 130 + 40) * 3, 25), { tk, end });
  const mt = (await apply(Q, [{ op: "remove_background", id: "vid1" }]))[0];
  const again = V.matte(join(m, "mover.mp4"), { kind: "video", fps: 30, srcW: 640, srcH: 360, root: Q });
  check("real: matte produced and cached", existsSync(mt.matte) && again.cached === true, mt);
}

console.log(`\n${failures ? `✗ ${failures} failure(s)` : "✓ all vision checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
