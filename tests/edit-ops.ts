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

console.log("pieces of an attached clip keep their place and length");
{
  const run = (t: any, ops: any[]) => applyOps(null as any, t, ops);
  const at = (t: any, id: string) => t.tracks.flatMap((tr: any) => tr.clips).find((c: any) => c.id === id);
  const valid = (name: string, t: any) => check(`${name}: validation is clean`, !validate(t).some((i: any) => i.level === "error"), validate(t));
  const base = () => {
    const t = newTimeline(640, 360, 30);
    t.assets.i = { path: "/none.png", kind: "image" };
    t.assets.v = { path: "/none.mp4", kind: "video", duration: 10, has_audio: false };
    t.assets.av = { path: "/none2.mp4", kind: "video", duration: 10, has_audio: true };
    return applyOps(null as any, t, [
      { op: "add_clip", track: "main", asset: "i", id: "img1", duration: 4 },
      { op: "add_clip", track: "main", asset: "i", id: "img2", duration: 2 },
      { op: "add_clip", track: "overlay", asset: "v", id: "ovl", attach_to: "img1", offset: 0.5, in: 1, duration: 2 },
    ])[0];
  };
  // plain duration
  let [t, [sp]] = run(base(), [{ op: "split_clip", id: "ovl", at: 1.5 }]);
  let [l, r] = [at(t, sp.left), at(t, sp.right)];
  check("split of an attached clip: the left keeps its place, the right starts at the split time", near(l.start, 0.5) && near(r.start, 1.5) && near(l.offset, 0.5) && near(r.offset, 1.5), { l, r });
  check("  both stay attached to the same target and the lengths sum to the original", l.attach_to === "img1" && r.attach_to === "img1" && near(l.duration + r.duration, 2) && near(r.in, 2), { l, r });
  valid("split of an attached clip", t);
  // retime the target
  const [t3] = run(t, [{ op: "move_clip", id: "img1", index: 1 }]);
  check("moving the target moves both halves and keeps their gap", near(at(t3, "img1").start, 2) && near(at(t3, sp.left).start, 2.5) && near(at(t3, sp.right).start, 3.5), [at(t3, sp.left), at(t3, sp.right)]);
  valid("retimed target", t3);
  // computed length
  const [tm, [, spm]] = run(base(), [{ op: "update_clip", id: "ovl", match_duration: true, end_offset: 0.5 }, { op: "split_clip", id: "ovl", at: 2 }]);
  [l, r] = [at(tm, "ovl"), at(tm, spm.right)];
  check("split with a computed length: plain durations that sum to the original, no match_duration/end_offset", near(l.duration, 1.5) && near(r.duration, 1.5) && near(l.start, 0.5) && near(r.start, 2) && [l, r].every((c: any) => c.match_duration === undefined && c.end_offset === undefined), { l, r });
  valid("split with a computed length", tm);
  const [tm3] = run(tm, [{ op: "update_clip", id: "img1", duration: 6 }]);
  check("  a later change of the target leaves the lengths alone", near(at(tm3, "ovl").duration, 1.5) && near(at(tm3, spm.right).duration, 1.5), [at(tm3, "ovl"), at(tm3, spm.right)]);
  // freeze_frame (a later clip attached to a main clip, and a clip attached to that one, shift too)
  const fbase = run(base(), [
    { op: "add_clip", track: "overlay", asset: "i", id: "tail", attach_to: "img2", offset: 0, duration: 1 },
    { op: "add_clip", track: "overlay", asset: "i", id: "sub", attach_to: "tail", offset: 0.25, duration: 0.5 },
  ])[0];
  check("freeze setup: the later clips sit where expected", near(at(fbase, "tail").start, 4) && near(at(fbase, "sub").start, 4.25), [at(fbase, "tail"), at(fbase, "sub")]);
  const [tf, rf] = run(fbase, [{ op: "freeze_frame", id: "ovl", at: 1.5, duration: 1 }]);
  const fz = at(tf, rf[0].id), fl = at(tf, "ovl"), fr = tf.tracks.flatMap((tr: any) => tr.clips).find((c: any) => c.type === "video" && c.id !== "ovl" && !c.freeze);
  check("freeze_frame on an attached clip: the freeze clip is attached and placed at the freeze time", fz.attach_to === "img1" && near(fz.start, 1.5) && near(fz.duration, 1) && near(fl.start, 0.5) && near(fl.duration, 1), { fz, fl });
  check("  the right part sits after the freeze", fr && near(fr.start, 2.5) && near(fr.duration, 1) && fr.attach_to === "img1", fr);
  check("  later attached clips move by their offset, and a clip attached to one of them follows once", near(at(tf, "tail").start, 5) && near(at(tf, "sub").start, 5.25), [at(tf, "tail"), at(tf, "sub")]);
  valid("freeze_frame on an attached clip", tf);
  // ripple removal and duplicate: a start written on an attached clip is overwritten by resolve
  const [tr0] = run(base(), [
    { op: "add_clip", track: "overlay", asset: "i", id: "gap", at: 2.5, duration: 0.5 },
    { op: "add_clip", track: "overlay", asset: "i", id: "tail", attach_to: "img2", offset: 0, duration: 1 },
  ]);
  const [tr1] = run(tr0, [{ op: "remove_clip", id: "gap", ripple: true }]);
  check("remove_clip ripple moves a later attached clip by its offset", near(at(tr0, "tail").start, 4) && near(at(tr1, "tail").start, 3.5), [at(tr0, "tail"), at(tr1, "tail")]);
  valid("remove_clip ripple", tr1);
  const [td, [dp]] = run(base(), [{ op: "duplicate_clip", id: "ovl" }]);
  check("duplicate_clip of an attached clip lands after the original, attached to the same target", at(td, dp.id).attach_to === "img1" && near(at(td, dp.id).start, 2.5) && near(at(td, dp.id).offset, 2.5), at(td, dp.id));
  valid("duplicate_clip of an attached clip", td);
  const [tdm, [, dpm]] = run(base(), [{ op: "update_clip", id: "ovl", match_duration: true }, { op: "duplicate_clip", id: "ovl" }]);
  check("duplicate_clip of an attached clip with a computed length: the copy lands after it with the same length, as a plain duration", near(at(tdm, "ovl").duration, 3.5) && near(at(tdm, dpm.id).start, 4) && near(at(tdm, dpm.id).duration, 3.5) && at(tdm, dpm.id).match_duration === undefined && at(tdm, dpm.id).end_offset === undefined && at(tdm, "ovl").match_duration === true, [at(tdm, "ovl"), at(tdm, dpm.id)]);
  valid("duplicate_clip with a computed length", tdm);
  // chain: C and A on one track, B (on another track) attached to C, A attached to B: A follows C once
  const cbase = run(base(), [
    { op: "add_track", id: "ty", kind: "video" },
    { op: "add_clip", track: "overlay", asset: "i", id: "gap", at: 1, duration: 1 },
    { op: "add_clip", track: "overlay", asset: "i", id: "cc", at: 2, duration: 1 },
    { op: "add_clip", track: "ty", asset: "i", id: "bb", attach_to: "cc", offset: 0.5, duration: 2 },
    { op: "add_clip", track: "overlay", asset: "i", id: "aa", attach_to: "bb", offset: 3, duration: 1 },
  ])[0];
  const [tc] = run(cbase, [{ op: "remove_clip", id: "gap", ripple: true }]);
  check("remove_clip ripple: a clip attached through a clip of another track follows once", near(at(cbase, "aa").start, 5.5) && near(at(tc, "cc").start, 1) && near(at(tc, "bb").start, 1.5) && near(at(tc, "aa").start, 4.5), ["cc", "bb", "aa"].map((i) => at(tc, i)));
  valid("remove_clip ripple through a chain", tc);
  // the shifted offset is clamped at 0, so a later move of the target does not leave the clip behind
  const kbase = run(base(), [
    { op: "add_track", id: "ty", kind: "video" },
    { op: "add_clip", track: "ty", asset: "i", id: "mm", at: 0, duration: 6 },
    { op: "add_clip", track: "overlay", asset: "i", id: "gap", at: 0, duration: 3 },
    { op: "add_clip", track: "overlay", asset: "i", id: "att", attach_to: "mm", offset: 1, duration: 1 },
  ])[0];
  const [tk] = run(kbase, [{ op: "remove_clip", id: "gap", ripple: true }]);
  check("remove_clip ripple: the shifted offset stops at the target's start", near(at(tk, "att").start, 0) && near(at(tk, "att").offset, 0), at(tk, "att"));
  const [tk2] = run(tk, [{ op: "move_clip", id: "mm", at: 3 }]);
  check("  and after the target moves the clip is at the target's new start", near(at(tk2, "att").start, 3), at(tk2, "att"));
  // freeze_frame when the target is on the same track, after the freeze time
  const sbase = run(base(), [
    { op: "add_clip", track: "overlay", asset: "i", id: "tt", at: 5, duration: 1 },
    { op: "add_clip", track: "overlay", asset: "v", id: "c0", attach_to: "tt", offset: -4, duration: 3 },
  ])[0];
  check("freeze setup: c0 sits before its target", near(at(sbase, "c0").start, 1) && near(at(sbase, "tt").start, 5), [at(sbase, "c0"), at(sbase, "tt")]);
  const [ts, rsf] = run(sbase, [{ op: "freeze_frame", id: "c0", at: 2, duration: 1 }]);
  const sr = ts.tracks.flatMap((tr: any) => tr.clips).find((c: any) => c.attach_to === "tt" && c.id !== "c0" && !c.freeze);
  check("freeze_frame with the target later on the same track: left, freeze and right are contiguous", near(at(ts, "c0").start, 1) && near(at(ts, "c0").duration, 1) && near(at(ts, rsf[0].id).start, 2) && near(at(ts, rsf[0].id).duration, 1) && sr && near(sr.start, 3) && near(sr.duration, 2) && near(at(ts, "tt").start, 6), [at(ts, "c0"), at(ts, rsf[0].id), sr, at(ts, "tt")]);
  valid("freeze_frame with the target on the same track", ts);
  // freeze_frame through a clip that stays: X (attached to a later clip that shifts) is the freeze clip's target
  const pbase = run(base(), [
    { op: "add_track", id: "x", kind: "video" },
    { op: "add_clip", track: "x", asset: "i", id: "tt", at: 5, duration: 1 },
    { op: "add_clip", track: "x", asset: "i", id: "xx", attach_to: "tt", offset: -4, duration: 1 },
    { op: "add_clip", track: "x", asset: "v", id: "c0", attach_to: "xx", offset: 1, duration: 2 },
  ])[0];
  check("freeze setup: xx at 1, c0 at 2, tt at 5", near(at(pbase, "xx").start, 1) && near(at(pbase, "c0").start, 2) && near(at(pbase, "tt").start, 5), ["xx", "c0", "tt"].map((i) => at(pbase, i)));
  const [tp, [rp]] = run(pbase, [{ op: "freeze_frame", id: "c0", at: 3, duration: 2 }]);
  const pr = tp.tracks.flatMap((tr: any) => tr.clips).find((c: any) => c.type === "video" && c.attach_to === "xx" && c.id !== "c0" && !c.freeze);
  check("freeze_frame when its target stays and follows a shifting clip: freeze at 3, right part at 5, the target stays at 1", near(at(tp, rp.id).start, 3) && near(rp.start, 3) && pr && near(pr.start, 5) && near(at(tp, "xx").start, 1) && near(at(tp, "tt").start, 7), [at(tp, rp.id), pr, at(tp, "xx"), at(tp, "tt")]);
  valid("freeze_frame through a clip that stays", tp);
  // detached audio
  const abase = run(base(), [{ op: "add_clip", track: "main", asset: "av", id: "vid1", in: 1, duration: 2 }, { op: "detach_audio", id: "vid1" }])[0];
  const aud = abase.tracks.flatMap((tr: any) => tr.clips).find((c: any) => c.type === "audio").id;
  check("audio setup: attached to the video", at(abase, aud).attach_to === "vid1" && near(at(abase, aud).start, 6) && at(abase, aud).offset === 0, at(abase, aud));
  const [ta, [sa]] = run(abase, [{ op: "split_clip", id: aud, at: 7 }]);
  [l, r] = [at(ta, sa.left), at(ta, sa.right)];
  check("splitting the audio clip directly: the right half stays attached to the video at its place", l.attach_to === "vid1" && r.attach_to === "vid1" && near(l.start, 6) && near(r.start, 7) && near(r.offset, 1) && near(l.duration + r.duration, 2) && near(r.in, 2), { l, r });
  valid("split of an attached audio clip", ta);
  const [tv, [sv]] = run(abase, [{ op: "split_clip", id: "vid1", at: 7 }]);
  const vr = at(tv, sv.right), al = at(tv, aud), ar = tv.tracks.flatMap((tr: any) => tr.clips).find((c: any) => c.type === "audio" && c.attach_to === sv.right);
  check("splitting the video: its audio splits with it, the right audio follows the right picture", ar && near(al.start, 6) && near(al.duration, 1) && near(ar.start, 7) && near(ar.duration, 1) && near(vr.start, 7) && near(ar.in, 2), { al, ar, vr });
  valid("split of a video with detached audio", tv);
  const [tw, [, sw]] = run(abase, [{ op: "update_clip", id: aud, match_duration: true, end_offset: 0.5 }, { op: "split_clip", id: "vid1", at: 7 }]);
  const wl = at(tw, aud), wr = tw.tracks.flatMap((tr: any) => tr.clips).find((c: any) => c.type === "audio" && c.attach_to === sw.right);
  check("splitting the video: audio with a computed length gets plain lengths on both pieces", wr && near(wl.start, 6) && near(wl.duration, 1) && near(wr.start, 7) && near(wr.duration, 0.5) && [wl, wr].every((c: any) => c.match_duration === undefined && c.end_offset === undefined), { wl, wr });
  valid("split of a video whose audio has a computed length", tw);
  const [tj, [, sj]] = run(abase, [{ op: "j_cut", id: "vid1", seconds: 0.5 }, { op: "split_clip", id: "vid1", at: 7 }]);
  const aj = tj.tracks.flatMap((tr: any) => tr.clips).filter((c: any) => c.type === "audio").sort((x: any, y: any) => x.start - y.start);
  check("splitting a video with J-cut audio: the audio is split at the same time", aj.length === 2 && near(aj[0].start, 5.5) && near(aj[0].duration, 1.5) && near(aj[1].start, 7) && near(aj[1].duration, 1) && aj[1].attach_to === sj.right, aj);
  valid("split of a J-cut video", tj);
  // ops that place an attached clip set its offset: it lands where asked and stays attached
  console.log("ops that place an attached clip move it by offset");
  const refused = (name: string, t: any, ops: any[], code: string) => {
    const before = JSON.stringify(t);
    try { run(t, ops); check(name, false, "no error"); }
    catch (e: any) { check(name, e.code === code && !!e.hint && JSON.stringify(t) === before, { code: e.code, message: e.message, hint: e.hint }); }
  };
  const [m1, [r1]] = run(base(), [{ op: "move_clip", id: "ovl", at: 1 }]);
  check("move_clip at on an attached clip: it lands at the asked time, stays attached, offset updated, result reports the start", near(at(m1, "ovl").start, 1) && at(m1, "ovl").attach_to === "img1" && near(at(m1, "ovl").offset, 1) && near(r1.start, 1), [at(m1, "ovl"), r1]);
  valid("move_clip at on an attached clip", m1);
  const [m2, [r2]] = run(m1, [{ op: "move_clip", id: "ovl", shift: 0.5 }]);
  check("move_clip shift on an attached clip: moves by the amount, offset updated", near(at(m2, "ovl").start, 1.5) && near(at(m2, "ovl").offset, 1.5) && near(r2.start, 1.5), [at(m2, "ovl"), r2]);
  const [m3] = run(m2, [{ op: "move_clip", id: "img1", index: 1 }]);
  check("  and a later move of the target carries it", near(at(m3, "img1").start, 2) && near(at(m3, "ovl").start, 3.5), [at(m3, "img1"), at(m3, "ovl")]);
  valid("move_clip then target move", m3);
  const [m4] = run(base(), [{ op: "move_clip", id: "ovl", shift: -5 }]);
  check("move_clip shift before 0 stops at 0, still attached", near(at(m4, "ovl").start, 0) && near(at(m4, "ovl").offset, 0) && at(m4, "ovl").attach_to === "img1", at(m4, "ovl"));
  const [m5, [r5]] = run(base(), [{ op: "add_track", id: "ty", kind: "video" }, { op: "move_clip", id: "ovl", track: "ty", at: 2 }]);
  check("move_clip of an attached clip to another non-magnetic track: lands there, stays attached, offset updated", m5.tracks.find((x: any) => x.id === "ty")!.clips.some((c: any) => c.id === "ovl") && near(at(m5, "ovl").start, 2) && near(at(m5, "ovl").offset, 2) && at(m5, "ovl").attach_to === "img1" && r5.track === "ty", [at(m5, "ovl"), r5]);
  const [m6] = run(m5, [{ op: "move_clip", id: "img1", index: 1 }]);
  check("  and a later move of the target carries it", near(at(m6, "ovl").start, 4), at(m6, "ovl"));
  valid("move_clip to another track", m6);
  const [m7] = run(base(), [{ op: "add_track", id: "ty", kind: "video" }, { op: "move_clip", id: "ovl", track: "ty" }]);
  check("move_clip to another track without a time keeps the place", near(at(m7, "ovl").start, 0.5) && near(at(m7, "ovl").offset, 0.5), at(m7, "ovl"));
  // magnetic destinations refuse an attached clip
  refused("move_clip of an attached clip into a magnetic track is refused, batch atomic", base(), [{ op: "update_clip", id: "ovl", name: "x" }, { op: "move_clip", id: "ovl", track: "main", index: 1 }], "attached_magnetic");
  refused("duplicate_clip of an attached clip into a magnetic track is refused, batch atomic", base(), [{ op: "update_clip", id: "ovl", name: "x" }, { op: "duplicate_clip", id: "ovl", track: "main" }], "attached_magnetic");
  const hand = base();
  at(hand, "img2").attach_to = "img1";
  refused("move_clip within a magnetic track of an attached clip (hand-edited) is refused", hand, [{ op: "move_clip", id: "img2", index: 0 }], "attached_magnetic");
  refused("add_clip with attach_to onto a magnetic track is refused", base(), [{ op: "add_clip", track: "main", asset: "i", id: "bad", attach_to: "img1", offset: 1, duration: 1 }], "attached_magnetic");
  refused("update_clip attach_to on a clip of a magnetic track is refused", base(), [{ op: "update_clip", id: "img2", attach_to: "img1", offset: 1 }], "attached_magnetic");
  refused("update_track magnetic=true on a track holding an attached clip is refused", base(), [{ op: "update_track", id: "overlay", set: { magnetic: true } }], "attached_magnetic");
  const [m8] = run(base(), [{ op: "update_clip", id: "ovl", attach_to: null }, { op: "move_clip", id: "ovl", track: "main", index: 1 }]);
  check("  after attach_to=null the clip can join the magnetic track", at(m8, "ovl").attach_to === undefined && m8.tracks.find((x: any) => x.id === "main")!.clips.map((c: any) => c.id).join() === "img1,ovl,img2", m8.tracks.find((x: any) => x.id === "main")!.clips.map((c: any) => c.id));
  valid("detached then moved", m8);
  const [m9] = run(base(), [{ op: "move_clip", id: "img2", index: 0 }]);
  check("move_clip within a magnetic track of a plain clip is unchanged", m9.tracks.find((x: any) => x.id === "main")!.clips.map((c: any) => c.id).join() === "img2,img1", m9.tracks.find((x: any) => x.id === "main")!.clips.map((c: any) => c.id));
  // trim_start
  const [n1, [q1]] = run(base(), [{ op: "trim_clip", id: "ovl", trim_start: 0.5 }]);
  check("trim_clip trim_start on an attached clip: start moves by d, in-point by d, the end stays, still attached", near(at(n1, "ovl").start, 1) && near(at(n1, "ovl").in, 1.5) && near(at(n1, "ovl").duration, 1.5) && near(at(n1, "ovl").start + at(n1, "ovl").duration, 2.5) && near(at(n1, "ovl").offset, 1) && at(n1, "ovl").attach_to === "img1" && near(q1.start, 1), [at(n1, "ovl"), q1]);
  valid("trim_start on an attached clip", n1);
  const [n2] = run(base(), [{ op: "update_clip", id: "ovl", speed: 2 }, { op: "trim_clip", id: "ovl", trim_start: 0.5 }]);
  check("  with speed 2 the in-point moves by d*speed", near(at(n2, "ovl").in, 2) && near(at(n2, "ovl").start, 1) && near(at(n2, "ovl").start + at(n2, "ovl").duration, 2.5), at(n2, "ovl"));
  // update_clip start
  const [u1, [s1]] = run(base(), [{ op: "update_clip", id: "ovl", start: 1.5 }]);
  check("update_clip start on an attached clip moves it: offset updated, still attached", near(at(u1, "ovl").start, 1.5) && near(at(u1, "ovl").offset, 1.5) && at(u1, "ovl").attach_to === "img1" && near(s1.start, 1.5), [at(u1, "ovl"), s1]);
  valid("update_clip start on an attached clip", u1);
  refused("update_clip start with offset on an attached clip is refused", base(), [{ op: "update_clip", id: "ovl", set: { start: 1, offset: 1 } }], "bad_value");
  const [u2] = run(base(), [{ op: "update_clip", id: "ovl", set: { start: 5, attach_to: "img2" } }]);
  check("update_clip start with a new attach_to computes the offset against the new target", near(at(u2, "ovl").start, 5) && near(at(u2, "ovl").offset, 1) && at(u2, "ovl").attach_to === "img2", at(u2, "ovl"));
  valid("update_clip start with a new attach_to", u2);
  const [u3] = run(base(), [{ op: "update_clip", id: "ovl", set: { start: 3, attach_to: null } }]);
  check("update_clip start with attach_to null places the plain clip", at(u3, "ovl").attach_to === undefined && near(at(u3, "ovl").start, 3), at(u3, "ovl"));
  // add_transition
  const tbase = run(base(), [{ op: "add_clip", track: "overlay", asset: "i", id: "ov0", at: 0, duration: 2 }])[0];
  const [x1, [y1]] = run(tbase, [{ op: "add_transition", to: "ovl", type: "crossfade", duration: 0.5 }]);
  check("add_transition on an attached clip: start = previous end - duration, offset updated, still attached", near(at(x1, "ovl").start, 1.5) && near(at(x1, "ovl").offset, 1.5) && at(x1, "ovl").attach_to === "img1" && near(y1.start, 1.5), [at(x1, "ovl"), y1]);
  valid("add_transition on an attached clip", x1);
  const [x2] = run(tbase, [{ op: "update_clip", id: "ovl", match_duration: true }, { op: "add_transition", to: "ovl", type: "crossfade", duration: 0.5 }]);
  check("  a computed length is kept: it still ends at the target's end", near(at(x2, "ovl").start, 1.5) && near(at(x2, "ovl").start + at(x2, "ovl").duration, 4) && at(x2, "ovl").match_duration === true, at(x2, "ovl"));
  // computed length
  const [c1] = run(base(), [{ op: "update_clip", id: "ovl", match_duration: true }, { op: "move_clip", id: "ovl", at: 1 }]);
  check("move_clip of an attached clip with a computed length: it keeps the rule and ends at the target's end", near(at(c1, "ovl").start, 1) && near(at(c1, "ovl").duration, 3) && at(c1, "ovl").match_duration === true && at(c1, "ovl").attach_to === "img1", at(c1, "ovl"));
  valid("move_clip with a computed length", c1);
  const [c2] = run(base(), [{ op: "update_clip", id: "ovl", match_duration: true }, { op: "update_clip", id: "ovl", start: 1 }]);
  check("update_clip start of an attached clip with a computed length: same", near(at(c2, "ovl").start, 1) && near(at(c2, "ovl").duration, 3) && at(c2, "ovl").match_duration === true, at(c2, "ovl"));
  // ripple with a clamped target: an attached clip outside the set keeps its place
  const lbase = run(base(), [
    { op: "add_track", id: "x", kind: "video" },
    { op: "add_clip", track: "x", asset: "i", id: "xc", at: 1, duration: 4 },
    { op: "add_clip", track: "x", asset: "i", id: "xt", at: 2, duration: 1 },
    { op: "add_clip", track: "x", asset: "i", id: "xb", attach_to: "xt", offset: -1.5, duration: 0.5 },
  ])[0];
  check("ripple setup: xb sits before its target", near(at(lbase, "xb").start, 0.5) && near(at(lbase, "xt").start, 2), [at(lbase, "xb"), at(lbase, "xt")]);
  const [lr] = run(lbase, [{ op: "remove_clip", id: "xc", ripple: true }]);
  check("remove_clip ripple when the target's shift stops at 0: the attached clip outside the set keeps its place", near(at(lr, "xt").start, 0) && near(at(lr, "xb").start, 0.5) && at(lr, "xb").attach_to === "xt", [at(lr, "xt"), at(lr, "xb")]);
  valid("remove_clip ripple with a clamped target", lr);
  // remove_silence on an attached clip (real media with a silent stretch)
  const S = join(tmp, "proj-attached");
  api.create(S, { preset: "720p" });
  ff("-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6,volume=enable='between(t,2,3.5)':volume=0", "-shortest", "-pix_fmt", "yuv420p", join(m, "gap.mp4"));
  await api.apply(S, [
    { op: "add_clip", track: "main", src: join(m, "p.png"), id: "bg", duration: 8 },
    { op: "add_clip", track: "overlay", src: join(m, "gap.mp4"), id: "talk", attach_to: "bg", offset: 1, match_duration: true, end_offset: 1 },
  ]);
  const rs = (await api.apply(S, [{ op: "remove_silence", id: "talk" }])).results[0];
  const si = api.info(S, "json");
  const segs = si.timeline.tracks.flatMap((tr: any) => tr.clips).filter((c: any) => rs.segments.includes(c.id));
  check("remove_silence on an attached clip: one segment per speech part", segs.length === 2, { rs, segs });
  check("  the segments stay attached, each at its own place, with plain durations", segs.length === 2 && segs.every((c: any) => c.attach_to === "bg" && c.match_duration === undefined && c.end_offset === undefined) && near(segs[0].start, 1) && near(segs[1].start, 1 + segs[0].duration) && near(segs[1].offset, 1 + segs[0].duration), segs);
  check("  and the project validates", si.errors === 0, si.issues);
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
