// `agentcut ui`: local web UI (127.0.0.1 only) to watch and steer a project. Every edit goes through api.apply with the
// revision the page saw, so a stale page gets a "conflict" instead of overwriting an agent's work. Changes made by other
// processes (CLI/MCP) are picked up by polling project.json and pushed to the page over Server-Sent Events.
import { spawn } from "node:child_process";
import { createReadStream, existsSync, realpathSync, renameSync, rmSync, statSync, unwatchFile, utimesSync, watchFile } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import * as api from "./api.ts";
import { EditError, type Dict } from "./model.ts";
import { PAGE } from "./ui-page.ts";

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".json": "application/json",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
  ".fcpxml": "application/xml", ".otio": "application/json",
};
const STATUS: Record<string, number> = { conflict: 409, bad_revision: 400, forbidden: 403, not_found: 404, bad_json: 400, bad_request: 400 };
const SERVED_DIRS = ["renders", "previews"]; // besides project assets, only outputs are served

export async function startUi(project: string | undefined, o: { port?: number } = {}) {
  const p = api.openProject(project);
  const root = p.root;
  const clients = new Set<ServerResponse>();
  const jobs = new Map<string, Dict>();
  const playing = new Map<string, Dict>(); // play output path -> running job
  let preparing: Dict | null = null; // the running prepare job: a second request joins it
  const thumbs = new Map<string, Promise<Buffer>>();
  const cacheDir = join(root, "previews", "ui");

  const state = (): Dict => ({ ...api.info(root, "json"), history: api.history(root) });
  const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event: string, data: unknown) => { for (const c of clients) send(c, event, data); };
  const fileUrl = (abs: string) => "/files/" + relative(root, abs).split(sep).map(encodeURIComponent).join("/");

  // live sync: stat-poll survives the atomic rename used by Project.save (fs.watch on the file does not)
  let lastRev = -1;
  watchFile(p.file, { interval: 150 }, () => {
    try { const s = state(); if (s.revision !== lastRev) { lastRev = s.revision; broadcast("state", s); } }
    catch (e: any) { broadcast("error", errJson(e)); }
  });

  const server = createServer(async (req, res) => {
    try { await route(req, res); }
    catch (e: any) {
      const status = e instanceof EditError ? (STATUS[e.code] ?? 422) : 500;
      if (!res.headersSent) json(res, status, { ok: false, error: errJson(e) }); else res.end();
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(url.pathname);
    // DNS-rebinding / cross-site guards: only our own host, same-origin JSON writes
    const port = (server.address() as any).port;
    if (!new Set([`127.0.0.1:${port}`, `localhost:${port}`]).has(req.headers.host ?? "")) return json(res, 403, { ok: false, error: { code: "forbidden", message: "bad host" } });
    if (path.split("/").includes("..") || path.includes("\0")) return json(res, 403, { ok: false, error: { code: "forbidden", message: "path traversal rejected" } });
    if (req.method === "POST") {
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { ok: false, error: { code: "forbidden", message: "cross-origin request" } });
      if (!String(req.headers["content-type"]).startsWith("application/json")) return json(res, 415, { ok: false, error: { code: "bad_request", message: "POST bodies must be application/json" } });
    }

    if (req.method === "GET" && path === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(PAGE); }
    if (req.method === "GET" && path === "/api/state") return json(res, 200, { ok: true, ...state() });
    if (req.method === "GET" && path === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      clients.add(res);
      send(res, "state", state());
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === "GET" && path === "/api/frame") {
      const t = Number(url.searchParams.get("t") ?? 0), scale = Number(url.searchParams.get("scale") ?? 0.5);
      if (!Number.isFinite(t) || !Number.isFinite(scale)) throw new EditError("t and scale must be numbers", "bad_request");
      const r = await api.frameImage(root, Math.max(0, t), { scale: Math.min(1, Math.max(0.1, scale)) });
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store", "x-revision": String(r.revision) });
      return res.end(r.data);
    }
    if (req.method === "GET" && path.startsWith("/api/thumb/")) {
      const a = asset(path.slice("/api/thumb/".length));
      if (a.kind === "image") return sendFile(req, res, a.abs);
      const t = Math.max(0, Number(url.searchParams.get("t")) || 0);
      const key = `${a.abs}|${t.toFixed(2)}`;
      if (!thumbs.has(key)) { if (thumbs.size > 500) thumbs.clear(); thumbs.set(key, thumbnail(a.abs, t).catch((e) => { thumbs.delete(key); throw e; })); }
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "max-age=3600" });
      return res.end(await thumbs.get(key));
    }
    if (req.method === "GET" && path.startsWith("/media/")) return sendFile(req, res, asset(path.slice("/media/".length)).abs);
    if (req.method === "GET" && path.startsWith("/files/")) return sendFile(req, res, servedFile(path.slice("/files/".length)));
    if (req.method === "GET" && path.startsWith("/api/jobs/")) {
      const j = jobs.get(path.slice("/api/jobs/".length));
      return j ? json(res, 200, { ok: true, ...j }) : json(res, 404, { ok: false, error: { code: "not_found", message: "no such job" } });
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      const rev = body.revision === undefined ? undefined : Number(body.revision);
      if (path === "/api/ops") return json(res, 200, await api.apply(root, body.ops, { revision: rev, label: body.label }));
      if (path === "/api/undo") return json(res, 200, { ok: true, ...api.undo(root, 1, rev) });
      if (path === "/api/redo") return json(res, 200, { ok: true, ...api.redo(root, 1, rev) });
      if (path === "/api/sheet") {
        const r = await api.sheet(root, { count: Number(body.count ?? 12), cols: 4, tileWidth: 320, out: join(cacheDir, `sheet-${Date.now()}.jpg`) });
        return json(res, 200, { ok: true, ...r, url: fileUrl(r.image) });
      }
      if (path === "/api/render") return json(res, 200, { ok: true, ...render(body) });
      if (path === "/api/prepare") return json(res, 200, { ok: true, ...prepare() });
    }
    json(res, 404, { ok: false, error: { code: "not_found", message: `${req.method} ${path}` } });
  }

  /** play=true: draft of [start,end) into previews/ui/ (cached per revision+range) for the viewer; else a normal render into renders/. */
  function render(body: Dict) {
    const id = Math.random().toString(36).slice(2, 10);
    const job: Dict = { id, kind: body.play ? "play" : "export", status: "running", progress: 0, started: Date.now() };
    jobs.set(id, job);
    const start = Number(body.start ?? 0), end = body.end === undefined ? undefined : Number(body.end);
    const out = body.play ? join(cacheDir, `play-r${p.load().revision}-${start.toFixed(2)}-${end?.toFixed(2) ?? "end"}.mp4`) : undefined;
    const finish = (r: Dict) => { Object.assign(job, { status: "done", progress: 1, result: r, url: fileUrl(r.output ?? out), sheet_url: r.contact_sheet ? fileUrl(r.contact_sheet) : undefined });  broadcast("job", job); };
    if (out && existsSync(out)) { const now = new Date(); utimesSync(out, now, now); finish({ output: out }); return job; }
    if (out && playing.has(out)) { jobs.delete(id); return playing.get(out)!; } // same range already rendering: share that job
    // play renders go to a .part-<pid>- file (the name cache.ts treats as in flight) and are renamed when complete, so the cache check above never serves a half-written file
    const part = out?.replace(/\.mp4$/, `.part-${process.pid}-${id}.mp4`);
    if (out) playing.set(out, job);
    let last = 0;
    api.render(root, {
      out: part, start, end, draft: !!body.draft || !!body.play, sheet: !body.play, workers: body.play ? 1 : undefined,
      progress: (d, n) => { job.progress = +(d / n).toFixed(3); const now = Date.now(); if (now - last > 200) { last = now; broadcast("job", job); } },
    }).then((r: Dict) => {
      if (out) { renameSync(part!, out); r.output = out; }
      finish(r);
    }).catch((e) => { if (part) rmSync(part, { force: true }); Object.assign(job, { status: "failed", error: errJson(e) }); broadcast("job", job); })
      .finally(() => { if (out) playing.delete(out); });
    return job;
  }

  /** compute mattes / vision analyses and apply the pending vision requests (the slow step not_prepared asks for) */
  function prepare() {
    if (preparing) return preparing;
    const job: Dict = { id: Math.random().toString(36).slice(2, 10), kind: "prepare", status: "running", progress: 0, started: Date.now() };
    jobs.set(job.id, job);
    preparing = job;
    let last = 0;
    Promise.resolve().then(() => api.prepare(root, { progress: (d, n) => { job.progress = n ? +(d / n).toFixed(3) : 0; const now = Date.now(); if (now - last > 200) { last = now; broadcast("job", job); } } }))
      .then((r: Dict) => Object.assign(job, { status: "done", progress: 1, result: r }))
      .catch((e) => Object.assign(job, { status: "failed", error: errJson(e) }))
      .finally(() => { preparing = null; broadcast("job", job); });
    return job;
  }

  function asset(id: string) {
    const a = p.load().assets[id];
    if (!a?.path) throw new EditError(`no asset '${id}' in this project`, "not_found");
    return { kind: a.kind, abs: p.abs(a.path) };
  }

  function servedFile(rel: string) {
    const abs = join(root, rel);
    for (const d of SERVED_DIRS) {
      const dir = join(root, d);
      if (abs.startsWith(dir + sep) && existsSync(abs) && realpathSync(abs).startsWith(realpathSync(dir) + sep)) return abs;
    }
    throw new EditError("only files in renders/ and previews/ are served", "forbidden");
  }

  await new Promise<void>((ok, fail) => {
    server.once("error", (e: any) => fail(e.code === "EADDRINUSE" ? new EditError(`port ${o.port} is in use`, "port_in_use", "pass --port N (or --port 0 for any free port)") : e));
    server.listen(o.port ?? 4810, "127.0.0.1", ok);
  });
  server.on("close", () => unwatchFile(p.file));
  const port = (server.address() as any).port;
  return { url: `http://127.0.0.1:${port}/`, port, project: root, revision: p.load().revision, server };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function errJson(e: any) {
  if (e instanceof EditError) return e.toJSON();
  return { code: "internal", message: String(e?.message ?? e) };
}

async function readJson(req: IncomingMessage): Promise<Dict> {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 5e6) throw new EditError("request body too large", "bad_request"); }
  try { const v = JSON.parse(s || "{}"); if (v && typeof v === "object") return v; } catch { /* below */ }
  throw new EditError("request body must be a JSON object", "bad_json");
}

/** Streams a file with HTTP Range support (needed for <video> seeking). */
function sendFile(req: IncomingMessage, res: ServerResponse, abs: string) {
  if (!isAbsolute(abs) || !existsSync(abs)) return json(res, 404, { ok: false, error: { code: "not_found", message: "file not found" } });
  const size = statSync(abs).size, type = MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
  if (m && size) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${size}`, "accept-ranges": "bytes" });
    return createReadStream(abs, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "content-length": size, "accept-ranges": "bytes" });
  createReadStream(abs).pipe(res);
}

function thumbnail(abs: string, t: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const ff = spawn("ffmpeg", ["-v", "error", "-ss", String(t), "-i", abs, "-frames:v", "1", "-vf", "scale=160:-2", "-f", "image2pipe", "-c:v", "mjpeg", "-"]);
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.on("error", fail);
    ff.on("close", (code) => (code === 0 && chunks.length ? ok(Buffer.concat(chunks)) : fail(new Error(`thumbnail failed for ${abs}`))));
  });
}
