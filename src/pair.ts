// Which clip a transition plays from. A leaf module: model.ts, render.ts, inspect.ts, ops.ts and the page share it.
// On a magnetic track the clips play in list order, so the clip before in the list. On any other track the list order is the draw order (later on top)
// and says nothing about time: the clip a transition plays from is the one being drawn where the incoming clip starts.

export interface PairTrack<C> { magnetic?: boolean; clips: C[] }
export interface PairOps<C> { start: (c: C) => number; end: (c: C) => number; drawn: (c: C) => boolean }

const EPS = 1e-6;

/** The clip the transition into clips[i] plays from, or null when none does. Magnetic: the clip before in the list, whatever it is (a gap too: the
 *  storyline overlaps the two, and the renderer blends only drawn layers).
 *  Otherwise: of the drawn clips below it in the list (the draw order) that still play when clips[i] starts and started before it or with it, the one that
 *  started last (a tie: the later in the list, nearer it). A clip drawn above the incoming one is no partner: the transition fades the incoming clip in. */
export function playsFrom<C>(tr: PairTrack<C>, i: number, o: PairOps<C>): C | null {
  const c = tr.clips[i];
  if (!c || !o.drawn(c)) return null;
  if (tr.magnetic) return tr.clips[i - 1] ?? null;
  const s = o.start(c);
  let best: C | null = null, at = -1;
  tr.clips.forEach((x, j) => {
    // drawn below it (the renderer fades the incoming clip in over the outgoing one), started before it or with it, still playing when it starts
    if (j >= i || !o.drawn(x) || !(o.end(x) > s + EPS) || !(o.start(x) <= s + EPS)) return;
    if (!best || o.start(x) > o.start(best) + EPS || (Math.abs(o.start(x) - o.start(best)) <= EPS && j > at)) { best = x; at = j; }
  });
  return best;
}

/** The clip a new transition into clips[i] blends from. Magnetic: the clip before in the list. Otherwise: the one it plays from now, else of the drawn clips that
 *  started before it, the one
 *  that ends last at or before its end (the clip it cuts from: add_transition moves the incoming clip back over it by the transition's length, not before its
 *  start, and above it in the draw order). Null: nothing. */
export function blendsFrom<C>(tr: PairTrack<C>, i: number, o: PairOps<C>): C | null {
  const now = playsFrom(tr, i, o);
  if (tr.magnetic || now) return now; // a transition already playing keeps its partner
  const c = tr.clips[i];
  if (!c || !o.drawn(c)) return null;
  const s = o.start(c), e = o.end(c);
  let best: C | null = null;
  tr.clips.forEach((x, j) => {
    if (j === i || !o.drawn(x) || !(o.start(x) < s - EPS) || !(o.end(x) <= e + EPS)) return;
    if (!best || o.end(x) >= o.end(best)) best = x;
  });
  return best;
}

/** Where add_transition puts a free-track clip that blends from `from` with a transition of length d: d before that clip's end, not before its start. */
export const blendStart = <C>(from: C, d: number, o: PairOps<C>) => Math.max(o.start(from), o.end(from) - d);
