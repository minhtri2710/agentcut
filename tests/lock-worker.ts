// Child process for tests/jobs.ts. Modes:
//   count DIR N        N times: lock, read counter, sleep a little, write counter+1 (lost updates = broken mutex)
//   hold LOCKFILE      take the lock, print "held", then hang until killed (a "crashed" holder once SIGKILLed)
//   claim LOCKFILE     write a reclaim token for the current (dead) lock, as a reclaimer that crashed mid-reclaim
//   wait LOCKFILE MS   try to take the lock for MS ms; print {"code","ms"} (code is the EditError code, or null if acquired)
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { withLock } from "../src/project.ts";

const [mode, target, n] = process.argv.slice(2);
const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (mode === "count") {
  const file = join(target, "counter"), lock = join(target, "lock");
  for (let i = 0; i < Number(n); i++) withLock(lock, () => { const v = Number(readFileSync(file, "utf8")); nap(1); writeFileSync(file, String(v + 1)); }, 60_000);
} else if (mode === "hold") {
  withLock(target, () => { process.stdout.write("held\n"); nap(600_000); });
} else if (mode === "claim") {
  writeFileSync(`${target}.reclaim-${readFileSync(target, "utf8").split(" ")[1]}`, `${process.pid} ${"c".repeat(16)} ${hostname()}`);
} else if (mode === "wait") {
  const t = performance.now();
  let code: string | null = null;
  try { withLock(target, () => {}, Number(n)); } catch (e: any) { code = e.code; }
  process.stdout.write(JSON.stringify({ code, ms: Math.round(performance.now() - t) }));
}
