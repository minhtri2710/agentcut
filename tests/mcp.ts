// MCP end-to-end: spawns the server over stdio, exercises the main tools like an agent would.
// Run: bun tests/mcp.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
check("create_project", (await call("create_project", { path: join(tmp, "p"), preset: "youtube" })).json.ok);
const ap = await call("apply_ops", { ops: [
  { op: "add_sequence", track: "main", items: [join(tmp, "a.mp4"), join(tmp, "p.png")], defaults: { duration: 2, transition: "crossfade", motion: "ken_burns" } },
  { op: "add_clip", track: "text", text: "Hello MCP", attach_to: "main#0", offset: 0.2, match_duration: true, preset: "neon" },
] });
check("apply_ops", ap.json.ok && ap.json.results[0].added.length === 2, ap.json);
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
// (the test's own file): every download attempt is recorded and answered 404, so nothing touches the network and no helper is started.
if (process.env.AGENTCUT_MCP) console.log("  - allow_download pass-through skipped: a compiled server takes no --preload");
else {
  const { FACE_MODEL } = await import("../src/vision.ts");
  const fetchLog = join(tmp, "mcp-fetch.log"), stub = join(tmp, "mcp-fetch-stub.ts");
  writeFileSync(stub, `import { appendFileSync } from "node:fs";\nglobalThis.fetch = (async (u: unknown) => { appendFileSync(${JSON.stringify(fetchLog)}, String(u) + "\\n"); return new Response("no", { status: 404 }); }) as typeof fetch;\n`);
  const fetched = () => { try { return readFileSync(fetchLog, "utf8").split("\n").filter(Boolean); } catch { return []; } };
  const c2 = new Client({ name: "agentcut-test-2", version: "1" });
  await c2.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-install", "--preload", stub, resolve(import.meta.dir, "../src/mcp.ts")], env }));
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
  check("MCP prepare with allow_download reaches the same download", p1.json.error?.code === "model_download_failed" && fetched().length === 2 && fetched()[1] === FACE_MODEL.url, { p1: p1.json, fetched: fetched() });
  await c2.close();
}
await client.close();
console.log(`${fails ? `✗ ${fails} failed` : "OK - MCP checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
