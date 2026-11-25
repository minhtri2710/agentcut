// The UI's chat panel: a locally installed agent CLI (Claude Code) run non-interactively on one message, with agentcut's own MCP server for the open project as its only tools.
// No model keys live here: the CLI uses its own login. Its stream-json lines become chat events for the page.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EditError } from "./model.ts";
import { stopOnAbort } from "./proc.ts";
import { has } from "./tts.ts";

export type ChatEvent = { kind: "session"; session: string } | { kind: "text"; text: string } | { kind: "tool"; name: string; input: unknown }
  | { kind: "tool_result"; ok: boolean; text: string } | { kind: "done"; session?: string; error?: string; stopped?: boolean };

const INSTALL = "install Claude Code (https://docs.claude.com/en/docs/claude-code), sign in once with `claude`, then reload this page";

/** what the panel can drive: the claude CLI on PATH, or a hint to install it */
export const chatEngine = () => (has("claude") ? { available: true, cli: "claude" } : { available: false, cli: null, hint: INSTALL });

/** agentcut's MCP server as this process can start it: the compiled binary re-invokes itself; otherwise mcp.ts/js beside this module, under bun with the launchers' flags */
export function mcpCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  if (here.includes("$bunfs") || here.includes("~BUN")) return { command: process.execPath, args: ["mcp"] };
  const flags = process.versions.bun ? ["--no-install", "--no-env-file", `--config=${join(dirname(here), "..", "scripts", "bunfig.empty.toml")}`] : [];
  return { command: process.execPath, args: [...flags, join(dirname(here), `mcp${extname(here)}`)] };
}

/** The CLI's arguments: print mode with streamed JSON, no built-in tools, only the agentcut MCP server (AGENTCUT_PROJECT names the project) and its tools allowed without asking.
 *  The message itself goes on stdin: in argv one that starts with '-' would be read as an option. */
export function chatArgs(root: string, session?: string): string[] {
  const mcp = { mcpServers: { agentcut: { ...mcpCommand(), env: { AGENTCUT_PROJECT: root } } } };
  return ["-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp),
    "--tools", "", "--allowedTools", "mcp__agentcut", "--permission-mode", "dontAsk",
    "--append-system-prompt", `You are the editing assistant inside the AgentCut UI. The open project is ${root}; edit it only with the agentcut MCP tools (read guide first if unsure). A human watches the same timeline and may edit too: take the revision from project_info before writing.`,
    ...(session ? ["--resume", session] : [])];
}

/** one stream-json line as chat events (an unknown line is none) */
export function chatEvents(line: string): ChatEvent[] {
  let m: any;
  try { m = JSON.parse(line); } catch { return []; }
  if (m.type === "system" && m.subtype === "init" && m.session_id) return [{ kind: "session", session: m.session_id }];
  const parts: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
  if (m.type === "assistant") return parts.flatMap((p): ChatEvent[] => p.type === "text" && p.text ? [{ kind: "text", text: p.text }] : p.type === "tool_use" ? [{ kind: "tool", name: String(p.name).replace(/^mcp__agentcut__/, ""), input: p.input }] : []);
  if (m.type === "user") return parts.filter((p) => p.type === "tool_result").map((p) => ({ kind: "tool_result", ok: !p.is_error, text: (Array.isArray(p.content) ? p.content.map((c: any) => c.text ?? "").join("") : String(p.content ?? "")).slice(0, 400) }));
  if (m.type === "result") return [{ kind: "done", session: m.session_id, ...(m.is_error ? { error: String(m.result ?? m.subtype) } : {}) }];
  return [];
}

/** Run the CLI on one message in `root`, each event to `on`; ends with a done event (stopped when `signal` aborted it). */
export function runChat(root: string, message: string, session: string | undefined, on: (e: ChatEvent) => void, signal: AbortSignal): Promise<void> {
  if (!has("claude")) throw new EditError("no agent CLI found for the chat", "missing_dependency", INSTALL);
  return new Promise((ok) => {
    const ch = spawn("claude", chatArgs(root, session), { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    stopOnAbort(ch, signal);
    ch.stdin.on("error", () => {}); // a CLI that exits before reading: its close below reports it
    ch.stdin.end(message);
    let err = "", done = false;
    ch.stderr.on("data", (c) => { err = (err + c).slice(-2000); });
    createInterface({ input: ch.stdout }).on("line", (l) => { for (const e of chatEvents(l)) { if (e.kind === "done") done = true; on(e); } });
    ch.on("error", (e) => { err += e.message; });
    ch.on("close", (code) => {
      if (done) { /* the CLI said how it ended */ }
      else if (signal.aborted) on({ kind: "done", stopped: true });
      else on({ kind: "done", error: err.trim().split("\n").pop() || `claude exited ${code}` });
      ok();
    });
  });
}
