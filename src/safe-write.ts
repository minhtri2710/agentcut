// The only way AgentCut creates files and directories in a project tree (and in its own user dirs: feedback, font cache).
// A folder written by someone else may hold symlinks or hard links at any path we write, so nothing here follows one:
//  - directories are walked with lstat, one component at a time, below a trusted base (the project root, which itself may be a symlink);
//  - files are created under a new random sibling name (O_EXCL) and renamed over the final name, which replaces a link there
//    instead of writing through it;
//  - the one append (feedback) opens with O_NOFOLLOW and refuses a file with other hard links.
// A refused path is an EditError "unsafe_path"; there is no fallback to a plain write. Lock and project files are created with a hard
// link, so a volume without hard links is refused with "unsupported_fs".
import { randomBytes } from "node:crypto";
import { closeSync, constants, copyFileSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EditError } from "./model.ts";

const refuse = (what: string) => new EditError(`${what} is not a plain directory or file here (symlink or link?)`, "unsafe_path",
  "AgentCut never writes through symlinks or hard links: replace it with a real directory (or file)");
const outside = (rel: string) => rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel);

/** exists, a dangling symlink included (existsSync follows the link, so a dangling one reads as absent) */
export const lexists = (f: string) => { try { lstatSync(f); return true; } catch (e: any) { if (e.code === "ENOENT") return false; throw e; } };

/** Walk `dir` (the base itself or a path below it) from `base`, one component at a time with lstat. One that exists as anything but a
 *  real directory is refused. With `make`, a missing one is made with a non-recursive mkdir (and the base is created if missing);
 *  without, the walk ends at the first missing component. */
function walk(base: string, dir: string, make: boolean): string {
  base = resolve(base); dir = resolve(dir);
  const rel = relative(base, dir);
  if (outside(rel)) throw new EditError(`${dir} is not inside ${base}`, "unsafe_path", "AgentCut writes only below the project folder");
  if (make) mkdirSync(base, { recursive: true });
  let d = base;
  for (const part of rel.split(sep).filter(Boolean)) {
    d = join(d, part);
    let st = lstatSync(d, { throwIfNoEntry: false });
    if (!st) {
      if (!make) break;
      try { mkdirSync(d); continue; } catch (e: any) { if (e.code !== "EEXIST") throw e; st = lstatSync(d); } // another process made it first
    }
    if (!st.isDirectory()) throw refuse(relative(base, d));
  }
  return dir;
}

/** `dir` (the base itself or a path below it) as real directories. `base` is trusted and created if missing; every component below it
 *  is lstat-checked, and one that exists as anything but a real directory is refused before anything is created. */
export const ensureDir = (base: string, dir: string) => walk(base, dir, true);

/** The same checks, creating nothing: refuses what ensureDir would refuse. */
export const checkDir = (base: string, dir: string) => { walk(base, dir, false); };

/** realpath, or null for a path that does not exist (or is a dangling or looping link) */
const real = (p: string) => { try { return realpathSync.native(p); } catch (e: any) { if (["ENOENT", "ENOTDIR", "ELOOP"].includes(e.code)) return null; throw e; } };

/** `dir` as a path below `base`, or null when it is not in the project. A path counts as inside when `base` or any ancestor of it
 *  is the same directory as `base` (compared by realpath): the project under another spelling (a link to it, a link to its parent,
 *  /private/var for /var, another letter case) is the project. The part below that ancestor is returned relative to `base`, so it
 *  is walked from the project root with lstat, whatever links its own components are. */
function below(base: string, dir: string): string | null {
  base = resolve(base);
  const root = real(base);
  if (root === null) { const rel = relative(base, dir); return outside(rel) ? null : dir; } // not made yet: only the spelling given can be judged
  for (let a = dir; ; a = dirname(a)) {
    if (real(a) === root) return join(base, relative(a, dir));
    if (dirname(a) === a) return null;
  }
}

/** The directory of `file`. In the project (see `below`): ensured as above. Elsewhere (no base, or an output path the user typed
 *  outside the project): the user's chosen location, created with mkdir -p; the file itself is still written by the rules below. */
function ensureParent(file: string, base?: string) {
  const dir = dirname(resolve(file)), inner = base ? below(base, dir) : null;
  if (inner !== null) ensureDir(base!, inner);
  else mkdirSync(dir, { recursive: true });
}

/** The project root `root`, made if missing, on a volume that supports hard links (see createExclusive): one probe with the same
 *  primitive. When it refuses, or anything else fails, the directories this call made are removed again (and only those). */
export function ensureRoot(root: string) {
  root = resolve(root);
  const missing: string[] = [];
  for (let d = root; !lexists(d); d = dirname(d)) missing.push(d);
  const made: string[] = [];
  try {
    for (const d of missing.reverse()) { try { mkdirSync(d); made.push(d); } catch (e: any) { if (e.code !== "EEXIST") throw e; } }
    probeLinks(root);
  } catch (e) {
    for (const d of made.reverse()) { try { rmdirSync(d); } catch { break; } } // deepest first; rmdir only removes an empty directory
    throw e;
  }
}

/** A new name next to `file`, `<name>.part-<pid>-<rand><ext>` (the extension is kept so ffmpeg picks the muxer; cache.ts treats
 *  `.part-<pid>-` as in flight while the pid lives). Nothing exists at it. */
const nameBeside = (file: string) => { const ext = extname(file); return `${file.slice(0, file.length - ext.length)}.part-${process.pid}-${randomBytes(6).toString("hex")}${ext}`; };

/** A new name for something an external program (ffmpeg, the vision helper) writes before `commit`; the directory is ensured first. */
export function tmpSibling(file: string, base?: string): string {
  ensureParent(file, base);
  return nameBeside(file);
}

/** Put the finished temp file at `file`; a symlink or file already there is replaced, never written through. A directory there is refused. */
export function commit(tmp: string, file: string) {
  try { renameSync(tmp, file); }
  catch (e: any) { throw e.code === "EISDIR" || e.code === "ENOTDIR" ? refuse(file) : e; }
}

/** Create `file` (O_EXCL: it never follows a link and never reuses an existing name). For files in a directory we just made. */
export const createFile = (file: string, data: string | Uint8Array, mode?: number) => writeFileSync(file, data, { flag: "wx", mode });

/** `make` puts the content at the new name `tmp`, then it replaces `file`. If `make` fails with EEXIST the name was not ours and is left
 *  alone; any other failure, and a failed rename, removes the temp file. */
function place(tmp: string, file: string, make: () => void) {
  try { make(); } catch (e: any) { if (e.code !== "EEXIST") rmSync(tmp, { force: true }); throw e; }
  try { commit(tmp, file); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Write `file` atomically: readers see the old or the new content, never a part. */
export function writeFile(file: string, data: string | Uint8Array, base?: string) {
  const tmp = tmpSibling(file, base);
  place(tmp, file, () => createFile(tmp, data));
}

/** Copy `src` to `file` the same way (the content lands under a new name first, then replaces `file`). */
export function copyFile(src: string, file: string, base?: string) {
  const tmp = tmpSibling(file, base);
  place(tmp, file, () => copyFileSync(src, tmp, constants.COPYFILE_EXCL));
}

/** The link errors of a volume that has no hard links (exFAT, FAT, some network and FUSE mounts), as a named error; null for any other error. */
export function linkRefusal(e: { code?: string }): EditError | null {
  if (!["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "ENOSYS"].includes(e.code ?? "")) return null;
  return new EditError("this volume does not support hard links, which AgentCut needs for its project and lock files", "unsupported_fs",
    "put the project directory on an APFS, NTFS or ext4 volume; media files may stay where they are (exFAT and FAT volumes are not supported)");
}

/** Prove hard links work in `dir` (a temp file, a link to it, both removed). */
export function probeLinks(dir: string) {
  const a = nameBeside(join(dir, "link-probe")), b = nameBeside(join(dir, "link-probe"));
  createFile(a, "");
  try { linkSync(a, b); }
  catch (e: any) { throw linkRefusal(e) ?? e; }
  finally { rmSync(a, { force: true }); rmSync(b, { force: true }); }
}

/** Create `file` only if nothing is there (a dangling symlink counts), with the full content already in place: the content is
 *  written to a new name and hard-linked to `file`, so readers never see a half-written file. false if `file` exists. The directory exists. A volume without hard links gives "unsupported_fs". */
export function createExclusive(file: string, body: string): boolean {
  const tmp = nameBeside(file);
  createFile(tmp, body);
  try { linkSync(tmp, file); return true; }
  catch (e: any) { if (e.code === "EEXIST") return false; throw linkRefusal(e) ?? e; }
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
