// `prepare`: compute the derived assets the timeline needs (remove_background mattes, auto_reframe / track_to analyses)
// outside apply_ops, then re-apply the pending vision requests so their keyframes land. Preview/render fail fast with
// not_prepared until this ran (ops-vision attachPrepared). Results are cached per file hash + params (vision.ts).
import { type Clip, allClips, type Dict, EditError, type Timeline } from "./model.ts";
import { applyOps } from "./ops.ts";
import { collectMissing, mattesFor } from "./ops-vision.ts";
import type { Project } from "./project.ts";
import * as V from "./vision.ts";

// pending vision ops in dependency order (track_to maps its box through the target's reframed focus)
const ORDER = ["auto_reframe", "track_to"];
const pendingOps = (tl: Timeline) => ORDER.flatMap((op) =>
  [...allClips(tl.tracks)].filter((c: Clip) => c.pending?.[op]).map((c) => ({ op, id: c.id, ...c.pending[op] })));

/** Derived assets the timeline still lacks, plus the pending ops (re-run here so their validation runs on the current edit). */
export function missingFor(p: Project, tl: Timeline) {
  const ops = pendingOps(tl);
  const [, analyses] = collectMissing(() => {
    try { return applyOps(p, tl, ops); }
    catch (e) {
      if (!(e instanceof EditError)) throw e;
      const i = Number(/^ops\[(\d+)\]/.exec(e.path ?? "")?.[1]), q = ops[i];
      if (q) { e.message = `pending ${q.op} on '${q.id}' no longer applies: ${e.message}`; e.hint = `${e.hint ? e.hint + "; " : ""}fix the clip, or drop the request with update_clip id=${q.id} set={pending:null} and re-run ${q.op}`; }
      throw e;
    }
  });
  const mattes = mattesFor(p.absolutized(tl), p.root).map((m) => m.job).filter((d) => !V.isReady(d));
  const seen = new Set<string>();
  return { ops, jobs: [...mattes, ...analyses].filter((d) => !seen.has(d.file) && seen.add(d.file)) };
}

// one computation per cache file per process, however many prepare calls ask for it
const inflight = new Map<string, Promise<{ cached: boolean }>>();
// (the first caller's abort signal governs a shared computation: the only abort is the server stopping, which stops every job)
function computeOnce(d: V.Derived, onFrames: (n: number) => void, signal?: AbortSignal) {
  let job = inflight.get(d.file);
  if (!job) { job = V.compute(d, onFrames, signal).finally(() => inflight.delete(d.file)); inflight.set(d.file, job); }
  return job;
}

export async function prepare(p: Project, o: { progress?: (done: number, total: number) => void; signal?: AbortSignal } = {}) {
  const computed: Dict[] = [];
  let applied: Dict[] = [], revision = p.load().revision;
  // a round computes what is missing now; a pending track_to on a pending reframe only shows its job in the next round
  for (let round = 0; ; round++) {
    o.signal?.throwIfAborted();
    const tl = p.load(), { ops, jobs } = missingFor(p, tl);
    if (!jobs.length) {
      if (ops.length) {
        const [next, results] = applyOps(p, tl, ops);
        if ([...allClips(next.tracks)].some((c) => c.pending))
          throw new EditError("prepare could not resolve every pending vision request", "vision_failed", "inspect clip.pending with info --json; remove a stale request with update_clip set={pending:null}");
        try { revision = p.save(next, "prepare"); }
        catch (e) { if (e instanceof EditError && e.code === "conflict" && round < 5) continue; throw e; }
        applied = results;
      }
      return { revision, computed, applied, ready: true };
    }
    if (round > ORDER.length) {
      // the timeline moved since prepare started: edits kept adding requests, not a bug
      if (tl.revision !== revision) throw new EditError(`the project kept changing while prepare ran (revision ${revision} -> ${tl.revision}); it did not finish`, "conflict", "run prepare again", undefined, { revision: tl.revision });
      throw new EditError("prepare made no progress", "internal", "this is an AgentCut bug; please report_feedback(kind='bug')");
    }
    const total = jobs.reduce((n, d) => n + d.frames, 0);
    let base = 0;
    for (const d of jobs) {
      const t0 = performance.now();
      const r = await computeOnce(d, (n) => o.progress?.(base + Math.min(n, d.frames), total), o.signal);
      base += d.frames;
      o.progress?.(base, total);
      computed.push({ kind: d.kind, source: d.job.path, file: d.file, cached: r.cached, seconds: +((performance.now() - t0) / 1000).toFixed(2) });
    }
  }
}

/** What prepare would do, without computing anything. */
export function prepareStatus(p: Project) {
  const tl = p.load(), { ops, jobs } = missingFor(p, tl);
  return { ready: !jobs.length && !ops.length, missing: jobs.map((d) => ({ kind: d.kind, source: d.job.path, frames: d.frames })), pending: ops.map((o) => `${o.op} ${o.id}`) };
}
