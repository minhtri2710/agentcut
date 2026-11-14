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
const tl = async () => (await api.info(P, "json")).timeline as any;
const clip = async (id: string) => (await tl()).tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id);

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
      const r = await AN.tts("-5% off today", join(tmp, "vo.wav"));
      const args = readFileSync(join(tmp, "tts.args"), "utf8").split("\n");
      check("dash-leading script is passed as a file", r.duration > 1 && !args.includes("-5% off today") && readFileSync(join(tmp, "tts.text"), "utf8") === "-5% off today", args);
    }
  } finally { process.env.PATH = PATH; }
  if (process.platform === "darwin") {
    const r = await AN.tts("-5% off today", join(tmp, "say.wav"));
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
check("known model passes validation", (await api.validate(P)).valid && (await code(() => api.apply(P, [{ op: "update_clip", id: vid, set: { remove_background: { model: "u2netp" } } }], { dryRun: true }))) === "ok");

console.log("detach_audio carries the audio processing");
{
  await api.apply(P, [{ op: "update_clip", id: vid, set: { eq: "voice_clarity", pan: -0.5, normalize: true } }]);
  const r = await api.apply(P, [{ op: "detach_audio", id: vid }]);
  const aud = (await clip(r.results[0].audio ?? r.results[0].id));
  const v = (await clip(vid));
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
  const audId = (await tl()).tracks.flatMap((t: any) => t.clips).find((c: any) => c.attach_to === vid).id;
  await api.apply(P, [{ op: "set_keyframes", id: audId, prop: "volume", keyframes: [[0, 1], [4, 0]] }]);
  const s = await api.apply(P, [{ op: "split_clip", id: vid, at: 1 }]);
  const right = (await clip(s.results[0].right)), left = (await clip(vid));
  check("left half keeps its curve", kfValue(left.keyframes.opacity, 0.5) === 0.125, left.keyframes);
  check("right half continues the curve (was reset to static)", Math.abs(kfValue(right.keyframes.opacity, 0) - 0.25) < 1e-9 && Math.abs(kfValue(right.keyframes.opacity, 3) - 1) < 1e-9, right.keyframes);
  const ar = (await tl()).tracks.flatMap((t: any) => t.clips).find((c: any) => c.attach_to === right.id);
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
  check("a new project and timeline_schema report SCHEMA_VERSION", (await tl()).version === SCHEMA_VERSION && (api.schema() as any).timeline.version === SCHEMA_VERSION, [(await tl()).version, (api.schema() as any).timeline.version]);
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
      e?.hint?.includes(String(SCHEMA_VERSION)) && (v === undefined ? /missing/.test(e.hint) : e.hint.includes(String(v))) && /create a new project/.test(e.hint) && /no upgrade/.test(e.hint) && e.message.startsWith("project.json "), e);
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
  check("replace_timeline with the supported version is applied", (await caught(() => api.apply(d, [{ op: "replace_timeline", timeline: good }]))) === null && (await api.info(d, "json")).timeline.name === "replaced");
}

console.log("ui: concurrent play renders share one job, the cache never sees a partial file");
{
  const ui = await startUi(P, { port: 0 });
  try {
    const post = (body: unknown) => fetch(`${ui.url}api/render`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json() as any);
    const T = Math.min(4, (await api.info(P)).duration as number); // a long range keeps the draft alive while it is polled and pruned
    const [a, b] = await Promise.all([post({ play: true, start: 0, end: T }), post({ play: true, start: 0, end: T })]);
    const rev = (await api.info(P)).revision;
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

console.log("review: a cancelled review stops, progress is reported, findings do not change");
{
  const { EditError } = await import("../src/model.ts");
  const RP = join(tmp, "rv-run");
  api.create(RP, { width: 320, height: 240, fps: 24 });
  await api.apply(RP, [{ op: "add_clip", track: "main", src: join(m, "av.mp4"), duration: 2 }, { op: "add_clip", track: "main", type: "gap", duration: 1.5 }, { op: "add_clip", track: "main", src: join(m, "av.mp4"), duration: 2 }]);
  const ticks: [number, number][] = [];
  const plain: any = await api.review(RP);
  const reported: any = await api.review(RP, { progress: (d, n) => ticks.push([d, n]) });
  check("review reports each black-frame sample, 1..total", ticks.length === 28 && ticks.every(([d, n], i) => d === i + 1 && n === 28), { n: ticks.length, last: ticks.at(-1) });
  const black = plain.findings.filter((f: any) => f.type === "black_frames");
  check("the black gap is found at its time, and the findings are the same with a progress callback", black.length === 1 && black[0].t >= 1.9 && black[0].t <= 2.2 && black[0].end >= 3.3 && black[0].end <= 3.7 && JSON.stringify(plain.findings) === JSON.stringify(reported.findings), plain.findings);
  const ac = new AbortController();
  let seen = 0;
  const e: any = await api.review(RP, { signal: ac.signal, progress: () => { if (++seen === 3) ac.abort(new EditError("the review was cancelled", "aborted")); } }).catch((x) => x);
  check("a cancelled review stops at the next sample with code aborted", e?.code === "aborted" && seen === 3, { code: e?.code, seen });
  const pre = new AbortController();
  pre.abort(new EditError("the review was cancelled", "aborted"));
  await api.apply(RP, [{ op: "add_clip", track: "text", text: "Hello", at: 0, duration: 2 }]);
  check("a review cancelled before it starts, with a text layer to measure, fails with aborted", (await api.review(RP, { signal: pre.signal }).catch((x) => x))?.code === "aborted");
}

console.log("review: the black-frame scan remembers each source frame and reads each source once, in order");
{
  const { Project } = await import("../src/project.ts");
  const { Renderer } = await import("../src/render.ts");
  const { resolve, totalDuration, clipStart, normAnim } = await import("../src/model.ts");
  const A = join(m, "av.mp4"), dark = join(m, "dark.mp4"), edge = join(m, "edge25.mp4"), long = join(m, "long.mp4"), swap = join(m, "swap.mp4");
  ff("-f", "lavfi", "-i", "color=c=0x050505:s=320x240:r=24:d=6", "-pix_fmt", "yuv420p", dark);
  // 25 fps (the timelines run at 24): bright until 2.0 s, then dark
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=5,format=yuv420p,geq=lum='if(gte(T,2),5,lum(X,Y))':cb='if(gte(T,2),128,cb(X,Y))':cr='if(gte(T,2),128,cr(X,Y))'", "-pix_fmt", "yuv420p", edge);
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=12", "-pix_fmt", "yuv420p", long);
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=4", "-pix_fmt", "yuv420p", swap);
  const build = async (name: string, ops: object[]) => {
    const d = join(tmp, `bm-${name}`);
    api.create(d, { width: 320, height: 240, fps: 24 });
    const r: any = await api.apply(d, ops);
    return { d, ids: r.results.map((x: any) => x.id as string) };
  };
  const vid = (extra: object = {}, src = A) => ({ op: "add_clip", track: "main", src, ...extra });
  const gap = (duration: number) => ({ op: "add_clip", track: "main", type: "gap", duration });
  // the scan as it was before the memo: the renderer draws every sample, runs are two or more dark samples in a row
  const renderOnly = async (d: string) => {
    const pj = new Project(d), t = pj.absolutized(resolve(pj.load())), T = totalDuration(t), step = 0.2, fps = Number(t.settings.fps);
    const R = new Renderer(structuredClone(t), pj.root, Math.min(1, 64 / t.settings.width));
    const dips: [number, number][] = [], low: number[] = [];
    for (const tr of t.tracks) if (!tr.hidden && (tr.kind ?? "video") !== "audio") tr.clips.forEach((c: any, i: number) => {
      const s = i > 0 ? normAnim(c.transition, 0.5) : null;
      if (s?.type === "dip_black") dips.push([clipStart(c), clipStart(c) + s.duration]);
    });
    try {
      for (let x = 0; x < T - 1e-6; x += step) {
        const tt = Math.min(x, T - 1 / fps);
        await R.frame(tt);
        const px = R.pixels();
        let bright = 0;
        for (let i = 0; i < px.length; i += 4) if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] > 24) bright++;
        if (bright / (px.length / 4) < 0.03 && !dips.some(([a, b]) => tt >= a - 1e-6 && tt <= b + 1e-6)) low.push(tt);
      }
    } finally { R.close(); }
    const runs: number[][] = [];
    for (let i = 0; i < low.length; i++) {
      let j = i;
      while (j + 1 < low.length && low[j + 1] - low[j] < step * 1.5) j++;
      if (j > i) runs.push([+low[i].toFixed(3), +Math.min(T, low[j] + step).toFixed(3)]);
      i = j;
    }
    return runs;
  };
  const scan = async (d: string) => {
    const stats: any = {}, rv: any = await api.review(d, { stats } as any);
    return { stats, black: rv.findings.filter((f: any) => f.type === "black_frames").map((f: any) => [f.t, f.end]) as number[][] };
  };
  const same = (...x: unknown[]) => x.every((v) => JSON.stringify(v) === JSON.stringify(x[0]));

  // guards: the six cases keep the findings the scan gave before the memo
  const truth: [string, object[], number[][], object[]?][] = [
    ["tr_clean", [vid(), vid(), vid()], [], [{ op: "add_transition", to: "vid2", type: "crossfade", duration: 0.5 }]],
    ["tr_gap", [vid({ duration: 3 }), gap(2), vid({ duration: 3 })], [[3, 5]]],
    ["tr_gap_short", [vid({ duration: 3 }), gap(0.3), vid({ duration: 3 })], [[3, 3.4]]],
    ["tr_dark", [vid({ duration: 3 }), vid({}, dark), vid({ duration: 3 })], [[3, 9]]],
    ["tr_fade", [vid({ exit: { type: "fade", duration: 1.5 } }), vid({ enter: { type: "fade", duration: 1.5 } })], []],
    ["tr_dip", [vid(), vid()], [], [{ op: "add_transition", to: "vid2", type: "dip_black", duration: 1.2 }]],
  ];
  for (const [name, ops, want, after] of truth) {
    const { d } = await build(name, ops);
    if (after) await api.apply(d, after);
    const fresh = await scan(d), again = await scan(d);
    check(`${name}: black ${want.map(([a, b]) => `${a}-${b}`).join(", ") || "none"} on a first scan, from the memo, and as the renderer alone draws it`,
      same(fresh.black, want, again.black, await renderOnly(d)) && again.stats.frames === 0, { fresh: fresh.black, again: again.black, stats: again.stats });
  }

  // new rows
  const reuse = await build("reuse", [1, 2, 3, 4].map(() => vid({ in: 0, duration: 2 })));
  const rs = await scan(reuse.d);
  check("four clips over the same two seconds of source: each frame is decoded once and every sample comes from the plain path",
    rs.stats.frames > 0 && rs.stats.frames <= 2 * 24 && rs.stats.rendered === 0 && rs.stats.memo + rs.stats.read === 40 && !rs.black.length, rs.stats);

  const off = await build("offgrid", [vid({ in: 1.013, duration: 2 }, edge), vid({ in: 0.5, duration: 2.5 }, edge)]);
  const os = await scan(off.d), ref = await renderOnly(off.d);
  check("two clips with different in-point phases over a 25 fps source at a bright-to-dark edge: each is read on its own and the black runs are the renderer's",
    ref.length === 2 && same(os.black, ref) && os.stats.rendered === 0, { memo: os.black, renderer: ref, stats: os.stats });

  // The granted bound (inspect.ts blackRuns): a clip read mid-stream may get another source frame than its own fresh seek gives, up to
  // 2 timeline frames apart. In findings: an edge is within one 0.2 s step of the renderer's, and a stretch appears or vanishes only
  // when it is within one step of the 0.4 s minimum.
  const within = (got: number[][], want: number[][]) => {
    const near = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) < 0.2 + 1e-6 && Math.abs(a[1] - b[1]) < 0.2 + 1e-6, short = (r: number[]) => r[1] - r[0] < 0.6 + 1e-6;
    return got.every((g) => want.some((w) => near(g, w)) || short(g)) && want.every((w) => got.some((g) => near(g, w)) || short(w));
  };
  const edgeA = join(m, "edge25a.mp4"); // the same picture with an AAC track, as camera files have
  ff("-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=5,format=yuv420p,geq=lum='if(gte(T,2),5,lum(X,Y))':cb='if(gte(T,2),128,cb(X,Y))':cr='if(gte(T,2),128,cr(X,Y))'",
    "-f", "lavfi", "-i", "sine=f=440:d=6", "-c:a", "aac", "-shortest", "-pix_fmt", "yuv420p", edgeA);

  // one key, one stream: clip B (in 47.1/24 s) starts at the edge, between source frame 49 (1.96 s, bright) and 50 (2.00 s, dark), in the run that clip A (in 0.1/24 s) opened
  for (const [what, src, want] of [["a video-only", edge, "same"], ["an AAC-carrying", edgeA, "within"]] as const) {
    const mid = await build(`midrun-${want}`, [vid({ in: 0.1 / 24, duration: 2 }, src), vid({ in: 47.1 / 24, duration: 2 }, src)]);
    const ms = await scan(mid.d), mref = await renderOnly(mid.d);
    check(`a clip that starts mid-run of another clip with the same key, at a bright-to-dark edge of ${what} 25 fps source: the black runs are the renderer's, within the bound`,
      mref.length === 1 && within(ms.black, mref) && (want === "within" || same(ms.black, mref)) && ms.stats.rendered === 0 && ms.stats.frames > 0, { memo: ms.black, renderer: mref, stats: ms.stats });
  }

  // a plain clip behind a leading transition: its stream starts after the transition's window, which the renderer draws
  const lead = await build("leading", [vid({ in: 0.1 / 24, duration: 2 }, edgeA), vid({ in: 40.1 / 24, duration: 2.5 }, edgeA)]);
  await api.apply(lead.d, [{ op: "add_transition", to: lead.ids[1], type: "crossfade", duration: 0.5 }]);
  const ls = await scan(lead.d);
  check("a plain clip behind a leading transition: the transition's samples are drawn, the rest come from the memo, and the black runs are the renderer's, within the bound",
    ls.stats.rendered > 0 && ls.stats.memo + ls.stats.read > 0 && within(ls.black, await renderOnly(lead.d)), { memo: ls.black, renderer: await renderOnly(lead.d), stats: ls.stats });

  const ed = await build("edit", [0, 3, 6, 9].map((s) => vid({ in: s, duration: 1 }, long)));
  const e1 = await scan(ed.d);
  await api.apply(ed.d, [{ op: "update_clip", id: ed.ids[3], set: { in: 11 } }]);
  const e2 = await scan(ed.d);
  check("a second review after one clip changed decodes only that clip's frames and takes the other three clips' samples from the memo",
    e1.stats.read === 20 && e2.stats.frames > 0 && e2.stats.frames <= 24 && e2.stats.read === 5 && e2.stats.memo === 15 && e2.stats.rendered === 0 && !e2.black.length, { first: e1.stats, second: e2.stats });

  const sw = await build("swap", [vid({ duration: 3 }, swap)]);
  const s1 = await scan(sw.d);
  ff("-f", "lavfi", "-i", "color=c=0x050505:s=320x240:r=24:d=4", "-pix_fmt", "yuv420p", swap);
  const s2 = await scan(sw.d);
  check("the memo is not used for a source file that changed: the new file is read and its black stretch found",
    !s1.black.length && same(s2.black, [[0, 3]], await renderOnly(sw.d)) && s2.stats.memo === 0 && s2.stats.frames > 0, { before: s1.black, after: s2.black, stats: s2.stats });

  const names = () => readdirSync(join(reuse.d, ".agentcut", "cache")).filter((f) => /^dark-.*\.json$/.test(f));
  const had = names(), counted = (api.cache.info(reuse.d) as any).cache.files;
  const pruned: any = api.cache.prune(reuse.d);
  const rebuilt = await scan(reuse.d);
  check("the memo is a cache file: cache info counts it, prune removes it, the next review rebuilds it",
    had.length === 1 && counted >= 1 && pruned.files.some((f: string) => f.includes(had[0])) && rebuilt.stats.memo === 0 && rebuilt.stats.frames > 0 && names().length === 1, { had, counted, pruned: pruned.files, stats: rebuilt.stats });

  chmodSync(join(reuse.d, ".agentcut", "cache", names()[0]), 0);
  const unreadable = await scan(reuse.d);
  check("a memo file that cannot be read is a miss: the review still runs and rewrites it", process.getuid?.() === 0 || unreadable.stats.memo === 0 && unreadable.stats.frames > 0 && !unreadable.black.length, unreadable.stats);

  const mixed = await build("mixed", [vid({ in: 0, duration: 2 }), vid({ speed: 2, duration: 2 }), { op: "add_clip", track: "text", text: "Hi", at: 0.5, duration: 1 }]);
  const mx = await scan(mixed.d);
  check("clips off the fast path (a speed change, a title above) are drawn by the renderer, the rest from the memo, and the findings are the renderer's",
    mx.stats.memo + mx.stats.read === 5 && mx.stats.rendered === 15 && same(mx.black, await renderOnly(mixed.d)), mx.stats);
}

console.log("templates: the text of every template stays inside the safe area at every preset size");
{
  const { TEMPLATES } = await import("../src/presets.ts");
  const { PRESETS } = await import("../src/model.ts");
  ff("-f", "lavfi", "-i", "gradients=size=800x800:n=4", "-frames:v", "1", join(m, "p.png"));
  ff("-f", "lavfi", "-i", "aevalsrc='sin(2*PI*60*t)*exp(-25*mod(t,0.5))':s=44100:d=12", "-ac", "2", join(m, "beat.wav"));
  const png = join(m, "p.png"), media = [png, png, png];
  const args: Record<string, object> = {
    slideshow: { media, title: "Our summer trip" },
    promo: { media, hook: "Meet the new Model X", points: ["Fast", "Simple"], cta: "Buy now", brand_color: "#FFD60A" },
    beat_montage: { media, music: join(m, "beat.wav"), title: "Album" },
    quote: { text: "Stay hungry, stay foolish", author: "Steve" },
    listicle: { title: "Top picks", items: [{ text: "First pick", media: png }, { text: "Noise-cancelling wireless earbuds with a charging case", media: png }] },
  };
  check("every template has arguments here", JSON.stringify(Object.keys(args).sort()) === JSON.stringify(Object.keys(TEMPLATES).sort()), Object.keys(TEMPLATES));
  for (const name of Object.keys(TEMPLATES)) {
    const bad: Record<string, string> = {};
    for (const [preset, [w, h]] of Object.entries(PRESETS)) {
      const d = join(tmp, `tpl-${name}-${preset}`);
      api.create(d, { width: w, height: h });
      await api.apply(d, [{ op: "apply_template", name, ...args[name] }]);
      const unsafe = ((await api.review(d, { black: false })) as any).findings.filter((f: any) => f.type === "text_unsafe");
      if (unsafe.length) bad[preset] = unsafe.map((f: any) => f.message).join("; ");
    }
    check(`${name}: no text_unsafe at any preset size`, !Object.keys(bad).length, bad);
  }
}

console.log("templates: placement is kept where it was safe, a preset's own placement is kept, margin takes x and y");
{
  const { Project } = await import("../src/project.ts");
  const { Renderer } = await import("../src/render.ts");
  const { resolve } = await import("../src/model.ts");
  const MP = join(tmp, "margin-xy");
  api.create(MP, { preset: "reels" });
  await api.apply(MP, [{ op: "add_clip", track: "text", text: "Label", at: 0, duration: 2, font_size: 60, position: "bottom_left", margin: "5% 20%" }]);
  const pj = new Project(MP), R = new Renderer(pj.absolutized(resolve(pj.load())), pj.root, 1);
  const b = await R.layoutBox(R.layers.find((l) => l.type === "text")!, 1);
  R.close();
  check("a margin 'x y' sets the left distance and the bottom distance apart (5% and 20% of 1080 px)", !!b && Math.abs(b[0] - 54) < 2 && Math.abs(1920 - (b[1] + b[3]) - 216) < 2, b);
  const marginIn = async (margin: unknown) => code(() => api.apply(MP, [{ op: "add_clip", track: "text", text: "M", at: 3, duration: 1, position: "top", margin }]));
  const refused = [await marginIn("5% 20% 30%"), await marginIn("5% x"), await marginIn("abc"), await marginIn("")];
  check("a margin with three parts, a part that is not a length, or no value is refused at validation", refused.every((c) => c === "validation_failed"), refused);
  const accepted = [await marginIn("5% 12%"), await marginIn("40px 12%"), await marginIn("8%"), await marginIn(40)];
  check("one length or 'x y' (number, px or %) is accepted", accepted.every((c) => c === "ok"), accepted);
  const titleOf = async (preset: string, extra: object = {}) => {
    const d = join(tmp, `ttl-${preset}-${Object.keys(extra).length}`);
    api.create(d, { preset });
    await api.apply(d, [{ op: "apply_template", name: "slideshow", media: [join(m, "p.png")], title: "Hi", ...extra }]);
    return ((await api.info(d, "json")).timeline as any).tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === "text");
  };
  const land = await titleOf("youtube"), vert = await titleOf("reels"), own = await titleOf("youtube", { title_preset: "lower_third" }), ownV = await titleOf("reels", { title_preset: "lower_third" });
  check("slideshow title: centred where the canvas has no UI zones, at the top where it has", land.position === undefined && vert.position === "top", [land.position, vert.position]);
  check("slideshow title_preset keeps its own position (bottom-left) at both sizes, with a margin inside the safe area", own.position === "bottom_left" && ownV.position === "bottom_left" && /^[\d.]+% [\d.]+%$/.test(ownV.margin), [own, ownV]);
}

if (process.argv.includes("--keep")) console.log("kept", tmp); else rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall review checks passed");
process.exit(failures ? 1 : 0);
