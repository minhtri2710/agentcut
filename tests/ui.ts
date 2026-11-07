// Web UI + project concurrency: revision conflicts across processes, no lost edits under parallel writers, HTTP endpoints,
// SSE live sync for edits made by another process, path-traversal / host guards.
// Run: bun tests/ui.ts            (needs ffmpeg on PATH)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = [process.execPath, resolve(import.meta.dir, "../src/cli.ts")];
let failures = 0;
const check = (name: string, cond: unknown, info?: unknown) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); }
};
const cliAsync = (args: (string | number)[]) => new Promise<any>((ok) => {
  const ch = spawn(CLI[0], [...CLI.slice(1), ...args.map(String)]);
  let out = "";
  ch.stdout.on("data", (c) => (out += c));
  ch.on("close", () => { try { ok(JSON.parse(out)); } catch { ok({ ok: false, raw: out }); } });
});

const tmp = mkdtempSync(join(tmpdir(), "agentcut-ui-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
mkdirSync(join(tmp, "cache", "models", "u2netp"), { recursive: true }); writeFileSync(join(tmp, "cache", "models", "u2netp", "u2netp.onnx"), ""); // the default matte model is cached
const api = await import("../src/api.ts");
const { startUi } = await import("../src/ui.ts");
const dir = join(tmp, "proj"), media = join(tmp, "media");
mkdirSync(media);
const ff = (...a: string[]) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a]); if (r.status) throw new Error(String(r.stderr)); };
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", join(media, "a.mp4"));
ff("-f", "lavfi", "-i", "mandelbrot=size=320x240", "-frames:v", "1", join(media, "p.jpg"));
api.create(dir, { preset: "square" });
await api.apply(dir, [
  { op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 2 },
  { op: "add_clip", track: "main", src: join(media, "p.jpg"), duration: 1, transition: "crossfade" },
  { op: "add_clip", track: "text", text: "Hi", attach_to: "main#0", offset: 0.2, duration: 1 },
]);

// ---------------------------------------------------------------- concurrency across processes
console.log("concurrency");
const r0 = api.info(dir).revision as number;
const stale = await cliAsync(["-p", dir, "op", "add_marker", "t=1", `--revision`, r0 - 1]);
check("stale --revision from another process -> conflict", stale.ok === false && stale.error.code === "conflict" && stale.error.revision === r0, stale);
check("conflict changed nothing", api.info(dir).revision === r0);
const N = 6;
const par = await Promise.all(Array.from({ length: N }, (_, i) => cliAsync(["-p", dir, "op", "add_marker", `t=${i + 1}`, `label=m${i}`])));
const tl = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const labels = new Set(tl.markers.map((m: any) => m.label));
check(`${N} parallel writers: every edit kept`, par.every((x) => x.ok) && Array.from({ length: N }, (_, i) => `m${i}`).every((l) => labels.has(l)), { par, markers: tl.markers });
check("revision advanced once per write", tl.revision === r0 + N, tl.revision);
const und = await cliAsync(["-p", dir, "undo", "--revision", r0]);
check("stale undo -> conflict", und.ok === false && und.error.code === "conflict", und);

// ---------------------------------------------------------------- HTTP server
console.log("server");
const ui = await startUi(dir, { port: 0 });
const base = ui.url.replace(/\/$/, "");
const raw = (path: string, o: { method?: string; host?: string; body?: unknown } = {}) => new Promise<{ status: number; body: Buffer; type: string }>((ok, fail) => {
  const rq = request({ host: "127.0.0.1", port: ui.port, path, method: o.method ?? "GET",
    headers: { host: o.host ?? `127.0.0.1:${ui.port}`, ...(o.body ? { "content-type": "application/json" } : {}) } }, (res) => {
    const ch: Buffer[] = [];
    res.on("data", (c) => ch.push(c));
    res.on("end", () => ok({ status: res.statusCode!, body: Buffer.concat(ch), type: String(res.headers["content-type"]) }));
  });
  rq.on("error", fail);
  rq.end(o.body ? JSON.stringify(o.body) : undefined);
});
const jget = async (path: string, o?: any) => { const r = await raw(path, o); return { status: r.status, j: JSON.parse(r.body.toString()) }; };

check("bound to 127.0.0.1", ui.url.startsWith("http://127.0.0.1:"));
const page = await raw("/");
check("page served", page.status === 200 && page.body.toString().includes("EventSource"));
const st = await jget("/api/state");
check("state has timeline + revision + history", st.j.ok && st.j.revision === r0 + N && st.j.timeline.tracks.length > 0 && Array.isArray(st.j.history.undo), st.j);
const vid = st.j.timeline.tracks.find((t: any) => t.id === "main").clips[0];
const fr = await raw("/api/frame?t=0.5&scale=0.25");
check("frame is a JPEG", fr.status === 200 && fr.type === "image/jpeg" && fr.body[0] === 0xff && fr.body[1] === 0xd8);
const th = await raw(`/api/thumb/${vid.asset}?t=0.5`);
check("video thumbnail", th.status === 200 && th.body[0] === 0xff && th.body[1] === 0xd8);
const md = await raw(`/media/${vid.asset}`);
check("project asset served", md.status === 200 && md.type === "video/mp4" && md.body.length > 1000);

// SSE: read the event stream and wait for a given revision
const events: any[] = [];
const ctl = new AbortController();
const sse = await fetch(base + "/api/events", { signal: ctl.signal });
(async () => {
  const rd = sse.body!.getReader(); let buf = "";
  try {
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += new TextDecoder().decode(value);
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const blk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(blk)?.[1], data = /^data: (.*)$/m.exec(blk)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
      }
    }
  } catch { /* aborted */ }
})();
const waitRev = async (rev: number) => {
  for (let i = 0; i < 100; i++) { if (events.some((e) => e.event === "state" && e.data.revision === rev)) return true; await Bun.sleep(50); }
  return false;
};
check("SSE sends the current state on connect", await waitRev(r0 + N));

const ap = await jget("/api/ops", { method: "POST", body: { ops: [{ op: "update_clip", id: vid.id, set: { opacity: 0.5 } }], revision: r0 + N } });
check("op via HTTP applied", ap.status === 200 && ap.j.ok && ap.j.revision === r0 + N + 1, ap.j);
check("SSE pushed the HTTP edit", await waitRev(r0 + N + 1));
const cf = await jget("/api/ops", { method: "POST", body: { ops: [{ op: "update_clip", id: vid.id, set: { opacity: 0.2 } }], revision: r0 } });
check("stale page edit -> 409 conflict with hint", cf.status === 409 && cf.j.error.code === "conflict" && /reload/.test(cf.j.error.hint), cf.j);
const bad = await jget("/api/ops", { method: "POST", body: { ops: [{ op: "update_clip", id: vid.id, set: { opacity: "lots" } }] } });
check("invalid batch rejected with issues", bad.status === 422 && bad.j.error.code === "validation_failed" && bad.j.error.issues?.length, bad.j);

const ext = await cliAsync(["-p", dir, "op", "add_marker", "t=2.5", "label=agent"]);
check("SSE pushed an edit made by another process", ext.ok && await waitRev(ext.revision), ext);
const pushed = events.findLast((e) => e.event === "state").data;
check("pushed state contains the agent's marker", pushed.timeline.markers.some((m: any) => m.label === "agent"));

const un = await jget("/api/undo", { method: "POST", body: { revision: ext.revision } });
check("undo via HTTP", un.status === 200 && un.j.undone?.length === 1 && un.j.revision === ext.revision + 1, un.j);

// ---------------------------------------------------------------- guards
console.log("guards");
for (const p of ["/files/../project.json", "/files/renders/../../project.json", "/files/%2e%2e/project.json", "/media/..%2f..%2fetc%2fpasswd"]) {
  const r = await raw(p);
  check(`traversal rejected: ${p}`, r.status === 403 || r.status === 404, r.status);
  check(`  no project.json leaked`, !r.body.toString().includes('"tracks"'));
}
check("project.json outside renders/previews refused", (await raw("/files/project.json")).status === 403);
check("unknown asset id -> 404", (await raw("/media/nope")).status === 404);
check("foreign Host header refused (DNS rebinding)", (await raw("/api/state", { host: "evil.example:80" })).status === 403);
const xo = await new Promise<number>((ok) => {
  const rq = request({ host: "127.0.0.1", port: ui.port, path: "/api/ops", method: "POST",
    headers: { host: `127.0.0.1:${ui.port}`, origin: "http://evil.example", "content-type": "application/json" } }, (res) => { res.resume(); ok(res.statusCode!); });
  rq.end(JSON.stringify({ ops: [] }));
});
check("cross-origin POST refused", xo === 403);

// ---------------------------------------------------------------- render job
console.log("render");
const job = (await jget("/api/render", { method: "POST", body: { play: true, start: 0, end: 1 } })).j;
let done: any = null;
for (let i = 0; i < 300 && !done; i++) { const s = (await jget(`/api/jobs/${job.id}`)).j; if (s.status !== "running") done = s; else await Bun.sleep(100); }
check("play render finishes", done?.status === "done" && typeof done.url === "string", done);
const vid2 = done?.url ? await raw(done.url) : null;
check("rendered preview served from previews/", vid2?.status === 200 && vid2.type === "video/mp4" && vid2.body.length > 1000);
check("SSE reported the job", events.some((e) => e.event === "job" && e.data.id === job.id && e.data.status === "done"));

// ---------------------------------------------------------------- not_prepared: hint + prepare job
console.log("prepare");
const fake = join(tmp, "fake-uv.mjs");
writeFileSync(fake, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const job = JSON.parse(process.argv.at(-1));
const vf = "scale=" + job.w + ":" + job.h + ",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,W/2),0,255)'";
const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", job.path, "-an", "-vf", vf, "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-f", "mov", job.out], { encoding: "utf8" });
if (r.status) { process.stderr.write(r.stderr); process.exit(1); }
process.stdout.write(JSON.stringify({ out: job.out, frames: 1 }));
`);
chmodSync(fake, 0o755);
process.env.AGENTCUT_UV = fake;
await api.apply(dir, [{ op: "remove_background", id: vid.id }]);
const np = await jget("/api/frame?t=0.5&scale=0.25");
check("frame of an unprepared project -> 422 not_prepared with hint", np.status === 422 && np.j.error.code === "not_prepared" && /prepare/.test(np.j.error.hint), np);
check("page offers the Prepare action for not_prepared", page.body.toString().includes("/api/prepare"));
const pj = (await jget("/api/prepare", { method: "POST", body: {} })).j;
const pj2 = (await jget("/api/prepare", { method: "POST", body: {} })).j;
check("prepare starts a job; a second request joins it", pj.ok && pj.kind === "prepare" && pj2.id === pj.id, [pj, pj2]);
let pdone: any = null;
for (let i = 0; i < 300 && !pdone; i++) { const s = (await jget(`/api/jobs/${pj.id}`)).j; if (s.status !== "running") pdone = s; else await Bun.sleep(100); }
check("prepare job finishes done with the result", pdone?.status === "done" && pdone.result?.ready === true, pdone);
check("SSE reported the prepare job", events.some((e) => e.event === "job" && e.data.id === pj.id && e.data.status === "done"));
const after = await raw("/api/frame?t=0.5&scale=0.25");
check("frame succeeds after prepare", after.status === 200 && after.type === "image/jpeg", after.body.toString().slice(0, 200));

// a prepare that fails before it starts (project.json gone) lands in the job and frees the slot
const pf = join(dir, "project.json"), pfAway = join(dir, "project.json.away");
renameSync(pf, pfAway);
const fj = (await jget("/api/prepare", { method: "POST", body: {} })).j;
let fdone: any = null;
for (let i = 0; i < 100 && !fdone; i++) { const s = (await jget(`/api/jobs/${fj.id}`)).j; if (s.status !== "running") fdone = s; else await Bun.sleep(50); }
const fj2 = (await jget("/api/prepare", { method: "POST", body: {} })).j;
renameSync(pfAway, pf);
check("prepare that throws at once: the job fails with no_project", fj.kind === "prepare" && fdone?.status === "failed" && fdone.error?.code === "no_project", { fj, fdone });
check("  the slot is free: the next request is a new job", !!fj.id && fj2.kind === "prepare" && fj2.id !== fj.id, { fj, fj2 });

ctl.abort();
ui.server.closeAllConnections?.();
await new Promise((ok) => ui.server.close(ok));
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall ui checks passed");
process.exit(failures ? 1 : 0);
