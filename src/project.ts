// Project folder: project.json + media/ renders/ previews/ fonts/ + .agentcut/history (undo/redo).
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as presolve } from "node:path";
import { fontCheck, registerFontDir } from "./fonts.ts";
import {
  clipDur, clipStart, clone, EditError, type Issue, newTimeline, normAnim, PRESETS, resolve, SCHEMA_VERSION, suggest, type Timeline,
  totalDuration, type Track, validate,
} from "./model.ts";

export const PROJECT_FILE = "project.json";
const MAX_HISTORY = 100;
const LOCK_WAIT_MS = 10_000;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** The one version gate: every timeline read from disk (project.json, history snapshots) and every one written goes through it.
 *  `source` names where the timeline came from (op input is checked by replace_timeline itself). */
function checkVersion(tl: Timeline, source: string, fix = "there is no upgrade: create a new project (agentcut init <new dir>) and re-import its media"): Timeline {
  if (tl?.version !== SCHEMA_VERSION) {
    const found = JSON.stringify(tl?.version) ?? "missing";
    throw new EditError(`${source} has schema version ${found}; this build reads only version ${SCHEMA_VERSION}`, "bad_version", `found ${found}, supported ${SCHEMA_VERSION}; ${fix}`);
  }
  return tl;
}

/** `snapshot`: the history entry (stack/name) the text came from; without it the text is project.json */
function parse(text: string, snapshot?: string): Timeline {
  const source = snapshot ? `history snapshot ${snapshot}` : "project.json";
  let tl: Timeline;
  try { tl = JSON.parse(text); }
  catch (e: any) { throw new EditError(`${source} is not valid JSON: ${e.message}`, "bad_json", "fix the file or run `agentcut undo` to restore the last good version"); }
  return checkVersion(tl, source, snapshot ? `there is no upgrade; project.json itself is fine: delete .agentcut/history/${snapshot}` : undefined);
}

function revisionOf(tl: Timeline): number {
  if (!Number.isInteger(tl.revision) || tl.revision < 0) throw new EditError(`project.json has no valid 'revision' (got ${JSON.stringify(tl.revision)})`, "bad_revision", 'set "revision": 0 at the top level of project.json');
  return tl.revision;
}

/** Optimistic concurrency: an edit based on revision `base` may only be written while the project is still at `base`. */
export function checkRevision(base: number, current: number) {
  if (!Number.isInteger(base) || base < 0) throw new EditError(`revision must be a non-negative integer (got ${JSON.stringify(base)})`, "bad_revision", "pass the revision from info / project_info, or omit it");
  if (base !== current) throw new EditError(`project changed since revision ${base} (now ${current}); nothing was changed`, "conflict",
    "reload the project (info / project_info), then re-apply your edit against the latest revision", undefined, { revision: current });
}

/** only ESRCH proves a pid dead; anything else (EPERM, or an impossible pid process.kill rejects with another code) counts as alive: fail closed */
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code !== "ESRCH"; } };
/** exists, a dangling symlink included (existsSync follows the link, so a dangling one reads as absent) */
const lexists = (f: string) => { try { lstatSync(f); return true; } catch (e: any) { if (e.code === "ENOENT") return false; throw e; } };
const readOr = (f: string) => { try { return readFileSync(f, "utf8"); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; } };
/** O_EXCL create with the full content already in place (link of a temp file), so readers never see a half-written lock. */
function createExcl(file: string, body: string): boolean {
  const tmp = `${file}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, body, { flag: "wx" });
  try { linkSync(tmp, file); return true; }
  catch (e: any) { if (e.code === "EEXIST") return false; throw e; }
  finally { rmSync(tmp, { force: true }); }
}
/** Lock and claim files hold "<pid> <id> <host>": id is 16 hex chars, unique per acquisition; the host goes last because a
 *  hostname may contain spaces. Anything else is not something AgentCut wrote and is never reclaimed. */
const LOCK_FORMAT = /^(\d+) ([0-9a-f]{16}) (.+)$/;
const HOST = hostname();
/** the holder is provably dead: same host and no such pid. Malformed content and other hosts (pids of another pid
 *  namespace or machine mean nothing here) are never stale: fail closed, the waiter gets `locked`. */
function staleHolder(content: string) {
  const m = LOCK_FORMAT.exec(content);
  return m && m[3] === HOST && !alive(Number(m[1])) ? { id: m[2] } : null;
}
/** `file` (content `held`) belongs to a dead process. Only the one process that creates `<file>.reclaim-<id>` may delete it,
 *  after re-reading that it still carries that content, so a slow reclaimer can never delete a newer lock (the old
 *  check-then-unlink race). The claim path is built from the validated id only. A claim left by a reclaimer that crashed is
 *  itself reclaimed the same way; a claim whose owner is alive (or unjudgeable) blocks, and the caller times out. */
export function reclaim(file: string, held: string, token: string) {
  const stale = staleHolder(held);
  if (!stale) return;
  const claim = `${file}.reclaim-${stale.id}`;
  if (createExcl(claim, token)) {
    try { if (readOr(file) === held) rmSync(file); } finally { rmSync(claim, { force: true }); }
    return;
  }
  const c = readOr(claim);
  if (c !== null) reclaim(claim, c, token);
}

/** Cross-process mutex on `file`, whose content is "<pid> <id> <host>" (id unique per acquisition). Every iteration that
 *  does not acquire the lock checks the deadline and sleeps, so a reclaim that cannot progress never spins. */
export function withLock<T>(file: string, fn: () => T, waitMs = LOCK_WAIT_MS): T {
  mkdirSync(dirname(file), { recursive: true });
  const token = `${process.pid} ${randomBytes(8).toString("hex")} ${HOST}`, until = Date.now() + waitMs;
  while (!createExcl(file, token)) {
    const held = readOr(file);
    if (held !== null) reclaim(file, held, token);
    if (Date.now() > until) throw new EditError("project is locked by another AgentCut process", "locked", `retry; if no AgentCut process is running, delete ${file}`);
    Atomics.wait(SLEEP, 0, 0, 5);
  }
  try { return fn(); }
  finally { if (readOr(file) === token) rmSync(file, { force: true }); }
}

export function findProject(start?: string): string {
  const env = process.env.AGENTCUT_PROJECT;
  let p = presolve(start ?? env ?? process.cwd());
  if (p.endsWith(".json") && existsSync(p)) return dirname(p);
  for (let cur = p; ; cur = dirname(cur)) {
    if (existsSync(join(cur, PROJECT_FILE))) return cur;
    if (dirname(cur) === cur) break;
  }
  throw new EditError(`no ${PROJECT_FILE} found in ${p} or its parents`, "no_project", "create one with `agentcut init <dir> --preset reels` (or pass -p <dir>)");
}

export class Project {
  root: string; file: string;
  constructor(root: string) {
    this.root = presolve(root);
    this.file = join(this.root, PROJECT_FILE);
    if (!existsSync(this.file)) throw new EditError(`${this.file} does not exist`, "no_project", "run `agentcut init` first");
    registerFontDir(join(this.root, "fonts"));
  }

  static create(root: string, o: { preset?: string; width?: number; height?: number; fps?: number; name?: string; empty?: boolean } = {}) {
    root = presolve(root);
    if (lexists(join(root, PROJECT_FILE))) throw new EditError(`project already exists at ${root}`, "exists", "open it instead, or choose another folder");
    let w = o.width ?? 1920, h = o.height ?? 1080;
    if (o.preset) {
      if (!PRESETS[o.preset]) { const s = suggest(o.preset, Object.keys(PRESETS)); throw new EditError(`unknown preset '${o.preset}'`, "bad_preset", `${s ? `did you mean '${s}'? ` : ""}presets: ${Object.keys(PRESETS).join(", ")}`); }
      [w, h] = PRESETS[o.preset];
    }
    for (const d of ["media", "renders", "previews", "fonts", ".agentcut/history/undo", ".agentcut/history/redo"]) mkdirSync(join(root, d), { recursive: true });
    const tl = newTimeline(w, h, o.fps ?? 30, o.name ?? basename(root));
    if (o.empty) tl.tracks = [];
    writeFileSync(join(root, PROJECT_FILE), JSON.stringify(tl, null, 2), { flag: "wx" });
    return new Project(root);
  }

  load(): Timeline { return parse(readFileSync(this.file, "utf8")); }

  /** Write tl if it is based on the revision on disk (else EditError "conflict"); returns the new revision. */
  save(tl: Timeline, label = "edit", snapshot = true): number {
    checkVersion(tl, "the timeline to save", "save only a timeline loaded from the project");
    resolve(tl);
    return this.locked(() => {
      const cur = readFileSync(this.file, "utf8");
      const disk = revisionOf(parse(cur));
      checkRevision(revisionOf(tl), disk);
      if (snapshot) { this.entries("undo"); this.entries("redo"); this.push("undo", cur, label); this.clear("redo"); } // both stacks verified before the first write
      tl.revision = disk + 1;
      this.write(tl);
      return tl.revision;
    });
  }

  /** a new temp name per write, created O_EXCL: a planted symlink (or any existing file) is never written through or reused */
  private write(tl: Timeline) {
    const tmp = `${this.file}.tmp-${randomBytes(6).toString("hex")}`;
    try { writeFileSync(tmp, JSON.stringify(tl, null, 2), { flag: "wx" }); renameSync(tmp, this.file); }
    catch (e: any) { if (e.code !== "EEXIST") rmSync(tmp, { force: true }); throw e; }
  }

  private locked<T>(fn: () => T): T { return withLock(join(this.plainDir(".agentcut"), "lock"), fn); }

  /** root/<parts> as a real directory, made one component at a time: an existing component that is not a real directory (a symlink)
   *  is refused before anything is created or written there. */
  private plainDir(...parts: string[]) {
    let d = this.root;
    for (const part of parts) {
      d = join(d, part);
      let st;
      try { st = lstatSync(d); } catch (e: any) { if (e.code !== "ENOENT") throw e; mkdirSync(d); continue; }
      if (!st.isDirectory()) throw new EditError(`${relative(this.root, d)} is not a plain directory inside the project (symlink?)`, "unsafe_history", "AgentCut never reads, writes or deletes history through symlinks: replace it with a real directory");
    }
    return d;
  }

  // ---------------------------------------------------------------- history
  /** The history writer's entry names (push): digits + ".json". Undo/redo/prune only ever touch a path built from a stack dir plus such a name. */
  private static readonly ENTRY = /^\d+\.json$/;
  /** The stack dir, checked component by component (.agentcut, history, the stack) with lstat before anything is created: a symlink
   *  there would point undo/redo/prune at files outside the history. Same intent as cache.ts areaRoot (:28-35, a realpath check of
   *  a cache area, code unsafe_cache_dir); the two are not merged because that one resolves a path and this one refuses to create through a link. */
  private stack(name: string) { return this.plainDir(".agentcut", "history", name); }
  /** Entry paths of a stack, oldest first. An entry that is not a regular file (a symlink, a directory) is refused, never followed. */
  private entries(name: string) {
    const d = this.stack(name), out: string[] = [];
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!Project.ENTRY.test(e.name)) continue;
      if (!e.isFile()) throw new EditError(`.agentcut/history/${name}/${e.name} is not a regular file (symlink?)`, "unsafe_history", "AgentCut never reads or deletes history through symlinks: remove it");
      out.push(join(d, e.name));
    }
    return out.sort();
  }
  private push(name: string, content: string, label: string) {
    const ts = `${Date.now()}${String(Math.floor(performance.now() * 1000) % 1e6).padStart(6, "0")}`;
    writeFileSync(join(this.stack(name), `${ts}.json`), JSON.stringify({ label, time: Date.now(), timeline: content }));
    const e = this.entries(name);
    for (const old of e.slice(0, Math.max(0, e.length - MAX_HISTORY))) unlinkSync(old);
  }
  private clear(name: string) { rmSync(this.stack(name), { recursive: true, force: true }); }
  // restored snapshots get a fresh revision, so the revision only ever increases
  private step(from: string, to: string, steps: number, base?: number) {
    return this.locked(() => {
      let cur = readFileSync(this.file, "utf8"), rev = revisionOf(parse(cur));
      if (base !== undefined) checkRevision(base, rev);
      // every snapshot this call will use is read and version-checked before anything is written: all or nothing
      const e = this.entries(from), snaps: { file: string; label: string; tl: Timeline }[] = [];
      for (let i = 0; i < steps && i < e.length; i++) {
        const file = e[e.length - 1 - i], d = JSON.parse(readFileSync(file, "utf8"));
        snaps.push({ file, label: d.label, tl: parse(d.timeline, `${from}/${basename(file)}`) });
      }
      if (!snaps.length) throw new EditError(`nothing to ${from}`, "empty_history");
      this.entries(to); // the stack this call writes to is verified before the first write
      for (const sn of snaps) {
        this.push(to, cur, sn.label);
        unlinkSync(sn.file);
        sn.tl.revision = ++rev;
        this.write(sn.tl);
        cur = readFileSync(this.file, "utf8");
      }
      return { labels: snaps.map((sn) => sn.label), revision: rev };
    });
  }
  /** base: the revision the caller saw; a newer revision on disk is a conflict. */
  undo(steps = 1, base?: number) { return this.step("undo", "redo", steps, base); }
  redo(steps = 1, base?: number) { return this.step("redo", "undo", steps, base); }
  history() {
    const lab = (n: string) => this.entries(n).slice(-20).map((p) => JSON.parse(readFileSync(p, "utf8")).label);
    return { undo: lab("undo"), redo: lab("redo") };
  }

  // ---------------------------------------------------------------- paths
  rel(p: string) { const a = presolve(p); const r = relative(this.root, a); return r.startsWith("..") || isAbsolute(r) ? a : r; }
  abs(p: string) { return isAbsolute(p) ? p : join(this.root, p); }
  absolutized(tl: Timeline): Timeline {
    const t = clone(tl);
    for (const a of Object.values(t.assets)) if (a.path) a.path = this.abs(a.path);
    return t;
  }
  validate(tl?: Timeline): Issue[] {
    const t = this.absolutized(resolve(clone(tl ?? this.load())));
    return validate(t, { exists: (p) => existsSync(p), fontCheck });
  }
  defaultOutput(ext = ".mp4", tag = "") {
    const name = this.load().name || "video";
    const d = new Date(), pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return join(this.root, "renders", `${name}${tag ? "-" + tag : ""}-${stamp}${ext}`);
  }
}

/** Token-cheap text view of a timeline. */
export function summarize(tl: Timeline): string {
  resolve(tl);
  const st = tl.settings;
  const L = [`${tl.name || "untitled"}: ${st.width}x${st.height} @${st.fps}fps, duration ${totalDuration(tl).toFixed(2)}s, bg ${st.background ?? "#000"}, loudness ${st.loudness}`];
  const assets = Object.entries(tl.assets);
  if (assets.length) {
    L.push("assets:");
    for (const [id, a] of assets) L.push(`  ${id}: ${a.kind}${a.width ? ` ${a.width}x${a.height}` : ""}${a.duration ? ` ${a.duration.toFixed(2)}s` : ""}${a.has_audio && a.kind === "video" ? " +audio" : ""}${a.alpha ? " alpha" : ""}  ${basename(a.path ?? "")}`);
  }
  L.push("tracks (bottom -> top):");
  tl.tracks.forEach((tr, i) => {
    const f = [tr.kind ?? "video", ...["magnetic", "muted", "hidden"].filter((k) => tr[k])];
    if (tr.role) f.push(`role=${tr.role}`);
    if (tr.duck) f.push(`duck=${tr.duck}dB`);
    L.push(`  [${i}] ${tr.id} (${f.join(", ")}) ${tr.clips.length} clips`);
    for (const c of tr.clips) {
      const s = clipStart(c), d = clipDur(c);
      let desc = c.type;
      if (c.asset) desc += ` ${c.asset}${c.in ? `@${Number(c.in).toFixed(2)}` : ""}`;
      if (c.text) { const t = String(c.text).replace(/\n/g, " / "); desc += ` "${t.slice(0, 40)}${t.length > 40 ? "…" : ""}"`; }
      if (c.type === "captions") desc += ` style=${c.style ?? "karaoke"} words=${(c.words || []).length}${c.srt ? " srt" : ""}`;
      if (c.type === "shape") desc += ` ${c.shape ?? "rect"}`;
      if (c.type === "compound") { const ts = (c.tracks || []) as Track[]; desc += ` ${ts.reduce((n, t) => n + (t.clips?.length ?? 0), 0)} nested clips on ${ts.map((t) => t.id).join(",") || "-"}${c.in ? ` in=${c.in}` : ""}`; }
      const x: string[] = [];
      for (const k of ["enter", "exit", "transition", "motion"]) { const v = k === "motion" ? c[k] : normAnim(c[k], 0.5); if (v) x.push(`${k}=${typeof v === "object" ? v.type : v}`); }
      if (c.keyframes) x.push(`kf=${Object.keys(c.keyframes).join(",")}`);
      if (c.filters?.length) x.push(`filters=${c.filters.map((f: any) => (typeof f === "string" ? f : f.type)).join(",")}`);
      if (c.effects?.length) x.push(`fx=${c.effects.map((f: any) => (typeof f === "string" ? f : f.type)).join(",")}`);
      if (c.mask) x.push(`mask=${typeof c.mask === "string" ? c.mask : c.mask.shape}`);
      for (const k of ["fit", "position", "blend"]) if (c[k] && c[k] !== "cover" && c[k] !== "normal") x.push(`${k}=${c[k]}`);
      if ((c.speed ?? 1) !== 1) x.push(`speed=${c.speed}`);
      if ((c.volume ?? 1) !== 1) x.push(`vol=${c.volume}`);
      for (const k of ["reverse", "freeze", "loop", "until_end"]) if (c[k]) x.push(k);
      if (c.pending) x.push(`pending=${Object.keys(c.pending).join(",")}`);
      if (c.remove_background) x.push("remove_background");
      if (c.attach_to) x.push(`attached→${c.attach_to}${c.offset ? `+${c.offset}` : ""}`);
      if (c.enabled === false) x.push("DISABLED");
      L.push(`      ${s.toFixed(2).padStart(7)}–${(s + d).toFixed(2).padStart(7)}  ${c.id.padEnd(8)} ${desc}${x.length ? `  [${x.join(" ")}]` : ""}`);
    }
  });
  if (tl.markers?.length) L.push("markers: " + tl.markers.slice(0, 40).map((m) => `${m.t}s ${m.label ?? ""}`.trim()).join(", "));
  return L.join("\n");
}

export const fileSize = (p: string) => statSync(p).size;
