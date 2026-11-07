// Regression checks for the review of the colour/audio/vision/ui/verify round: one block per fixed bug.
// Run: bun tests/review.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-review-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root (fonts/vision read it at load)
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
  writeFileSync(join(bin, exe), `#!/bin/sh\nprintf '%s\\n' "$@" > "${tmp}/tts.args"\n` +
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

console.log("schema version: any version but SCHEMA_VERSION fails closed, nothing is rewritten");
{
  const { SCHEMA_VERSION } = await import("../src/model.ts");
  check("SCHEMA_VERSION is 1", SCHEMA_VERSION === 1, SCHEMA_VERSION);
  check("a new project and timeline_schema report SCHEMA_VERSION", tl().version === SCHEMA_VERSION && (api.schema() as any).timeline.version === SCHEMA_VERSION, [tl().version, (api.schema() as any).timeline.version]);
  const caught = async (f: () => unknown): Promise<any> => { try { await f(); return null; } catch (e) { return e; } };
  /** every entry under dir with its content (a symlink with its target) and every directory's mtime, dir itself included: names and
   *  contents alone would miss a file created and removed again behind a link */
  const tree = (dir: string): string => [".", ...readdirSync(dir, { recursive: true }).map(String).sort()].map((n) => {
    const f = join(dir, n), st = lstatSync(f);
    return `${n}:${st.isSymbolicLink() ? "->" + readlinkSync(f) : st.isDirectory() ? "/" + st.mtimeMs : readFileSync(f, "utf8")}`;
  }).join("\n");
  const setVersion = (dir: string, v: unknown) => {
    const t = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
    if (v === undefined) delete t.version; else t.version = v;
    writeFileSync(join(dir, "project.json"), JSON.stringify(t, null, 2));
  };
  const everyPath: [string, (d: string) => unknown][] = [
    ["info", (d) => api.info(d, "json")],
    ["validate", (d) => api.validate(d)],
    ["apply", (d) => api.apply(d, [{ op: "add_marker", t: 1 }])],
    ["apply --dry-run", (d) => api.apply(d, [{ op: "add_marker", t: 1 }], { dryRun: true })],
    ["undo", (d) => api.undo(d)],
    ["redo", (d) => api.redo(d)],
    ["frame", (d) => api.frame(d, 0)],
    ["sheet", (d) => api.sheet(d, {})],
    ["scopes", (d) => api.scopes(d, 0)],
    ["motion", (d) => api.motion(d, {})],
    ["audio_check", (d) => api.audioCheck(d, {})],
    ["review", (d) => api.review(d)],
    ["render", (d) => api.render(d, { out: join(d, "renders", "x.mp4") })],
    ["export otio", (d) => api.exportTimeline(d, { format: "otio", out: join(d, "x.otio") })],
    ["export fcpxml", (d) => api.exportTimeline(d, { format: "fcpxml", out: join(d, "x.fcpxml") })],
    ["export captions", (d) => api.exportCaptions(d, { out: join(d, "x.srt") })],
    ["prepare", (d) => api.prepare(d)],
    ["cache info", (d) => api.cache.info(d)],
    ["ui", async (d) => { const ui = await startUi(d, { port: 0 }); ui.server.closeAllConnections?.(); await new Promise((ok) => ui.server.close(ok)); }],
  ];
  for (const [label, v] of [["version+1", SCHEMA_VERSION + 1], ["no version", undefined]] as const) {
    const d = join(tmp, `ver-${label.replace(/\W/g, "")}`);
    api.create(d, { preset: "reels" });
    await api.apply(d, [{ op: "add_marker", t: 0.5 }]);
    setVersion(d, v);
    const before = readFileSync(join(d, "project.json"), "utf8");
    const hist = () => tree(join(d, ".agentcut", "history"));
    const h0 = hist();
    for (const [name, f] of everyPath) {
      const e = await caught(() => f(d));
      check(`${label}: ${name} -> bad_version`, e?.code === "bad_version", e ? { code: e.code, message: e.message } : "ok");
    }
    const e = await caught(() => api.info(d));
    check(`${label}: the hint names the value found, the one supported, and that there is no upgrade`,
      e?.hint?.includes(String(SCHEMA_VERSION)) && (v === undefined ? /missing/.test(e.hint) : e.hint.includes(String(v))) && e.hint.includes("agentcut init <new dir>") && /no upgrade/.test(e.hint) && e.message.startsWith("project.json "), e);
    check(`${label}: project.json is byte-identical, history untouched`, readFileSync(join(d, "project.json"), "utf8") === before && hist() === h0);
  }
  for (const stack of ["undo", "redo"] as const) {
    const d = join(tmp, `ver-snap-${stack}`);
    api.create(d, { preset: "reels" });
    await api.apply(d, [{ op: "add_marker", t: 0.5 }]);
    if (stack === "redo") await api.undo(d);
    const dir = join(d, ".agentcut", "history", stack), f = join(dir, readdirSync(dir).filter((n) => n.endsWith(".json")).sort().pop()!);
    const snap = JSON.parse(readFileSync(f, "utf8")), inner = JSON.parse(snap.timeline);
    inner.version = SCHEMA_VERSION + 1; snap.timeline = JSON.stringify(inner);
    writeFileSync(f, JSON.stringify(snap));
    const before = readFileSync(join(d, "project.json"), "utf8"), snapBefore = readFileSync(f, "utf8");
    const e = await caught(() => (stack === "undo" ? api.undo(d) : api.redo(d)));
    check(`${stack}: a snapshot of another version -> bad_version`, e?.code === "bad_version", e ? { code: e.code, message: e.message } : "ok");
    check(`${stack}: the message names the snapshot, not project.json`, e?.message.includes(basename(f)) && /history snapshot/.test(e.message) && !e.message.startsWith("project.json"), e?.message);
    check(`${stack}: the hint says to remove that entry and that project.json is fine, not to recreate the project`,
      e?.hint?.includes(basename(f)) && /project\.json itself is fine/.test(e.hint) && !/agentcut init/.test(e.hint), e?.hint);
    check(`${stack}: project.json and the snapshot are untouched`, readFileSync(join(d, "project.json"), "utf8") === before && existsSync(f) && readFileSync(f, "utf8") === snapBefore);
  }
}

console.log("undo/redo act only on history entries, never on a path named inside a snapshot");
{
  const { SCHEMA_VERSION } = await import("../src/model.ts");
  const caught = async (f: () => unknown): Promise<any> => { try { await f(); return null; } catch (e) { return e; } };
  const tree = (dir: string): string => [".", ...readdirSync(dir, { recursive: true }).map(String).sort()].map((n) => {
    const f = join(dir, n), st = lstatSync(f);
    return `${n}:${st.isSymbolicLink() ? "->" + readlinkSync(f) : st.isDirectory() ? "/" + st.mtimeMs : readFileSync(f, "utf8")}`;
  }).join("\n");
  /** a project with `n` entries on `stack`; returns its dir */
  const make = async (name: string, stack: "undo" | "redo", n = 1) => {
    const d = join(tmp, name);
    api.create(d, { preset: "reels" });
    for (let i = 0; i < n; i++) await api.apply(d, [{ op: "add_marker", t: 0.5 + i }]);
    if (stack === "redo") await api.undo(d, n);
    return d;
  };
  const entries = (d: string, stack: string) => readdirSync(join(d, ".agentcut", "history", stack)).filter((x) => x.endsWith(".json")).sort();
  const run = (d: string, stack: string, steps = 1) => (stack === "undo" ? api.undo(d, steps) : api.redo(d, steps));
  for (const stack of ["undo", "redo"] as const) {
    // (a) a "file" key naming a file outside the project, (b) one naming a sibling inside the project but outside history
    for (const [label, where] of [["outside the project", join(tmp, "outside-victim.txt")], ["a sibling inside the project", "keep.txt"]] as const) {
      const d = await make(`path-${stack}-${label.replace(/\W/g, "")}`, stack);
      const victim = where.startsWith("/") ? where : join(d, where);
      writeFileSync(victim, "keep me");
      const f = join(d, ".agentcut", "history", stack, entries(d, stack).pop()!);
      const snap = JSON.parse(readFileSync(f, "utf8")); snap.file = victim; writeFileSync(f, JSON.stringify(snap));
      const e = await caught(() => run(d, stack));
      check(`${stack}: a snapshot naming a file ${label} does not delete it`, existsSync(victim) && readFileSync(victim, "utf8") === "keep me", e ? { code: e.code } : "ok");
      const e2 = await caught(() => (stack === "undo" ? api.redo(d) : api.undo(d)));
      check(`${stack}: ... nor does the opposite step (${label})`, existsSync(victim) && readFileSync(victim, "utf8") === "keep me", e2 ? { code: e2.code } : "ok");
    }
    // (c) an entry that is a symlink to a snapshot outside history, (d) the stack directory itself a symlink
    for (const kind of ["entry symlink", "stack dir symlink"] as const) {
      const d = await make(`link-${stack}-${kind.replace(/\W/g, "")}`, stack);
      const out = join(tmp, `elsewhere-${stack}-${kind.replace(/\W/g, "")}`); mkdirSync(out);
      const dir = join(d, ".agentcut", "history", stack);
      if (kind === "entry symlink") {
        const f = join(dir, entries(d, stack).pop()!);
        renameSync(f, join(out, "snap.json")); symlinkSync(join(out, "snap.json"), f);
      } else {
        for (const n of readdirSync(dir)) renameSync(join(dir, n), join(out, n));
        rmSync(dir, { recursive: true }); symlinkSync(out, dir);
      }
      const proj = readFileSync(join(d, "project.json"), "utf8"), hist = tree(join(d, ".agentcut", "history")), outside = tree(out);
      const e = await caught(() => run(d, stack));
      check(`${stack}: ${kind} -> unsafe_path`, e?.code === "unsafe_path", e ? { code: e.code, message: e.message } : "ok");
      check(`${stack}: ${kind}: project.json, the history dir and the target are byte-identical`,
        readFileSync(join(d, "project.json"), "utf8") === proj && tree(join(d, ".agentcut", "history")) === hist && tree(out) === outside);
    }
    // multi-step is all-or-nothing: a bad snapshot at the second step leaves everything as it was
    {
      const d = await make(`multi-${stack}`, stack, 2);
      const dir = join(d, ".agentcut", "history", stack), f = join(dir, entries(d, stack)[0]);
      const snap = JSON.parse(readFileSync(f, "utf8")), inner = JSON.parse(snap.timeline);
      inner.version = SCHEMA_VERSION + 1; snap.timeline = JSON.stringify(inner); writeFileSync(f, JSON.stringify(snap));
      const proj = readFileSync(join(d, "project.json"), "utf8"), hist = tree(join(d, ".agentcut", "history"));
      const e = await caught(() => run(d, stack, 2));
      check(`${stack} x2: the bad snapshot at the second step -> bad_version`, e?.code === "bad_version", e ? { code: e.code, message: e.message } : "ok");
      check(`${stack} x2: nothing was applied: project.json and both stacks are byte-identical`, readFileSync(join(d, "project.json"), "utf8") === proj && tree(join(d, ".agentcut", "history")) === hist);
    }
  }
}

console.log("history writes never follow a symlink, and nothing is written before a refusal");
{
  const caught = async (f: () => unknown): Promise<any> => { try { await f(); return null; } catch (e) { return e; } };
  const tree = (dir: string): string => [".", ...readdirSync(dir, { recursive: true }).map(String).sort()].map((n) => {
    const f = join(dir, n), st = lstatSync(f);
    return `${n}:${st.isSymbolicLink() ? "->" + readlinkSync(f) : st.isDirectory() ? "/" + st.mtimeMs : readFileSync(f, "utf8")}`;
  }).join("\n");
  const make = async (name: string, stack: "undo" | "redo") => {
    const d = join(tmp, name);
    api.create(d, { preset: "reels" });
    await api.apply(d, [{ op: "add_marker", t: 0.5 }]);
    if (stack === "redo") await api.undo(d);
    return d;
  };
  const acts: [string, (d: string) => unknown][] = [
    ["undo", (d) => api.undo(d)], ["redo", (d) => api.redo(d)],
    ["apply", (d) => api.apply(d, [{ op: "add_marker", t: 1 }])], ["history", (d) => api.history(d)],
  ];

  // DP-10: project.json as a link is replaced by a regular file; the file it pointed to is left alone
  {
    const d = await make("json-link", "undo"), target = join(tmp, "json-link-target.json");
    for (const [name, f] of [["apply", () => api.apply(d, [{ op: "add_marker", t: 2 }])], ["undo", () => api.undo(d)], ["redo", () => api.redo(d)]] as const) {
      writeFileSync(target, readFileSync(join(d, "project.json"), "utf8"));
      const keep = readFileSync(target, "utf8");
      rmSync(join(d, "project.json")); symlinkSync(target, join(d, "project.json"));
      const e = await caught(f);
      check(`project.json as a link: ${name} leaves the target alone and writes a regular file`, readFileSync(target, "utf8") === keep && lstatSync(join(d, "project.json")).isFile(), e ? { code: e.code } : "ok");
    }
  }
  // a dangling project.json symlink is not a free slot for init
  {
    const d = join(tmp, "init-link"), target = join(tmp, "init-link-target.json");
    mkdirSync(d); symlinkSync(target, join(d, "project.json"));
    const e = await caught(() => api.create(d, { preset: "reels" }));
    check("create over a dangling project.json symlink -> exists, nothing written through it", e?.code === "exists" && !existsSync(target), e ? { code: e.code } : "created");
  }
  // DP-08: a bad entry in the stack a call would write to is refused before the call writes anything
  for (const stack of ["undo", "redo"] as const) for (const kind of ["symlink", "directory"] as const) {
    const d = await make(`opposite-${stack}-${kind}`, stack), other = stack === "undo" ? "redo" : "undo";
    const outside = join(tmp, `opposite-${stack}-${kind}-target.json`); writeFileSync(outside, "{}");
    mkdirSync(join(d, ".agentcut", "history", other), { recursive: true });
    const bad = join(d, ".agentcut", "history", other, "1.json");
    if (kind === "symlink") symlinkSync(outside, bad); else mkdirSync(bad);
    for (const [name, f] of [[stack, () => (stack === "undo" ? api.undo(d) : api.redo(d))], ["apply", () => api.apply(d, [{ op: "add_marker", t: 1 }])]] as const) {
      const proj = readFileSync(join(d, "project.json"), "utf8"), hist = tree(join(d, ".agentcut", "history"));
      const e = await caught(f);
      check(`${name} with a ${kind} entry in ${other}/ -> unsafe_path, history and project.json byte-identical`,
        e?.code === "unsafe_path" && readFileSync(join(d, "project.json"), "utf8") === proj && tree(join(d, ".agentcut", "history")) === hist, e ? { code: e.code } : "ok");
    }
  }
  // DP-09: a symlinked .agentcut or history dir: refused before anything is created, written or removed there
  for (const kind of [".agentcut to a populated dir", ".agentcut to an empty dir", "history to a dir"] as const) {
    for (const stack of ["undo", "redo"] as const) {
      const d = await make(`dirlink-${kind.replace(/\W/g, "")}-${stack}`, stack), out = join(tmp, `dirlink-out-${kind.replace(/\W/g, "")}-${stack}`);
      if (kind === "history to a dir") { renameSync(join(d, ".agentcut", "history"), out); symlinkSync(out, join(d, ".agentcut", "history")); }
      else { if (kind === ".agentcut to a populated dir") renameSync(join(d, ".agentcut"), out); else { rmSync(join(d, ".agentcut"), { recursive: true }); mkdirSync(out); } symlinkSync(out, join(d, ".agentcut")); }
      for (const [name, f] of acts) {
        const proj = readFileSync(join(d, "project.json"), "utf8"), before = tree(out);
        const e = await caught(f.bind(null, d));
        check(`${kind} (${stack}): ${name} -> unsafe_path, nothing changed behind the link`,
          e?.code === "unsafe_path" && tree(out) === before && readFileSync(join(d, "project.json"), "utf8") === proj, e ? { code: e.code, message: e.message } : "ok");
      }
    }
  }
}

console.log("replace_timeline rejects a wrong or missing version itself (dry run and real apply agree)");
{
  const { SCHEMA_VERSION } = await import("../src/model.ts");
  const caught = async (f: () => unknown): Promise<any> => { try { await f(); return null; } catch (e) { return e; } };
  const d = join(tmp, "replace-version");
  api.create(d, { preset: "reels" });
  const before = readFileSync(join(d, "project.json"), "utf8");
  for (const [label, v] of [["version+1", SCHEMA_VERSION + 1], ["no version", undefined]] as const) for (const dryRun of [true, false]) {
    const t = JSON.parse(before); if (v === undefined) delete t.version; else t.version = v;
    const e = await caught(() => api.apply(d, [{ op: "replace_timeline", timeline: t }], { dryRun }));
    check(`replace_timeline ${label}${dryRun ? " (dry run)" : ""} -> bad_version about the op input`,
      e?.code === "bad_version" && /op input/.test(e.message) && !e.message.startsWith("project.json") && e.hint.includes(`"version": ${SCHEMA_VERSION}`) && !/init/.test(e.hint), e ? { code: e.code, message: e.message, hint: e.hint } : "ok");
  }
  check("replace_timeline: project.json is byte-identical", readFileSync(join(d, "project.json"), "utf8") === before);
  const good = JSON.parse(before); good.name = "replaced";
  check("replace_timeline with the supported version is applied", (await caught(() => api.apply(d, [{ op: "replace_timeline", timeline: good }]))) === null && api.info(d, "json").timeline.name === "replaced");
}

console.log("ui: concurrent play renders share one job, the cache never sees a partial file");
{
  const ui = await startUi(P, { port: 0 });
  try {
    const post = (body: unknown) => fetch(`${ui.url}api/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    const T = Math.min(4, api.info(P).duration as number); // a long range keeps the draft alive while it is polled and pruned
    const [a, b] = await Promise.all([post({ play: true, start: 0, end: T }), post({ play: true, start: 0, end: T })]);
    const rev = api.info(P).revision;
    const final = join(P, "previews", "ui", `play-r${rev}-0.00-${T.toFixed(2)}.mp4`);
    check("second request joins the running job", a.id === b.id, [a.id, b.id]);
    check("final path absent while rendering", a.status !== "running" || !existsSync(final));
    const uiDir = join(P, "previews", "ui"), parts = () => existsSync(uiDir) ? readdirSync(uiDir).filter((f) => f.includes(".part")) : [];
    let part: string[] = [];
    for (let i = 0; i < 3000 && !part.length; i++) { part = parts(); if (!part.length) await new Promise((ok) => setTimeout(ok, 5)); }
    const seen = part.length ? join(uiDir, part[0]) : "";
    if (seen) api.cache.prune(P); // a prune while the render runs must not take its draft
    check("draft is named .part-<pid>- (protected as in flight) and survives a prune", !!seen && part.every((f) => f.includes(`.part-${process.pid}-`)) && existsSync(seen), { part, now: parts() });
    let done: any = null;
    for (let i = 0; i < 300 && !done; i++) { const s: any = await fetch(`${ui.url}api/jobs/${a.id}`).then((r) => r.json()); if (s.status !== "running") done = s; else await new Promise((ok) => setTimeout(ok, 100)); }
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", final], { encoding: "utf8" });
    check("finished preview is complete and renamed into place", done?.status === "done" && Math.abs(Number(probe.stdout) - T) < 0.1 && parts().length === 0, { done, d: probe.stdout, left: parts() });
    const again = await post({ play: true, start: 0, end: T });
    check("next request is a cache hit", again.status === "done" && again.url === done.url);
  } finally { ui.server.closeAllConnections?.(); await new Promise((ok) => ui.server.close(ok)); }
}

if (process.argv.includes("--keep")) console.log("kept", tmp); else rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall review checks passed");
process.exit(failures ? 1 : 0);
