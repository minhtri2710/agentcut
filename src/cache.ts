// Project cache management: .agentcut/cache (vision analyses and mattes) and previews/ (frames, sheets, strips,
// UI play drafts). "Referenced" = still needed by the current timeline (mattes of remove_background clips, analyses of
// pending vision requests); everything else can be rebuilt and is pruned first.
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { EditError, type Timeline } from "./model.ts";
import { missingFor } from "./prepare.ts";
import { collectAnalyses, mattesFor } from "./ops-vision.ts";
import { alive, type Project } from "./project.ts";
import { cacheDir } from "./vision.ts";

const MB = 1 << 20;
export const PREVIEWS_MAX_MB = () => Number(process.env.AGENTCUT_PREVIEWS_MAX_MB ?? 200);
interface Entry { area: "cache" | "previews"; root: string; path: string; bytes: number; mtime: number; referenced: boolean }

/** temp output of a write that is still running (pid in the name: safe-write.ts `.part-<pid>-`) */
const inFlight = (f: string) => { const m = /\.part-(\d+)-/.exec(f); return !!m && alive(Number(m[1])); };

/** regular files under dir; symlinks (files or directories) are never followed, counted or deleted */
function files(dir: string): string[] {
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
  return ents.flatMap((d) => { const f = join(dir, d.name); return d.isDirectory() ? files(f) : d.isFile() ? [f] : []; });
}

/** realpath of an area directory (null if absent). Fails closed unless it is exactly where it claims to be under the real
 *  project root: a symlinked area (or symlinked parent) would make prune delete files outside the project. */
function areaRoot(p: Project, dir: string): string | null {
  let real = "";
  try { real = realpathSync(dir); } catch (e: any) { if (e.code === "ENOENT") return null; if (e.code !== "ELOOP") throw e; }
  const rel = relative(p.root, dir);
  if (real !== join(realpathSync(p.root), rel))
    throw new EditError(`${rel} is not a plain directory inside the project (symlink?)`, "unsafe_cache_dir", `AgentCut never deletes through symlinks: replace ${rel} with a real directory`);
  return real;
}

/** analyses the pending vision requests need, cached or not (none if a request no longer applies: prepare reports that) */
function pendingFiles(p: Project, tl: Timeline) {
  try { return collectAnalyses(() => missingFor(p, tl))[1].map((d) => d.file); } catch (e) { if (e instanceof EditError) return []; throw e; }
}

function entries(p: Project, area?: "cache" | "previews"): Entry[] {
  let ref = new Set<string>(); // previews are never referenced: skip the timeline walk for the automatic preview cap
  if (area !== "previews") {
    const tl = p.load();
    ref = new Set([...mattesFor(p.absolutized(tl), p.root).map((m) => m.job.file), ...pendingFiles(p, tl)]);
  }
  const out: Entry[] = [];
  for (const [a, dir] of [["cache", cacheDir(p.root)], ["previews", join(p.root, "previews")]] as const) {
    if (area && a !== area) continue;
    const root = areaRoot(p, dir);
    if (root) for (const f of files(dir)) {
      const st = lstatSync(f, { throwIfNoEntry: false });
      if (st?.isFile() && !inFlight(f)) out.push({ area: a, root, path: f, bytes: st.size, mtime: st.mtimeMs, referenced: ref.has(f) });
    }
  }
  return out;
}

const sum = (es: { bytes: number }[]) => ({ files: es.length, mb: +(es.reduce((n, e) => n + e.bytes, 0) / MB).toFixed(2) });

export function cacheInfo(p: Project) {
  const es = entries(p), area = (a: string) => es.filter((e) => e.area === a);
  const detail = (a: string) => ({ ...sum(area(a)), referenced: sum(area(a).filter((e) => e.referenced)),
    oldest_days: area(a).length ? +((Date.now() - Math.min(...area(a).map((e) => e.mtime))) / 864e5).toFixed(2) : null });
  // render scratch dirs: not pruned by size or age (a render may be using them); `cache prune` and each render or prepare remove those of a process that is gone (sweepStale), so they are counted apart from `total`
  const tmpDir = join(p.root, ".agentcut", "tmp"), tmp = areaRoot(p, tmpDir) ? files(tmpDir).map((f) => ({ bytes: lstatSync(f, { throwIfNoEntry: false })?.size ?? 0 })) : [];
  return { project: p.root, total: sum(es), cache: { dir: cacheDir(p.root), ...detail("cache") }, previews: { dir: join(p.root, "previews"), max_mb: PREVIEWS_MAX_MB(), ...detail("previews") }, tmp: { dir: tmpDir, ...sum(tmp) } };
}

/** "7d", "12h", "30m", "90s" or plain seconds -> ms */
export function parseAge(v: string | number): number {
  const m = /^(\d+(?:\.\d+)?)\s*(d|h|m|s)?$/.exec(String(v).trim());
  if (!m) throw new EditError(`bad age '${v}'`, "bad_value", "use e.g. 7d, 12h, 30m, 90s or seconds");
  return Number(m[1]) * { d: 864e5, h: 36e5, m: 6e4, s: 1e3 }[(m[2] ?? "s") as "d"];
}

/** the file's parent still resolves under its area root (a directory swapped for a symlink since the walk would not); false if already gone */
function contained(e: Pick<Entry, "root" | "path">) {
  let dir: string;
  try { dir = realpathSync(dirname(e.path)); } catch (err: any) { if (err.code === "ENOENT") return false; throw err; }
  if (dir !== e.root && !dir.startsWith(e.root + sep)) throw new EditError(`${relative(e.root, e.path)} resolves outside its cache area`, "unsafe_cache_dir", "AgentCut never deletes through symlinks");
  return true;
}

const PART_FILE = /\.part-(\d+)-/;                // safe-write.ts tmpSibling: <name>.part-<pid>-<rand><ext>
const RENDER_TMP = /^render-(\d+)-[A-Za-z0-9]{6}$/; // encode.ts renderTmp: render-<pid>-<mkdtemp suffix>

/** Remove what a dead process left behind (SIGKILL, crash, power loss; catchable stops clean up after themselves), run at the
 *  start of prepare and of render. Deletes only (a) `.part-<pid>-` files in the project cache dir and (b) `render-<pid>-xxxxxx`
 *  directories in <project>/.agentcut/tmp, only when `alive(pid)` is false (ESRCH only). Every target is a direct child of a
 *  directory that realpath-resolves to where it claims to be under the project (symlinked areas are skipped, never followed),
 *  is re-checked with `contained` right before the delete, and is never a symlink. A pid that was reused by an unrelated live
 *  process looks alive and keeps its file: the safe direction. Names carry no host, so a project shared over a network
 *  filesystem by several machines is out of scope. */
export function sweepStale(p: Project) {
  // Housekeeping must never fail the user's render or prepare: any error with a `code` (an fs error such as EBUSY / EPERM while an
  // orphan still holds a file, or an EditError from the containment checks) leaves that entry for the next sweep. A containment
  // failure never reaches the delete.
  const soft = <T,>(f: () => T, otherwise: T): T => { try { return f(); } catch (e: any) { if (typeof e?.code === "string") return otherwise; throw e; } };
  const list = (dir: string) => soft(() => readdirSync(dir, { withFileTypes: true }), []);
  const plain = (dir: string) => soft(() => areaRoot(p, dir), null);
  const rm = (e: Pick<Entry, "root" | "path">, recursive: boolean) => soft(() => { if (contained(e)) rmSync(e.path, { recursive, force: true }); }, undefined);
  const cache = cacheDir(p.root), cacheRoot = plain(cache);
  if (cacheRoot) for (const d of list(cache)) { // the cache dir is flat: direct children only, regular files only
    const m = PART_FILE.exec(d.name);
    if (d.isFile() && m && !alive(Number(m[1]))) rm({ root: cacheRoot, path: join(cache, d.name) }, false);
  }
  const tmp = join(p.root, ".agentcut", "tmp"), tmpRoot = plain(tmp);
  if (tmpRoot) for (const d of list(tmp)) {
    const m = RENDER_TMP.exec(d.name);
    if (d.isDirectory() && m && !alive(Number(m[1]))) rm({ root: tmpRoot, path: join(tmp, d.name) }, true);
  }
}

/** Delete cache/preview files. Only files older than olderThan (if given) are eligible. Without maxMb: every eligible
 *  unreferenced file. With maxMb: eligible files until the total is <= maxMb - unreferenced first, oldest first, and
 *  referenced ones (rebuilt by prepare) only if that is not enough. */
export function prune(p: Project, o: { maxMb?: number; olderThan?: string | number; area?: "cache" | "previews"; keep?: string[] } = {}) {
  if (o.maxMb !== undefined && !(o.maxMb >= 0)) throw new EditError("max_mb must be a number >= 0", "bad_value");
  const es = entries(p, o.area), cutoff = o.olderThan !== undefined ? Date.now() - parseAge(o.olderThan) : Infinity;
  const eligible = es.filter((e) => e.mtime < cutoff && !o.keep?.includes(e.path)).sort((a, b) => Number(a.referenced) - Number(b.referenced) || a.mtime - b.mtime);
  let total = es.reduce((n, e) => n + e.bytes, 0);
  const removed: Entry[] = [];
  for (const e of eligible) {
    if (o.maxMb !== undefined ? total <= o.maxMb * MB : e.referenced) break;
    if (!contained(e)) continue;
    rmSync(e.path, { force: true });
    total -= e.bytes;
    removed.push(e);
  }
  return { removed: sum(removed), removed_referenced: removed.filter((e) => e.referenced).length,
    files: removed.slice(0, 50).map((e) => relative(p.root, e.path).split(sep).join("/")), left: { files: es.length - removed.length, mb: +(total / MB).toFixed(2) },
    ...(removed.some((e) => e.referenced) ? { hint: "referenced files were removed: run prepare before the next preview/render" } : {}) };
}

/** Automatic bound on previews/ after writing `written` (AGENTCUT_PREVIEWS_MAX_MB, default 200; 0 disables): oldest
 *  previews go first, the files just written stay. Outputs elsewhere (-o) are not touched. */
export function capPreviews(p: Project, ...written: string[]) {
  const max = PREVIEWS_MAX_MB(), dir = join(p.root, "previews");
  if (max > 0 && written.some((w) => w.startsWith(dir + sep))) prune(p, { maxMb: max, area: "previews", keep: written });
}
