// Project folder: project.json + media/ renders/ previews/ fonts/ + .agentcut/history (undo/redo).
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve as presolve, sep } from "node:path";
import { FONT_FILE, fontCheck, registerFontDir } from "./fonts.ts";
import {
  clipDur, clipStart, clone, EditError, type Issue, newTimeline, normAnim, parseTime, presetSize, resolve, round6, SCHEMA_VERSION, type Timeline,
  totalDuration, type Track, validate,
} from "./model.ts";
import { checkDir, createExclusive, createFile, ensureDir, ensureRoot, lexists, notWritable, writeFile } from "./safe-write.ts";

export const PROJECT_FILE = "project.json";
const MAX_HISTORY = 100;
const LOCK_WAIT_MS = 10_000;
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** The one version gate: every timeline read from disk (project.json, history snapshots) and every one written goes through it.
 *  `source` names where the timeline came from (op input is checked by replace_timeline itself). */
function checkVersion(tl: Timeline, source: string, fix = "there is no upgrade: create a new project and re-import its media"): Timeline {
  if (tl?.version !== SCHEMA_VERSION) {
    const found = JSON.stringify(tl?.version) ?? "missing";
    throw new EditError(`${source} has schema version ${found}; this build reads only version ${SCHEMA_VERSION}`, "bad_version", `found ${found}, supported ${SCHEMA_VERSION}; ${fix}`);
  }
  return tl;
}

/** The state of project.json a history entry is read beside: "sound" (the file passed its own read, or the hint is never shown: changesSince and the non-strict highestStored skip every error they meet), "undo" (an undo over a project.json it can read no revision from: not JSON, or no valid revision),
 *  "unfit" (a history listing over a project.json that failed its read). */
type Beside = "sound" | "undo" | "unfit";

/** What to do about a history entry that cannot be used (`at` is stack/name), by the state of project.json beside it. The one place these three texts are built. */
const entryFix = (at: string, beside: Beside) => beside === "undo"
  ? `move .agentcut/history/${at} out of the history folder (it may still hold a timeline) and undo again`
  : beside === "unfit"
    ? `project.json has its own error (info shows it); this entry cannot be read either: move .agentcut/history/${at} out of the history folder (it may still hold a timeline)`
    : `project.json itself is fine: move .agentcut/history/${at} out of the history folder (it may still hold a timeline)`;

/** `snapshot`: the history entry (stack/name) the text came from; without it the text is project.json. `beside`: see entryFix */
function parse(text: string, snapshot?: string, beside: Beside = "sound"): Timeline {
  const source = snapshot ? `history snapshot ${snapshot}` : "project.json";
  let tl: Timeline;
  try { tl = JSON.parse(text); }
  catch (e: any) { throw new EditError(`${source} is not valid JSON: ${e.message}`, "bad_json", snapshot ? entryFix(snapshot, beside) : DAMAGED_FIX); }
  return checkVersion(tl, source, snapshot ? `there is no upgrade; ${entryFix(snapshot, beside)}` : undefined);
}

/** The way out of a project.json that cannot be read: undo restores the last good version, and it is the one history call that needs no revision there (no revision can be read). */
const DAMAGED_FIX = "undo restores the last good version (undo needs no revision while project.json is damaged), or fix the file";

/** `highest`: the history's highest revision (Project.highestStored), asked only when the revision is invalid, for the number the hint gives to set by hand. */
function revisionOf(tl: Timeline, highest?: () => number | undefined): number {
  if (!Number.isInteger(tl.revision) || tl.revision < 0) {
    let top: number | undefined;
    try { top = highest?.(); } catch { /* the hint falls back to words */ }
    const byHand = top === undefined
      ? `if you set "revision" by hand, use a whole number above every revision any agent has read (0 only if the project was never edited): a lower one makes an old revision valid again`
      : `to set it by hand, set "revision" to ${top + 1} (the history's last revision + 1): a lower number makes an old revision valid again`;
    throw new EditError(`project.json has no valid 'revision' (got ${JSON.stringify(tl.revision)})`, "bad_revision", `${DAMAGED_FIX}; ${byHand}`);
  }
  return tl.revision;
}

/** Every history-writing call says which state of the project it was planned against; there is no "latest". */
export function requireRevision(v: unknown): asserts v is number {
  if (v === undefined || v === null) throw new EditError("no revision: every history-writing call says which state of the project it was planned against", "missing_revision",
    "pass the revision you last read: info / project_info show it (CLI --revision N, MCP revision), and every apply, undo, redo and prepare result carries the new one; init and create_project return 0");
}

/** Who made a history change. Self-declared text, not a security boundary: it only has to be one short plain line, since it reaches JSON and the page. */
export const AUTHOR_MAX = 64;
const AUTHOR_TEXT = /^(?! )[\p{L}\p{M}\p{N} ._:@/+-]+(?<! )$/u;
/** the page's own word for itself (it is stored as is); an entry written before the field existed reads as UNKNOWN_AUTHOR */
export const UI_AUTHOR = "you";
export const UNKNOWN_AUTHOR = "unknown";
/** What history, undo and redo report per entry: who made the edit, and (once it was undone or redone) who last moved it between the stacks. */
export interface HistoryEntry { label: string; author: string; movedBy?: string }
const authorRule = `1 to ${AUTHOR_MAX} characters: letters (accented ones too), digits, spaces and . _ - : @ / + (no leading or trailing space)`;
/** Every history write goes through this: no caller identity is missing_author, a value that is not plain text of at most AUTHOR_MAX characters is bad_author. */
export function checkAuthor(v: unknown): string {
  if (v === undefined || v === null) throw new EditError("no author: every history entry records who made the change", "missing_author", "pass the caller's name as the author (CLI --author NAME or $AGENTCUT_AUTHOR; MCP and the page declare one themselves)");
  if (typeof v !== "string" || v.length > AUTHOR_MAX || !AUTHOR_TEXT.test(v)) throw new EditError(`author must be ${authorRule}, got ${JSON.stringify(typeof v === "string" ? v.slice(0, 40) : v)}${typeof v === "string" && v.length > 40 ? ` (${v.length} characters)` : ""}`, "bad_author", authorRule);
  return v;
}
/** An author the CLI or an MCP client declared: checkAuthor, and neither the page's word nor the old-entry word, so it cannot pass as the person at the page or as an entry from before the field. */
export function declaredAuthor(v: unknown): string {
  const a = checkAuthor(v);
  if ([UI_AUTHOR, UNKNOWN_AUTHOR].includes(a.toLowerCase())) throw new EditError(`author '${a}' is reserved`, "bad_author", `'${UI_AUTHOR}' is the web page and '${UNKNOWN_AUTHOR}' marks entries from before authors were recorded: choose another name`);
  return a;
}

/** A render, export, caption or preview output must not replace the project's own files: project.json, anything under .agentcut/ or fonts/, a file an
 *  asset points to, or a font file a text or captions clip names. Compared by path (the deepest existing ancestor resolved, so a path whose parent is not
 *  made yet is compared in the same space as the protected folders) and, for an existing output, by file identity (a case-insensitive volume). A path
 *  that cannot be inspected (a link loop, no permission) is refused: unsafe_path. */
export function refuseSource(root: string, tl: Pick<Timeline, "assets" | "tracks"> | null, out: string) {
  const unreadable = (f: string, e: any) => new EditError(`cannot inspect ${f}: ${e.code ?? e.message}`, "unsafe_path", "fix the link or the permissions on that path, or choose another output path");
  const absent = (e: any) => e.code === "ENOENT" || e.code === "ENOTDIR";
  const stat = (f: string, follow: boolean) => { try { return (follow ? statSync : lstatSync)(f); } catch (e: any) { if (absent(e)) return undefined; throw unreadable(f, e); } };
  const canon = (f: string) => {
    const a = presolve(f), rest = [basename(a)];
    for (let d = dirname(a); ; d = dirname(d)) {
      try { return join(realpathSync.native(d), ...rest); }
      catch (e: any) { if (!absent(e)) throw unreadable(d, e); if (dirname(d) === d) return a; rest.unshift(basename(d)); }
    }
  };
  const o = canon(out), st = stat(out, false), hist = canon(join(root, ".agentcut")), fonts = canon(join(root, "fonts"));
  const inside = (dir: string) => o === dir || o.startsWith(dir + sep);
  const same = (f: string) => {
    if (canon(f) === o) return true;
    const s = st?.isFile() ? stat(f, true) : undefined; // follows a symlinked asset to the file it reads
    return !!s && s.isFile() && s.ino === st!.ino && s.dev === st!.dev;
  };
  // resolveFont opens these as given. tl may be an unvalidated project.json (tts): whatever is not a track list, track, clip or string cannot name a font file and is skipped
  const fontsIn = (tracks: unknown): string[] => (Array.isArray(tracks) ? tracks : []).flatMap((tr) => (Array.isArray(tr?.clips) ? tr.clips : []).flatMap((c: any) =>
    [...(typeof c?.font === "string" && FONT_FILE.test(c.font) ? [c.font] : []), ...fontsIn(c?.tracks)]));
  const fontFiles = fontsIn(tl?.tracks);
  const what = inside(hist) ? "the project's history folder"
    : inside(fonts) ? "the project's fonts folder"
    : same(join(root, PROJECT_FILE)) ? "project.json"
    : Object.values(tl?.assets ?? {}).some((a) => typeof a?.path === "string" && a.path && same(isAbsolute(a.path) ? a.path : join(root, a.path))) ? "a media file the timeline uses"
    : fontFiles.some(same) ? "a font file the timeline uses" : null;
  if (what) throw new EditError(`${out} is ${what}; writing there would replace it`, "output_is_source", "choose another output path, for example renders/<name>.mp4");
}

/** only ESRCH proves a pid dead; anything else (EPERM, or an impossible pid process.kill rejects with another code) counts as alive: fail closed */
export const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code !== "ESRCH"; } };
const readOr = (f: string) => { try { return readFileSync(f, "utf8"); } catch (e: any) { if (e.code === "ENOENT") return null; throw e; } };
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
  if (createExclusive(claim, token)) {
    try { if (readOr(file) === held) rmSync(file); } finally { rmSync(claim, { force: true }); }
    return;
  }
  const c = readOr(claim);
  if (c !== null) reclaim(claim, c, token);
}

/** Cross-process mutex on `file` (its directory exists), whose content is "<pid> <id> <host>" (id unique per acquisition). Every iteration that
 *  does not acquire the lock checks the deadline and sleeps, so a reclaim that cannot progress never spins. */
export function withLock<T>(file: string, fn: () => T, waitMs = LOCK_WAIT_MS): T {
  const token = `${process.pid} ${randomBytes(8).toString("hex")} ${HOST}`, until = Date.now() + waitMs;
  while (!createExclusive(file, token)) {
    const held = readOr(file);
    if (held !== null) reclaim(file, held, token);
    if (Date.now() > until) throw new EditError(`${file} is held by another AgentCut process`, "locked", `retry; if no AgentCut process is running, delete ${file}`);
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
  throw new EditError(`no ${PROJECT_FILE} found in ${p} or its parents`, "no_project", "create a project first (preset reels, say), or pass the project folder");
}

export class Project {
  root: string; file: string;
  constructor(root: string) {
    this.root = presolve(root);
    this.file = join(this.root, PROJECT_FILE);
    if (!existsSync(this.file)) throw new EditError(`${this.file} does not exist`, "no_project", "create the project first");
    registerFontDir(join(this.root, "fonts"));
  }

  static create(root: string, o: { preset?: string; width?: number; height?: number; fps?: number; name?: string; empty?: boolean } = {}) {
    root = presolve(root);
    if (lexists(join(root, PROJECT_FILE))) throw new EditError(`project already exists at ${root}`, "exists", "open it instead, or choose another folder");
    let w = o.width ?? 1920, h = o.height ?? 1080;
    if (o.preset) { const [pw, ph] = presetSize(o.preset); w = o.width ?? pw; h = o.height ?? ph; } // a preset fills only the size that is not given
    const tl = newTimeline(w, h, o.fps ?? 30, o.name ?? basename(root));
    if (o.empty) tl.tracks = [];
    const bad = validate(tl).filter((i) => i.level === "error"); // the project is built and checked in memory: bad settings leave no folder behind
    if (bad.length) throw new EditError(`${bad[0].path}: ${bad[0].message}`, "bad_value", bad[0].hint ?? "e.g. width 1920, height 1080, fps 30, or a preset such as reels");
    const dirs = ["media", "renders", "previews", "fonts", ".agentcut/history/undo", ".agentcut/history/redo"].map((d) => join(root, d));
    for (const d of dirs) checkDir(root, d); // every chain is checked before anything is made: a refused one leaves nothing behind
    ensureRoot(root); // also proves the volume has hard links; on a volume without, nothing is left behind
    for (const d of dirs) ensureDir(root, d);
    if (!createExclusive(join(root, PROJECT_FILE), JSON.stringify(tl, null, 2))) throw new EditError(`project already exists at ${root}`, "exists", "open it instead, or choose another folder");
    return new Project(root);
  }

  /** Analyses (transcribe, tts, silence) that this api.apply call has computed, by request: what the synchronous ops read (analyze.ts `analysis`). `tmp` is a folder to delete at the end of the call. */
  readonly analyses = new Map<string, { value?: unknown; error?: EditError; tmp?: string }>();

  /** The millisecond a voiceover of this call is named after, taken once: a media name must not change from round to round, since an analysis is keyed by the file's path. */
  readonly stamp = Date.now();

  /** Files an op wrote into media/ while a batch was applied (imports, synthesized speech). A batch that is not saved discards them. */
  private staged: string[] = [];
  stage(file: string) { this.staged.push(file); return file; }
  /** Remove the staged files again; only a regular file directly in media/ is ever removed. keep: the batch was saved. */
  discardStaged(keep = false) {
    const media = join(this.root, "media");
    for (const f of this.staged.splice(0)) {
      const st = lstatSync(f, { throwIfNoEntry: false });
      if (!keep && st?.isFile() && dirname(presolve(f)) === media) rmSync(f, { force: true });
    }
  }

  /** project.json as a timeline; a file with no valid revision is bad_revision here, so every command names the damage (its hint points to undo). */
  load(): Timeline { const tl = parse(readFileSync(this.file, "utf8")); revisionOf(tl, () => this.highestStored()); return tl; }

  /** Optimistic concurrency: a write based on revision `base` may only land while the project is still at `base`. The one conflict text, shared by api.apply, save, undo/redo and the page:
   *  it names who changed the project since `base` (changesSince), so the caller can judge whether its edit still makes sense. */
  checkRevision(base: number, current: number) {
    if (!Number.isInteger(base) || base < 0) throw new EditError(`revision must be a non-negative integer (got ${JSON.stringify(base)})`, "bad_revision", "pass the revision from info / project_info, or from the previous result's revision");
    if (base === current) return;
    const changes = this.changesSince(base), shown = changes.slice(0, 8).map((c) => `${JSON.stringify(c.author)} ${c.label.slice(0, 60)}`).join(", ");
    throw new EditError(`project changed since revision ${base} (now ${current})${shown ? `: ${shown}${changes.length > 8 ? `, and ${changes.length - 8} more` : ""}` : ""}; nothing was changed`, "conflict",
      "reload the project (info / project_info), then resend your edit against the latest revision; an analysis the batch needed (transcription, speech, silence) runs again on the resend", undefined, { revision: current, changes });
  }

  /** Who changed the project at or after revision `base`, oldest first: a history entry holds the timeline from before its change, so a stored revision >= base is a change since.
   *  Undo-stack entries are saves (or, with movedBy, redos); redo-stack entries are undos. Not listed: an undo that a later edit followed (the redo stack is gone) and what the
   *  100-entry history dropped. Names are self-declared. Best effort: a history entry that cannot be read ends the list instead of replacing the conflict by another error. */
  private changesSince(base: number): { author: string; label: string }[] {
    const found: { r: number; author: string; label: string }[] = [];
    try {
      for (const stack of ["undo", "redo"]) {
        const files = this.entries(stack);
        for (let i = files.length - 1; i >= 0; i--) {
          const e = Project.readEntry(files[i], stack), r = e.revision;
          if (!(r >= base)) break; // stored revisions rise with the position in a stack
          found.push({ r, author: e.movedBy ?? e.author, label: (stack === "redo" ? "undo " : e.movedBy === undefined ? "" : "redo ") + e.label });
        }
      }
    } catch { /* see above */ }
    return found.sort((a, b) => a.r - b.r).map(({ author, label }) => ({ author, label }));
  }

  /** Write tl if it is based on the revision on disk (else EditError "conflict"); returns the new revision. `author` is who made the change: the history
   *  entry records it (missing_author / bad_author otherwise). */
  save(tl: Timeline, label: string, author: string | undefined): number {
    checkVersion(tl, "the timeline to save", "save only a timeline loaded from the project");
    const by = checkAuthor(author);
    resolve(tl);
    return this.locked(() => {
      const cur = readFileSync(this.file, "utf8");
      const disk = revisionOf(parse(cur), () => this.highestStored());
      this.checkRevision(revisionOf(tl), disk);
      this.entries("undo"); this.entries("redo"); // both stacks verified before the first write
      const pushed = this.push("undo", cur, disk, label, by);
      tl.revision = disk + 1;
      // invariant: after a save the redo stack is empty, or the save did not happen. The stack is moved aside before the write (a failure there throws with nothing
      // written), put back if the write fails (history stays as it was), and removed afterwards; a removal that fails leaves an unread dir, never a replayable stack.
      let aside: string | undefined;
      try {
        const redo = this.stack("redo"), to = join(dirname(redo), `.redo-${randomBytes(8).toString("hex")}`);
        renameSync(redo, to); aside = to;
        this.write(tl);
      } catch (e) {
        if (aside) try { renameSync(aside, join(dirname(aside), "redo")); } catch { /* redo stays gone: empty, never stale */ }
        rmSync(pushed, { force: true });
        throw e;
      }
      try { rmSync(aside, { recursive: true, force: true }); } catch { /* inert: no stack reads this name */ }
      this.prune("undo");
      return tl.revision;
    });
  }

  private write(tl: Timeline) { writeFile(this.file, JSON.stringify(tl, null, 2), this.root); }

  /** history and the lock live under .agentcut: a permission failure anywhere in the locked call (making the dirs, the lock, a history entry) is the named not_writable. */
  private locked<T>(fn: () => T): T {
    try { return withLock(join(this.plainDir(".agentcut"), "lock"), fn); }
    catch (e: any) { throw notWritable(e) ?? e; }
  }

  /** root/<parts> as a real directory: an existing component that is not a real directory (a symlink) is refused before anything is created or written there. */
  private plainDir(...parts: string[]) { return ensureDir(this.root, join(this.root, ...parts)); }

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
      if (!e.isFile()) throw new EditError(`.agentcut/history/${name}/${e.name} is not a regular file (symlink?)`, "unsafe_path", "AgentCut never reads or deletes history through symlinks: remove it");
      out.push(join(d, e.name));
    }
    const n = (f: string) => BigInt(basename(f, ".json"));
    return out.sort((a, b) => (n(a) < n(b) ? -1 : n(a) > n(b) ? 1 : a < b ? -1 : a > b ? 1 : 0)); // equal values (1.json, 01.json) fall back to the name text, so readdir order never shows
  }
  /** The next name is one more than the highest in the stack (padded to 19 digits): the order is the numeric value and never depends on the clock. Returns the new path.
   *  `revision` is the revision of the state `content` holds (for a project.json with no valid revision, the number it is taken to have): the field is written here and read only in readEntry. */
  private push(name: string, content: string, revision: number, label: string, author: string, movedBy?: string) {
    const last = this.entries(name).reduce((m, f) => { const n = BigInt(basename(f, ".json")); return n > m ? n : m; }, 0n);
    const file = join(this.stack(name), `${(last + 1n).toString().padStart(19, "0")}.json`);
    writeFile(file, JSON.stringify({ label, time: Date.now(), revision, author, ...(movedBy === undefined ? {} : { movedBy }), timeline: content }), this.root);
    return file;
  }
  /** Drop the oldest entries above the cap. Called only after the project write has succeeded: a call that fails must leave the history as it was,
   *  so nothing is pruned before the commit point. A failure here is not a failure of the call (it is already done); the extra entry is harmless and the next call prunes it. */
  private prune(name: string) {
    try { const e = this.entries(name); for (const old of e.slice(0, Math.max(0, e.length - MAX_HISTORY))) unlinkSync(old); } catch { /* committed already */ }
  }
  /** A history entry (label, author, revision, timeline text, and who last moved it between the stacks); an entry that is not valid JSON, has no revision that is a
   *  whole number >= 0, or names an author that is not plain text, is a named error. The one place that reads an entry without an author as UNKNOWN_AUTHOR,
   *  and the only reader of an entry's revision (never its timeline text). `beside`: the state of project.json the hint may speak of (see entryFix); only a read that knows the file is fine, or never looked, says "sound". */
  private static readEntry(file: string, stack: string, beside: Beside = "sound"): { label: string; author: string; movedBy?: string; timeline: string; revision: number } {
    const at = `${stack}/${basename(file)}`, hint = entryFix(at, beside);
    let d: any;
    try { d = JSON.parse(readFileSync(file, "utf8")); }
    catch (e: any) { throw new EditError(`history snapshot ${at} is not valid JSON: ${e.message}`, "bad_json", hint); }
    if (typeof d !== "object" || d === null || !Number.isInteger(d.revision) || d.revision < 0) throw new EditError(`history snapshot ${at} has no valid revision (got ${JSON.stringify(d?.revision)})`, "bad_json", hint);
    const who = (field: string, v: unknown) => { try { return checkAuthor(v); } catch (e: any) { throw new EditError(`history snapshot ${at} has an invalid ${field}: ${e.message}`, "bad_json", hint); } };
    return { ...d, author: d.author === undefined ? UNKNOWN_AUTHOR : who("author", d.author), ...(d.movedBy === undefined ? {} : { movedBy: who("movedBy", d.movedBy) }) };
  }
  /** The highest revision any entry of either stack holds; undefined when there is none (an empty history and a deleted one look the same). Creates nothing.
   *  The hint (`strict` off) never throws: an unreadable entry or stack is skipped, and the hint gives the number of the rest. The undo over a damaged project.json
   *  (`strict`) takes the file's number from it, so it throws the entry's or the stack's own error instead of counting only part of the history. */
  private highestStored(strict = false): number | undefined {
    let top = -1;
    const skip = (e: unknown) => { if (strict) throw e; };
    for (const name of ["undo", "redo"]) {
      try {
        if (!existsSync(join(this.root, ".agentcut", "history", name))) continue;
        for (const f of this.entries(name)) {
          try { top = Math.max(top, Project.readEntry(f, name, strict ? "undo" : "sound").revision); } catch (e) { skip(e); }
        }
      } catch (e) { skip(e); }
    }
    return top < 0 ? undefined : top;
  }
  // restored snapshots get a fresh revision, so the revision only ever increases
  private step(from: string, to: string, steps: number, base: number | undefined, mover: string | undefined) {
    if (!Number.isInteger(steps) || steps < 1) throw new EditError(`steps must be a whole number >= 1, got ${JSON.stringify(steps) ?? steps}`, "bad_value", `e.g. ${from} 1; asking for more than the history holds ${from}s what is there and reports it`);
    const by = checkAuthor(mover);
    return this.locked(() => {
      let cur = readFileSync(this.file, "utf8"), rev: number | undefined, damage: unknown;
      // a damaged project.json must not block the recovery its error promises: it is kept in the other stack, and the revision continues from the history
      try { rev = revisionOf(parse(cur), () => this.highestStored()); } catch (e) { if (!(e instanceof EditError && ["bad_json", "bad_revision"].includes(e.code))) throw e; damage = e; }
      if (rev !== undefined) { requireRevision(base); this.checkRevision(base, rev); }
      else if (from !== "undo") throw damage; // an unreadable project.json has no revision to name, and only undo may run there (it is the way out); redo fails with the file's own error
      // every snapshot this call will use is read and version-checked before anything is written: all or nothing
      const e = this.entries(from), snaps: { file: string; label: string; author: string; tl: Timeline }[] = [];
      const beside: Beside = rev === undefined ? "undo" : "sound";
      for (let i = 0; i < steps && i < e.length; i++) {
        const file = e[e.length - 1 - i], d = Project.readEntry(file, from, beside);
        snaps.push({ file, label: d.label, author: d.author, tl: parse(d.timeline, `${from}/${basename(file)}`, beside) });
      }
      if (!snaps.length) throw damage ?? new EditError(`nothing to ${from}`, "empty_history"); // nothing to restore from: the file's own error is the useful one
      // the damaged file is taken to have the number the hint gives (the history's highest + 1), and the entry that keeps it records that number: the undone state lands on the next one
      if (rev === undefined) rev = (this.highestStored(true) ?? -1) + 1;
      this.entries(to); // the stack this call writes to is verified before the first write
      for (const sn of snaps) {
        const pushed = this.push(to, cur, rev, sn.label, sn.author, by);
        sn.tl.revision = ++rev;
        try { this.write(sn.tl); } catch (err) { rmSync(pushed, { force: true }); throw err; } // the snapshot stays where it was until the project file is written
        unlinkSync(sn.file);
        this.prune(to);
        cur = readFileSync(this.file, "utf8");
      }
      return { entries: snaps.map((sn): HistoryEntry => ({ label: sn.label, author: sn.author, movedBy: by })), revision: rev, requested: steps, done: snaps.length };
    });
  }
  /** base: the revision the caller saw, required (missing_revision), except for an undo while project.json is unreadable (a redo there fails with the file's error); any other revision on disk is a conflict. `author` is who undoes or redoes: the moved entry keeps its own author and records this one as movedBy. */
  undo(steps = 1, base?: number, author?: string) { return this.step("undo", "redo", steps, base, author); }
  redo(steps = 1, base?: number, author?: string) { return this.step("redo", "undo", steps, base, author); }
  /** The last 20 entries of each stack. An entry that cannot be read is a named error whose hint speaks of project.json only as far as this call's own read of it: any failure of that read is "unfit". */
  history() {
    let beside: Beside = "sound";
    try { revisionOf(parse(readFileSync(this.file, "utf8"))); } catch { beside = "unfit"; }
    const list = (n: string) => this.entries(n).slice(-20).map((p): HistoryEntry => { const { label, author, movedBy } = Project.readEntry(p, n, beside); return { label, author, ...(movedBy === undefined ? {} : { movedBy }) }; });
    return { undo: list("undo"), redo: list("redo") };
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
  /** Throws invalid_timeline when the timeline has validation errors: render, preview and prepare all stop here before any media tool runs. */
  requireValid(tl: Timeline) {
    const errs = this.validate(tl).filter((i) => i.level === "error");
    if (errs.length) throw new EditError(`timeline has ${errs.length} error(s); first: ${errs[0].path}: ${errs[0].message}`, "invalid_timeline", errs[0].hint ?? "run validate for the full list");
  }
  /** A new file in renders/ no other call has: the name is reserved with an exclusive create (0 bytes), so two calls in the same second
   *  get two names (`-2`, `-3` ... after the stamp). The caller's output replaces the reserved file; a caller that fails calls `releaseOutput`.
   *  shortcut: a process killed by a signal between reserve and rename leaves a 0-byte file in renders/; sweep it if that ever matters */
  defaultOutput(ext = ".mp4", tag = "") {
    // one file-name component: no separators or control characters, no leading dot (so never ".." or a hidden file)
    const name = String(this.load().name ?? "").replace(/[\\/\x00-\x1f]/g, "_").replace(/^\.+/, "") || "video";
    const d = new Date(), pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const dir = ensureDir(this.root, join(this.root, "renders"));
    for (let n = 1; ; n++) {
      const file = join(dir, `${name}${tag ? "-" + tag : ""}-${stamp}${n > 1 ? `-${n}` : ""}${ext}`);
      try { createFile(file, ""); return file; } catch (e: any) { if (e.code !== "EEXIST") throw e; }
    }
  }
  /** Give back a name `defaultOutput` reserved, if nothing was written to it. */
  releaseOutput(file: string) {
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st?.isFile() && st.size === 0) rmSync(file, { force: true });
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
      if (typeof c.match_duration === "string") { const eo = round6(parseTime(c.end_offset ?? 0)); x.push(`length→${c.match_duration}${eo ? `${eo > 0 ? "-" : "+"}${Math.abs(eo)}` : ""}`); }
      if (c.enabled === false) x.push("DISABLED");
      L.push(`      ${s.toFixed(2).padStart(7)}–${(s + d).toFixed(2).padStart(7)}  ${String(c.id ?? "?").padEnd(8)} ${desc}${x.length ? `  [${x.join(" ")}]` : ""}`);
    }
  });
  if (tl.markers?.length) L.push("markers: " + tl.markers.slice(0, 40).map((m) => `${m.t}s ${m.label ?? ""}`.trim()).join(", "));
  return L.join("\n");
}
