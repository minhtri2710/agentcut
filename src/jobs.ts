// The one retention rule for the background jobs the UI server and the MCP server keep in a Map by id. A leaf module, like own.ts.
export const JOBS_KEPT = 64; // the newest finished jobs (by end) a server remembers, so a long session does not grow without bound; older ids answer not_found

/** a job that ended goes to the end of the map (a Map iterates in insertion order), so finished jobs are listed earliest-ended first; the earliest-ended beyond JOBS_KEPT go, a running job stays */
export function endJob<T extends { status?: unknown }>(jobs: Map<string, T>, id: string, job: T) {
  jobs.delete(id); jobs.set(id, job);
  const finished = [...jobs].filter(([, j]) => j.status !== "running");
  for (const [old] of finished.slice(0, Math.max(0, finished.length - JOBS_KEPT))) jobs.delete(old);
}
