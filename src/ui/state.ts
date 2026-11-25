import type { DragMode } from "./edits.ts";
import type { ApiError, Clip, Dict, Job, State, Track } from "./types.ts";
import { findIn, viewOf, type View } from "./view.ts";

export const LABEL = 90, LANE = 44; // px: the lane label column, one lane's height

/** what the box under the batch shows: a render's progress, its result (with the file's URL), a contact sheet */
export type Out = { progress?: number; result?: Dict; url?: string; sheet?: string };

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
  exporting: false, // the export dialog is open
  template: null as string | null, // the template whose dialog is open
  sheeting: false,
  out: null as Out | null,
  consent: null as ApiError | null, // the model download the dialog asks about
  drag: null as { id: string; mode: DragMode; dx: number } | null, // a clip being dragged, dx in px
  kfDrag: null as { id: string; kt: number; dx: number } | null, // a keyframe tick being dragged
  tab: "media", // the left panel's tab
  inspTab: "form" as "form" | "json", // the inspector shows the form or the clip's JSON
  review: null as { busy: boolean; result?: Dict } | null, // the review panel's last run
  mediaQuery: "",
  uploading: null as string | null, // the dropped file being sent to media/
  tx: {} as Record<string, { busy?: boolean; words?: { text: string; start: number; end: number }[] }>, // transcripts by asset id and file path
  chat: { log: [] as Dict[], busy: false, engine: null as Dict | null }, // the chat panel: the events of this page's view of the conversation, an agent run going on, what CLI drives it
  txSel: null as { id: string; a: number; b: number } | null, // the transcript words picked in clip id: anchor and end
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
