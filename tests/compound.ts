// Compound clips: make_compound / expand_compound must not change what renders (frames + audio mix).
// Run: bun tests/compound.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-compound-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("../src/api.ts");
const { buildAudio } = await import("../src/audio.ts");

let failures = 0;
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}
const raw = (file: string, fmt: string[]) => spawnSync("ffmpeg", ["-v", "error", "-i", file, ...fmt, "-"], { maxBuffer: 1 << 28 }).stdout as Buffer;
const meanDiff = (a: Buffer, b: Buffer) => { if (a.length !== b.length || !a.length) return Infinity; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
async function rejects(f: () => Promise<unknown>, code: string) { try { await f(); return false; } catch (e: any) { return e.code === code; } }

const m = join(tmp, "media");
mkdirSync(m);
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=5", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-shortest", "-pix_fmt", "yuv420p", join(m, "a.mp4"));
ff("-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4", "-f", "lavfi", "-i", "sine=frequency=660:duration=4", "-shortest", "-pix_fmt", "yuv420p", join(m, "b.mp4"));
ff("-f", "lavfi", "-i", "gradients=size=640x640:n=3", "-frames:v", "1", join(m, "p.png"));
ff("-f", "lavfi", "-i", "sine=frequency=220:duration=12", "-ac", "2", join(m, "bed.wav"));

const P = join(tmp, "proj");
api.create(P, { preset: "720p" });
await api.apply(P, [
  { op: "add_clip", track: "main", src: join(m, "a.mp4"), duration: 3 },
  { op: "add_clip", track: "main", src: join(m, "p.png"), duration: 2, transition: "crossfade", motion: "ken_burns" },
  { op: "add_clip", track: "main", src: join(m, "b.mp4"), duration: 2.5, transition: { type: "crossfade", duration: 0.5 } },
  { op: "add_clip", track: "text", text: "Inside", attach_to: "main#1", offset: 0.5, duration: 1.5, enter: "pop" },
  { op: "add_clip", track: "text", text: "Outside", attach_to: "main#0", offset: 0.2, duration: 1, position: "top" },
  { op: "add_clip", track: "music", src: join(m, "bed.wav"), volume: 0.5, until_end: true },
]);
const times = [0.5, 1.0, 2.75, 3.4, 4.25, 4.75, 6.2];
async function snap(tag: string) {
  const out: Buffer[] = [];
  for (const t of times) { const f = join(tmp, `${tag}-${t}.png`); await api.frame(P, t, { out: f, scale: 0.5 }); out.push(raw(f, ["-f", "rawvideo", "-pix_fmt", "rgba"])); }
  return out;
}
const mix = (tag: string) => { const p = api.openProject(P), w = join(tmp, `${tag}.wav`); buildAudio(p.absolutized(p.load()), w); return raw(w, ["-f", "s16le"]); };
const before = await snap("before"), audioBefore = mix("before");
const dur0 = api.info(P).duration;

console.log("make_compound");
const r = await api.apply(P, [{ op: "make_compound", ids: ["main#0", "main#1", "txt1"], name: "intro" }]);
const res = r.results[0];
check("compound created on main", res.id === "cmp1" && res.track === "main" && res.duration === 4.5, res);
check("outside connected clip detached", res.detached?.includes("txt2"), res);
const inf = api.info(P, "both");
const main = inf.timeline.tracks.find((t: any) => t.id === "main");
check("main = [cmp1, vid2]", main.clips.map((c: any) => c.id).join() === "cmp1,vid2", main.clips.map((c: any) => c.id));
check("nested tracks mirror sources", main.clips[0].tracks.map((t: any) => `${t.id}:${t.clips.length}`).join() === "main:2,text:1", main.clips[0].tracks);
check("summary shows compound", /cmp1\s+compound 3 nested clips on main,text/.test(inf.summary), inf.summary);
check("no validation errors", inf.errors === 0, inf.issues);
check("duration unchanged", Math.abs(inf.duration - dur0) < 1e-6, [dur0, inf.duration]);
const after = await snap("after");
times.forEach((t, i) => check(`frame ${t}s identical (mean abs diff ${meanDiff(before[i], after[i]).toFixed(3)})`, meanDiff(before[i], after[i]) < 0.5));
const audioAfter = mix("after");
check(`audio mix identical (mean abs diff ${meanDiff(audioBefore, audioAfter).toFixed(2)})`, meanDiff(audioBefore, audioAfter) < 2);

console.log("validation + errors");
const dupNested = [{ op: "add_clip", track: "overlay", type: "color", color: "red", id: "img1", at: 0, duration: 1 }];
check("duplicate nested id rejected as exists", await rejects(() => api.apply(P, dupNested), "exists"));
check("  also with allow_invalid", await rejects(() => api.apply(P, dupNested, { allowInvalid: true }), "exists"));
check("new ids skip nested ones", (await api.apply(P, [{ op: "add_clip", track: "overlay", src: join(m, "p.png"), at: 0, duration: 1 }], { dryRun: true })).results[0].id === "img2");
check("expand needs a compound", await rejects(() => api.apply(P, [{ op: "expand_compound", id: "vid2" }]), "bad_type"));
await api.apply(P, [{ op: "update_clip", id: "cmp1", set: { effects: [{ type: "bw" }], opacity: 0.8 } }]);
const fx = await api.frame(P, 1, { out: join(tmp, "fx.png"), scale: 0.25 });
check("compound with effects renders", fx.bytes > 1000);
await api.apply(P, [{ op: "update_clip", id: "cmp1", set: { effects: null, opacity: null } }]);

console.log("render");
const out = join(tmp, "draft.mp4");
const rr: any = await api.render(P, { out, draft: true, workers: 2, sheet: false });
const pr = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", out], { encoding: "utf8" }).stdout);
check("draft has audio + video", pr.streams.some((s: any) => s.codec_type === "audio") && pr.streams.some((s: any) => s.codec_type === "video"), pr.streams.map((s: any) => s.codec_type));
check(`draft duration ${Number(pr.format.duration).toFixed(2)} ≈ ${dur0}`, Math.abs(Number(pr.format.duration) - dur0) < 0.1, rr);

console.log("expand_compound");
const e = (await api.apply(P, [{ op: "expand_compound", id: "cmp1" }])).results[0];
check("expanded ids", ["vid1", "img1", "txt1"].every((i) => e.ids.includes(i)) && !e.created_tracks.length && !e.gaps.length, e);
const inf2 = api.info(P, "both");
check("main restored", inf2.timeline.tracks.find((t: any) => t.id === "main").clips.map((c: any) => c.id).join() === "vid1,img1,vid2");
check("txt1 still attached to img1", inf2.timeline.tracks.find((t: any) => t.id === "text").clips.find((c: any) => c.id === "txt1").attach_to === "img1");
check("no validation errors after expand", inf2.errors === 0, inf2.issues);
const back = await snap("back");
times.forEach((t, i) => check(`frame ${t}s identical after expand (${meanDiff(before[i], back[i]).toFixed(3)})`, meanDiff(before[i], back[i]) < 0.5));
check("non-contiguous selection rejected", await rejects(() => api.apply(P, [{ op: "make_compound", ids: ["vid1", "vid2"] }]), "not_contiguous"));
check("selection past the storyline run rejected", await rejects(() => api.apply(P, [{ op: "make_compound", ids: ["img1", "txt2"] }]), "out_of_span"));

console.log("trimmed compound on a non-magnetic track");
const g = (await api.apply(P, [{ op: "make_compound", ids: ["txt2", "txt1"] }])).results[0];
check("compound on text track at s0", g.track === "text" && Math.abs(g.start - 0.2) < 1e-6, g);
await api.apply(P, [{ op: "update_clip", id: g.id, set: { in: 0.5, duration: 2.6 } }]);
const e2 = (await api.apply(P, [{ op: "expand_compound", id: g.id }])).results[0];
const txt = api.info(P, "json").timeline.tracks.find((t: any) => t.id === "text").clips;
const t1 = txt.find((c: any) => c.id === "txt1"), t2 = txt.find((c: any) => c.id === "txt2");
check("trimmed to the visible window", e2.dropped.length === 0 && Math.abs(t2.start - 0.2) < 1e-6 && Math.abs(t2.duration - 0.5) < 1e-6 && Math.abs(t1.start - 2.5) < 1e-6 && Math.abs(t1.duration - 0.3) < 1e-6, { t1, t2, e2 });

console.log("regroup: expand_compound stamps what it places, make_compound from=<id> takes it back");
const Q = join(tmp, "regroup");
api.create(Q, { preset: "720p" });
const col = (track: string, id: string, color: string, extra: object = {}) => ({ op: "add_clip", track, type: "color", color, id, duration: 2, ...extra });
await api.apply(Q, [col("main", "c1", "red"), col("main", "c2", "blue"), col("main", "c3", "green"), col("ov", "o1", "white", { at: 0, duration: 1 }), col("ov", "o2", "gray", { at: 1, duration: 1 })]);
const all = () => api.info(Q, "json").timeline.tracks.flatMap((t: any) => t.clips) as any[];
const byId = (id: string) => all().find((c: any) => c.id === id);
const groupOf = (id: string) => byId(id)?.group;
const nestedIds = (id: string) => byId(id).tracks.flatMap((t: any) => t.clips.map((c: any) => c.id)).sort().join();
await api.apply(Q, [{ op: "make_compound", ids: ["c1", "c2"], id: "gA", name: "alpha" }, { op: "make_compound", ids: ["c3"], id: "gB" }]);
await api.apply(Q, [{ op: "update_clip", id: "gB", set: { duration: 3 } }]);
const xa = (await api.apply(Q, [{ op: "expand_compound", id: "gA" }])).results[0];
const xb = (await api.apply(Q, [{ op: "expand_compound", id: "gB" }])).results[0];
check("expand stamps every clip it places", xa.ids.every((i: string) => JSON.stringify(groupOf(i)) === JSON.stringify({ id: "gA", name: "alpha", track: "main" })), xa.ids.map(groupOf));
check("expand stamps its gaps too (unnamed compound: no name)", xb.gaps.length === 1 && [...xb.ids, ...xb.gaps].every((i: string) => JSON.stringify(groupOf(i)) === JSON.stringify({ id: "gB", track: "main" })), [...xb.ids, ...xb.gaps].map(groupOf));
check("two expands give two separate groups", all().filter((c: any) => c.group?.id === "gA").length === 2 && all().filter((c: any) => c.group?.id === "gB").length === 2);
check("the stamped timeline validates", api.info(Q, "json").errors === 0, api.info(Q, "json").issues);
const sp = (await api.apply(Q, [{ op: "split_clip", id: "c2", at: 3 }])).results[0];
check("split keeps the stamp on both halves", groupOf("c2")?.id === "gA" && groupOf(sp.right)?.id === "gA", [groupOf("c2"), groupOf(sp.right)]);
const dup = (await api.apply(Q, [{ op: "duplicate_clip", id: "c1" }])).results[0];
check("duplicate_clip clears the stamp on the copy and keeps it on the original", groupOf(dup.id) === undefined && groupOf("c1")?.id === "gA", [groupOf(dup.id), groupOf("c1")]);
await api.apply(Q, [{ op: "remove_clip", id: dup.id }]);
const ra = (await api.apply(Q, [{ op: "make_compound", from: "gA" }])).results[0];
check("from regroups both halves on the storyline, with the old id and name", ra.id === "gA" && byId("gA")?.name === "alpha" && nestedIds("gA") === `c1,c2,${sp.right}`.split(",").sort().join(), { ra, nested: byId("gA") && nestedIds("gA") });
check("  the stamps are cleared inside the compound, and gB's are untouched", !JSON.stringify(byId("gA").tracks).includes('"group"') && all().filter((c: any) => c.group?.id === "gB").length === 2);
check("  nothing is left over from gA", !all().some((c: any) => c.group?.id === "gA"));
check("  validates", api.info(Q, "json").errors === 0, api.info(Q, "json").issues);

await api.apply(Q, [{ op: "make_compound", ids: ["o1", "o2"], id: "gC" }]);
const xc = (await api.apply(Q, [{ op: "expand_compound", id: "gC" }])).results[0];
const spo = (await api.apply(Q, [{ op: "split_clip", id: "o2", at: 1.5 }])).results[0];
check("non-magnetic track: stamped, and split keeps it", xc.ids.every((i: string) => groupOf(i)?.id === "gC") && groupOf(spo.right)?.id === "gC");
const rc = (await api.apply(Q, [{ op: "make_compound", from: "gC" }])).results[0];
check("non-magnetic track: from regroups all three clips", rc.id === "gC" && rc.track === "ov" && nestedIds("gC") === ["o1", "o2", spo.right].sort().join() && !all().some((c: any) => c.group?.id === "gC"), { rc, n: nestedIds("gC") });

console.log("regroup: detached audio stays paired and stamped");
await api.apply(Q, [
  { op: "add_clip", track: "vt", src: join(m, "a.mp4"), id: "v1", at: 0, duration: 2 },
  { op: "detach_audio", id: "v1" },
]);
const au1 = all().find((c: any) => c.type === "audio" && c.attach_to === "v1").id;
await api.apply(Q, [{ op: "make_compound", ids: ["v1", au1], id: "gD" }]);
const xd = (await api.apply(Q, [{ op: "expand_compound", id: "gD" }])).results[0];
check("expand stamps the detached audio it places", xd.ids.includes(au1) && groupOf("v1")?.id === "gD" && groupOf(au1)?.id === "gD", xd);
const spv = (await api.apply(Q, [{ op: "split_clip", id: "v1", at: 1 }])).results[0];
const au2 = all().find((c: any) => c.type === "audio" && c.attach_to === spv.right)?.id;
check("split keeps the audio paired with its picture, and every half stamped", !!au2 && [ "v1", au1, spv.right, au2 ].every((i) => groupOf(i)?.id === "gD"), all().map((c: any) => [c.id, c.attach_to, c.group?.id]));
const rd = (await api.apply(Q, [{ op: "make_compound", from: "gD" }])).results[0];
const nested = byId("gD").tracks.flatMap((t: any) => t.clips) as any[];
check("from takes both pictures and both audio clips, pairs intact", rd.id === "gD" && nested.length === 4 && nested.find((c: any) => c.id === au1).attach_to === "v1" && nested.find((c: any) => c.id === au2).attach_to === spv.right, nested.map((c: any) => [c.id, c.attach_to]));
check("  the regrouped project validates", api.info(Q, "json").errors === 0, api.info(Q, "json").issues);
await api.apply(Q, [{ op: "add_clip", track: "vt", src: join(m, "a.mp4"), id: "v2", at: 5, duration: 1, group: { id: "gE", track: "vt" } }, { op: "detach_audio", id: "v2" }]);
check("detach_audio gives the new audio clip its picture's stamp", all().filter((c: any) => c.group?.id === "gE").length === 2, all().map((c: any) => [c.id, c.group?.id]));

console.log("regroup: arguments");
check("ids and from together are rejected", await rejects(() => api.apply(Q, [{ op: "make_compound", ids: ["v2"], from: "gE" }]), "bad_arg"));
check("neither ids nor from is rejected", await rejects(() => api.apply(Q, [{ op: "make_compound" }]), "missing_arg"));
check("from with no stamped clips is rejected", await rejects(() => api.apply(Q, [{ op: "make_compound", from: "nope" }]), "no_group"));
check("from while that compound is on the timeline is rejected", await rejects(() => api.apply(Q, [{ op: "make_compound", from: "gD" }]), "exists"));
async function failure(f: () => Promise<unknown>) { try { await f(); return null; } catch (e: any) { return e; } }
await api.apply(Q, [col("hm", "h1", "red", { at: 0, duration: 1 }), col("hm", "h2", "blue", { at: 1, duration: 1 }), { op: "make_compound", ids: ["h1", "h2"], id: "gH" }, { op: "expand_compound", id: "gH" }]);
await api.apply(Q, [{ op: "add_track", id: "other" }, { op: "move_clip", id: "h1", track: "other", at: 0 }, { op: "move_clip", id: "h2", track: "other", at: 1 }]);
let snapQ = JSON.stringify(api.openProject(Q).load());
const hx1 = await failure(() => api.apply(Q, [{ op: "make_compound", from: "gH" }]));
check("from: every member left the home track -> home_track_empty, naming the track and the group", hx1?.code === "home_track_empty" && /'hm'/.test(hx1.message) && /'gH'/.test(hx1.message) && !!hx1.hint, hx1 && [hx1.code, hx1.message]);
check("  the failed batch left the timeline unchanged", JSON.stringify(api.openProject(Q).load()) === snapQ);
await api.apply(Q, [{ op: "remove_track", id: "hm" }]);
snapQ = JSON.stringify(api.openProject(Q).load());
const hx2 = await failure(() => api.apply(Q, [{ op: "make_compound", from: "gH" }]));
check("from: the home track is gone -> missing_track, naming the track and the group", hx2?.code === "missing_track" && /'hm'/.test(hx2.message) && /'gH'/.test(hx2.message) && /add_track/.test(hx2.hint), hx2 && [hx2.code, hx2.message, hx2.hint]);
check("  the failed batch left the timeline unchanged", JSON.stringify(api.openProject(Q).load()) === snapQ);
await api.apply(Q, [{ op: "add_track", id: "hm" }, { op: "move_clip", id: "h1", track: "hm", at: 0 }]);
const rh = (await api.apply(Q, [{ op: "make_compound", from: "gH" }])).results[0];
check("from: with the home track back (one member on it) the compound lands there, not on another track", rh.id === "gH" && rh.track === "hm", rh);
check("a group without a track is rejected by validation", await rejects(() => api.apply(Q, [{ op: "add_clip", track: "vt", type: "color", color: "red", id: "gz1", at: 8, duration: 1, group: { id: "G" } }]), "validation_failed"));
check("a group whose track is not a string is rejected by validation", await rejects(() => api.apply(Q, [{ op: "add_clip", track: "vt", type: "color", color: "red", id: "gz2", at: 8, duration: 1, group: { id: "G", track: 5 } }]), "validation_failed"));
const xs = await failure(() => api.apply(Q, [{ op: "make_compound", from: "c3" }]));
check("from=<id of a plain clip> says the id is used, not that a compound is", xs?.code === "exists" && /already used/.test(xs.message) && !/compound/.test(xs.message), xs && [xs.code, xs.message]);
check("a group without an id is rejected by validation", await rejects(() => api.apply(Q, [{ op: "update_clip", id: "v2", set: { group: { id: null } } }]), "validation_failed"));

console.log("regroup: a compound expanded inside an expanded compound rejoins its outer group");
const deepIds = (c: any): string[] => c.tracks.flatMap((t: any) => t.clips.flatMap((x: any) => (x.type === "compound" ? [x.id, ...deepIds(x)] : [x.id])));
async function twoLevel(name: string, setup: object[], outer: string[], innerOuterId: string, splitAt: [string, number], expectTrack: string) {
  const R = join(tmp, name);
  api.create(R, { preset: "720p" });
  await api.apply(R, setup);
  await api.apply(R, [{ op: "make_compound", ids: ["i1", "i2"], id: "A" }, { op: "make_compound", ids: outer, id: "O" }]);
  await api.apply(R, [{ op: "expand_compound", id: "O" }]);
  await api.apply(R, [{ op: "expand_compound", id: "A" }]);
  const tl = () => api.openProject(R).load();
  const flat = () => tl().tracks.flatMap((t: any) => t.clips) as any[];
  const inner = flat().find((c: any) => c.id === "i1").group;
  check(`${name}: expanding the inner compound records the outer stamp as its parent`, inner?.id === "A" && inner.parent?.id === "O" && inner.parent.track === expectTrack, inner);
  const sp2 = (await api.apply(R, [{ op: "split_clip", id: splitAt[0], at: splitAt[1] }])).results[0];
  check(`${name}: split carries the whole stamp, parent included`, JSON.stringify(flat().find((c: any) => c.id === sp2.right).group) === JSON.stringify(inner), flat().find((c: any) => c.id === sp2.right)?.group);
  const before2 = JSON.stringify(tl());
  const early = await failure(() => api.apply(R, [{ op: "make_compound", from: "O" }]));
  check(`${name}: from=O while A is still expanded -> inner_expanded naming A (not not_contiguous)`, early?.code === "inner_expanded" && /'A'/.test(early.message) && /from=A first/.test(early.hint), early && [early.code, early.message, early.hint]);
  check(`${name}:   the project is unchanged`, JSON.stringify(tl()) === before2);
  const ra2 = await failure(() => api.apply(R, [{ op: "make_compound", from: "A" }]));
  check(`${name}: from=A succeeds`, ra2 === null, ra2 && [ra2.code, ra2.message]);
  check(`${name}: the rebuilt A carries O's stamp again`, flat().find((c: any) => c.id === "A")?.group?.id === "O");
  const ro2 = await failure(() => api.apply(R, [{ op: "make_compound", from: "O" }]));
  check(`${name}: from=O succeeds (A is part of the group, so a storyline run stays contiguous)`, ro2 === null, ro2 && [ro2.code, ro2.message]);
  const O = flat().find((c: any) => c.id === "O");
  check(`${name}: O contains A again, with both halves of i1 and i2 inside A`, !!O && deepIds(O).sort().join() === ["A", "i1", sp2.right, "i2", ...outer.filter((i) => i !== "A")].sort().join(), O && deepIds(O));
  check(`${name}: no clip anywhere carries a stamp at the end`, !JSON.stringify(tl().tracks).includes('"group"'));
  check(`${name}: validates`, api.info(R, "json").errors === 0, api.info(R, "json").issues);
}
await twoLevel("two-level non-magnetic", [col("np", "m1", "red", { at: 0, duration: 1 }), col("np", "m2", "blue", { at: 1, duration: 1 }), col("npa", "i1", "green", { at: 0, duration: 2 }), col("npa", "i2", "white", { at: 2, duration: 1 })],
  ["m1", "m2", "A"], "np", ["i1", 1], "np");
await twoLevel("two-level storyline", [col("main", "x1", "red", { duration: 1 }), col("main", "i1", "green", { duration: 1 }), col("main", "i2", "white", { duration: 1 }), col("main", "x2", "blue", { duration: 1 })],
  ["x1", "A", "x2"], "main", ["i1", 1.5], "main");
{
  const R = join(tmp, "three-level");
  api.create(R, { preset: "720p" });
  await api.apply(R, [col("tp", "p1", "red", { at: 0, duration: 1 }), col("to", "o1", "blue", { at: 0, duration: 1 }), col("ta", "a1", "green", { at: 0, duration: 1 }), col("ta", "a2", "white", { at: 1, duration: 1 }),
    { op: "make_compound", ids: ["a1", "a2"], id: "A" }, { op: "make_compound", ids: ["o1", "A"], id: "O" }, { op: "make_compound", ids: ["p1", "O"], id: "P" },
    { op: "expand_compound", id: "P" }, { op: "expand_compound", id: "O" }, { op: "expand_compound", id: "A" }]);
  const snap3 = JSON.stringify(api.openProject(R).load());
  const e3 = await failure(() => api.apply(R, [{ op: "make_compound", from: "P" }]));
  check("three levels: from=P while O and A are expanded -> inner_expanded naming both", e3?.code === "inner_expanded" && /'O'/.test(e3.message) && /'A'/.test(e3.message), e3 && [e3.code, e3.message]);
  check("  the project is unchanged", JSON.stringify(api.openProject(R).load()) === snap3);
  for (const g of ["A", "O", "P"]) await api.apply(R, [{ op: "make_compound", from: g }]);
  const P3 = api.openProject(R).load().tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === "P");
  check("  inner first (A, O, P) restores P with O and A inside, unstamped", !!P3 && deepIds(P3).sort().join() === ["A", "O", "a1", "a2", "o1", "p1"].join() && !JSON.stringify(api.openProject(R).load().tracks).includes('"group"'), P3 && deepIds(P3));
}
const bp = await failure(() => api.apply(Q, [{ op: "add_clip", track: "vt", type: "color", color: "red", id: "gz3", at: 8, duration: 1, group: { id: "G", track: "t", parent: { id: "P" } } }]));
check("a stamp whose parent lacks a track is rejected, at group.parent.track", bp?.code === "validation_failed" && JSON.stringify(bp.details?.issues).includes("group.parent.track"), bp && [bp.code, bp.details]);

console.log("match_duration by clip reference");
{
  const S = join(tmp, "by-reference");
  api.create(S, { preset: "720p" });
  await api.apply(S, [col("main", "m1", "red", { duration: 2 }), col("main", "m2", "blue", { duration: 2 }), col("ov", "tA", "green", { at: 0, duration: 1 }), col("ov", "tB", "white", { at: 0, duration: 1 }),
    col("ov2", "tC", "white", { at: 0, duration: 1 }), col("ov3", "vo", "white", { at: 0, duration: 1.5 }),
    { op: "update_clip", id: "tA", match_duration: "m1", end_offset: 0.5 }, { op: "update_clip", id: "tB", match_duration: "vo" }, { op: "update_clip", id: "tC", match_duration: "m1" }]);
  const flat = () => api.openProject(S).load().tracks.flatMap((t: any) => t.clips) as any[];
  const byId = (id: string) => flat().find((c: any) => c.id === id);
  const k = (await api.apply(S, [{ op: "make_compound", ids: ["m1", "tA", "tB"], id: "K" }])).results[0];
  const nested = byId("K").tracks.flatMap((t: any) => t.clips) as any[];
  const nc = (id: string) => nested.find((c: any) => c.id === id);
  check("make_compound: a reference inside the set stays", nc("tA").match_duration === "m1" && nc("tA").end_offset === 0.5 && nc("tA").duration === 1.5, nc("tA"));
  check("make_compound: a reference that leaves the set is frozen to its length", nc("tB").match_duration === undefined && nc("tB").duration === 1.5 && JSON.stringify(k.unlinked_durations?.slice().sort()) === '["tB","tC"]', { k, tB: nc("tB") });
  check("make_compound: a follower outside the set of a clip inside it is frozen", byId("tC").match_duration === undefined && byId("tC").duration === 2, byId("tC"));
  const dup = (await api.apply(S, [{ op: "duplicate_clip", id: "K" }])).results[0];
  const dn = byId(dup.id).tracks.flatMap((t: any) => t.clips) as any[];
  const dA = dn.find((c: any) => c.match_duration), dM = dn.find((c: any) => c.type === "color" && c.id !== dA?.id);
  check("duplicate_clip of a compound remaps a reference inside it", !!dA && dA.id !== "tA" && dM.id !== "m1" && dA.match_duration === dM.id, dn);
  await api.apply(S, [{ op: "remove_clip", id: dup.id }]);
  await api.apply(S, [col("ov4", "tD", "white", { at: 0, duration: 1 }), { op: "update_clip", id: "tD", match_duration: "K" }]);
  check("a follower of the compound itself follows its length", byId("tD").duration === 2, byId("tD"));
  const ex = (await api.apply(S, [{ op: "expand_compound", id: "K" }])).results[0];
  check("expand_compound: a reference inside the set stays, on the same ids", byId("tA").match_duration === "m1" && byId("tA").duration === 1.5 && !!byId("m1"), byId("tA"));
  check("expand_compound: a follower of the compound is frozen and listed", byId("tD").match_duration === undefined && byId("tD").duration === 2 && JSON.stringify(ex.unlinked_durations) === '["tD"]', { ex, tD: byId("tD") });
  await api.apply(S, [{ op: "update_clip", id: "m1", duration: 3 }]);
  check("expand_compound: the kept reference still follows", byId("tA").duration === 2.5, byId("tA"));
  check("the by-reference project validates", api.info(S, "json").errors === 0, api.info(S, "json").issues);
}
{ // a follower on the magnetic track, inside the selected run: the reference is not an attachment, so it survives both ops
  const S2 = join(tmp, "by-reference-run");
  api.create(S2, { preset: "720p" });
  await api.apply(S2, [col("main", "m1", "red", { duration: 2 }), col("main", "m2", "blue", { duration: 2 }), col("main", "m3", "green", { duration: 1 }), { op: "update_clip", id: "m2", match_duration: "m1", end_offset: 0.5 }]);
  const flat2 = () => api.openProject(S2).load().tracks.flatMap((t: any) => t.clips) as any[];
  const mk = (await api.apply(S2, [{ op: "make_compound", ids: ["m1", "m2"], id: "K2" }])).results[0];
  const n2 = flat2().find((c: any) => c.id === "K2").tracks[0].clips.find((c: any) => c.id === "m2");
  check("make_compound: a main-track follower inside the run keeps its reference and end_offset", n2.match_duration === "m1" && n2.end_offset === 0.5 && n2.duration === 1.5 && mk.unlinked_durations.length === 0, { mk, n2 });
  const ex2 = (await api.apply(S2, [{ op: "expand_compound", id: "K2" }])).results[0];
  const m2 = flat2().find((c: any) => c.id === "m2");
  check("expand_compound: it survives the expand too", m2.match_duration === "m1" && m2.end_offset === 0.5 && m2.duration === 1.5 && ex2.unlinked_durations.length === 0, { ex2, m2 });
  await api.apply(S2, [{ op: "update_clip", id: "m1", duration: 3 }]);
  check("  and still follows its target on the magnetic track", flat2().find((c: any) => c.id === "m2").duration === 2.5 && flat2().find((c: any) => c.id === "m3").start === 5.5, flat2().map((c: any) => [c.id, c.start, c.duration]));
}
{ // remove_asset force inside a compound: a follower of a removed nested clip keeps its length
  const S3 = join(tmp, "by-reference-asset");
  api.create(S3, { preset: "720p" });
  await api.apply(S3, [{ op: "add_clip", track: "t3", src: join(m, "p.png"), id: "pa", at: 0, duration: 2 }, col("t4", "fb", "blue", { at: 0, duration: 1 }), { op: "update_clip", id: "fb", match_duration: "pa" },
    { op: "make_compound", ids: ["pa", "fb"], id: "K3" }]);
  const ra = (await api.apply(S3, [{ op: "remove_asset", id: Object.keys(api.info(S3, "json").timeline.assets)[0], force: true }])).results[0];
  const fb = api.openProject(S3).load().tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === "K3").tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === "fb");
  check("remove_asset force: a nested follower of a removed nested clip keeps its length", JSON.stringify(ra.unlinked_durations) === '["fb"]' && fb.match_duration === undefined && fb.duration === 2, { ra, fb });
  check("  and the project validates", api.info(S3, "json").errors === 0, api.info(S3, "json").issues);
}

console.log("expand_compound: a trimmed head moves keyframes, effects and caption words; srt captions are refused");
{
  const X = join(tmp, "expand-head");
  api.create(X, { preset: "720p" });
  const srt = join(tmp, "cues.srt");
  writeFileSync(srt, "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
  await api.apply(X, [
    col("ov", "k1", "red", { at: 0, duration: 4, effects: [{ type: "grain", start: 1, duration: 2 }], keyframes: { opacity: [{ t: 1, v: 0.5 }, { t: 3, v: 1 }] } }),
    { op: "add_clip", track: "cp", type: "captions", id: "cw", at: 0, duration: 4, words: [{ text: "hi", start: 1, end: 2 }, { text: "yo", s: 2.5, e: 3.5 }] },
    { op: "make_compound", ids: ["k1", "cw"], id: "K" },
    { op: "update_clip", id: "K", set: { in: 0.5, duration: 3 } },
    { op: "expand_compound", id: "K" }]);
  const xs = api.openProject(X).load().tracks.flatMap((t: any) => t.clips) as any[];
  const k1 = xs.find((c: any) => c.id === "k1"), cw = xs.find((c: any) => c.id === "cw");
  check("object-form keyframes move with the cut head", JSON.stringify(k1.keyframes.opacity.map((x: any) => x.t)) === "[0.5,2.5]", k1.keyframes);
  check("an effect window moves with the cut head", k1.effects.length === 1 && k1.effects[0].start === 0.5 && k1.effects[0].duration === 2, k1.effects);
  check("caption words move with the cut head, alias words included", cw.words.length === 2 && cw.words[0].start === 0.5 && cw.words[0].end === 1.5 && cw.words[1].start === 2 && cw.words[1].end === 3, cw.words);
  check("  the expanded project validates", api.info(X, "json").errors === 0, api.info(X, "json").issues);
  const Y = join(tmp, "expand-srt");
  api.create(Y, { preset: "720p" });
  await api.apply(Y, [{ op: "add_clip", track: "cp", type: "captions", id: "cs", at: 0, duration: 4, srt }, { op: "add_clip", track: "cp2", type: "captions", id: "cs2", at: 0, duration: 4, srt },
    { op: "make_compound", ids: ["cs"], id: "S" }, { op: "make_compound", ids: ["cs2"], id: "S2" }, { op: "update_clip", id: "S", set: { in: 0.5, duration: 3 } }]);
  check("expanding a compound with srt captions at a cut head is refused (cues cannot move)", (await failure(() => api.apply(Y, [{ op: "expand_compound", id: "S" }])))?.code === "bad_type");
  check("  and with no head cut it expands", (await failure(() => api.apply(Y, [{ op: "expand_compound", id: "S2" }]))) === null);
}

console.log("expand_compound: what the compound carried goes to its clips, or the expand is refused");
{
  const X = join(tmp, "expand-carry");
  api.create(X, { preset: "720p" });
  await api.apply(X, [
    { op: "add_clip", track: "ov", src: join(m, "a.mp4"), id: "cv1", at: 0, duration: 2, volume: 0.8 },
    { op: "add_clip", track: "ov", src: join(m, "a.mp4"), id: "cv2", at: 3, duration: 2 },
    col("ov", "cc", "red", { at: 6, duration: 1 }), col("ov", "cd", "blue", { at: 8, duration: 1 }),
    { op: "make_compound", ids: ["cv1"], id: "C1" }, { op: "make_compound", ids: ["cv2"], id: "C2" }, { op: "make_compound", ids: ["cc"], id: "C3" }, { op: "make_compound", ids: ["cd"], id: "C4" },
    { op: "update_clip", id: "C4", set: { effects: [{ type: "bw" }], opacity: 0.8 } },
    { op: "update_clip", id: "C1", set: { volume: 0.5, enabled: false } }, { op: "update_clip", id: "C2", set: { muted: true } }, { op: "update_clip", id: "C3", set: { effects: [{ type: "bw" }], opacity: 0.8 } }]);
  const flat = () => api.openProject(X).load().tracks.flatMap((t: any) => t.clips) as any[];
  const e3 = await failure(() => api.apply(X, [{ op: "expand_compound", id: "C3" }]));
  check("a compound with effects or opacity is refused, naming them, with the fix", e3?.code === "layer_properties" && /effects/.test(e3.message) && /opacity/.test(e3.message) && /update_clip/.test(e3.hint) && flat().some((c: any) => c.id === "C3"), e3 && [e3.code, e3.message, e3.hint]);
  await api.apply(X, [{ op: "expand_compound", id: "C1" }, { op: "expand_compound", id: "C2" }]);
  const cv1 = flat().find((c: any) => c.id === "cv1"), cv2 = flat().find((c: any) => c.id === "cv2");
  check("the compound's volume multiplies into its clips and its enabled=false goes with them", Math.abs(cv1.volume - 0.4) < 1e-6 && cv1.enabled === false && cv2.enabled === undefined, [cv1, cv2]);
  check("the compound's muted goes to its clips", cv2.muted === true && cv1.muted === undefined, [cv1, cv2]);
  await api.apply(X, [{ op: "update_clip", id: "C4", set: { effects: null, opacity: null } }, { op: "expand_compound", id: "C4" }]);
  check("  and with the layer properties cleared it expands", !flat().some((c: any) => c.id === "C4") && api.info(X, "json").errors === 0, api.info(X, "json").issues);
}

console.log("expand_compound: other storylines and the home storyline keep their time and their place");
{
  const setup = async (name: string) => {
    const X = join(tmp, name);
    api.create(X, { preset: "720p" });
    await api.apply(X, [{ op: "add_track", id: "story2", kind: "video", magnetic: true, below: "overlay" },
      col("main", "c1", "red"), col("main", "c2", "blue"), col("story2", "s1", "green"), col("story2", "s2", "white"), col("story2", "s3", "gray", { duration: 1 })]);
    const mk = (await api.apply(X, [{ op: "make_compound", ids: ["c1", "c2", "s1", "s2"], id: "G" }])).results[0];
    return { X, mk, tl: () => api.openProject(X).load(), story: () => api.openProject(X).load().tracks.find((t: any) => t.id === "story2")!.clips as any[] };
  };
  const a = await setup("expand-story");
  const order0 = a.tl().tracks.map((t: any) => t.id);
  check("setup: make_compound leaves a gap on the other storyline", a.story().map((c: any) => c.id).join() === `${a.mk.gaps[0]},s3`, a.story().map((c: any) => c.id));
  const ex = (await api.apply(a.X, [{ op: "expand_compound", id: "G" }])).results[0];
  check("the clips go back into the other storyline's gap: no new track, nothing left over", ex.created_tracks.length === 0 && a.story().map((c: any) => c.id).join() === "s1,s2,s3" && a.tl().tracks.map((t: any) => t.id).join() === order0.join(), { ex, story: a.story().map((c: any) => c.id) });
  check("  they keep their times on that storyline", JSON.stringify(a.story().map((c: any) => [c.id, c.start, c.duration])) === '[["s1",0,2],["s2",2,2],["s3",4,1]]', a.story().map((c: any) => [c.id, c.start, c.duration]));
  check("  and the project validates", api.info(a.X, "json").errors === 0, api.info(a.X, "json").issues);
  const b = await setup("expand-story-moved");
  await api.apply(b.X, [{ op: "update_clip", id: b.mk.gaps[0], set: { duration: 3 } }]);
  const exb = (await api.apply(b.X, [{ op: "expand_compound", id: "G" }])).results[0];
  const order = b.tl().tracks.map((t: any) => t.id);
  check("when that gap no longer fits, the new track sits just above the other storyline, not on top", exb.created_tracks.length === 1 && order[order.indexOf("story2") + 1] === exb.created_tracks[0] && order.indexOf("overlay") > order.indexOf(exb.created_tracks[0]), { exb, order });
  check("  and the other storyline keeps its clips", b.story().map((c: any) => c.id).includes("s3"), b.story().map((c: any) => c.id));
  const Z = join(tmp, "expand-home-empty");
  api.create(Z, { preset: "720p" });
  await api.apply(Z, [col("main", "h1", "red"), col("main", "h2", "blue"), col("main", "h3", "green"), col("ov", "o1", "white", { at: 0, duration: 4 }), { op: "make_compound", ids: ["h1", "h2", "o1"], id: "H" }]);
  const nested = (api.openProject(Z).load().tracks.find((t: any) => t.id === "main")!.clips[0].tracks as any[]).filter((t: any) => t.id !== "main");
  await api.apply(Z, [{ op: "update_clip", id: "H", set: { tracks: nested } }, { op: "expand_compound", id: "H" }]);
  const zm = api.openProject(Z).load().tracks.find((t: any) => t.id === "main")!.clips as any[];
  const h3 = zm.find((c: any) => c.id === "h3");
  check("a compound with nothing of its own on its storyline leaves a gap, so the clips after it keep their time", zm[0].type === "gap" && zm[0].duration === 4 && h3.start === 4, zm.map((c: any) => [c.id, c.type, c.start, c.duration]));
}

console.log("retimed compound: what it drops is reported by validate");
{
  const R = join(tmp, "retimed");
  api.create(R, { preset: "720p" });
  await api.apply(R, [{ op: "add_clip", track: "main", src: join(m, "a.mp4"), duration: 2, id: "rv" },
    { op: "add_captions", words: [{ text: "Hello", start: 0, end: 1 }], id: "rc", at: 0 },
    { op: "make_compound", ids: ["rv", "rc"], id: "RC" }]);
  const warns = () => (api.validate(R) as any).issues.filter((i: any) => i.level === "warning" && i.path.endsWith(".speed")) as any[];
  const retime = (set: object) => api.apply(R, [{ op: "update_clip", id: "RC", set }]);
  check("speed 1: no retime warning", warns().length === 0, warns());
  await retime({ speed: 2 });
  const w = warns();
  check("speed 2: one warning for the dropped nested audio, one for the nested captions", w.length === 2 && w.some((i) => /nested audio is not mixed/.test(i.message) && i.hint) && w.some((i) => /nested captions are not exported/.test(i.message) && i.hint), w);
  check("  the batch still accepts the edit (warning, not error)", (api.validate(R) as any).valid === true);
  await retime({ muted: true });
  check("a muted compound drops no audio: only the captions warning stays", warns().length === 1 && /captions/.test(warns()[0].message), warns());
  await retime({ muted: false, speed: 1 });
  check("back to speed 1: no warning", warns().length === 0, warns());
}

console.log("retimed compound: the warning names only what plays now but is not mixed or exported");
{
  const M = await import("../src/model.ts");
  const warned = (tracks: any[]) => {
    const tl = M.newTimeline(640, 360, 30);
    tl.assets.v = { path: "/none.mp4", kind: "video", duration: 10, has_audio: true } as any;
    tl.assets.q = { path: "/none2.mp4", kind: "video", duration: 10, has_audio: false } as any;
    tl.tracks = tracks;
    return M.validate(tl).filter((i) => i.level === "warning" && i.path.endsWith(".speed")).map((i) => `${i.path.match(/.*<(\w+)>/)![1]}:${/audio/.test(i.message) ? "audio" : "captions"}`).sort();
  };
  const vid = (id: string, o: object = {}) => ({ id, type: "video", asset: "v", start: 0, duration: 2, ...o });
  const cap = (id: string, o: object = {}) => ({ id, type: "captions", words: [{ text: "Hi", start: 0, end: 1 }], start: 0, duration: 2, ...o });
  const trk = (id: string, clips: any[], o: object = {}) => ({ id, kind: "video", clips, ...o });
  const cmp = (id: string, tracks: any[], o: object = {}) => ({ id, type: "compound", start: 0, duration: 2, speed: 2, tracks, ...o });
  const top = (...c: any[]) => [trk("top", c)];
  const is = (name: string, got: string[], want: string[]) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

  is("a frozen nested video has no sound to drop", warned(top(cmp("RC", [trk("n", [vid("a", { freeze: true })])]))), []);
  is("a muted nested track has no sound to drop", warned(top(cmp("RC", [trk("n", [vid("a")], { muted: true })]))), []);
  is("a nested video whose asset has no audio has no sound to drop", warned(top(cmp("RC", [trk("n", [vid("a", { asset: "q" })])]))), []);
  is("a hidden nested track still mixes its audio but exports no captions", warned(top(cmp("RC", [trk("n", [vid("a"), cap("c")], { hidden: true })]))), ["RC:audio"]);
  is("a compound on a hidden nested track exports no captions either", warned(top(cmp("RC", [trk("n", [cmp("N", [trk("m", [cap("c")])], { speed: 1 })], { hidden: true })]))), []);

  const inner = () => cmp("RC", [trk("n", [vid("a"), cap("c")])]);
  is("a disabled ancestor reaches nothing below it", warned(top(cmp("P", [trk("p", [inner()])], { speed: 1, enabled: false }))), []);
  is("a muted ancestor drops no audio below it, but its captions are still exported", warned(top(cmp("P", [trk("p", [inner()])], { speed: 1, muted: true }))), ["RC:captions"]);
  is("an ancestor on a muted track drops no audio below it", warned([trk("top", [cmp("P", [trk("p", [inner()])], { speed: 1 })], { muted: true })]), ["RC:captions"]);
  is("an ancestor on a hidden track exports no captions below it", warned([trk("top", [cmp("P", [trk("p", [inner()])], { speed: 1 })], { hidden: true })]), ["RC:audio"]);
  is("a retimed compound counts the clips of a speed-1 compound inside it", warned(top(cmp("P", [trk("p", [cmp("N", [trk("n", [vid("a")])], { speed: 1 })])]))), ["P:audio"]);
  is("a retimed compound inside a retimed one still reports its own drop; the outer one does not count it", warned(top(cmp("P", [trk("p", [cmp("RC", [trk("n", [vid("a")])])])]))), ["RC:audio"]);

  is("clips outside the visible nested range [in, in + duration x speed] are not counted", warned(top(cmp("RC", [trk("n", [vid("a", { start: 10 }), cap("c", { start: 10 })])]))), []);
  is("a clip inside that range is counted only because the speed widens it", warned(top(cmp("RC", [trk("n", [vid("a", { start: 3 })])]))), ["RC:audio"]);
  is("the range starts at the compound's in", warned(top(cmp("RC", [trk("n", [vid("a", { start: 0 })])], { in: 5 }))), []);
}

console.log(failures ? `\n${failures} FAILED` : "\nall compound checks passed");
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
