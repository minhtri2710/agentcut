// Worker process entry: renders one segment described by a job JSON file. Progress lines "P <n>" on stdout.
import { readFileSync } from "node:fs";
import { encodeFrames, type SegmentJob } from "./encode.ts";
import { registerFontDir } from "./fonts.ts";
import { EditError } from "./model.ts";
import { Renderer } from "./render.ts";

export async function runSegment(jobFile: string) {
  // the parent stops a worker with SIGTERM: end the frame loop so the encoder is stopped and awaited before this process exits
  const stop = new AbortController();
  process.on("SIGTERM", () => stop.abort(new EditError("render worker stopped", "aborted")));
  const job: SegmentJob = JSON.parse(readFileSync(jobFile, "utf8"));
  for (const d of job.fontDirs) registerFontDir(d);
  const r = new Renderer(job.tl, job.root, job.scale);
  let last = 0;
  await encodeFrames(r, job.t0, job.i0, job.i1, job.v, job.out, undefined, (d) => {
    const now = performance.now();
    if (now - last > 250 || d === job.i1 - job.i0) { last = now; process.stdout.write(`P ${d}\n`); }
  }, stop.signal);
}

/** The worker entry for every launch (this file under node/bun, and the compiled binary's `__segment`): an EditError reaches the parent as one "E <json>" line so its code, message and hint survive; anything else is a stack on stderr. */
export const runSegmentMain = (jobFile: string) => runSegment(jobFile).catch((e) => {
  if (e instanceof EditError) process.stdout.write(`E ${JSON.stringify({ message: e.message, code: e.code, hint: e.hint, path: e.path })}\n`, () => process.exit(1));
  else { process.stderr.write(String(e?.stack || e)); process.exit(1); }
});

const isMain = process.argv[1] && /segment-worker\.(ts|js)$/.test(process.argv[1]);
if (isMain) runSegmentMain(process.argv[2]);
