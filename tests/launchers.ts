// Launchers: bun runs of scripts/ac, the .mcp.json command, the segment worker and the compiled binary ignore the bunfig.toml and .env in the working dir.
// A source tree without node_modules makes no registry request. Every bun command in the package.json scripts passes --no-install (checked statically), and the docs script runs from a tree without node_modules and regenerates AGENTS.md as committed. Run: bun tests/launchers.ts
// (AGENTCUT_BIN=<compiled binary> checks that binary instead of the source launchers; the no-registry case needs a source tree and is skipped)
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
const dotenvCache = join(tmp, "dotenv-cache"); // where the working dir's .env would send AGENTCUT_CACHE
const marker = join(work, "preload-ran");
let fails = 0;
const check = (n: string, c: unknown, info?: unknown) => { console.log(`  ${c ? "✓" : "✗"} ${n}`, c ? "" : JSON.stringify(info ?? null).slice(0, 500)); if (!c) fails++; };

// launcher env: HOME at spawn; no AGENTCUT_HOME or AGENTCUT_CACHE (a set variable would win over .env), so both default under HOME
const env = (): Record<string, string> => {
  const e: Record<string, string> = { ...(process.env as Record<string, string>), HOME: home };
  delete e.AGENTCUT_HOME; delete e.AGENTCUT_CACHE; delete e.AGENTCUT_PROJECT; delete e.NODE_ENV;
  return e;
};
// the .mcp.json command of a source tree; its paths are relative to the tree root, so resolve them to run from another working dir
const mcpOf = (tree: string) => {
  const m = JSON.parse(readFileSync(join(tree, ".mcp.json"), "utf8")).mcpServers.agentcut as { command: string; args: string[] };
  const abs = (a: string) => {
    const [flag, value] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=") + 1), a.slice(a.indexOf("=") + 1)] : ["", a];
    return !value.startsWith("/") && existsSync(resolve(tree, value)) ? flag + resolve(tree, value) : a;
  };
  return [m.command, ...m.args.map(abs)];
};
const cliCmd = bin ? [bin] : [resolve(root, "scripts/ac")];
const mcpLaunch = bin ? [bin, "mcp"] : mcpOf(root);
const cli = (args: string[], cwd: string) => {
  const r = spawnSync(cliCmd[0], [...cliCmd.slice(1), ...args], { cwd, env: env(), encoding: "utf8" });
  try { return JSON.parse(r.stdout); } catch { throw new Error(`non-JSON output for ${args.join(" ")}: ${r.stdout.slice(0, 300)} ${r.stderr.slice(-500)}`); }
};
const reset = () => { for (const d of [marker, dotenvHome, dotenvCache, home]) rmSync(d, { recursive: true, force: true }); };
const ignored = (name: string, wrote: string) => {
  check(`${name}: bunfig.toml in the working dir is not loaded`, !existsSync(marker));
  check(`${name}: .env in the working dir is not loaded (feedback went to ${wrote})`, existsSync(join(home, ".agentcut", "feedback")) && !existsSync(dotenvHome));
};

// project and media are made before those files are written
cli(["init", work, "--preset", "square"], tmp);
cli(["apply", "--ops", JSON.stringify([{ op: "add_clip", track: "main", type: "color", color: "#204080", duration: 2 }, { op: "add_clip", track: "text", text: "Hi", at: 0, duration: 2 }])], work);
writeFileSync(join(work, "pre.ts"), `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\n`);
writeFileSync(join(work, "bunfig.toml"), 'preload = ["./pre.ts"]\n');
for (const f of [".env", ".env.local"]) writeFileSync(join(work, f), `AGENTCUT_HOME=${dotenvHome}\nAGENTCUT_CACHE=${dotenvCache}\n`);

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
// the workers resolve fonts and write the font cache under AGENTCUT_CACHE: it lands in the default place, not where the .env points
check("segment workers: .env in the working dir is not loaded (font cache went to the default place)", existsSync(join(home, ".cache", "agentcut", "font-families.json")) && !existsSync(dotenvCache));

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

// every bun command in a package.json script is `bun --no-install ...`: --no-install given to `bun run` does not reach the bun processes a script starts
const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts as Record<string, string>;
const bareBun = Object.entries(scripts).flatMap(([n, line]) => line.split("&&").map((c) => c.trim().split(/\s+/)).filter((w) => w[0] === "bun" && w[1] !== "--no-install").map((w) => `${n}: ${w.slice(0, 3).join(" ")}`));
const scriptsOk = bareBun.length === 0;
check(`package.json scripts: every bun command passes --no-install${bareBun.length ? ` (missing in: ${[...new Set(bareBun.map((b) => b.split(":")[0]))].join(", ")})` : ""}`, scriptsOk, bareBun);

// a source tree without node_modules, and a registry on 127.0.0.1 that records every request: no launch may ask it for a package
if (bin) console.log("no registry request: skipped (a compiled binary resolves no packages)");
else {
  console.log("no registry request");
  const copy = join(tmp, "tree");
  mkdirSync(copy);
  for (const f of ["src", "scripts", "package.json", "bun.lock", "tsconfig.json", ".mcp.json"]) cpSync(join(root, f), join(copy, f), { recursive: true });
  const hits: string[] = [];
  const registry = createServer((q, s) => { hits.push(q.url ?? ""); s.statusCode = 404; s.end("{}"); });
  await new Promise<void>((r) => registry.listen(0, "127.0.0.1", r));
  const bare = join(tmp, "bare"); // working dir whose .npmrc names the registry
  mkdirSync(bare);
  writeFileSync(join(bare, ".npmrc"), `registry=http://127.0.0.1:${(registry.address() as any).port}/\n`);
  const e: Record<string, string> = { ...env(), BUN_INSTALL_CACHE_DIR: join(tmp, "bun-cache"), NO_PROXY: "127.0.0.1,localhost", HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9" };
  delete e.BUN_INSTALL; delete e.XDG_CACHE_HOME;
  const launch = (cmd: string[], cwd = bare) => new Promise<void>((done) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd, env: e, stdio: "ignore" });
    const poll = setInterval(() => { if (hits.length) p.kill(); }, 50);
    const limit = setTimeout(() => p.kill(), 30000);
    p.on("exit", () => { clearInterval(poll); clearTimeout(limit); done(); });
  });
  for (const [name, cmd] of [["scripts/ac", [join(copy, "scripts/ac"), "fonts"]], [".mcp.json command", mcpOf(copy)]] as const) {
    hits.length = 0;
    await launch([...cmd]);
    check(`${name}: no registry request (${hits.join(" ") || "none"})`, hits.length === 0, hits);
  }
  // pins that the docs script runs from a tree without node_modules and that AGENTS.md is in sync with GUIDE. The registry assertion is a tripwire: src/docs.ts imports no package today, so it discriminates only if that changes; the --no-install pin is the static check above
  if (!scriptsOk) console.log("docs script: skipped (a package.json script lacks --no-install, so the run could install)");
  else {
    writeFileSync(join(copy, ".npmrc"), readFileSync(join(bare, ".npmrc")));
    writeFileSync(join(copy, "AGENTS.md"), "placeholder\n"); // the script must replace it
    hits.length = 0;
    await launch(["bun", "--no-install", "run", "docs"], copy);
    check(`docs script from a tree without node_modules: no registry request (tripwire) (${hits.join(" ") || "none"})`, hits.length === 0, hits);
    check("docs script from a tree without node_modules: AGENTS.md is in sync with GUIDE", readFileSync(join(copy, "AGENTS.md"), "utf8") === readFileSync(join(root, "AGENTS.md"), "utf8"));
  }
  registry.close();
}

console.log(`\n${fails ? `✗ ${fails} check(s) failed` : "OK - all checks passed"}  (${tmp})`);
if (!fails) rmSync(tmp, { recursive: true, force: true });
process.exit(fails ? 1 : 0);
