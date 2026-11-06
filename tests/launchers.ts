// Launchers: bun runs of scripts/ac, the .mcp.json command, the segment worker and the compiled binary ignore the bunfig.toml and .env in the working dir.
// Run: bun tests/launchers.ts     (AGENTCUT_BIN=<compiled binary> checks that binary instead of the source launchers)
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dir, "..");
const bin = process.env.AGENTCUT_BIN;
const tmp = mkdtempSync(join(tmpdir(), "agentcut-launchers-"));
const work = join(tmp, "work"); // the working dir of every launch: a project holding a bunfig.toml and .env
const home = join(tmp, "home"); // default AGENTCUT_HOME of the launches (HOME is set at spawn)
const dotenvHome = join(tmp, "dotenv-home"); // where the working dir's .env would send AGENTCUT_HOME
const marker = join(work, "preload-ran");
let fails = 0;
const check = (n: string, c: unknown, info?: unknown) => { console.log(`  ${c ? "✓" : "✗"} ${n}`, c ? "" : JSON.stringify(info ?? null).slice(0, 500)); if (!c) fails++; };

// launcher env: HOME at spawn, no AGENTCUT_HOME (a set variable would win over .env), isolated cache
const env = (): Record<string, string> => {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home, AGENTCUT_CACHE: join(tmp, "cache") };
  delete e.AGENTCUT_HOME; delete e.AGENTCUT_PROJECT; delete e.NODE_ENV;
  return e;
};
const mcpJson = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers.agentcut as { command: string; args: string[] };
// .mcp.json paths are relative to the project root; resolve them so the server can run from `work`
const mcpCmd = [mcpJson.command, ...mcpJson.args.map((a: string) => (a.endsWith(".ts") ? resolve(root, a) : a))];
const cliCmd = bin ? [bin] : [resolve(root, "scripts/ac")];
const mcpLaunch = bin ? [bin, "mcp"] : mcpCmd;
const cli = (args: string[], cwd: string) => {
  const r = spawnSync(cliCmd[0], [...cliCmd.slice(1), ...args], { cwd, env: env(), encoding: "utf8" });
  try { return JSON.parse(r.stdout); } catch { throw new Error(`non-JSON output for ${args.join(" ")}: ${r.stdout.slice(0, 300)} ${r.stderr.slice(-500)}`); }
};
const reset = () => { rmSync(marker, { force: true }); rmSync(dotenvHome, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); };
const ignored = (name: string, wrote: string) => {
  check(`${name}: bunfig.toml in the working dir is not loaded`, !existsSync(marker));
  check(`${name}: .env in the working dir is not loaded (feedback went to ${wrote})`, existsSync(join(home, ".agentcut", "feedback")) && !existsSync(dotenvHome));
};

// project and media are made before those files are written
cli(["init", work, "--preset", "square"], tmp);
cli(["apply", "--ops", JSON.stringify([{ op: "add_clip", track: "main", type: "color", color: "#204080", duration: 2 }])], work);
writeFileSync(join(work, "pre.ts"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\n`);
writeFileSync(join(work, "bunfig.toml"), 'preload = ["./pre.ts"]\n');
writeFileSync(join(work, ".env"), `AGENTCUT_HOME=${dotenvHome}\n`);
writeFileSync(join(work, ".env.local"), `AGENTCUT_HOME=${dotenvHome}\n`);

console.log(`launcher: ${cliCmd.join(" ")}`);
reset();
const fb = cli(["feedback", "add", "kind=idea", "title=launcher check"], work);
check("cli runs from the working dir", fb.ok === true, fb);
ignored("cli", "home");

console.log("segment worker");
reset();
const rd = cli(["render", "-o", "renders/w.mp4", "--draft", "--no-sheet", "--quiet", "--workers", "2"], work);
check("render with 2 workers ran in the working dir", rd.ok !== false && rd.workers === 2 && existsSync(join(work, "renders", "w.mp4")), rd);
check("segment workers: bunfig.toml in the working dir is not loaded", !existsSync(marker));

console.log(`mcp: ${mcpLaunch.join(" ")}`);
reset();
{
  const client = new Client({ name: "agentcut-launchers-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: mcpLaunch[0], args: mcpLaunch.slice(1), cwd: work, env: env() }));
  const r: any = await client.callTool({ name: "report_feedback", arguments: { kind: "idea", title: "launcher check" } });
  check("mcp server runs from the working dir", !r.isError, r.content);
  await client.close();
  ignored("mcp", "home");
}

console.log(`\n${fails ? `✗ ${fails} check(s) failed` : "OK - all checks passed"}  (${tmp})`);
if (!fails) rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
