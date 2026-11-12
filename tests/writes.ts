// Project-tree writes do not follow symlinks or hard links: every place AgentCut writes (previews/, renders/, media/, .agentcut/, outputs,
// sidecars, the feedback store, the font cache) is checked with a link placed there first. A refused write is an EditError "unsafe_path"
// and the link's target is unchanged (content, entry list and directory mtimes, so create-then-remove behind a link is caught too);
// a link at the final name of an output is replaced by a regular file and its target is left alone.
// Run: bun tests/writes.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-writes-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root (fonts/vision read it at load)
const api = await import("../src/api.ts");
const FB = await import("../src/feedback.ts");
const S = await import("../src/safe-write.ts");

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
    check(".agentcut as a link: init -> unsafe_path, nothing else is created, the target is unchanged", c === "unsafe_path" && readdirSync(d).join() === ".agentcut" && snap(t) === before, { c, entries: readdirSync(d), now: snap(t) });
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

// ------------------------------------------------------------------ the project under another spelling
console.log("an output path that names the project another way is checked like one inside it");
{
  const spellings: [string, (p: string) => string][] = [
    ["through a link to the project", (p) => { const a = join(tmp, `alias-${++n}`); symlinkSync(p, a); return a; }],
    ["through a link to the folder above it", (p) => { const a = join(tmp, `above-${++n}`); symlinkSync(dirname(p), a); return join(a, basename(p)); }],
  ];
  const priv = (p: string) => `/private${p}`;
  if (process.platform === "darwin" && existsSync(priv(tmp)) && realpathSync(priv(tmp)) === realpathSync(tmp)) spellings.push(["with /private in front", priv]);
  for (const [how, spell] of spellings) {
    const groups: [string, [string, string, (p: string, out: string) => unknown][]][] = [
      ["previews", [["preview_frame", ".jpg", (p, out) => api.frame(p, 1, { out })], ["contact_sheet", ".jpg", (p, out) => api.sheet(p, { count: 2, out })], ["scopes", ".jpg", (p, out) => api.scopes(p, 1, { out })]]],
      ["renders", [["export_captions", ".srt", (p, out) => api.exportCaptions(p, { out })], ["export_timeline", ".fcpxml", (p, out) => api.exportTimeline(p, { out })], ["render", ".mp4", (p, out) => api.render(p, { out, draft: true, workers: 1, sheet: false })]]],
    ];
    for (const [dir, acts] of groups) {
      const p = await project(`spelling-${dir}-${++n}`), t = outside("target"), before = snap(t);
      link(p, dir, t);
      const alias = spell(p);
      for (const [name, ext, act] of acts) {
        const c = await code(() => act(p, join(alias, dir, `named-${++n}${ext}`)));
        check(`${dir}/ as a link, ${name} to the project ${how}: unsafe_path, the target is unchanged`, c === "unsafe_path" && snap(t) === before, { c, now: snap(t) });
      }
    }
  }
}

// ------------------------------------------------------------------ a directory of the project that is a link to the project root
console.log("a project directory that is a link to the project root: refused, nothing new in the root");
{
  const cases: [string, string, (p: string) => unknown][] = [
    ["previews", "preview_frame, default output", (p) => api.frame(p, 1)],
    ["previews", "preview_frame, out typed as <root>/previews/x.jpg", (p) => api.frame(p, 1, { out: join(p, "previews", "x.jpg") })],
    ["renders", "export_timeline, default output", (p) => api.exportTimeline(p, {})],
    ["media", "import_media copy=true", (p) => api.apply(p, [{ op: "import_media", path: join(m, "other.mp4"), copy: true }])],
  ];
  for (const [dir, what, act] of cases) {
    const p = await project(`rootlink-${dir}-${++n}`);
    link(p, dir, p);
    utimesSync(p, 1e9, 1e9);
    const before = `${readdirSync(p).sort().join()}|${lstatSync(p).mtimeMs}`;
    const c = await code(() => act(p));
    const now = `${readdirSync(p).sort().join()}|${lstatSync(p).mtimeMs}`;
    check(`${dir}/ as a link to the project root: ${what} -> unsafe_path, nothing new in the root`, c === "unsafe_path" && now === before, { c, before, now });
  }
}

// ------------------------------------------------------------------ a timeline name in a default output path
console.log("a timeline name with separators or dots: default outputs stay one file in renders/");
{
  for (const name of ["../../up", "a/b\\c", "..", ".hidden", "/abs/x", ""]) {
    const p = await project(`name-${++n}`);
    const f = JSON.parse(readFileSync(join(p, "project.json"), "utf8")); f.name = name; writeFileSync(join(p, "project.json"), JSON.stringify(f)); // a received project.json is not limited to what set_settings accepts
    const out: any = await api.exportTimeline(p, {});
    const cap: any = api.exportCaptions(p, {});
    for (const [what, o] of [["export_timeline", out.output], ["export_captions", cap.output]]) {
      check(`name ${JSON.stringify(name)}: ${what} writes directly in renders/, not hidden`, typeof o === "string" && dirname(o) === join(p, "renders") && !basename(o).startsWith("."), { o });
    }
  }
}

// ------------------------------------------------------------------ a directory at the output's name
console.log("an output path that is a directory: refused with unsafe_path, no temp file is left");
{
  const outputs: [string, string, string, (p: string, out: string) => unknown][] = [
    ["preview_frame", "previews", ".jpg", (p, out) => api.frame(p, 1, { out })],
    ["contact_sheet", "previews", ".jpg", (p, out) => api.sheet(p, { count: 2, out })],
    ["scopes", "previews", ".jpg", (p, out) => api.scopes(p, 1, { out })],
    ["audio_check", "previews", ".png", (p, out) => api.audioCheck(p, { out })],
    ["export_captions", "renders", ".srt", (p, out) => api.exportCaptions(p, { out })],
    ["export_timeline", "renders", ".fcpxml", (p, out) => api.exportTimeline(p, { out })],
    ["render", "renders", ".mp4", (p, out) => api.render(p, { out, draft: true, workers: 1, sheet: false })],
  ];
  const p = await project("final-dir");
  for (const [name, dir, ext, act] of outputs) {
    const out = join(p, dir, `dir-${++n}${ext}`);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "keep.txt"), "keep");
    const c = await code(() => act(p, out));
    check(`${name} to a directory: unsafe_path, the directory is unchanged, no temp file`,
      c === "unsafe_path" && readFileSync(join(out, "keep.txt"), "utf8") === "keep" && readdirSync(join(p, dir)).every((f) => !f.includes(".part-")), { c, entries: readdirSync(join(p, dir)) });
  }
}

// ------------------------------------------------------------------ temp files in flight
console.log("cache prune: only `.part-<pid>-` names count as in flight");
{
  const p = await project("in-flight"), old = join(p, "previews", `old.${process.pid}.tmp`), live = join(p, "previews", `new.part-${process.pid}-abcdef.jpg`);
  writeFileSync(old, "x");
  writeFileSync(live, "y");
  api.cache.prune(p, { maxMb: 0 });
  check("a `.<pid>.tmp` file of a live pid is pruned, a `.part-<pid>-` file is kept", !existsSync(old) && existsSync(live), { old: existsSync(old), live: existsSync(live) });
}

// ------------------------------------------------------------------ volumes without hard links
console.log("volumes without hard links: a named error, and init leaves nothing behind");
{
  for (const c of ["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "ENOSYS"]) {
    const e = S.linkRefusal?.({ code: c });
    check(`link error ${c} -> unsupported_fs with a hint naming the volume types`, e?.code === "unsupported_fs" && /APFS, NTFS or ext4/.test(e.hint ?? "") && /media/.test(e.hint ?? ""), e);
  }
  check("EEXIST and EACCES are not volume errors", ["EEXIST", "EACCES", "ENOENT"].every((c) => S.linkRefusal?.({ code: c }) === null));
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    // a root that cannot be written to makes the first write fail the way the link probe does on such a volume: the root init made is removed again
    const root = join(tmp, "init-no-skeleton"), keep = process.umask(0o777);
    let c: string;
    try { c = await code(() => api.create(root, { preset: "reels" })); } finally { process.umask(keep); if (existsSync(root)) chmodSync(root, 0o700); } // a regression must not leave a dir the suite cannot remove
    check("init that cannot use its new root fails and removes the root it made", c !== "ok" && !existsSync(root), { c, exists: existsSync(root) });
  }
}

// ------------------------------------------------------------------ sidecars of a render
console.log("sidecar names next to a render that are links: the targets are unchanged");
{
  const p = await project("sidecars"), out = join(p, "renders", "s.mp4");
  mkdirSync(join(p, "renders"), { recursive: true });
  const targets: string[] = [];
  for (const f of [`${out}.subs.srt`, `${out}.subs.mp4`]) {
    const t = join(tmp, `sidecar-target-${++n}.bin`);
    writeFileSync(t, "keep");
    symlinkSync(t, f);
    targets.push(t);
  }
  const r: any = await api.render(p, { out, draft: true, workers: 1, subtitles: true }).catch((e) => e);
  check("render with subtitles completes; its contact sheet is in previews/", !!r.output && r.subtitles?.cues > 0 && dirname(r.contact_sheet ?? "") === join(p, "previews"), { code: r.code, message: r.message, sheet: r.contact_sheet });
  check("the sidecar links' targets are unchanged", targets.every((t) => readFileSync(t, "utf8") === "keep"));
  check("the contact sheet is a regular file and none sits next to the output", regular(r.contact_sheet) && readdirSync(join(p, "renders")).every((f) => !f.endsWith(".sheet.jpg")), readdirSync(join(p, "renders")));
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

// ------------------------------------------------------------------ ops that write into media/
console.log("copy and speech ops: a dry run or a refused batch leaves nothing in media/");
{
  const p = await project("media-stage"), list = () => readdirSync(join(p, "media")).sort().join(","), before = list();
  const copy = { op: "import_media", path: join(m, "other.mp4"), copy: true };
  await api.apply(p, [copy], { dryRun: true });
  check("dry run: media/ is unchanged", list() === before, list());
  const bad = await code(() => api.apply(p, [copy, { op: "add_clip", track: "main", src: join(tmp, "no-such-file.mp4") }]));
  check("a batch refused by a later op: media/ is unchanged", bad !== "ok" && list() === before, { bad, now: list() });
  const note = join(tmp, "note.txt");
  writeFileSync(note, "not media");
  const nm = await code(() => api.apply(p, [{ op: "import_media", path: note, copy: true }]));
  check("a file that is not media is refused and not copied", nm !== "ok" && list() === before, { nm, now: list() });
  if (process.platform === "darwin") {
    const vo = { op: "add_voiceover", text: "Hi.", voice: "Linh" };
    await api.apply(p, [vo], { dryRun: true });
    const dry = list();
    const bad2 = await code(() => api.apply(p, [vo, { op: "add_clip", track: "main", src: join(tmp, "no-such-file.mp4") }]));
    check("speech: a dry run and a refused batch leave no .wav in media/", dry === before && bad2 !== "ok" && list() === before, { dry, bad2, now: list() });
    await api.apply(p, [vo]);
    check("speech: a saved batch keeps its .wav", list().split(",").some((f) => f.endsWith(".wav")), list());
  }
  await api.apply(p, [copy]);
  check("a saved batch keeps the copy", regular(join(p, "media", "other.mp4")), list());
}

// ------------------------------------------------------------------ outputs may not replace the project's own files
console.log("render/export/caption/preview output at project.json, .agentcut/ or an asset file: output_is_source, the file is unchanged");
{
  const own = join(tmp, "own-source.mp4"), tgt = join(tmp, "link-target.mp4"), lnk = join(tmp, "link-source.mp4");
  copyFileSync(join(m, "av.mp4"), own);
  copyFileSync(join(m, "av.mp4"), tgt);
  symlinkSync(tgt, lnk);
  const p = await project("out-source");
  await api.apply(p, [{ op: "import_media", path: own }, { op: "import_media", path: join(m, "other.mp4"), copy: true }, { op: "import_media", path: lnk }]);
  const pj = join(p, "project.json"), inMedia = join(p, "media", "other.mp4"), hist = join(p, ".agentcut", "history", "undo", "x.mp4");
  const sums = () => [pj, own, inMedia, tgt].map((f) => readFileSync(f).toString("base64")).join("|"), before = sums();
  const rows: [string, () => unknown][] = [
    ["render over an asset outside the project", () => api.render(p, { out: own, draft: true, sheet: false })],
    ["render over a copied asset in media/", () => api.render(p, { out: inMedia, draft: true, sheet: false })],
    ["render into .agentcut/", () => api.render(p, { out: hist, draft: true, sheet: false })],
    ["export_timeline over project.json", () => api.exportTimeline(p, { format: "fcpxml", out: pj })],
    ["otio over an asset", () => api.exportTimeline(p, { format: "otio", out: inMedia })],
    ["export_captions over project.json", () => api.exportCaptions(p, { out: pj, format: "srt" })],
    ["preview_frame over project.json", () => api.frame(p, 1, { out: pj })],
    ["scopes over an asset", () => api.scopes(p, 1, { out: own })],
    ["render over the target of a symlinked asset", () => api.render(p, { out: tgt, draft: true, sheet: false })],
  ];
  for (const [name, f] of rows) check(`${name}: output_is_source`, (await code(f)) === "output_is_source" && sums() === before, name);
  const up = join(p, "PROJECT.JSON");
  if (S.lexists(up)) check("project.json under another letter case: output_is_source", (await code(() => api.exportTimeline(p, { format: "fcpxml", out: up }))) === "output_is_source" && sums() === before);
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

console.log("subtitle mux part file carries the host tag (the render sweep can remove it after a crash)");
{
  const bin = join(tmp, "fakebin"), rec = join(tmp, "mux-output.txt");
  mkdirSync(bin);
  writeFileSync(join(bin, "ffmpeg"), '#!/bin/sh\nfor a; do last=$a; done\nprintf %s "$last" > "$AGENTCUT_TEST_MUX_REC"\nexit 1\n', { mode: 0o755 });
  const { embedSubtitles } = await import("../src/subtitles.ts");
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`; process.env.AGENTCUT_TEST_MUX_REC = rec;
  let c: string;
  try { c = await code(() => embedSubtitles(join(tmp, "out.mp4"), [{ start: 0, end: 1, text: "x", clip: "c" }])); } finally { process.env.PATH = path; delete process.env.AGENTCUT_TEST_MUX_REC; }
  const name = existsSync(rec) ? basename(readFileSync(rec, "utf8")) : "";
  check("embedSubtitles writes its part file under a host-tagged name", c === "encode_failed" && new RegExp(`^out\\.part-${process.pid}-${S.HOST_TAG}-[0-9a-f]{12}\\.mp4$`).test(name), { c, name, tag: S.HOST_TAG });
}

if (process.argv.includes("--keep")) console.log("kept", tmp); else rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall write checks passed");
process.exit(failures ? 1 : 0);
