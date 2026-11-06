// Project-tree writes do not follow symlinks or hard links: every place AgentCut writes (previews/, renders/, media/, .agentcut/, outputs,
// sidecars, the feedback store, the font cache) is checked with a link placed there first. A refused write is an EditError "unsafe_path"
// and the link's target is unchanged (content, entry list and directory mtimes, so create-then-remove behind a link is caught too);
// a link at the final name of an output is replaced by a regular file and its target is left alone.
// Run: bun tests/writes.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-writes-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root (fonts/vision read it at load)
const api = await import("../src/api.ts");
const FB = await import("../src/feedback.ts");

let failures = 0;
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
const ff = (...a: string[]) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a], { encoding: "utf8" }); if (r.status) throw new Error(r.stderr); };
const code = async (f: () => unknown) => { try { await f(); return "ok"; } catch (e: any) { return e.code ?? e.message; } };

const m = join(tmp, "media"); mkdirSync(m);
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-f", "lavfi", "-i", "sine=f=440:duration=3", "-shortest", "-pix_fmt", "yuv420p", "-c:a", "aac", join(m, "av.mp4"));
copyFileSync(join(m, "av.mp4"), join(m, "other.mp4")); // a file no project has imported yet

let n = 0;
/** a project with one clip and a captions clip */
const project = async (name: string) => {
  const d = join(tmp, name);
  api.create(d, { preset: "reels" });
  await api.apply(d, [{ op: "add_clip", track: "main", src: join(m, "av.mp4") },
    { op: "add_captions", words: [{ text: "one", start: 0, end: 0.5 }, { text: "two", start: 0.5, end: 1 }] }]);
  return d;
};
/** every entry under dir with its content (a link with its target) and every directory's mtime, the dir itself included */
const snap = (dir: string): string => [".", ...readdirSync(dir, { recursive: true }).map(String).sort()].map((e) => {
  const f = join(dir, e), st = lstatSync(f);
  return `${e}:${st.isSymbolicLink() ? "->" + readlinkSync(f) : st.isDirectory() ? "/" + st.mtimeMs : readFileSync(f, "utf8")}`;
}).join("\n");
/** a directory elsewhere in the suite's tmp dir, holding one file, with an old mtime so any later change shows */
const outside = (name: string) => {
  const d = join(tmp, `${name}-${++n}`);
  mkdirSync(d);
  writeFileSync(join(d, "keep.txt"), "keep");
  utimesSync(d, 1e9, 1e9);
  return d;
};
/** replace <project>/<rel> with a link to `to` */
const link = (p: string, rel: string, to: string) => { rmSync(join(p, rel), { recursive: true, force: true }); symlinkSync(to, join(p, rel)); };
const regular = (f: string) => lstatSync(f, { throwIfNoEntry: false })?.isFile() === true;

// ------------------------------------------------------------------ a directory of the project as a link
console.log("a project directory that is a link: refused, the target is unchanged");
{
  const dirAct: Record<string, [string, (p: string) => unknown][]> = {
    previews: [["preview_frame", (p) => api.frame(p, 1)], ["contact_sheet", (p) => api.sheet(p, { count: 2 })], ["scopes", (p) => api.scopes(p, 1)], ["audio_check", (p) => api.audioCheck(p, {})]],
    renders: [["export_captions", (p) => api.exportCaptions(p, {})], ["export_timeline", (p) => api.exportTimeline(p, {})], ["render", (p) => api.render(p, { draft: true, workers: 1 })]],
  };
  for (const [dir, acts] of Object.entries(dirAct)) for (const [name, act] of acts) {
    const p = await project(`dir-${dir}-${name}`), t = outside("target"), before = snap(t);
    link(p, dir, t);
    const c = await code(() => act(p));
    check(`${dir}/ as a link: ${name} -> unsafe_path, the target is unchanged`, c === "unsafe_path" && snap(t) === before, { c, now: snap(t) });
  }
  // render scratch space and the media copy target
  {
    const p = await project("dir-tmp"), t = outside("target"), before = snap(t);
    mkdirSync(join(p, ".agentcut"), { recursive: true });
    link(p, ".agentcut/tmp", t);
    const c = await code(() => api.render(p, { out: join(p, "renders", "a.mp4"), draft: true, workers: 1 }));
    check(".agentcut/tmp as a link: render -> unsafe_path, the target is unchanged", c === "unsafe_path" && snap(t) === before, { c, now: snap(t) });
  }
  {
    const p = await project("dir-media"), t = outside("target"), before = snap(t);
    link(p, "media", t);
    const c = await code(() => api.apply(p, [{ op: "import_media", path: join(m, "other.mp4"), copy: true }]));
    check("media/ as a link: import_media copy=true -> unsafe_path, the target is unchanged", c === "unsafe_path" && snap(t) === before, { c, now: snap(t) });
  }
  {
    const p = await project("dir-agentcut"), t = outside("target"), before = snap(t);
    rmSync(join(p, ".agentcut"), { recursive: true });
    symlinkSync(t, join(p, ".agentcut"));
    const e = await code(() => api.apply(p, [{ op: "add_marker", t: 1 }]));
    check(".agentcut as a link: apply -> unsafe_path, the target is unchanged", e === "unsafe_path" && snap(t) === before, { e, now: snap(t) });
  }
  {
    const d = join(tmp, "init-agentcut"), t = outside("target"), before = snap(t);
    mkdirSync(d);
    symlinkSync(t, join(d, ".agentcut"));
    const c = await code(() => api.create(d, { preset: "reels" }));
    check(".agentcut as a link: init -> unsafe_path, no project.json, the target is unchanged", c === "unsafe_path" && !existsSync(join(d, "project.json")) && snap(t) === before, { c, now: snap(t) });
  }
}

// ------------------------------------------------------------------ the final name of an output as a link
console.log("an output path that is a link: replaced by a regular file, the target is unchanged");
{
  const outputs: [string, string, (p: string, out: string) => unknown][] = [
    ["preview_frame", ".jpg", (p, out) => api.frame(p, 1, { out })],
    ["contact_sheet", ".jpg", (p, out) => api.sheet(p, { count: 2, out })],
    ["scopes", ".jpg", (p, out) => api.scopes(p, 1, { out })],
    ["audio_check", ".png", (p, out) => api.audioCheck(p, { out })],
    ["export_captions", ".srt", (p, out) => api.exportCaptions(p, { out })],
    ["export_timeline", ".fcpxml", (p, out) => api.exportTimeline(p, { out })],
    ["render", ".mp4", (p, out) => api.render(p, { out, draft: true, workers: 1, sheet: false })],
  ];
  const p = await project("final-link");
  for (const where of ["inside the project", "outside the project"]) for (const dangling of [false, true]) for (const [name, ext, act] of outputs) {
    const dir = where === "inside the project" ? join(p, name === "render" ? "renders" : "previews") : outside("elsewhere");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${name}-${++n}${ext}`), target = join(tmp, `final-target-${n}.bin`);
    if (!dangling) writeFileSync(target, "keep");
    symlinkSync(target, out);
    const c = await code(() => act(p, out));
    check(`${name} to a ${dangling ? "dangling " : ""}link ${where}: ok, a regular file now, the target is unchanged`,
      c === "ok" && regular(out) && (dangling ? !existsSync(target) : readFileSync(target, "utf8") === "keep"), { c, kind: lstatSync(out).isSymbolicLink() ? "link" : "file" });
  }
}

// ------------------------------------------------------------------ sidecars of a render
console.log("sidecar names next to a render that are links: the targets are unchanged");
{
  const p = await project("sidecars"), out = join(p, "renders", "s.mp4"), sheet = join(p, "renders", "s.sheet.jpg");
  mkdirSync(join(p, "renders"), { recursive: true });
  const targets: string[] = [];
  for (const f of [`${out}.subs.srt`, `${out}.subs.mp4`, sheet]) {
    const t = join(tmp, `sidecar-target-${++n}.bin`);
    writeFileSync(t, "keep");
    symlinkSync(t, f);
    targets.push(t);
  }
  const r: any = await api.render(p, { out, draft: true, workers: 1, subtitles: true }).catch((e) => e);
  check("render with subtitles and a contact sheet completes", !!r.output && r.subtitles?.cues > 0 && r.contact_sheet === sheet, { code: r.code, message: r.message });
  check("the sidecar links' targets are unchanged", targets.every((t) => readFileSync(t, "utf8") === "keep"));
  check("the contact sheet is a regular file", regular(sheet));
  check("no sidecar is left behind", readdirSync(join(p, "renders")).every((f) => !f.includes(".part-")), readdirSync(join(p, "renders")));
}

// ------------------------------------------------------------------ media/ copy
console.log("import_media copy=true: a link at the copy's name is never written through");
{
  const p = await project("media-link"), target = join(tmp, "media-target.bin");
  symlinkSync(target, join(p, "media", "other.mp4"));
  const r: any = await api.apply(p, [{ op: "import_media", path: join(m, "other.mp4"), copy: true }]);
  const copies = readdirSync(join(p, "media")).sort();
  check("a dangling link at media/other.mp4: the copy takes the next free name, the link target is not created", !existsSync(target) && copies.includes("other-1.mp4") && regular(join(p, "media", "other-1.mp4")), { copies, r: r.results?.[0] });
  const q = await project("media-link-file"), keep = join(tmp, "media-target-file.bin");
  writeFileSync(keep, "keep");
  symlinkSync(keep, join(q, "media", "other.mp4"));
  await api.apply(q, [{ op: "import_media", path: join(m, "other.mp4"), copy: true }]);
  check("a link to a file at media/other.mp4: the file is unchanged", readFileSync(keep, "utf8") === "keep" && regular(join(q, "media", "other-1.mp4")));
}

// ------------------------------------------------------------------ feedback store and font cache (outside the project tree)
console.log("the feedback store and the font cache");
{
  const home = process.env.AGENTCUT_HOME!, fb = join(home, "feedback");
  const note = () => code(() => FB.addNote({ kind: "idea", title: `note ${++n}` }));
  // feedback/ as a link
  {
    const t = outside("fb-target"), before = snap(t);
    rmSync(fb, { recursive: true, force: true }); // events recorded by the calls above
    mkdirSync(home, { recursive: true });
    symlinkSync(t, fb);
    const c = await note();
    FB.recordEvent({ type: "call", cmd: "probe", ms: 1 });
    check("feedback/ as a link: add -> unsafe_path, an event is dropped, the target is unchanged", c === "unsafe_path" && snap(t) === before, { c, now: snap(t) });
    rmSync(fb);
  }
  // events.jsonl and notes.json as links, and as a second hard link
  mkdirSync(fb, { recursive: true });
  for (const name of ["events.jsonl", "notes.json"]) {
    const t = join(tmp, `fb-${name}`);
    writeFileSync(t, name === "notes.json" ? "[]" : "keep\n");
    rmSync(join(fb, name), { force: true });
    symlinkSync(t, join(fb, name));
    const c = await note();
    FB.recordEvent({ type: "call", cmd: "probe", ms: 1 });
    check(`${name} as a link: the target is unchanged`, readFileSync(t, "utf8") === (name === "notes.json" ? "[]" : "keep\n"), { c });
    rmSync(join(fb, name));
  }
  check("notes.json written over a link is a regular file", regular(join(fb, "notes.json")) || !existsSync(join(fb, "notes.json")));
  {
    const t = join(tmp, "fb-hard.jsonl");
    writeFileSync(t, "keep\n");
    rmSync(join(fb, "events.jsonl"), { force: true });
    linkSync(t, join(fb, "events.jsonl"));
    FB.recordEvent({ type: "call", cmd: "probe", ms: 1 });
    check("events.jsonl with another hard link: nothing is appended", readFileSync(t, "utf8") === "keep\n");
    rmSync(join(fb, "events.jsonl"));
    FB.recordEvent({ type: "call", cmd: "probe", ms: 1 });
    check("a normal events.jsonl is still appended to", /"cmd":"probe"/.test(readFileSync(join(fb, "events.jsonl"), "utf8")));
  }
  // font cache
  {
    const cache = join(process.env.AGENTCUT_CACHE!, "font-families.json"), t = join(tmp, "font-target.bin");
    mkdirSync(process.env.AGENTCUT_CACHE!, { recursive: true });
    writeFileSync(t, "keep");
    rmSync(cache, { force: true });
    symlinkSync(t, cache);
    const F = await import("../src/fonts.ts");
    await (await import("../src/canvas.ts")).loadCanvas();
    F.refreshFonts(); // the family list is cached in this process: force the cache write
    F.fontsKnown();
    check("font cache path as a link: the target is unchanged, the cache is a regular file", readFileSync(t, "utf8") === "keep" && regular(cache), { kind: lstatSync(cache).isSymbolicLink() ? "link" : "file" });
  }
}

if (process.argv.includes("--keep")) console.log("kept", tmp); else rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall write checks passed");
process.exit(failures ? 1 : 0);
