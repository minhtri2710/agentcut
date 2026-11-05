// Compound clips: make_compound / expand_compound must not change what renders (frames + audio mix).
// Run: bun tests/compound.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-compound-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store
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
async function rejects(f: () => Promise<unknown>, code: string) { try { await f(); return false; } catch (e: any) { return e.code === code || e.message; } }

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
check("duplicate nested id rejected", await rejects(() => api.apply(P, [{ op: "add_clip", track: "overlay", type: "color", color: "red", id: "img1", at: 0, duration: 1 }]), "validation_failed"));
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

console.log(failures ? `\n${failures} FAILED` : "\nall compound checks passed");
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
