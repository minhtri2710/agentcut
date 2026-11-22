// What every suite shares: the check reporter and its failure count, the ffmpeg fixture runner, and applyLatest.
// A suite still owns its tmp dir, its summary line and its exit (`process.exit(failures() ? 1 : 0)`).
import { spawnSync } from "node:child_process";
import type * as Api from "./author-api.ts";

let count = 0;
/** checks that failed so far */
export const failures = () => count;

export function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { count++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info) : ""); }
}

/** runs ffmpeg to make a fixture; throws with its stderr when it fails */
export function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-nostdin", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/** apply at the project's current revision, for rows that are not about concurrency (the rows about revisions pass theirs by hand).
 *  The API is imported on first call, after the suite has set AGENTCUT_HOME / AGENTCUT_CACHE.
 *  info "json": the text summary cannot print a clip without an id, which some rows save on purpose. */
export async function applyLatest(project: string, ops: Parameters<typeof Api.apply>[1], o: { label?: string; allowInvalid?: boolean; dryRun?: boolean; author?: string; signal?: AbortSignal } = {}) {
  const api = await import("./author-api.ts");
  return api.apply(project, ops, { ...o, revision: (await api.info(project, "json")).revision });
}
