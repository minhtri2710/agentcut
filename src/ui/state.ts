import type { DragMode } from "./edits.ts";
import type { ApiError, Clip, Job, State, Track } from "./types.ts";
import { findIn, viewOf, type View } from "./view.ts";

export const LABEL = 90, LANE = 44; // px: the lane label column, one lane's height

/** what the box under the batch shows: a render's progress, its result, a contact sheet */
export type Out = { progress?: number; link?: { url: string; name: string; info: string }; sheet?: string };

/** The page's state, in one place: what the server last sent (S) and what only this page knows. Components read it; a change calls changed(). */
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
  prep: null as Job | "starting" | null, // the Prepare button's job while it runs
  needPrepare: false, // the viewer answered not_prepared: offer Prepare
  play: null as { pct: number | null } | null, // a play draft being made (pct null: not started yet)
  playing: false, // the play draft is shown in <video>
  rendering: false,
  sheeting: false,
  out: null as Out | null,
  consent: null as ApiError | null, // the model download the dialog asks about
  drag: null as { id: string; mode: DragMode; dx: number } | null, // a clip being dragged, dx in px
  kfDrag: null as { id: string; kt: number; dx: number } | null, // a keyframe tick being dragged
};

let redraw = () => {};
/** the page's root registers its redraw here */
export const onChange = (f: () => void) => { redraw = f; };
/** st changed: draw the page again */
export const changed = () => redraw();

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

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
