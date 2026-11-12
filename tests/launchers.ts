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

// CLI input and flags: a raw run keeps the exit code, which cli() drops
const run = (args: string[], cwd: string, input?: string) => {
  const r = spawnSync(cliCmd[0], [...cliCmd.slice(1), ...args], { cwd, env: env(), encoding: "utf8", input, maxBuffer: 1 << 28 });
  let json: any = null; try { json = JSON.parse(r.stdout); } catch { /* checked by the caller */ }
  return { status: r.status, json, out: r.stdout };
};
console.log("cli input and flags");
{
  const io = join(tmp, "io");
  cli(["init", io, "--preset", "square"], tmp);
  const clipIds = () => JSON.parse(readFileSync(join(io, "project.json"), "utf8")).tracks.flatMap((t: any) => t.clips.map((c: any) => c.id));
  // a 3-byte character split across two stdin writes
  const body = Buffer.from(JSON.stringify([{ op: "add_clip", track: "text", id: "big", text: "ệ".repeat(20) + "x".repeat(3000000), at: 0, duration: 1 }]));
  const cut = body.indexOf(Buffer.from("ệ")) + 1;
  const a = await new Promise<{ out: string }>((done) => {
    const p = spawn(cliCmd[0], [...cliCmd.slice(1), "apply", "-", "-p", io], { cwd: tmp, env: env(), stdio: ["pipe", "pipe", "ignore"] });
    let out = ""; p.stdout!.on("data", (d) => (out += d)); p.on("close", () => done({ out }));
    p.stdin!.write(body.subarray(0, cut));
    setTimeout(() => p.stdin!.end(body.subarray(cut)), 500);
  });
  check("apply - keeps multi-byte text whole across stdin chunks", JSON.parse(a.out || "{}").ok === true && !readFileSync(join(io, "project.json"), "utf8").includes("\uFFFD"), a.out.slice(0, 300));
  const rev = () => run(["info", "-p", io], tmp).json?.revision;
  const r0 = rev();
  const dr = run(["apply", "--ops", JSON.stringify([{ op: "add_clip", track: "main", type: "color", color: "#204080", id: "c1", duration: 2 }]), "--dry-run=false", "-p", io], tmp);
  check("--dry-run=false saves the edit", dr.json?.dry_run === false && rev() > r0, dr.out.slice(0, 300));
  const u = run(["render", "--no-such-flag", "2", "-p", io], tmp);
  check("unknown flag: exit 2, code usage, names the flag", u.status === 2 && u.json?.error?.code === "usage" && u.json.error.message.includes("--no-such-flag"), u.out.slice(0, 300));
  const uc = run(["bogus"], tmp);
  check("unknown command: exit 2", uc.status === 2 && uc.json?.error?.code === "usage", uc.out.slice(0, 300));
  const note = run(["feedback", "add", "kind=idea", "title=flag check"], tmp).json;
  const rs = run(["feedback", "resolve", note.id, "--status", "wontfix"], tmp);
  check("feedback resolve --status wontfix stores the value", rs.json?.status === "wontfix", rs.out.slice(0, 300));
  const md = join(tmp, "backlog.md");
  const sm = run(["feedback", "summary", "--md", md], tmp);
  check("feedback summary --md FILE writes the file", sm.json?.ok === true && existsSync(md), sm.out.slice(0, 300));
  run(["apply", "--ops", JSON.stringify([{ op: "add_clip", track: "text", id: "t1", text: "Hi", at: 0, duration: 1, attach_to: "c1" }]), "-p", io], tmp);
  const rm = run(["rm", "c1", "--keep-attached", "-p", io], tmp);
  check("rm --keep-attached keeps the attached clip", rm.json?.ok === true && clipIds().includes("t1") && !clipIds().includes("c1"), [rm.out.slice(0, 200), clipIds()]);
  // a result bigger than the pipe buffer, read late: the process must not exit before the pipe is drained
  const slow = await new Promise<{ len: number; ok: boolean }>((done) => {
    const p = spawn(cliCmd[0], [...cliCmd.slice(1), "info", "--json", "-p", io], { cwd: tmp, env: env(), stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    p.stdout!.on("data", (d: Buffer) => chunks.push(d));
    p.stdout!.pause();
    setTimeout(() => p.stdout!.resume(), 1500);
    p.on("close", () => { const t = Buffer.concat(chunks).toString("utf8"); let ok = false; try { ok = JSON.parse(t).ok === true; } catch { /* cut */ } done({ len: t.length, ok }); });
  });
  check("a result larger than the pipe buffer arrives whole", slow.ok, slow.len);
}

// a failed ffmpeg spawn: the loudness of a finished render is left unknown, the process does not die on an unhandled 'error' event
if (!bin) {
  console.log("ffmpeg spawn failure");
  const script = join(tmp, "spawn-fail.ts"), empty = join(tmp, "empty-path");
  mkdirSync(empty);
  writeFileSync(script, `import { loudness } from ${JSON.stringify(join(root, "src/analyze.ts"))};\nprocess.env.PATH = ${JSON.stringify(empty)};\nconsole.log(JSON.stringify(await loudness("x.wav")));\n`);
  const r = spawnSync("bun", ["--no-install", "--no-env-file", `--config=${join(root, "scripts/bunfig.empty.toml")}`, script], { cwd: tmp, env: { ...env(), PATH: process.env.PATH }, encoding: "utf8", timeout: 30000 });
  check("loudness with no ffmpeg on PATH resolves with unknown metrics", r.status === 0 && r.stdout.includes('"integrated_lufs":null'), [r.status, r.stdout.slice(0, 200), r.stderr.slice(-300)]);
}

// the test runner: a failing suite does not hide the later ones, the exit code is 1 and the failed suites are named at the end
if (!bin) {
  console.log("test runner");
  const dir = join(tmp, "runner-suites");
  mkdirSync(dir);
  const suite = (name: string, body: string) => { writeFileSync(join(dir, name), body); return join(dir, name); };
  const failA = suite("fail-a.ts", 'console.log("FAIL-A ran"); process.exit(3);\n'), passB = suite("pass-b.ts", 'console.log("PASS-B ran");\n'), failC = suite("fail-c.ts", 'console.log("FAIL-C ran"); process.exit(1);\n');
  const run = (...files: string[]) => spawnSync("bun", ["--no-install", join(root, "scripts/test.ts"), ...files], { cwd: tmp, env: { ...env(), PATH: process.env.PATH }, encoding: "utf8", timeout: 60000 });
  const bad = run(failA, passB, failC), good = run(passB);
  const tail = bad.stderr.slice(bad.stderr.lastIndexOf("suites failed"));
  check("test runner: a failing suite does not stop the later ones; exit 1; the failed suites are named, the passing one is not",
    bad.status === 1 && /FAIL-A ran[\s\S]*PASS-B ran[\s\S]*FAIL-C ran/.test(bad.stdout) && tail.includes("fail-a.ts (exit 3)") && tail.includes("fail-c.ts (exit 1)") && !tail.includes("pass-b.ts"),
    [bad.status, bad.stdout.slice(-200), bad.stderr.slice(-300)]);
  const flags = run(suite("flags.ts", "console.log(`FLAGS ${JSON.stringify(process.execArgv)}`);\n"));
  check("test runner: each suite is started with --no-install", flags.stdout.includes('FLAGS ["--no-install"]'), [flags.status, flags.stdout.slice(-200), flags.stderr.slice(-200)]);
  check("test runner: all suites passing exits 0", good.status === 0 && /all 1 suites passed/.test(good.stdout), [good.status, good.stdout.slice(-200), good.stderr.slice(-200)]);
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
