// Scrub timing on the fixtures of tests/scrub-fixtures.ts. One mode per run; every mode appends one json line per timeline to <dir>/runs/<label>.jsonl and prints a summary.
//   http    the number that counts: a real `ac ui --port 0` server, GET /api/frame?scale=0.5 once cold (the first frame request on a fresh server),
//           then 40 requests at t = (i + 0.5) * duration / 40, one at a time, in the order --order names; the wall time of each includes reading the body.
//   stages  where the time goes, in this process: api.frameImage as the handler calls it, then the same work in the pieces renderFrame runs
//           (setup, Renderer construct, decode = the time inside FrameSource.readAt, composite = the rest of Renderer.frame, JPEG encode, close). Run apart from `http`.
//   floor   plain ffmpeg `-ss t -i file -frames:v 1` on the 1080p source and the short-GOP source at the same 40 times, ascending: what starting a decoder and one frame cost.
//   floor-hw     the floor line on src.mp4 and short.mp4, each in software and with `-hwaccel videotoolbox` placed first (where src/media.ts puts it), the four variants
//                taken back to back at each of the 40 times, the first one rotating, so host load drift reaches all of them alike. Each hardware run must exit 0 with an empty stderr,
//                and before timing one untimed `-v verbose` run per file must name videotoolbox for the hardware line and not for the software one (the proof is in the jsonl as hw_proof).
//   floor-gop    the software floor line on short.mp4 at keyframe time + 0, 0.5, 1.0 and 1.45 s for the first 39 keyframes; the distance is checked against the file's keyframe list before the first spawn.
//   floor-proxy  the software floor line at the 40 times on the two p540 proxy-like files (tests/scrub-fixtures.ts proxy) with src.mp4 and short.mp4 beside them, taken the same way.
//   The three floor-* modes take no flag and no timeline name. They interleave their variants; each variant is one jsonl line.
// p50 / p95 are nearest rank (the 20th and the 38th of 40). The page cache is not dropped: "cold" means a fresh server, not a cold disk.
// `uptime` load averages are logged before and after each timeline, and every 10th time point of a floor-* pass; the 1-minute figure lags the real load.
// --order=asc|desc|shuffle (http and stages; default asc) visits the same 40 times ascending, descending, or in one fixed shuffle (Fisher-Yates over mulberry32, seed 79) for every timeline and repeat.
// Run: bun --no-install tests/scrub-measure.ts <http|stages|floor|floor-hw|floor-gop|floor-proxy> <fixtures dir> <label> [--order=asc|desc|shuffle] [timeline ...]
//   with AGENTCUT_HOME and AGENTCUT_CACHE pointing at isolated dirs (stages and the server child both read them).
//   A token that starts with "-" is a flag wherever it stands, and the only flag is --order=; a dir that starts with "-" is written ./-name; a label cannot start with "-".
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GOP_PROXY_FILE, INTRA_PROXY_FILE, keyframes, NAMES, projectDir, SHORT_FILE, SRC_FILE, type Name } from "./scrub-fixtures.ts";

const MODES = ["http", "stages", "floor", "floor-hw", "floor-gop", "floor-proxy"];
const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("-")), pos = argv.filter((a) => !a.startsWith("-")); // a flag takes no following token: `--order tl1` refuses `--order` and does not eat tl1; one in the dir or label slot is a flag, not a value
const [mode, dirArg, label, ...only] = pos;
if (!MODES.includes(mode) || !dirArg || !label) throw new Error(`usage: bun tests/scrub-measure.ts <${MODES.join("|")}> <fixtures dir> <label> [--order=asc|desc|shuffle] [timeline ...]`);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) throw new Error(`label ${JSON.stringify(label)} must be letters, digits, ".", "_" and "-", starting with a letter or digit`);
if (!process.env.AGENTCUT_HOME || !process.env.AGENTCUT_CACHE) throw new Error("AGENTCUT_HOME and AGENTCUT_CACHE must point at isolated dirs");
const ORDERS = ["asc", "desc", "shuffle"], SEED = 79, FLOOR = mode.startsWith("floor");
const unknownFlags = flags.filter((f) => !f.startsWith("--order="));
if (unknownFlags.length) throw new Error(`unknown flag ${unknownFlags.join(", ")}; the only flag is --order=${ORDERS.join("|")}`);
if (flags.length > 1) throw new Error("--order was given more than once");
const ORDER = flags.length ? flags[0].slice("--order=".length) : "asc";
if (!ORDERS.includes(ORDER)) throw new Error(`--order=${ORDER || "<empty>"} is not one of ${ORDERS.join(", ")}`);
if (FLOOR && flags.length) throw new Error(`--order does not apply to ${mode}`);
if (FLOOR && only.length) throw new Error(`${mode} takes no timeline name, got ${only.join(", ")}`);
const bad = only.filter((n) => !(NAMES as readonly string[]).includes(n));
if (bad.length) throw new Error(`unknown timeline ${bad.join(", ")}; the names are ${NAMES.join(", ")}`);
const dir = resolve(dirArg), names = (only.length ? only : NAMES) as Name[];
// what the mode reads must exist before anything is created or timed
const [needs, built] = ({ http: [names.map((n) => projectDir(dir, n)), "all"], stages: [names.map((n) => projectDir(dir, n)), "all"], floor: [[SRC_FILE(dir), SHORT_FILE(dir)], "floor"], "floor-hw": [[SRC_FILE(dir), SHORT_FILE(dir)], "floor"],
  "floor-gop": [[SHORT_FILE(dir)], "floor"], "floor-proxy": [[SRC_FILE(dir), SHORT_FILE(dir), GOP_PROXY_FILE(dir), INTRA_PROXY_FILE(dir)], "floor, then proxy"] } as Record<string, [string[], string]>)[mode];
const missing = needs.filter((f) => !existsSync(f));
if (missing.length) throw new Error(`${missing.join(", ")} missing: build with bun tests/scrub-fixtures.ts ${dir} (part: ${built})`);
const AC = fileURLToPath(new URL("../scripts/ac", import.meta.url));
const N = 40, SCALE = 0.5, WAIT_MS = 60_000; // the longest wait for the server to listen or for one response; past it the run fails and the server child is ended

mkdirSync(join(dir, "runs"), { recursive: true });
const file = join(dir, "runs", `${label}.jsonl`);
/** mulberry32: a small seeded generator, so the shuffled order is the same on every run. */
function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** The index (0..N-1) of the time each request visits, in request order. */
const PERMUTATION = (() => {
  const p = Array.from({ length: N }, (_, i) => i);
  if (ORDER === "desc") return p.reverse();
  if (ORDER === "shuffle") {
    const rnd = mulberry32(SEED);
    for (let i = N - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  }
  return p;
})();
const log = (rec: object) => appendFileSync(file, JSON.stringify({ mode, label, order: ORDER, ...(ORDER === "shuffle" ? { seed: SEED } : {}), permutation: PERMUTATION, ...rec }) + "\n");
const now = () => performance.now();
const load = () => spawnSync("uptime", { encoding: "utf8" }).stdout.trim().replace(/^.*load averages?: /, "");
const r1 = (x: number) => Math.round(x * 10) / 10;
const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.ceil(p * xs.length) - 1];
const stat = (xs: number[]) => ({ p50: r1(q(xs, 0.5)), p95: r1(q(xs, 0.95)), max: r1(Math.max(...xs)), mean: r1(xs.reduce((a, b) => a + b, 0) / xs.length) });
const spread = (T: number) => PERMUTATION.map((i) => ((i + 0.5) * T) / N);
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
        const line = String(d).split("\n")[0];
        let first: { url?: unknown; error?: { code?: string; message?: string } } | undefined;
        try { first = JSON.parse(line); } catch { /* not JSON: reported below with the raw line */ }
        if (typeof first?.url === "string") ok(first.url);
        else fail(new Error(first?.error ? `ui refused to start: ${first.error.code}: ${first.error.message}` : `ui printed no url on its first line: ${line.slice(0, 200)}`));
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
    return { t: Number(t.toFixed(4)), whole, setup, construct, decode, composite, encode, close, unattributed: whole - (setup + construct + decode + composite + encode + close) };
  };
  const cold = await once(T / 2);
  const rows: (typeof cold)[] = [];
  for (const t of spread(T)) rows.push(await once(t));
  const keys = ["whole", "setup", "construct", "decode", "composite", "encode", "close", "unattributed"] as const;
  const per = Object.fromEntries(keys.map((k) => [k, stat(rows.map((x) => x[k]))])) as Record<(typeof keys)[number], ReturnType<typeof stat>>;
  const rounded = (x: typeof cold) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === "t" ? v : r1(v)]));
  log({ name, duration: T, cold: rounded(cold), stages: per, samples: rows.map(rounded), load_before: loadBefore, load_after: load() });
  console.log(`  ${name}: load ${loadBefore} -> ${load()}`);
  for (const k of keys) console.log(`    ${k.padEnd(13)} ${show(per[k])}  mean ${per[k].mean}`);
}

function floor() {
  for (const [name, f] of [["src", SRC_FILE(dir)], ["short", SHORT_FILE(dir)]] as const) {
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

type Req = { id: string; file: string; t: number; hw?: boolean; extra?: Record<string, unknown> };
/** The floor line; `level` verbose is the untimed probe (banner off). */
const ffline = (f: string, t: number, hw: boolean, level: "error" | "verbose", digits: number) => ["-v", level, ...(level === "error" ? [] : ["-hide_banner"]), ...(hw ? ["-hwaccel", "videotoolbox"] : []),
  "-ss", t.toFixed(digits), "-i", f, "-frames:v", "1", "-an", "-f", "null", "-"];

/** Runs the requests of each time point back to back, the first one rotating with the point's index, so load drift reaches every variant alike.
 *  Any non-zero exit or any stderr byte fails the pass (a hardware start that fails must not time as a software decode). */
function interleaved(points: Req[][], digits = 4) {
  const rows = new Map<string, Record<string, unknown>[]>(), first = new Map<string, Req>(), trace: { i: number; load: string }[] = [], before = load();
  points.forEach((pt, i) => {
    if (i % 10 === 0) trace.push({ i, load: load() });
    for (let j = 0; j < pt.length; j++) {
      const r = pt[(j + i) % pt.length];
      const a = now(), p = spawnSync("ffmpeg", ffline(r.file, r.t, !!r.hw, "error", digits), { encoding: "utf8" }), ms = now() - a;
      if (p.status !== 0 || p.stderr) throw new Error(`ffmpeg ${r.id} t=${r.t}: exit ${p.status}${p.error ? ` (${p.error.message})` : ""}: ${p.stderr}`);
      if (!rows.has(r.id)) { rows.set(r.id, []); first.set(r.id, r); }
      rows.get(r.id)!.push({ i, t: Number(r.t.toFixed(digits)), ms: r1(ms), status: p.status, ...r.extra });
    }
  });
  return { rows, first, trace, before, after: load() };
}

/** One jsonl line and one summary line per variant. */
function report(res: ReturnType<typeof interleaved>, more: (id: string) => object = () => ({})) {
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0];
  const stats: Record<string, ReturnType<typeof stat>> = {};
  for (const [id, rows] of res.rows) {
    const s = (stats[id] = stat(rows.map((x) => x.ms as number))), r = res.first.get(id)!;
    log({ name: id, file: r.file, hw: !!r.hw, ffmpeg, ...s, samples: rows, load_before: res.before, load_after: res.after, load_trace: res.trace, ...more(id) });
    console.log(`  ${id.padEnd(11)} ${show(s)}  mean ${s.mean}`);
  }
  console.log(`  load ${res.before} -> ${res.after}`);
  return stats;
}

/** The hardware line must really use VideoToolbox: one untimed verbose run of each line, the hardware one must name it and the software one must not. Returns the matching line. */
function hwProof(f: string) {
  const run = (hw: boolean) => spawnSync("ffmpeg", ffline(f, 0.75, hw, "verbose", 4), { encoding: "utf8" });
  const sw = run(false), hw = run(true), line = hw.stderr.split("\n").find((l) => /videotoolbox/i.test(l));
  if (sw.status !== 0 || hw.status !== 0) throw new Error(`hardware probe on ${f}: exit software ${sw.status}, hardware ${hw.status}: ${(hw.stderr || sw.stderr).slice(-400)}`);
  if (!line) throw new Error(`hardware probe on ${f}: no verbose line names videotoolbox: ${hw.stderr.slice(-600)}`);
  if (/videotoolbox/i.test(sw.stderr)) throw new Error(`hardware probe on ${f}: the software run names videotoolbox too, so the line proves nothing: ${sw.stderr.slice(-400)}`);
  return line.trim();
}

function floorHw() {
  const files = [["src", SRC_FILE(dir)], ["short", SHORT_FILE(dir)]] as const;
  const proof = Object.fromEntries(files.map(([n, f]) => [n, hwProof(f)]));
  for (const [n, p] of Object.entries(proof)) console.log(`  hw_proof ${n}: ${p}`);
  const s = report(interleaved(spread(60).map((t) => files.flatMap(([n, f]) => [{ id: `${n}-sw`, file: f, t }, { id: `${n}-hw`, file: f, t, hw: true }]))), (id) => (id.endsWith("-hw") ? { hw_proof: proof[id.slice(0, -3)] } : {}));
  for (const [n] of files) if (Math.abs(s[`${n}-hw`].p50 - s[`${n}-sw`].p50) < 0.02 * s[`${n}-sw`].p50) console.log(`  note: ${n} hardware p50 is within 2 % of software p50: no sign here that the decoder differed`);
}

const GOP_D = [0, 0.5, 1.0, 1.45]; // seconds after a keyframe
function floorGop() {
  const f = SHORT_FILE(dir), kf = keyframes(f);
  if (kf.length < 40) throw new Error(`${f} has ${kf.length} keyframes, expected 40`);
  // 39 keyframes, the last one left out: its +1.45 s would end within a frame of the file's end, where a missing frame exits 0 without a sign
  const points = kf.slice(0, 39).map((k0, k) => GOP_D.map((d) => {
    const t = Number((k0 + d).toFixed(6)), at = Math.max(...kf.filter((x) => x <= t + 1e-6)), next = kf.find((x) => x > t + 1e-6) ?? null;
    if (Math.abs(t - at - d) > 1e-3 || at !== k0) throw new Error(`request t=${t}: expected ${d} s after keyframe ${k0}, found ${t - at} s after ${at}`);
    return { id: `d${d.toFixed(2)}`, file: f, t, extra: { kf: at, distance_s: Number((t - at).toFixed(4)), next_kf: next } };
  }));
  report(interleaved(points, 6));
}

function floorProxy() {
  const files = [["src", SRC_FILE(dir)], ["short", SHORT_FILE(dir)], ["p540-gop", GOP_PROXY_FILE(dir)], ["p540-intra", INTRA_PROXY_FILE(dir)]] as const;
  report(interleaved(spread(60).map((t) => files.map(([n, f]) => ({ id: n, file: f, t })))));
}

console.log(`${mode} ${label}: load ${load()}`);
const t0 = now();
if (mode === "floor") floor();
else if (mode === "floor-hw") floorHw();
else if (mode === "floor-gop") floorGop();
else if (mode === "floor-proxy") floorProxy();
else for (const n of names) await (mode === "http" ? http(n) : stages(n));
console.log(`${mode} ${label}: ${r1((now() - t0) / 1000)} s, load ${load()}`);
