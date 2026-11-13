// MCP end-to-end: spawns the server over stdio, exercises the main tools like an agent would.
// Run: bun tests/mcp.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cmd = process.env.AGENTCUT_MCP ? [process.env.AGENTCUT_MCP] : [process.execPath, resolve(import.meta.dir, "../src/mcp.ts")];
const tmp = mkdtempSync(join(tmpdir(), "agentcut-mcp-"));
const env = { ...(process.env as Record<string, string>), AGENTCUT_HOME: join(tmp, "home"), AGENTCUT_CACHE: join(tmp, "cache") }; // isolated feedback store + cache
spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=4", "-pix_fmt", "yuv420p", join(tmp, "a.mp4")]);
spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "gradients=size=800x800", "-frames:v", "1", join(tmp, "p.png")]);
let fails = 0;
const check = (n: string, c: unknown, info?: unknown) => { console.log(`  ${c ? "✓" : "✗"} ${n}`, c ? "" : JSON.stringify(info).slice(0, 500)); if (!c) fails++; };

const client = new Client({ name: "agentcut-test", version: "1" });
await client.connect(new StdioClientTransport({ command: cmd[0], args: cmd.slice(1), env }));
const t0 = performance.now();
const tools = (await client.listTools()).tools;
check(`lists tools (${tools.length})`, tools.length >= 20, tools.map((t) => t.name));
const callOn = (c: Client) => async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await c.callTool({ name, arguments: args });
  const txt = r.content.find((x: any) => x.type === "text")?.text;
  return { r, json: txt?.startsWith("{") ? JSON.parse(txt) : txt, images: r.content.filter((x: any) => x.type === "image") };
};
const call = callOn(client);
check("guide", String((await call("guide")).json).includes("Mental model"));
const created = await call("create_project", { path: join(tmp, "p"), preset: "youtube" });
check("create_project", created.json.ok);
const ap = await call("apply_ops", { ops: [
  { op: "add_sequence", track: "main", items: [join(tmp, "a.mp4"), join(tmp, "p.png")], defaults: { duration: 2, transition: "crossfade", motion: "ken_burns" } },
  { op: "add_clip", track: "text", text: "Hello MCP", attach_to: "main#0", offset: 0.2, match_duration: true, preset: "neon" },
] });
check("apply_ops", ap.json.ok && ap.json.results[0].added.length === 2, ap.json);
const dry = await call("apply_ops", { ops: [{ op: "add_marker", t: 1 }], dry_run: true });
check("apply_ops names the project root, dry run included", ap.json.project === created.json.project && dry.json.dry_run && dry.json.project === created.json.project, { ap: ap.json.project, dry: dry.json.project, created: created.json.project });
const bad = await call("apply_ops", { ops: [{ op: "add_clip", text: "x", enter: "fly_in" }] });
check("bad batch rejected + hint", !bad.json.ok && bad.json.error.code === "validation_failed", bad.json);
const fr = await call("preview_frame", { t: 1 });
check("preview_frame returns image (jpeg)", fr.images.length === 1 && fr.images[0].data.length > 1000 && fr.images[0].mimeType === "image/jpeg");
const sh = await call("contact_sheet", { count: 6 });
check("contact_sheet returns image", sh.images.length === 1);
const rd = await call("render", { draft: true, wait_seconds: 60 });
check("render draft", rd.json.ok && rd.json.status === "done" && rd.json.result.frames > 0, rd.json);
const ex = await call("export_timeline", { format: "otio", output: join(tmp, "edit.otio") });
check("export_timeline otio", ex.json.ok && ex.json.format === "otio" && JSON.parse(readFileSync(join(tmp, "edit.otio"), "utf8")).OTIO_SCHEMA === "Timeline.1", ex.json);
await call("apply_ops", { ops: [{ op: "add_captions", words: [{ text: "Hi", start: 0.2, end: 0.8 }] }] });
const ec = await call("export_captions", { output: join(tmp, "subs.vtt") });
check("export_captions vtt", ec.json.ok && ec.json.cues === 1 && readFileSync(join(tmp, "subs.vtt"), "utf8").startsWith("WEBVTT"), ec.json);
await call("undo", {});
const info = await call("project_info", {});
check("project_info summary", String(info.json.summary).includes("attached→vid1"), info.json.summary);
check("undo", (await call("undo", {})).json.ok);
const fb1 = await call("report_feedback", { kind: "missing_feature", title: "no op to detach audio from a video clip", suggestion: "detach_audio op" });
const fb2 = await call("report_feedback", { kind: "missing_feature", title: "No op to detach the audio of video clips" });
check("report_feedback dedups", fb1.json.ok && fb2.json.merged && fb2.json.count === 2, [fb1.json, fb2.json]);
const sum = await call("feedback_summary", {});
check("summary has auto-logged guess 'fly_in'", sum.json.naming_misses?.some((m: any) => m.guess === "fly_in"), sum.json.naming_misses);
check("summary ranks the note", sum.json.recommendations?.[0]?.text.includes("detach audio"), sum.json.recommendations);
check("markdown report", String((await call("feedback_summary", { markdown: true })).json).includes("# AgentCut improvement backlog"));
const gone = await call("render_status", { job_id: "nope", wait_seconds: 0 });
check("render_status of an unknown job: not_found with a hint to re-run prepare/render", !gone.json.ok && gone.json.error.code === "not_found" && /prepare|render/.test(gone.json.error.hint ?? ""), gone.json);
const V = (await call("timeline_schema")).json.timeline.version;
check("timeline_schema reports the version a new project carries", Number.isInteger(V) && JSON.parse(readFileSync(join(tmp, "p", "project.json"), "utf8")).version === V, V);
for (const [label, v] of [["version+1", V + 1], ["no version", undefined]] as const) {
  const d = join(tmp, `ver-${label.replace(/\W/g, "")}`);
  await call("create_project", { path: d, preset: "youtube" });
  const t = JSON.parse(readFileSync(join(d, "project.json"), "utf8"));
  if (v === undefined) delete t.version; else t.version = v;
  writeFileSync(join(d, "project.json"), JSON.stringify(t, null, 2));
  const before = readFileSync(join(d, "project.json"), "utf8");
  for (const [tool, args] of [["validate", {}], ["project_info", {}], ["apply_ops", { ops: [{ op: "add_marker", t: 1 }] }], ["undo", {}], ["render", { draft: true }]] as const) {
    const r = await call(tool, { project: d, ...args });
    check(`${label}: ${tool} -> bad_version with a hint naming both versions`, r.json.ok === false && r.json.error.code === "bad_version" && r.json.error.hint.includes(String(V)) && r.json.error.hint.includes(String(v ?? "missing")), r.json);
  }
  check(`${label}: project.json is byte-identical`, readFileSync(join(d, "project.json"), "utf8") === before, "rewritten");
}
{
  const d = join(tmp, "replace-version");
  await call("create_project", { path: d, preset: "youtube" });
  const before = readFileSync(join(d, "project.json"), "utf8");
  for (const [label, v] of [["version+1", V + 1], ["no version", undefined]] as const) for (const dry_run of [true, false]) {
    const t = JSON.parse(before); if (v === undefined) delete t.version; else t.version = v;
    const r = await call("apply_ops", { project: d, dry_run, ops: [{ op: "replace_timeline", timeline: t }] });
    check(`apply_ops replace_timeline ${label}${dry_run ? " (dry run)" : ""} -> bad_version about the op input`,
      r.json.ok === false && r.json.error.code === "bad_version" && /op input/.test(r.json.error.message) && r.json.error.hint.includes(`"version": ${V}`), r.json);
  }
  check("replace_timeline: project.json is byte-identical", readFileSync(join(d, "project.json"), "utf8") === before, "rewritten");
}
// allow_download reaches the face-model download (analyze_subject and prepare). This server runs with a stub fetch loaded by --preload
// (the test's own file): every download attempt is recorded and answered 404, so nothing touches the network. uv is a stand-in (AGENTCUT_UV)
// that records any run: the gate and the download come before the helper, so it never runs, and the rows do not depend on a uv on the host.
if (process.env.AGENTCUT_MCP) console.log("  - allow_download pass-through skipped: a compiled server takes no --preload");
else {
  const { chmodSync, existsSync } = await import("node:fs");
  const { FACE_MODEL } = await import("../src/vision.ts");
  const fetchLog = join(tmp, "mcp-fetch.log"), stub = join(tmp, "mcp-fetch-stub.ts"), uv2 = join(tmp, "mcp-uv-unused.sh"), uv2Ran = join(tmp, "mcp-uv-unused.ran");
  writeFileSync(stub, `import { appendFileSync } from "node:fs";\nglobalThis.fetch = (async (u: unknown) => { appendFileSync(${JSON.stringify(fetchLog)}, String(u) + "\\n"); return new Response("no", { status: 404 }); }) as typeof fetch;\n`);
  writeFileSync(uv2, `#!/bin/sh\n: > ${JSON.stringify(uv2Ran)}\nexit 1\n`);
  chmodSync(uv2, 0o755);
  const fetched = () => { try { return readFileSync(fetchLog, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const c2 = new Client({ name: "agentcut-test-2", version: "1" });
  await c2.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-install", "--preload", stub, resolve(import.meta.dir, "../src/mcp.ts")], env: { ...env, AGENTCUT_UV: uv2 } }));
  const call2 = callOn(c2);
  const D = join(tmp, "dl");
  await call2("create_project", { path: D, preset: "reels" });
  await call2("apply_ops", { ops: [{ op: "add_clip", track: "main", src: join(tmp, "a.mp4"), duration: 3 }, { op: "auto_reframe", id: "vid1" }] });
  const code = (r: any) => r.json?.error?.code ?? r.json?.status;
  const s0 = await call2("analyze_subject", { path: join(tmp, "a.mp4"), fps: 2 }), p0 = await call2("prepare", { wait_seconds: 20 });
  check("MCP analyze_subject and prepare without allow_download: model_not_cached, nothing fetched", code(s0) === "model_not_cached" && p0.json.error?.code === "model_not_cached" && fetched().length === 0, { s0: s0.json, p0: p0.json, fetched: fetched() });
  const s1 = await call2("analyze_subject", { path: join(tmp, "a.mp4"), fps: 2, allow_download: true }), n1 = fetched().length;
  const p1 = await call2("prepare", { allow_download: true, wait_seconds: 20 });
  check("MCP analyze_subject with allow_download reaches the face-model download (stub 404 -> model_download_failed)", code(s1) === "model_download_failed" && n1 === 1 && fetched()[0] === FACE_MODEL.url, { s1: s1.json, fetched: fetched() });
  check("MCP prepare with allow_download reaches the same download", p1.json.error?.code === "model_download_failed" && fetched().length === 2 && fetched()[1] === FACE_MODEL.url && !existsSync(uv2Ran), { p1: p1.json, fetched: fetched(), uvRan: existsSync(uv2Ran) });
  await c2.close();
}
// analyze_subject caches in the project (the project arg, else the one the server remembers) and in the user cache with none; auto_reframe then reuses
// the project's result. This server runs a stand-in for uv (AGENTCUT_UV) that answers every subject job with a fixed track, so no real helper runs.
{
  const { readdirSync, mkdirSync, chmodSync } = await import("node:fs");
  const { FACE_MODEL } = await import("../src/vision.ts");
  const cache3 = join(tmp, "cache3"), uv = join(tmp, "mcp-fake-uv.mjs"), uvLog = join(tmp, "mcp-fake-uv.log");
  writeFileSync(uv, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const job = JSON.parse(process.argv.at(-1)), n = job.fps ? Math.max(2, Math.round((job.duration ?? 4) * job.fps)) : 1;
appendFileSync(${JSON.stringify(uvLog)}, job.cmd + "\\n");
process.stdout.write(JSON.stringify({ samples: Array.from({ length: n }, (_, i) => ({ t: +((job.start ?? 0) + i / (job.fps ?? 6)).toFixed(4), x: 0.5, y: 0.5, kind: "saliency", score: 0.5 })) }));
`);
  chmodSync(uv, 0o755);
  mkdirSync(join(cache3, "models", FACE_MODEL.name), { recursive: true });
  writeFileSync(join(cache3, "models", FACE_MODEL.name, `${FACE_MODEL.name}.onnx`), "");
  const env3: Record<string, string | undefined> = { ...env, AGENTCUT_CACHE: cache3, AGENTCUT_UV: uv };
  delete env3.AGENTCUT_PROJECT;
  const c3 = new Client({ name: "agentcut-test-3", version: "1" });
  await c3.connect(new StdioClientTransport({ command: cmd[0], args: cmd.slice(1), env: env3 as Record<string, string> }));
  const call3 = callOn(c3), runs = () => { try { return readFileSync(uvLog, "utf8").split("\n").filter(Boolean).length; } catch { return 0; } };
  const subj = (dir: string) => { try { return readdirSync(dir).filter((f) => f.startsWith("subject-")); } catch { return []; } };
  const userVision = join(cache3, "vision"), pcache = (d: string) => join(d, ".agentcut", "cache"), a4 = join(tmp, "a.mp4");
  const n0 = await call3("analyze_subject", { path: a4 });
  check("MCP analyze_subject with no project open: ok, cached in the user cache",
    n0.json.ok === true && n0.json.cached === false && runs() === 1 && subj(userVision).length === 1, n0.json);
  const D3 = join(tmp, "subj3"), D4 = join(tmp, "subj4");
  await call3("create_project", { path: D3, preset: "reels" });
  await call3("apply_ops", { ops: [{ op: "add_clip", track: "main", src: a4 }] });
  const n1 = await call3("analyze_subject", { path: a4 });
  check("MCP analyze_subject with a remembered project: cached in that project, not read from or written to the user cache",
    n1.json.ok === true && n1.json.cached === false && runs() === 2 && subj(pcache(D3)).length === 1 && subj(userVision).length === 1, n1.json);
  const rf = await call3("apply_ops", { ops: [{ op: "auto_reframe", id: "vid1" }] });
  check("MCP auto_reframe on the whole clip reuses it: applied at once, no pending, helper not run", rf.json.ok === true && !rf.json.results[0].pending && runs() === 2, rf.json);
  await call3("create_project", { path: D4, preset: "reels" });
  await call3("open_project", { path: D3 });
  const n2 = await call3("analyze_subject", { path: a4, fps: 5, project: D4 });
  check("MCP analyze_subject with a project arg: cached in that project, not the remembered one",
    n2.json.ok === true && n2.json.cached === false && runs() === 3 && subj(pcache(D4)).length === 1 && subj(pcache(D3)).length === 1 && subj(userVision).length === 1, n2.json);
  const n3 = await call3("analyze_subject", { path: a4, project: join(tmp, "no-such-project") });
  check("MCP analyze_subject with a project arg that is not a project -> no_project, helper not run", n3.json.ok === false && n3.json.error.code === "no_project" && runs() === 3, n3.json);
  await c3.close();
}
// A-14/A-40/A-39: the remembered project, job errors, view_image, create_project height, schema bounds
{
  const env5: Record<string, string | undefined> = { ...env }; delete env5.AGENTCUT_PROJECT;
  const c5 = new Client({ name: "agentcut-test-5", version: "1" });
  await c5.connect(new StdioClientTransport({ command: cmd[0], args: cmd.slice(1), env: env5 as Record<string, string> }));
  const call5 = callOn(c5), A = join(tmp, "rem-a"), B = join(tmp, "rem-b"), rev = (d: string) => JSON.parse(readFileSync(join(d, "project.json"), "utf8")).revision;
  await call5("create_project", { path: A, preset: "youtube" });
  await call5("create_project", { path: B, preset: "youtube" });
  await call5("open_project", { path: A });
  await call5("project_info", { project: B });
  const rb = rev(B);
  await call5("apply_ops", { ops: [{ op: "add_marker", t: 1 }] });
  check("a project arg on another tool does not change the remembered project", rev(A) === 1 && rev(B) === rb, { a: rev(A), b: rb });
  const bo = await call5("open_project", { path: join(tmp, "no-such-project") });
  await call5("apply_ops", { ops: [{ op: "add_marker", t: 2 }] });
  check("a failed open_project keeps the remembered project", bo.json.ok === false && rev(A) === 2 && rev(B) === rb, { bo: bo.json, a: rev(A) });

  const bad5 = await call5("render", { project: A, draft: true, output: join(tmp, "no-such-dir", "x.xyz"), wait_seconds: 30 });
  check("a failed job is an error result", bad5.json.status === "failed" && bad5.json.ok === false && bad5.r.isError === true, { json: bad5.json, isError: bad5.r.isError });

  const txt = join(tmp, "note.txt"); writeFileSync(txt, "not a picture");
  const vi = await call5("view_image", { path: txt }), vm = await call5("view_image", { path: join(tmp, "missing.png") }), vd = await call5("view_image", { path: tmp + ".png" });
  check("view_image refuses a non-image file", vi.json?.ok === false && vi.json.error.code === "bad_request" && vi.images.length === 0, [vi.json, vi.images.length]);
  check("view_image of a missing file -> not_found", vm.json?.ok === false && vm.json.error.code === "not_found" && vd.json?.error?.code === "not_found", [vm.json ?? vm.r, vd.json ?? vd.r]);
  const vp = await call5("view_image", { path: join(tmp, "p.png") });
  check("view_image still returns a picture", vp.images.length === 1, vp.json ?? vp.r);

  const H = join(tmp, "height-only"), ho = await call5("create_project", { path: H, preset: "reels", height: 500 });
  check("create_project with only a height uses it, not the preset", ho.json.ok && ho.json.settings.height === 500 && ho.json.settings.width === 1920, ho.json.settings);

  // only the SDK's own input validation counts (an error result or a protocol error, code -32602 "Input validation error"); an api bad_value answer would pass with the schema bound deleted
  const rejected = async (name: string, args: Record<string, unknown>) => {
    try { const r = await call5(name, args); return r.r.isError === true && /-32602|Input validation error/.test(String(r.json?.error?.message ?? r.json)); }
    catch (e: any) { return e?.code === -32602; }
  };
  await call5("open_project", { path: A });
  for (const [name, args] of [["preview_frame", { t: 0, scale: 1e6 }], ["preview_frame", { t: 0, scale: 0 }], ["render", { scale: 1e6 }], ["contact_sheet", { count: 1e6 }], ["contact_sheet", { count: 0 }],
    ["contact_sheet", { times: Array.from({ length: 65 }, () => 0) }], ["contact_sheet", { times: [-1] }], ["contact_sheet", { every: 0 }]] as const)
    check(`${name} ${JSON.stringify(args).slice(0, 40)} is refused at the schema`, await rejected(name, args as Record<string, unknown>), args);
  const cs = await call5("contact_sheet", { count: 4, times: [0, 0.5] });
  check("contact_sheet within the bounds still works", cs.images.length === 1, cs.json ?? cs.r);
  await c5.close();
}
// transcribe model/start/end and the tts tool, against fake engines on PATH (no real ASR or TTS runs)
if (process.platform !== "win32") {
  const { chmodSync, existsSync, mkdirSync } = await import("node:fs");
  const bin = join(tmp, "engine-bin"), model = join(tmp, "fake.bin"), say = process.platform === "darwin";
  mkdirSync(bin);
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300:duration=5", join(tmp, "talk.wav")]);
  writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-m" ] && echo "$2" > "${tmp}/asr.model"; [ "$1" = "-of" ] && printf '%s' '{"result":{"language":"vi"},"transcription":[{"text":" Hi","offsets":{"from":200,"to":500}}]}' > "$2.json"; shift; done\n`);
  writeFileSync(join(bin, say ? "say" : "espeak-ng"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "${say ? "-o" : "-w"}" ] && cp "${join(tmp, "talk.wav")}" "$2"; shift; done\n`);
  for (const f of ["whisper-cli", say ? "say" : "espeak-ng"]) chmodSync(join(bin, f), 0o755);
  const env6: Record<string, string | undefined> = { ...env, PATH: `${bin}:${process.env.PATH}` }; delete env6.AGENTCUT_PROJECT; delete env6.AGENTCUT_WHISPER_MODEL;
  const c6 = new Client({ name: "agentcut-test-6", version: "1" });
  await c6.connect(new StdioClientTransport({ command: cmd[0], args: cmd.slice(1), env: env6 as Record<string, string> }));
  const call6 = callOn(c6), TP = join(tmp, "tts-proj");
  const tr = await call6("transcribe", { path: join(tmp, "talk.wav"), language: "vi", model, start: 1, end: 2 });
  check("transcribe: the model reaches the engine and the range shifts the word times", tr.json.ok === true && readFileSync(join(tmp, "asr.model"), "utf8").trim() === model && tr.json.words[0].start === 1.2 && tr.json.words[0].end === 1.5, tr.json);
  const half = await call6("transcribe", { path: join(tmp, "talk.wav"), model, start: 1 });
  check("transcribe: start alone runs to the media's end", half.json.ok === true && half.json.words[0].start === 1.2, half.json);
  const bad = await Promise.all([{ start: 2, end: 1 }, { start: 9 }].map((r) => call6("transcribe", { path: join(tmp, "talk.wav"), model, ...r })));
  check("transcribe: end <= start and a start past the media's end are bad_value", bad.every((b) => b.json.ok === false && b.json.error.code === "bad_value"), bad.map((b) => b.json));
  await call6("create_project", { path: TP, preset: "youtube" });
  const names = (await c6.listTools()).tools.map((t) => t.name);
  check("tts is listed", names.includes("tts"), names);
  const own = await call6("tts", { text: "hello", output: join(TP, "project.json") });
  check("tts refuses the project's own file", own.json.ok === false && own.json.error.code === "output_is_source", own.json);
  const rates = await Promise.all([0, -3].map((rate) => call6("tts", { text: "hello", output: join(tmp, "r.wav"), rate })));
  check("tts: a rate that is not positive is bad_value", rates.every((r) => r.json.ok === false && r.json.error.code === "bad_value"), rates.map((r) => r.json));
  const out = join(TP, "media", "v.wav"), sp = await call6("tts", { text: "Hello there. Bye.", output: out, rate: 175 });
  check("tts writes the file and reports it", sp.json.ok === true && existsSync(out) && sp.json.path === out && sp.json.duration > 4 && sp.json.sentences.length === 2, sp.json);
  await c6.close();
}
// a client's cancel and the server's stop each end a tool call's ffmpeg child: a stand-in ffmpeg records its pid and waits 60 s
if (process.platform !== "win32") {
  const bin = join(tmp, "stall-bin"), pidFile = join(tmp, "stall.pid");
  const real = process.env.PATH!.split(delimiter).map((d) => join(d, "ffmpeg")).find((f) => existsSync(f))!;
  mkdirSync(bin);
  const stall = (key: string) => writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\n[ "$1" = "-version" ] && exit 0\ncase "$*" in *'${key}'*) echo $$ > '${pidFile}'; exec sleep 60;; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const stallEnv = { ...env, PATH: bin + delimiter + process.env.PATH };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const until = async (cond: () => unknown, ms: number) => { const t = performance.now(); while (performance.now() - t < ms && !cond()) await sleep(25); return !!cond(); };
  const waitPid = async () => { await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, "utf8")) > 0, 10_000); return existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) || 0 : 0; };
  // the stand-in sleeps 60 s, so a child gone within 5 s shows the server stopped it
  const stopped = async (pid: number) => { const ok = pid > 0 && (await until(() => !alive(pid), 5000)); if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL"); return ok; };
  // transcribe, analyze_silence, tts and apply_ops add_captions transcribe= reach ffmpeg first: tts through a stand-in speech engine that writes talk.wav
  const speaker = process.platform === "darwin" ? "say" : "espeak-ng";
  writeFileSync(join(bin, speaker), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "${speaker === "say" ? "-o" : "-w"}" ] && cp '${join(tmp, "talk.wav")}' "$2"; shift; done\n`, { mode: 0o755 });
  const SP = join(tmp, "stall-proj");
  await call("create_project", { path: SP, preset: "youtube" });
  const SM = join(tmp, "stall-music"); // review beats="music" reads the music track's beats
  await call("create_project", { path: SM, preset: "youtube" });
  await call("apply_ops", { project: SM, ops: [{ op: "add_clip", track: "music", src: join(tmp, "talk.wav"), duration: 2 }] });
  const stalls = [["audio_check", { source: join(tmp, "talk.wav") }, "pcm_s16le"], ["analyze_scenes", { path: join(tmp, "a.mp4") }, "scene"], ["measure_loudness", { path: join(tmp, "talk.wav") }, "ebur128"],
    ["transcribe", { path: join(tmp, "talk.wav") }, "-ar 16000"], ["analyze_silence", { path: join(tmp, "talk.wav") }, "silencedetect"], ["tts", { text: "Hello there.", output: join(tmp, "stall-tts.wav") }, "p0.wav"],
    ["apply_ops", { project: SP, ops: [{ op: "add_captions", transcribe: join(tmp, "talk.wav") }] }, "-ar 16000"],
    ["scopes", { project: SP, t: 0.2 }, "signalstats"], ["analyze_beats", { path: join(tmp, "talk.wav") }, "-f f32le"], ["review", { project: SM, beats: "music" }, "-f f32le"],
    ["apply_ops", { project: SP, ops: [{ op: "snap_to_beats", track: "main", beats: join(tmp, "talk.wav") }] }, "-f f32le"]] as const;
  for (const [tool, args, key] of stalls) {
    stall(key);
    rmSync(pidFile, { force: true });
    const saved = tool === "apply_ops" ? readFileSync(join(SP, "project.json"), "utf8") : ""; // both apply_ops rows use SP
    const c = new Client({ name: "agentcut-test-cancel", version: "1" });
    await c.connect(new StdioClientTransport({ command: cmd[0], args: cmd.slice(1), env: stallEnv }));
    const ac = new AbortController();
    const pending = c.callTool({ name: tool, arguments: args }, undefined, { signal: ac.signal }).then(() => null, (e) => e);
    const pid = await waitPid();
    ac.abort();
    await pending;
    const gone = await stopped(pid);
    const after = await callOn(c)("guide");
    check(`a client cancel during ${tool} stops its ffmpeg child within 5 s and the server keeps serving`, gone && String(after.json).includes("Mental model"), { pid, gone });
    if (tool === "apply_ops") check("a cancelled apply_ops saved nothing: project.json is unchanged and media/ is empty", readFileSync(join(SP, "project.json"), "utf8") === saved && readdirSync(join(SP, "media")).length === 0, { media: readdirSync(join(SP, "media")) });
    await c.close();
  }
  { // a cancelled add_voiceover leaves no speech folder behind (agentcut-vo-* holds the call's synthesized speech, agentcut-tts-* the synthesis itself)
    const SV = join(tmp, "stall-vo"), mine = (n: string) => /^agentcut-(vo|tts)-/.test(n), before = new Set(readdirSync(tmpdir()).filter(mine));
    await call("create_project", { path: SV, preset: "youtube" });
    stall("p0.wav");
    rmSync(pidFile, { force: true });
    const c = new Client({ name: "agentcut-test-cancel", version: "1" });
    await c.connect(new StdioClientTransport({ command: cmd[0], args: cmd.slice(1), env: stallEnv }));
    const ac = new AbortController();
    const pending = c.callTool({ name: "apply_ops", arguments: { project: SV, ops: [{ op: "add_voiceover", text: "Hello there." }] } }, undefined, { signal: ac.signal }).then(() => null, (e) => e);
    const pid = await waitPid();
    ac.abort();
    await pending;
    const gone = await stopped(pid), clean = await until(() => readdirSync(tmpdir()).filter(mine).every((n) => before.has(n)), 3000);
    check("a client cancel during apply_ops add_voiceover stops its ffmpeg child, leaves no speech folder in the temp dir and saves nothing", gone && clean && readdirSync(join(SV, "media")).length === 0,
      { pid, gone, left: readdirSync(tmpdir()).filter((n) => mine(n) && !before.has(n)) });
    await c.close();
  }
  for (const [tool, args, key] of stalls) {
    stall(key);
    rmSync(pidFile, { force: true });
    const child = spawn(cmd[0], cmd.slice(1), { env: stallEnv, stdio: ["pipe", "pipe", "inherit"] });
    let buf = "";
    const st = { exit: null as { code: number | null; at: number } | null, reply: null as any };
    child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); if (m.id === 2) st.reply = m; } } });
    child.on("exit", (code) => { st.exit = { code, at: performance.now() }; });
    const send = (m: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentcut-test-stop", version: "1" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/call", params: { name: tool, arguments: args } });
    const pid = await waitPid();
    const t1 = performance.now();
    child.stdin.end();
    await until(() => st.exit, 10_000);
    const gone = await stopped(pid);
    const body = st.reply ? JSON.parse(st.reply.result.content[0].text) : null;
    check(`stdin end during ${tool} answers it as aborted, stops its ffmpeg child, and the server exits 0 within 3 s`,
      gone && body?.ok === false && body.error.code === "aborted" && st.exit?.code === 0 && st.exit.at - t1 < 3000, { pid, gone, body, exit: st.exit, ms: st.exit ? st.exit.at - t1 : null });
    if (!st.exit) child.kill("SIGKILL");
  }
}
await client.close();
console.log(`${fails ? `✗ ${fails} failed` : "OK - MCP checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
