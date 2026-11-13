// Web UI + project concurrency: revision conflicts across processes, no lost edits under parallel writers, HTTP endpoints,
// SSE live sync for edits made by another process, path-traversal / host guards.
// Run: bun tests/ui.ts            (needs ffmpeg on PATH)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
const r0 = (await api.info(dir)).revision as number;
const stale = await cliAsync(["-p", dir, "op", "add_marker", "t=1", `--revision`, r0 - 1]);
check("stale --revision from another process -> conflict", stale.ok === false && stale.error.code === "conflict" && stale.error.revision === r0, stale);
check("conflict changed nothing", (await api.info(dir)).revision === r0);
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
// `text` is a raw JSON body (possibly empty or malformed); `port` aims at another ui server
const raw = (path: string, o: { method?: string; host?: string; body?: unknown; text?: string; port?: number; origin?: string } = {}) => new Promise<{ status: number; body: Buffer; type: string; headers: Record<string, unknown> }>((ok, fail) => {
  const port = o.port ?? ui.port;
  const rq = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET",
    headers: { host: o.host ?? `127.0.0.1:${port}`, ...(o.origin ? { origin: o.origin } : {}), ...(o.body || o.text !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
    const ch: Buffer[] = [];
    res.on("data", (c) => ch.push(c));
    res.on("end", () => ok({ status: res.statusCode!, body: Buffer.concat(ch), type: String(res.headers["content-type"]), headers: res.headers }));
  });
  rq.on("error", fail);
  rq.end(o.text ?? (o.body ? JSON.stringify(o.body) : undefined));
});
const jget = async (path: string, o?: any) => { const r = await raw(path, o); return { status: r.status, j: JSON.parse(r.body.toString()) }; };

check("bound to 127.0.0.1", ui.url.startsWith("http://127.0.0.1:"));
const page = await raw("/");
check("page served", page.status === 200 && page.body.toString().includes("EventSource"));
const st0 = await raw("/api/state");
const st = await jget("/api/state");
check("state has timeline + revision + history", st.j.ok && st.j.revision === r0 + N && st.j.timeline.tracks.length > 0 && Array.isArray(st.j.history.undo), st.j);
const vid = st.j.timeline.tracks.find((t: any) => t.id === "main").clips[0];
const fr = await raw("/api/frame?t=0.5&scale=0.25");
check("frame is a JPEG", fr.status === 200 && fr.type === "image/jpeg" && fr.body[0] === 0xff && fr.body[1] === 0xd8);
const late = await raw(`/api/frame?t=${st.j.duration}&scale=0.25`);
check("a frame time at the duration is refused as bad_value", late.status >= 400 && late.status < 500 && late.type === "application/json" && JSON.parse(late.body.toString()).error.code === "bad_value", late.status);
check("every response carries nosniff and a framing restriction", [page, st0, fr].every((r) => r.headers["x-content-type-options"] === "nosniff" && r.headers["x-frame-options"] === "DENY" && String(r.headers["content-security-policy"]).includes("frame-ancestors 'none'")), [page, st0, fr].map((r) => r.headers));
const th = await raw(`/api/thumb/${vid.asset}?t=0.5`);
check("video thumbnail", th.status === 200 && th.body[0] === 0xff && th.body[1] === 0xd8);
{ // a thumbnail ffmpeg cannot make is an error response that is not cached, never an empty 200
  const srcAbs = resolve(dir, st.j.timeline.assets[vid.asset].path), away = srcAbs + ".away";
  renameSync(srcAbs, away);
  const bt = await raw(`/api/thumb/${vid.asset}?t=2.5`);
  renameSync(away, srcAbs);
  check("failed thumbnail -> error status, no long cache", bt.status >= 400 && !String(bt.headers["cache-control"]).includes("max-age"), [bt.status, bt.headers["cache-control"], bt.body.length]);
}
{ // the file behind an asset changes (replaced in place): the next thumbnail is the new picture, and none is cached by the browser
  const srcAbs = resolve(dir, st.j.timeline.assets[vid.asset].path), keep = srcAbs + ".keep";
  const first = await raw(`/api/thumb/${vid.asset}?t=0.5`);
  renameSync(srcAbs, keep);
  ff("-f", "lavfi", "-i", "color=c=red:size=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", srcAbs);
  const second = await raw(`/api/thumb/${vid.asset}?t=0.5`);
  rmSync(srcAbs); renameSync(keep, srcAbs);
  check("a thumbnail follows the file: replaced in place -> a new picture, header no-cache", second.status === 200 && !second.body.equals(first.body) && second.headers["cache-control"] === "no-cache" && first.headers["cache-control"] === "no-cache", [first.status, second.status, first.headers["cache-control"], second.headers["cache-control"]]);
}
{ // a replacement whose mtime was set back to the old value is still a new picture: the key also holds the size
  const srcAbs = resolve(dir, st.j.timeline.assets[vid.asset].path), keep = srcAbs + ".keep", was = statSync(srcAbs);
  const first = await raw(`/api/thumb/${vid.asset}?t=0.5`);
  renameSync(srcAbs, keep);
  ff("-f", "lavfi", "-i", "color=c=blue:size=320x180:rate=30:duration=1", "-pix_fmt", "yuv420p", srcAbs);
  utimesSync(srcAbs, was.atimeMs / 1000, was.mtimeMs / 1000);
  const sameMtime = statSync(srcAbs).mtimeMs === was.mtimeMs && statSync(srcAbs).size !== was.size;
  const second = await raw(`/api/thumb/${vid.asset}?t=0.5`);
  rmSync(srcAbs); renameSync(keep, srcAbs);
  check("a thumbnail follows the file: a replacement of another size with the old mtime -> a new picture", sameMtime && second.status === 200 && !second.body.equals(first.body), [sameMtime, first.status, second.status]);
}
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
// SSE events arrive after the HTTP answer that caused them: wait for one, bounded to 5 s
const waitEvent = async (match: (e: any) => boolean) => {
  for (let i = 0; i < 100; i++) { if (events.some(match)) return true; await Bun.sleep(50); }
  return false;
};
const waitRev = (rev: number) => waitEvent((e) => e.event === "state" && e.data.revision === rev);
const waitJob = (id: string) => waitEvent((e) => e.event === "job" && e.data.id === id && e.data.status === "done");
check("SSE sends the current state on connect", await waitRev(r0 + N));

const ap = await jget("/api/ops", { method: "POST", body: { ops: [{ op: "update_clip", id: vid.id, set: { opacity: 0.5 } }], revision: r0 + N } });
check("op via HTTP applied", ap.status === 200 && ap.j.ok && ap.j.revision === r0 + N + 1, ap.j);
check("SSE pushed the HTTP edit", await waitRev(r0 + N + 1));
const cf = await jget("/api/ops", { method: "POST", body: { ops: [{ op: "update_clip", id: vid.id, set: { opacity: 0.2 } }], revision: r0 } });
check("stale page edit -> 409 conflict with hint", cf.status === 409 && cf.j.error.code === "conflict" && /reload/.test(cf.j.error.hint), cf.j);
const bad = await jget("/api/ops", { method: "POST", body: { ops: [{ op: "update_clip", id: vid.id, set: { opacity: "lots" } }] } });
check("invalid batch rejected with issues", bad.status === 422 && bad.j.error.code === "validation_failed" && bad.j.error.issues?.length, bad.j);

for (const [what, text, code] of [["{}", "{}", "bad_request"], ["[]", "[]", "bad_json"], ["an ops value that is not a list", '{"ops":"add_marker"}', "bad_request"]] as const) {
  const r = await jget("/api/ops", { method: "POST", text });
  check(`/api/ops with ${what}: 400 ${code}`, r.status === 400 && r.j.ok === false && r.j.error.code === code, r);
}
const histBefore = (await jget("/api/state")).j;
const arrUndo = await jget("/api/undo", { method: "POST", text: "[]" });
const histAfter = (await jget("/api/state")).j;
check("/api/undo with []: 400 bad_json, and the history is unchanged", arrUndo.status === 400 && arrUndo.j.error.code === "bad_json" && histAfter.revision === histBefore.revision && JSON.stringify(histAfter.timeline) === JSON.stringify(histBefore.timeline), { arrUndo, before: histBefore.revision, after: histAfter.revision });
for (const [path, body] of [["/api/ops", { ops: [{ op: "add_marker", t: 1 }], revision: "abc" }], ["/api/undo", { revision: "abc" }], ["/api/ops", { ops: [{ op: "add_marker", t: 1 }], revision: String(r0) }]] as const) {
  const r = await jget(path, { method: "POST", body });
  check(`${path} with revision ${JSON.stringify(body.revision)}: bad_revision that echoes the value as sent`, r.status === 400 && r.j.error.code === "bad_revision" && r.j.error.message.includes(`got ${JSON.stringify(body.revision)}`), r);
}

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
// a 3-byte character split across two request writes; the rejected op echoes its name back, so no revision moves
const split = await new Promise<string>((ok) => {
  const body = Buffer.from(JSON.stringify({ ops: [{ op: "nope_ệ" }] })), cut = body.indexOf(Buffer.from("ệ")) + 1;
  const rq = request({ host: "127.0.0.1", port: ui.port, path: "/api/ops", method: "POST", headers: { host: `127.0.0.1:${ui.port}`, "content-type": "application/json" } }, (res) => {
    const ch: Buffer[] = []; res.on("data", (c) => ch.push(c)); res.on("end", () => ok(Buffer.concat(ch).toString("utf8")));
  });
  rq.write(body.subarray(0, cut));
  setTimeout(() => rq.end(body.subarray(cut)), 300);
});
check("POST body keeps multi-byte text whole across chunks", split.includes("nope_ệ") && !split.includes("\uFFFD"), split.slice(0, 300));

// ---------------------------------------------------------------- render job
console.log("render");
const job = (await jget("/api/render", { method: "POST", body: { play: true, start: 0, end: 1 } })).j;
let done: any = null;
for (let i = 0; i < 300 && !done; i++) { const s = (await jget(`/api/jobs/${job.id}`)).j; if (s.status !== "running") done = s; else await Bun.sleep(100); }
check("play render finishes", done?.status === "done" && typeof done.url === "string", done);
const vid2 = done?.url ? await raw(done.url) : null;
check("rendered preview served from previews/", vid2?.status === 200 && vid2.type === "video/mp4" && vid2.body.length > 1000);
const lsDir = await raw("/files/previews/ui");
check("a directory under previews/ answers 404 and the server keeps serving", lsDir.status === 404 && (await raw("/api/state")).status === 200, lsDir.status);
check("SSE reported the job", await waitJob(job.id));

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
check("SSE reported the prepare job", await waitJob(pj.id));
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

// download consent: only a literal allow_download=true reaches the helper; without it the job fails with the model list and nothing runs
console.log("prepare consent");
{
  const log = join(tmp, "consent-uv.log"), capture = join(tmp, "consent-uv.mjs");
  writeFileSync(capture, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, process.argv.at(-1) + "\\n");
process.stderr.write("stopped before any fetch");
process.exit(1);
`);
  chmodSync(capture, 0o755);
  process.env.AGENTCUT_UV = capture;
  const dirC = join(tmp, "consent");
  api.create(dirC, { preset: "square" });
  await api.apply(dirC, [{ op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 1 }]);
  const cid = JSON.parse(readFileSync(join(dirC, "project.json"), "utf8")).tracks.find((t: any) => t.id === "main").clips[0].id;
  await api.apply(dirC, [{ op: "remove_background", id: cid, model: "u2net_human_seg" }]);
  const uc = await startUi(dirC, { port: 0 });
  const prep = async (o: { text?: string; origin?: string }) => {
    const r = await jget("/api/prepare", { method: "POST", port: uc.port, ...o });
    if (r.status !== 200) return r;
    for (let i = 0; i < 300; i++) { const s = (await jget(`/api/jobs/${r.j.id}`, { port: uc.port })).j; if (s.status !== "running") return { status: 200, j: s }; await Bun.sleep(50); }
    return r;
  };
  const runs = () => { try { return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  for (const [what, text] of [["no body", ""], ["{}", "{}"], ['"true" (a string)', '{"allow_download":"true"}'], ["1", '{"allow_download":1}'], ["false", '{"allow_download":false}']] as const) {
    const r = await prep({ text });
    check(`prepare with allow_download ${what}: model_not_cached with the model list, the helper never runs`,
      r.j.status === "failed" && r.j.error?.code === "model_not_cached" && r.j.error.models?.[0]?.model === "u2net_human_seg" && r.j.error.models[0].approx_mb === 176 && runs().length === 0, r);
  }
  const bad = await prep({ text: '{"allow_download":tru' });
  check("a malformed body is refused and nothing runs", bad.status === 400 && runs().length === 0, bad);
  const xo2 = await jget("/api/prepare", { method: "POST", port: uc.port, text: '{"allow_download":true}', origin: "http://evil.example" });
  check("cross-origin prepare with the flag -> 403, nothing runs", xo2.status === 403 && runs().length === 0, xo2);
  const yes = await prep({ text: '{"allow_download":true}' });
  const seen = runs();
  check("allow_download true reaches the helper once, as allow_download", seen.length === 1 && seen[0].allow_download === true && yes.j.status === "failed" && yes.j.error?.code !== "model_not_cached", { seen, yes });
  uc.server.closeAllConnections?.();
  await new Promise((ok) => uc.server.close(ok));
}

// ---------------------------------------------------------------- cancel a job
console.log("cancel");
{
  const big = join(media, "big.mp4");
  ff("-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30:duration=6", "-pix_fmt", "yuv420p", big);
  const dirK = join(tmp, "cancel");
  api.create(dirK, { preset: "4k" });
  await api.apply(dirK, [{ op: "add_clip", track: "main", src: big, at: 0, duration: 5.9 }]);
  const uk = await startUi(dirK, { port: 0 });
  const R = join(dirK, "renders"), left = () => (existsSync(R) ? readdirSync(R) : []);
  const events: any[] = [];
  const sse = request({ host: "127.0.0.1", port: uk.port, path: "/api/events", headers: { host: `127.0.0.1:${uk.port}` } }, (res) => {
    let buf = "";
    res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const m = /^event: (\w+)\ndata: (.*)$/s.exec(buf.slice(0, i)); buf = buf.slice(i + 2); if (m) events.push({ event: m[1], data: JSON.parse(m[2]) }); } });
  });
  sse.end();
  const poll = async (cond: () => unknown) => { for (let i = 0; i < 600 && !cond(); i++) await Bun.sleep(50); return !!cond(); };
  const j = (await jget("/api/render", { method: "POST", port: uk.port, body: {} })).j;
  const working = await poll(() => left().some((f) => f.includes(".part-")));
  const xo = await jget(`/api/jobs/${j.id}/cancel`, { method: "POST", port: uk.port, body: {}, origin: "http://evil.example" });
  const still = (await jget(`/api/jobs/${j.id}`, { port: uk.port })).j;
  check("cancel from another origin: 403, and the job keeps running", working && xo.status === 403 && still.status === "running", { working, xo, still });
  const c = await jget(`/api/jobs/${j.id}/cancel`, { method: "POST", port: uk.port, body: {} });
  const after = (await jget(`/api/jobs/${j.id}`, { port: uk.port })).j;
  check("POST /api/jobs/<id>/cancel stops the render: status cancelled with code aborted, and renders/ is empty when it replies", c.status === 200 && c.j.status === "cancelled" && c.j.error?.code === "aborted" && after.status === "cancelled" && !left().length, { c, after, left: left() });
  check("  the new status was pushed over SSE", await poll(() => events.some((e) => e.event === "job" && e.data.id === j.id && e.data.status === "cancelled")), events.filter((e) => e.event === "job").map((e) => e.data.status));
  const none = await jget("/api/jobs/nope/cancel", { method: "POST", port: uk.port, body: {} });
  const twice = await jget(`/api/jobs/${j.id}/cancel`, { method: "POST", port: uk.port, body: {} });
  check("cancel of an unknown job: 404; of a cancelled job: unchanged", none.status === 404 && twice.status === 200 && twice.j.status === "cancelled", { none, twice });
  // a play job asked for twice is one job: cancelling it stops it for both requests
  const p1 = (await jget("/api/render", { method: "POST", port: uk.port, body: { play: true, start: 0, end: 5 } })).j;
  const p2 = (await jget("/api/render", { method: "POST", port: uk.port, body: { play: true, start: 0, end: 5 } })).j;
  const PV = join(dirK, "previews", "ui"), played = () => (existsSync(PV) ? readdirSync(PV) : []);
  await poll(() => played().some((f) => f.includes(".part-")));
  const pc = await jget(`/api/jobs/${p1.id}/cancel`, { method: "POST", port: uk.port, body: {} });
  const shared = (await jget(`/api/jobs/${p2.id}`, { port: uk.port })).j;
  check("a play job shared by two requests is cancelled for both", p1.id === p2.id && pc.j.status === "cancelled" && shared.status === "cancelled" && !played().length, { p1: p1.id, p2: p2.id, pc, shared });
  // a cancel takes effect until the output is written: with the loudness pass held by a stand-in ffmpeg on PATH, the cancel gives a done job with the output
  {
    const bin = join(tmp, "stub-bin"), mark = join(tmp, "stub-loud.mark"), tone = join(media, "with-audio.mp4");
    mkdirSync(bin);
    writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in\n  *ebur128*) : > ${JSON.stringify(mark)}; exec sleep 60 ;;\nesac\nexec ${JSON.stringify(spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim())} "$@"\n`);
    chmodSync(join(bin, "ffmpeg"), 0o755);
    ff("-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=2", "-f", "lavfi", "-i", "sine=d=2", "-shortest", "-pix_fmt", "yuv420p", tone);
    const dirE = join(tmp, "cancel-extras");
    api.create(dirE, { preset: "720p" });
    await api.apply(dirE, [{ op: "add_clip", track: "main", src: tone, at: 0, duration: 2 }]);
    const ue = await startUi(dirE, { port: 0 });
    const was = process.env.PATH;
    process.env.PATH = `${bin}:${was}`;
    try {
      const e = (await jget("/api/render", { method: "POST", port: ue.port, body: { draft: true } })).j;
      const held = await poll(() => existsSync(mark));
      const ec = await jget(`/api/jobs/${e.id}/cancel`, { method: "POST", port: ue.port, body: {} });
      check("UI cancel while the loudness pass runs: the job is done with its output; the loudness is skipped and marked", held && ec.status === 200 && ec.j.status === "done" && existsSync(ec.j.result?.output) && /skipped/.test(ec.j.result.loudness_error ?? "") && !ec.j.result.loudness, { held, ec });
    } finally { process.env.PATH = was; }
    ue.server.closeAllConnections?.();
    await new Promise((ok) => ue.server.close(ok));
  }
  // a play asked for again after its job was cancelled, while the old job is still stopping, is a new job (the old one reads cancelled and must not be joined);
  // a stand-in ffmpeg holds the render and takes 1 s to stop after its TERM, which it records
  {
    const bin = join(tmp, "stub-play-bin"), started = join(tmp, "stub-play.started"), termed = join(tmp, "stub-play.termed"), tone = join(media, "with-audio.mp4");
    mkdirSync(bin);
    writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in *-version*|*-hide_banner*) exec ${JSON.stringify(spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim())} "$@" ;; esac\n: > ${JSON.stringify(started)}\ntrap ': > ${termed}; kill $! 2>/dev/null; sleep 1; exit 1' TERM\nsleep 60 &\nwait $!\n`);
    chmodSync(join(bin, "ffmpeg"), 0o755);
    const dirP = join(tmp, "cancel-play-again");
    api.create(dirP, { preset: "720p" });
    await api.apply(dirP, [{ op: "add_clip", track: "main", src: tone, at: 0, duration: 2 }]);
    const up = await startUi(dirP, { port: 0 });
    const was = process.env.PATH;
    process.env.PATH = `${bin}:${was}`;
    const play = async () => (await jget("/api/render", { method: "POST", port: up.port, body: { play: true, start: 0, end: 1 } })).j;
    const status = async (id: string) => (await jget(`/api/jobs/${id}`, { port: up.port })).j.status;
    try {
      const old = await play();
      const held = await poll(() => existsSync(started));
      const cancelling = jget(`/api/jobs/${old.id}/cancel`, { method: "POST", port: up.port, body: {} }); // answers once the old job has stopped
      const stopping = await poll(() => existsSync(termed));
      const again = await play(), stillRunning = await status(old.id);
      const joined = await play();
      await cancelling;
      const fourth = await play();
      check("a play asked for again while its cancelled job is still stopping is a new job; later requests join the new job, also after the old one has ended",
        held && stopping && stillRunning === "running" && again.id !== old.id && joined.id === again.id && fourth.id === again.id, { held, stopping, stillRunning, old: old.id, again: again.id, joined: joined.id, fourth: fourth.id });
      await jget(`/api/jobs/${again.id}/cancel`, { method: "POST", port: up.port, body: {} });
    } finally { process.env.PATH = was; }
    up.server.closeAllConnections?.();
    await new Promise((ok) => up.server.close(ok));
  }
  // a cancel of a job that already failed replies ok:false (HTTP 200), as MCP cancel_job does
  {
    const gone = join(media, "gone.mp4"), dirF = join(tmp, "cancel-failed");
    writeFileSync(gone, readFileSync(join(media, "a.mp4")));
    api.create(dirF, { preset: "720p" });
    await api.apply(dirF, [{ op: "add_clip", track: "main", src: gone, at: 0, duration: 1 }]);
    rmSync(gone);
    const uf = await startUi(dirF, { port: 0 });
    const f = (await jget("/api/render", { method: "POST", port: uf.port, body: {} })).j;
    const state = async () => (await jget(`/api/jobs/${f.id}`, { port: uf.port })).j.status;
    for (let i = 0; i < 200 && (await state()) === "running"; i++) await Bun.sleep(50);
    const failed = (await state()) === "failed";
    const fc = await jget(`/api/jobs/${f.id}/cancel`, { method: "POST", port: uf.port, body: {} });
    check("UI cancel of a job that already failed: HTTP 200, ok false, status failed", failed && fc.status === 200 && fc.j.ok === false && fc.j.status === "failed", { failed, fc });
    uf.server.closeAllConnections?.();
    await new Promise((ok) => uf.server.close(ok));
  }
  const UNDO = join(dirK, ".agentcut", "history", "undo"), undoCount = () => (existsSync(UNDO) ? readdirSync(UNDO).length : 0);
  const [rev0, undo0] = [api.openProject(dirK).load().revision, undoCount()];
  const emptyOps = await jget("/api/ops", { method: "POST", port: uk.port, body: { ops: [] } });
  check("/api/ops with an empty list answers 200 with the same revision, applies no op and adds no undo entry", emptyOps.status === 200 && emptyOps.j.ok === true && emptyOps.j.results.length === 0 && emptyOps.j.revision === rev0 && api.openProject(dirK).load().revision === rev0 && undoCount() === undo0, { emptyOps, rev0, undo0 });
  sse.destroy();
  uk.server.closeAllConnections?.();
  await new Promise((ok) => uk.server.close(ok));
}

// an apply stops with its request: when the browser closes the connection during an analysis, the tool it runs is stopped and nothing is saved
if (process.platform !== "win32") {
  const dirA = join(tmp, "abort-apply"), binA = join(tmp, "bin-abort"), pidFile = join(tmp, "abort.pid"); // the stand-in piper records its pid and waits
  mkdirSync(binA);
  writeFileSync(join(binA, "piper"), `#!/bin/sh\necho $$ > '${pidFile}'; exec sleep 60\n`, { mode: 0o755 });
  api.create(dirA, { preset: "square" });
  const before = readFileSync(join(dirA, "project.json"), "utf8");
  const ua = await startUi(dirA, { port: 0 });
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const was = { PATH: process.env.PATH, AGENTCUT_PIPER_MODEL: process.env.AGENTCUT_PIPER_MODEL };
  process.env.PATH = `${binA}:${was.PATH}`;
  process.env.AGENTCUT_PIPER_MODEL = join(media, "p.jpg");
  let pid = 0, aliveBefore = false, stopped = false;
  try {
    const rq = request({ host: "127.0.0.1", port: ua.port, path: "/api/ops", method: "POST", headers: { host: `127.0.0.1:${ua.port}`, "content-type": "application/json" } });
    rq.on("error", () => { /* the socket is destroyed below */ });
    rq.end(JSON.stringify({ ops: [{ op: "add_voiceover", text: "Hello there.", voice: "piper" }] }));
    for (let i = 0; i < 200 && !pid; i++) { await Bun.sleep(25); try { pid = Number(readFileSync(pidFile, "utf8")) || 0; } catch { /* not started yet */ } }
    aliveBefore = pid > 0 && alive(pid);
    rq.destroy();
    for (let i = 0; i < 200 && !stopped; i++) { stopped = !alive(pid); if (!stopped) await Bun.sleep(25); }
  } finally {
    for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL"); // a child that outlived the bound is the failure; do not leave it running
  check("a UI apply stops its analysis when the request goes away, within 5 s", pid > 0 && aliveBefore && stopped, { pid, aliveBefore, stopped });
  check("the aborted apply saved nothing and the server keeps serving", readFileSync(join(dirA, "project.json"), "utf8") === before && (await raw("/api/state", { port: ua.port })).status === 200);
  // the same apply with the client connected is not aborted: the stand-in piper now writes its output and exits
  ff("-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", join(tmp, "tone.wav"));
  writeFileSync(join(binA, "piper"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "--output_file" ] && cp '${join(tmp, "tone.wav")}' "$2"; shift; done\ncat > /dev/null\n`, { mode: 0o755 });
  process.env.PATH = `${binA}:${was.PATH}`;
  process.env.AGENTCUT_PIPER_MODEL = join(media, "p.jpg");
  const rev0 = (await api.info(dirA)).revision as number;
  let done: { status: number; j: any } | undefined;
  try { done = await jget("/api/ops", { method: "POST", port: ua.port, body: { ops: [{ op: "add_voiceover", text: "Hello there.", voice: "piper" }] } }); }
  finally { for (const [k, v] of Object.entries(was)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  check("a UI apply whose client stays connected completes and saves a revision", done?.status === 200 && (await api.info(dirA)).revision === rev0 + 1 && done.j.results?.[0]?.clip?.id, { status: done?.status, j: done?.j, rev0 });
  ua.server.closeAllConnections?.();
  await new Promise((ok) => ua.server.close(ok));
}

// default port 4810 taken: the message names the port (this listener may fail if something else already holds it, which also blocks startUi)
{
  const { createServer } = await import("node:net");
  const hold = createServer();
  await new Promise<void>((ok) => { hold.once("error", () => ok()); hold.listen(4810, "127.0.0.1", () => ok()); });
  const e: any = await startUi(dir).then(() => null, (x) => x);
  hold.close();
  check("default port in use -> port_in_use naming 4810", e?.code === "port_in_use" && /4810/.test(e.message) && !/undefined/.test(e.message), e && { code: e.code, message: e.message });
}

// a listen that fails leaves nothing running: the child must end by itself (a live project.json watcher would keep it alive)
{
  const script = join(tmp, "listen-fails.ts");
  writeFileSync(script, `import { createServer } from "node:net";
const { startUi } = await import(${JSON.stringify(resolve(import.meta.dir, "../src/ui.ts"))});
const hold = createServer();
await new Promise<void>((ok) => hold.listen(0, "127.0.0.1", ok));
const e: any = await startUi(process.argv[2], { port: (hold.address() as any).port }).then(() => null, (x: any) => x);
console.log(e?.code ?? "started");
hold.close();
`);
  const r = await new Promise<{ status: number | null; signal: string | null; out: string; err: string }>((ok) => { // async: the suite's own server keeps answering while the child lives
    const ch = spawn(process.execPath, [script, dir]);
    let out = "", err = "";
    ch.stdout.on("data", (c) => (out += c));
    ch.stderr.on("data", (c) => (err += c));
    const kill = setTimeout(() => ch.kill("SIGKILL"), 20000);
    ch.on("close", (status, signal) => { clearTimeout(kill); ok({ status, signal, out, err }); });
  });
  check("a listen that fails rejects with port_in_use and leaves no watcher behind (the process ends by itself)", r.status === 0 && r.out.trim() === "port_in_use", { status: r.status, signal: r.signal, out: r.out, err: r.err.slice(0, 200) });
}

// a client that goes away mid-stream: the server keeps serving and the file descriptor of the read stream is released
{
  mkdirSync(join(dir, "renders"), { recursive: true });
  writeFileSync(join(dir, "renders", "big.bin"), Buffer.alloc(64 * 1024 * 1024)); // far more than the socket buffers hold, so the stream is mid-read when the client leaves
  const fds = () => readdirSync(existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd").length;
  await raw("/api/state"); // warm-up: lazily opened descriptors are in the baseline
  const settle = async () => { let n = fds(); for (let same = 0; same < 4;) { await new Promise((ok) => setTimeout(ok, 100)); const m = fds(); same = m === n ? same + 1 : 0; n = m; } return n; }; // until the count holds still
  const abort = () => new Promise<void>((ok, fail) => {
    const rq = request({ host: "127.0.0.1", port: ui.port, path: "/files/renders/big.bin", headers: { host: `127.0.0.1:${ui.port}`, range: "bytes=0-" } }, (res) => {
      res.once("data", () => { rq.destroy(); ok(); });
    });
    rq.on("error", () => {});
    rq.end();
    setTimeout(() => fail(new Error("no bytes")), 10000).unref();
  });
  const base = await settle(), N = 20;
  for (let i = 0; i < N; i++) await abort();
  const after = await settle();
  const again = await jget("/api/state");
  check(`${N} clients that leave mid-stream: their file descriptors are released`, after - base < N / 2, { base, after });
  check("  and the server keeps serving", again.status === 200 && again.j.ok === true, again.status);
  rmSync(join(dir, "renders", "big.bin"));
}

ctl.abort();
ui.server.closeAllConnections?.();
await new Promise((ok) => ui.server.close(ok));
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nall ui checks passed");
process.exit(failures ? 1 : 0);
