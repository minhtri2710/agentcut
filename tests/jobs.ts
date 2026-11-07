// Slow work off the edit path + bounded caches: project lock under concurrent processes (stale-lock reclaim race),
// prepare as an MCP background job with progress (render_status), not_prepared fail-fast, cache info/prune, previews cap.
// The vision helper is a fake `uv` (AGENTCUT_UV) so this runs offline. Run: bun tests/jobs.ts [--keep]   (needs ffmpeg)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-jobs-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
mkdirSync(join(tmp, "cache", "models", "u2netp"), { recursive: true }); writeFileSync(join(tmp, "cache", "models", "u2netp", "u2netp.onnx"), ""); // the default matte model is cached
let failures = 0;
const t0 = performance.now();
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 600) : ""); }
}
const ff = (...a: string[]) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a], { encoding: "utf8" }); if (r.status) throw new Error(r.stderr); };
const worker = resolve(import.meta.dir, "lock-worker.ts");
const run = (...a: string[]) => new Promise<number>((res) => spawn(process.execPath, [worker, ...a], { stdio: "inherit" }).on("close", (c) => res(c ?? 1)));
/** pid of a process that has exited */
const deadPid = () => { const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }); return Number(r.stdout); };

/** a lock body as AgentCut writes it: "<pid> <16 hex> <host>" */
const lockBody = (pid: number, id = "a".repeat(16), host = hostname()) => `${pid} ${id} ${host}`;

// ---------------------------------------------------------------- lock
console.log("project lock (concurrent processes)");
{
  const D = join(tmp, "lock1"), N = 8, K = 40;
  mkdirSync(D);
  writeFileSync(join(D, "counter"), "0");
  const codes = await Promise.all(Array.from({ length: N }, () => run("count", D, String(K))));
  check(`${N} processes x ${K} locked increments: no lost update`, codes.every((c) => c === 0) && readFileSync(join(D, "counter"), "utf8") === String(N * K), { codes, n: readFileSync(join(D, "counter"), "utf8") });

  // a crashed holder (SIGKILL inside the lock) leaves a stale lock; many processes reclaim it at once
  const D2 = join(tmp, "lock2");
  mkdirSync(D2);
  writeFileSync(join(D2, "counter"), "0");
  const holder = spawn(process.execPath, [worker, "hold", join(D2, "lock")], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((res) => holder.stdout!.once("data", () => res()));
  holder.kill("SIGKILL");
  await new Promise((r) => holder.on("close", r));
  check("killed holder left its lock behind", existsSync(join(D2, "lock")));
  const codes2 = await Promise.all(Array.from({ length: N }, () => run("count", D2, String(K))));
  check("stale lock reclaimed by racing processes: still mutual exclusion", codes2.every((c) => c === 0) && readFileSync(join(D2, "counter"), "utf8") === String(N * K), readFileSync(join(D2, "counter"), "utf8"));
  check("no lock or reclaim tokens left over", readdirSync(D2).join() === "counter", readdirSync(D2));

  // a reclaimer that itself crashed mid-reclaim (token left, lock still stale) must not wedge the project
  writeFileSync(join(D2, "lock"), lockBody(deadPid()));
  await run("claim", join(D2, "lock"));
  const before = readdirSync(D2).length;
  const codes3 = await Promise.all(Array.from({ length: 4 }, () => run("count", D2, "5")));
  check("crashed reclaimer's token is reclaimed too", before === 3 && codes3.every((c) => c === 0) && readFileSync(join(D2, "counter"), "utf8") === String(N * K + 20) && readdirSync(D2).join() === "counter", readdirSync(D2));

  // the old race: reclaimer B read lock L (dead holder) and stalls; A reclaims L and takes a NEW lock; B then resumes its
  // reclaim with the stale view. The old check-then-unlink deleted A's live lock here.
  const { reclaim, withLock } = await import("../src/project.ts");
  const L = join(tmp, "lock3", "lock"), stale = lockBody(deadPid());
  mkdirSync(join(tmp, "lock3"));
  writeFileSync(L, stale);
  withLock(L, () => {
    const mine = readFileSync(L, "utf8");
    reclaim(L, stale, lockBody(process.pid, "b".repeat(16)));
    check("a late reclaimer with a stale view cannot delete a live lock", readFileSync(L, "utf8") === mine && mine !== stale && readdirSync(join(tmp, "lock3")).join() === "lock");
  });
  // reclaim that cannot make progress (claim held by a live process that is not reclaiming: pid reuse, another user's
  // pid, a stopped reclaimer) must still give up after waitMs with `locked` instead of spinning. Run in a child under a
  // wall-clock kill so a regression fails this check instead of hanging the suite.
  {
    const D4 = join(tmp, "lock4"), L4 = join(D4, "lock"), id = "d".repeat(16);
    mkdirSync(D4);
    writeFileSync(L4, lockBody(deadPid(), id));
    writeFileSync(`${L4}.reclaim-${id}`, lockBody(process.pid, "e".repeat(16)));
    const child = spawn(process.execPath, [worker, "wait", L4, "300"], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "", killed = false;
    child.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => { killed = true; child.kill("SIGKILL"); }, 8000);
    await new Promise((r) => child.on("close", r));
    clearTimeout(timer);
    const r = out ? JSON.parse(out) : {};
    check("claim held by a live non-reclaimer: waiter gets `locked` within a bound (no spin), and the lock and claim are left alone", !killed && r.code === "locked" && r.ms >= 250 && r.ms < 5000 && existsSync(L4) && existsSync(`${L4}.reclaim-${id}`), { killed, out });
  }

  // locks AgentCut did not write in this format, or whose holder cannot be judged (other host), are never reclaimed
  {
    const D5 = join(tmp, "lock5"), L5 = join(D5, "lock"), code = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.code; } };
    mkdirSync(D5);
    const dead = deadPid();
    const cases: Record<string, string> = {
      garbage: "garbage",
      "pid only": String(dead),
      "old <pid> <token> format": `${dead} ${"a".repeat(16)}`,
      "path-like id": `${dead} ../../escape ${hostname()}`,
      "non-hex id": `${dead} ${"z".repeat(16)} ${hostname()}`,
      "trailing newline": `${lockBody(dead)}\n`,
      "dead pid on another host": lockBody(dead, "a".repeat(16), `${hostname()}-other host`),
      "impossible pid on this host": lockBody(99999999999),
    };
    for (const [name, body] of Object.entries(cases)) {
      writeFileSync(L5, body);
      const c = code(() => withLock(L5, () => {}, 200));
      check(`lock '${name}': locked, file kept, nothing created beside it`, c === "locked" && readFileSync(L5, "utf8") === body && readdirSync(D5).join() === "lock", { c, files: readdirSync(D5) });
    }
    // a stale lock whose reclaim claim is malformed / from another host is not reclaimed either
    const id = "f".repeat(16);
    for (const [name, body] of [["malformed", "crashed"], ["other host", lockBody(deadPid(), "c".repeat(16), "elsewhere")]] as const) {
      writeFileSync(L5, lockBody(deadPid(), id));
      writeFileSync(`${L5}.reclaim-${id}`, body);
      const c = code(() => withLock(L5, () => {}, 200));
      check(`stale lock with a ${name} claim: locked, both files kept`, c === "locked" && existsSync(L5) && readFileSync(`${L5}.reclaim-${id}`, "utf8") === body, c);
      rmSync(`${L5}.reclaim-${id}`, { force: true });
    }
    rmSync(L5, { force: true });
  }
}

// ---------------------------------------------------------------- media + fake uv
const m = join(tmp, "media");
mkdirSync(m);
ff("-f", "lavfi", "-i", "color=c=0x00ff00:s=320x180:r=30:d=2", "-pix_fmt", "yuv420p", join(m, "green.mp4"));
ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-pix_fmt", "yuv420p", join(m, "src.mp4"));
const calls = join(tmp, "calls.log"), fake = join(tmp, "fake-uv.mjs");
// matte = left half transparent; emits progress lines like the real helper, and is slow enough to outlive a 0 s wait
writeFileSync(fake, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const job = JSON.parse(process.argv.at(-1));
appendFileSync(${JSON.stringify(calls)}, job.cmd + "\\n");
if (job.cmd !== "matte") { process.stdout.write(JSON.stringify({ samples: [{ t: 0, x: 0.5, y: 0.5, kind: "face" }] })); process.exit(0); }
const vf = "scale=" + job.w + ":" + job.h + ",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,W/2),0,255)'";
const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", job.path, "-an", "-vf", vf, "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-f", "mov", job.out], { encoding: "utf8" });
if (r.status) { process.stderr.write(r.stderr); process.exit(1); }
for (let i = 1; i <= 60; i += 10) { process.stderr.write("AGENTCUT_PROGRESS " + i + "\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120); }
process.stdout.write(JSON.stringify({ out: job.out, frames: 60 }));
`);
chmodSync(fake, 0o755);
const nCalls = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0);

// ---------------------------------------------------------------- prepare as an MCP job
console.log("prepare (MCP background job)");
const P = join(tmp, "proj");
let extraCalls = 0; // helper runs of the model-gate project below, not of P
{
  const env = { ...(process.env as Record<string, string>), AGENTCUT_UV: fake };
  const client = new Client({ name: "jobs-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dir, "../src/mcp.ts")], env }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return JSON.parse(r.content.find((c: any) => c.type === "text").text);
  };
  await call("create_project", { path: P, preset: "720p" });
  const t1 = performance.now();
  const ap = await call("apply_ops", { ops: [
    { op: "add_clip", track: "main", src: join(m, "green.mp4"), duration: 2 },
    { op: "add_clip", track: "overlay", src: join(m, "src.mp4"), at: 0, duration: 2 },
    { op: "remove_background", id: "vid2" }] });
  check("apply_ops returns at once, tells the agent to prepare", ap.ok && ap.prepare_needed && ap.results[2].pending && performance.now() - t1 < 2000 && nCalls() === 0, ap);
  const pv = await call("preview_frame", { t: 1 });
  check("preview_frame before prepare -> not_prepared", !pv.ok && pv.error.code === "not_prepared" && /prepare/.test(pv.error.hint), pv);
  const st = await call("prepare", { status_only: true });
  check("prepare status_only lists the missing matte", st.ok && !st.ready && st.missing[0].kind === "matte" && st.missing[0].frames === 60 && nCalls() === 0, st);
  const job = await call("prepare", { wait_seconds: 0 });
  check("prepare returns a running job", job.ok && job.status === "running" && job.kind === "prepare" && /render_status/.test(job.hint), job);
  let seen = 0, last: any;
  for (let i = 0; i < 100; i++) {
    last = await call("render_status", { job_id: job.job_id, wait_seconds: 0.2 });
    if (last.status === "running" && last.progress > 0 && last.progress < 1) seen++;
    if (last.status !== "running") break;
  }
  check("render_status shows partial progress, then done with the matte", seen > 0 && last.status === "done" && last.progress === 1 && last.result.computed[0].kind === "matte", { seen, last });
  const pv2 = await call("preview_frame", { t: 1 });
  check("preview works after prepare", pv2.ok, pv2);
  const again = await call("prepare", {});
  check("second prepare: nothing to compute", again.status === "done" && again.result.computed.length === 0 && nCalls() === 1, again);
  // a model that is not cached: the MCP prepare tool refuses it, and allow_download lets the job through
  const Q = join(tmp, "proj-model");
  await call("create_project", { path: Q, preset: "720p" });
  await call("apply_ops", { project: Q, ops: [{ op: "add_clip", track: "main", src: join(m, "src.mp4"), duration: 2 }, { op: "remove_background", id: "vid1", model: "silueta" }] });
  const qs = await call("prepare", { project: Q, status_only: true }), calls0 = nCalls();
  check("MCP prepare status_only lists the model to download", qs.ok && qs.models_to_download?.[0]?.model === "silueta" && qs.models_to_download[0].approx_mb === 43, qs);
  const q1 = await call("prepare", { project: Q, wait_seconds: 10 });
  check("MCP prepare without allow_download: model_not_cached, the helper never runs", q1.status === "failed" && q1.error?.code === "model_not_cached" && nCalls() === calls0, q1);
  const q2 = await call("prepare", { project: Q, allow_download: true, wait_seconds: 10 });
  check("MCP prepare allow_download=true passes the gate", q2.status === "done" && q2.result?.computed?.[0]?.kind === "matte" && nCalls() === calls0 + 1, q2);
  extraCalls = 1;
  await client.close();
}

// ---------------------------------------------------------------- render + cache via api
console.log("render + cache");
process.env.AGENTCUT_UV = fake;
const api = await import("../src/api.ts");
const out = join(tmp, "out.mp4");
const rr: any = await api.render(P, { out, quality: "draft", sheet: false });
check("render uses the prepared matte (no helper call)", rr.frames === 60 && nCalls() - extraCalls === 1, rr);
const png = join(tmp, "f.png");
await api.frame(P, 1, { out: png, scale: 0.5 });
const pix = (x: number) => [...spawnSync("ffmpeg", ["-v", "error", "-i", png, "-vf", `crop=1:1:${x}:180`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout];
check("matte composited: left half shows the green background", pix(40)[1] > 200 && pix(40)[0] < 60, pix(40));

const cache = join(P, ".agentcut", "cache");
const matte = readdirSync(cache).find((f) => f.startsWith("matte-"))!;
// an orphan analysis (no clip needs it) and an old preview
writeFileSync(join(cache, "subject-0123456789abcdef0123.json"), JSON.stringify({ samples: [] }).padEnd(4096));
const info0: any = api.cache.info(P);
check("cache info: sizes per area, the matte referenced, the orphan not", info0.cache.files === 2 && info0.cache.referenced.files === 1 && info0.previews.files >= 1, info0);
const pr1: any = api.cache.prune(P);
check("prune (default): removes only unreferenced cache files", pr1.removed.files >= 2 && existsSync(join(cache, matte)) && !existsSync(join(cache, "subject-0123456789abcdef0123.json")) && pr1.removed_referenced === 0, pr1);
check("prepared project still previews after a default prune", !!(await api.frame(P, 1, { out: png })).image);
const pr2: any = api.cache.prune(P, { maxMb: 0 });
check("prune max_mb=0 removes referenced files too, with a prepare hint", !existsSync(join(cache, matte)) && pr2.removed_referenced >= 1 && /prepare/.test(pr2.hint), pr2);
const nf: any = await api.frame(P, 1, { out: png }).catch((e) => e);
check("after pruning the matte, preview asks for prepare again", nf.code === "not_prepared", nf);
await api.prepare(P);
check("prepare rebuilds it", existsSync(join(cache, matte)) && nCalls() - extraCalls === 2);
const bad = (() => { try { api.cache.prune(P, { olderThan: "soon" }); } catch (e: any) { return e.code; } })();
check("bad older_than -> bad_value", bad === "bad_value");

// older_than: only files older than the cutoff go
const prev = join(P, "previews");
const oldF = join(prev, "old.jpg"), newF = join(prev, "new.jpg");
writeFileSync(oldF, "x".repeat(1000));
writeFileSync(newF, "x".repeat(1000));
const week = Date.now() / 1000 - 8 * 86400;
utimesSync(oldF, week, week);
const pr3: any = api.cache.prune(P, { olderThan: "7d" });
check("older_than=7d removes only old unreferenced files", !existsSync(oldF) && existsSync(newF) && existsSync(join(cache, matte)) && pr3.removed.files === 1, pr3);

// automatic previews cap: the newest preview stays, oldest go first; outputs outside previews/ are untouched
process.env.AGENTCUT_PREVIEWS_MAX_MB = "0.3";
for (let i = 0; i < 6; i++) { const f = join(prev, `filler-${i}.bin`); writeFileSync(f, Buffer.alloc(100_000)); utimesSync(f, week + i, week + i); }
const fr = await api.frame(P, 1.5, { scale: 0.5 });
const left = readdirSync(prev), bytes = left.reduce((n, f) => n + statSync(join(prev, f)).size, 0);
check("previews/ capped automatically after a preview (newest kept)", existsSync(fr.image) && bytes <= 0.3 * (1 << 20) && !left.includes("filler-0.bin") && left.includes("filler-5.bin"), { left, bytes });
check("outputs outside previews/ are not touched by the cap", existsSync(png) && existsSync(out));
delete process.env.AGENTCUT_PREVIEWS_MAX_MB;

// CLI: one JSON object
const cli = (...a: string[]) => JSON.parse(spawnSync(process.execPath, [resolve(import.meta.dir, "../src/cli.ts"), ...a, "-p", P], { encoding: "utf8", env: { ...process.env, AGENTCUT_UV: fake } }).stdout);
const ci = cli("cache", "info"), cp = cli("cache", "prune", "--older-than", "30d"), ps = cli("prepare", "--status");
check("CLI cache info / prune / prepare --status print one JSON object", ci.ok && ci.total.files > 0 && cp.ok && cp.removed.files === 0 && ps.ok && ps.ready === true, { ci, cp, ps });

// prepare while the timeline keeps changing: the missing set is never settled in the round budget -> conflict, not internal
console.log("prepare vs concurrent edits");
{
  const P2 = join(tmp, "proj-race"), srcs = [0, 1, 2, 3].map((i) => join(m, `race-${i}.mp4`));
  srcs.forEach((f, i) => ff("-f", "lavfi", "-i", `testsrc2=s=${160 + 16 * i}x90:r=30:d=1`, "-pix_fmt", "yuv420p", f));
  api.create(P2, { preset: "720p" });
  const addMatte = (i: number) => api.apply(P2, [{ op: "add_clip", track: `t${i}`, src: srcs[i], at: 0, duration: 1 }, { op: "remove_background", id: `vid${i + 1}` }]);
  await addMatte(0);
  let edits = 1;
  // once a round's matte is on disk (edits-th matte file), add one more clip that needs a new matte
  const mattes = () => readdirSync(join(P2, ".agentcut", "cache")).filter((f) => f.startsWith("matte-")).length;
  const pending: Promise<unknown>[] = [];
  const r: any = await api.prepare(P2, { progress: (d, n) => { if (d === n && edits < 4 && mattes() >= edits) pending.push(addMatte(edits++)); } }).catch((e) => e);
  await Promise.all(pending);
  check("edits landing every round: prepare fails `conflict` with a prepare-again hint, not `internal`", r.code === "conflict" && /prepare/.test(r.hint ?? "") && edits === 4, { code: r.code, hint: r.hint, edits });
}

// prepare that cannot settle with no edit in between (the matte vanishes after every compute): a bug -> internal, revision unchanged
{
  const P3 = join(tmp, "proj-stuck"), cache3 = join(P3, ".agentcut", "cache");
  api.create(P3, { preset: "720p" });
  await api.apply(P3, [{ op: "add_clip", track: "main", src: join(m, "race-0.mp4"), at: 0, duration: 1 }, { op: "remove_background", id: "vid1" }]);
  const rev = (api.info(P3) as any).revision;
  const r: any = await api.prepare(P3, { progress: (d, n) => {
    // runs after vision.ts renamed the matte into place: delete it so the next round finds it missing again
    if (d === n) for (const f of readdirSync(cache3)) if (f.startsWith("matte-") && !f.includes(".part-")) rmSync(join(cache3, f), { force: true });
  } }).catch((e) => e);
  check("matte that never stays: prepare fails `internal` and the revision did not move", r.code === "internal" && (api.info(P3) as any).revision === rev, { code: r.code, rev, now: (api.info(P3) as any).revision });
}

// ---------------------------------------------------------------- the server as a raw child (stdin EOF, signals, exit code)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => unknown, ms: number) => { const t = performance.now(); while (performance.now() - t < ms && !cond()) await sleep(25); return !!cond(); };
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code !== "ESRCH"; } };
const kids = (pid: number): number[] => spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
const tree = (pid: number): number[] => kids(pid).flatMap((k) => [k, ...tree(k)]);
const osTmp = join(tmp, "os-tmp"); // TMPDIR of every server below: nothing of AgentCut may land here
mkdirSync(osTmp);
function mcpProc(env: Record<string, string>) {
  const child = spawn(process.execPath, [resolve(import.meta.dir, "../src/mcp.ts")], { env: { ...(process.env as Record<string, string>), TMPDIR: osTmp, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", id = 0, exit: { code: number | null; signal: string | null; at: number } | null = null;
  const waiting = new Map<number, (m: any) => void>();
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); waiting.get(m.id)?.(m); waiting.delete(m.id); } } });
  child.on("exit", (code, signal) => { exit = { code, signal, at: performance.now() }; });
  const rpc = (method: string, params: unknown) => new Promise<any>((res) => { const i = ++id; waiting.set(i, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
  return {
    child, pid: child.pid!, rpc, get exit() { return exit; },
    init: async () => { await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jobs-test", version: "1" } }); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); },
    call: async (name: string, args: Record<string, unknown> = {}) => JSON.parse((await rpc("tools/call", { name, arguments: args })).result.content.find((c: any) => c.type === "text").text),
  };
}
/** what a render left in <project>/.agentcut/tmp */
const renderTmpLeft = (proj: string) => (existsSync(join(proj, ".agentcut", "tmp")) ? readdirSync(join(proj, ".agentcut", "tmp")) : []);
const partsIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((f) => f.includes(".part-")) : []);

// a render never leaves a partial or truncated file at the output path: it writes <out>.part-<pid>-<rand><ext> and renames on success
console.log("render output is atomic");
{
  const P4 = join(tmp, "proj-atomic"), dir = join(tmp, "atomic-out");
  mkdirSync(dir);
  api.create(P4, { preset: "720p" });
  await api.apply(P4, [{ op: "add_clip", track: "main", src: join(m, "src.mp4"), at: 0, duration: 2 }]);
  const failAfter = (k: number) => (d: number) => { if (d >= k) throw new Error("progress callback failed"); };
  // R1: a mid-render failure (single worker) leaves nothing at the output path and no part file
  const o1 = join(dir, "fail.mp4");
  const f1: any = await api.render(P4, { out: o1, quality: "draft", sheet: false, workers: 1, progress: failAfter(5) }).catch((e) => e);
  check("R1: render failing mid-way rejects and leaves no output and no part file", f1?.message === "progress callback failed" && !existsSync(o1) && !partsIn(dir).length, { f1: f1?.message, files: readdirSync(dir) });
  // an existing output survives a failed re-render untouched (it is replaced only when the new one is complete)
  const o2 = join(dir, "keep.mp4");
  writeFileSync(o2, "previous render");
  await api.render(P4, { out: o2, quality: "draft", sheet: false, workers: 1, progress: failAfter(5) }).catch(() => {});
  check("a failed re-render keeps the previous output as it was", readFileSync(o2, "utf8") === "previous render" && !partsIn(dir).length, readdirSync(dir));
  // success: complete file at the output path, no part left (video, gif, audio-only)
  for (const [name, o] of [["mp4", { workers: 1 }], ["mp4 with workers", { workers: 2 }], ["gif", { workers: 1 }], ["wav", {}]] as const) {
    const f = join(dir, `ok-${name.replace(/\W+/g, "-")}.${name.split(" ")[0]}`);
    const r: any = await api.render(P4, { out: f, quality: "draft", sheet: false, ...o });
    check(`${name}: output is complete and no part file is left`, r.output === f && statSync(f).size === r.size_bytes && r.size_bytes > 0 && !partsIn(dir).length, { r: r.output, files: readdirSync(dir) });
  }

  // R1b: the server is stopped (SIGTERM) while a one-worker render runs: nothing is left at the output path, no part file, no render temp
  const big = join(m, "big.mp4"), killed = join(tmp, "killed-out"), ko = join(killed, "out.mp4"), P5 = join(tmp, "proj-term");
  ff("-f", "lavfi", "-i", "testsrc2=s=3840x2160:r=30:d=6", "-pix_fmt", "yuv420p", big);
  const srv = mcpProc({ AGENTCUT_UV: fake });
  await srv.init();
  await srv.call("create_project", { path: P5, preset: "4k" });
  await srv.call("apply_ops", { ops: [{ op: "add_clip", track: "main", src: big, at: 0, duration: 5.9 }] });
  const job = await srv.call("render", { output: ko, wait_seconds: 0 });
  const sawPart = await until(() => partsIn(killed).length > 0, 30_000);
  process.kill(srv.pid, "SIGTERM");
  await until(() => srv.exit, 10_000);
  await sleep(700);
  check("R1b: SIGTERM mid-render: a part file was in progress; afterwards no output, no part file, no render temp", job.ok && sawPart && !existsSync(ko) && !partsIn(killed).length && !renderTmpLeft(P5).length, { job, sawPart, out: existsSync(killed) ? readdirSync(killed) : null, tmp: renderTmpLeft(P5), exit: srv.exit });
}

// the server stops (stdin EOF, SIGTERM) while a job runs: every job is aborted, children and temp files are gone, and it exits inside the SDK client's 2 s window
console.log("shutdown while a job runs");
const slowUv = join(tmp, "slow-uv.mjs"), uvLog = join(tmp, "slow-uv.log");
// behaves like vision-py.ts matte(): decoder ffmpeg -> this process -> encoder ffmpeg -> job.out, ~25 s, no progress lines.
// FAKE_UV_MODE: silent = exits on SIGTERM or stdin EOF; stubborn = ignores SIGTERM, exits on stdin EOF; deaf = ignores both (needs SIGKILL)
writeFileSync(slowUv, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const mode = process.env.FAKE_UV_MODE, job = JSON.parse(process.argv.at(-1));
if (mode === "stubborn" || mode === "deaf") process.on("SIGTERM", () => {});
if (mode !== "deaf") { process.stdin.on("end", () => process.exit(143)); process.stdin.resume(); }
const dec = spawn("ffmpeg", ["-v", "error", "-nostdin", "-re", "-f", "lavfi", "-i", "testsrc2=s=" + job.w + "x" + job.h + ":r=30:d=25", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { stdio: ["ignore", "pipe", "ignore"] });
const enc = spawn("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", job.w + "x" + job.h, "-framerate", "30", "-i", "-", "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-f", "mov", job.out], { stdio: ["pipe", "ignore", "ignore"] });
appendFileSync(process.env.FAKE_UV_LOG, process.pid + " " + dec.pid + " " + enc.pid + "\\n");
enc.stdin.on("error", () => {});
dec.stdout.pipe(enc.stdin);
enc.on("exit", () => { process.stdout.write(JSON.stringify({ out: job.out, frames: 750 })); process.exit(0); });
`);
chmodSync(slowUv, 0o755);
const m12 = join(m, "long.mp4");
ff("-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=12", "-pix_fmt", "yuv420p", m12);
let caseNo = 0;
/** start `kind` (prepare: a slow matte; render: a multi-worker render), wait until it is visibly working, stop the server by `how`, report what is left */
async function stopDuring(kind: "prepare" | "render", how: "term" | "eof", mode = "silent") {
  const proj = join(tmp, `proj-stop-${++caseNo}`), outDir = join(tmp, `stop-out-${caseNo}`), out = join(outDir, "out.mp4"), cacheD = join(proj, ".agentcut", "cache");
  rmSync(uvLog, { force: true });
  const srv = mcpProc({ AGENTCUT_UV: slowUv, FAKE_UV_MODE: mode, FAKE_UV_LOG: uvLog });
  await srv.init();
  await srv.call("create_project", { path: proj, preset: "720p" });
  await srv.call("apply_ops", { ops: kind === "prepare"
    ? [{ op: "add_clip", track: "main", src: join(m, "src.mp4"), duration: 2 }, { op: "remove_background", id: "vid1" }]
    : [{ op: "add_clip", track: "main", src: m12, duration: 12 }] });
  const job = await srv.call(kind, kind === "prepare" ? { wait_seconds: 0 } : { output: out, wait_seconds: 0 });
  const working = kind === "prepare"
    ? await until(() => existsSync(uvLog) && partsIn(cacheD).length, 30_000)
    : await until(() => renderTmpLeft(proj).some((d) => existsSync(join(proj, ".agentcut", "tmp", d)) && readdirSync(join(proj, ".agentcut", "tmp", d)).some((f) => f.startsWith("seg"))) && tree(srv.pid).length >= 3, 60_000);
  const logged = existsSync(uvLog) ? readFileSync(uvLog, "utf8").split(/\s+/).filter(Boolean).map(Number) : [];
  const procs = [...new Set([...tree(srv.pid), ...logged])];
  const t0 = performance.now();
  if (how === "term") process.kill(srv.pid, "SIGTERM"); else srv.child.stdin.end();
  const exited = await until(() => srv.exit, 10_000);
  const exitMs = srv.exit ? srv.exit.at - t0 : Infinity;
  const gone = await until(() => procs.every((p) => !isAlive(p)), Math.max(0, 3000 - (performance.now() - t0)));
  const left = procs.filter(isAlive);
  for (const p of left) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } // a failing test must not leave processes behind
  return { job, working, procs, exited, exitMs, code: srv.exit?.code, signal: srv.exit?.signal, gone, left, parts: partsIn(cacheD), tmpLeft: renderTmpLeft(proj), outLeft: existsSync(outDir) ? readdirSync(outDir) : [],
    osTmpLeft: readdirSync(osTmp).filter((f) => f.startsWith("agentcut")) };
}
const clean = (r: Awaited<ReturnType<typeof stopDuring>>) => !r.parts.length && !r.tmpLeft.length && !r.outLeft.length && !r.osTmpLeft.length;
const sec = (r: { exitMs: number }) => `${(r.exitMs / 1000).toFixed(2)}s`;
for (const [kind, how, mode, name] of [
  ["prepare", "term", "silent", "R2: SIGTERM during a slow prepare"],
  ["render", "term", "silent", "R2: SIGTERM during a multi-worker render"],
  ["prepare", "eof", "silent", "R6: stdin EOF during a slow prepare"],
  ["render", "eof", "silent", "R6: stdin EOF during a multi-worker render"],
] as const) {
  const r = await stopDuring(kind, how, mode);
  const want = how === "term" ? 143 : 0;
  check(`${name}: exits with code ${want} in ${sec(r)}, children dead, no part file, no render temp, no output`,
    r.working && r.exited && r.exitMs < 3000 && r.code === want && r.gone && clean(r), r);
}
for (const mode of ["silent", "stubborn", "deaf"]) {
  const r = await stopDuring("prepare", "term", mode);
  check(`R3: SIGTERM, helper '${mode}' (${{ silent: "dies on SIGTERM", stubborn: "ignores SIGTERM, leaves on stdin EOF", deaf: "ignores both: SIGKILL" }[mode]}): the helper and its ffmpeg children (${r.procs.length} processes) are dead, server exited in ${sec(r)}`,
    r.working && r.procs.length >= 3 && r.exited && r.exitMs < 3000 && r.code === 143 && r.gone && clean(r), r);
}

// DL-02 / DL-07: a tool call the server has accepted around the stop always gets its reply before the server exits (exit code unchanged).
// The late `prepare` is sent just before or just after SIGTERM (shift in ms; < 0: request first); it is `aborted` either way, and the
// server must never start a helper after `stopping`: a request sent after SIGTERM (shift >= 0) starts none (1 helper), one sent before may
// start a concurrent compute (<= 2). Independent of the helper's 1.5 s kill window.
for (const shift of [-30, -2, 0, 2, 30]) {
  const proj = join(tmp, `proj-late${shift}`);
  rmSync(uvLog, { force: true });
  const srv = mcpProc({ AGENTCUT_UV: slowUv, FAKE_UV_MODE: "deaf", FAKE_UV_LOG: uvLog });
  await srv.init();
  await srv.call("create_project", { path: proj, preset: "720p" });
  await srv.call("apply_ops", { ops: [{ op: "add_clip", track: "main", src: join(m, "src.mp4"), duration: 2 }, { op: "remove_background", id: "vid1" }] });
  await srv.call("prepare", { wait_seconds: 0 });
  const working = await until(() => existsSync(uvLog), 30_000);
  const procs = [...new Set([...tree(srv.pid), ...readFileSync(uvLog, "utf8").split(/\s+/).filter(Boolean).map(Number)])];
  const t0 = performance.now();
  let late: any = null, lateMs: number | null = null;
  const send = () => srv.call("prepare", { wait_seconds: 5 }).then((r) => { late = r; lateMs = Math.round(performance.now() - t0); });
  let sent: Promise<void>;
  if (shift < 0) { sent = send(); await sleep(-shift); process.kill(srv.pid, "SIGTERM"); }
  else { process.kill(srv.pid, "SIGTERM"); await sleep(shift); sent = send(); }
  await until(() => srv.exit, 10_000);
  await Promise.race([sent, sleep(200)]); // a reply written before the exit is already in the pipe
  const exitMs = srv.exit ? Math.round(srv.exit.at - t0) : null;
  const helpers = readFileSync(uvLog, "utf8").trim().split("\n").length;
  for (const p of procs) if (isAlive(p)) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  check(`DL-02/DL-07: a prepare sent ${shift < 0 ? `${-shift} ms before` : `${shift} ms after`} SIGTERM is answered \`aborted\` before the server exits (143), ${shift < 0 ? "at most 2 helpers" : "no new helper"}`,
    working && late?.status === "failed" && late.error?.code === "aborted" && srv.exit?.code === 143 && (shift < 0 ? helpers <= 2 : helpers === 1), { late, helpers, exitMs, lateMs, exit: srv.exit });
}

// DM-01: a reply bigger than the pipe buffer, read late by a client that is paused when SIGTERM arrives, still arrives whole (the shutdown waits
// for stdout to take it); the exit code stays 143. DM-02: a reader that went away does not change the exit code.
{
  const big = join(tmp, "big.png");
  ff("-f", "lavfi", "-i", "nullsrc=s=1200x1000,geq=r='random(1)*255':g='random(2)*255':b='random(3)*255'", "-frames:v", "1", big);
  const bytes = statSync(big).size;
  const srv = mcpProc({});
  await srv.init();
  srv.child.stdout.pause();
  const reply = srv.rpc("tools/call", { name: "view_image", arguments: { path: big } });
  await sleep(500); // the server has written what the pipe takes and is waiting for the rest to drain
  const t0 = performance.now();
  process.kill(srv.pid, "SIGTERM");
  await sleep(400);
  const aliveBeforeRead = !srv.exit;
  const exited = () => srv.exit; // read after the awaits: the getter is not narrowed by the check above
  srv.child.stdout.resume();
  const msg: any = await Promise.race([reply, sleep(10_000).then(() => null)]);
  await until(() => srv.exit, 10_000);
  const got = msg?.result?.content?.[0]?.data?.length ?? 0;
  check(`DM-01: a ${(bytes / 1e6).toFixed(1)} MB image reply, client paused at SIGTERM and reading 400 ms later, arrives whole; exit 143`,
    aliveBeforeRead && got === Math.ceil(bytes / 3) * 4 && exited()?.code === 143, { bytes, got, aliveBeforeRead, exit: exited(), exitMs: exited() ? Math.round(exited()!.at - t0) : null });
}
{
  const srv = mcpProc({});
  await srv.init();
  srv.child.stdout.destroy(); // nobody reads the replies any more: the server's next write fails with EPIPE
  srv.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "guide", arguments: {} } }) + "\n");
  await sleep(500);
  const diedEarly = !!srv.exit;
  if (!diedEarly) process.kill(srv.pid, "SIGTERM");
  await until(() => srv.exit, 10_000);
  check("DM-02: stdout closed by the reader (EPIPE on a reply), then SIGTERM: the server stays up until the stop and exits 143", !diedEarly && (srv.exit as typeof srv.exit)?.code === 143, { diedEarly, exit: srv.exit });
}

// DL-01: the embedded helper script, run by the real python3 (no uv, no packages): a normal exit must stay normal, the stdin stop must work,
// and the stop must stay unarmed when stdin is not a pipe
console.log("vision helper script (python3)");
{
  const py = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (py.error) console.log("  - skipped: no python3 on PATH");
  else {
    const { VISION_PY } = await import("../src/vision-py.ts");
    const file = join(tmp, "helper.py"), head = join(tmp, "helper-head.py");
    writeFileSync(file, VISION_PY);
    writeFileSync(head, VISION_PY.slice(0, VISION_PY.indexOf("def frames(")) + "\nimport sys, time\ntime.sleep(float(sys.argv[1]))\n"); // the stop watcher only, then a sleep
    const runPy = (args: string[], stdio: "pipe" | "ignore", closeStdinAfterMs?: number) => new Promise<{ code: number | null; signal: string | null; ms: number; stderr: string }>((res) => {
      const t = performance.now(), ch = spawn("python3", ["-I", ...args], { stdio: [stdio, "pipe", "pipe"] });
      let stderr = ""; ch.stderr!.on("data", (d) => (stderr += d));
      if (closeStdinAfterMs !== undefined) setTimeout(() => ch.stdin!.end(), closeStdinAfterMs);
      const guard = setTimeout(() => ch.kill("SIGKILL"), 15_000); // a hung python must fail the check, not the suite
      ch.on("exit", (code, signal) => { clearTimeout(guard); res({ code, signal, ms: performance.now() - t, stderr }); });
    });
    const bogus = await runPy([file, '{"cmd":"bogus"}'], "pipe");
    check(`helper exits normally (code 1, KeyError) with its stop watcher armed, not by SIGABRT [${py.stdout.trim()}]`, bogus.code === 1 && bogus.signal === null && /KeyError/.test(bogus.stderr), bogus);
    const ok = await runPy([head, "0.3"], "pipe");
    check("helper that finishes normally with stdin an open pipe exits 0", ok.code === 0 && ok.signal === null, ok);
    const stop = await runPy([head, "30"], "pipe", 300);
    check(`closing the helper's stdin stops it: exit 143 in ${(stop.ms / 1000).toFixed(2)}s`, stop.code === 143 && stop.ms < 3000, stop);
    const devnull = await runPy([head, "0.5"], "ignore");
    check("stdin from /dev/null (not a pipe): the watcher stays unarmed, the run finishes normally", devnull.code === 0 && devnull.signal === null, devnull);
  }
}

// a dead process's leftovers are swept at the next prepare and render; nothing else is touched
console.log("sweep of a dead process's leftovers");
{
  const P6 = join(tmp, "proj-atomic"), cacheD = join(P6, ".agentcut", "cache"), tmpD = join(P6, ".agentcut", "tmp");
  const dead = deadPid(), me = process.pid, outside = join(tmp, "sweep-outside");
  mkdirSync(cacheD, { recursive: true }); mkdirSync(tmpD, { recursive: true }); mkdirSync(join(outside, "d"), { recursive: true });
  writeFileSync(join(outside, "d", "sentinel"), "x");
  const gone = [join(cacheD, `matte-aaa.part-${dead}-1.mov`), join(cacheD, `subject-bbb.part-${dead}-abcdef.json`), join(tmpD, `render-${dead}-abc123`)];
  const kept = [join(cacheD, `matte-aaa.part-${me}-1.mov`), join(cacheD, `matte-aaa.part-99999999999-1.mov`), join(tmpD, `render-${me}-abc123`), join(tmpD, `render-99999999999-abc123`),
    join(tmpD, `render-${dead}-abc123.txt`), join(tmpD, `render-${dead}-abc12`), join(tmpD, "other"), join(P6, `stray.part-${dead}-1.mov`),
    join(cacheD, "sub", `deep.part-${dead}-1.mov`), // the cache dir is flat: only its direct children are swept
    join(P6, "previews", `p.part-${dead}-1.bin`), join(P6, "renders", `r.part-${dead}-1.mp4`), join(P6, "media", `media.part-${dead}-1.mp4`)];
  const plant = (fs: string[]) => { for (const f of fs) { mkdirSync(join(f, ".."), { recursive: true }); if (/render-\d+-abc123$|other$|abc12$/.test(f)) { mkdirSync(f, { recursive: true }); writeFileSync(join(f, "seg000.mkv"), "x".repeat(2000)); } else writeFileSync(f, "x"); } };
  const info0: any = api.cache.info(P6);
  plant([join(tmpD, `render-${me}-abc123`), join(tmpD, "other")]);
  const info1: any = api.cache.info(P6);
  check("cache info does not count .agentcut/tmp", info1.total.files === info0.total.files && info1.total.mb === info0.total.mb, { info0: info0.total, info1: info1.total });
  plant([...gone, ...kept]);
  symlinkSync(join(outside, "d"), join(tmpD, `render-${dead}-lnk123`)); // a symlink with a dead pid in its name: never followed, never removed
  for (const [what, run] of [["prepare", () => api.prepare(P6)], ["render", () => api.render(P6, { out: join(tmp, "sweep-out.mp4"), quality: "draft", sheet: false, workers: 1, end: 0.5 })]] as const) {
    if (what === "render") plant(gone); // plant again for the second entry point
    await run();
    check(`R5: ${what} sweeps the dead pid's .part files and render dirs`, gone.every((f) => !existsSync(f)), gone.filter(existsSync));
    check(`R5: ${what} keeps a live pid's, impossible pids, near-miss names, symlinks and anything outside the cache and .agentcut/tmp`,
      kept.every((f) => existsSync(f)) && existsSync(join(tmpD, `render-${dead}-lnk123`)) && existsSync(join(outside, "d", "sentinel")), kept.filter((f) => !existsSync(f)));
  }
  // DL-04: housekeeping never fails the user's call: stale entries that cannot be removed (read-only parents) are left, prepare and render still succeed
  if (process.getuid?.() === 0) console.log("  - skipped: running as root, chmod cannot make a directory read-only");
  else {
    plant(gone);
    chmodSync(gone[2], 0o555); chmodSync(cacheD, 0o555); // the stale render dir cannot lose its file, the cache dir cannot lose its .part files
    const r1: any = await api.prepare(P6).catch((e) => e), r2: any = await api.render(P6, { out: join(tmp, "sweep-out2.mp4"), quality: "draft", sheet: false, workers: 1, end: 0.5 }).catch((e) => e);
    chmodSync(gone[2], 0o755); chmodSync(cacheD, 0o755);
    check("R5: entries that cannot be removed do not fail prepare or render, and stay for the next sweep", r1.ready === true && r2.frames > 0 && gone.every(existsSync), { r1: r1?.message ?? r1.ready, r2: r2?.message ?? r2.frames, left: gone.filter(existsSync) });
    await api.prepare(P6);
    check("R5: the next sweep removes them", gone.every((f) => !existsSync(f)));
  }
  api.cache.prune(P6, { maxMb: 0 });
  check("cache prune (max_mb=0) leaves .agentcut/tmp alone", existsSync(join(tmpD, `render-${me}-abc123`)) && existsSync(join(tmpD, "other")) && existsSync(join(tmpD, `render-${dead}-lnk123`)));
}

// containment: symlinks inside or in place of an area are never walked, counted or deleted
console.log("cache containment (symlinks)");
{
  const outside = join(tmp, "outside"), sentinels = ["a.bin", "b.bin", "c.bin"].map((n) => join(outside, n));
  mkdirSync(outside);
  const plant = () => sentinels.forEach((f, i) => { writeFileSync(f, Buffer.alloc(100_000)); utimesSync(f, week + i, week + i); });
  const intact = () => sentinels.every((f) => existsSync(f));
  const errCode = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.code; } };
  const errHint = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.hint; } };
  plant();
  symlinkSync(outside, join(prev, "linkdir"));
  symlinkSync(sentinels[0], join(prev, "linkfile.bin"));
  const info: any = api.cache.info(P);
  check("symlinked file and dir are not counted", info.previews.files === readdirSync(prev, { withFileTypes: true }).filter((d) => d.isFile()).length, info.previews);
  process.env.AGENTCUT_PREVIEWS_MAX_MB = "0.3";
  for (let i = 0; i < 4; i++) { const f = join(prev, `contained-${i}.bin`); writeFileSync(f, Buffer.alloc(100_000)); utimesSync(f, week + i, week + i); }
  await api.frame(P, 1.5, { scale: 0.5 });
  check("cap evicts previews but not what a symlink points at", intact() && !existsSync(join(prev, "contained-0.bin")), readdirSync(prev));
  delete process.env.AGENTCUT_PREVIEWS_MAX_MB;
  api.cache.prune(P);
  api.cache.prune(P, { maxMb: 0 });
  await api.prepare(P); // max_mb=0 also dropped the matte
  check("prune (default and max_mb=0) leaves symlink targets alone", intact() && !existsSync(join(prev, "contained-3.bin")), readdirSync(prev));
  for (const n of ["linkdir", "linkfile.bin"]) rmSync(join(prev, n), { force: true });

  // symlink loops inside an area: a preview write and cache info/prune still work
  symlinkSync(prev, join(prev, "loop"));
  symlinkSync(join(prev, "loopb"), join(prev, "loopa")); symlinkSync(join(prev, "loopa"), join(prev, "loopb"));
  process.env.AGENTCUT_PREVIEWS_MAX_MB = "0.3";
  const lf: any = await api.frame(P, 1, { scale: 0.5 }).catch((e) => e);
  delete process.env.AGENTCUT_PREVIEWS_MAX_MB;
  check("preview write succeeds next to symlink loops", !!lf.image && existsSync(lf.image), lf?.code ?? lf);
  check("cache info/prune do not throw on symlink loops", errCode(() => { api.cache.info(P); api.cache.prune(P); }) === undefined);
  for (const n of ["loop", "loopa", "loopb"]) rmSync(join(prev, n), { force: true });

  // an area that is itself a symlink to somewhere outside: fail closed
  for (const [name, real, link] of [["previews", prev + ".real", prev], ["cache", cache + ".real", cache]] as const) {
    plant();
    renameSync(link, real);
    symlinkSync(outside, link);
    const codes = [errCode(() => api.cache.prune(P)), errCode(() => api.cache.prune(P, { maxMb: 0 })), errCode(() => api.cache.info(P))];
    const hints = [errHint(() => api.cache.prune(P)), errHint(() => api.cache.info(P))];
    check(`${name}/ symlinked outside: prune and info fail closed, sentinels survive`, codes.every((c) => c === "unsafe_cache_dir") && intact(), codes);
    check(`  their hint does not offer AGENTCUT_PREVIEWS_MAX_MB (it only governs the automatic cap)`, hints.every((h) => typeof h === "string" && !/AGENTCUT_PREVIEWS_MAX_MB/.test(h)), hints);
    if (name === "previews") {
      const wf: any = await api.frame(P, 1, { scale: 0.5 }).catch((e) => e);
      check("preview write into a symlinked previews/: unsafe_path, sentinels survive", wf.code === "unsafe_path" && intact(), { code: wf.code, hint: wf.hint });
    }
    unlinkSync(link);
    renameSync(real, link);
  }

  // a UI play draft in flight (this pid in the .part-<pid>- name) survives a cap and a prune
  mkdirSync(join(prev, "ui"), { recursive: true });
  const draft = join(prev, "ui", `play-r1-0.00-1.00.part-${process.pid}-abcd1234.mp4`);
  writeFileSync(draft, Buffer.alloc(100_000)); utimesSync(draft, week - 5, week - 5);
  const impossible = join(prev, "x.part-99999999999-1.bin");
  writeFileSync(impossible, Buffer.alloc(100_000)); utimesSync(impossible, week - 5, week - 5);
  process.env.AGENTCUT_PREVIEWS_MAX_MB = "0.05";
  await api.frame(P, 1.5, { scale: 0.5 });
  delete process.env.AGENTCUT_PREVIEWS_MAX_MB;
  api.cache.prune(P, { maxMb: 0 });
  check("in-flight draft survives the cap and prune", existsSync(draft));
  check("temp with an impossible pid (process.kill rejects it without ESRCH) survives the cap and prune too", existsSync(impossible));
  rmSync(impossible, { force: true });

  // a directory swapped for a symlink after the walk, before the delete: the per-delete realpath recheck refuses it.
  // The walk has no hook, so the swap runs from inside the in-flight probe (process.kill(pid, 0)) that prune makes for
  // this `.part-<dead pid>-` file right after listing it.
  plant();
  const swap = join(prev, "swap"), swapReal = swap + ".real", name = `x.part-${deadPid()}-1.bin`;
  mkdirSync(swap);
  writeFileSync(join(swap, name), Buffer.alloc(1000));
  writeFileSync(join(outside, name), Buffer.alloc(1000));
  const kill = process.kill;
  let swapped = false;
  process.kill = ((pid: number, sig?: any) => {
    if (!swapped) { swapped = true; renameSync(swap, swapReal); symlinkSync(outside, swap); }
    return kill.call(process, pid, sig);
  }) as typeof process.kill;
  let swapCode: string | undefined;
  try { api.cache.prune(P); } catch (e: any) { swapCode = e.code; } finally { process.kill = kill; }
  check("dir swapped for a symlink after the walk: prune refuses, the outside file survives", swapped && swapCode === "unsafe_cache_dir" && intact() && existsSync(join(outside, name)) && existsSync(join(swapReal, name)), { swapped, swapCode });
  if (swapped) { unlinkSync(swap); rmSync(swapReal, { recursive: true, force: true }); }
  rmSync(join(outside, name), { force: true });
}

console.log(`\n${failures ? `✗ ${failures} failure(s)` : "✓ all jobs checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
