import type { Clip, State, Track } from "./types.ts";
import { findIn, viewOf, type View } from "./view.ts";

export const LABEL = 90, LANE = 44; // px: the lane label column, one lane's height

/** The page's state, in one place: what the server last sent (S) and what only this page knows. */
export const st = {
  S: null as State | null,
  V: null as View | null, // the tracks shown: the timeline, or an opened compound
  path: [] as string[], // the opened compounds, outermost first
  sel: null as string | null,
  picked: [] as string[], // shift-click multi-selection
  inspBase: "", // the text the inspector box was filled with
  kfProp: "opacity",
  t: 0, // playhead, seconds
  pps: 80, // pixels per second
  prepJob: null as string | null,
  playJob: null as string | null,
  renderJob: null as string | null,
};

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, kids: Node[] = []): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => e.appendChild(k));
  return e;
}

export const S = (): State => st.S!;
export const V = (): View => st.V!;
export const total = (): number => (st.S ? st.S.duration : 0);
export const findClip = (id: string): Clip | null => findIn(V().tracks, id)?.c ?? null;
export const trackOf = (id: string): Track | null => findIn(V().tracks, id)?.tr ?? null;
/** the view of the shown tracks after the state or the opened path changed; a path that leads nowhere is cut */
export function refreshView() {
  const r = viewOf(S().timeline.tracks, st.path);
  st.path = r.path; st.V = r.view;
}
