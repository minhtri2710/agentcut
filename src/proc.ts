// Child processes that a signal can stop. A leaf module (node: imports only), so any module may run a tool without an import cycle.
import { spawn, type ChildProcess } from "node:child_process";

/** Stop `ch` when `signal` aborts: close its stdin (EOF is the stop request for ffmpeg and the vision helper), SIGTERM it, and
 *  SIGKILL it after `graceMs` if it is still running. Only the direct child is signalled (no process-group kill): what uv forwards
 *  to python is unverified, which is why the helper also watches its stdin. */
export function stopOnAbort(ch: ChildProcess, signal?: AbortSignal, graceMs = 1500) {
  if (!signal) return;
  const stop = () => {
    try { ch.stdin?.end(); } catch { /* already closed */ }
    ch.kill();
    const t = setTimeout(() => ch.kill("SIGKILL"), graceMs);
    ch.once("close", () => clearTimeout(t));
  };
  if (signal.aborted) return stop();
  signal.addEventListener("abort", stop, { once: true });
  ch.once("close", () => signal.removeEventListener("abort", stop));
}

export interface RunResult { status: number | null; stdout: string; stderr: string }
/** spawnSync without blocking the event loop. Output past `maxBuffer` bytes on either stream (spawnSync's default, 1 MiB) kills the child and gives
 *  status null with the output kept so far, as does a failed spawn (the message goes to stderr). An abort stops the child and rejects with signal.reason. */
export async function run(cmd: string, args: string[], { signal, maxBuffer = 1 << 20 }: { signal?: AbortSignal; maxBuffer?: number } = {}): Promise<RunResult> {
  signal?.throwIfAborted();
  const ch = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  const out: Buffer[][] = [[], []], size = [0, 0];
  let over = false;
  const keep = (k: 0 | 1) => (d: Buffer) => {
    const room = maxBuffer - size[k];
    if (d.length > room) { over = true; ch.kill(); d = d.subarray(0, room); }
    size[k] += d.length;
    out[k].push(d);
  };
  ch.stdout!.on("data", keep(0));
  ch.stderr!.on("data", keep(1));
  stopOnAbort(ch, signal);
  const status = await new Promise<number | null>((done) => {
    ch.once("error", (e) => { out[1].push(Buffer.from(e.message)); done(null); });
    ch.once("close", (code) => done(over ? null : code));
  });
  signal?.throwIfAborted();
  return { status, stdout: Buffer.concat(out[0]).toString(), stderr: Buffer.concat(out[1]).toString() };
}
