// The only way AgentCut creates files and directories in a project tree (and in its own user dirs: feedback, font cache).
// A folder written by someone else may hold symlinks or hard links at any path we write, so nothing here follows one:
//  - directories are walked with lstat, one component at a time, below a trusted base (the project root, which itself may be a symlink);
//  - files are created under a new random sibling name (O_EXCL) and renamed over the final name, which replaces a link there
//    instead of writing through it;
//  - the one append (feedback) opens with O_NOFOLLOW and refuses a file with other hard links.
// A refused path is an EditError "unsafe_path"; there is no fallback to a plain write.
import { randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EditError } from "./model.ts";

const refuse = (what: string) => new EditError(`${what} is not a plain directory or file here (symlink or link?)`, "unsafe_path",
  "AgentCut never writes through symlinks or hard links: replace it with a real directory (or file)");
const outside = (rel: string) => rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);

/** exists, a dangling symlink included (existsSync follows the link, so a dangling one reads as absent) */
export const lexists = (f: string) => { try { lstatSync(f); return true; } catch (e: any) { if (e.code === "ENOENT") return false; throw e; } };

/** `dir` (the base itself or a path below it) as real directories. `base` is trusted and created if missing; every component below it
 *  is lstat-checked and made with a non-recursive mkdir, and one that exists as anything but a real directory is refused before
 *  anything is created. */
export function ensureDir(base: string, dir: string): string {
  base = resolve(base); dir = resolve(dir);
  const rel = relative(base, dir);
  if (outside(rel)) throw new EditError(`${dir} is not inside ${base}`, "unsafe_path", "AgentCut writes only below the project folder");
  mkdirSync(base, { recursive: true });
  let d = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    d = join(d, part);
    let st = lstatSync(d, { throwIfNoEntry: false });
    if (!st) {
      try { mkdirSync(d); continue; } catch (e: any) { if (e.code !== "EEXIST") throw e; st = lstatSync(d); } // another process made it first
    }
    if (!st.isDirectory()) throw refuse(relative(base, d));
  }
  return dir;
}

/** The directory of `file`. Inside `base`: checked as above. Elsewhere (no base, or an output path the user typed outside the project):
 *  the user's chosen location, created with mkdir -p; the file itself is still written by the rules below. */
function ensureParent(file: string, base?: string) {
  const dir = dirname(resolve(file));
  if (base && !outside(relative(resolve(base), dir))) ensureDir(base, dir);
  else mkdirSync(dir, { recursive: true });
}

/** A new name next to `file`, `<name>.part-<pid>-<rand><ext>` (the extension is kept so ffmpeg picks the muxer; cache.ts treats
 *  `.part-<pid>-` as in flight while the pid lives). Nothing exists at it. */
const nameBeside = (file: string) => { const ext = extname(file); return `${file.slice(0, file.length - ext.length)}.part-${process.pid}-${randomBytes(6).toString("hex")}${ext}`; };

/** A new name for something an external program (ffmpeg, the vision helper) writes before `commit`; the directory is ensured first. */
export function tmpSibling(file: string, base?: string): string {
  ensureParent(file, base);
  return nameBeside(file);
}

/** Put the finished temp file at `file`; a symlink or file already there is replaced, never written through. */
export const commit = (tmp: string, file: string) => renameSync(tmp, file);

/** Create `file` (O_EXCL: it never follows a link and never reuses an existing name). For files in a directory we just made. */
export const createFile = (file: string, data: string | Uint8Array, mode?: number) => writeFileSync(file, data, { flag: "wx", mode });

/** Write `file` atomically: readers see the old or the new content, never a part. */
export function writeFile(file: string, data: string | Uint8Array, base?: string) {
  const tmp = tmpSibling(file, base);
  try { createFile(tmp, data); commit(tmp, file); }
  catch (e: any) { if (e.code !== "EEXIST") rmSync(tmp, { force: true }); throw e; }
}

/** Copy `src` to `file` the same way (the content lands under a new name first, then replaces `file`). */
export function copyFile(src: string, file: string, base?: string) {
  const tmp = tmpSibling(file, base);
  try { copyFileSync(src, tmp, constants.COPYFILE_EXCL); commit(tmp, file); }
  catch (e: any) { if (e.code !== "EEXIST") rmSync(tmp, { force: true }); throw e; }
}

/** Create `file` only if nothing is there (a dangling symlink counts), with the full content already in place: the content is
 *  written to a new name and hard-linked to `file`, so readers never see a half-written file. false if `file` exists. The directory exists. */
export function createExclusive(file: string, body: string): boolean {
  const tmp = nameBeside(file);
  createFile(tmp, body);
  try { linkSync(tmp, file); return true; }
  catch (e: any) { if (e.code === "EEXIST") return false; throw e; }
  finally { rmSync(tmp, { force: true }); }
}

/** Append to `file`, creating it. Not rename-and-replace: concurrent appenders (several AgentCut processes logging events) would lose
 *  each other's lines, while O_APPEND keeps every write whole. The final name is checked with lstat (a symlink or anything that is
 *  not a regular file is refused), opened with O_NOFOLLOW where the platform has it, and the opened file must have no other hard link. */
export function appendFile(file: string, text: string, base?: string) {
  ensureParent(file, base);
  const pre = lstatSync(file, { throwIfNoEntry: false });
  if (pre && !pre.isFile()) throw refuse(file);
  let fd: number;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o666); }
  catch (e: any) { throw e.code === "ELOOP" ? refuse(file) : e; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1) throw refuse(file);
    writeSync(fd, text);
  } finally { closeSync(fd); }
}
