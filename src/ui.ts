// `agentcut ui`: local web UI (127.0.0.1 only) to watch and steer a project. Every edit goes through api.apply with the
// revision the page saw, so a stale page gets a "conflict" instead of overwriting an agent's work. Changes made by other
// processes (CLI/MCP) are picked up by polling project.json and pushed to the page over Server-Sent Events.
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, linkSync, mkdtempSync, realpathSync, rmSync, statSync, unwatchFile, utimesSync, watchFile } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import * as api from "./api.ts";
import { inp, VIDEO_MAP } from "./ffinput.ts";
import { endJob } from "./jobs.ts";
import { AUDIO_EXT, IMAGE_EXT, seekArgs } from "./media.ts";
import { type Asset, EditError, resolve as resolveTimeline, totalDuration, type Dict, type VideoFacts } from "./model.ts";
import { UI_AUTHOR } from "./project.ts";
import { ensureDir } from "./safe-write.ts";
import { PAGE } from "./ui/page.gen.ts";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
  ".fcpxml": "application/xml", ".otio": "application/json",
};
const STATUS: Record<string, number> = { conflict: 409, bad_revision: 400, missing_revision: 400, forbidden: 403, not_found: 404, bad_json: 400, bad_request: 400 };
const SERVED_DIRS = ["renders", "previews"]; // besides project assets, only outputs are served
/** what a file dropped on the page may be: the media import_media takes */
const UPLOAD_EXT = new Set([...IMAGE_EXT, ...AUDIO_EXT, ".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".gif", ".json"]);

export async function startUi(project: string | undefined, o: { port?: number } = {}) {
  if (o.port !== undefined && !(Number.isInteger(o.port) && o.port >= 0 && o.port <= 65535)) throw new EditError(`port must be a whole number from 0 to 65535, got ${JSON.stringify(o.port)}`, "bad_value", "e.g. 4810; 0 picks a free port");
  const p = api.openProject(project);
  const root = p.root;
  const clients = new Set<ServerResponse>();
  const jobs = new Map<string, Dict>();
  const playing = new Map<string, Dict>(); // play output path -> running job
  let preparing: Dict | null = null; // the running prepare job: a second request joins it
  const running = new Map<string, { ctl: AbortController; settled: Promise<unknown> }>(); // job id -> its abort and its end, while it runs
  const thumbs = new Map<string, Promise<Buffer>>();
  const cacheDir = join(root, "previews", "ui");
  let assetsKey: string | undefined;
  let assets: Record<string, Asset> | undefined;

  const state = async (): Promise<Dict> => ({ ...(await api.info(root, "json")), history: p.history() });
  const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event: string, data: unknown) => { for (const c of clients) send(c, event, data); };
  const fileUrl = (abs: string) => "/files/" + relative(root, abs).split(sep).map(encodeURIComponent).join("/");

  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "frame-ancestors 'none'");
    try { await route(req, res); }
    catch (e: any) {
      const status = e instanceof EditError ? (STATUS[e.code] ?? 422) : 500;
      if (!res.headersSent) json(res, status, { ok: false, error: errJson(e) }); else res.end();
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    let url: URL, path: string;
    try { url = new URL(req.url ?? "/", "http://x"); path = decodeURIComponent(url.pathname); }
    catch { throw new EditError("the request target is not a valid URL path", "bad_request"); }
    // DNS-rebinding / cross-site guards: only our own host, same-origin JSON writes
    const port = (server.address() as any).port;
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host ?? "")) return json(res, 403, { ok: false, error: { code: "forbidden", message: "bad host" } });
    if (path.split("/").includes("..") || path.includes("\0")) return json(res, 403, { ok: false, error: { code: "forbidden", message: "path traversal rejected" } });
    if (req.method === "POST") {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { ok: false, error: { code: "forbidden", message: "cross-origin request" } });
      // an upload is the file's bytes; every other POST is JSON. Neither type can be sent cross-site without a preflight, which this server never answers.
      const want = path === "/api/upload" ? "application/octet-stream" : "application/json";
      if (!String(req.headers["content-type"]).startsWith(want)) return json(res, 415, { ok: false, error: { code: "bad_request", message: `POST ${path === "/api/upload" ? "/api/upload takes the file as" : "bodies must be"} ${want}` } });
    }
    if (req.method === "POST" && path === "/api/upload") return json(res, 200, { ok: true, path: await upload(req, url.searchParams.get("name")) });

    if (req.method === "GET" && path === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(PAGE); }
    if (req.method === "GET" && path === "/api/state") return json(res, 200, { ok: true, ...(await state()) });
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      let ping: ReturnType<typeof setInterval> | undefined;
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      // added to the clients only once the state is in hand, so no newer broadcast is followed by this older one
      let s: Dict;
      try { s = await state(); }
      catch (e) { // the stream ends after the named error: the cure (an entry removed) does not touch project.json, so only a new connection finds the state again
        if (!res.destroyed) { send(res, "error", errJson(e)); res.end(); }
        return;
      }
      if (res.destroyed) return;
      clients.add(res);
      send(res, "state", s);
      ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      return;
    }
    if (req.method === "GET" && path === "/api/frame") {
      const t = Number(url.searchParams.get("t") ?? 0), scale = Number(url.searchParams.get("scale") ?? 0.5);
      if (!Number.isFinite(t) || !Number.isFinite(scale)) throw new EditError("t and scale must be numbers", "bad_request");
      const r = await api.frameImage(root, Math.max(0, t), { scale: Math.min(1, Math.max(0.1, scale)), reuse: true });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store", "x-revision": String(r.revision) });
      return res.end(r.data);
    }
    if (req.method === "GET" && path.startsWith("/api/thumb/")) {
      const a = asset(path.slice("/api/thumb/".length));
      if (a.kind === "image") return sendFile(req, res, a.abs);
      const t = Math.max(0, Number(url.searchParams.get("t")) || 0);
      const st = statSync(a.abs, { throwIfNoEntry: false }), key = `${a.abs}|${st?.mtimeMs}|${st?.size}|${t.toFixed(2)}`; // the file changing (relinked, or replaced in place) is a new picture
      if (!thumbs.has(key)) { if (thumbs.size > 500) thumbs.clear(); thumbs.set(key, thumbnail(a.abs, t, a.kind === "video" ? (a as Dict as VideoFacts) : undefined, a.fps).catch((e) => { thumbs.delete(key); throw e; })); }
      const jpg = await thumbs.get(key); // a failure here is an error response, not an empty cached 200
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-cache" });
      return res.end(jpg);
    }
    if (req.method === "GET" && path.startsWith("/media/")) return sendFile(req, res, asset(path.slice("/media/".length)).abs);
    if (req.method === "GET" && path.startsWith("/files/")) return sendFile(req, res, servedFile(path.slice("/files/".length)));
    if (req.method === "GET" && path.startsWith("/api/jobs/")) {
      const j = jobs.get(path.slice("/api/jobs/".length));
      return j ? json(res, 200, { ok: true, ...j }) : json(res, 404, { ok: false, error: { code: "not_found", message: "no such job" } });
    }

    if (req.method === "POST") {
      const gone = new AbortController(); // the response closes once it is sent or the client goes away; only the second finds work still waiting
      res.on("close", () => gone.abort());
      const body = await readJson(req);
      const rev = body.revision; // as sent: no revision is missing_revision, and anything but a whole number >= 0 is bad_revision that echoes it
      // the page is one person at one browser: its author is the server's own constant, whatever the request body says
      if (path === "/api/ops") return json(res, 200, await api.apply(root, body.ops, { revision: rev, label: body.label, author: UI_AUTHOR, signal: gone.signal }));
      if (path === "/api/undo") return json(res, 200, { ok: true, ...api.undo(root, 1, rev, UI_AUTHOR) });
      if (path === "/api/redo") return json(res, 200, { ok: true, ...api.redo(root, 1, rev, UI_AUTHOR) });
      if (path === "/api/sheet") {
        const r = await api.sheet(root, { count: Number(body.count ?? 12), cols: 4, tileWidth: 320, out: join(cacheDir, `sheet-${Date.now()}.jpg`) });
        return json(res, 200, { ok: true, ...r, url: fileUrl(r.image) });
      }
      const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
      if (cancel) { // a play job shared by several requests is one job: cancelling it stops it for all of them
        const j = jobs.get(cancel[1]), r = running.get(cancel[1]);
        if (!j) throw new EditError("no such job", "not_found");
        if (r) { r.ctl.abort(new EditError("the job was cancelled", "aborted")); await r.settled; }
        return json(res, 200, { ok: j.status !== "failed", ...j }); // the same rule as MCP cancel_job: only a job that ended failed is not ok
      }
      if (path === "/api/render") return json(res, 200, { ok: true, ...render(body) });
      if (path === "/api/prepare") return json(res, 200, { ok: true, ...prepare(body.allow_download === true) });
    }
    json(res, 404, { ok: false, error: { code: "not_found", message: `${req.method} ${path}` } });
  }

  /** play=true: draft of [start,end) into previews/ui/ (cached per revision+range) for the viewer; else a normal render into renders/. */
  function render(body: Dict) {
    const id = Math.random().toString(36).slice(2, 10);
    const job: Dict = { id, kind: body.play ? "play" : "export", status: "running", progress: 0, started: Date.now() };
    let start = Number(body.start ?? 0), end = body.end === undefined ? undefined : Number(body.end);
    let out: string | undefined;
    if (body.play) {
      const tl = resolveTimeline(p.load()), fps = tl.settings.fps, duration = totalDuration(tl);
      if (!Number.isFinite(start) || start < 0 || (end !== undefined && (!Number.isFinite(end) || end <= start)))
        throw new EditError("play range must have a finite non-negative start and an end after start", "bad_value");
      const first = Math.round(start * fps), last = Math.round(Math.min(end ?? duration, duration) * fps);
      if (last <= first) throw new EditError("play range contains no frames", "empty", "choose a range of at least one frame inside the timeline");
      start = first / fps; end = last / fps;
      out = join(cacheDir, `play-r${tl.revision}-f${first}-${last}.mp4`);
    }
    const finish = (r: Dict) => { Object.assign(job, { status: "done", progress: 1, result: r, url: fileUrl(r.output ?? out), sheet_url: r.contact_sheet ? fileUrl(r.contact_sheet) : undefined });  broadcast("job", job); };
    if (out && existsSync(out)) { const now = new Date(); utimesSync(out, now, now); finish({ output: out }); endJob(jobs, id, job); return job; }
    const live = out ? playing.get(out) : undefined;
    if (live && !running.get(live.id)?.ctl.signal.aborted) return live; // same range already rendering: share that job, unless it is being cancelled
    // api.render writes to a .part-<pid>- file and renames to `out` only when complete, so the cache check above never serves a half-written file
    jobs.set(id, job); // every call that can throw is above; from here to the promise chain nothing throws, so a job in `jobs` always reaches its end
    if (out) playing.set(out, job);
    let last = 0;
    const ctl = new AbortController();
    running.set(id, { ctl, settled: api.render(root, {
      out, start, end, draft: !!body.draft || !!body.play, sheet: !body.play, workers: body.play ? 1 : undefined, signal: ctl.signal,
      progress: (d, n) => { job.progress = +(d / n).toFixed(3); const now = Date.now(); if (now - last > 200) { last = now; broadcast("job", job); } },
    }).then(finish)
      .catch((e) => { Object.assign(job, { status: endedAs(ctl, e), error: errJson(e) }); broadcast("job", job); })
      .finally(() => { if (out && playing.get(out) === job) playing.delete(out); running.delete(id); endJob(jobs, id, job); }) });
    return job;
  }

  /** compute mattes / vision analyses and apply the pending vision requests (the slow step not_prepared asks for) */
  function prepare(allowDownload: boolean) {
    if (preparing) return preparing;
    const job: Dict = { id: Math.random().toString(36).slice(2, 10), kind: "prepare", status: "running", progress: 0, started: Date.now() };
    jobs.set(job.id, job);
    preparing = job;
    let last = 0;
    const ctl = new AbortController();
    running.set(job.id, { ctl, settled: Promise.resolve().then(() => api.prepare(root, { allowDownload, author: UI_AUTHOR, signal: ctl.signal, progress: (d, n, download) => { job.progress = n ? +(d / n).toFixed(3) : 0; const changed = download?.model !== job.download?.model; /* appears, disappears or names another model: the page must hear it now */ if (download) job.download = download; else delete job.download; const now = Date.now(); if (changed || now - last > 200) { last = now; broadcast("job", job); } } }))
      .then((r: Dict) => Object.assign(job, { status: "done", progress: 1, result: r }))
      .catch((e) => Object.assign(job, { status: endedAs(ctl, e), error: errJson(e) }))
      .finally(() => { delete job.download; preparing = null; running.delete(job.id); endJob(jobs, job.id, job); broadcast("job", job); }) });
    return job;
  }

  /** a file dropped on the page, into <project>/media/ under its own name (name-1, name-2... when taken; never overwrites). Returns its path for import_media. */
  async function upload(req: IncomingMessage, name: string | null): Promise<string> {
    if (!name || name !== basename(name) || name.startsWith(".") || name.length > 200) throw new EditError("upload name must be a plain file name", "bad_value", "e.g. ?name=clip.mp4");
    const ext = extname(name).toLowerCase();
    if (!UPLOAD_EXT.has(ext)) throw new EditError(`${name}: not a media file import_media takes`, "bad_type", `accepted: ${[...UPLOAD_EXT].join(" ")}`);
    // written in a scratch dir that cache.ts sweepStale removes after a crash, then linked into media/: a half-written file is never there
    const scratch = mkdtempSync(join(ensureDir(root, join(root, ".agentcut", "tmp")), `upload-${process.pid}-`)), part = join(scratch, "part");
    try {
      await pipeline(req, createWriteStream(part, { flags: "wx" }));
      const dir = ensureDir(root, join(root, "media")), stem = name.slice(0, -ext.length);
      for (let i = 0; ; i++) {
        const dest = join(dir, i ? `${stem}-${i}${ext}` : name);
        try { linkSync(part, dest); return dest; } catch (e: any) { if (e.code !== "EEXIST") throw e; }
      }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }

  function asset(id: string): Asset & { abs: string } {
    const st = statSync(p.file, { bigint: true });
    const key = `${st.ino}|${st.size}|${st.mtimeNs}`;
    if (key !== assetsKey) {
      const loaded = p.load();
      assets = loaded.assets;
      assetsKey = key;
    }
    const a = assets![id];
    if (!a?.path) throw new EditError(`no asset '${id}' in this project`, "not_found");
    return { ...a, abs: p.abs(a.path) };
  }

  function servedFile(rel: string) {
    const abs = join(root, rel);
    for (const d of SERVED_DIRS) {
      const dir = join(root, d);
      if (abs.startsWith(dir + sep) && (!existsSync(abs) || realpathSync(abs).startsWith(realpathSync(dir) + sep))) return abs; // sendFile answers 404 for a missing path or a directory
    }
    throw new EditError("only files in renders/ and previews/ are served", "forbidden");
  }

  await new Promise<void>((ok, fail) => {
    server.once("error", (e: any) => fail(e.code === "EADDRINUSE" ? new EditError(`port ${o.port ?? 4810} is in use`, "port_in_use", "pass --port N (or --port 0 for any free port)") : e));
    server.listen(o.port ?? 4810, "127.0.0.1", ok);
  });
  // live sync: stat-poll survives the atomic rename used by Project.save (fs.watch on the file does not). Started only once the port is held, so a failed listen leaves nothing running.
  let lastRev = -1;
  // one push at a time, in the order the changes were seen: state() waits for Skia on the first text project, and two quick saves must not end with the older state sent last
  let pushing: Promise<void> = Promise.resolve();
  watchFile(p.file, { interval: 150 }, () => {
    pushing = pushing.then(async () => {
      try { const s = await state(); if (s.revision !== lastRev) { lastRev = s.revision; broadcast("state", s); } }
      catch (e: any) { broadcast("error", errJson(e)); }
    });
  });
  server.on("close", () => { unwatchFile(p.file); void api.closeFrameCache(root); });
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/`, port, project: root, revision: p.load().revision, server };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** the status of a job that ended in an error: cancelled when its own abort caused it */
const endedAs = (ctl: AbortController, e: any) => (ctl.signal.aborted && e instanceof EditError && e.code === "aborted" ? "cancelled" : "failed");

function errJson(e: any) {
  if (e instanceof EditError) return e.toJSON();
  return { code: "internal", message: String(e?.message ?? e) };
}

async function readJson(req: IncomingMessage): Promise<Dict> {
  const b: Buffer[] = []; let n = 0;
  for await (const c of req) { b.push(c); n += c.length; if (n > 5e6) throw new EditError("request body too large", "bad_request"); }
  try { const v = JSON.parse(Buffer.concat(b).toString("utf8") || "{}"); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch { /* below */ }
  throw new EditError("request body must be a JSON object", "bad_json");
}

/** Streams a file with HTTP Range support (needed for <video> seeking). */
function sendFile(req: IncomingMessage, res: ServerResponse, abs: string) {
  if (!isAbsolute(abs) || !isFile(abs)) return json(res, 404, { ok: false, error: { code: "not_found", message: "file not found" } });
  const size = statSync(abs).size, type = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (m && size) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
    return pipe(createReadStream(abs, { start, end }), res);
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
  pipe(createReadStream(abs), res);
}

const isFile = (abs: string) => statSync(abs, { throwIfNoEntry: false })?.isFile() === true;
/** a read error after the headers went out can only end the connection; it must not escape as an unhandled stream error */
function pipe(rs: ReturnType<typeof createReadStream>, res: ServerResponse) {
  rs.on("error", () => res.destroy());
  res.on("close", () => rs.destroy());
  rs.pipe(res);
}

function thumbnail(abs: string, t: number, facts?: VideoFacts, fps?: number | null): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const ss = seekArgs(t, facts, fps);
    const ff = spawn("ffmpeg", ["-v", "error", ...ss.input, ...inp(abs), ...VIDEO_MAP, ...ss.output, "-frames:v", "1", "-vf", "scale=160:-2", "-f", "image2pipe", "-c:v", "mjpeg", "-"]);
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.on("error", fail);
    ff.on("close", (code) => (code === 0 && chunks.length ? ok(Buffer.concat(chunks)) : fail(new Error(`thumbnail failed for ${abs}`))));
  });
}
