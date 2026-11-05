// Slow work off the edit path + bounded caches: project lock under concurrent processes (stale-lock reclaim race),
// prepare as an MCP background job with progress (render_status), not_prepared fail-fast, cache info/prune, previews cap.
// The vision helper is a fake `uv` (AGENTCUT_UV) so this runs offline. Run: bun tests/jobs.ts [--keep]   (needs ffmpeg)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-jobs-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
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
  writeFileSync(join(D2, "lock"), `${deadPid()} stale-token`);
  await run("claim", join(D2, "lock"));
  const before = readdirSync(D2).length;
  const codes3 = await Promise.all(Array.from({ length: 4 }, () => run("count", D2, "5")));
  check("crashed reclaimer's token is reclaimed too", before === 3 && codes3.every((c) => c === 0) && readFileSync(join(D2, "counter"), "utf8") === String(N * K + 20) && readdirSync(D2).join() === "counter", readdirSync(D2));

  // the old race: reclaimer B read lock L (dead holder) and stalls; A reclaims L and takes a NEW lock; B then resumes its
  // reclaim with the stale view. The old check-then-unlink deleted A's live lock here.
  const { reclaim, withLock } = await import("../src/project.ts");
  const L = join(tmp, "lock3", "lock"), stale = `${deadPid()} old`;
  mkdirSync(join(tmp, "lock3"));
  writeFileSync(L, stale);
  withLock(L, () => {
    const mine = readFileSync(L, "utf8");
    reclaim(L, stale, `${process.pid} late`);
    check("a late reclaimer with a stale view cannot delete a live lock", readFileSync(L, "utf8") === mine && mine !== stale && readdirSync(join(tmp, "lock3")).join() === "lock");
  });
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
  await client.close();
}

// ---------------------------------------------------------------- render + cache via api
console.log("render + cache");
process.env.AGENTCUT_UV = fake;
const api = await import("../src/api.ts");
const out = join(tmp, "out.mp4");
const rr: any = await api.render(P, { out, quality: "draft", sheet: false });
check("render uses the prepared matte (no helper call)", rr.frames === 60 && nCalls() === 1, rr);
const png = join(tmp, "f.png");
await api.frame(P, 1, { out: png, scale: 0.5 });
const pix = (x: number) => [...spawnSync("ffmpeg", ["-v", "error", "-i", png, "-vf", `crop=1:1:${x}:180`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout];
check("matte composited: left half shows the green background", pix(40)[1] > 200 && pix(40)[0] < 60, pix(40));

const cache = join(P, ".agentcut", "cache");
const matte = readdirSync(cache).find((f) => f.startsWith("matte-"))!;
// an orphan analysis (no clip needs it) and an old preview
writeFileSync(join(cache, "subject-0123456789abcdef0123.json"), JSON.stringify({ samples: [] }).padEnd(4096));
const info0: any = api.cache.info(P);
check("cache info: sizes per area, matte + helper script referenced", info0.cache.files === 3 && info0.cache.referenced.files === 2 && info0.previews.files >= 1, info0);
const pr1: any = api.cache.prune(P);
check("prune (default): removes only unreferenced cache files", pr1.removed.files >= 2 && existsSync(join(cache, matte)) && !existsSync(join(cache, "subject-0123456789abcdef0123.json")) && pr1.removed_referenced === 0, pr1);
check("prepared project still previews after a default prune", !!(await api.frame(P, 1, { out: png })).image);
const pr2: any = api.cache.prune(P, { maxMb: 0 });
check("prune max_mb=0 removes referenced files too, with a prepare hint", !existsSync(join(cache, matte)) && pr2.removed_referenced >= 1 && /prepare/.test(pr2.hint), pr2);
const nf: any = await api.frame(P, 1, { out: png }).catch((e) => e);
check("after pruning the matte, preview asks for prepare again", nf.code === "not_prepared", nf);
await api.prepare(P);
check("prepare rebuilds it", existsSync(join(cache, matte)) && nCalls() === 2);
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

// containment: symlinks inside or in place of an area are never walked, counted or deleted
console.log("cache containment (symlinks)");
{
  const outside = join(tmp, "outside"), sentinels = ["a.bin", "b.bin", "c.bin"].map((n) => join(outside, n));
  mkdirSync(outside);
  const plant = () => sentinels.forEach((f, i) => { writeFileSync(f, Buffer.alloc(100_000)); utimesSync(f, week + i, week + i); });
  const intact = () => sentinels.every((f) => existsSync(f));
  const errCode = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.code; } };
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
    check(`${name}/ symlinked outside: prune and info fail closed, sentinels survive`, codes.every((c) => c === "unsafe_cache_dir") && intact(), codes);
    unlinkSync(link);
    renameSync(real, link);
  }

  // a UI play draft in flight (this pid in the .part-<pid>- name) survives a cap and a prune
  mkdirSync(join(prev, "ui"), { recursive: true });
  const draft = join(prev, "ui", `play-r1-0.00-1.00.part-${process.pid}-abcd1234.mp4`);
  writeFileSync(draft, Buffer.alloc(100_000)); utimesSync(draft, week - 5, week - 5);
  process.env.AGENTCUT_PREVIEWS_MAX_MB = "0.05";
  await api.frame(P, 1.5, { scale: 0.5 });
  delete process.env.AGENTCUT_PREVIEWS_MAX_MB;
  api.cache.prune(P, { maxMb: 0 });
  check("in-flight draft survives the cap and prune", existsSync(draft));
}

console.log(`\n${failures ? `✗ ${failures} failure(s)` : "✓ all jobs checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
