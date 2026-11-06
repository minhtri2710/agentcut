// Video scopes of a rendered frame: waveform + vectorscope + histogram image and signalstats numbers (one FFmpeg run).
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { inp } from "./ffinput.ts";
import { needFfmpeg } from "./media.ts";
import { EditError } from "./model.ts";
import { commit, tmpSibling } from "./safe-write.ts";

const [PW, PH] = [480, 270];
const GRAPH = [
  "[0]split=4[a][y][d][s0]", // waveform/vectorscope read broadcast YUV (graticule 16-235); histogram reads RGB
  "[y]format=yuv444p,split=2[b][c]",
  "[s0]scale=out_range=full,format=yuv444p[e]", // stats in full range: white = 255 (limited range caps it at 235 = 0.92)
  `[a]scale=${PW}:${PH}:force_original_aspect_ratio=decrease,pad=${PW}:${PH}:-1:-1[f]`,
  `[b]waveform=components=1:intensity=0.1:graticule=green:flags=numbers+dots:scale=digital,scale=${PW}:${PH}[w]`,
  `[c]vectorscope=mode=color3:graticule=green:flags=name,scale=${PH}:${PH},pad=${PW}:${PH}:-1:-1[v]`,
  `[d]format=gbrp,histogram=display_mode=stack:level_height=60,scale=${PW}:${PH}[h]`,
  "[f][w]hstack[top]", "[v][h]hstack[bot]", "[top][bot]vstack,format=rgb24[out]",
  "[e]signalstats,metadata=mode=print:file=-[s]",
].join(";");

/**
 * 2x2 sheet of an encoded still (PNG/JPEG): frame | luma waveform / vectorscope | RGB histogram.
 * stats: luma 0..1 (min, 10th pct, avg, 90th pct, max), average saturation, chroma cast (+u = blue, +v = red; 0 = neutral).
 * The image is written under a new name and renamed to outPath; `base` is the project folder when outPath is inside it.
 */
export function scopes(still: Buffer, outPath: string, base?: string) {
  needFfmpeg();
  const tmp = tmpSibling(outPath, base);
  let r;
  try {
    r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "image2pipe", ...inp("pipe:0"), "-filter_complex", GRAPH,
      "-map", "[out]", "-frames:v", "1", tmp, "-map", "[s]", "-f", "null", "-"], { input: still, encoding: "utf8", maxBuffer: 1 << 24 });
    if (r.status === 0) commit(tmp, outPath);
  } finally { rmSync(tmp, { force: true }); }
  if (r.status !== 0) throw new EditError(`scopes failed: ${String(r.stderr || r.error).slice(0, 300)}`, "scopes_failed");
  const m: Record<string, number> = {};
  for (const [, k, v] of (r.stdout || "").matchAll(/lavfi\.signalstats\.(\w+)=([-\d.]+)/g)) m[k] = +v;
  // the graph is 8-bit yuv444p (signalstats YBITDEPTH is the frame's *effective* depth, not the format's)
  const mid = 128, n = (v: number | undefined) => +((v ?? 0) / 255).toFixed(3);
  return {
    image: outPath,
    stats: {
      luma: { min: n(m.YMIN), p10: n(m.YLOW), avg: n(m.YAVG), p90: n(m.YHIGH), max: n(m.YMAX) },
      saturation_avg: n(m.SATAVG),
      cast: { u: n((m.UAVG ?? mid) - mid), v: n((m.VAVG ?? mid) - mid) },
    },
  };
}
