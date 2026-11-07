// Pro trimming/audio ops: detach_audio, j_cut, l_cut, slip_clip, roll_edit, slide_clip (numbers, errors, audio render).
// Run: bun tests/edit-ops.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-editops-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store - set before importing the api
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("../src/api.ts");
const { applyOps } = await import("../src/ops.ts");
const { newTimeline, validate, resolve } = await import("../src/model.ts");

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

const m = join(tmp, "media");
mkdirSync(m);
console.log("media ->", tmp);
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-shortest", "-pix_fmt", "yuv420p", join(m, "a.mp4"));
ff("-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=660:duration=6", "-shortest", "-pix_fmt", "yuv420p", join(m, "b.mp4"));
ff("-f", "lavfi", "-i", "color=c=blue:size=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", join(m, "silent.mp4"));
ff("-f", "lavfi", "-i", "gradients=size=400x400:n=3", "-frames:v", "1", join(m, "p.png"));

const P = join(tmp, "proj");
api.create(P, { preset: "720p" });
const apply = async (ops: any[], dryRun = false) => (await api.apply(P, ops, { dryRun })).results;
const one = async (o: any, dryRun = false) => (await apply([o], dryRun))[0];
async function fails(o: any, code: string, name: string) {
  try { await one(o); check(name, false, "no error"); }
  catch (e: any) { check(name, e.code === code && !!e.hint, { code: e.code, message: e.message, hint: e.hint }); }
}
const tl = () => api.info(P, "json").timeline;
const clip = (id: string) => tl().tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id);

await apply([
  { op: "add_clip", track: "main", src: join(m, "a.mp4"), in: 1, duration: 3 },   // vid1 0..3
  { op: "add_clip", track: "main", src: join(m, "b.mp4"), in: 1.5, duration: 3 }, // vid2 3..6
  { op: "add_clip", track: "main", src: join(m, "a.mp4"), in: 0, duration: 2 },   // vid3 6..8
  { op: "add_clip", track: "overlay", src: join(m, "silent.mp4"), at: 0, duration: 1, size: ["20%", "20%"] }, // vid4
  { op: "add_clip", track: "overlay", src: join(m, "p.png"), at: 1, duration: 1, size: ["20%", "20%"] },     // img1
]);

console.log("detach_audio");
const d = await one({ op: "detach_audio", id: "vid1" });
check("detach returns ids", d.id === "vid1" && d.audio === "aud1" && d.track === "dialogue", d);
const a1 = clip("aud1"), dlg = tl().tracks.find((t: any) => t.id === "dialogue");
check("dialogue track created (audio, role dialogue)", dlg?.kind === "audio" && dlg.role === "dialogue", dlg);
check("audio clip mirrors video", a1.attach_to === "vid1" && a1.offset === 0 && a1.in === 1 && a1.duration === 3 && a1.start === 0 && a1.asset === clip("vid1").asset, a1);
check("video muted", clip("vid1").muted === true);
await fails({ op: "detach_audio", id: "vid1" }, "already_detached", "detach twice -> already_detached");
await fails({ op: "detach_audio", id: "vid4" }, "no_audio", "silent video -> no_audio");
await fails({ op: "detach_audio", id: "img1" }, "bad_type", "image -> bad_type");
await fails({ op: "detach_audio", id: "aud1" }, "bad_type", "audio clip -> bad_type");
await fails({ op: "detach_audio", id: "vid1", track: "main" }, "already_detached", "already detached wins over bad track");
await fails({ op: "detach_audio", id: "vid3", track: "main" }, "bad_track", "non-audio track -> bad_track");
await fails({ op: "detach_audio" }, "missing_arg", "missing id -> missing_arg");

console.log("j_cut");
const j = await one({ op: "j_cut", id: "main#1", seconds: 0.5, crossfade: 0.2 });
const a2 = clip("aud2");
check("auto-detached", j.detached === true && j.audio === "aud2" && clip("vid2").muted === true, j);
check("audio leads by 0.5", near(a2.in, 1.0) && near(a2.offset, -0.5) && near(a2.duration, 3.5) && near(a2.start, 2.5) && a2.fade_in === 0.2, a2);
check("picture unchanged", near(clip("vid2").start, 3) && near(clip("vid2").duration, 3) && near(clip("vid2").in, 1.5));
check("reports previous audio underneath", j.under?.includes("aud1"), j);
const jc = await one({ op: "j_cut", id: "vid2", seconds: 5 }, true);
check("lead clamped to source in-point", jc.clamped?.applied === 1 && near(jc.audio_in, 0) && near(jc.audio_start, 1.5) && jc.clamped.reason === "source media", jc);
await fails({ op: "j_cut", id: "main#0", seconds: 0.5 }, "out_of_range", "j_cut on clip at 0 -> out_of_range");
await fails({ op: "j_cut", id: "vid2", seconds: -1 }, "bad_amount", "negative seconds -> bad_amount");
await fails({ op: "j_cut", id: "vid2" }, "missing_arg", "missing seconds -> missing_arg");

console.log("l_cut");
const l = await one({ op: "l_cut", id: "vid1", seconds: 1 });
check("audio tail +1", near(clip("aud1").duration, 4) && near(clip("aud1").in, 1) && near(clip("aud1").start, 0) && near(clip("vid1").duration, 3), clip("aud1"));
check("l_cut reports overlap", l.under?.includes("aud2"), l);
const lc = await one({ op: "l_cut", id: "aud1", seconds: 10 }, true);
check("tail clamped to source end (accepts audio id)", lc.clamped?.applied === 1 && near(lc.audio_duration, 5), lc);

console.log("slip_clip");
const s = await one({ op: "slip_clip", id: "vid2", by: 0.5 });
check("video slipped", near(s.in, 2) && near(clip("vid2").start, 3) && near(clip("vid2").duration, 3), s);
check("detached audio slipped too", near(clip("aud2").in, 1.5) && near(clip("aud2").start, 2.5), clip("aud2"));
await fails({ op: "slip_clip", id: "vid2", by: -3 }, "out_of_range", "slip before source start -> out_of_range");
await fails({ op: "slip_clip", id: "vid2", by: 1.6 }, "out_of_range", "slip past source end -> out_of_range");
await fails({ op: "slip_clip", id: "img1", by: 0.5 }, "bad_type", "slip image -> bad_type");

console.log("roll_edit (magnetic)");
const r = await one({ op: "roll_edit", id: "main#1", by: 0.5 });
check("cut moved later", near(clip("vid2").duration, 3.5) && near(clip("vid3").in, 0.5) && near(clip("vid3").duration, 1.5) && near(clip("vid3").start, 6.5), r);
check("outgoing detached audio rolled", near(clip("aud2").duration, 4) && near(clip("aud2").in, 1.5), clip("aud2"));
check("total length unchanged", near(api.info(P).duration, 8));
await fails({ op: "roll_edit", id: "main#-1", by: 0.5 }, "no_next", "roll last clip -> no_next");
await fails({ op: "roll_edit", id: "vid2", by: -4 }, "out_of_range", "roll too far -> out_of_range");
await fails({ op: "roll_edit", id: "vid2", by: 1.2 }, "out_of_range", "roll past source -> out_of_range");

console.log("slide_clip (magnetic)");
const sl = await one({ op: "slide_clip", id: "vid2", by: -0.5 });
check("prev shortened, next extended", near(clip("vid1").duration, 2.5) && near(clip("vid3").in, 0) && near(clip("vid3").duration, 2) && near(clip("vid2").start, 2.5), sl);
check("prev detached audio follows, slid clip audio follows", near(clip("aud1").duration, 3.5) && near(clip("aud2").start, 2), [clip("aud1"), clip("aud2")]);
check("content of slid clip unchanged", near(clip("vid2").in, 2) && near(clip("vid2").duration, 3.5));
check("total length still 8", near(api.info(P).duration, 8));
await fails({ op: "slide_clip", id: "main#0", by: 0.5 }, "no_neighbour", "slide first magnetic clip -> no_neighbour");
await fails({ op: "slide_clip", id: "vid2", by: -2.5 }, "out_of_range", "slide past prev -> out_of_range");

console.log("non-magnetic track");
await apply([
  { op: "add_track", id: "b", kind: "video" },
  { op: "add_clip", track: "b", src: join(m, "a.mp4"), in: 1, at: 0, duration: 2, id: "n1" },
  { op: "add_clip", track: "b", src: join(m, "a.mp4"), in: 2, at: 2, duration: 2, id: "n2" },
  { op: "add_clip", track: "b", src: join(m, "p.png"), at: 6, duration: 1, id: "n3" },
]);
await one({ op: "roll_edit", id: "n1", by: 0.5 });
check("roll: n1 longer, n2 starts later with later in", near(clip("n1").duration, 2.5) && near(clip("n2").start, 2.5) && near(clip("n2").in, 2.5) && near(clip("n2").duration, 1.5), [clip("n1"), clip("n2")]);
await fails({ op: "roll_edit", id: "n2", by: 0.5 }, "not_adjacent", "roll with a gap -> not_adjacent");
const ns = await one({ op: "slide_clip", id: "n2", by: 0.5 });
check("slide: touching prev grows, n2 moves", near(clip("n1").duration, 3) && near(clip("n2").start, 3) && near(clip("n2").in, 2.5) && !ns.next && !ns.overlaps, ns);
const ov = await one({ op: "slide_clip", id: "n2", by: 2 }, true);
check("slide into a non-touching neighbour reports overlap", ov.overlaps?.includes("n3") && near(ov.start, 5), ov);
await fails({ op: "slide_clip", id: "n1", by: -1 }, "out_of_range", "slide before 0 -> out_of_range");
const n3 = await one({ op: "slide_clip", id: "n3", by: -1 });
check("slide with no touching neighbours just shifts", near(n3.start, 5) && !n3.prev && !n3.next, n3);

console.log("reverse / pure timeline");
{
  const t = newTimeline(640, 360, 30);
  t.assets.v = { path: "/none.mp4", kind: "video", duration: 10, has_audio: true };
  t.tracks[0].clips = [{ id: "x1", type: "video", asset: "v", in: 0, duration: 2 }, { id: "x2", type: "video", asset: "v", in: 4, duration: 2, reverse: true, keyframes: { volume: [[0, 1], [1, 0.5]] } }];
  const [out, res] = applyOps(null as any, t, [{ op: "j_cut", id: "x2", seconds: 1 }, { op: "l_cut", id: "x2", seconds: 1 }]);
  const au = out.tracks.flatMap((tr) => tr.clips).find((c) => c.id === res[0].audio)!;
  check("reverse j_cut keeps in, l_cut lowers in", au.reverse && near(au.in as number, 3) && near(au.duration as number, 4) && near(au.start as number, 1), au);
  check("volume keyframes shift with the head", near(au.keyframes.volume[0][0], 1) && near(au.keyframes.volume[1][0], 2), au.keyframes);
}

console.log("match_duration by clip reference");
{
  const base = () => {
    const t = newTimeline(640, 360, 30);
    t.assets.i = { path: "/none.png", kind: "image" };
    t.assets.s = { path: "/none.wav", kind: "audio", duration: 20 };
    return applyOps(null as any, t, [
      { op: "add_clip", track: "main", asset: "i", id: "img1", duration: 2 },
      { op: "add_clip", track: "main", asset: "i", id: "img2", duration: 2 },
      { op: "add_clip", track: "main", asset: "i", id: "img3", duration: 2 },
      { op: "add_clip", track: "voice", asset: "s", type: "audio", id: "vo1", at: 0, duration: 3 },
    ])[0];
  };
  const run = (t: any, ops: any[]) => applyOps(null as any, t, ops);
  const at = (t: any, id: string) => t.tracks.flatMap((tr: any) => tr.clips).find((c: any) => c.id === id);
  let t = run(base(), [{ op: "update_clip", id: "img2", match_duration: "voice#-1" }])[0];
  check("a reference sets the duration and keeps the magnetic start", at(t, "img2").duration === 3 && at(t, "img2").start === 2 && at(t, "img3").start === 5 && at(t, "img2").match_duration === "vo1", at(t, "img2"));
  t = run(t, [{ op: "update_clip", id: "vo1", duration: 5 }])[0];
  check("a later change to the target updates the clip length", at(t, "img2").duration === 5 && at(t, "img3").start === 7, [at(t, "img2"), at(t, "img3")]);
  t = run(t, [{ op: "update_clip", id: "img2", end_offset: -0.5 }])[0];
  check("negative end_offset holds longer", near(at(t, "img2").duration, 5.5) && near(at(t, "img3").start, 7.5), at(t, "img2"));
  t = run(t, [{ op: "update_clip", id: "img2", end_offset: 1 }])[0];
  check("end_offset stops before the target ends", near(at(t, "img2").duration, 4) && near(at(t, "img3").start, 6), at(t, "img2"));
  t = run(t, [{ op: "update_clip", id: "img2", match_duration: null, end_offset: null }])[0];
  check("null un-follows and keeps the length", at(t, "img2").match_duration === undefined && near(at(t, "img2").duration, 4), at(t, "img2"));
  t = run(base(), [{ op: "add_clip", track: "main", asset: "i", id: "img4", match_duration: "vo1", end_offset: 1 }])[0];
  check("add_clip takes a reference", at(t, "img4").duration === 2 && at(t, "img4").start === 6, at(t, "img4"));
  t = run(base(), [{ op: "add_clip", track: "overlay", asset: "i", id: "ovl", attach_to: "img1", offset: 0.5, match_duration: "vo1" }])[0];
  check("a reference with attach_to: start from the attachment, length from the reference", near(at(t, "ovl").start, 0.5) && at(t, "ovl").duration === 3, at(t, "ovl"));

  // a chain, listed in the opposite order
  t = run(base(), [
    { op: "add_clip", track: "overlay", asset: "i", id: "cA", at: 0, duration: 1 }, { op: "add_clip", track: "overlay", asset: "i", id: "cB", at: 0, duration: 1 },
    { op: "update_clip", id: "cA", match_duration: "cB", end_offset: 0.5 }, { op: "update_clip", id: "cB", match_duration: "vo1", end_offset: 0.5 },
  ])[0];
  check("a chain resolves", near(at(t, "cB").duration, 2.5) && near(at(t, "cA").duration, 2), [at(t, "cA"), at(t, "cB")]);
  t = run(t, [{ op: "update_clip", id: "vo1", duration: 6 }])[0];
  check("changing the end of the chain updates its start", near(at(t, "cB").duration, 5.5) && near(at(t, "cA").duration, 5), [at(t, "cA"), at(t, "cB")]);

  // bad references: bad_ref, nothing written
  const Q = join(tmp, "proj-ref");
  api.create(Q, { preset: "720p" });
  await api.apply(Q, [
    { op: "add_clip", track: "main", src: join(m, "p.png"), id: "img1", duration: 2 },
    { op: "add_clip", track: "main", src: join(m, "p.png"), id: "img2", duration: 2 },
    { op: "add_clip", track: "overlay", text: "vo", id: "vo1", at: 0, duration: 3 },
    { op: "add_clip", track: "overlay", text: "x", id: "cA", at: 0, duration: 1 }, { op: "add_clip", track: "overlay", text: "x", id: "cB", at: 0, duration: 1 }, { op: "add_clip", track: "overlay", text: "x", id: "cC", at: 0, duration: 1 },
    { op: "add_clip", track: "overlay", text: "x", id: "ue", at: 0, until_end: true },
    { op: "add_clip", track: "text", text: "x", id: "att", attach_to: "img1", offset: 0.1, match_duration: true },
    { op: "update_clip", id: "cA", match_duration: "cB" }, { op: "update_clip", id: "cB", match_duration: "cC" },
  ]);
  const rev = () => api.info(Q, "json").timeline.revision;
  const r0 = rev();
  for (const [name, ops] of [
    ["unknown id", [{ op: "update_clip", id: "img2", match_duration: "nope" }]],
    ["unknown ref", [{ op: "update_clip", id: "img2", match_duration: "overlay#99" }]],
    ["unknown track", [{ op: "update_clip", id: "img2", match_duration: "nowhere#0" }]],
    ["itself", [{ op: "update_clip", id: "img2", match_duration: "img2" }]],
    ["a 2-cycle", [{ op: "update_clip", id: "cB", match_duration: "cA" }]],
    ["a 3-cycle", [{ op: "update_clip", id: "cC", match_duration: "cA" }]],
    ["a cycle inside one batch", [{ op: "update_clip", id: "img2", match_duration: "vo1" }, { op: "update_clip", id: "vo1", match_duration: "img2" }]],
    ["an until_end target", [{ op: "update_clip", id: "img2", match_duration: "ue" }]],
    ["an attach-derived target", [{ op: "update_clip", id: "img2", match_duration: "att" }]],
    ["add_clip, unknown id", [{ op: "add_clip", track: "main", src: join(m, "p.png"), match_duration: "nope" }]],
  ] as [string, any[]][]) {
    try { await api.apply(Q, ops); check(`${name}: bad_ref`, false, "no error"); }
    catch (e: any) { check(`${name}: bad_ref, a hint, nothing written`, e.code === "bad_ref" && !!e.hint && rev() === r0, { code: e.code, message: e.message, hint: e.hint }); }
  }
  check("the unknown-id hint suggests a name", await api.apply(Q, [{ op: "update_clip", id: "img1", match_duration: "img22" }]).then(() => "", (e: any) => e.hint) === "did you mean 'img2'?");
  const qi = api.info(Q, "json");
  await api.apply(Q, [{ op: "update_clip", id: "img2", match_duration: "vo1" }]);
  const qi2 = api.info(Q, "json");
  check("project_info shows the resolved duration", qi.errors === 0 && qi2.errors === 0 && qi2.timeline.tracks[0].clips[1].duration === 3 && near(qi2.duration, 5), qi2.timeline.tracks[0].clips);

  // remove_clip of the target
  t = run(base(), [{ op: "update_clip", id: "img2", match_duration: "vo1", end_offset: 0.5 }])[0];
  let [t2, [rm]] = run(t, [{ op: "remove_clip", id: "vo1" }]);
  check("remove_clip of the target keeps the follower with a plain duration", at(t2, "img2") && near(at(t2, "img2").duration, 2.5) && at(t2, "img2").match_duration === undefined && at(t2, "img2").end_offset === undefined && JSON.stringify(rm.unlinked_durations) === '["img2"]' && !rm.removed_attached.length, { rm, c: at(t2, "img2") });
  t = run(base(), [
    { op: "add_clip", track: "overlay", asset: "i", id: "box", at: 0, duration: 1 },
    { op: "add_clip", track: "overlay", asset: "i", id: "tag", attach_to: "box", offset: 0, duration: 2, at: 0 },
    { op: "add_clip", track: "main", asset: "i", id: "img4", match_duration: "tag" },
  ])[0];
  [t2, [rm]] = run(t, [{ op: "remove_clip", id: "box" }]);
  check("removing an attached target unlinks its followers too", JSON.stringify(rm.removed_attached) === '["tag"]' && JSON.stringify(rm.unlinked_durations) === '["img4"]' && at(t2, "img4").match_duration === undefined && at(t2, "img4").duration === 2, { rm, c: at(t2, "img4") });

  // split / duplicate
  t = run(base(), [{ op: "update_clip", id: "img2", match_duration: "vo1", end_offset: 1 }])[0]; // img2: 2..4 (2 s)
  let [t3, [sp]] = run(t, [{ op: "split_clip", id: "img2", at: 3 }]);
  const [l, r] = [at(t3, sp.left), at(t3, sp.right)];
  check("split of a follower: both halves keep their length and drop the reference", l.duration === 1 && r.duration === 1 && l.match_duration === undefined && r.match_duration === undefined && l.end_offset === undefined && r.end_offset === undefined, { l, r });
  t3 = run(t3, [{ op: "update_clip", id: "vo1", duration: 9 }])[0];
  check("  and a later change of the target leaves them alone", at(t3, sp.left).duration === 1 && at(t3, sp.right).duration === 1);
  [t3, [sp]] = run(t, [{ op: "split_clip", id: "vo1", at: 1.5 }]);
  check("split of the target: the follower keeps following the left half", at(t3, "img2").match_duration === "vo1" && near(at(t3, "img2").duration, 0.5), at(t3, "img2"));
  [t3, [sp]] = run(t, [{ op: "duplicate_clip", id: "img2" }]);
  check("duplicate keeps the reference", at(t3, sp.id).match_duration === "vo1" && at(t3, sp.id).end_offset === 1 && near(at(t3, sp.id).duration, 2), at(t3, sp.id));

  // hand-edited timelines
  const bad = (name: string, edit: (x: any) => void) => {
    const x = structuredClone(run(base(), [{ op: "update_clip", id: "img2", match_duration: "vo1" }])[0]);
    edit(x);
    const e = validate(x).filter((i: any) => i.level === "error" && /<img2>\.match_duration$/.test(i.path));
    check(`validate: ${name}`, e.length === 1, validate(x).filter((i: any) => i.level === "error"));
  };
  bad("a missing clip", (x) => { at(x, "img2").match_duration = "ghost"; });
  { const x = structuredClone(run(base(), [{ op: "update_clip", id: "img2", match_duration: "vo1" }])[0]); at(x, "img2").match_duration = "ghost";
    check("validate: the missing-clip hint does not offer true", validate(x).find((i: any) => /<img2>\.match_duration$/.test(i.path))?.hint === "name an existing clip id, or remove match_duration"); }
  bad("until_end together with a followed length", (x) => { at(x, "img2").until_end = true; });
  bad("itself", (x) => { at(x, "img2").match_duration = "img2"; });
  bad("a cycle", (x) => { at(x, "vo1").match_duration = "img2"; at(x, "img2").match_duration = "vo1"; });
  bad("an until_end target", (x) => { at(x, "vo1").until_end = true; });
  bad("a match_duration:true target", (x) => { at(x, "vo1").attach_to = "img1"; at(x, "vo1").match_duration = true; });
  { const x = structuredClone(run(base(), [{ op: "update_clip", id: "img2", match_duration: "vo1" }])[0]); at(x, "vo1").match_duration = true;
    check("validate: match_duration:true without attach_to is a plain length, so a good target", !validate(x).some((i: any) => i.level === "error"), validate(x)); }
  bad("a number", (x) => { at(x, "img2").match_duration = 5; });
  { // one resolve() of a hand-edited project: followers settle before the magnetic layout, so the clip after a follower moves with it
    const x = structuredClone(run(base(), [{ op: "update_clip", id: "img2", match_duration: "vo1" }])[0]);
    at(x, "vo1").duration = 5;
    resolve(x);
    check("resolve once: a follower settles before the magnetic layout", at(x, "img2").duration === 5 && at(x, "img3").start === 7, [at(x, "img2"), at(x, "img3")]);
  }
  const ok = structuredClone(run(base(), [{ op: "update_clip", id: "img2", match_duration: "vo1" }])[0]);
  check("validate: a good reference is clean", !validate(ok).some((i: any) => i.level === "error"), validate(ok));

  // match_duration:true with attach_to, as before
  t = run(base(), [{ op: "add_clip", track: "overlay", asset: "i", id: "ovl", attach_to: "img1", offset: 0.3, match_duration: true, end_offset: 0.2 }])[0];
  check("match_duration:true with attach_to: target - offset - end_offset", near(at(t, "ovl").duration, 1.5) && near(at(t, "ovl").start, 0.3), at(t, "ovl"));
  t = run(t, [{ op: "update_clip", id: "img1", duration: 4 }])[0];
  check("  and it follows the target", near(at(t, "ovl").duration, 3.5), at(t, "ovl"));

  // computed durations are not silently overwritten
  const refuses = (tt: any, ops: any[], name: string, hint: RegExp) => {
    try { run(tt, ops); check(name, false, "no error"); }
    catch (e: any) { check(name, e.code === "computed_duration" && hint.test(e.hint ?? ""), { code: e.code, message: e.message, hint: e.hint }); }
  };
  const fol = run(base(), [{ op: "add_clip", track: "main", asset: "i", id: "img4", duration: 2 }, { op: "update_clip", id: "img2", match_duration: "vo1" },
    { op: "add_clip", track: "overlay", asset: "i", id: "ovl", attach_to: "img1", offset: 0.3, match_duration: true }])[0];
  const R1 = /follows 'vo1'.*end_offset.*match_duration=null/;
  refuses(fol, [{ op: "update_clip", id: "img2", duration: 1 }], "update_clip duration on a follower is refused", R1);
  refuses(fol, [{ op: "update_clip", id: "img2", set: { duration: 1 } }], "  also through set", R1);
  refuses(fol, [{ op: "update_clip", id: "ovl", duration: 1 }], "update_clip duration on an attached match_duration:true clip is refused", /attach_to target 'img1'.*match_duration=null/);
  for (const [k, v] of [["duration", 1], ["end", 1], ["trim_start", 0.5], ["trim_end", 0.5]] as const)
    refuses(fol, [{ op: "trim_clip", id: "img2", [k]: v }], `trim_clip ${k} on a follower is refused`, R1);
  refuses(fol, [{ op: "roll_edit", id: "img1", by: 0.2 }], "roll_edit with a follower on the right is refused", R1);
  refuses(fol, [{ op: "roll_edit", id: "img2", by: 0.2 }], "roll_edit with a follower on the left is refused", R1);
  refuses(fol, [{ op: "slide_clip", id: "img3", by: 0.2 }], "slide_clip next to a follower is refused", R1);
  {
    const [x, [u]] = run(fol, [{ op: "update_clip", id: "img2", duration: 1, match_duration: null, end_offset: null }]);
    check("update_clip may set duration while it drops match_duration", u.duration === 1 && at(x, "img2").match_duration === undefined && at(x, "img3").start === 3, [u, at(x, "img3")]);
    const [, [u2]] = run(fol, [{ op: "update_clip", id: "img2", end_offset: 1 }]);
    check("end_offset is the allowed edit, and the result is post-resolve", u2.duration === 2, u2);
    const [y, [sl]] = run(fol, [{ op: "slide_clip", id: "img2", by: 0.2 }]);
    check("slide_clip of the follower itself still works", sl.id === "img2" && sl.duration === at(y, "img2").duration, sl);
  }
  {
    const t0 = base();
    t0.assets.v = { path: "/none.mp4", kind: "video", duration: 10, has_audio: true };
    const [x1] = run(t0, [{ op: "add_clip", track: "main", asset: "v", id: "vid1", in: 1, duration: 2 }, { op: "detach_audio", id: "vid1" }]);
    const aud = x1.tracks.flatMap((tr: any) => tr.clips).find((c: any) => c.type === "audio" && c.attach_to === "vid1").id;
    const [x2] = run(x1, [{ op: "update_clip", id: aud, match_duration: "vo1" }]);
    refuses(x2, [{ op: "j_cut", id: "vid1", seconds: 0.5 }], "j_cut on a computed-length audio clip is refused", R1);
  }
  {
    const [x, [sn]] = run(fol, [{ op: "snap_to_beats", track: "main", beats: [0, 1, 2, 3, 4, 5, 6] }]);
    check("snap_to_beats keeps computed clips and lists them", JSON.stringify(sn.kept_computed) === '["img2"]' && x && at(x, "img2").match_duration === "vo1" && at(x, "img2").duration === 3, sn);
    check("  and retimed lists the values that were applied", sn.retimed.length > 0 && sn.retimed.every((r: any) => at(x, r.id).duration === r.duration) && !sn.retimed.some((r: any) => r.id === "img2"), sn);
  }

  // match_duration:true without attach_to is a plain length, so a clip can follow it
  t = run(base(), [{ op: "add_clip", track: "overlay", asset: "i", id: "plain", at: 0, duration: 2, match_duration: true }, { op: "update_clip", id: "img2", match_duration: "plain" }])[0];
  check("a match_duration:true clip without attach_to can be followed", at(t, "img2").duration === 2, at(t, "img2"));

  // until_end and a followed length
  for (const [name, ops] of [
    ["add_clip", [{ op: "add_clip", track: "overlay", asset: "i", id: "u1", until_end: true, match_duration: "vo1" }]],
    ["update_clip until_end on a follower", [{ op: "update_clip", id: "img2", match_duration: "vo1" }, { op: "update_clip", id: "img2", until_end: true }]],
    ["update_clip a reference on an until_end clip", [{ op: "add_clip", track: "overlay", asset: "i", id: "u1", until_end: true }, { op: "update_clip", id: "u1", match_duration: "vo1" }]],
  ] as [string, any[]][]) {
    try { run(base(), ops); check(`${name}: until_end with a followed length is refused`, false, "no error"); }
    catch (e: any) { check(`${name}: until_end with a followed length is refused`, e.code === "bad_value" && /until_end and match_duration both set the length; keep one/.test(e.message) && !!e.hint, { code: e.code, message: e.message }); }
  }

  // clips that lose their target by remove_track / remove_asset force keep their length
  t = run(base(), [{ op: "update_clip", id: "img2", match_duration: "vo1", end_offset: 0.5 }])[0];
  let [t4, [rt]] = run(t, [{ op: "remove_track", id: "voice" }]);
  check("remove_track: a follower of a removed clip keeps its length", JSON.stringify(rt.unlinked_durations) === '["img2"]' && at(t4, "img2").match_duration === undefined && at(t4, "img2").end_offset === undefined && near(at(t4, "img2").duration, 2.5), { rt, c: at(t4, "img2") });
  check("  and the timeline is valid", !validate(t4).some((i: any) => i.level === "error"), validate(t4));
  [t4, [rt]] = run(t, [{ op: "remove_asset", id: "s", force: true }]);
  check("remove_asset force: a follower of a removed clip keeps its length", JSON.stringify(rt.unlinked_durations) === '["img2"]' && at(t4, "img2").match_duration === undefined && near(at(t4, "img2").duration, 2.5), { rt, c: at(t4, "img2") });
  check("  and the timeline is valid", !validate(t4).some((i: any) => i.level === "error"), validate(t4));

  // freeze_frame and remove_silence: what they create from a follower is a plain clip
  {
    const t0 = base();
    t0.assets.v = { path: "/none.mp4", kind: "video", duration: 10, has_audio: false };
    const [x, rs] = run(t0, [{ op: "add_clip", track: "overlay", asset: "v", id: "vid1", at: 0, duration: 1 }, { op: "update_clip", id: "vid1", match_duration: "vo1" },
      { op: "freeze_frame", id: "vid1", at: 0, duration: 1.5 }]);
    const fz = rs[2];
    check("freeze_frame: the freeze clip is plain and keeps its length", at(x, fz.id).match_duration === undefined && at(x, fz.id).end_offset === undefined && at(x, fz.id).duration === 1.5 && at(x, "vid1").match_duration === "vo1", { fz, c: at(x, fz.id) });
    const [x2, rs2] = run(t0, [{ op: "add_clip", track: "overlay", asset: "v", id: "vid1", at: 0, duration: 1 }, { op: "update_clip", id: "vid1", match_duration: "vo1" },
      { op: "freeze_frame", id: "vid1", at: 1.5, duration: 1 }]);
    const fz2 = rs2[2];
    check("freeze_frame inside a follower: both halves and the freeze clip are plain", [at(x2, "vid1"), at(x2, fz2.id)].every((c: any) => c.match_duration === undefined) && !x2.tracks.flatMap((tr: any) => tr.clips).some((c: any) => c.match_duration), x2.tracks.flatMap((tr: any) => tr.clips).map((c: any) => [c.id, c.match_duration, c.duration]));
  }
  {
    await api.apply(Q, [{ op: "add_clip", track: "overlay", src: join(m, "a.mp4"), id: "vs1", at: 0, duration: 2 }, { op: "update_clip", id: "vs1", match_duration: "vo1", end_offset: 0.5 }]);
    const r = (await api.apply(Q, [{ op: "remove_silence", id: "vs1" }])).results[0];
    const vs = api.info(Q, "json").timeline.tracks.flatMap((tr: any) => tr.clips).filter((c: any) => r.segments.includes(c.id));
    check("remove_silence: the segments of a follower are plain clips", vs.length > 0 && vs.every((c: any) => c.match_duration === undefined && c.end_offset === undefined && typeof c.duration === "number"), { r, vs });
  }
  {
    const text = (id: string) => String(api.info(Q).summary).split("\n").find((l: string) => l.includes(` ${id} `) || l.includes(` ${id}  `)) ?? "";
    await api.apply(Q, [{ op: "update_clip", id: "img2", end_offset: 0.5 }]);
    const a1 = text("img2");
    await api.apply(Q, [{ op: "update_clip", id: "img2", end_offset: -0.3 }]);
    const a2 = text("img2");
    check("the summary shows end_offset with its sign", a1.includes("length→vo1-0.5") && a2.includes("length→vo1+0.3"), [a1, a2]);
  }
}

console.log("validity + render");
const inf = api.info(P);
check("timeline valid", inf.errors === 0, inf.issues);
const out = join(P, "renders", "jcut.mp4");
const rr: any = await api.render(P, { draft: true, sheet: false, out, end: 4 });
check("draft render", rr.frames > 0, rr);
const pr: any = api.probe(out);
check("render has audio", pr.has_audio && near(pr.duration, 4, 0.15), pr);
// B's 660 Hz tone starts in the J-cut lead (2.0..2.5), under A's 440 Hz, before B's picture (2.5)
const tone = (ss: number) => {
  const x = spawnSync("ffmpeg", ["-v", "info", "-nostdin", "-ss", String(ss), "-t", "0.3", "-i", out, "-af", "bandpass=f=660:width_type=q:w=20,volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(x.stderr)?.[1] ?? -99);
};
const [before, lead] = [tone(1.4), tone(2.1)];
check("B's audio is heard in the J-cut lead", lead - before > 12, { before, lead });

console.log(`\n${failures ? `✗ ${failures} check(s) failed` : "OK - all checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s  (${tmp})`);
if (!process.argv.includes("--keep") && !failures) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
