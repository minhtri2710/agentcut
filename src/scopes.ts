// Video scopes of a rendered frame: waveform + vectorscope + histogram image and signalstats numbers (one FFmpeg run).
import { spawnSync } from "node:child_process";
import { needFfmpeg } from "./media.ts";
import { EditError } from "./model.ts";

const [PW, PH] = [480, 270];
const GRAPH = [
  "[0]split=3[a][y][d]", "[y]format=yuv444p,split=3[b][c][e]", // waveform/vectorscope/stats read YUV; histogram reads RGB
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
 */
export function scopes(still: Buffer, outPath: string) {
  needFfmpeg();
  const r = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-f", "image2pipe", "-i", "-", "-filter_complex", GRAPH,
    "-map", "[out]", "-frames:v", "1", outPath, "-map", "[s]", "-f", "null", "-"], { input: still, encoding: "utf8", maxBuffer: 1 << 24 });
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
