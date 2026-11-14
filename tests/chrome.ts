// The one place the suite starts Chrome. Why: an installed Chrome can start its own browser-update helper and wake the
// machine's update service, which downloads and installs components on a developer's host. Every launch therefore runs under
// macOS `sandbox-exec` with a profile that denies executing those helpers and the update service's mach names, denies writes to the
// update service's directories, and denies the network except loopback. There is no uncontained path and no switch for one:
// a host without sandbox-exec (or a seat that is itself sandboxed) fails the suite instead of launching Chrome.
// The mach-lookup deny has no row of its own (no safe probe exists): it is covered by the profile parsing and by the denial count of a run.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// SBPL regexes have no case-insensitive flag, so each letter that varies is a class
export const EXEC_DENY = ["[Gg]oogle[Uu]pdater", "[Kk]eystone", "[Kk]sadmin", "launchctl"];
const MACH_DENY = "^com\\.google\\.([Gg]oogle[Uu]pdater|[Kk]eystone)";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CHROME = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
/** CHROME, when set, is the only binary tried: a wrong path fails instead of falling back to another browser */
export const resolveChrome = (): string | undefined =>
  process.env.CHROME || [MAC_CHROME, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((d) => LINUX_CHROME.map((n) => join(d, n)))].find((p) => existsSync(p));
export const chromeHint = () => process.env.CHROME ? `CHROME=${process.env.CHROME} does not exist` : `looked at ${MAC_CHROME}, and ${LINUX_CHROME.join(", ")} on PATH; set CHROME=/path/to/chrome`;

/** The executables of the update helper that ships inside an installed Chrome (listed, never run). */
export const bundledUpdaterHelpers = (chrome: string): string[] => {
  const app = chrome.slice(0, chrome.indexOf(".app/") + 4), fw = join(app, "Contents", "Frameworks");
  const ls = (p: string) => { try { return readdirSync(p); } catch { return []; } };
  return ls(fw).flatMap((f) => ls(join(fw, f, "Versions")).flatMap((v) => ls(join(fw, f, "Versions", v, "Helpers", "GoogleUpdater.app", "Contents", "MacOS")).map((x) => join(fw, f, "Versions", v, "Helpers", "GoogleUpdater.app", "Contents", "MacOS", x))));
};

// Chrome locks its profile with a unix socket it binds in the per-user temp dir; `deny network*` would stop that and Chrome would not start.
// This is the only allow beyond loopback: that one file name, nothing outbound.
export const SINGLETON_ALLOW = '(allow network-bind (local unix-socket (regex #"^/(private/)?var/folders/[^/]+/[^/]+/T/com\\.google\\.Chrome\\.[^/]+/SingletonSocket$")))';
const q = (s: string) => `"${s.replace(/[\\"]/g, "\\$&")}"`;
export const profileText = (home = homedir()): string => `(version 1)
(allow default)
(deny process-exec ${EXEC_DENY.map((r) => `(regex #"${r}")`).join(" ")})
(deny mach-lookup (global-name-regex #"${MACH_DENY}"))
(deny lsopen)
(deny file-write* (subpath ${q(join(home, "Library/Google"))}) (subpath ${q(join(home, "Library/Application Support/Google/GoogleUpdater"))}) (subpath ${q(join(home, "Library/LaunchAgents"))}) (subpath "/Library/Google") (subpath "/Library/LaunchAgents") (subpath "/Library/LaunchDaemons"))
(deny network*)
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
${SINGLETON_ALLOW}
`;

/** Why the containment cannot be had on this host, or null. */
export const containmentProblem = (platform: string = process.platform, sandboxExec: string = SANDBOX_EXEC): string | null =>
  platform !== "darwin" ? `no Chrome containment on ${platform}` : !existsSync(sandboxExec) ? `no Chrome containment: ${sandboxExec} is missing` : null;

/** Writes the profile into dir and returns its path. */
export const writeProfile = (dir: string): string => { const p = join(dir, "chrome-contain.sb"); writeFileSync(p, profileText()); return p; };

/** Writes the profile and proves it applies (parses, and this seat can apply one): exits 1 naming the cause. */
export const containOrExit = (dir: string, who: string): string => {
  const why = containmentProblem();
  if (why) { console.error(`FAILED: ${who}: ${why}`); process.exit(1); }
  const profile = writeProfile(dir);
  const r = spawnSync(SANDBOX_EXEC, ["-f", profile, "/usr/bin/true"], { encoding: "utf8", timeout: 20_000 });
  if (r.status !== 0) { console.error(`FAILED: ${who}: the Chrome containment profile does not apply (exit ${r.status}): ${r.stderr.trim().slice(0, 300)}`); process.exit(1); }
  return profile;
};

// The first two cut the denied traffic's noise. --no-sandbox: inside our profile, Chrome's helper processes cannot apply Chrome's own
// Seatbelt profile (a nested sandbox_init), so with it on, every helper dies with `sandbox initialization failed: Operation not permitted`
// and no renderer starts. Chrome's own renderer sandbox is therefore off, but the outer profile above still holds that renderer: no updater
// exec, no network but loopback, no writes to the update directories, and it loads only the suite's own loopback page.
// This flag exists only here, next to the profile, so it never appears without it.
export const CONTAINED_FLAGS = ["--disable-background-networking", "--disable-component-update", "--no-sandbox"];
export const launchChrome = (chrome: string, profile: string, args: string[]): ChildProcess =>
  spawn(SANDBOX_EXEC, ["-f", profile, chrome, ...CONTAINED_FLAGS, ...args], { stdio: ["ignore", "ignore", "pipe"] });

/** A test file that starts Chrome itself instead of going through launchChrome. */
export const spawnsChromeDirectly = (text: string): boolean => /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*(CHROME|MAC_CHROME|chrome)\b|Google Chrome\.app/.test(text);

/** A page fetch outcome that shows the network layer refused the address at once (not a timeout, not a response). */
export const refusedAtOnce = (r: { outcome: string; ms: number; errorText?: string }): boolean =>
  r.outcome === "failed" && r.ms < 3000 && /^net::ERR_/.test(r.errorText ?? "") && !/TIMED_OUT/.test(r.errorText ?? "");
