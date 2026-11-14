// AI vision ops: auto_reframe, remove_background, track_to (+ path smoothing, caching, missing-tool errors).
// The Python helper is replaced by a fake `uv` (AGENTCUT_UV) returning known tracks and a real alpha matte, so pixel checks
// are exact and the suite runs offline. AGENTCUT_TEST_VISION=1 also runs the real helper through uv (downloads packages, and the
// models unless AGENTCUT_TEST_VISION_MODELS names a dir laid out as <name>/<name>.onnx to copy into its own cache); with
// AGENTCUT_TEST_VISION_FACE=<image or video with one face> it also checks that the face branch finds it. Without the flag a SKIPPED line lists the rows.
// Run: bun tests/vision.ts [--keep]          (needs ffmpeg on PATH)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync as lstat, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync as symlink, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-vision-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("../src/api.ts");
const V = await import("../src/vision.ts");
const M = await import("../src/model.ts");
const A = await import("../src/anim.ts");

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
if (process.env.FAKE_JOB_LOG) appendFileSync(process.env.FAKE_JOB_LOG, JSON.stringify(job) + "\\n");
const n = job.fps ? Math.max(2, Math.round((job.duration ?? 4) * job.fps)) : 1;
const ts = Array.from({ length: n }, (_, i) => +((job.start ?? 0) + i / (job.fps ?? 6)).toFixed(4));
let out;
if (job.cmd === "subject" && job.path.includes("empty")) out = { samples: [] };
else if (job.cmd === "subject" && process.env.FAKE_SUBJECT) { // a scenario: what the detector reports for every sample
  const sc = process.env.FAKE_SUBJECT, face = (score, faces = 1) => ({ kind: "face", x: 0.5, y: 0.5, w: 0.2, h: 0.3, score, faces });
  out = { samples: ts.map((t, i) => ({ t, ...(sc === "faces" ? face(0.95) : sc === "mixed" ? (i < n / 2 ? face(0.95) : { kind: "saliency", x: 0.5, y: 0.5, score: 0.5 })
    : sc === "low" ? face(i === 2 ? 0.62 : 0.95) : sc === "several" ? face(0.95, i === 1 ? 3 : 1) : sc === "saliency" ? { kind: "saliency", x: 0.5, y: 0.5, score: 0.5 } : { kind: "none", score: 0 }) })) };
}
else if (job.cmd === "subject" && n === 1) out = { samples: [{ t: 0, x: 0.8, y: 0.5, kind: "face", score: 1, faces: 1 }] };
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
const FACE = "face_detection_yunet_2023mar";
for (const name of ["u2netp", "u2net", FACE]) seedModel(name); // the models the suite's mattes and subject analyses use are cached
/** the face model in another user cache dir (an empty file: the fake uv never reads it) */
const seedFaceIn = (cache: string) => { mkdirSync(join(cache, "models", FACE), { recursive: true }); writeFileSync(join(cache, "models", FACE, `${FACE}.onnx`), ""); };
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
async function applyPrep(proj: string, ops: any[], allowDownload = false) {
  const r = await api.apply(proj, ops);
  if (!r.results.some((x: any) => x.pending)) return r.results;
  const pr = await api.prepare(proj, { allowDownload });
  return r.results.map((x: any) => (x.pending ? pr.applied.find((y: any) => y.op === x.op && y.id === x.id) ?? x : x));
}
async function prepFails(proj: string, ops: any[], code: string, name: string, words: string[] = []) {
  await apply(proj, ops);
  try { await api.prepare(proj); check(name, false, "no error"); }
  catch (e: any) { check(name, e.code === code && !!e.hint && words.every((w) => `${e.message} ${e.hint}`.includes(w)), { code: e.code, message: e.message, hint: e.hint }); }
  await api.undo(proj);
}
const clip = async (proj: string, id: string) => (await api.info(proj, "json")).timeline.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id);

await apply(P, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4 }]);
const t1 = performance.now(), a1: any = await api.apply(P, [{ op: "auto_reframe", id: "vid1" }]);
check("apply only records the request (no helper run, pending + hint)", a1.results[0].pending === true && a1.prepare_needed && nCalls() === 0 && (await clip(P, "vid1")).pending?.auto_reframe && !(await clip(P, "vid1")).keyframes, a1);
check("apply stays fast", performance.now() - t1 < 1000, performance.now() - t1);
const nf: any = await api.frame(P, 0.05, { scale: 0.25 }).catch((e) => e);
check("preview before prepare -> not_prepared with prepare hint", nf.code === "not_prepared" && /prepare/.test(nf.hint) && nf.details?.pending?.[0] === "auto_reframe vid1", nf);
check("prepare status lists the missing analysis", (api.prepareStatus(P) as any).missing[0]?.kind === "subject", api.prepareStatus(P));
const prog: number[] = [], pr1: any = await api.prepare(P, { progress: (d, n) => prog.push(d / n) });
const r1 = pr1.applied[0];
check("prepare computes, applies and clears pending (progress reaches 1)", pr1.computed.length === 1 && pr1.computed[0].cached === false && !(await clip(P, "vid1")).pending && prog.at(-1) === 1, { pr1, prog });
const fx = (await clip(P, "vid1")).keyframes?.focus_x;
check("writes focus_x keyframes (9:16 pans horizontally only)", Array.isArray(fx) && fx.length >= 2 && !(await clip(P, "vid1")).keyframes.focus_y, (await clip(P, "vid1")));
// 640x360 into 1080x1920: the cover picture is 3413 px wide, seen through a 1080 px view. The view can centre a point from 540 to 2873 px: focus 0.1582..0.8418
const lo = 540 / 3413, hi = 1 - lo;
check("focus stays in the reachable range and moves right", fx && fx.every((k: any) => k[1] >= lo - 1e-3 && k[1] <= hi + 1e-3) && fx.at(-1)[1] > fx[0][1] + 0.5, fx);
// the subject walks 0.1 -> 0.9 (sample 12 of 24 at 0.1 + 0.8 * 12 / 23): focus is that source point, clamped at both ends
check("focus is the subject's source point (clamped to the reachable range at the ends)", near(fx[0][1], lo, 2e-3) && near(fx.at(-1)[1], hi, 2e-3) && near(A.kfValue(fx, 2), 0.1 + (0.8 * 12) / 23, 0.03), { fx, mid: A.kfValue(fx, 2) });
const steps = fx ? fx.slice(1).map((k: any, i: number) => (k[1] - fx[i][1]) / (k[0] - fx[i][0])) : [];
check("smooth: no backwards steps (jitter gone)", steps.every((s: number) => s >= -1e-6), steps);
check("result reports samples", r1.samples === 24 && nCalls("subject") === 1, r1);
const r2 = (await apply(P, [{ op: "auto_reframe", id: "vid1" }]))[0];
check("cached analysis applies at once in apply_ops (no pending)", !r2.pending && r2.samples === 24 && nCalls("subject") === 1, r2);
check("prepare with nothing pending is a no-op", (await api.prepare(P)).computed.length === 0 && nCalls("subject") === 1);
await applyPrep(P, [{ op: "auto_reframe", id: "vid1", fps: 4 }]);
check("other params -> new analysis", nCalls("subject") === 2);

// analyze_subject with a project fills that project's cache; auto_reframe on a clip covering the same range at the same fps reuses it.
// Without a project it fills the user cache and leaves every project cache alone.
{
  const subjFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("subject-")).sort() : []);
  const userVision = join(process.env.AGENTCUT_CACHE!, "vision"), rbPath = join(m, "rb.mp4"), stillPath = join(m, "still.png");
  const S = join(tmp, "reel-subject"), S2 = join(tmp, "reel-subject-none"), pcache = (root: string) => join(root, ".agentcut", "cache");
  api.create(S, { preset: "reels" });
  api.create(S2, { preset: "reels" });
  await apply(S, [{ op: "add_clip", track: "main", src: stillPath, duration: 2 }, { op: "add_clip", track: "main", src: rbPath }]);
  const u0 = subjFiles(userVision), c0 = nCalls("subject");
  const sv: any = await api.analyze.subject(rbPath, 6, false, S), si: any = await api.analyze.subject(stillPath, undefined, false, S);
  check("project: analyze_subject computes into the project's cache and leaves the user cache alone",
    sv.cached === false && si.cached === false && nCalls("subject") === c0 + 2 && subjFiles(pcache(S)).length === 2 && subjFiles(userVision).join() === u0.join(), { sv: sv.cached, si: si.cached, project: subjFiles(pcache(S)), user: subjFiles(userVision) });
  const rf = await apply(S, [{ op: "auto_reframe", id: "img1" }, { op: "auto_reframe", id: "vid1" }]);
  check("project: auto_reframe on the still and on the whole video at in 0 applies at once, reusing the analyses",
    rf.every((r: any) => !r.pending) && rf[0].samples === 1 && rf[1].samples === sv.samples.length && nCalls("subject") === c0 + 2, { rf, calls: nCalls("subject") - c0 });
  const st: any = api.prepareStatus(S), pp: any = await api.prepare(S);
  check("project: nothing is missing and prepare computes nothing", st.missing.length === 0 && pp.computed.length === 0 && nCalls("subject") === c0 + 2, { st, pp });
  const none: any = await api.analyze.subject(rbPath, 6);
  check("no project: analyze_subject computes into the user cache and creates no project cache",
    none.cached === false && nCalls("subject") === c0 + 3 && subjFiles(userVision).length === u0.length + 1 && !existsSync(pcache(S2)) && subjFiles(pcache(S)).length === 2, { none: none.cached, user: subjFiles(userVision), s2: existsSync(pcache(S2)) });
  const noProj = await api.analyze.subject(rbPath, 6, false, join(tmp, "no-such-project")).catch((e) => e);
  check("a project that does not exist -> no_project, helper not run", noProj.code === "no_project" && nCalls("subject") === c0 + 3, noProj.code);

  // CLI (a child, fake uv): -p, the nearest project.json and no project at all
  const cli = join(import.meta.dir, "../src/cli.ts"), S3 = join(tmp, "reel-subject-cli"), sub = join(S3, "sub"), outside = join(tmp, "outside-any-project");
  api.create(S3, { preset: "reels" });
  mkdirSync(sub);
  mkdirSync(outside);
  const runRaw = (cwd: string, fps: string, envProject: string | undefined, ...a: string[]) => {
    const e: Record<string, string | undefined> = { ...process.env };
    delete e.AGENTCUT_PROJECT;
    if (envProject) e.AGENTCUT_PROJECT = envProject;
    const r = spawnSync(process.execPath, ["--no-install", cli, "subject", rbPath, "--fps", fps, ...a], { cwd, encoding: "utf8", env: e as NodeJS.ProcessEnv });
    return { status: r.status, json: JSON.parse(r.stdout || "{}") };
  };
  const run = (cwd: string, fps: string, ...a: string[]) => runRaw(cwd, fps, undefined, ...a).json;
  const k0 = nCalls("subject"), u1 = subjFiles(userVision), cp = run(outside, "6", "-p", S3);
  check("CLI subject -p <project>: computed into that project's cache, user cache unchanged",
    cp.ok === true && cp.cached === false && nCalls("subject") === k0 + 1 && subjFiles(pcache(S3)).length === 1 && subjFiles(userVision).join() === u1.join(), { cp, project: subjFiles(pcache(S3)) });
  const cn = run(sub, "6");
  check("CLI subject with no -p inside a project folder uses the nearest project.json: same project cache, cached", cn.ok === true && cn.cached === true && nCalls("subject") === k0 + 1, cn);
  // an explicit project that is not one fails closed: no_project, non-zero exit, nothing computed or written
  const bare = join(tmp, "folder-without-project"), u2 = subjFiles(userVision), k1 = nCalls("subject");
  mkdirSync(bare);
  const bp = runRaw(outside, "4", undefined, "-p", bare), be = runRaw(outside, "4", bare);
  check("CLI subject -p <folder without a project> or $AGENTCUT_PROJECT naming one: no_project, non-zero exit, helper not run, nothing written to either cache",
    [bp, be].every((x) => x.status !== 0 && x.json.ok === false && x.json.error?.code === "no_project") && nCalls("subject") === k1 && subjFiles(userVision).join() === u2.join() && !existsSync(pcache(bare)), { bp, be, user: subjFiles(userVision) });
  const cu = run(outside, "5");
  check("CLI subject outside any project: computed into the user cache, no project cache created",
    cu.ok === true && cu.cached === false && nCalls("subject") === k0 + 2 && subjFiles(userVision).length === u1.length + 1 && !existsSync(pcache(outside)) && subjFiles(pcache(S3)).length === 1, { cu, user: subjFiles(userVision) });
}

const f0 = await api.frame(P, 0.05, { scale: 0.25, out: join(tmp, "rf0.png") });
const f1 = await api.frame(P, 3.9, { scale: 0.25, out: join(tmp, "rf1.png") });
check("render follows: start shows the left (red) side", isColor(px(f0.image, 135, 240), [255, 0, 0]), px(f0.image, 135, 240));
check("render follows: end shows the right (blue) side", isColor(px(f1.image, 135, 240), [0, 0, 255]), px(f1.image, 135, 240));

// focus is the source point the view centres on: the red/blue edge sits at source x 0.5 = 1706.5 px of the 3413 px cover picture; the view starts at
// clamp(focus * 3413 - 540, 0, 2333), so the edge lands at 1706.5 - offset px of the 1080 px view (a quarter of that in the 0.25 scale frame)
{
  const F = join(tmp, "focus-pin"), edge = (focus: number) => (1706.5 - Math.min(2333, Math.max(0, focus * 3413 - 540))) / 4;
  api.create(F, { preset: "reels" });
  await apply(F, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4, focus: [0.4, 0.5] }]);
  const side = async (t: number, x: number) => px((await api.frame(F, t, { scale: 0.25, out: join(tmp, `fp-${t}.png`) })).image, x, 240);
  const e0 = edge(0.4); // 220
  check("static focus 0.4: the view centres source x 0.4 (the red/blue edge is 10 px either side of the expected place)", isColor(await side(0.05, Math.round(e0 - 10)), [255, 0, 0]) && isColor(await side(0.05, Math.round(e0 + 10)), [0, 0, 255]), { e0 });
  await apply(F, [{ op: "update_clip", id: "vid1", set: { focus: [0.5, 0.5], keyframes: { focus_x: [[0, 0.4], [4, 0.6]] } } }]);
  const e1 = edge(0.4 + (0.2 * 3.9) / 4); // 54
  check("animated focus 0.4 -> 0.6: the same place at the start", isColor(await side(0.05, Math.round(e0 - 10)), [255, 0, 0]) && isColor(await side(0.05, Math.round(e0 + 10)), [0, 0, 255]), { e0 });
  check("animated focus: at 3.9 s (focus 0.595) the edge has moved to the expected place", isColor(await side(3.9, Math.round(e1 - 10)), [255, 0, 0]) && isColor(await side(3.9, Math.round(e1 + 10)), [0, 0, 255]), { e1 });
}

const ri = (await applyPrep(P, [{ op: "add_clip", track: "main", src: join(m, "still.png"), duration: 1 }, { op: "auto_reframe", id: "img1" }]))[1];
// subject at 0.8 of the 3413 px picture, inside the reachable range [0.1582, 0.8418]: focus = 0.8
check("image: one sample -> static focus, no keyframes", ri.samples === 1 && near((await clip(P, "img1")).focus[0], 0.8, 2e-3) && !(await clip(P, "img1")).keyframes, { ri, c: (await clip(P, "img1")) });
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
await fails(P, [{ op: "update_clip", id: "vid1", set: { filters: [{ type: "hflip" }] } }, { op: "auto_reframe", id: "vid1" }], "unsupported", "auto_reframe on a clip with an hflip filter -> unsupported");
await fails(P, [{ op: "update_clip", id: "vid1", set: { filters: ["vflip"] } }, { op: "auto_reframe", id: "vid1" }], "unsupported", "auto_reframe on a clip with a vflip filter (string form) -> unsupported");
await fails(P, [{ op: "update_clip", id: "vid1", set: { filters: [{ type: "stabilize" }] } }, { op: "auto_reframe", id: "vid1" }], "unsupported", "auto_reframe on a clip with a stabilize filter -> unsupported");
await fails(P, [{ op: "update_clip", id: "vid1", set: { filters: ["stabilize"] } }, { op: "auto_reframe", id: "vid1" }], "unsupported", "auto_reframe on a clip with a stabilize filter (string form) -> unsupported");

// ---------------------------------------------------------------- track_to
console.log("track_to");
await apply(Y, [{ op: "add_clip", track: "overlay", type: "shape", shape: "circle", size: [40, 40], fill: "white", at: 1, duration: 2 }]);
const tr = (await applyPrep(Y, [{ op: "track_to", id: "shp1", target: "vid1", box: [400, 400, 200, 200], at: 1.5, fps: 10 }]))[0];
const sh = (await clip(Y, "shp1"));
await fails(Y, [{ op: "update_clip", id: "vid1", set: { filters: [{ type: "hflip" }] } }, { op: "track_to", id: "shp1", target: "vid1", box: [400, 400, 200, 200], at: 1.5 }], "unsupported", "track_to on a target with an hflip filter -> unsupported");
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
  { op: "track_to", id: "shp1", target: "vid1", box: [500, 900, 100, 100], at: 2 }]);
check("track_to on a pending reframe waits for it", both.results[3].waiting_for === "auto_reframe vid1", both.results[3]);
process.env.FAKE_JOB_LOG = join(tmp, "track-jobs.jsonl");
const pb: any = await api.prepare(P).finally(() => { delete process.env.FAKE_JOB_LOG; });
check("prepare resolves the chain (reframe, then track)", pb.applied.map((x: any) => x.op).join() === "auto_reframe,track_to" && !(await clip(P, "shp1")).pending, pb);
{
  const v = (await clip(P, "vid1")), s = (await clip(P, "shp1"));
  // the view's offset in the 3413 px cover picture for a focus f: clamp(f * 3413 - 540, 0, 2333); the follower's x is the tracked point (u * 3413) minus that offset
  const full = Math.round(640 * (1920 / 360)), off = (T: number) => Math.min(full - 1080, Math.max(0, A.kfValue(v.keyframes.focus_x, T) * full - 1080 / 2));
  for (const T of [1, 3]) {
    const u = 0.25 + (0.5 * T * 15) / 59, want = u * full - off(T), got = A.kfValue(s.keyframes.x, T);
    check(`track_to on a reframed clip subtracts the pan (at ${T} s)`, near(got, want, 3), { got, want });
  }
  // the box drawn at 'at' = 2 s maps to source fractions through the focus at that time: x = (X + offset) / 3413, y = Y / 1920 (the picture fills the height)
  const job = readFileSync(join(tmp, "track-jobs.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((j) => j.cmd === "track");
  const want = [(500 + off(2)) / full, 900 / 1920, 100 / full, 100 / 1920];
  check("track_to maps the box to the source through the focus at 'at'", Array.isArray(job?.box) && want.every((w, i) => near(job.box[i], w, 2e-4)), { box: job?.box, want });
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
check("remove_background only sets the field (pending, no helper run)", rb.pending === true && (await clip(B, "vid2")).remove_background === true && nCalls("matte") === 0, rb);
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
check("off=true removes the field", off.remove_background === false && (await clip(B, "vid2")).remove_background === undefined);
{ // `_matte` has one owner: a hand-set one on a clip without remove_background is not drawn, at any nesting depth
  const mfile = join(B, ".agentcut", "cache", readdirSync(join(B, ".agentcut", "cache")).find((f) => f.startsWith("matte-"))!);
  await apply(B, [{ op: "update_clip", id: "vid2", set: { _matte: { path: mfile, w: 640, h: 360 } } }]);
  const hand = await api.frame(B, 1, { scale: 0.5, out: join(tmp, "rb-hand.png") });
  check("a hand-set _matte on a clip without remove_background is not drawn", isColor(px(hand.image, 40, 180), [255, 0, 0]), px(hand.image, 40, 180));
  const { attachPrepared } = await import("../src/ops-vision.ts");
  const stray = { path: mfile, w: 1, h: 1 };
  const tl: any = structuredClone((await api.info(B, "json")).timeline);
  tl.tracks[0].clips[0].tracks = [{ id: "n", clips: [{ id: "nested", type: "video", asset: tl.tracks[0].clips[0].asset, _matte: stray }] }];
  tl.tracks[0].clips[0].type = "compound";
  tl.tracks[0].clips[0]._matte = stray;
  const got: any = attachPrepared(tl, B);
  check("attachPrepared drops a hand-set _matte on a compound and on a clip nested in it", got.tracks[0].clips[0]._matte === undefined && got.tracks[0].clips[0].tracks[0].clips[0]._matte === undefined);
}
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
check("audio-only: pending reframe recorded", !!(await clip(AO, "vid1")).pending?.auto_reframe);
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
check("export-pending: both clips carry pending requests", !!(await clip(EP, "vid1")).pending?.auto_reframe && !!(await clip(EP, "shp1")).pending?.track_to, [(await clip(EP, "vid1")).pending, (await clip(EP, "shp1")).pending]);
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
  const subjectErr = async (cache: string, fps = 5, seed = true) => {
    const keep = process.env.AGENTCUT_CACHE;
    if (seed) seedFaceIn(cache);
    process.env.AGENTCUT_CACHE = cache;
    try { await api.analyze.subject(join(m, "rb.mp4"), fps); return undefined; } catch (e: any) { return e; } finally { process.env.AGENTCUT_CACHE = keep; }
  };
  const subject = async (cache: string, fps = 5, seed = true) => (await subjectErr(cache, fps, seed) as any)?.code ?? "ok";
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
      const n = runs().length, err: any = await subjectErr(cache, 5, false), code = err?.code;
      check(`${name}: refused with unsafe_helper_dir, uv not run, nothing written`, code === "unsafe_helper_dir" && runs().length === n && watch.every((d) => !existsSync(d) || readdirSync(d).length === 0), { code, ran: runs().length - n });
      return err?.hint as string | undefined;
    };
    if (posix) {
      // each cause has its own hint, and applying it makes the next run pass (the not-owned-by-you cause needs another user, so no row builds it)
      const cSym = fresh("c-symlink"), elsewhere = fresh("elsewhere"), symRoot = join(realpathSync(cSym), "helper-runs");
      symlinkSync(elsewhere, join(cSym, "helper-runs"));
      const symHint = await refused("helper-runs is a symlink", cSym, [elsewhere]);
      check("helper-runs is a symlink: the hint is to remove the link (no chmod), and doing so makes the next run pass", symHint?.includes(`(rm ${symRoot})`) === true && !symHint.includes("chmod")
        && spawnSync("rm", [symRoot]).status === 0 && await subject(cSym) === "ok" && readdirSync(elsewhere).length === 0, { hint: symHint });
      const cMode = fresh("c-mode"), modeRoot = join(realpathSync(cMode), "helper-runs");
      mkdirSync(join(cMode, "helper-runs"));
      chmod(join(cMode, "helper-runs"), 0o755);
      const modeHint = await refused("helper-runs has mode 0755", cMode, [join(cMode, "helper-runs")]);
      check("helper-runs with mode 0755: the hint is chmod 700 on it, and running it makes the next run pass", modeHint?.endsWith(`with: chmod 700 ${modeRoot}`) === true
        && spawnSync("chmod", ["700", modeRoot]).status === 0 && await subject(cMode) === "ok", { hint: modeHint });
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
      const inHome = (h = home, seed = false) => {
        if (seed) seedFaceIn(join(h, ".cache", "agentcut"));
        const e: Record<string, string | undefined> = { ...process.env, HOME: h, AGENTCUT_UV: rec };
        delete e.AGENTCUT_CACHE;
        return JSON.parse(spawnSync(process.execPath, [cli, "subject", join(m, "rb.mp4"), "--fps", "7"], { encoding: "utf8", env: e as NodeJS.ProcessEnv }).stdout || "{}");
      };
      chmod(home, 0o775);
      const nHome = runs().length, okHome = inHome(home, true), rh = runs().at(-1)!;
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

      // under umask 002 (a child: the umask is set at spawn, never in this process) the font-family cache creates the user cache dir first;
      // a later vision run must still accept it, and a group-writable dir that already exists is refused with a hint that says how to fix it
      const um = fresh("umask"), umCache = join(um, "agentcut"), umHome = fresh("umask-home"), umScript = join(tmp, "umask-child.ts"), src = (f: string) => join(import.meta.dir, "../src", f);
      writeFileSync(umScript, `import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [cache, media, face, canvas, fonts, api] = JSON.parse(process.argv[2]);
process.umask(0o002);
await (await import(canvas)).loadCanvas();
(await import(fonts)).fontsKnown();               // writes <cache>/font-families.json, creating <cache>
mkdirSync(join(cache, "models", face), { recursive: true }); writeFileSync(join(cache, "models", face, face + ".onnx"), "");
const a = await import(api), run = async (fps) => { try { await a.analyze.subject(media, fps); return {}; } catch (e) { return { code: e.code, hint: e.hint }; } };
const first = await run(5), mode = statSync(cache).mode & 0o777;
chmodSync(cache, 0o775);
const loose = await run(7);
process.stdout.write(JSON.stringify({ first, mode, loose }));
`);
      const nUm = runs().length;
      const ur = spawnSync(process.execPath, ["--no-install", umScript, JSON.stringify([umCache, join(m, "rb.mp4"), FACE, src("canvas.ts"), src("fonts.ts"), src("api.ts")])],
        { encoding: "utf8", env: { ...process.env, HOME: umHome, AGENTCUT_CACHE: umCache, AGENTCUT_UV: rec } as NodeJS.ProcessEnv });
      const uj = JSON.parse(ur.stdout || "{}");
      check("umask 002: the font cache creates the user cache dir private (0700) and the vision run is accepted", uj.mode === 0o700 && uj.first && !uj.first.code && runs().length === nUm + 1, { uj, status: ur.status, err: ur.stderr.slice(-300) });
      check("umask 002: an existing group-writable cache dir is still refused, and the hint says how to make it private", uj.loose?.code === "unsafe_helper_dir" && /chmod go-w /.test(uj.loose.hint) && uj.loose.hint.includes(umCache) && runs().length === nUm + 1, uj.loose);
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
  const rev0 = (await api.info(W, "json")).revision;
  // 1. validate types the asset record; apply and replace_timeline reject the batch and change nothing
  const badFps = { ...tlj, assets: { [aid]: { ...tlj.assets[aid], fps: "30,more" } } };
  const rejected = await api.apply(W, [{ op: "replace_timeline", timeline: badFps }]).catch((e) => e);
  check("a non-numeric asset fps is rejected by replace_timeline and nothing changes", rejected.code === "validation_failed" && rejected.details?.issues?.some((i: any) => i.path === `$.assets.${aid}.fps`) && (await api.info(W, "json")).revision === rev0, rejected.details ?? rejected);
  for (const [what, patch, key] of [["a zero fps", { fps: 0 }, "fps"], ["a fractional width", { width: 320.5 }, "width"], ["a negative duration", { duration: -1 }, "duration"],
    ["an unknown kind", { kind: "movie" }, "kind"], ["a string sample rate", { sample_rate: "48000" }, "sample_rate"], ["an unknown asset field", { zoom: 2 }, "zoom"]] as const) {
    const r = await api.apply(W, [{ op: "replace_timeline", timeline: { ...tlj, assets: { [aid]: { ...tlj.assets[aid], ...patch } } } }]).catch((e) => e);
    check(`${what} in the asset record is rejected`, r.code === "validation_failed" && r.details?.issues?.some((i: any) => i.path === `$.assets.${aid}.${key}`), r.details ?? r);
  }
  check("a valid asset record has no asset issues", (await api.validate(W)).valid === true);
  // 2. a project.json edited by hand: validate reports it, prepare refuses before any job is built
  const calls0 = nCalls();
  writeFileSync(file, JSON.stringify({ ...tlj, assets: { [aid]: { ...tlj.assets[aid], fps: "30,more" } } }));
  check("validate reports a non-numeric asset fps in project.json", (await api.validate(W)).valid === false);
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
  // records whether the job holds allow_download, its model_sha256 and the U2NET_HOME variable only, then hands over to the fake above
  writeFileSync(gateUv, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const job = JSON.parse(process.argv.at(-1));
appendFileSync(${JSON.stringify(gateLog)}, JSON.stringify({ cmd: job.cmd, hasAllow: "allow_download" in job, sha: job.model_sha256 ?? null, home: process.env.U2NET_HOME ?? null, ort: process.env.ORT_DISABLE_TELEMETRY ?? null }) + "\\n");
const r = spawnSync(${JSON.stringify(fake)}, process.argv.slice(2), { encoding: "utf8" });
process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);
`);
  chmodSync(gateUv, 0o755);
  const gateRuns = () => (existsSync(gateLog) ? readFileSync(gateLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as { cmd: string; hasAllow: boolean; sha: string | null; home: string | null; ort: string | null }[];
  const MODEL = "u2net_human_seg", cacheRoot = process.env.AGENTCUT_CACHE!, modelDir = join(cacheRoot, "models");
  const G = join(tmp, "gate");
  api.create(G, { preset: "720p" });
  await apply(G, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 2 }, { op: "remove_background", id: "vid1", model: MODEL }]);
  process.env.AGENTCUT_UV = gateUv;
  try {
    const caps = () => (api.capabilities() as any).matte_models as { name: string; approx_mb: number; cached: boolean }[];
    check("capabilities lists the 5 matte models with their size in whole MB and cached flags", caps()?.map((x) => `${x.name}:${x.approx_mb}`).join() === "u2netp:5,u2net:176,u2net_human_seg:176,isnet-general-use:179,silueta:44"
      && caps().find((x) => x.name === "u2netp")?.cached === true && caps().find((x) => x.name === MODEL)?.cached === false, caps());
    const st: any = api.prepareStatus(G);
    check("prepare status lists the model that would be downloaded", st.models_to_download?.length === 1 && st.models_to_download[0].model === MODEL && st.models_to_download[0].approx_mb === 176
      && st.models_to_download[0].path === modelFile(MODEL), st);
    const nf: any = await api.prepare(G).catch((e) => e);
    check("uncached model -> model_not_cached naming the model", nf.code === "model_not_cached" && nf.message.includes(MODEL), { code: nf.code, message: nf.message });
    check("  the hint has the size, the cache path and allow_download", nf.hint?.includes("176") && nf.hint.includes(modelFile(MODEL)) && nf.hint.includes("allow_download"), nf.hint);
    check("  the helper never ran and nothing was written to the models dir", gateRuns().length === 0 && !existsSync(join(modelDir, MODEL)), { runs: gateRuns(), listing: existsSync(modelDir) ? readdirSync(modelDir) : null });
    { // every matte model has a size: the text is whole MB, never a placeholder
      const U = join(tmp, "gate-size");
      api.create(U, { preset: "720p" });
      await apply(U, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 2 }, { op: "remove_background", id: "vid1", model: "isnet-general-use" }]);
      const un: any = await api.prepare(U).catch((e) => e), us: any = api.prepareStatus(U);
      check("uncached isnet-general-use: model_not_cached says '~179 MB', the status size is 179", un.code === "model_not_cached" && un.message.includes("isnet-general-use (~179 MB)") && un.hint.includes("~179 MB")
        && !/null|undefined|NaN/.test(un.message + un.hint) && us.models_to_download[0]?.approx_mb === 179 && gateRuns().length === 0, { code: un.code, message: un.message, hint: un.hint, us: us.models_to_download });
    }
    seedModel(MODEL);
    check("cached model: capabilities say so and prepare status lists nothing to download", caps().find((x) => x.name === MODEL)?.cached === true && (api.prepareStatus(G) as any).models_to_download.length === 0);
    process.env.ORT_DISABLE_TELEMETRY = "0"; // an inherited value must not win over the helper's own
    let ok: any;
    try { ok = await api.prepare(G); } finally { delete process.env.ORT_DISABLE_TELEMETRY; }
    const run = gateRuns();
    check("cached model: the gate passes, the helper ran with the model's sha256, no allow_download, and U2NET_HOME = the user cache (models live in <cache>/models)",
      ok.computed[0]?.kind === "matte" && run.length === 1 && run[0].hasAllow === false && run[0].sha === M.MATTE_PINS[MODEL].sha256 && run[0].home === cacheRoot, { ok: ok.ready, run });
    check("the helper is spawned with ORT_DISABLE_TELEMETRY=1, whatever the inherited value", run[0].ort === "1", run);
    rmSync(modelFile(MODEL)); rmSync(join(G, ".agentcut", "cache"), { recursive: true });
    // the download is stubbed (no network): this row's pin is a small body, restored below
    const pin = M.MATTE_PINS[MODEL], pinned = { ...pin }, body = Buffer.from("not a real model: a small body for the allow_download row"), realFetch = globalThis.fetch, asked: string[] = [];
    const bodySha = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
    Object.assign(pin, { sha256: bodySha, bytes: body.length });
    globalThis.fetch = (async (u: any) => { asked.push(String(u)); return new Response(body); }) as typeof fetch;
    let al: any;
    try { al = await api.prepare(G, { allowDownload: true }); } finally { globalThis.fetch = realFetch; Object.assign(pin, pinned); }
    check("allow_download with the model missing: AgentCut fetches and verifies it, then the helper runs on the verified file with its sha256 and no allow_download",
      al.computed[0]?.kind === "matte" && asked.join() === pinned.url && readFileSync(modelFile(MODEL)).equals(body) && gateRuns().length === 2 && gateRuns()[1].hasAllow === false && gateRuns()[1].sha === bodySha, { al: al.ready, asked, run: gateRuns() });
    check("allow_download is not part of the matte cache key", V.matteJob(join(m, "rb.mp4"), { kind: "video", fps: 30, duration: 2, srcW: 640, srcH: 360, model: MODEL, root: G }).file === al.computed[0].file);

    // the CLI spelling reaches the same gate; its child runs with a stub fetch loaded by --preload (the test's own file): it records the URL and answers 404
    rmSync(join(G, ".agentcut", "cache"), { recursive: true }); rmSync(modelFile(MODEL));
    const cliFetchLog = join(tmp, "gate-cli-fetch.log"), cliFetchStub = join(tmp, "gate-cli-fetch-stub.ts");
    writeFileSync(cliFetchStub, `import { appendFileSync } from "node:fs";\nglobalThis.fetch = (async (u: unknown) => { appendFileSync(${JSON.stringify(cliFetchLog)}, String(u) + "\\n"); return new Response("no", { status: 404 }); }) as typeof fetch;\n`);
    const cli = (...a: string[]) => spawnSync(process.execPath, ["--no-install", "--preload", cliFetchStub, join(import.meta.dir, "../src/cli.ts"), "prepare", "-p", G, "--quiet", ...a], { encoding: "utf8", env: { ...process.env } });
    const c1 = cli(), c1j = JSON.parse(c1.stdout || "{}");
    check("CLI prepare without --allow-download: model_not_cached, non-zero exit", c1.status !== 0 && c1j.error?.code === "model_not_cached", { status: c1.status, out: c1.stdout.slice(0, 300) });
    const c2 = cli("--allow-download"), c2j = JSON.parse(c2.stdout || "{}");
    check("CLI prepare --allow-download passes the gate and reaches the model download (stub answers 404 -> model_download_failed), the helper not started",
      c2.status !== 0 && c2j.error?.code === "model_download_failed" && existsSync(cliFetchLog) && readFileSync(cliFetchLog, "utf8").trim() === pinned.url && gateRuns().length === 2, { status: c2.status, out: c2.stdout.slice(0, 300), runs: gateRuns().length });

    // a matte helper that fails with the model file present: the hint names it
    {
      const failUv = join(tmp, "fail-uv.mjs");
      writeFileSync(failUv, `#!/usr/bin/env node\nprocess.stderr.write("stub load failure\\n"); process.exit(1);\n`);
      chmodSync(failUv, 0o755);
      const F = join(tmp, "gate-fail");
      api.create(F, { preset: "720p" });
      await apply(F, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 2 }, { op: "remove_background", id: "vid1", model: MODEL }]);
      process.env.AGENTCUT_UV = failUv;
      seedModel(MODEL);
      const bad: any = await api.prepare(F).catch((e) => e);
      check("matte helper fails with the model file present: vision_failed, the hint names the file and allow_download", bad.code === "vision_failed" && bad.hint.includes(modelFile(MODEL)) && bad.hint.includes("if the error is about loading the model, the model file " + modelFile(MODEL) + " may be damaged") && bad.hint.includes("allow_download=true"), { code: bad.code, hint: bad.hint });
      check("  the original hint text is kept", /probe_media/.test(bad.hint), bad.hint);
      process.env.AGENTCUT_UV = gateUv;
    }

    // the helper itself: it points the HTTP clients at an unreachable proxy before importing rembg, whatever the job holds.
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
      const guarded = () => {
        const out = join(run, "seen-proxy.json");
        const job = JSON.stringify({ cmd: "matte", kind: "image", model: "u2netp", w: 2, h: 2, path: "x", out: join(run, "o.png"), allow_download: true });
        const r = spawnSync("python3", ["-I", "-S", "-B", "-c", boot, stubs, script, job], { cwd: run, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
          env: childEnv({ STUB_OUT: out, HTTPS_PROXY: "http://allowed.example:3128", HTTP_PROXY: "http://allowed.example:3128", NO_PROXY: "*" }) });
        return { status: r.status, seen: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null, stderr: r.stderr.slice(-200) };
      };
      mkdirSync(join(run, "home"));
      const noStubs = spawnSync("python3", ["-I", "-S", "-B", "-c", "import importlib.util as u; print(u.find_spec('onnxruntime'), u.find_spec('rembg'))"], { cwd: run, encoding: "utf8", env: childEnv({}) });
      check("the helper child cannot find the real onnxruntime or rembg without the stub dir", noStubs.status === 0 && noStubs.stdout.trim() === "None None", { out: noStubs.stdout, err: noStubs.stderr });
      const closed = guarded();
      const dead = (v: string | null) => typeof v === "string" && /^http:\/\/127\.0\.0\.1:9\/?$/.test(v);
      check("helper: the proxy variables point at an unreachable address and NO_PROXY is cleared when rembg is imported, whatever the environment says",
        !!closed.seen && ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].every((k) => dead(closed.seen[k])) && !closed.seen.NO_PROXY && !closed.seen.no_proxy, closed);

      { // a pinned model is hashed where the helper loads it: the right bytes reach the stub loader, other bytes are refused before it
        const { createHash } = await import("node:crypto");
        writeFileSync(join(stubs, "cv2.py"), "class FaceDetectorYN:\n  @staticmethod\n  def create(*a): raise SystemExit('stub yunet')\n");
        const fixture = join(run, "fixture.onnx"), sha = (b: string) => createHash("sha256").update(b).digest("hex");
        writeFileSync(fixture, "small model fixture");
        const load = (job: Record<string, unknown>) => spawnSync("python3", ["-I", "-S", "-B", "-c", boot, stubs, script, JSON.stringify(job)], { cwd: run, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: childEnv({ STUB_OUT: join(run, "seen-load.json") }) });
        const matteJob = (extra: Record<string, unknown>) => ({ cmd: "matte", kind: "image", model: "u2netp", w: 2, h: 2, path: "x", out: join(run, "o.png"), model_file: fixture, ...extra });
        const subjectJob = (extra: Record<string, unknown>) => ({ cmd: "subject", w: 2, h: 2, fps: 1, face_min: 0.6, path: "x", face_model: fixture, ...extra });
        const refused = (r: { status: number | null; stderr: string }, stub: string) => r.status !== 0 && /does not match its pinned sha256/.test(r.stderr) && !r.stderr.includes(stub);
        const reached = (r: { stderr: string }, stub: string) => r.stderr.includes(stub) && !/does not match/.test(r.stderr);
        const okSha = sha("small model fixture"), badSha = sha("other bytes");
        check("helper, matte: a model file with the job's sha256 reaches the loader; other bytes are refused before it", reached(load(matteJob({ model_sha256: okSha })), "stub rembg: u2netp") && refused(load(matteJob({ model_sha256: badSha })), "stub rembg"));
        const noSha = [load(matteJob({})), load(subjectJob({}))];
        check("helper: a matte job and a subject job with no sha256 are refused before the loader", noSha.every((r) => r.status !== 0 && /no sha256/.test(r.stderr) && !/stub (rembg|yunet)/.test(r.stderr)), noSha.map((r) => r.stderr.slice(-200)));
        check("helper, subject: the face model with the job's sha256 reaches the detector; other bytes are refused before it", reached(load(subjectJob({ model_sha256: okSha })), "stub yunet") && refused(load(subjectJob({ model_sha256: badSha })), "stub yunet"));
        writeFileSync(join(stubs, "cv2.py"), "");
      }

      // the decoder child: a fake ffmpeg (a shell script first on PATH) and a stub numpy; the `track` command reads every frame with the real helper text
      writeFileSync(join(stubs, "numpy.py"), "uint8 = 0\nclass _A:\n  def __init__(s, b): s.b = b\n  def reshape(s, *a): return s\ndef frombuffer(b, t): return _A(b)\n");
      writeFileSync(join(stubs, "cv2.py"), "");
      const bin = join(tmp, "fake-ffmpeg-bin");
      mkdirSync(bin);
      const fakeFfmpeg = (body: string) => { writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, "ffmpeg"), 0o755); };
      const decode = (timeout: number) => {
        const job = JSON.stringify({ cmd: "track", path: "x", w: 2, h: 2, fps: 1, start: 0, duration: 2, at: 0, box: [0, 0, 0.5, 0.5] });
        const r = spawnSync("python3", ["-I", "-S", "-B", "-c", boot, stubs, script, job], { cwd: run, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout,
          env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: join(run, "home") } });
        return { status: r.status, signal: r.signal, stderr: r.stderr.slice(-300) };
      };
      // a decoder that dies with no error text after two frames (2x2 bgr24 = 12 bytes a frame)
      fakeFfmpeg("head -c 24 /dev/zero; exit 1");
      const silent = decode(20_000);
      check("helper: a decoder that exits non-zero with empty stderr fails the run (no short result)", silent.status !== 0 && silent.signal === null && /ffmpeg exited 1/.test(silent.stderr), silent);
      // a decoder that writes far more than a pipe holds to stderr before it writes any frame
      fakeFfmpeg("yes x | head -c 400000 >&2; exit 0");
      const flood = decode(8_000);
      check("helper: a decoder that fills stderr does not block the run (finishes, no timeout)", flood.signal === null && flood.status !== null && /no frames decoded/.test(flood.stderr), flood);

      // stdin closed while a decode and an encode are in flight: the helper stops both ffmpeg children before it exits, so the
      // encoder cannot finish writing `out` afterwards. The fake decoder never writes a frame; the fake encoder writes `out` one second after its stdin ends.
      writeFileSync(join(stubs, "rembg.py"), "def new_session(model): return None\ndef remove(*a, **k): raise SystemExit('stub rembg')\n");
      const pids = join(run, "children.pids"), late = join(run, "late.mov");
      fakeFfmpeg(`echo $$ >> ${JSON.stringify(pids)}\ncase " $* " in *" pipe:0 "*) cat >/dev/null; sleep 1; for a; do o=$a; done; echo late > "$o";; *) exec sleep 30;; esac`);
      const unused = join(run, "unused.onnx");
      writeFileSync(unused, "small model fixture");
      const matteJob = JSON.stringify({ cmd: "matte", kind: "video", model: "u2netp", w: 2, h: 2, fps: 1, path: "x", out: late, model_file: unused, model_sha256: (await import("node:crypto")).createHash("sha256").update("small model fixture").digest("hex") });
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const kids = () => (existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : []);
      const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      for (const how of ["stdin closed", "SIGTERM"] as const) {
        rmSync(pids, { force: true }); rmSync(late, { force: true });
        const h = spawn("python3", ["-I", "-S", "-B", "-c", boot, stubs, script, matteJob], { cwd: run, stdio: ["pipe", "ignore", "ignore"], env: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: join(run, "home") } });
        const exited = new Promise<number | null>((res) => h.on("exit", (c) => res(c)));
        try {
          for (let i = 0; i < 200 && kids().length < 2; i++) await pause(50);
          const started = kids().length;
          if (how === "SIGTERM") h.kill("SIGTERM"); else h.stdin!.end();
          const code = await Promise.race([exited, pause(10_000).then(() => "timeout" as const)]);
          for (let i = 0; i < 60 && kids().some(isAlive); i++) await pause(50);
          await pause(1500); // longer than the fake encoder's delay
          check(`helper: ${how} during a decode and an encode: both ffmpeg children are gone and no output is written afterwards`,
            started === 2 && code !== "timeout" && !kids().some(isAlive) && !existsSync(late), { started, code, alive: kids().filter(isAlive), late: existsSync(late) });
        } finally { for (const pid of kids()) if (isAlive(pid)) process.kill(pid, "SIGKILL"); if (h.exitCode === null) h.kill("SIGKILL"); }
      }
    }
  } finally { process.env.AGENTCUT_UV = fake; }
}

// ---------------------------------------------------------------- the face model and what a subject result says it followed
console.log("subject results: what was followed");
{
  const face = (score: number, faces = 1) => ({ t: 0, x: 0.5, y: 0.5, w: 0.2, h: 0.3, kind: "face", score, faces });
  const sal = { t: 0, x: 0.5, y: 0.5, kind: "saliency", score: 0.5 }, none = { t: 0, kind: "none", score: 0 };
  const WARN = {
    saliency: "no face found: followed the most salient region; check the framing with preview_frame and set focus by hand if it is wrong",
    none: "nothing to follow was found: the focus stays at the centre",
    mixed: (k: number, n: number) => `a face was found in ${k} of ${n} samples; the others follow the most salient region`,
    low: (s: number) => `lowest face confidence ${s} (under 0.9): it may not be a face; check with preview_frame`,
    several: (n: number) => `up to ${n} faces in frame: following the largest`,
  };
  const shape = (subject: string, warnings: string[]) => JSON.stringify(warnings.length ? { subject, warnings } : { subject });
  const attempt = (f: () => unknown) => { try { return f(); } catch (e: any) { return { threw: String(e.message ?? e) }; } };
  for (const [name, samples, subject, warnings] of [
    ["faces at or above 0.9", [face(0.9), face(0.97)], "face", []],
    ["no face, saliency (and an empty sample)", [sal, sal, none], "saliency", [WARN.saliency]],
    ["some faces, the rest saliency", [face(0.95), sal, sal, face(0.95)], "mixed", [WARN.mixed(2, 4)]],
    ["faces and an empty sample", [face(0.95), none], "mixed", ["a face was found in 1 of 2 samples; 0 follow the most salient region and 1 found nothing to follow"]],
    ["a face, one saliency and an empty sample (singular)", [face(0.95), sal, none], "mixed", ["a face was found in 1 of 3 samples; 1 follows the most salient region and 1 found nothing to follow"]],
    ["a face under 0.9", [face(0.95), face(0.62), face(0.7)], "face", [WARN.low(0.62)]],
    ["several faces in a frame", [face(0.95), face(0.95, 3), face(0.95, 2)], "face", [WARN.several(3)]],
    ["only empty samples", [none, none], "none", [WARN.none]],
    ["mixed with a weak face and several faces", [face(0.5, 2), sal], "mixed", [WARN.mixed(1, 2), WARN.low(0.5), WARN.several(2)]],
  ] as [string, any[], string, string[]][])
    check(`subjectSummary: ${name} -> ${subject}${warnings.length ? ` + ${warnings.length} warning(s)` : ", no warnings"}`, JSON.stringify(attempt(() => V.subjectSummary(samples))) === shape(subject, warnings), attempt(() => V.subjectSummary(samples)));

  // the same summary in the three results that carry it (the fake detector reports the scenario for every sample)
  const S = join(tmp, "summary-reel"), T = join(tmp, "summary-yt");
  api.create(S, { preset: "reels" });
  api.create(T, { preset: "youtube" });
  await apply(S, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4 }]);
  await apply(T, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4 }, { op: "add_clip", track: "overlay", type: "shape", shape: "circle", size: [40, 40], fill: "white", at: 0, duration: 4 }]);
  try {
    // fps 2.5 over 4 s = 10 samples; each scenario has its own fps, so no result is read from another one's cache
    for (const [sc, fps, subject, warnings] of [
      ["faces", 1.5, "face", []], ["saliency", 2, "saliency", [WARN.saliency]], ["mixed", 2.5, "mixed", [WARN.mixed(5, 10)]],
      ["low", 3.5, "face", [WARN.low(0.62)]], ["several", 4.5, "face", [WARN.several(3)]], ["none", 5.5, "none", [WARN.none]],
    ] as [string, number, string, string[]][]) {
      process.env.FAKE_SUBJECT = sc;
      const a: any = await api.analyze.subject(join(m, "rb.mp4"), fps).catch((e) => e);
      const r: any = (await applyPrep(S, [{ op: "auto_reframe", id: "vid1", fps }]).catch((e) => [e]))[0];
      delete process.env.FAKE_SUBJECT;
      check(`${sc}: analyze_subject says ${subject}${warnings.length ? " with its warning" : " without warnings"}`, shape(a.subject, a.warnings ?? []) === shape(subject, warnings) && a.samples?.length === Math.round(4 * fps) && "cached" in a && a.fps === fps, a);
      check(`${sc}: auto_reframe says the same, counts its samples and its face samples (not "faces")`, shape(r.subject, r.warnings ?? []) === shape(subject, warnings) && r.samples === a.samples?.length && r.face_samples === (subject === "face" ? r.samples : subject === "mixed" ? r.samples / 2 : 0) && !("faces" in r) && r.id === "vid1", r);
    }
    process.env.FAKE_SUBJECT = "mixed";
    const tt: any = (await applyPrep(T, [{ op: "track_to", id: "shp1", target: "vid1", fps: 4 }]).catch((e) => [e]))[0];
    delete process.env.FAKE_SUBJECT;
    check("track_to without a box says what it followed", shape(tt.subject, tt.warnings ?? []) === shape("mixed", [WARN.mixed(8, 16)]) && tt.target === "vid1" && tt.attached_to === "vid1", tt);
    // the summary covers the samples inside the follower's overlap only (the cached analysis spans 0..4 s: samples 0..7 are faces, 8..15 saliency, 4 per second)
    const dot = (id: string, at: number) => ({ op: "add_clip", track: "overlay", type: "shape", shape: "circle", size: [40, 40], fill: "white", at, duration: 1, id });
    for (const [id, at, subject, warnings] of [
      ["shp2", 3, "saliency", [WARN.saliency]], ["shp3", 0, "face", []], ["shp4", 1.5, "mixed", [WARN.mixed(2, 5)]],
    ] as [string, number, string, string[]][]) {
      process.env.FAKE_SUBJECT = "mixed";
      const o: any = (await applyPrep(T, [dot(id, at), { op: "track_to", id, target: "vid1", fps: 4 }]).catch((e) => [e]))[1];
      delete process.env.FAKE_SUBJECT;
      check(`track_to without a box over ${at}-${at + 1} s: the summary describes the samples it followed (${subject})`, shape(o.subject, o.warnings ?? []) === shape(subject, warnings) && o.attached_to === "vid1", o);
    }
    const tb: any = (await applyPrep(T, [{ op: "track_to", id: "shp1", target: "vid1", box: [400, 400, 200, 200], at: 1, fps: 10 }]).catch((e) => [e]))[0];
    check("track_to with a box has no subject fields", tb.subject === undefined && tb.warnings === undefined && tb.attached_to === "vid1", tb);
  } finally { delete process.env.FAKE_SUBJECT; }
}

console.log("the face model: descriptor, job, gate, download");
{
  const { createHash } = await import("node:crypto");
  const { createServer } = await import("node:http");
  const { basename } = await import("node:path");
  const { FACE_MODEL } = V;
  check("the face model is pinned: a name, an https URL at a full commit, a sha256 and a size",
    FACE_MODEL?.name === FACE && /^https:\/\/.*\/[0-9a-f]{40}\/.*\.onnx$/.test(FACE_MODEL?.url ?? "") && FACE_MODEL?.sha256 === "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4" && FACE_MODEL?.bytes === 232589, FACE_MODEL);
  const mainCache = process.env.AGENTCUT_CACHE!, jobsLog = join(tmp, "subject-jobs.jsonl");
  const jobs = () => (existsSync(jobsLog) ? readFileSync(jobsLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as Record<string, any>[];
  const inCache = async <T>(cache: string, f: () => T | Promise<T>): Promise<T> => {
    process.env.AGENTCUT_CACHE = cache;
    try { return await f(); } finally { process.env.AGENTCUT_CACHE = mainCache; }
  };
  const fresh = (name: string) => { const d = join(tmp, `fm-${name}`); mkdirSync(d, { recursive: true }); return d; };
  const faceFile = (cache: string) => join(cache, "models", FACE, `${FACE}.onnx`);
  const caught = async (f: () => unknown) => { try { await f(); return null as any; } catch (e: any) { return e; } };
  process.env.FAKE_JOB_LOG = jobsLog;
  try {
    // 2. the job hands the cached model's absolute path to the helper; the cache key does not contain it
    const before = jobs().length, rb = join(m, "rb.mp4");
    const sub: any = await api.analyze.subject(rb, 6.5);
    const job = jobs()[before];
    check("the helper job carries face_model = the cached model's path and face_min = FACE_MIN", sub.cached === false && jobs().length === before + 1 && job?.cmd === "subject" && job.face_model === faceFile(mainCache) && typeof job.face_min === "number" && job.face_min === V.FACE_MIN, { job, want: faceFile(mainCache) });
    const A = fresh("key-a"), B = fresh("key-b"), R = join(tmp, "key-root");
    const jobIn = (cache: string) => inCache(cache, () => V.subjectJob(rb, { fps: 6, duration: 4, srcW: 640, srcH: 360, root: R }));
    const ja = await jobIn(A), jb = await jobIn(B);
    check("the cache key is the same under two cache roots, while face_model follows the root", basename(ja.file) === basename(jb.file) && ja.job.face_model === faceFile(A) && jb.job.face_model === faceFile(B), { a: ja.file, b: jb.file, fa: ja.job.face_model, fb: jb.job.face_model });
    { // the key is the hash of the job's own parameters (the path and the model file excluded), face_min among them
      const { path: _path, face_model: _model, model_sha256: _sha, ...params } = ja.job, keyOf = (p: unknown) => `subject-${V.cacheKey(rb, p)}.json`;
      check("the cache key covers face_min: it is the key of the job's parameters, and another face_min gives another key",
        typeof params.face_min === "number" && basename(ja.file) === keyOf(params) && basename(ja.file) !== keyOf({ ...params, face_min: V.FACE_MIN + 0.05 }), { params, file: ja.file });
    }
    check("the key names no path of this machine", !ja.file.includes(A) && !basename(ja.file).includes(FACE) && JSON.stringify(ja.job).includes(FACE_MODEL?.sha256?.slice(0, 12) ?? "no-sha"), ja.job);

    // 3. the gate: no model and no allow_download -> model_not_cached, and uv is never started
    const G = fresh("gate"), calls0 = nCalls(), jobs0 = jobs().length;
    const ns = await inCache(G, () => caught(() => api.analyze.subject(rb, 7.5)));
    check("analyze_subject without the model and without allow_download -> model_not_cached", ns?.code === "model_not_cached" && ns.message.includes(FACE) && !/remove_background/.test(ns.message), { code: ns?.code, message: ns?.message });
    check("  the hint names the file, allow_download and the size", ns?.hint?.includes(faceFile(G)) && ns.hint.includes("allow_download") && ns.hint.includes("0.23"), ns?.hint);
    check("  uv was never started and no model file was written", nCalls() === calls0 && jobs().length === jobs0 && !existsSync(join(G, "models")), { calls: nCalls() - calls0, models: existsSync(join(G, "models")) });
    const E = join(tmp, "gate-subject");
    api.create(E, { preset: "reels" });
    await apply(E, [{ op: "add_clip", track: "main", src: rb, duration: 4 }, { op: "auto_reframe", id: "vid1", fps: 7 }]);
    const st: any = await inCache(G, () => api.prepareStatus(E));
    check("prepare status lists the face model in models_to_download", st.models_to_download?.length === 1 && st.models_to_download[0].model === FACE && st.models_to_download[0].approx_mb === 0.23 && st.models_to_download[0].path === faceFile(G), st);
    for (const [what, opts] of [["", undefined], [" (allow_download false)", { allowDownload: false }]] as const) {
      const np = await inCache(G, () => caught(() => api.prepare(E, opts)));
      check(`prepare without allow_download${what}: model_not_cached, no job started`, np?.code === "model_not_cached" && np.message.includes(FACE) && !/remove_background/.test(np.message) && np.hint.includes("allow_download") && nCalls() === calls0 && jobs().length === jobs0, { code: np?.code, message: np?.message });
    }
    { // prepare's batch gate: a mixed batch (a job that needs the missing face model, a job that needs no model) is refused whole, before any job starts
      const G2 = fresh("gate-mixed"), M2 = join(tmp, "gate-mixed-project");
      await inCache(G2, () => seedModel("u2netp"));
      api.create(M2, { preset: "reels" });
      await apply(M2, [{ op: "add_clip", track: "main", src: rb, duration: 4 }, { op: "remove_background", id: "vid1" }, { op: "auto_reframe", id: "vid1", fps: 11 }]);
      const tree = (d: string) => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort().join("|") : null);
      const calls1 = nCalls(), jobs1 = jobs().length, g2 = tree(G2), m2 = tree(join(M2, ".agentcut"));
      const mst: any = await inCache(G2, () => api.prepareStatus(M2));
      check("a mixed batch: status lists the missing face model, the matte job needs no model", mst.missing.map((x: any) => x.kind).sort().join() === "matte,subject" && mst.models_to_download.map((x: any) => x.model).join() === FACE, mst);
      const mp = await inCache(G2, () => caught(() => api.prepare(M2)));
      check("a mixed batch: prepare -> model_not_cached for the face model only, and no job started (uv not run for either job, nothing new in either cache)",
        mp?.code === "model_not_cached" && mp.message.includes(FACE) && !mp.message.includes("u2netp") && nCalls() === calls1 && jobs().length === jobs1 && tree(G2) === g2 && tree(join(M2, ".agentcut")) === m2,
        { code: mp?.code, message: mp?.message, calls: nCalls() - calls1, g2: tree(G2), m2: tree(join(M2, ".agentcut")) });
    }
    // the CLI runs with a stub fetch loaded by --preload (the test's own file; no network, no product switch): it records the URL it was asked for
    const fetchLog = join(tmp, "cli-fetch.log"), fetchStub = join(tmp, "cli-fetch-stub.ts");
    writeFileSync(fetchStub, `import { appendFileSync } from "node:fs";\nglobalThis.fetch = (async (u: unknown) => { appendFileSync(${JSON.stringify(fetchLog)}, String(u) + "\\n"); return new Response("no", { status: 404 }); }) as typeof fetch;\n`);
    const fetched1 = () => (existsSync(fetchLog) ? readFileSync(fetchLog, "utf8").split("\n").filter(Boolean) : []);
    const cli = (cache: string, ...a: string[]) => spawnSync(process.execPath, ["--no-install", "--preload", fetchStub, join(import.meta.dir, "../src/cli.ts"), "subject", rb, "--fps", "8.5", ...a], { encoding: "utf8", env: { ...process.env, AGENTCUT_CACHE: cache } });
    const c1 = cli(G), c1j = JSON.parse(c1.stdout || "{}");
    check("CLI subject without --allow-download and without the model: model_not_cached, non-zero exit, uv not started, nothing fetched", c1.status !== 0 && c1j.error?.code === "model_not_cached" && nCalls() === calls0 && fetched1().length === 0, { status: c1.status, out: c1.stdout.slice(0, 300), fetched: fetched1() });
    const c1a = cli(G, "--allow-download"), c1aj = JSON.parse(c1a.stdout || "{}");
    check("CLI subject --allow-download without the model: the request reaches the download of the face model (stub answers 404 -> model_download_failed), uv not started",
      c1a.status !== 0 && c1aj.error?.code === "model_download_failed" && fetched1().join() === FACE_MODEL.url && nCalls() === calls0, { status: c1a.status, out: c1a.stdout.slice(0, 300), fetched: fetched1() });
    // with allow_download, compute fetches the face model first; a failed fetch stops it before the helper (fetch stubbed: no network)
    const realFetch = globalThis.fetch, fetched: string[] = [];
    globalThis.fetch = (async (u: any) => { fetched.push(String(u)); return new Response("no", { status: 404 }); }) as typeof fetch;
    const df = await inCache(G, () => caught(() => api.analyze.subject(rb, 7.5, true))).finally(() => { globalThis.fetch = realFetch; });
    check("analyze_subject with allow_download and no model: compute fetches the face model; a failed fetch -> model_download_failed, uv not started, nothing written",
      df?.code === "model_download_failed" && fetched.length === 1 && fetched[0] === FACE_MODEL.url && nCalls() === calls0 && !existsSync(join(G, "models")), { code: df?.code, fetched, calls: nCalls() - calls0 });
    seedFaceIn(G);
    const stOk: any = await inCache(G, () => api.prepareStatus(E));
    check("once the model file is in place nothing is left to download", stOk.models_to_download.length === 0, stOk);
    const okp: any = await inCache(G, () => api.prepare(E));
    check("  and prepare runs the helper with that file", okp.ready === true && nCalls() === calls0 + 1 && jobs().at(-1)?.face_model === faceFile(G), { ready: okp.ready, job: jobs().at(-1) });
    const c2 = cli(G, "--allow-download"), c2j = JSON.parse(c2.stdout || "{}");
    check("CLI subject --allow-download with the model present runs and says what it followed", c2.status === 0 && c2j.ok === true && typeof c2j.subject === "string" && Array.isArray(c2j.samples), { status: c2.status, out: c2.stdout.slice(0, 300) });

    // a helper that fails with the model present: the hint names the file
    const failUv = join(tmp, "fail-subject-uv.mjs");
    writeFileSync(failUv, `#!/usr/bin/env node\nprocess.stderr.write("stub load failure\\n"); process.exit(1);\n`);
    chmodSync(failUv, 0o755);
    process.env.AGENTCUT_UV = failUv;
    const bad = await inCache(G, () => caught(() => api.analyze.subject(rb, 9.5)));
    process.env.AGENTCUT_UV = fake;
    check("subject helper fails with the model present: vision_failed, the hint names the model file and allow_download", bad?.code === "vision_failed" && bad.hint.includes(`the model file ${faceFile(G)} may be damaged`) && bad.hint.includes("allow_download") && /probe_media/.test(bad.hint), { code: bad?.code, hint: bad?.hint });

    // 5. capabilities
    const caps = (cache: string) => inCache(cache, () => (api.capabilities() as any));
    const cOff = await caps(fresh("caps-off")), cOn = await caps(G);
    check("capabilities: engines.vision.face_model is not cached in an empty cache", JSON.stringify(cOff.engines.vision.face_model) === JSON.stringify({ name: FACE, approx_mb: 0.23, cached: false }), cOff.engines.vision);
    check("capabilities: engines.vision.face_model is cached once the file is there, and matte_models stays", JSON.stringify(cOn.engines.vision.face_model) === JSON.stringify({ name: FACE, approx_mb: 0.23, cached: true }) && cOn.matte_models.length === 5 && cOn.engines.vision.matte_models === "see matte_models", cOn.engines.vision);

    // 4. downloadModel against a local server (never the product URL)
    const good = Buffer.from("not a real model: some bytes for a local download test"), other = Buffer.from(good.toString().replace("some", "SOME"));
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    const server = createServer((req, res) => {
      const send = (code: number, body: Buffer) => { res.writeHead(code, { "content-length": body.length }); res.end(body); };
      if (req.url === "/hold") { res.writeHead(200, { "content-length": good.length }); res.write(good.subarray(0, 5)); return; } // never finishes
      if (req.url === "/slow") { // keeps sending, in small pieces, for longer than the idle limit the rows below use
        res.writeHead(200, { "content-length": good.length });
        let at = 0;
        const t = setInterval(() => { if (at >= good.length) { clearInterval(t); res.end(); } else res.write(good.subarray(at, (at += 6))); }, 100);
        res.on("close", () => clearInterval(t));
        return;
      }
      if (req.url === "/ok") send(200, good);
      else if (req.url === "/other") send(200, other);
      else if (req.url === "/short") send(200, good.subarray(0, 10));
      else if (req.url === "/long") send(200, Buffer.concat([good, good]));
      else send(404, Buffer.from("no"));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const desc = (name: string, path: string) => ({ name, url: `http://127.0.0.1:${port}${path}`, sha256: sha(good), bytes: good.length });
    const D = fresh("download");
    // what a failed download may leave in a models dir: no model or temp file (empty directories may remain)
    const left = (cache: string) => (existsSync(join(cache, "models")) ? readdirSync(join(cache, "models"), { recursive: true }).map(String).filter((f) => f.includes(".part-") || f.endsWith(".onnx")) : []);
    try {
      await inCache(D, async () => {
        const down = (name: string, path: string) => caught(() => V.downloadModel(desc(name, path)));
        for (const [what, path] of [["the right size with other bytes (sha256 differs)", "/other"], ["a body shorter than the size", "/short"], ["a body longer than the size", "/long"], ["an HTTP 404", "/missing"]] as const) {
          const e = await down("test_model_bad", path);
          check(`downloadModel: ${what} -> model_download_failed, hint names the URL and the target path, no file left`,
            e?.code === "model_download_failed" && e.hint.includes(desc("x", path).url) && e.hint.includes(join(D, "models", "test_model_bad", "test_model_bad.onnx")) && left(D).length === 0, { code: e?.code, message: e?.message, hint: e?.hint, left: left(D) });
        }
        // runs without AbortSignal.any, which Node before 20.3 lacks (package.json engines: >=20)
        const any = AbortSignal.any;
        (AbortSignal as any).any = undefined;
        const ok = await caught(() => V.downloadModel(desc("test_model_ok", "/ok")));
        (AbortSignal as any).any = any;
        const file = join(D, "models", "test_model_ok", "test_model_ok.onnx");
        check("downloadModel: the right bytes are written, and only that file (without AbortSignal.any)", ok === null && existsSync(file) && readFileSync(file).equals(good) && readdirSync(join(D, "models", "test_model_ok")).join() === "test_model_ok.onnx" && V.modelCached("test_model_ok") && V.modelFile("test_model_ok") === file, { ok, listing: existsSync(join(D, "models")) && readdirSync(join(D, "models"), { recursive: true }) });
      });
      const H = fresh("download-abort"), ac = new AbortController(), reason = new Error("stopped by the caller");
      const listing = (cache: string) => (existsSync(join(cache, "models")) ? readdirSync(join(cache, "models"), { recursive: true }).map(String) : []);
      let during: string[] = [];
      void (async () => { // the body is streamed: once the first bytes are in, they sit in a temp file beside the target; then the caller aborts
        for (let i = 0; i < 250 && !during.some((f) => f.includes(".part-")); i++) { await new Promise((r) => setTimeout(r, 20)); during = listing(H); }
        ac.abort(reason);
      })();
      const t0 = Date.now(), ab = await inCache(H, () => caught(() => V.downloadModel(desc("test_model_hold", "/hold"), ac.signal))), took = Date.now() - t0;
      // well under the 60 s idle limit: the caller's abort itself stopped the transfer
      check("downloadModel: the body goes to a temp file as it arrives; a caller abort mid-body rejects at once with the caller's reason, no file left", ab === reason && took < 10_000 && during.some((f) => f.includes(".part-")) && left(H).length === 0, { got: String(ab?.message ?? ab), took, during, after: left(H) });
      // the idle limit is shortened for these two rows (the third argument of downloadModel, which callers leave at 60 s)
      const S = fresh("download-stall"), ts = Date.now(), stalled = await inCache(S, () => caught(() => V.downloadModel(desc("test_model_stall", "/hold"), undefined, 300))), tookStall = Date.now() - ts;
      check("downloadModel: a body that stops sending fails after the idle limit, model_download_failed 'no data for', no file left", stalled?.code === "model_download_failed" && /no data for/.test(stalled.message) && tookStall < 10_000 && left(S).length === 0, { code: stalled?.code, message: stalled?.message, tookStall, after: left(S) });
      const L = fresh("download-slow"), tl = Date.now(), slow = await inCache(L, () => caught(() => V.downloadModel(desc("test_model_slow", "/slow"), undefined, 400))), tookSlow = Date.now() - tl;
      const slowFile = join(L, "models", "test_model_slow", "test_model_slow.onnx");
      check("downloadModel: a body that keeps sending succeeds although the whole transfer takes longer than the idle limit", slow === null && tookSlow > 400 && existsSync(slowFile) && readFileSync(slowFile).equals(good) && listing(L).length === 2, { slow: slow?.message, tookSlow, after: listing(L) });
      { // a killed download leaves its part file; the next download of that model removes only a dead process's exact part names
        const Z = fresh("download-parts"), dir = join(Z, "models", "test_model_ok");
        mkdirSync(dir, { recursive: true });
        const dead = Number(spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout);
        const part = (pid: number, tag: string, name = "test_model_ok") => join(dir, `${name}.part-${pid}-${tag}.onnx`);
        const outside = join(Z, "outside.bin");
        writeFileSync(outside, "outside");
        writeFileSync(part(dead, "aaaaaaaaaaaa"), "dead process");
        writeFileSync(part(process.pid, "bbbbbbbbbbbb"), "live process");
        symlink(outside, part(dead, "cccccccccccc")); // the right name, but a link
        writeFileSync(part(dead, "dd"), "a name tmpSibling never makes");
        writeFileSync(part(dead, "eeeeeeeeeeee", "test_model_other"), "another model's part");
        const dl = await inCache(Z, () => caught(() => V.downloadModel(desc("test_model_ok", "/ok"))));
        const kept = readdirSync(dir).sort(), want = [`test_model_ok.onnx`, `test_model_ok.part-${dead}-cccccccccccc.onnx`, `test_model_ok.part-${dead}-dd.onnx`, `test_model_ok.part-${process.pid}-bbbbbbbbbbbb.onnx`, `test_model_other.part-${dead}-eeeeeeeeeeee.onnx`].sort();
        check("downloadModel: the part file of a dead process is removed by the next download of that model, and the download itself succeeds", dl === null && !existsSync(part(dead, "aaaaaaaaaaaa")) && readFileSync(join(dir, "test_model_ok.onnx")).equals(good), { dl: dl?.message, kept });
        check("downloadModel: a live process's part file is kept, with its content", kept.includes(`test_model_ok.part-${process.pid}-bbbbbbbbbbbb.onnx`) && readFileSync(part(process.pid, "bbbbbbbbbbbb"), "utf8") === "live process", { kept });
        check("downloadModel: a link with the matching name, a name tmpSibling never makes and another model's part are left alone, and the link's target is not touched",
          JSON.stringify(kept) === JSON.stringify(want) && lstat(part(dead, "cccccccccccc")).isSymbolicLink() && readFileSync(outside, "utf8") === "outside", { kept, want });
      }
    } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    const refused = await inCache(fresh("download-closed"), () => caught(() => V.downloadModel(desc("test_model_closed", "/ok"))));
    check("downloadModel: a server that is gone -> model_download_failed", refused?.code === "model_download_failed", { code: refused?.code, message: refused?.message });
  } finally { delete process.env.FAKE_JOB_LOG; process.env.AGENTCUT_CACHE = mainCache; process.env.AGENTCUT_UV = fake; }
}

// ---------------------------------------------------------------- the helper's Python range, and the pinned u2netp
console.log("the vision helper's Python range and the u2netp pin");
{
  const { createHash } = await import("node:crypto");
  const logFile = join(tmp, "py-runs.jsonl"), pyUv = join(tmp, "py-uv.mjs");
  // records argv and the u2netp file as the helper would find it under U2NET_HOME, then fails with FAKE_PY_ERR on stderr
  writeFileSync(pyUv, `#!/usr/bin/env node
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const home = process.env.U2NET_HOME ?? null;
let model = null;
if (home) try { const f = join(home, "models", "u2netp", "u2netp.onnx"); model = { sha: createHash("sha256").update(readFileSync(f)).digest("hex"), mode: lstatMode(f) }; } catch {}
function lstatMode(f) { return statSync(f).mode & 0o777; }
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ argv: process.argv.slice(2), home, model }) + "\\n");
process.stderr.write((process.env.FAKE_PY_ERR ?? "boom") + "\\n"); process.exit(2);
`);
  chmodSync(pyUv, 0o755);
  type PyRun = { argv: string[]; home: string | null; model: { sha: string; mode: number } | null };
  const pyRuns = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) as PyRun[];
  const caught = async (f: () => unknown) => { try { await f(); return null as any; } catch (e: any) { return e; } };
  const rb = join(m, "rb.mp4"), keep = process.env.AGENTCUT_CACHE!, sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  let n = 0;
  const root = () => { const d = join(tmp, `py-root-${n++}`); mkdirSync(d); return d; }; // a fresh project dir: nothing is cached
  const jobs = {
    subject: () => V.subjectJob(rb, { fps: 10, duration: 1, srcW: 640, srcH: 360, root: root() }),
    track: () => V.trackJob(rb, { start: 0, duration: 1, at: 0, box: [0.4, 0.4, 0.2, 0.2], srcW: 640, srcH: 360, root: root() }),
    matte: () => V.matteJob(rb, { kind: "video", fps: 10, duration: 1, srcW: 640, srcH: 360, root: root() }),
  };
  /** compute one job under the failing uv; the run it logged, and the error */
  const go = async (job: ReturnType<(typeof jobs)[keyof typeof jobs]>, allow: boolean) => {
    const before = pyRuns().length, e = await caught(() => V.compute(job, undefined, undefined, allow));
    return { run: pyRuns().slice(before)[0], runs: pyRuns().length - before, e };
  };
  process.env.AGENTCUT_UV = pyUv;
  try {
    { // the args are built once for every helper, so one kind observes them
      const off = await go(jobs.track(), false), on = await go(jobs.track(), true), at = off.run?.argv.indexOf("--python") ?? -1;
      check("uv gets --python with the pinned range", at >= 0 && off.run.argv[at + 1] === ">=3.12,<3.14" && on.run?.argv[on.run.argv.indexOf("--python") + 1] === ">=3.12,<3.14", { off: off.run?.argv, on: on.run?.argv });
      check("--no-python-downloads is passed without allow_download and left out with it", off.run?.argv.includes("--no-python-downloads") === true && on.run?.argv.includes("--no-python-downloads") === false, { off: off.run?.argv, on: on.run?.argv });
    }
    { // every matte job carries its model's sha256 and file, and the helper job holds no download switch; the face job carries the face model's
      const jobOf = (r: PyRun) => JSON.parse(r.argv.at(-1)!);
      const u2netp = jobOf((await go(jobs.matte(), false)).run), face = jobOf((await go(jobs.subject(), false)).run);
      check("the matte job reaching the helper carries the model's sha256 and file, and no allow_download", u2netp.model_sha256 === M.MATTE_PINS.u2netp.sha256 && u2netp.model_file === V.modelFile("u2netp") && !("allow_download" in u2netp), u2netp);
      check("every matte model's job carries that model's sha256 and file", M.MATTE_MODELS.every((name) => { const j = V.matteJob(rb, { kind: "video", fps: 10, duration: 1, srcW: 640, srcH: 360, model: name, root: root() }).job; return j.model_sha256 === M.MATTE_PINS[name].sha256 && j.model_file === V.modelFile(name); }));
      check("every matte model has a pin: its own name, an https url ending /<name>.onnx, 64 hex sha256, bytes > 0, and a size in whole MB",
        M.MATTE_MODELS.length === 5 && M.MATTE_MODELS.every((name) => { const p = M.MATTE_PINS[name]; return p.name === name && p.url.startsWith("https://") && p.url.endsWith(`/${name}.onnx`) && /^[0-9a-f]{64}$/.test(p.sha256) && p.bytes > 0 && M.MATTE_MB[name] === Math.round(p.bytes / 1e6) && M.matteSize(name) === `~${M.MATTE_MB[name]} MB`; })
        && new Set(M.MATTE_MODELS.map((n) => M.MATTE_PINS[n].url)).size === 5);
      check("the subject job carries the face model's sha256", face.model_sha256 === V.FACE_MODEL.sha256 && face.face_model === V.modelFile(V.FACE_MODEL.name), face);
      process.env.FAKE_PY_ERR = "model file does not match its pinned sha256: " + V.modelFile("u2netp");
      const mm = await go(jobs.matte(), false);
      check("the helper refusing a model file: vision_failed, the hint names the file and says to delete it and run with allow_download=true",
        mm.e?.code === "vision_failed" && mm.e.hint.includes(V.modelFile("u2netp")) && /delete it/.test(mm.e.hint) && mm.e.hint.includes("allow_download=true") && !/network/.test(mm.e.hint), { code: mm.e?.code, hint: mm.e?.hint });
    }
    process.env.FAKE_PY_ERR = "error: No interpreter found for Python >=3.12, <3.14 in managed installations or search path";
    const ni = await go(jobs.track(), false);
    check("uv found no interpreter: vision_failed, the hint names the range, `uv python install 3.12` and allow_download=true, not network or model advice",
      ni.e?.code === "vision_failed" && ni.e.hint.includes(">=3.12,<3.14") && ni.e.hint.includes("uv python install 3.12") && ni.e.hint.includes("allow_download=true") && !/network|model/.test(ni.e.hint), { code: ni.e?.code, hint: ni.e?.hint });
    process.env.FAKE_PY_ERR = "boom";
    const other = await go(jobs.track(), false);
    check("any other helper failure keeps the network and decode hint", other.e?.code === "vision_failed" && /network access/.test(other.e.hint) && !/uv python install/.test(other.e.hint), { hint: other.e?.hint });

    // u2netp: AgentCut fetches it, checks sha256 and size, and only then lets the helper load it
    const U = M.MATTE_PINS.u2netp;
    const realFetch = globalThis.fetch, fetched: string[] = [];
    const serve = (body: Buffer) => { globalThis.fetch = (async (u: any) => { fetched.push(String(u)); return new Response(body); }) as typeof fetch; };
    const fresh = (name: string) => { const d = join(tmp, `u2-${name}`); mkdirSync(d, { recursive: true }); return d; };
    const inCache = async <T>(cache: string, f: () => Promise<T>) => { process.env.AGENTCUT_CACHE = cache; try { return await f(); } finally { process.env.AGENTCUT_CACHE = keep; } };
    const pin = { sha256: U.sha256, bytes: U.bytes };
    try {
      const W = fresh("wrong"), runs0 = pyRuns().length;
      serve(Buffer.alloc(U.bytes, 1)); // the right size, other content
      const bad = await inCache(W, () => go(jobs.matte(), true));
      check("a u2netp download with the wrong hash is refused: model_download_failed, no file written, the helper never started",
        bad.e?.code === "model_download_failed" && fetched.join() === U.url && pyRuns().length === runs0 && !(existsSync(join(W, "models")) && readdirSync(join(W, "models"), { recursive: true }).some((f) => String(f).endsWith(".onnx") || String(f).includes(".part-"))), { code: bad.e?.code, fetched, runs: pyRuns().length - runs0 });

      const good = Buffer.from("not a real model: some bytes for a local download test"), P = fresh("good");
      Object.assign(U, { sha256: sha(good), bytes: good.length }); // the pin of this row; restored below
      fetched.length = 0;
      serve(good);
      const ok = await inCache(P, () => go(jobs.matte(), true)), file = join(P, "models", "u2netp", "u2netp.onnx"), modeOf = () => (existsSync(file) ? lstat(file).mode & 0o777 : null);
      const umask = Number.parseInt(spawnSync("sh", ["-c", "umask"], { encoding: "utf8" }).stdout.trim(), 8);
      check("a good u2netp download is written once, as the only file, at mode 0644", fetched.join() === U.url && existsSync(file) && readFileSync(file).equals(good)
        && readdirSync(join(P, "models", "u2netp")).join() === "u2netp.onnx" && modeOf() === (0o644 & ~umask), { fetched, mode: modeOf(), umask });
      check("the helper is pointed at the verified file: U2NET_HOME is the cache whose models/u2netp/u2netp.onnx holds the checked bytes when the helper starts",
        ok.runs === 1 && ok.run.home === P && ok.run.model?.sha === sha(good) && ok.run.model.mode === (0o644 & ~umask), ok.run);
      fetched.length = 0;
      await inCache(P, () => go(jobs.matte(), true));
      check("a cached u2netp is not fetched again", fetched.length === 0, fetched);
    } finally { globalThis.fetch = realFetch; Object.assign(U, pin); delete process.env.FAKE_PY_ERR; process.env.AGENTCUT_CACHE = keep; process.env.AGENTCUT_UV = fake; }
  } finally { process.env.AGENTCUT_UV = fake; delete process.env.FAKE_PY_ERR; }
}

// ---------------------------------------------------------------- missing tool
console.log("missing uv");
process.env.AGENTCUT_UV = join(tmp, "no-such-uv");
await prepFails(P, [{ op: "auto_reframe", id: "vid1", fps: 3 }], "missing_dependency", "no uv -> missing_dependency with install hint (prepare)", ["needs uv"]);
await prepFails(B, [{ op: "remove_background", id: "vid2", model: "u2net" }], "missing_dependency", "no uv (matte) -> missing_dependency (prepare)");
await prepFails(P, [{ op: "auto_reframe", id: "vid1", fps: 3 }, { op: "remove_background", id: "vid1", model: "u2net" }], "missing_dependency",
  "no uv, mixed batch -> one missing_dependency naming both jobs and both downloads", ["remove_background", "subject analysis", "rembg", "opencv", " need uv"]);
{
  const keep = process.env.AGENTCUT_CACHE, G = join(tmp, "no-uv-cache"), realFetch = globalThis.fetch, fetched: string[] = [];
  const err = (f: () => Promise<unknown>) => f().then(() => null, (x) => x as any);
  const N = join(tmp, "no-uv-reel");
  let e: any, pe: any;
  try {
    mkdirSync(G);
    globalThis.fetch = (async (u: any) => { fetched.push(String(u)); return new Response("no", { status: 404 }); }) as typeof fetch;
    process.env.AGENTCUT_CACHE = G;
    api.create(N, { preset: "reels" });
    await apply(N, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4") }, { op: "auto_reframe", id: "vid1", fps: 5 }]);
    e = await err(() => api.analyze.subject(join(m, "rb.mp4"), 7.25, true)); pe = await err(() => api.prepare(N));
  } finally { globalThis.fetch = realFetch; process.env.AGENTCUT_CACHE = keep; }
  check("no uv, face model missing, downloads allowed -> missing_dependency and nothing fetched", e?.code === "missing_dependency" && fetched.length === 0 && !existsSync(join(G, "models")), { code: e?.code, fetched });
  check("no uv, face model missing, prepare without downloads -> missing_dependency (uv before the model gate)", pe?.code === "missing_dependency", { code: pe?.code });
}
check("core edits still work without uv", (await apply(B, [{ op: "update_clip", id: "vid2", set: { opacity: 0.5 } }]))[0].id === "vid2");

// ---------------------------------------------------------------- real helper (opt-in: downloads opencv/rembg via uv)
// Each row is named here so a run without AGENTCUT_TEST_VISION=1 can list what it skips. The rows share the projects built in `setup`.
const real = { R: "", Q: "", K: "", I: "", mainCache: "" };
const realRows: [string, () => Promise<[unknown, unknown]>][] = [
  // the YuNet branch: the helper loads the face model from <cache>/models/<name>/<name>.onnx (the layout the downloader writes and src/vision.ts documents),
  // and the picture holds no face, so every sample falls back to saliency
  ["real: face detector loaded from the models dir; no face in the picture -> saliency, followed left -> right", async () => {
    const res = (await applyPrep(real.R, [{ op: "auto_reframe", id: "vid1" }], true))[0], kx = (await clip(real.R, "vid1")).keyframes.focus_x;
    return [res.samples === 18 && res.face_samples === 0 && res.subject === "saliency" && kx[0][1] < 0.2 && kx.at(-1)[1] > 0.7 && existsSync(V.modelFile(V.FACE_MODEL.name)), { res, kx }];
  }],
  ["real: CSRT follows the box (within 25 px)", async () => {
    const tk = (await applyPrep(real.Q, [{ op: "track_to", id: "shp1", target: "vid1", box: [120, 420, 240, 240], at: 0 }]))[0], end = (await clip(real.Q, "shp1")).keyframes.x.at(-1);
    return [tk.lost === 0 && near(end[1], (40 + end[0] * 130 + 40) * 3, 25), { tk, end }];
  }],
  ["real: KCF follows the box (within 40 px)", async () => {
    const tk = (await applyPrep(real.K, [{ op: "track_to", id: "shp1", target: "vid1", box: [120, 420, 240, 240], at: 0, tracker: "kcf" }]))[0], end = (await clip(real.K, "shp1")).keyframes.x.at(-1);
    return [near(end[1], (40 + end[0] * 130 + 40) * 3, 40), { tk, end }];
  }],
  ["real: video matte produced under the models dir layout and cached", async () => {
    await apply(real.Q, [{ op: "remove_background", id: "vid1" }]);
    const mt: any = await api.prepare(real.Q, { allowDownload: true }), again = await V.compute(V.matteJob(join(m, "mover.mp4"), { kind: "video", fps: 30, duration: 3, srcW: 640, srcH: 360, root: real.Q }));
    return [existsSync(mt.computed[0].file) && again.cached === true && existsSync(V.modelFile("u2netp")), mt];
  }],
  ["real: image matte is a PNG with an alpha channel and is cached", async () => {
    await apply(real.I, [{ op: "add_clip", track: "main", src: join(m, "still.png"), duration: 1 }, { op: "remove_background", id: "img1" }]);
    const mt: any = await api.prepare(real.I, { allowDownload: true }), file: string = mt.computed[0].file;
    const pix = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim();
    const again = await V.compute(V.matteJob(join(m, "still.png"), { kind: "image", srcW: 640, srcH: 360, root: real.I }));
    return [file.endsWith(".png") && pix === "rgba" && again.cached === true, { file, pix }];
  }],
];
// a picture of one real face is not made offline: name one to also assert the face branch finds it
const faceFixture = process.env.AGENTCUT_TEST_VISION_FACE;
if (faceFixture) realRows.push(["real: a face in AGENTCUT_TEST_VISION_FACE is found (subject face)", async () => {
  const sub: any = await api.analyze.subject(faceFixture, 6, true);
  return [sub.subject === "face" && sub.samples.some((x: any) => x.kind === "face"), { subject: sub.subject, warnings: sub.warnings }];
}]);
if (process.env.AGENTCUT_TEST_VISION === "1") {
  console.log("real helper (uv)");
  delete process.env.AGENTCUT_UV;
  ff("-f", "lavfi", "-i", "color=c=0x203040:s=640x360:r=30:d=3", "-f", "lavfi", "-i", "testsrc2=s=80x80:r=30:d=3",
    "-filter_complex", "[0][1]overlay=x='40+t*130':y=140", "-pix_fmt", "yuv420p", join(m, "mover.mp4"));
  // a cache of its own: the suite's cache holds 0-byte model seeds the real helper cannot load
  real.mainCache = process.env.AGENTCUT_CACHE!;
  const realCache = join(tmp, "real-cache");
  mkdirSync(realCache, { recursive: true });
  if (process.env.AGENTCUT_TEST_VISION_MODELS) cpSync(process.env.AGENTCUT_TEST_VISION_MODELS, join(realCache, "models"), { recursive: true });
  process.env.AGENTCUT_CACHE = realCache;
  try {
    real.R = join(tmp, "real");
    api.create(real.R, { preset: "reels" });
    await apply(real.R, [{ op: "add_clip", track: "main", src: join(m, "mover.mp4"), duration: 3 }]);
    for (const k of ["Q", "K"] as const) {
      real[k] = join(tmp, `real-yt-${k}`);
      api.create(real[k], { preset: "youtube" });
      await apply(real[k], [{ op: "add_clip", track: "main", src: join(m, "mover.mp4"), duration: 3 },
        { op: "add_clip", track: "overlay", type: "shape", shape: "circle", size: [30, 30], fill: "red", at: 0, duration: 3 }]);
    }
    real.I = join(tmp, "real-image");
    api.create(real.I, { preset: "youtube" });
    // a helper failure is a ✗ row, so the suite still reports and removes its tmp dir
    for (const [name, f] of realRows) {
      try { const [ok, info] = await f(); check(name, ok, info); } catch (e: any) { check(name, false, { code: e.code, message: e.message }); }
    }
  } finally { process.env.AGENTCUT_CACHE = real.mainCache; }
} else {
  console.log(`SKIPPED: ${realRows.length} real-helper rows (AGENTCUT_TEST_VISION=1 runs them through uv and downloads packages and models): ${realRows.map(([n]) => n).join(" | ")}`);
  if (!faceFixture) console.log("SKIPPED: real face row (set AGENTCUT_TEST_VISION_FACE=<image or video with one face> together with AGENTCUT_TEST_VISION=1)");
}

// ---------------------------------------------------------------- a matte with no frames; a missing source; pending analyses and prune
console.log("matte frame count, missing source, prune");
{
  // a helper that exits 0 with a file at the output path but reports no frames: it must not be cached
  const emptyUv = join(tmp, "empty-matte-uv.mjs");
  writeFileSync(emptyUv, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const job = JSON.parse(process.argv.at(-1));
writeFileSync(job.out, "x");
process.stdout.write(JSON.stringify({ out: job.out, frames: 0 }));
`);
  chmodSync(emptyUv, 0o755);
  const Z = join(tmp, "empty-matte");
  api.create(Z, { preset: "720p" });
  await apply(Z, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 2 }, { op: "remove_background", id: "vid1" }]);
  process.env.AGENTCUT_UV = emptyUv;
  let zr: any;
  try { zr = await api.prepare(Z).catch((e) => e); } finally { process.env.AGENTCUT_UV = fake; }
  const zc = join(Z, ".agentcut", "cache");
  check("a matte reported with no frames is refused (vision_failed) and not cached", zr.code === "vision_failed" && (!existsSync(zc) || readdirSync(zc).every((f) => !f.startsWith("matte-"))), { code: zr.code, files: existsSync(zc) ? readdirSync(zc) : null });

  // cache info / prune on a project whose matte clip lost its media: a named error, not a raw ENOENT
  const gone = join(tmp, "gone.mp4");
  cpSync(join(m, "rb.mp4"), gone);
  const M = join(tmp, "gone-src");
  api.create(M, { preset: "720p" });
  await apply(M, [{ op: "add_clip", track: "main", src: gone, duration: 2 }, { op: "remove_background", id: "vid1" }]);
  rmSync(gone);
  for (const [what, f] of [["cache info", () => api.cache.info(M)], ["cache prune", () => api.cache.prune(M)]] as const) {
    let e: any; try { f(); } catch (x) { e = x; }
    check(`${what} with a matte clip whose media is missing: not_found naming the file, with a hint`, e?.code === "not_found" && e.message.includes(gone) && !!e.hint, { code: e?.code, message: e?.message });
  }

  // an analysis a pending request needs, already computed but not yet applied, is referenced: prune keeps it
  const R = join(tmp, "pending-keep");
  api.create(R, { preset: "reels" });
  await apply(R, [{ op: "add_clip", track: "main", src: join(m, "rb.mp4"), duration: 4 }, { op: "auto_reframe", id: "vid1" }]);
  check("pending-keep: the request is recorded", !!(await clip(R, "vid1")).pending?.auto_reframe);
  const an = await api.analyze.subject(join(m, "rb.mp4"), 6, false, R);
  const cdir = join(R, ".agentcut", "cache"), subjFiles = () => readdirSync(cdir).filter((f) => f.startsWith("subject-"));
  check("pending-keep: the analysis exists in the project cache", an.cached === false && subjFiles().length === 1, subjFiles());
  const inf: any = api.cache.info(R);
  check("cache info counts the computed analysis of a pending request as referenced", inf.cache.referenced.files === 1, inf.cache);
  api.cache.prune(R);
  check("prune keeps the computed analysis of a pending request", subjFiles().length === 1, subjFiles());
  const pr: any = await api.prepare(R);
  check("prepare then applies the pending request from that analysis without running the helper", pr.computed.length === 0 && !(await clip(R, "vid1")).pending, pr);
}

console.log(`\n${failures ? `✗ ${failures} failure(s)` : "✓ all vision checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
