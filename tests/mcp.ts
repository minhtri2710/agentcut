// MCP end-to-end: spawns the server over stdio, exercises the main tools like an agent would.
// Run: bun tests/mcp.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r: any = await client.callTool({ name, arguments: args });
  const txt = r.content.find((c: any) => c.type === "text")?.text;
  return { r, json: txt?.startsWith("{") ? JSON.parse(txt) : txt, images: r.content.filter((c: any) => c.type === "image") };
};
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
await client.close();
console.log(`${fails ? `✗ ${fails} failed` : "OK - MCP checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
