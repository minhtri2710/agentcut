import { dur, num, start } from "./time.ts";
import type { Clip, Track } from "./types.ts";

export type Found = { c: Clip; tr: Track };
/** the tracks shown, and where a nested time u plays on the timeline: off + k * u. [lo, hi] is the timeline range every opened compound shows. */
export type View = { tracks: Track[]; off: number; k: number; lo: number; hi: number; nested: boolean };

/** the last clip with this id in the tracks (not inside compounds) */
export function findIn(tracks: Track[], id: string): Found | null {
  let r: Found | null = null;
  for (const tr of tracks) for (const c of tr.clips) if (c.id === id) r = { c, tr };
  return r;
}

/** The tracks shown: the timeline, or the nested tracks of the opened compound (path) drawn where render plays them.
 *  A nested time u plays at timeline time off + k * u (render.ts subT: u = in + local * speed, composed per opened level);
 *  [lo, hi] is the timeline range every opened compound shows (its [in, in + duration * speed] window).
 *  A path that no longer leads to compounds is cut at the first level that does not; the cut path is returned. */
export function viewOf(top: Track[], path: string[]): { view: View; path: string[] } {
  let tracks = top, off = 0, k = 1, lo = -Infinity, hi = Infinity;
  for (let i = 0; i < path.length; i++) {
    const f = findIn(tracks, path[i]);
    if (!f || f.c.type !== "compound") { path = path.slice(0, i); break; }
    const v = Number(f.c.speed || 1) || 1;
    lo = Math.max(lo, off + k * start(f.c)); hi = Math.min(hi, off + k * (start(f.c) + dur(f.c)));
    off += k * (start(f.c) - num(f.c.in || 0) / v); k /= v; tracks = f.c.tracks || [];
  }
  return { view: { tracks, off, k, lo, hi, nested: path.length > 0 }, path };
}

/** The lanes top to bottom, as CapCut and Final Cut lay them out: the picture tracks above, the top layer first (tracks[0] is drawn first, so it is the lowest
 *  picture lane: the main storyline), then the audio tracks below in track order. */
export function laneRows(tracks: Track[]): Track[] {
  return tracks.filter((t) => t.kind !== "audio").reverse().concat(tracks.filter((t) => t.kind === "audio"));
}

/** every clip of the shown tracks in time order (ties: lane order), the order Left and Right walk */
export function clipOrder(v: View): Clip[] {
  const r: Clip[] = [];
  laneRows(v.tracks).forEach((tr) => tr.clips.forEach((c) => r.push(c)));
  return r.map((c, i) => [v.off + v.k * start(c), i, c] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}

/** the clip id an attach_to reference names: an id, or "track#index" (negative counts from the end); null when it points at nothing */
export function resolveRef(tracks: Track[], ref: string): string | null {
  const m = /^(.+)#(-?\d+)$/.exec(ref);
  if (!m) return ref;
  const tr = tracks.filter((x) => x.id === m[1])[0];
  if (!tr) return null;
  let i = +m[2];
  if (i < 0) i += tr.clips.length;
  const c = tr.clips[i];
  return c ? c.id : null;
}

/** seconds between ruler ticks at this zoom */
export const tickStep = (pps: number): number => (pps > 150 ? 0.5 : pps > 50 ? 1 : pps > 20 ? 5 : pps > 5 ? 10 : pps > 1.5 ? 30 : 60);

/** a time as CapCut shows it: mm:ss:ff (frames at the project's rate) */
export const clock = (s: number, fps: number) => { // 29.97 fps counts 30 frames to a second, as NDF timecode does
  const n = Math.round(fps), f = Math.round(s * fps), ff = f % n, ss = Math.floor(f / n) % 60, mm = Math.floor(f / n / 60);
  return [mm, ss, ff].map((x) => String(x).padStart(2, "0")).join(":");
};
