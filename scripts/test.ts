// `bun run test`: every suite one at a time, in order; a failing suite does not hide the later ones. Exit 1 if any failed, and name them at the end.
// Suite files may be given as arguments (paths) instead of the default list. Each suite's own output is passed through unchanged.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = ["smoke", "mcp", "edit-ops", "compound", "codecs", "export", "ui", "audio", "color-tts", "verify", "writes", "vision", "review", "jobs", "ui-browser", "realmedia", "launchers"]
  .map((n) => `tests/${n}.ts`);
const suites = process.argv.length > 2 ? process.argv.slice(2) : SUITES;

const failed: string[] = [];
for (const s of suites) {
  const r = spawnSync(process.execPath, ["--no-install", s], { cwd: root, stdio: "inherit" });
  if (r.status !== 0) failed.push(`${s} (${r.status === null ? `signal ${r.signal ?? "?"}` : `exit ${r.status}`}${r.error ? `: ${r.error.message}` : ""})`);
}
if (failed.length) console.error(`\n${failed.length} of ${suites.length} suites failed:\n${failed.map((f) => `  ${f}`).join("\n")}`);
else console.log(`\nall ${suites.length} suites passed`);
process.exit(failed.length ? 1 : 0);
