// The UI's chat panel: a locally installed agent CLI run on one message, with agentcut's own MCP server for the open project as its tools.
// No model keys live here: each CLI uses its own login. Its output becomes chat events for the page.
// claude, pi and omp print JSON lines; agy and devin speak ACP (Agent Client Protocol) on stdio, and this side answers their permission requests.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EditError } from "./model.ts";
import { stopOnAbort } from "./proc.ts";
import { has } from "./tts.ts";

export type ChatEvent = { kind: "session"; session: string } | { kind: "text"; text: string } | { kind: "tool"; name: string; input: unknown }
  | { kind: "tool_result"; ok: boolean; text: string } | { kind: "done"; session?: string; error?: string; stopped?: boolean };

/** the CLIs the panel can drive, in the order it offers them */
export const CHAT_CLIS = ["claude", "pi", "omp", "agy", "devin"] as const;
export type ChatCli = (typeof CHAT_CLIS)[number];

const INSTALL = "install one of these agent CLIs and sign in once: Claude Code (claude), pi, omp, Antigravity (agy) or Devin (devin); then reload this page";

/** what the panel can drive: the CLIs found on PATH, or a hint to install one */
export const chatEngine = () => {
  const clis = CHAT_CLIS.filter((c) => has(c));
  return clis.length ? { available: true, clis } : { available: false, clis, hint: INSTALL };
};

/** agentcut's MCP server as this process can start it: the compiled binary re-invokes itself; otherwise mcp.ts/js beside this module, under bun with the launchers' flags */
export function mcpCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  if (here.includes("$bunfs") || here.includes("~BUN")) return { command: process.execPath, args: ["mcp"] };
  const flags = process.versions.bun ? ["--no-install", "--no-env-file", `--config=${join(dirname(here), "..", "scripts", "bunfig.empty.toml")}`] : [];
  return { command: process.execPath, args: [...flags, join(dirname(here), `mcp${extname(here)}`)] };
}

const instructions = (root: string) => `You are the editing assistant inside the AgentCut UI. The open project is ${root}; edit it only with the agentcut MCP tools (read guide first if unsure). A human watches the same timeline and may edit too: take the revision from project_info before writing.`;
const mcpServers = (root: string) => ({ mcpServers: { agentcut: { ...mcpCommand(), env: { AGENTCUT_PROJECT: root } } } });

/** How `cli` runs one message: its argv, working folder, the config files it reads there (written before each run), and whether it speaks ACP.
 *  Each keeps the same rule: the agentcut MCP server is the only tool set it may use to change anything, and the CLI's own config is not touched.
 *  claude: no built-in tools, only this MCP server, its tools allowed without asking. pi: a scratch folder whose .pi/mcp.json names the server (trusted for the run),
 *  tools limited to codemode (a sandboxed script runner that sees only allowed tools) and agentcut's. omp: a scratch folder whose .mcp.json names it, no built-in tools.
 *  agy, devin: ACP, the server passed with the session; a tool call that asks permission is allowed only for an agentcut MCP tool (agy reads files without asking). */
export function chatLaunch(cli: ChatCli, root: string, session?: string): { args: string[]; cwd: string; files: [string, string][]; acp: boolean } {
  const scratch = join(root, ".agentcut", "chat", cli), servers = JSON.stringify(mcpServers(root));
  if (cli === "claude") return { cwd: root, files: [], acp: false, args: ["-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", servers,
    "--tools", "", "--allowedTools", "mcp__agentcut", "--permission-mode", "dontAsk", "--append-system-prompt", instructions(root), ...(session ? ["--resume", session] : [])] };
  if (cli === "pi") return { cwd: scratch, files: [[join(scratch, ".pi", "mcp.json"), servers]], acp: false, args: ["-p", "--mode", "json", "--approve", "--tools", "codemode,mcp__agentcut*",
    "--no-skills", "--no-context-files", "--no-prompt-templates", "--append-system-prompt", instructions(root), ...(session ? ["--session", session] : [])] };
  if (cli === "omp") return { cwd: scratch, files: [[join(scratch, ".mcp.json"), servers]], acp: false, args: ["-p", "--mode", "json", "--no-tools", "--no-extensions", "--no-skills",
    "--no-context-files", "--no-lsp", "--append-system-prompt", instructions(root), ...(session ? ["--resume", session] : [])] };
  return { cwd: root, files: [], acp: true, args: cli === "devin" ? ["acp", "--process-model", "in-process"] : ["acp"] };
}

const toolName = (n: unknown) => String(n).replace(/^mcp_{1,2}agentcut_{1,2}/, "");
const texts = (c: unknown) => (Array.isArray(c) ? c.map((x: any) => x?.text ?? "").join("") : String(c ?? "")).slice(0, 400);

/** one claude stream-json line as chat events (an unknown line is none) */
export function chatEvents(line: string): ChatEvent[] {
  let m: any;
  try { m = JSON.parse(line); } catch { return []; }
  if (m.type === "system" && m.subtype === "init" && m.session_id) return [{ kind: "session", session: m.session_id }];
  const parts: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
  if (m.type === "assistant") return parts.flatMap((p): ChatEvent[] => p.type === "text" && p.text ? [{ kind: "text", text: p.text }] : p.type === "tool_use" ? [{ kind: "tool", name: toolName(p.name), input: p.input }] : []);
  if (m.type === "user") return parts.filter((p) => p.type === "tool_result").map((p) => ({ kind: "tool_result", ok: !p.is_error, text: texts(p.content) }));
  if (m.type === "result") return [{ kind: "done", session: m.session_id, ...(m.is_error ? { error: String(m.result ?? m.subtype) } : {}) }];
  return [];
}

/** One pi or omp --mode json line as chat events: the session, each finished assistant message (text, tool calls), each tool result, the end. `last` keeps the session id and the last error for the end. */
export function piEvents(line: string, last: { session?: string; error?: string } = {}): ChatEvent[] {
  let m: any;
  try { m = JSON.parse(line); } catch { return []; }
  if (m.type === "session" && m.id) { last.session = m.id; return [{ kind: "session", session: m.id }]; }
  if (m.type === "agent_end") return [{ kind: "done", session: last.session, ...(last.error ? { error: last.error } : {}) }];
  if (m.type !== "message_end" || !m.message) return [];
  const msg = m.message, parts: any[] = Array.isArray(msg.content) ? msg.content : [];
  if (msg.role === "assistant") {
    if (msg.stopReason === "error") last.error = String(msg.errorMessage ?? "the model request failed");
    return parts.flatMap((p): ChatEvent[] => p.type === "text" && p.text ? [{ kind: "text", text: p.text }] : p.type === "toolCall" ? [{ kind: "tool", name: toolName(p.name), input: p.arguments }] : []);
  }
  if (msg.role === "toolResult") return [{ kind: "tool_result", ok: !msg.isError, text: texts(msg.content) }];
  return [];
}

/** Whether an ACP permission request is for an agentcut MCP tool (agy names them mcp_agentcut_<tool>): only those are allowed, everything else is refused. */
export const acpAllowed = (toolCall: any) => /^mcp_{1,2}agentcut_{1,2}[a-z_]+$/.test(String(toolCall?.name ?? ""));

/** One message over ACP: initialize, load the session (its replayed history is not shown) or start one with the agentcut MCP server, ask for a permission on every action where the CLI has such a mode,
 *  send the message (the instructions lead a new session's first message), answer permission requests, and turn session updates into chat events. Resolves with the session and an error, if any. */
function acpRun(ch: ChildProcess, root: string, cwd: string, message: string, session: string | undefined, on: (e: ChatEvent) => void): Promise<{ session?: string; error?: string }> {
  let next = 0, replaying = false, said = "";
  const waits = new Map<number, (m: any) => void>(), shown = new Set<string>();
  const write = (o: unknown) => { if (ch.stdin?.writable) ch.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...(o as object) }) + "\n"); };
  const call = (method: string, params: unknown) => new Promise<any>((ok) => { const id = ++next; waits.set(id, ok); write({ id, method, params }); });
  const flush = () => { if (said.trim()) on({ kind: "text", text: said.trim() }); said = ""; };
  createInterface({ input: ch.stdout! }).on("line", (l) => {
    let m: any;
    try { m = JSON.parse(l); } catch { return; }
    if (m.id !== undefined && !m.method) { waits.get(m.id)?.(m); waits.delete(m.id); return; }
    if (m.method === "session/request_permission") {
      const opts: any[] = m.params?.options ?? [], allow = acpAllowed(m.params?.toolCall);
      const pick = opts.find((o) => (allow ? o.kind === "allow_once" : o.kind === "reject_once")) ?? opts.find((o) => String(o.kind).startsWith(allow ? "allow" : "reject"));
      return write({ id: m.id, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
    }
    if (m.method && m.id !== undefined) return write({ id: m.id, error: { code: -32601, message: "not offered by AgentCut" } }); // no file system or terminal for the agent through this client
    const u = m.params?.update;
    if (m.method !== "session/update" || !u || replaying) return;
    if (u.sessionUpdate === "agent_message_chunk") said += u.content?.text ?? "";
    else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
      if (!shown.has(u.toolCallId)) { shown.add(u.toolCallId); flush(); on({ kind: "tool", name: toolName(u.name ?? u.title), input: u.rawInput ?? {} }); }
      if (u.status === "completed" || u.status === "failed") on({ kind: "tool_result", ok: u.status === "completed", text: texts(u.rawOutput ?? u.content?.map?.((c: any) => c.content ?? c)) });
    }
  });
  const fail = (r: any) => r?.error?.message ?? String(r?.error ?? "");
  return (async () => {
    const init = await call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "agentcut", version: "1" } });
    if (init.error) return { error: fail(init) };
    const servers = [{ name: "agentcut", ...mcpCommand(), env: [{ name: "AGENTCUT_PROJECT", value: root }] }];
    let sid = session, fresh = false, modes: any;
    if (sid) { replaying = true; const r = await call("session/load", { sessionId: sid, cwd, mcpServers: servers }); replaying = false; if (r.error) sid = undefined; else modes = r.result?.modes; }
    if (!sid) {
      const r = await call("session/new", { cwd, mcpServers: servers });
      if (r.error || !r.result?.sessionId) return { error: fail(r) || "the agent started no session" };
      sid = r.result.sessionId as string; fresh = true; modes = r.result.modes;
      on({ kind: "session", session: sid });
    }
    if ((modes?.availableModes ?? []).some((x: any) => x.id === "ask") && modes.currentModeId !== "ask") await call("session/set_mode", { sessionId: sid, modeId: "ask" }); // devin starts in accept-edits
    const r = await call("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: fresh ? `${instructions(root)}\n\n${message}` : message }] });
    flush();
    return { session: sid, ...(r.error ? { error: fail(r) } : {}) };
  })();
}

/** Run `cli` on one message in the project `root`, each event to `on`; ends with a done event (stopped when `signal` aborted it). */
export function runChat(cli: ChatCli, root: string, message: string, session: string | undefined, on: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  if (!has(cli)) throw new EditError(`agent CLI '${cli}' not found`, "missing_dependency", INSTALL);
  const L = chatLaunch(cli, root, session);
  for (const [f, text] of L.files) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); }
  return new Promise((ok) => {
    const ch = spawn(cli, L.args, { cwd: L.cwd, stdio: ["pipe", "pipe", "pipe"] });
    stopOnAbort(ch, signal);
    ch.stdin.on("error", () => {}); // a CLI that exits before reading: its close below reports it
    let err = "", done = false;
    const end = (e: ChatEvent) => { if (e.kind === "done") { if (done) return; done = true; } on(e); };
    ch.stderr.on("data", (c) => { err = (err + c).slice(-2000); });
    ch.on("error", (e) => { err += e.message; });
    if (L.acp) acpRun(ch, root, L.cwd, message, session, end).then((r) => { if (!signal.aborted) end({ kind: "done", session: r.session, ...(r.error ? { error: r.error } : {}) }); ch.kill(); }, (e) => { err += String(e); ch.kill(); });
    else {
      ch.stdin.end(message); // on stdin: in argv a message that starts with '-' would be read as an option
      const last = {}, parse = cli === "claude" ? chatEvents : (l: string) => piEvents(l, last);
      createInterface({ input: ch.stdout }).on("line", (l) => { for (const e of parse(l)) end(e); });
    }
    ch.on("close", (code) => {
      if (!done) end(signal.aborted ? { kind: "done", stopped: true } : { kind: "done", error: err.trim().split("\n").pop() || `${cli} exited ${code}` });
      ok();
    });
  });
}
