// Worker process entry: renders one segment described by a job JSON file. Progress lines "P <n>" on stdout.
import { readFileSync } from "node:fs";
import { encodeFrames, type SegmentJob } from "./encode.ts";
import { registerFontDir } from "./fonts.ts";
import { Renderer } from "./render.ts";

export async function runSegment(jobFile: string) {
  const job: SegmentJob = JSON.parse(readFileSync(jobFile, "utf8"));
  for (const d of job.fontDirs) registerFontDir(d);
  const r = new Renderer(job.tl, job.root, job.scale);
  let last = 0;
  await encodeFrames(r, job.t0, job.i0, job.i1, job.v, job.out, undefined, (d) => {
    const now = performance.now();
    if (now - last > 250 || d === job.i1 - job.i0) { last = now; process.stdout.write(`P ${d}\n`); }
  });
}

const isMain = process.argv[1] && /segment-worker\.(ts|js)$/.test(process.argv[1]);
if (isMain) runSegment(process.argv[2]).catch((e) => { process.stderr.write(String(e?.stack || e)); process.exit(1); });
