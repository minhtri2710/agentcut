import { ops } from "./api.ts";
import { dragEdit, kfMoveBatch, type DragMode } from "./edits.ts";
import { select } from "./inspector.ts";
import { st, V } from "./state.ts";
import { clipNodes, drawTimeline } from "./timeline.ts";
import { dur, start } from "./time.ts";
import type { Clip, Track } from "./types.ts";
import { seek } from "./viewer.ts";

/** drag a clip: move (other lane = other track; magnetic = new index) or trim an edge; one op on release */
export function drag(ev: MouseEvent, tr: Track, c: Clip, mode: DragMode) {
  ev.preventDefault(); select(c.id);
  const el = clipNodes.get(c.id)!, x0 = ev.clientX, s0 = start(c), d0 = dur(c);
  let moved = false;
  const mm = (e: MouseEvent) => {
    const dt = (e.clientX - x0) / st.pps, pps = st.pps;
    if (Math.abs(e.clientX - x0) > 3) moved = true;
    if (mode === "move") el.style.transform = "translate(" + (e.clientX - x0) + "px,0px)";
    else if (mode === "l") { el.style.left = (s0 + dt) * pps + "px"; el.style.width = Math.max(4, (d0 - dt) * pps) + "px"; }
    else el.style.width = Math.max(4, (d0 + dt) * pps) + "px";
  };
  const mu = (e: MouseEvent) => {
    document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu);
    if (!moved) { drawTimeline(); return; }
    const dt = +((e.clientX - x0) / st.pps).toFixed(3);
    const lane = document.elementsFromPoint(e.clientX, e.clientY).filter((n) => n.classList && n.classList.contains("lane"))[0] as HTMLElement | undefined;
    const edit = dragEdit(mode, c, tr, V().tracks, lane ? lane.dataset.track! : tr.id, dt, s0, d0);
    ops(edit.ops, edit.label).then((r) => { if (!r) drawTimeline(); });
  };
  document.addEventListener("mousemove", mm); document.addEventListener("mouseup", mu);
}

/** drag a keyframe tick: moves every prop's point at that time; one batch of set_keyframes on release */
export function kfDrag(ev: MouseEvent, c: Clip, kt: number) {
  ev.preventDefault(); ev.stopPropagation(); select(c.id);
  const k = ev.target as HTMLElement, x0 = ev.clientX;
  let moved = false;
  const mm = (e: MouseEvent) => { if (Math.abs(e.clientX - x0) > 2) moved = true; if (!V().nested) k.style.left = (kt * st.pps + e.clientX - x0) + "px"; };
  const mu = (e: MouseEvent) => {
    document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu);
    const v = V();
    if (!moved || v.nested) { seek(v.off + v.k * (start(c) + kt)); return; }
    ops(kfMoveBatch(c, kt, (e.clientX - x0) / st.pps), "move keyframe " + c.id).then((r) => { if (!r) drawTimeline(); });
  };
  document.addEventListener("mousemove", mm); document.addEventListener("mouseup", mu);
}
