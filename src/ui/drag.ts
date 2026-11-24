import { ops } from "./api.ts";
import { dragEdit, kfMoveBatch, type DragMode } from "./edits.ts";
import { select } from "./inspector.tsx";
import { changed, st, V } from "./state.ts";
import { dur, start } from "./time.ts";
import type { Clip, Track } from "./types.ts";
import { seek } from "./viewer.tsx";

/** drag a clip: move (other lane = other track; magnetic = new index) or trim an edge; one op on release. The clip is drawn from st.drag meanwhile. */
export function drag(ev: MouseEvent, tr: Track, c: Clip, mode: DragMode) {
  ev.preventDefault(); select(c.id);
  const x0 = ev.clientX, s0 = start(c), d0 = dur(c);
  let moved = false;
  const mm = (e: MouseEvent) => {
    if (Math.abs(e.clientX - x0) > 3) moved = true;
    st.drag = { id: c.id, mode, dx: e.clientX - x0 }; changed();
  };
  const mu = (e: MouseEvent) => {
    document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu);
    const done = () => { st.drag = null; changed(); };
    if (!moved) return done();
    const dt = +((e.clientX - x0) / st.pps).toFixed(3);
    const lane = document.elementsFromPoint(e.clientX, e.clientY).filter((n) => n.classList && n.classList.contains("lane"))[0] as HTMLElement | undefined;
    const edit = dragEdit(mode, c, tr, V().tracks, lane ? lane.dataset.track! : tr.id, dt, s0, d0);
    ops(edit.ops, edit.label).then(done);
  };
  document.addEventListener("mousemove", mm); document.addEventListener("mouseup", mu);
}

/** drag a keyframe tick: moves every prop's point at that time; one batch of set_keyframes on release */
export function kfDrag(ev: MouseEvent, c: Clip, kt: number) {
  ev.preventDefault(); ev.stopPropagation(); select(c.id);
  const x0 = ev.clientX;
  let moved = false;
  const mm = (e: MouseEvent) => { if (Math.abs(e.clientX - x0) > 2) moved = true; st.kfDrag = { id: c.id, kt, dx: e.clientX - x0 }; changed(); };
  const mu = (e: MouseEvent) => {
    document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu);
    const v = V(), done = () => { st.kfDrag = null; changed(); };
    if (!moved || v.nested) { done(); seek(v.off + v.k * (start(c) + kt)); return; }
    ops(kfMoveBatch(c, kt, (e.clientX - x0) / st.pps), "move keyframe " + c.id).then(done);
  };
  document.addEventListener("mousemove", mm); document.addEventListener("mouseup", mu);
}
