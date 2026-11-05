// Size/count cap for the files the web UI generates (previews/ui/: contact sheets, play drafts). LRU by mtime: a cache
// hit touches its file, so pruning drops what was used longest ago.
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

export const UI_CACHE_LIMITS = { bytes: 512 * 1024 * 1024, files: 64 };

export function touch(abs: string) { const now = new Date(); utimesSync(abs, now, now); }

/** Delete the least recently used files until `dir` fits the limits; `keep` (the file just produced) always survives. */
export function prune(dir: string, keep?: string, lim = UI_CACHE_LIMITS) {
  mkdirSync(dir, { recursive: true });
  const files = readdirSync(dir).flatMap((n) => {
    const abs = join(dir, n);
    try { const s = statSync(abs); return s.isFile() ? [{ abs, size: s.size, mtime: s.mtimeMs }] : []; } catch { return []; } // raced with a delete
  }).sort((a, b) => Number(b.abs === keep) - Number(a.abs === keep) || b.mtime - a.mtime);
  let bytes = 0, n = 0;
  const removed: string[] = [];
  for (const f of files) {
    bytes += f.size; n++;
    if (f.abs !== keep && (bytes > lim.bytes || n > lim.files)) { rmSync(f.abs, { force: true }); removed.push(f.abs); bytes -= f.size; n--; }
  }
  return removed;
}
