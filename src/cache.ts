// Project cache management: .agentcut/cache (vision analyses, mattes, helper script) and previews/ (frames, sheets, strips,
// UI play drafts). "Referenced" = still needed by the current timeline (mattes of remove_background clips, analyses of
// pending vision requests, the current helper script); everything else can be rebuilt and is pruned first.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { EditError, type Timeline } from "./model.ts";
import { missingFor } from "./prepare.ts";
import { mattesFor } from "./ops-vision.ts";
import type { Project } from "./project.ts";
import { cacheDir, helperScript } from "./vision.ts";

const MB = 1 << 20;
export const PREVIEWS_MAX_MB = () => Number(process.env.AGENTCUT_PREVIEWS_MAX_MB ?? 200);
interface Entry { area: "cache" | "previews"; path: string; bytes: number; mtime: number; referenced: boolean }

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === "EPERM"; } };
/** temp output of a compute/render that is still running (pid in the name: vision.ts `.part-<pid>-`, `.<pid>.tmp`) */
const inFlight = (f: string) => { const m = /\.part-(\d+)-|\.(\d+)\.tmp$/.exec(f); return !!m && alive(Number(m[1] ?? m[2])); };

function files(dir: string): string[] {
  let names: string[];
  try { names = readdirSync(dir); } catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
  return names.flatMap((n) => { const f = join(dir, n), st = statSync(f, { throwIfNoEntry: false }); return st?.isDirectory() ? files(f) : st ? [f] : []; });
}

/** analyses the pending vision requests still need (none if a request no longer applies: prepare reports that) */
function pendingFiles(p: Project, tl: Timeline) {
  try { return missingFor(p, tl).jobs.map((d) => d.file); } catch (e) { if (e instanceof EditError) return []; throw e; }
}

function entries(p: Project, area?: "cache" | "previews"): Entry[] {
  let ref = new Set<string>(); // previews are never referenced: skip the timeline walk for the automatic preview cap
  if (area !== "previews") {
    const tl = p.load();
    ref = new Set([helperScript(p.root), ...mattesFor(p.absolutized(tl), p.root).map((m) => m.job.file), ...pendingFiles(p, tl)]);
  }
  const out: Entry[] = [];
  for (const [a, dir] of [["cache", cacheDir(p.root)], ["previews", join(p.root, "previews")]] as const) {
    if (area && a !== area) continue;
    for (const f of files(dir)) {
      const st = statSync(f, { throwIfNoEntry: false });
      if (st && !inFlight(f)) out.push({ area: a, path: f, bytes: st.size, mtime: st.mtimeMs, referenced: ref.has(f) });
    }
  }
  return out;
}

const sum = (es: Entry[]) => ({ files: es.length, mb: +(es.reduce((n, e) => n + e.bytes, 0) / MB).toFixed(2) });

export function cacheInfo(p: Project) {
  const es = entries(p), area = (a: string) => es.filter((e) => e.area === a);
  const detail = (a: string) => ({ ...sum(area(a)), referenced: sum(area(a).filter((e) => e.referenced)),
    oldest_days: area(a).length ? +((Date.now() - Math.min(...area(a).map((e) => e.mtime))) / 864e5).toFixed(2) : null });
  return { project: p.root, total: sum(es), cache: { dir: cacheDir(p.root), ...detail("cache") }, previews: { dir: join(p.root, "previews"), max_mb: PREVIEWS_MAX_MB(), ...detail("previews") } };
}

/** "7d", "12h", "30m", "90s" or plain seconds -> ms */
export function parseAge(v: string | number): number {
  const m = /^(\d+(?:\.\d+)?)\s*(d|h|m|s)?$/.exec(String(v).trim());
  if (!m) throw new EditError(`bad age '${v}'`, "bad_value", "use e.g. 7d, 12h, 30m, 90s or seconds");
  return Number(m[1]) * { d: 864e5, h: 36e5, m: 6e4, s: 1e3 }[(m[2] ?? "s") as "d"];
}

/** Delete cache/preview files. Only files older than olderThan (if given) are eligible. Without maxMb: every eligible
 *  unreferenced file. With maxMb: eligible files until the total is <= maxMb - unreferenced first, oldest first, and
 *  referenced ones (rebuilt by prepare) only if that is not enough. */
export function prune(p: Project, o: { maxMb?: number; olderThan?: string | number; area?: "cache" | "previews"; keep?: string } = {}) {
  if (o.maxMb !== undefined && !(o.maxMb >= 0)) throw new EditError("max_mb must be a number >= 0", "bad_value");
  const es = entries(p, o.area), cutoff = o.olderThan !== undefined ? Date.now() - parseAge(o.olderThan) : Infinity;
  const eligible = es.filter((e) => e.mtime < cutoff && e.path !== o.keep).sort((a, b) => Number(a.referenced) - Number(b.referenced) || a.mtime - b.mtime);
  let total = es.reduce((n, e) => n + e.bytes, 0);
  const removed: Entry[] = [];
  for (const e of eligible) {
    if (o.maxMb !== undefined ? total <= o.maxMb * MB : e.referenced) break;
    rmSync(e.path, { force: true });
    total -= e.bytes;
    removed.push(e);
  }
  return { removed: sum(removed), removed_referenced: removed.filter((e) => e.referenced).length,
    files: removed.slice(0, 50).map((e) => relative(p.root, e.path).split(sep).join("/")), left: { files: es.length - removed.length, mb: +(total / MB).toFixed(2) },
    ...(removed.some((e) => e.referenced) ? { hint: "referenced files were removed: run prepare before the next preview/render" } : {}) };
}

/** Automatic bound on previews/ after writing `written` (AGENTCUT_PREVIEWS_MAX_MB, default 200; 0 disables): oldest
 *  previews go first, the file just written stays. Outputs elsewhere (-o) are not touched. */
export function capPreviews(p: Project, written: string) {
  const max = PREVIEWS_MAX_MB(), dir = join(p.root, "previews");
  if (max > 0 && written.startsWith(dir + sep)) prune(p, { maxMb: max, area: "previews", keep: written });
}
