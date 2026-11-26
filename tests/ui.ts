// Web UI + project concurrency: revision conflicts across processes, no lost edits under parallel writers, HTTP endpoints,
// SSE live sync for edits made by another process, path-traversal / host guards.
// Run: bun tests/ui.ts            (needs ffmpeg on PATH)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { basename, join, resolve } from "node:path";
import { CONTAINED_FLAGS, SINGLETON_ALLOW, containmentProblem, profileText, spawnsChromeDirectly } from "./chrome.ts";
import { applyLatest, check, failures, ff } from "./harness.ts";

const CLI = [process.execPath, resolve(import.meta.dir, "../src/cli.ts")];
const cliAsync = (args: (string | number)[]) => new Promise<any>((ok) => {
  const { AGENTCUT_AUTHOR: _inherited, ...inherited } = process.env; // a variable of the runner never decides who an edit is by; the test declares its own name
  const ch = spawn(CLI[0], [...CLI.slice(1), ...args.map(String)], { env: { ...inherited, AGENTCUT_AUTHOR: "ui-test" } });
  let out = "";
  ch.stdout.on("data", (c) => (out += c));
  ch.on("close", () => { try { ok(JSON.parse(out)); } catch { ok({ ok: false, raw: out }); } });
});

const tmp = mkdtempSync(join(tmpdir(), "agentcut-ui-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
mkdirSync(join(tmp, "cache", "models", "u2netp"), { recursive: true }); writeFileSync(join(tmp, "cache", "models", "u2netp", "u2netp.onnx"), ""); // the default matte model is cached
const api = await import("./author-api.ts");
const { startUi } = await import("../src/ui.ts");
const { JOBS_KEPT } = await import("../src/jobs.ts");
const dir = join(tmp, "proj"), media = join(tmp, "media");
mkdirSync(media);
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", join(media, "a.mp4"));
ff("-f", "lavfi", "-i", "color=c=green:size=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", join(media, "b.mp4"));
ff("-f", "lavfi", "-i", "mandelbrot=size=320x240", "-frames:v", "1", join(media, "p.jpg"));
// the fixtures a row sets up from outside are not about concurrency: they read the project's revision (info) and apply at it. The rows about revisions, conflicts and the page pass theirs by hand.
const made = api.create(dir, { preset: "square" });
await api.apply(dir, [
  { op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 2 },
  { op: "add_clip", track: "main", src: join(media, "p.jpg"), duration: 1, transition: "crossfade" },
  { op: "add_clip", track: "text", text: "Hi", attach_to: "main#0", offset: 0.2, duration: 1 },
], { revision: made.revision });

// ---------------------------------------------------------------- concurrency across processes
console.log("concurrency");
const r0 = (await api.info(dir)).revision as number;
const stale = await cliAsync(["-p", dir, "op", "add_marker", "t=1", `--revision`, r0 - 1]);
check("stale --revision from another process -> conflict", stale.ok === false && stale.error.code === "conflict" && stale.error.revision === r0, stale);
check("conflict changed nothing", (await api.info(dir)).revision === r0);
const N = 6;
const marker = (i: number) => ["op", "add_marker", `t=${i + 1}`, `label=m${i}`];
const par = await Promise.all(Array.from({ length: N }, (_, i) => cliAsync(["-p", dir, ...marker(i), "--revision", r0])));
check(`${N} parallel writers at one revision: one applies, the others are conflicts that name who changed what`,
  par.filter((x) => x.ok).length === 1 && par.filter((x) => !x.ok).every((x) => x.error.code === "conflict" && x.error.message.includes('"ui-test" add_marker')), par);
// the agent's protocol after a conflict: read the revision again, resend. Writers racing on the project lock never lose an edit.
const resend = async (i: number) => { for (;;) { const now = await cliAsync(["-p", dir, "info"]), r = await cliAsync(["-p", dir, ...marker(i), "--revision", now.revision]); if (r.ok || r.error.code !== "conflict") return r; } };
const again = await Promise.all(par.flatMap((x, i) => (x.ok ? [] : [resend(i)])));
const tl = JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const labels = new Set(tl.markers.map((m: any) => m.label));
check(`${N} writers that resend after a conflict: every edit kept`, again.every((x) => x.ok) && Array.from({ length: N }, (_, i) => `m${i}`).every((l) => labels.has(l)), { again, markers: tl.markers });
check("revision advanced once per write", tl.revision === r0 + N, tl.revision);
const und = await cliAsync(["-p", dir, "undo", "--revision", r0]);
check("stale undo -> conflict", und.ok === false && und.error.code === "conflict", und);

// ---------------------------------------------------------------- HTTP server
console.log("server");
for (const port of [99999, -1, 4810.5]) { // a port is a whole number from 0 to 65535: refused before anything listens
  const r: any = await startUi(dir, { port }).catch((e: any) => e);
  r.server?.close();
  check(`ui port ${port} is bad_value naming the range`, r.code === "bad_value" && /0 to 65535/.test(r.message), r.message ?? "started");
}
const ui = await startUi(dir, { port: 0 });
const base = ui.url.replace(/\/$/, "");
// `text` is a raw JSON body (possibly empty or malformed); `port` aims at another ui server
const raw = (path: string, o: { method?: string; host?: string; body?: unknown; text?: string; port?: number; origin?: string; headers?: Record<string, string> } = {}) => new Promise<{ status: number; body: Buffer; type: string; headers: Record<string, unknown> }>((ok, fail) => {
  const port = o.port ?? ui.port;
  const rq = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET",
    headers: { host: o.host ?? `127.0.0.1:${port}`, ...o.headers, ...(o.origin ? { origin: o.origin } : {}), ...(o.body || o.text !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
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
const assetUrls = [...page.body.toString().matchAll(/\/assets\/app\.[0-9a-f]{12}\.(?:css|js)/g)].map((m) => m[0]);
const pageJs = await raw(assetUrls.find((u) => u.endsWith(".js"))!), pageCss = await raw(assetUrls.find((u) => u.endsWith(".css"))!);
check("page served: a shell naming its stylesheet and script, each served as its type and kept by the browser for good", page.status === 200 && page.headers["cache-control"] === "no-store" && assetUrls.length === 2
  && pageJs.status === 200 && pageJs.type.startsWith("text/javascript") && pageJs.body.toString().includes("EventSource") && pageCss.status === 200 && pageCss.type.startsWith("text/css")
  && [pageJs, pageCss].every((r) => r.headers["cache-control"] === "public, max-age=31536000, immutable"), { assetUrls, page: page.headers, js: pageJs.headers });
const gz = await raw(assetUrls[0], { headers: { "accept-encoding": "gzip, br" } });
check("  gzipped when the browser accepts it, and the same text unzipped", gz.headers["content-encoding"] === "gzip" && gunzipSync(gz.body).equals(assetUrls[0].endsWith(".js") ? pageJs.body : pageCss.body) && gz.body.length < pageJs.body.length / 2);
check("  not gzipped when the browser refuses it (gzip;q=0)", (await raw(assetUrls[0], { headers: { "accept-encoding": "gzip;q=0, br" } })).headers["content-encoding"] === undefined);
check("  an asset of no build is 404, an Object property name too", (await raw("/assets/app.000000000000.js")).status === 404 && (await raw("/assets/constructor")).status === 404);
const st0 = await raw("/api/state");
const st = await jget("/api/state");
check("state has timeline + revision + history", st.j.ok && st.j.revision === r0 + N && st.j.timeline.tracks.length > 0 && Array.isArray(st.j.history.undo), st.j);
const vid = st.j.timeline.tracks.find((t: any) => t.id === "main").clips[0];
const fr = await raw("/api/frame?t=0.5&scale=0.25");
check("frame is a JPEG", fr.status === 200 && fr.type === "image/jpeg" && fr.body[0] === 0xff && fr.body[1] === 0xd8);
const frameSequence = [0.1, 0.5, 1.2, 1.9, 0.3, 0.0, 1.0];
const frameIdentity: { t: number; status: number; same: boolean; bytes: number; expected: number }[] = [];
const freshFrames = new Map<number, Buffer>();
for (const t of frameSequence) {
  const cached = await raw(`/api/frame?t=${t}&scale=0.25`), fresh = await api.frameImage(dir, t, { scale: 0.25 });
  freshFrames.set(t, fresh.data);
  frameIdentity.push({ t, status: cached.status, same: cached.body.equals(fresh.data), bytes: cached.body.length, expected: fresh.data.length });
}
check("reused /api/frame bytes match fresh renderers across ascending, descending, and jump seeks", frameIdentity.every((x) => x.status === 200 && x.same), frameIdentity);
{
  const layersDir = join(tmp, "layers"), madeLayers = api.create(layersDir, { preset: "square" });
  await api.apply(layersDir, Array.from({ length: 3 }, () => ({ op: "add_clip" as const, track: "main", src: join(media, "a.mp4"), duration: 2.5 })), { revision: madeLayers.revision });
  const scrubUi = await startUi(layersDir, { port: 0 });
  const last = await raw("/api/frame?t=6.5&scale=0.25", { port: scrubUi.port });
  const first = await raw("/api/frame?t=0.5&scale=0.25", { port: scrubUi.port });
  const layers = api.frameCacheVideoLayers(layersDir);
  const farOpen = layers.filter((L) => L.open && (0.5 < L.start - 1 || 0.5 > L.end + 1));
  check("a backward scrub closes cached video layers far from the playhead", last.status === 200 && first.status === 200 && layers.length === 3
    && layers.some((L) => L.open && L.start <= 0.5 && 0.5 < L.end) && farOpen.length === 0, layers);
  scrubUi.server.closeAllConnections?.();
  await new Promise((ok) => scrubUi.server.close(ok));
  await api.closeFrameCache(layersDir);
}
{
  const captionsDir = join(tmp, "captions"), srtPath = join(tmp, "preview.srt");
  const madeCaptions = api.create(captionsDir, { preset: "square" });
  writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:02,000\nMANGO\n");
  await api.apply(captionsDir, [
    { op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 2 },
    { op: "add_captions", srt: srtPath, preset: "clean" },
  ], { revision: madeCaptions.revision });
  const captionsUi = await startUi(captionsDir, { port: 0 });
  const first = await raw("/api/frame?t=0.5&scale=0.25", { port: captionsUi.port });
  const was = statSync(srtPath);
  writeFileSync(srtPath, "1\n00:00:00,000 --> 00:00:02,000\nBERRY\n");
  utimesSync(srtPath, was.atimeMs / 1000, (was.mtimeMs + 2000) / 1000);
  const changed = await raw("/api/frame?t=0.5&scale=0.25", { port: captionsUi.port });
  const fresh = await api.frameImage(captionsDir, 0.5, { scale: 0.25 });
  check("an in-place SRT edit invalidates the frame cache without changing the project revision",
    first.status === 200 && changed.status === 200 && first.headers["x-revision"] === changed.headers["x-revision"]
    && changed.body.equals(fresh.data) && !changed.body.equals(first.body),
    { first: first.headers["x-revision"], changed: changed.headers["x-revision"], fresh: changed.body.equals(fresh.data), differs: !changed.body.equals(first.body) });
  captionsUi.server.closeAllConnections?.();
  await new Promise((ok) => captionsUi.server.close(ok));
  await api.closeFrameCache(captionsDir);
}
{
  const alphaDir = join(tmp, "alpha-bg"), red = join(media, "red.png"), green = join(media, "green.png");
  ff("-f", "lavfi", "-i", "color=c=red:size=64x64", "-frames:v", "1", red);
  ff("-f", "lavfi", "-i", "color=c=green:size=64x64", "-frames:v", "1", green);
  const madeAlpha = api.create(alphaDir, { preset: "square" });
  await api.apply(alphaDir, [
    { op: "set_settings", background: "#00000080" },
    { op: "add_clip", track: "main", src: red, duration: 1 },
    { op: "add_clip", track: "main", src: green, duration: 1 },
  ], { revision: madeAlpha.revision });
  const first = await api.frameImage(alphaDir, 0.5, { reuse: true, scale: 0.25, format: "png" });
  const reused = await api.frameImage(alphaDir, 1.5, { reuse: true, scale: 0.25, format: "png" });
  const fresh = await api.frameImage(alphaDir, 1.5, { scale: 0.25, format: "png" });
  check("a reused Renderer clears before painting a translucent background",
    !first.data.equals(reused.data) && reused.data.equals(fresh.data),
    { changed: !first.data.equals(reused.data), fresh: reused.data.equals(fresh.data) });
  await api.closeFrameCache(alphaDir);
}
{
  const unstatDir = join(tmp, "unstat"), madeUnstat = api.create(unstatDir, { preset: "square" });
  await api.apply(unstatDir, [{
    op: "add_clip", track: "text", text: `${unstatDir}/project.json/x`, at: 0, duration: 1,
  }], { revision: madeUnstat.revision });
  const unstatUi = await startUi(unstatDir, { port: 0 });
  const cached = await raw("/api/frame?t=0.5&scale=0.25", { port: unstatUi.port });
  const fresh = await api.frameImage(unstatDir, 0.5, { scale: 0.25 });
  check("an unstatable absolute-looking text string does not break frame rendering",
    cached.status === 200 && cached.body.equals(fresh.data), { status: cached.status, same: cached.body.equals(fresh.data) });
  unstatUi.server.closeAllConnections?.();
  await new Promise((ok) => unstatUi.server.close(ok));
  await api.closeFrameCache(unstatDir);
}
const late = await raw(`/api/frame?t=${st.j.duration}&scale=0.25`);
check("a frame time at the duration is refused as bad_value", late.status >= 400 && late.status < 500 && late.type === "application/json" && JSON.parse(late.body.toString()).error.code === "bad_value", late.status);
check("every response carries nosniff and a framing restriction", [page, st0, fr].every((r) => r.headers["x-content-type-options"] === "nosniff" && r.headers["x-frame-options"] === "DENY" && String(r.headers["content-security-policy"]).includes("frame-ancestors 'none'")), [page, st0, fr].map((r) => r.headers));
const th = await raw(`/api/thumb/${vid.asset}?t=0.5`);
check("video thumbnail", th.status === 200 && th.body[0] === 0xff && th.body[1] === 0xd8);
{
  const srcAbs = resolve(dir, st.j.timeline.assets[vid.asset].path), keep = srcAbs + ".keep";
  renameSync(srcAbs, keep);
  let thumb: Awaited<ReturnType<typeof raw>>;
  try {
    ff("-f", "lavfi", "-i", "color=c=0x00ff00:s=64x64:r=10:d=1", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=1", "-map", "0:v", "-map", "1:v", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-disposition:v:0", "0", "-disposition:v:1", "default", srcAbs);
    thumb = await raw(`/api/thumb/${vid.asset}?t=0.5`);
  } finally { rmSync(srcAbs, { force: true }); renameSync(keep, srcAbs); }
  const rgb = spawnSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { input: thumb.body }).stdout;
  check("a thumbnail reads the first video stream, not the default stream", thumb.status === 200 && rgb.length === 3 && rgb[0] < 30 && rgb[1] > 200 && rgb[2] < 30, [...rgb]);
}
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
{ // a thumbnail is the picture at its time where an input seek there does not land: near the picture's start of an flv (h264, sound) or an avi (mpeg4, B-frames), and in an mpegts with a keyframe each second (its seek can land after the target)
  const T = join(tmp, "thumbs"), shots: [string, number][] = [["ns.flv", 0], ["ns.avi", 0], ["key.ts", 0.5], ["key.ts", 2.5]];
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=2", "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-c:a", "aac", join(media, "ns.flv"));
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=2", "-c:v", "mpeg4", "-bf", "2", join(media, "ns.avi"));
  ff("-f", "lavfi", "-i", "testsrc2=size=64x64:rate=25:duration=4", "-c:v", "libx264", "-x264-params", "keyint=25:min-keyint=25:scenecut=0", "-f", "mpegts", join(media, "key.ts"));
  const tm = api.create(T, { preset: "square" });
  await api.apply(T, ["ns.flv", "ns.avi", "key.ts"].map((f) => ({ op: "add_clip", track: "main", src: join(media, f), duration: 1 })), { revision: tm.revision });
  const assets = Object.entries(JSON.parse(readFileSync(join(T, "project.json"), "utf8")).assets as Record<string, { path: string; container_start: number }>);
  const tu = await startUi(T, { port: 0 }), got: unknown[] = [];
  for (const [f, t] of shots) {
    const [id, a] = assets.find(([, a]) => basename(a.path) === f)!, r = await raw(`/api/thumb/${id}?t=${t}`, { port: tu.port });
    // the picture at t on the container's clock, decoded from the file's start
    const want = spawnSync("ffmpeg", ["-v", "error", "-copyts", "-i", join(media, f), "-map", "0:V:0", "-ss", String(t + a.container_start), "-frames:v", "1", "-vf", "scale=160:-2", "-f", "image2pipe", "-c:v", "mjpeg", "-"]).stdout;
    got.push([f, t, r.status, r.body.length, want.length, r.body.equals(want)]);
  }
  tu.server.close();
  check("a thumbnail near the picture's start of an flv or avi, and one in an mpegts, is the picture at its time", got.every((g: any) => g[2] === 200 && g[5]), got);
}
const md = await raw(`/media/${vid.asset}`);
check("project asset served", md.status === 200 && md.type === "video/mp4" && md.body.length > 1000);
{
  const relinkProject = join(tmp, "relink-project");
  const created = api.create(relinkProject, { preset: "square" });
  await api.apply(relinkProject, [{ op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 2 }],
    { revision: created.revision });
  const relinkUi = await startUi(relinkProject, { port: 0 });
  const state = await jget("/api/state", { port: relinkUi.port });
  const id = state.j.timeline.tracks.find((t: any) => t.id === "main").clips[0].asset;
  const first = await raw(`/media/${id}`, { port: relinkUi.port });
  const relinked = join(relinkProject, "media", "relinked.mp4");
  copyFileSync(join(media, "b.mp4"), relinked);
  const changed = await jget("/api/ops", { method: "POST", port: relinkUi.port, body: {
    ops: [{ op: "relink_asset", id, path: relinked }], revision: state.j.revision,
  } });
  const second = await raw(`/media/${id}`, { port: relinkUi.port });
  check("media lookup follows relink_asset after a cached lookup", first.status === 200 && changed.status === 200
    && second.status === 200 && second.body.equals(readFileSync(relinked)) && !second.body.equals(first.body),
  { first: first.status, changed: changed.status, second: second.status, bytes: [first.body.length, second.body.length] });
  relinkUi.server.closeAllConnections?.();
  await new Promise((ok) => relinkUi.server.close(ok));
}

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

const ap = await jget("/api/ops", { method: "POST", body: { ops: [{ op: "update_clip", id: vid.id, set: { opacity: 0.5 } }], revision: r0 + N, author: "mallory" } });
check("op via HTTP applied", ap.status === 200 && ap.j.ok && ap.j.revision === r0 + N + 1, ap.j);
{ const h = (await jget("/api/state")).j.history, top = h.undo.at(-1);
  check("the page's edit is recorded as 'you' whatever the request body says", top?.label === "update_clip" && top.author === "you", top);
  check("the page state's history is {undo, redo} lists of {label, author} entries", ["undo", "redo"].every((k) => Array.isArray(h[k]) && h[k].every((e: any) => typeof e.label === "string" && typeof e.author === "string")), h); }
check("SSE pushed the HTTP edit", await waitRev(r0 + N + 1));
const cf = await jget("/api/ops", { method: "POST", body: { ops: [{ op: "update_clip", id: vid.id, set: { opacity: 0.2 } }], revision: r0 } });
check("stale page edit -> 409 conflict with hint", cf.status === 409 && cf.j.error.code === "conflict" && /reload/.test(cf.j.error.hint), cf.j);
check("  and the page's notice is the shared text: it names who changed the project, the page's own edit as \"you\"", cf.j.error.message.includes('"you" update_clip') && cf.j.error.changes?.some((c: any) => c.author === "you" && c.label === "update_clip"), cf.j.error);
for (const path of ["/api/ops", "/api/redo"]) { // an op that does not exist, so a server that wrongly accepted the call would still change nothing
  const miss = await jget(path, { method: "POST", body: { ops: [{ op: "no_such_op" }] } });
  check(`${path} with no revision -> 400 missing_revision`, miss.status === 400 && miss.j.error.code === "missing_revision" && !!miss.j.error.hint, miss.j);
}
const bad = await jget("/api/ops", { method: "POST", body: { ops: [{ op: "update_clip", id: vid.id, set: { opacity: "lots" } }], revision: (await api.info(dir)).revision } });
check("invalid batch rejected with issues", bad.status === 422 && bad.j.error.code === "validation_failed" && bad.j.error.issues?.length, bad.j);
{
  const text = st.j.timeline.tracks.find((t: any) => t.id === "text").clips[0];
  const before = freshFrames.get(0.5)!;
  await applyLatest(dir, [{ op: "update_clip", id: text.id, set: { text: "Frame cache edit" } }]);
  const changed = await raw("/api/frame?t=0.5&scale=0.25"), fresh = await api.frameImage(dir, 0.5, { scale: 0.25 });
  const revision = (await api.info(dir)).revision;
  check("a picture edit invalidates the cached frame and returns the new revision", changed.status === 200 && Number(changed.headers["x-revision"]) === revision
    && fresh.revision === revision && changed.body.equals(fresh.data) && !changed.body.equals(before), { header: changed.headers["x-revision"], revision, same: changed.body.equals(fresh.data), changed: !changed.body.equals(before) });

  const projectFile = join(dir, "project.json"), timeline = JSON.parse(readFileSync(projectFile, "utf8"));
  const unchangedRevision = timeline.revision;
  timeline.tracks.find((t: any) => t.id === "text").clips.find((c: any) => c.id === text.id).text = "Hand-edited frame";
  writeFileSync(projectFile, JSON.stringify(timeline));
  const hand = await raw("/api/frame?t=0.5&scale=0.25"), handFresh = await api.frameImage(dir, 0.5, { scale: 0.25 });
  check("a hand edit without a revision bump invalidates the cached frame", hand.status === 200 && Number(hand.headers["x-revision"]) === unchangedRevision
    && handFresh.revision === unchangedRevision && hand.body.equals(handFresh.data) && !hand.body.equals(changed.body), { header: hand.headers["x-revision"], revision: unchangedRevision, same: hand.body.equals(handFresh.data), changed: !hand.body.equals(changed.body) });
}

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

const ext = await cliAsync(["-p", dir, "op", "add_marker", "t=2.5", "label=agent", "--revision", (await api.info(dir)).revision]);
check("SSE pushed an edit made by another process", ext.ok && await waitRev(ext.revision), ext);
const pushed = events.findLast((e) => e.event === "state").data;
check("pushed state contains the agent's marker", pushed.timeline.markers.some((m: any) => m.label === "agent"));
check("the pushed history names the other process's declared author", pushed.history.undo.at(-1)?.author === "ui-test", pushed.history.undo.at(-1));

const un = await jget("/api/undo", { method: "POST", body: { revision: ext.revision, author: "mallory" } });
check("undo via HTTP", un.status === 200 && un.j.undone?.length === 1 && un.j.revision === ext.revision + 1, un.j);
check("the page's undo reports the agent's author and 'you' as who undid it", un.j.undone[0].author === "ui-test" && un.j.undone[0].movedBy === "you", un.j.undone);

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
for (const [method, p] of [["GET", "/%"], ["GET", "/api/state%"], ["GET", "/media/%E0%A4%A"], ["GET", "/files/renders/%zz"], ["GET", "/api/jobs/%"], ["GET", "//"], ["POST", "/api/render%"]]) {
  const r = await raw(p, { method, body: method === "POST" ? {} : undefined });
  check(`a request target that does not parse: ${method} ${p} -> 400 bad_request`, r.status === 400 && JSON.parse(r.body.toString()).error?.code === "bad_request", [r.status, r.body.toString().slice(0, 120)]);
}
check("  the server keeps serving", (await raw("/api/state")).status === 200);
const xo = await new Promise<number>((ok) => {
  const rq = request({ host: "127.0.0.1", port: ui.port, path: "/api/ops", method: "POST",
    headers: { host: `127.0.0.1:${ui.port}`, origin: "http://evil.example", "content-type": "application/json" } }, (res) => { res.resume(); ok(res.statusCode!); });
  rq.end(JSON.stringify({ ops: [], revision: 0 }));
});
check("cross-origin POST refused", xo === 403);
// a 3-byte character split across two request writes; the rejected op echoes its name back, so no revision moves
const splitRev = (await api.info(dir)).revision;
const split = await new Promise<string>((ok) => {
  const body = Buffer.from(JSON.stringify({ ops: [{ op: "nope_ệ" }], revision: splitRev })), cut = body.indexOf(Buffer.from("ệ")) + 1;
  const rq = request({ host: "127.0.0.1", port: ui.port, path: "/api/ops", method: "POST", headers: { host: `127.0.0.1:${ui.port}`, "content-type": "application/json" } }, (res) => {
    const ch: Buffer[] = []; res.on("data", (c) => ch.push(c)); res.on("end", () => ok(Buffer.concat(ch).toString("utf8")));
  });
  rq.write(body.subarray(0, cut));
  setTimeout(() => rq.end(body.subarray(cut)), 300);
});
check("POST body keeps multi-byte text whole across chunks", split.includes("nope_ệ") && !split.includes("\uFFFD"), split.slice(0, 300));

// a file dropped on the page: its bytes go to media/ under its own name, never over another file, and only as octet-stream
const upload = (name: string, body: Buffer, o: { type?: string; origin?: string } = {}) => new Promise<{ status: number; j: any }>((ok, fail) => {
  const rq = request({ host: "127.0.0.1", port: ui.port, path: "/api/upload?name=" + encodeURIComponent(name), method: "POST",
    headers: { host: `127.0.0.1:${ui.port}`, "content-type": o.type ?? "application/octet-stream", ...(o.origin ? { origin: o.origin } : {}) } }, (res) => {
    const ch: Buffer[] = []; res.on("data", (c) => ch.push(c)); res.on("end", () => ok({ status: res.statusCode!, j: JSON.parse(Buffer.concat(ch).toString()) }));
  });
  rq.on("error", fail);
  rq.end(body);
});
const jpg = readFileSync(join(media, "p.jpg"));
const up1 = await upload("drop.jpg", jpg), up2 = await upload("drop.jpg", jpg);
check("an upload lands in media/ under its name, a second one with the same name beside it (never over it)", up1.j.ok && up1.j.path === join(dir, "media", "drop.jpg") && up2.j.path === join(dir, "media", "drop-1.jpg")
  && readFileSync(up1.j.path).equals(jpg) && readFileSync(up2.j.path).equals(jpg), [up1, up2]);
const scratchLeft = () => (existsSync(join(dir, ".agentcut", "tmp")) ? readdirSync(join(dir, ".agentcut", "tmp")).filter((f) => f.startsWith("upload-")) : []);
const badUps = await Promise.all([upload("../x.jpg", jpg), upload(".hidden.jpg", jpg), upload("notes.txt", Buffer.from("x")), upload("drop.jpg", jpg, { type: "application/json" }), upload("x.jpg", jpg, { origin: "http://evil.example" })]);
check("an upload whose name is a path or hidden is bad_value, a non-media file bad_type, JSON 415, another origin 403; nothing is written",
  JSON.stringify(badUps.map((r) => [r.status, r.j.error?.code])) === '[[422,"bad_value"],[422,"bad_value"],[422,"bad_type"],[415,"bad_request"],[403,"forbidden"]]'
  && ["x.jpg", ".hidden.jpg", "notes.txt", "drop-2.jpg"].every((f) => !existsSync(join(dir, "media", f))) && !existsSync(join(tmp, "x.jpg")) && scratchLeft().length === 0, badUps.map((r) => [r.status, r.j.error]));
const opsOctet = await new Promise<number>((ok) => {
  const rq = request({ host: "127.0.0.1", port: ui.port, path: "/api/ops", method: "POST", headers: { host: `127.0.0.1:${ui.port}`, "content-type": "application/octet-stream" } }, (res) => { res.resume(); ok(res.statusCode!); });
  rq.end("{}");
});
check("  and /api/ops still takes JSON only", opsOctet === 415, opsOctet);
for (const f of ["drop.jpg", "drop-1.jpg"]) rmSync(join(dir, "media", f));
// a clip's waveform: 50 peaks per second of the asset's sound; a file with no sound is an error, not an empty wave
ff("-f", "lavfi", "-i", "sine=frequency=440:duration=2", join(media, "tone.wav"));
const toneId = (await applyLatest(dir, [{ op: "import_media", path: join(media, "tone.wav") }])).results[0].asset;
const pk = await jget("/api/peaks/" + toneId), mute = await jget("/api/peaks/" + vid.asset);
check("/api/peaks: 50 peaks per second of the sound, a steady tone steady inside, 0..255", pk.j.ok && pk.j.rate === 50 && Math.abs(pk.j.peaks.length - 100) <= 1
  && pk.j.peaks.slice(2, -2).every((v: number) => v === pk.j.peaks[50] && v > 20 && v <= 255), { rate: pk.j.rate, n: pk.j.peaks?.length, some: pk.j.peaks?.slice(0, 5) });
check("  and a video with no sound answers decode_failed", mute.status === 422 && mute.j.error?.code === "decode_failed", mute);
// the library: each item a still from a scratch timeline, kept in previews/ui/library per AgentCut version; the scratch project is gone after
{
  const { VERSION } = await import("../src/version.ts");
  const bw = await raw("/api/library/look/bw"), file = join(dir, "previews", "ui", "library", `look-bw-${VERSION}.jpg`);
  const px = spawnSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", "scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { input: bw.body }).stdout;
  check("/api/library/look/bw: a JPEG of the test picture in that look (grey), saved in previews/ui/library", bw.status === 200 && bw.type === "image/jpeg" && existsSync(file)
    && px.length === 3 && Math.max(...px) - Math.min(...px) <= 6, { status: bw.status, px: [...px] });
  const xs = await raw("/api/library/look/warm", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" } }), nav = await raw("/", { headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" } });
  check("a request another site's page makes is refused (403, nothing rendered); opening the page from a link is not", xs.status === 403 && !existsSync(join(dir, "previews", "ui", "library", `look-warm-${VERSION}.jpg`)) && nav.status === 200, [xs.status, nav.status]);
  const m0 = statSync(file).mtimeMs, again = await raw("/api/library/look/bw");
  check("  a second request is the saved file", again.status === 200 && statSync(file).mtimeMs === m0 && again.body.equals(bw.body));
  const bad = await raw("/api/library/look/nope"), deep = await raw("/api/library/look/bw/x");
  check("  an item not in the library, or a longer path, is not_found", [bad, deep].every((r) => r.status === 404 && JSON.parse(r.body.toString()).error.code === "not_found"), [bad.status, deep.status]);
  check("  no scratch project is left in .agentcut/tmp", !readdirSync(join(dir, ".agentcut", "tmp")).some((n) => n.startsWith(`render-${process.pid}-`)));
}
// the transcript panel's words: the engine's words of an asset in media seconds, kept in previews/ui/transcripts so the engine runs once per file version
if (process.platform !== "win32") { // the stand-in engine is a shell script
  const bin = join(tmp, "asr-bin"), model = join(tmp, "asr.bin"), runs = join(tmp, "asr.runs");
  mkdirSync(bin); writeFileSync(model, "");
  writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\necho run >> "${runs}"\nwhile [ $# -gt 0 ]; do [ "$1" = "-of" ] && printf '%s' '{"result":{"language":"en"},"transcription":[{"text":" Hi","offsets":{"from":200,"to":500}},{"text":" there","offsets":{"from":600,"to":900}}]}' > "$2.json"; shift; done\n`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, model: process.env.AGENTCUT_WHISPER_MODEL };
  process.env.PATH = `${bin}:${env.PATH}`; process.env.AGENTCUT_WHISPER_MODEL = model;
  try {
    const t1 = await jget("/api/transcript", { method: "POST", body: { asset: toneId } }), t2 = await jget("/api/transcript", { method: "POST", body: { asset: toneId } });
    check("/api/transcript: the words of the asset in media seconds; asked again, the saved words without a second engine run",
      t1.j.ok && JSON.stringify(t1.j.words) === '[{"text":"Hi","start":0.2,"end":0.5},{"text":"there","start":0.6,"end":0.9}]' && JSON.stringify(t2.j.words) === JSON.stringify(t1.j.words)
      && readFileSync(runs, "utf8").trim().split("\n").length === 1 && readdirSync(join(dir, "previews", "ui", "transcripts")).length === 1, { t1: t1.j, runs: readFileSync(runs, "utf8") });
    const bad = await jget("/api/transcript", { method: "POST", body: { asset: 5 } });
    check("  a request without an asset id is bad_request", bad.status === 400 && bad.j.error.code === "bad_request", bad);
  } finally { process.env.PATH = env.PATH; if (env.model === undefined) delete process.env.AGENTCUT_WHISPER_MODEL; else process.env.AGENTCUT_WHISPER_MODEL = env.model; }
}

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
{
  const fps = (await api.info(dir, "json")).timeline.settings.fps;
  const play = async (start: number, end: number) => (await jget("/api/render", { method: "POST", body: { play: true, start, end } })).j;
  const normalized = await play(0.001, 1.001);
  check("play ranges in the same frame slots reuse the normalized cached range", normalized.status === "done" && normalized.url === done.url, normalized);
  const next = await play(0, 1 + 1 / fps);
  let ended = next;
  for (let i = 0; i < 300 && ended.status === "running"; i++) { await Bun.sleep(50); ended = (await jget(`/api/jobs/${next.id}`)).j; }
  check("play ranges in different frame slots render exactly their normalized range", ended.status === "done" && ended.url !== done.url && ended.result.frames === fps + 1 && Math.abs(ended.result.range[1] - (1 + 1 / fps)) < 1e-6, ended);
  const empty = await play(0, 0.001), invalid = await play(-1, 1);
  check("play refuses empty normalized ranges and invalid starts before making jobs", empty.error?.code === "empty" && invalid.error?.code === "bad_value", { empty, invalid });
}
{ // the history panel undoes back to an entry: steps on /api/undo and /api/redo; the review panel runs review
  await applyLatest(dir, [{ op: "add_marker", t: 0.11, label: "h1" }]);
  await applyLatest(dir, [{ op: "add_marker", t: 0.12, label: "h2" }]);
  const labels = () => (JSON.parse(readFileSync(join(dir, "project.json"), "utf8")).markers ?? []).map((m: any) => m.label);
  const r1 = (await api.info(dir)).revision;
  const bad = await jget("/api/undo", { method: "POST", body: { revision: r1, steps: 0 } });
  const two = await jget("/api/undo", { method: "POST", body: { revision: r1, steps: 2 } });
  check("undo with steps 2 undoes the two newest entries in one call (the revision moves once per entry); steps 0 is bad_value", bad.j.error?.code === "bad_value" && two.j.ok && two.j.done === 2 && two.j.revision === r1 + 2
    && !labels().includes("h1") && !labels().includes("h2"), { bad: bad.j.error, two: two.j, labels: labels() });
  const back = await jget("/api/redo", { method: "POST", body: { revision: two.j.revision, steps: 2 } });
  check("  and redo with steps 2 brings both back", back.j.done === 2 && labels().includes("h1") && labels().includes("h2"), back.j);
  const rv = await jget("/api/review", { method: "POST", body: {} });
  check("/api/review answers review's findings and the revision it read", rv.j.ok && Array.isArray(rv.j.findings) && typeof rv.j.clean === "boolean" && rv.j.revision === (await api.info(dir)).revision, rv.j);
}
{ // the export dialog: a format from the list, the file named by the server in renders/, the result with its QA
  const bad = await jget("/api/render", { method: "POST", body: { format: ".txt" } }), path = await jget("/api/render", { method: "POST", body: { format: "../x.mp4" } });
  check("an export format outside the list is bad_value, before any job", bad.status === 422 && bad.j.error?.code === "bad_value" && path.j.error?.code === "bad_value", [bad.j, path.j]);
  let ex = (await jget("/api/render", { method: "POST", body: { format: ".webm", quality: "draft", start: 0, end: 0.5 } })).j;
  for (let i = 0; i < 600 && ex.status === "running"; i++) { await Bun.sleep(100); ex = (await jget(`/api/jobs/${ex.id}`)).j; }
  check("an export writes the chosen format into renders/ and its result carries the QA of the written file", ex.status === "done" && /^\/files\/renders\/[^/]+\.webm$/.test(ex.url) && ex.result.qa?.ok === true
    && (await raw(ex.url)).type === "video/webm", { status: ex.status, url: ex.url, qa: ex.result?.qa, error: ex.error });
}

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
await applyLatest(dir, [{ op: "remove_background", id: vid.id }]);
const np = await jget("/api/frame?t=0.5&scale=0.25");
check("frame of an unprepared project -> 422 not_prepared with hint", np.status === 422 && np.j.error.code === "not_prepared" && /prepare/.test(np.j.error.hint), np);
check("page offers the Prepare action for not_prepared", pageJs.body.toString().includes("/api/prepare"));
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
  await applyLatest(dirC, [{ op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 1 }]);
  const cid = JSON.parse(readFileSync(join(dirC, "project.json"), "utf8")).tracks.find((t: any) => t.id === "main").clips[0].id;
  await applyLatest(dirC, [{ op: "remove_background", id: cid, model: "u2net_human_seg" }]);
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
  // the download is stubbed (no network): it records the URL and answers 404
  const realFetch = globalThis.fetch, asked: string[] = [];
  globalThis.fetch = (async (u: any) => { asked.push(String(u)); return new Response("no", { status: 404 }); }) as typeof fetch;
  const yes = await prep({ text: '{"allow_download":true}' }).finally(() => { globalThis.fetch = realFetch; });
  check("allow_download true reaches the model download once (the pinned URL), and the helper is not started", asked.join() === (await import("../src/model.ts")).MATTE_PINS.u2net_human_seg.url && yes.j.status === "failed" && yes.j.error?.code === "model_download_failed" && runs().length === 0, { asked, runs: runs(), yes });
  uc.server.closeAllConnections?.();
  await new Promise((ok) => uc.server.close(ok));
}

// a long session does not keep every finished job: past JOBS_KEPT the earliest-ended finished ones answer not_found, a running one is never dropped
console.log("job retention");
{
  const bin = join(tmp, "stub-keep-bin"), started = join(tmp, "stub-keep.started");
  mkdirSync(bin);
  writeFileSync(join(bin, "ffmpeg"), `#!/bin/sh\ncase "$*" in *-version*|*-hide_banner*) exec ${JSON.stringify(spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim())} "$@" ;; esac\n: > ${JSON.stringify(started)}\ntrap 'kill $! 2>/dev/null; exit 1' TERM\nsleep 60 &\nwait $!\n`);
  chmodSync(join(bin, "ffmpeg"), 0o755);
  const dirJ = join(tmp, "retention");
  api.create(dirJ, { preset: "720p" });
  await applyLatest(dirJ, [{ op: "add_clip", track: "main", src: join(media, "a.mp4"), at: 0, duration: 1 }]);
  const uj = await startUi(dirJ, { port: 0 });
  const get = (id: string) => jget(`/api/jobs/${id}`, { port: uj.port });
  const cancel = (id: string) => jget(`/api/jobs/${id}/cancel`, { method: "POST", port: uj.port, body: {} });
  const was = process.env.PATH;
  process.env.PATH = `${bin}:${was}`;
  try {
    const held = (await jget("/api/render", { method: "POST", port: uj.port, body: { play: true, start: 0, end: 1 } })).j; // the oldest job, and running throughout
    for (let i = 0; i < 200 && !existsSync(started); i++) await Bun.sleep(50);
    const prepared = async () => { // nothing is pending, so a prepare settles at once
      const id = (await jget("/api/prepare", { method: "POST", port: uj.port, body: {} })).j.id;
      for (let k = 0; k < 200 && (await get(id)).j.status === "running"; k++) await Bun.sleep(20);
      return id;
    };
    const ids: string[] = [];
    for (let i = 0; i < JOBS_KEPT + 2; i++) ids.push(await prepared());
    const [oldest, oldestCancel, newest, running] = [await get(ids[0]), await cancel(ids[0]), await get(ids.at(-1)!), await get(held.id)];
    check(`the oldest of ${JOBS_KEPT + 2} finished jobs is forgotten: GET and cancel answer 404 not_found`, oldest.status === 404 && oldest.j.error?.code === "not_found" && oldestCancel.status === 404 && oldestCancel.j.error?.code === "not_found", { oldest, oldestCancel });
    check("  the newest finished job is kept", newest.status === 200 && newest.j.status === "done", newest);
    check("  a job still running is kept, older than all of them", existsSync(started) && running.status === 200 && running.j.status === "running", { started: existsSync(started), running });
    const stopped = await cancel(held.id); // the job that started first now ends last
    await prepared();
    const ended = await get(held.id);
    check("a job is kept by when it ended: the first started, ended after the others, still answers after the next job ends", stopped.j.status !== "running" && ended.status === 200 && ended.j.status === stopped.j.status, { ended, stopped });
    const pj = join(dirJ, "project.json"), saved = readFileSync(pj, "utf8"), realRandom = Math.random;
    let failed: any;
    try { // the project cannot be read: the play fails before it starts. Its client is never told a job id, so the row fixes the one the server draws ("i")
      writeFileSync(pj, "{"); Math.random = () => 0.5;
      failed = await jget("/api/render", { method: "POST", port: uj.port, body: { play: true, start: 0, end: 3 } });
    } finally { Math.random = realRandom; writeFileSync(pj, saved); }
    const [ghost, ghostCancel] = [await get("i"), await cancel("i")];
    check("a play request that fails before it starts leaves no job: GET and cancel on it answer 404 not_found", failed.status >= 400 && failed.j.ok === false && ghost.status === 404 && ghost.j.error?.code === "not_found" && ghostCancel.status === 404 && ghostCancel.j.error?.code === "not_found", { failed, ghost, ghostCancel });
    mkdirSync(join(dirJ, "previews", "ui"), { recursive: true });
    writeFileSync(join(dirJ, "previews", "ui", `play-r${(await api.info(dirJ)).revision}-f0-${(await api.info(dirJ, "json")).timeline.settings.fps}.mp4`), "x"); // a cached range: a play on it is done at once, with no job end to follow
    const hits: string[] = [];
    for (let i = 0; i < JOBS_KEPT + 2; i++) hits.push((await jget("/api/render", { method: "POST", port: uj.port, body: { play: true, start: 0, end: 3 } })).j.id);
    const [firstHit, lastHit] = [await get(hits[0]), await get(hits.at(-1)!)];
    check(`the oldest of ${JOBS_KEPT + 2} plays answered from the cache is forgotten, the newest is kept`, firstHit.status === 404 && firstHit.j.error?.code === "not_found" && lastHit.status === 200 && lastHit.j.status === "done", { firstHit, lastHit });
  } finally { process.env.PATH = was; }
  uj.server.closeAllConnections?.();
  await new Promise((ok) => uj.server.close(ok));
}

// ---------------------------------------------------------------- cancel a job
console.log("cancel");
{
  const big = join(media, "big.mp4");
  ff("-f", "lavfi", "-i", "testsrc2=size=3840x2160:rate=30:duration=6", "-pix_fmt", "yuv420p", big);
  const dirK = join(tmp, "cancel");
  api.create(dirK, { preset: "4k" });
  await applyLatest(dirK, [{ op: "add_clip", track: "main", src: big, at: 0, duration: 5.9 }]);
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
    await applyLatest(dirE, [{ op: "add_clip", track: "main", src: tone, at: 0, duration: 2 }]);
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
    await applyLatest(dirP, [{ op: "add_clip", track: "main", src: tone, at: 0, duration: 2 }]);
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
    await applyLatest(dirF, [{ op: "add_clip", track: "main", src: gone, at: 0, duration: 1 }]);
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
  const emptyOps = await jget("/api/ops", { method: "POST", port: uk.port, body: { ops: [], revision: rev0 } });
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
    rq.end(JSON.stringify({ ops: [{ op: "add_voiceover", text: "Hello there.", voice: "piper" }], revision: 0 })); // dirA is a new project
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
  try { done = await jget("/api/ops", { method: "POST", port: ua.port, body: { ops: [{ op: "add_voiceover", text: "Hello there.", voice: "piper" }], revision: rev0 } }); }
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

// the event stream over a state that cannot be read: it carries the named error and ends (the page shows an error event; an ended stream with no event is a blank page that reconnects without a word)
console.log("event stream over an unreadable history entry");
{
  const d = join(tmp, "unreadable-entry");
  api.create(d, { preset: "reels" });
  await applyLatest(d, [{ op: "add_marker", t: 1 }]);
  await applyLatest(d, [{ op: "add_marker", t: 2 }]);
  const us = await startUi(d, { port: 0 });
  await jget("/api/state", { port: us.port });
  const undoDir = join(d, ".agentcut", "history", "undo"), entry = join(undoDir, readdirSync(undoDir).sort().pop()!), name = basename(entry);
  const noRev = JSON.parse(readFileSync(entry, "utf8")); delete noRev.revision;
  writeFileSync(entry, JSON.stringify(noRev));
  /** GET /api/events: the head, the events seen, and whether the server ended the stream (the first `state` event also stops the read, as a page would have what it needs) */
  const stream = (port: number) => new Promise<{ status?: number; type: string; events: { event: string; data: any }[]; ended: boolean }>((ok) => {
    const out = { status: undefined as number | undefined, type: "", events: [] as { event: string; data: any }[], ended: false };
    const rq = request({ host: "127.0.0.1", port, path: "/api/events", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      out.status = res.statusCode; out.type = String(res.headers["content-type"]);
      let buf = "";
      res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const m = /^event: (\w+)\ndata: (.*)$/s.exec(buf.slice(0, i)); buf = buf.slice(i + 2); if (m) out.events.push({ event: m[1], data: JSON.parse(m[2]) }); } if (out.events.some((e) => e.event === "state")) { rq.destroy(); ok(out); } });
      res.on("end", () => { out.ended = true; ok(out); });
    });
    rq.on("error", () => ok(out));
    setTimeout(() => { rq.destroy(); ok(out); }, 5000);
    rq.end();
  });
  const sj = await jget("/api/state", { port: us.port });
  check("/api/state over an entry with no revision: 400 bad_json naming the entry", sj.status === 400 && sj.j.error.code === "bad_json" && sj.j.error.message.includes(name), sj);
  const s1 = await stream(us.port);
  check("/api/events over the same entry: 200 event-stream, one `error` event with the same code and the entry's name, then the stream ends",
    s1.status === 200 && s1.type === "text/event-stream" && s1.events.length === 1 && s1.events[0].event === "error" && s1.events[0].data.code === "bad_json" && s1.events[0].data.message.includes(name) && s1.ended, s1);
  rmSync(entry);
  const s2 = await stream(us.port);
  check("a new stream after the entry is removed carries the state again", s2.events[0]?.event === "state" && typeof s2.events[0].data.revision === "number", s2);
  const pj = JSON.parse(readFileSync(join(d, "project.json"), "utf8")); delete pj.revision; writeFileSync(join(d, "project.json"), JSON.stringify(pj));
  const s3 = await stream(us.port);
  check("over a project.json with no valid revision the stream carries that file's own error and ends", s3.events.length === 1 && s3.events[0].event === "error" && s3.events[0].data.code === "bad_revision" && s3.ended, s3);
  us.server.closeAllConnections?.();
  await new Promise((ok) => us.server.close(ok));
}

{
  const d = join(tmp, "history-name-reuse");
  const created = api.create(d, { preset: "reels" });
  const first = await applyLatest(d, [{ op: "add_marker", t: 1 }], { label: "first edit" });
  const second = await applyLatest(d, [{ op: "add_marker", t: 2 }], { label: "second edit" });
  const undoDir = join(d, ".agentcut", "history", "undo");
  const reusedName = readdirSync(undoDir).sort().at(-1);
  const historyUi = await startUi(d, { port: 0 });
  await jget("/api/state", { port: historyUi.port });
  const undone = await jget("/api/undo", { method: "POST", body: { revision: second.revision }, port: historyUi.port });
  const replacement = await applyLatest(d, [{ op: "add_marker", t: 3 }], { label: "replacement edit" });
  const latest = await jget("/api/state", { port: historyUi.port });
  const currentName = readdirSync(undoDir).sort().at(-1);
  check("history cache follows a new entry reusing an undone filename and clears redo",
    reusedName === currentName && replacement.revision === undone.j.revision + 1
      && latest.j.history.undo.at(-1)?.label === "replacement edit" && latest.j.history.redo.length === 0,
  { reusedName, currentName, history: latest.j.history, revisions: [created.revision, first.revision, second.revision, undone.j.revision, replacement.revision] });
  historyUi.server.closeAllConnections?.();
  await new Promise((ok) => historyUi.server.close(ok));
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

// ---------------------------------------------------------------- chat: the agent CLI (a stand-in claude here) on one message, its events to every page
console.log("chat");
{
  const { chatLaunch, chatEvents, piEvents, acpAllowed } = await import("../src/chat.ts");
  const a = chatLaunch("claude", "/p/root", "s0").args, mcp = JSON.parse(a[a.indexOf("--mcp-config") + 1]).mcpServers.agentcut;
  check("chatArgs: streamed JSON, no built-in tools, only the agentcut MCP server for the project, its tools allowed, the session resumed",
    a[0] === "-p" && a[1] === "--output-format" && a[a.indexOf("--output-format") + 1] === "stream-json" && a[a.indexOf("--tools") + 1] === "" && a.includes("--strict-mcp-config")
    && a[a.indexOf("--allowedTools") + 1] === "mcp__agentcut" && a[a.indexOf("--permission-mode") + 1] === "dontAsk" && a[a.indexOf("--resume") + 1] === "s0"
    && mcp.env.AGENTCUT_PROJECT === "/p/root" && existsSync(mcp.args[mcp.args.length - 1]) && mcp.args[mcp.args.length - 1].endsWith("mcp.ts"), a);
  const pi = chatLaunch("pi", "/p/root", "s0"), omp = chatLaunch("omp", "/p/root", "s0"), named = (f: [string, string][]) => f.map(([p, t]) => [p, JSON.parse(t).mcpServers.agentcut.env.AGENTCUT_PROJECT]);
  check("chatLaunch pi: a scratch folder whose .pi/mcp.json names the project's server, trusted for the run; only codemode and agentcut's tools; the session resumed",
    pi.cwd === join("/p/root", ".agentcut", "chat", "pi") && JSON.stringify(named(pi.files)) === JSON.stringify([[join(pi.cwd, ".pi", "mcp.json"), "/p/root"]]) && !pi.acp
    && pi.args.includes("--approve") && pi.args[pi.args.indexOf("--tools") + 1] === "codemode,mcp__agentcut*" && pi.args[pi.args.indexOf("--mode") + 1] === "json" && pi.args[pi.args.indexOf("--session") + 1] === "s0", pi);
  check("chatLaunch omp: a scratch .mcp.json, no built-in tools or extensions; the session resumed; agy and devin speak ACP in the project folder",
    omp.cwd === join("/p/root", ".agentcut", "chat", "omp") && JSON.stringify(named(omp.files)) === JSON.stringify([[join(omp.cwd, ".mcp.json"), "/p/root"]]) && omp.args.includes("--no-tools") && omp.args.includes("--no-extensions")
    && omp.args[omp.args.indexOf("--resume") + 1] === "s0" && chatLaunch("agy", "/p/root").acp && chatLaunch("devin", "/p/root").acp && chatLaunch("devin", "/p/root").cwd === "/p/root", omp);
  const pe = (lines: unknown[]) => { const last = {}; return JSON.stringify(lines.flatMap((o) => piEvents(JSON.stringify(o), last))); };
  check("piEvents: the session, a finished assistant message's text and tool calls (server prefix dropped), tool results, the end with the session; a failed model request ends with its error",
    pe([{ type: "session", id: "p1" }, { type: "message_update" }, { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "ok" }, { type: "toolCall", name: "mcp__agentcut_project_info", arguments: { a: 1 } }] } },
      { type: "message_end", message: { role: "toolResult", isError: true, content: [{ type: "text", text: "conflict" }] } }, { type: "agent_end" }])
      === '[{"kind":"session","session":"p1"},{"kind":"text","text":"ok"},{"kind":"tool","name":"project_info","input":{"a":1}},{"kind":"tool_result","ok":false,"text":"conflict"},{"kind":"done","session":"p1"}]'
    && pe([{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "quota", content: [] } }, { type: "agent_end" }]) === '[{"kind":"done","error":"quota"}]');
  check("acpAllowed: an agentcut MCP tool is allowed; a shell command, a file write or another server's tool is not, whatever its title says",
    acpAllowed({ name: "mcp_agentcut_project_info" }) && acpAllowed({ name: "mcp__agentcut__apply_ops" }) && !acpAllowed({ name: "run_command", title: "mcp_agentcut_x" }) && !acpAllowed({ name: "write_file" })
    && !acpAllowed({ name: "mcp_devin_ask" }) && !acpAllowed({ name: "mcp_agentcut_x; rm" }) && !acpAllowed({}));
  const ev = (o: unknown) => JSON.stringify(chatEvents(JSON.stringify(o)));
  check("chatEvents: the session, text and tool calls (server prefix dropped), tool results, the end; anything else is no event",
    ev({ type: "system", subtype: "init", session_id: "s1" }) === '[{"kind":"session","session":"s1"}]'
    && ev({ type: "assistant", message: { content: [{ type: "text", text: "ok" }, { type: "tool_use", name: "mcp__agentcut__apply_ops", input: { revision: 0 } }] } }) === '[{"kind":"text","text":"ok"},{"kind":"tool","name":"apply_ops","input":{"revision":0}}]'
    && ev({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: [{ type: "text", text: "conflict" }] }] } }) === '[{"kind":"tool_result","ok":false,"text":"conflict"}]'
    && ev({ type: "result", subtype: "success", session_id: "s1", result: "done" }) === '[{"kind":"done","session":"s1"}]' && ev({ type: "rate_limit" }) === "[]" && JSON.stringify(chatEvents("not json")) === "[]");
  if (process.platform !== "win32") {
    const bin = join(tmp, "chat-bin"), argsFile = join(tmp, "chat.args"), slow = join(tmp, "chat.slow");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ncat > "${argsFile}.msg"\npwd -P > "${argsFile}.cwd"\n[ -f "${slow}" ] && exec sleep 30\n`
      + `echo '{"type":"system","subtype":"init","session_id":"s1"}'\necho '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello"},{"type":"tool_use","name":"mcp__agentcut__project_info","input":{}}]}}'\n`
      + `echo '{"type":"user","message":{"content":[{"type":"tool_result","content":"rev 3"}]}}'\necho '{"type":"result","subtype":"success","session_id":"s1","result":"Hello"}'\n`, { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    try {
      const idle = async () => { for (let i = 0; i < 100; i++) { if (!(await jget("/api/chat")).j.busy) return true; await Bun.sleep(50); } return false; };
      const first = await jget("/api/chat", { method: "POST", body: { message: "- hi there" } });
      const got = (k: string) => waitEvent((e) => e.event === "chat" && e.data.kind === k);
      check("POST /api/chat runs the agent: the message, its text, tool call, tool result and end reach every page as chat events", first.j.ok && await got("user") && await got("text") && await got("tool") && await got("tool_result") && await got("done")
        && events.some((e) => e.event === "chat" && e.data.kind === "tool" && e.data.name === "project_info"), events.filter((e) => e.event === "chat").map((e) => e.data));
      check("  in the project folder, with the message on stdin (a leading '-' is not an option), and the next message resumes its session", await idle() && (await jget("/api/chat")).j.session === "s1"
        && readFileSync(argsFile + ".msg", "utf8") === "- hi there" && !readFileSync(argsFile, "utf8").includes("hi there") && readFileSync(argsFile + ".cwd", "utf8").trim() === realpathSync(dir) && (await jget("/api/chat", { method: "POST", body: { message: "more" } })).j.ok && await idle()
        && readFileSync(argsFile, "utf8").includes("--resume\ns1\n"), readFileSync(argsFile, "utf8"));
      writeFileSync(slow, "");
      const run = await jget("/api/chat", { method: "POST", body: { message: "slow" } }), again = await jget("/api/chat", { method: "POST", body: { message: "x" } });
      check("  one run at a time: a second message while it answers is busy (409)", run.j.ok && again.status === 409 && again.j.error.code === "busy", again);
      const t0 = Date.now(), stop = await jget("/api/chat/stop", { method: "POST", body: {} });
      check("  stop ends the run at once and says so", stop.j.stopping === true && await idle() && Date.now() - t0 < 3000 && await waitEvent((e) => e.event === "chat" && e.data.kind === "done" && e.data.stopped === true));
      rmSync(slow);
      const reset = await jget("/api/chat/reset", { method: "POST", body: {} }), empty = await jget("/api/chat", { method: "POST", body: { message: "  " } });
      check("  New chat forgets the session; an empty message is bad_request", reset.j.ok && (await jget("/api/chat")).j.session === null && empty.status === 400, empty.j);
      process.env.PATH = "/usr/bin:/bin";
      const none = await jget("/api/chat"), refused = await jget("/api/chat", { method: "POST", body: { message: "hi" } });
      check("with no agent CLI on PATH the panel is told how to install one, and a message is missing_dependency", none.j.available === false && /Claude Code \(claude\), pi, omp/.test(none.j.hint) && refused.j.error?.code === "missing_dependency", [none.j, refused.j]);
    } finally { process.env.PATH = PATH; }
    // pi (a stand-in printing pi's JSON lines) in its scratch folder, then agy (a stand-in ACP agent): permissions, a resumed session without its replayed history, ask mode
    const piArgs = join(tmp, "pi.args"), acpLog = join(tmp, "acp.log");
    writeFileSync(join(bin, "pi"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${piArgs}"\npwd -P > "${piArgs}.cwd"\ncat > /dev/null\n`
      + `echo '{"type":"session","id":"p1"}'\necho '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Pi here"},{"type":"toolCall","name":"codemode","arguments":{"code":"x"}}]}}'\n`
      + `echo '{"type":"message_end","message":{"role":"toolResult","isError":false,"content":[{"type":"text","text":"rev 3"}]}}'\necho '{"type":"agent_end"}'\n`, { mode: 0o755 });
    writeFileSync(join(bin, "agy"), `#!${process.execPath}
const fs = require("node:fs"), log = (x) => fs.appendFileSync(${JSON.stringify(acpLog)}, JSON.stringify(x) + "\\n"), out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
const up = (u) => out({ method: "session/update", params: { sessionId: "a1", update: u } });
let prompt;
require("node:readline").createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") return out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (m.method === "session/new") { log({ new: m.params }); return out({ id: m.id, result: { sessionId: "a1", modes: { currentModeId: "code", availableModes: [{ id: "code" }, { id: "ask" }] } } }); }
  if (m.method === "session/load") { log({ load: m.params.sessionId }); up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD" } }); return out({ id: m.id, result: { modes: { currentModeId: "ask", availableModes: [{ id: "ask" }] } } }); }
  if (m.method === "session/set_mode") { log({ mode: m.params.modeId }); return out({ id: m.id, result: {} }); }
  if (m.method === "session/prompt") {
    prompt = m.id; log({ prompt: m.params.prompt[0].text });
    up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } }); up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    up({ sessionUpdate: "tool_call", toolCallId: "t1", name: "mcp_agentcut_project_info", status: "pending", rawInput: {} });
    return out({ id: 900, method: "session/request_permission", params: { sessionId: "a1", toolCall: { name: "mcp_agentcut_project_info" }, options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } });
  }
  if (m.id === 900) { log({ p900: m.result.outcome.optionId }); return out({ id: 901, method: "session/request_permission", params: { sessionId: "a1", toolCall: { name: "run_command", title: "rm -rf x" }, options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } }); }
  if (m.id === 901) { log({ p901: m.result.outcome.optionId }); up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: "rev 3" }); return out({ id: prompt, result: { stopReason: "end_turn" } }); }
});
`, { mode: 0o755 });
    process.env.PATH = `${bin}:${PATH}`;
    try {
      const idle = async () => { for (let i = 0; i < 100; i++) { if (!(await jget("/api/chat")).j.busy) return true; await Bun.sleep(50); } return false; };
      const since = (n: number) => events.slice(n).filter((e) => e.event === "chat").map((e) => e.data);
      const eng = await jget("/api/chat"), bad = await jget("/api/chat", { method: "POST", body: { message: "hi", cli: "bash" } });
      check("the panel lists the agent CLIs found on PATH; an unknown CLI is bad_request", eng.j.clis.includes("pi") && eng.j.clis.includes("agy") && bad.status === 400 && bad.j.error.code === "bad_request", [eng.j, bad.j]);
      let n = events.length;
      await jget("/api/chat", { method: "POST", body: { message: "hi", cli: "pi" } });
      check("POST /api/chat with cli pi: run in its scratch folder, whose .pi/mcp.json names this project's server; its text, tool call, result and end reach the page",
        await idle() && JSON.stringify(since(n).map((e) => e.kind)) === '["user","session","text","tool","tool_result","done"]' && since(n)[2].text === "Pi here"
        && readFileSync(piArgs + ".cwd", "utf8").trim() === realpathSync(join(dir, ".agentcut", "chat", "pi")) && JSON.parse(readFileSync(join(dir, ".agentcut", "chat", "pi", ".pi", "mcp.json"), "utf8")).mcpServers.agentcut.env.AGENTCUT_PROJECT === dir, since(n));
      await jget("/api/chat", { method: "POST", body: { message: "again", cli: "pi" } });
      check("  the next pi message resumes its session; switching to agy starts a new conversation", await idle() && readFileSync(piArgs, "utf8").includes("--session\np1\n"), readFileSync(piArgs, "utf8"));
      n = events.length;
      await jget("/api/chat", { method: "POST", body: { message: "edit it", cli: "agy" } });
      const log1 = () => readFileSync(acpLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      check("agy over ACP: a new session with the agentcut server for this project, ask mode, the instructions before the first message; the agentcut tool allowed, the shell command refused; text in one piece",
        await idle() && JSON.stringify(since(n).map((e) => e.kind)) === '["user","session","text","tool","tool_result","done"]' && since(n)[2].text === "Hello" && since(n)[3].name === "project_info"
        && since(n)[4].ok === true && since(n)[5].session === "a1"
        && log1()[0].new.mcpServers[0].name === "agentcut" && log1()[0].new.mcpServers[0].env[0].value === dir && log1()[1].mode === "ask" && /AgentCut UI[\s\S]*edit it$/.test(log1()[2].prompt)
        && log1()[3].p900 === "yes" && log1()[4].p901 === "no", [since(n), log1()]);
      n = events.length;
      await jget("/api/chat", { method: "POST", body: { message: "more", cli: "agy" } });
      check("  the next agy message loads its session without showing the replayed history, and sends the message alone",
        await idle() && !since(n).some((e) => e.text === "OLD" || e.text === "OLDHello") && log1()[5].load === "a1" && log1()[6].prompt === "more", [since(n), log1().slice(5)]);
    } finally { process.env.PATH = PATH; }
  }
}

// ---------------------------------------------------------------- dashboard: `agentcut ui` on a folder of projects
console.log("dashboard");
{
  const { startDashboard } = await import("../src/ui.ts");
  const home = join(tmp, "projects");
  mkdirSync(home);
  api.create(join(home, "alpha"), { preset: "square" });
  ff("-f", "lavfi", "-i", "color=c=red:size=64x64", "-frames:v", "1", join(home, "alpha", "media", "red.png"));
  await applyLatest(join(home, "alpha"), [{ op: "add_clip", track: "main", src: join(home, "alpha", "media", "red.png"), duration: 2 }]);
  mkdirSync(join(home, "not-a-project"));
  api.create(join(home, "damaged"), { preset: "square" });
  const { revision: _, ...norev } = JSON.parse(readFileSync(join(home, "damaged", "project.json"), "utf8"));
  writeFileSync(join(home, "damaged", "project.json"), JSON.stringify(norev));
  const db = await startDashboard(home, { port: 0 }), at = { port: db.port };
  try {
    const list = await jget("/api/projects", at);
    const listed = list.j.ok ? list.j.projects : [], damaged = listed.find((p: any) => p.name === "damaged");
    check("the dashboard lists the project folders in it (not other folders), with size, length and revision", JSON.stringify(listed.filter((p: any) => p !== damaged).map((p: any) => [p.name, p.width, p.duration, p.revision])) === '[["alpha",1080,2,1]]', list.j);
    check("  a project.json with no valid revision is listed with the editor's bad_revision text, not a revision", damaged && damaged.revision === undefined && /no valid 'revision'/.test(damaged.error), damaged);
    const page = await raw("/", at);
    check("  its page is the editor's page marked as the dashboard", page.status === 200 && page.body.toString().includes('<div id="app" data-dashboard>'));
    const th = await raw("/api/projects/alpha/thumb", at);
    check("  a project's picture is a JPEG frame of it", th.status === 200 && th.type === "image/jpeg" && th.body[0] === 0xff, th.status);
    const made = await jget("/api/create", { ...at, method: "POST", body: { name: "beta", preset: "reels" } });
    check("create makes a project with that preset", made.j.ok && api.openProject(join(home, "beta")).load().settings.height === 1920, made.j);
    const codes = await Promise.all([{ name: "beta" }, { name: "../x" }, { name: ".hid" }, { name: 3 }].map(async (b) => (await jget("/api/create", { ...at, method: "POST", body: b })).j.error?.code));
    check("  an existing name is exists; a path, a dot name or no text is bad_value", JSON.stringify(codes) === '["exists","bad_value","bad_value","bad_value"]', codes);
    const dup = await jget("/api/duplicate", { ...at, method: "POST", body: { name: "alpha", as: "alpha2" } });
    const copy = api.openProject(join(home, "alpha2")).load();
    check("duplicate copies the timeline (renamed) and its media into a new project", dup.j.ok && copy.name === "alpha2" && copy.tracks[0].clips.length === 1 && existsSync(join(home, "alpha2", "media", "red.png")) && Object.values(copy.assets).every((a: any) => a.path === join("media", "red.png"))
      && (await api.info(join(home, "alpha2"), "json")).errors === 0, copy);
    // media beside project.json (linked by a relative path, not under media/) is copied too; the history, previews and renders are not
    ff("-f", "lavfi", "-i", "color=c=blue:size=64x64", "-frames:v", "1", join(home, "alpha", "beside.png"));
    mkdirSync(join(home, "alpha", "renders"), { recursive: true }); writeFileSync(join(home, "alpha", "renders", "old.mp4"), "x");
    await applyLatest(join(home, "alpha"), [{ op: "add_clip", track: "overlay", src: join(home, "alpha", "beside.png"), at: 0, duration: 1 }]);
    const dup3 = await jget("/api/duplicate", { ...at, method: "POST", body: { name: "alpha", as: "alpha3" } }), c3 = api.openProject(join(home, "alpha3"));
    check("duplicate copies media beside the timeline, and starts with no renders and a fresh history", dup3.j.ok && existsSync(join(home, "alpha3", "beside.png")) && (await api.info(join(home, "alpha3"), "json")).errors === 0
      && !existsSync(join(home, "alpha3", "renders", "old.mp4")) && api.history(join(home, "alpha3")).undo.length === 0 && c3.load().name === "alpha3", { dup: dup3.j, hist: api.history(join(home, "alpha3")) });
    const o1 = await jget("/api/open", { ...at, method: "POST", body: { name: "alpha" } }), o2 = await jget("/api/open", { ...at, method: "POST", body: { name: "alpha" } });
    const ed = o1.j.ok && await jget("/api/state", { port: Number(new URL(o1.j.url).port) });
    check("open starts that project's editor once and answers its URL", o1.j.ok && o2.j.url === o1.j.url && ed && ed.j.project === realpathSync(join(home, "alpha")), { o1: o1.j, state: ed && Object.keys(ed.j) });
    const gone = await jget("/api/open", { ...at, method: "POST", body: { name: "nope" } }), host = await raw("/api/projects", { ...at, host: "evil.test" });
    check("  a name with no project is not_found; another host is refused", gone.j.error?.code === "not_found" && host.status === 403, [gone.j, host.status]);
  } finally {
    db.server.closeAllConnections?.();
    await new Promise((ok) => db.server.close(ok));
  }
  check("a folder that does not exist is not_found", await startDashboard(join(tmp, "nowhere")).then(() => "started", (e) => e.code) === "not_found");
}

// ---------------------------------------------------------------- page modules (src/ui): the ones with no DOM, checked under bun
console.log("page modules");
{
  const { num } = await import("../src/ui/time.ts");
  const { viewOf, clipOrder, resolveRef } = await import("../src/ui/view.ts");
  const { pts, packKf, kfAt, kfBase, kfTimes } = await import("../src/ui/keyframes.ts");
  const { dragEdit, dropEdit, fieldValue, libEdit, clipWords, cutWords, kfMoveBatch, clipPatch, regroupIds } = await import("../src/ui/edits.ts");
  const { errText, mbOf, frameScale, prepareText } = await import("../src/ui/text.ts");
  const clip = (id: string, o: Record<string, unknown> = {}) => ({ id, type: "color", start: 0, duration: 1, ...o });
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  check("num reads seconds from numbers, ms, s and clock strings", num(1.5) === 1.5 && num("500ms") === 0.5 && num("2s") === 2 && num("1:02") === 62 && num("0:00:01.5") === 1.5, [num("500ms"), num("1:02")]);
  const { parseTime } = await import("../src/model.ts");
  const { parseKfs } = await import("../src/anim.ts");
  check("num shares the renderer's uppercase units and hour clock grammar", num("2.5S") === 2.5 && num("1:02:03") === 3723
    && ["2.5S", "1:02:03", ""].every((v) => num(v) === parseTime(v)));
  check("num returns NaN for garbage and non-time values without throwing", ["garbage", "a:b:c", null, undefined, {}, true].every((v) => Number.isNaN(num(v))));
  check("parseTime still rejects non-finite and invalid times with bad_time", [Infinity, NaN, "garbage"].every((v) => {
    try { parseTime(v); return false; } catch (e: any) { return e.code === "bad_time" && !!e.hint; }
  }));
  const objectKeys = [{ t: 1 }, { t: 1, v: null, value: 3 }];
  check("keyframe object defaults match parseKfs", pts(objectKeys)[0]?.[1] === 0 && pts(objectKeys)[1]?.[1] === 3
    && JSON.stringify(pts(objectKeys)) === JSON.stringify(parseKfs(objectKeys)));
  check("empty keyframes match parseKfs", pts(undefined).length === 0 && parseKfs([]).length === 0);

  // render.ts subT: a nested time u plays at s + (u - in) / speed, level by level; the view is off + k * u
  const inner = clip("ci", { type: "compound", start: 0, in: 1, speed: 2, duration: 1.5, tracks: [{ id: "n", clips: [clip("x1")] }] });
  const outer = clip("co", { type: "compound", start: 1, in: 0.25, speed: 0.5, duration: 3, tracks: [{ id: "m", clips: [inner] }] });
  const tops: any[] = [{ id: "main", clips: [outer] }];
  const two = viewOf(tops, ["co", "ci"]);
  const place = (u: number) => 1 + ((0 + (u - 1) / 2) - 0.25) / 0.5;
  check("viewOf: two opened compounds place a nested time where render plays it, and bound the visible window", two.view.nested && two.path.length === 2
    && [0, 1, 3].every((u) => near(two.view.off + two.view.k * u, place(u))) && near(two.view.lo, 1) && near(two.view.hi, 3.5), two.view);
  check("viewOf: a path that no longer leads to compounds is cut at the first level that does not", JSON.stringify(viewOf(tops, ["co", "gone"]).path) === '["co"]'
    && viewOf(tops, ["nope"]).path.length === 0 && !viewOf(tops, ["nope"]).view.nested && viewOf(tops, []).view.tracks === tops);

  const lanes: any[] = [{ id: "a", clips: [clip("a0", { start: 2 }), clip("a1")] }, { id: "b", clips: [clip("b0")] }];
  const order = clipOrder({ tracks: lanes, off: 0, k: 1, lo: -Infinity, hi: Infinity, nested: false }).map((c) => c.id);
  check("clipOrder is time order with ties in lane order (top lane first); resolveRef takes ids, track#i and track#-i", JSON.stringify(order) === '["b0","a1","a0"]'
    && resolveRef(lanes, "a#-1") === "a1" && resolveRef(lanes, "a#0") === "a0" && resolveRef(lanes, "a#5") === null && resolveRef(lanes, "zz#0") === null && resolveRef(lanes, "plain") === "plain", order);

  const ks = pts([{ t: "500ms", v: 2, ease: "ease_out" }, [0, 1]]);
  check("keyframes: pts sorts both key forms, packKf drops linear easing and clears an empty list, kfAt interpolates, kfBase defaults",
    JSON.stringify(packKf(ks)) === '[[0,1],[0.5,2,"ease_out"]]' && packKf([]) === null && kfAt(ks, 0.25) === 1.5 && kfAt(ks, 9) === 2 && kfAt(ks, -1) === 1
    && kfBase(clip("c"), "x", { width: 1080, height: 1920 }) === 540 && kfBase(clip("c", { opacity: 0.3 }), "opacity", { width: 1, height: 1 }) === 0.3
    && JSON.stringify(kfTimes(clip("c", { keyframes: { x: [[0, 1], [1, 2]], y: [[1, 5], [2, 6]] } }))) === "[0,1,2]", JSON.stringify(packKf(ks)));

  const trk = (id: string, magnetic: boolean, clips: any[]): any => ({ id, magnetic, clips });
  const from = trk("v", false, [clip("m", { start: 5, duration: 2 })]);
  const mag = trk("mag", true, [clip("p", { start: 0, duration: 2 }), clip("q", { start: 2, duration: 2 })]);
  const loose = trk("free", false, []);
  const all = [from, mag, loose];
  const m = from.clips[0];
  check("dragEdit: trimming the head sends trim_start, the tail a duration that stays at least 0.04 s",
    JSON.stringify(dragEdit("l", m, from, all, "v", 0.5, 5, 2)) === '{"ops":[{"op":"trim_clip","id":"m","trim_start":0.5}],"label":"trim_clip m"}'
    && dragEdit("r", m, from, all, "v", 0.5, 5, 2).ops[0].duration === 2.5 && dragEdit("r", m, from, all, "v", -9, 5, 2).ops[0].duration === 0.04);
  check("dragEdit: a move to a free lane sets the track and a start that is never negative; to a magnetic lane it sets the index by clip midpoints",
    JSON.stringify(dragEdit("move", m, from, all, "free", -9, 5, 2).ops) === '[{"op":"move_clip","id":"m","track":"free","at":0}]'
    && JSON.stringify(dragEdit("move", m, from, all, "mag", -3.5, 5, 2).ops) === '[{"op":"move_clip","id":"m","track":"mag","index":1}]'
    && JSON.stringify(dragEdit("move", m, from, all, "v", 0.25, 5, 2).ops) === '[{"op":"move_clip","id":"m","at":5.25}]');
  const att = clip("t", { attach_to: "m", offset: "0.5s" });
  check("dragEdit: a connected clip moves by changing its offset, after the track change when the lane differs",
    JSON.stringify(dragEdit("move", att, from, all, "free", 0.25, 0, 1)) === '{"ops":[{"op":"move_clip","id":"t","track":"free"},{"op":"update_clip","id":"t","set":{"offset":0.75}}],"label":"move t"}'
    && JSON.stringify(dragEdit("move", att, from, all, "v", -0.25, 0, 1).ops) === '[{"op":"update_clip","id":"t","set":{"offset":0.25}}]');

  const a1 = { asset: "a1" };
  check("dropEdit: a clip dropped on a free lane starts at the drop time (never below 0); on a magnetic lane it goes before the first clip whose middle is later",
    JSON.stringify(dropEdit(loose, a1, 2.34567)) === '{"op":"add_clip","track":"free","asset":"a1","at":2.346}' && dropEdit(loose, a1, -1).at === 0
    && dropEdit(mag, a1, 0.9).index === 0 && dropEdit(mag, a1, 1.1).index === 1 && dropEdit(mag, a1, 9).index === 2);
  const lib = (kind: string, name: string, c: Record<string, unknown> | null) => JSON.stringify(libEdit(kind, name, c as any));
  check("libEdit: an effect goes on the clip or the whole video; a look only on a picture; a transition into any clip; a preset only on its own clip type",
    lib("effect", "vhs", null) === '{"op":"add_effect","type":"vhs"}' && lib("effect", "vhs", clip("c")) === '{"op":"add_effect","id":"c","type":"vhs"}'
    && lib("look", "warm", clip("v", { type: "video" })) === '{"op":"update_clip","id":"v","set":{"color":{"look":"warm"}}}' && lib("look", "warm", clip("c")) === "null" && lib("look", "warm", null) === "null"
    && lib("transition", "zoom", clip("c")) === '{"op":"add_transition","to":"c","type":"zoom"}'
    && lib("text", "neon", clip("t", { type: "text" })) === '{"op":"update_clip","id":"t","set":{"preset":"neon"}}' && lib("text", "neon", clip("k", { type: "captions" })) === "null"
    && lib("caption", "pill", clip("k", { type: "captions" })) === '{"op":"update_clip","id":"k","set":{"preset":"pill"}}');
  const tc = clip("tv", { type: "video", start: 10, in: 1, speed: 2, duration: 2 }); // plays media 1..5
  const tw = clipWords(tc, [{ text: "a", start: 0.2, end: 0.8 }, { text: "b", start: 1.6, end: 2.4 }, { text: "c", start: 4.6, end: 5.4 }]);
  check("clipWords: media times through in and speed onto the timeline; a word the clip does not play is off",
    !tw[0].on && tw[1].on && near(tw[1].t0, 10.3) && near(tw[1].t1, 10.7) && tw[2].on && near(tw[2].t1, 12.2), tw);
  check("cutWords: one remove_range over the picked words in either order, kept inside the clip",
    JSON.stringify(cutWords(tc, tw, 2, 1)) === '{"op":"remove_range","id":"tv","start":10.3,"end":12}', cutWords(tc, tw, 2, 1));
  const thrown = (f: () => unknown) => { try { f(); return null; } catch (e: any) { return e.code; } };
  check("fieldValue: empty removes the field, numbers and booleans where the field takes them, text where it takes strings, else bad_value",
    fieldValue(["number"], " ") === null && fieldValue(["number", "string"], "2.5") === 2.5 && fieldValue(["number", "string"], "50%") === "50%" && fieldValue(["boolean", "number"], "true") === true
    && fieldValue(["string"], "12") === "12" && thrown(() => fieldValue(["number"], "abc")) === "bad_value" && thrown(() => fieldValue(["boolean"], "yes")) === "bad_value");
  const kc = clip("k", { duration: 3, keyframes: { opacity: [[0, 1], [1, 0.5]], scale: [[0.5, 1]] } });
  check("kfMoveBatch: moves the points at the dragged time on every prop that has one, clamped to the clip",
    JSON.stringify(kfMoveBatch(kc, 1, 0.5)) === '[{"op":"set_keyframes","id":"k","prop":"opacity","keyframes":[[0,1],[1.5,0.5]]}]'
    && (kfMoveBatch(kc, 1, 10)[0].keyframes as number[][])[1][0] === 3);

  const was = { id: "a", text: "x", color: { exposure: 0.2, contrast: 0.1 }, keyframes: { opacity: [[0, 1]] } };
  const p1 = clipPatch(was, { id: "a", text: "y", color: { exposure: 0.2 }, keyframes: { opacity: [[0, 1]] } });
  const p2 = clipPatch(was, { id: "a", text: "x", keyframes: { scale: [[0, 1]] } });
  check("clipPatch: a key removed inside a nested field is sent as null, a removed field as null, keyframes replace whole, no change is zero keys",
    JSON.stringify(p1) === '{"set":{"text":"y","color":{"exposure":0.2,"contrast":null}},"n":2}'
    && JSON.stringify(p2) === '{"set":{"keyframes":{"scale":[[0,1]]},"color":null},"n":2}' && clipPatch(was, JSON.parse(JSON.stringify(was))).n === 0, [p1, p2]);

  const gt: any[] = [{ id: "q", clips: [clip("g1", { group: { id: "ga" } }), clip("g2", { group: { id: "ga" } }), clip("g3", { group: { id: "gb" } }), clip("g4", { group: { id: "g1" } }),
    clip("cm", { type: "compound", tracks: [{ id: "i", clips: [clip("gb")] }] })] }];
  check("regroupIds: one id per stamped group, none when a clip, nested ones included, already has that id", JSON.stringify(regroupIds(gt)) === '["ga"]', regroupIds(gt));

  check("errText shows [code] message, the hint and one line per issue; mbOf keeps two decimals under 1 MB; frameScale steps in quarters from 0.25 to 1",
    errText({ code: "conflict", message: "stale", hint: "reload", issues: [{ path: "a.b", message: "bad", hint: "h" }] }) === "[conflict] stale\nhint: reload\n- a.b: bad (h)" && errText("plain") === "plain"
    && mbOf(500000, 500000) === "0.50" && mbOf(176e6, 176e6) === "176" && frameScale(640, 360, 1080, 1080, 1) === 0.5 && frameScale(9999, 9999, 100, 100, 2) === 1 && frameScale(10, 10, 1000, 1000, 1) === 0.25
    && prepareText({ id: "j", status: "running", progress: 0.456 }) === "Preparing 46%" && prepareText({ id: "j", status: "running", progress: 0, download: { model: "m", bytes: 5e6, total_bytes: 10e6 } }) === "Downloading m 5/10 MB");
}

// ---------------------------------------------------------------- the page bundle's assembly (scripts/build-ui.ts)
console.log("page assembly");
{
  const { assemble, pageModule } = await import("../scripts/build-ui.ts");
  const shell = '<link rel="stylesheet" href="{{STYLE}}"><script defer src="{{SCRIPT}}"></script>';
  check("assemble names each asset once, by its URL", assemble(shell, "app.a.css", "app.b.js") === '<link rel="stylesheet" href="/assets/app.a.css"><script defer src="/assets/app.b.js"></script>');
  const text = "a`b${c}</script><!--\n\\n   end\n";
  const gen = join(tmp, "page-gen-probe.ts");
  writeFileSync(gen, pageModule({ html: text, assets: { "app.x.js": text } }));
  const mod = await import(gen);
  check("pageModule: the generated module exports the page and its assets exactly, backticks, ${, </script> and line breaks included", mod.PAGE === text && mod.ASSETS["app.x.js"] === text);
}

// ---------------------------------------------------------------- the browser suite has no skip
console.log("browser gate");
{
  const missing = join(tmp, "no-such-chrome");
  const r = spawnSync(process.execPath, ["--no-install", resolve(import.meta.dir, "ui-browser.ts")], { env: { ...process.env, CHROME: missing }, encoding: "utf8", timeout: 30000 });
  check("ui-browser fails, and names the path, when the Chrome it is given does not exist (it does not skip)", r.status === 1 && (r.stdout + r.stderr).includes(missing), { status: r.status, out: (r.stdout + r.stderr).slice(0, 300) });
}

// ---------------------------------------------------------------- every Chrome launch of the suite is contained (none of these rows starts Chrome)
console.log("chrome containment");
{
  // (the rows that need this host's sandbox-exec and installed Chrome are in ui-browser.ts, next to the launch)
  const home = "/home/pinned", text = profileText(home), lines = (t: string, kind: string) => t.split("\n").filter((l) => l.startsWith(`(${kind} `));
  check("the profile allows only loopback and Chrome's own profile-lock socket beyond the default", JSON.stringify(lines(text, "allow")) === JSON.stringify([
    "(allow default)", '(allow network-bind (local ip "localhost:*"))', '(allow network-inbound (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))', SINGLETON_ALLOW]), text);
  const denies = [
    String.raw`(deny process-exec (regex #"[Gg]oogle[Uu]pdater") (regex #"[Kk]eystone") (regex #"[Kk]sadmin") (regex #"launchctl"))`,
    String.raw`(deny mach-lookup (global-name-regex #"^com\.google\.([Gg]oogle[Uu]pdater|[Kk]eystone)"))`,
    "(deny lsopen)",
    `(deny file-write* (subpath "${home}/Library/Google") (subpath "${home}/Library/Application Support/Google/GoogleUpdater") (subpath "${home}/Library/LaunchAgents") (subpath "/Library/Google") (subpath "/Library/LaunchAgents") (subpath "/Library/LaunchDaemons"))`,
    "(deny network*)"];
  check("the profile denies exec of the update helpers, their mach names, lsopen, writes to the update directories, and the network, in that order", JSON.stringify(lines(text, "deny")) === JSON.stringify(denies), lines(text, "deny"));
  const noSandbox = "--no-" + "sandbox"; // written apart so this file does not name the flag the row looks for
  check("Chrome's own sandbox is switched off only in tests/chrome.ts, next to the profile: the flag list is pinned and no other test file names the flag",
    JSON.stringify(CONTAINED_FLAGS) === JSON.stringify(["--disable-background-networking", "--disable-component-update", noSandbox])
    && readdirSync(resolve(import.meta.dir)).filter((f) => f.endsWith(".ts") && f !== "chrome.ts" && readFileSync(resolve(import.meta.dir, f), "utf8").includes(noSandbox)).length === 0, CONTAINED_FLAGS);
  check("without sandbox-exec, or off macOS, there is no containment (the suite fails; there is no uncontained path)",
    containmentProblem("linux") === "no Chrome containment on linux" && /is missing/.test(containmentProblem("darwin", join(tmp, "no-sandbox-exec")) ?? "") && containmentProblem("darwin", process.execPath) === null);
  const own = readdirSync(resolve(import.meta.dir)).filter((f) => f.endsWith(".ts") && f !== "chrome.ts");
  const direct = own.filter((f) => spawnsChromeDirectly(readFileSync(resolve(import.meta.dir, f), "utf8")));
  check("no test file but tests/chrome.ts starts Chrome (the detector flags a direct spawn, and none of the files has one)",
    spawnsChromeDirectly("const c = spawn(" + "CHROME, []);") && direct.length === 0, direct);
}

ctl.abort();
ui.server.closeAllConnections?.();
await new Promise((ok) => ui.server.close(ok));
await api.closeFrameCache(dir);
check("closing the UI server drops its frame Renderer cache", api.frameCacheSize(dir) === 0, api.frameCacheSize(dir));
if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true });
console.log(failures() ? `\n${failures()} FAILED` : "\nall ui checks passed");
process.exit(failures() ? 1 : 0);
