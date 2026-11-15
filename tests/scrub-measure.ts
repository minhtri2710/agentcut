// Scrub timing on the fixtures of tests/scrub-fixtures.ts. One mode per run; every mode appends one json line per timeline to <dir>/runs/<label>.jsonl and prints a summary.
//   http    the number that counts: a real `ac ui --port 0` server, GET /api/frame?scale=0.5 once cold (the first frame request on a fresh server),
//           then 40 requests at t = (i + 0.5) * duration / 40, ascending, one at a time; the wall time of each includes reading the body.
//   stages  where the time goes, in this process: api.frameImage as the handler calls it, then the same work in the pieces renderFrame runs
//           (setup, Renderer construct, decode = the time inside FrameSource.readAt, composite = the rest of Renderer.frame, JPEG encode, close). Run apart from `http`.
//   floor   plain ffmpeg `-ss t -i file -frames:v 1` on the 1080p source and on k4 at the same 40 times: what starting a decoder and one frame cost.
// p50 / p95 are nearest rank (the 20th and the 38th of 40). The page cache is not dropped: "cold" means a fresh server, not a cold disk.
// `uptime` load averages are logged before and after each timeline; the 1-minute figure lags the real load.
// Run: bun --no-install tests/scrub-measure.ts <http|stages|floor> <fixtures dir> <label> [timeline ...]
//   with AGENTCUT_HOME and AGENTCUT_CACHE pointing at isolated dirs (stages and the server child both read them).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mediaDir, NAMES, projectDir, type Name } from "./scrub-fixtures.ts";

const [mode, dirArg, label, ...only] = process.argv.slice(2);
if (!["http", "stages", "floor"].includes(mode) || !dirArg || !label) throw new Error("usage: bun tests/scrub-measure.ts <http|stages|floor> <fixtures dir> <label> [timeline ...]");
if (!process.env.AGENTCUT_HOME || !process.env.AGENTCUT_CACHE) throw new Error("AGENTCUT_HOME and AGENTCUT_CACHE must point at isolated dirs");
const bad = only.filter((n) => !(NAMES as readonly string[]).includes(n));
if (bad.length) throw new Error(`unknown timeline ${bad.join(", ")}; the names are ${NAMES.join(", ")}`);
const dir = resolve(dirArg), names = (only.length ? only : NAMES) as Name[];
const AC = fileURLToPath(new URL("../scripts/ac", import.meta.url));
const N = 40, SCALE = 0.5, WAIT_MS = 60_000; // the longest wait for the server to listen or for one response; past it the run fails and the server child is ended

mkdirSync(join(dir, "runs"), { recursive: true });
const file = join(dir, "runs", `${label}.jsonl`);
const log = (rec: object) => appendFileSync(file, JSON.stringify({ mode, label, ...rec }) + "\n");
const now = () => performance.now();
const load = () => spawnSync("uptime", { encoding: "utf8" }).stdout.trim().replace(/^.*load averages?: /, "");
const r1 = (x: number) => Math.round(x * 10) / 10;
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1];
const stat = (xs: number[]) => ({ p50: r1(q(xs, 0.5)), p95: r1(q(xs, 0.95)), max: r1(Math.max(...xs)), mean: r1(xs.reduce((a, b) => a + b, 0) / xs.length) });
const spread = (T: number) => Array.from({ length: N }, (_, i) => ((i + 0.5) * T) / N);
const show = (s: { p50: number; p95: number; max: number }) => `p50 ${s.p50}  p95 ${s.p95}  max ${s.max}`;

async function http(name: Name) {
  const loadBefore = load();
  const child = spawn(AC, ["ui", projectDir(dir, name), "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<number | null>((ok) => child.once("exit", ok));
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  console.log(`  ${name}: server pid ${child.pid}`);
  try {
    const url: string = await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`ui did not listen within ${WAIT_MS} ms: ${err.slice(0, 300)}`)), WAIT_MS);
      child.stdout.once("data", (d) => {
        clearTimeout(timer);
        try { ok(JSON.parse(String(d).split("\n")[0]).url); } catch { fail(new Error(`ui printed no JSON first line: ${String(d).slice(0, 200)}`)); }
      });
      void exited.then((c) => { clearTimeout(timer); fail(new Error(`ui exited ${c} before it listened: ${err.slice(0, 300)}`)); });
    });
    const T = ((await (await fetch(url + "api/state", { signal: AbortSignal.timeout(WAIT_MS) })).json()) as { duration: number }).duration;
    const get = async (t: number) => {
      const a = now(), res = await fetch(`${url}api/frame?t=${t.toFixed(4)}&scale=${SCALE}`, { signal: AbortSignal.timeout(WAIT_MS) }), body = Buffer.from(await res.arrayBuffer()), ms = now() - a;
      if (res.status !== 200 || body.length < 1000) throw new Error(`${name} t=${t}: status ${res.status}, ${body.length} bytes: ${body.toString("utf8", 0, 200)}`);
      return { t: Number(t.toFixed(4)), ms: r1(ms), bytes: body.length };
    };
    const cold = await get(T / 2);
    const samples: Awaited<ReturnType<typeof get>>[] = [];
    for (const t of spread(T)) samples.push(await get(t));
    const s = stat(samples.map((x) => x.ms));
    log({ name, pid: child.pid, duration: T, cold_ms: cold.ms, ...s, samples, load_before: loadBefore, load_after: load() });
    console.log(`  ${name}: cold ${cold.ms}  ${show(s)}  load ${loadBefore} -> ${load()}`);
  } finally {
    child.kill("SIGTERM");
    await exited;
  }
}

const waits: [number, number][] = [];
let patched = false;
/** The time during which at least one source-frame wait was open: layers that decode at once (a crossfade) count once. */
function waited() {
  let total = 0, end = -Infinity;
  for (const [a, b] of [...waits].sort((x, y) => x[0] - y[0])) { if (b > end) { total += b - Math.max(a, end); end = b; } }
  return total;
}
async function stages(name: Name) {
  const api = await import("./author-api.ts");
  const M = await import("../src/model.ts");
  const { Renderer, encodeStill } = await import("../src/render.ts");
  if (!patched) { // every wait for a source frame (ffmpeg start, seek, decode, read), timed by a wrapper set here once, nothing in src/ changes
    patched = true;
    const { FrameSource } = await import("../src/media.ts");
    const ro = FrameSource.prototype.readAt;
    FrameSource.prototype.readAt = async function (...a: Parameters<typeof ro>) { const s = now(); try { return await ro.apply(this, a); } finally { waits.push([s, now()]); } };
  }
  const root = projectDir(dir, name), loadBefore = load();
  const T = M.totalDuration(M.resolve(M.clone(api.openProject(root).load())));
  const once = async (t: number) => {
    const a = now();
    await api.frameImage(root, t, { scale: SCALE });
    const whole = now() - a;
    // the same work in pieces, as api.frameImage and renderFrame do it (no prepared mattes in these fixtures)
    const s0 = now();
    const p = api.openProject(root), tl = p.load();
    p.requireValid(tl);
    M.totalDuration(M.resolve(M.clone(tl)));
    const abs = p.absolutized(tl);
    const s1 = now();
    const r = new Renderer(abs, p.root, SCALE);
    const s2 = now();
    waits.length = 0;
    let s3 = 0, s4 = 0;
    try {
      const cv = await r.frame(t);
      s3 = now();
      encodeStill(cv, "jpeg");
      s4 = now();
    } finally { r.close(); }
    const s5 = now();
    const setup = s1 - s0, construct = s2 - s1, decode = waited(), composite = s3 - s2 - decode, encode = s4 - s3, close = s5 - s4;
    return { t: r1(t), whole, setup, construct, decode, composite, encode, close, unattributed: whole - (setup + construct + decode + composite + encode + close) };
  };
  const cold = await once(T / 2);
  const rows: (typeof cold)[] = [];
  for (const t of spread(T)) rows.push(await once(t));
  const keys = ["whole", "setup", "construct", "decode", "composite", "encode", "close", "unattributed"] as const;
  const per = Object.fromEntries(keys.map((k) => [k, stat(rows.map((x) => x[k]))])) as Record<(typeof keys)[number], ReturnType<typeof stat>>;
  const rounded = (x: typeof cold) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, r1(v)]));
  log({ name, duration: T, cold: rounded(cold), stages: per, samples: rows.map(rounded), load_before: loadBefore, load_after: load() });
  console.log(`  ${name}: load ${loadBefore} -> ${load()}`);
  for (const k of keys) console.log(`    ${k.padEnd(13)} ${show(per[k])}  mean ${per[k].mean}`);
}

function floor() {
  for (const [name, f] of [["src", join(mediaDir(dir), "src.mp4")], ["k4", join(mediaDir(dir), "k4.mp4")]] as const) {
    const loadBefore = load(), ms: number[] = [];
    for (const t of spread(60)) {
      const a = now();
      const r = spawnSync("ffmpeg", ["-v", "error", "-ss", t.toFixed(4), "-i", f, "-frames:v", "1", "-an", "-f", "null", "-"], { encoding: "utf8" });
      ms.push(now() - a);
      if (r.status !== 0) throw new Error(`ffmpeg ${name} t=${t}: ${r.stderr}`);
    }
    const s = stat(ms);
    log({ name, ...s, samples: ms.map(r1), load_before: loadBefore, load_after: load() });
    console.log(`  ${name}: ${show(s)}  load ${loadBefore} -> ${load()}`);
  }
}

console.log(`${mode} ${label}: load ${load()}`);
const t0 = now();
if (mode === "floor") floor();
else for (const n of names) await (mode === "http" ? http(n) : stages(n));
console.log(`${mode} ${label}: ${r1((now() - t0) / 1000)} s, load ${load()}`);
