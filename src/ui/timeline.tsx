import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { ops } from "./api.ts";
import { drag, kfDrag } from "./drag.ts";
import { dropEdit } from "./edits.ts";
import { t } from "./i18n.ts";
import { select } from "./inspector.tsx";
import { kfTimes, near, pts } from "./keyframes.ts";
import { ASSET_DRAG } from "./media.tsx";
import { $, changed, LABEL, LANE, refreshView, S, st, total, V } from "./state.ts";
import { dur, num, start } from "./time.ts";
import type { Clip, Track } from "./types.ts";
import { clipOrder, resolveRef, tickStep } from "./view.ts";
import { seek } from "./viewer.tsx";

const COL: Record<string, string> = { video: "#3b6fb6", image: "#2f8f83", text: "#a35bb8", captions: "#b8865b", shape: "#7b8f2f", color: "#8f2f5a",
  lottie: "#2f5a8f", audio: "#2f8f4a", gap: "#444", compound: "#b85b5b" };

/** the node of the clip with this id in the shown timeline: ids are free text, so no CSS selector is built from one */
export const clipNode = (id: string): HTMLElement | undefined =>
  Array.prototype.find.call(document.querySelectorAll<HTMLElement>("#lanes .clip"), (n: HTMLElement) => n.dataset.id === id) as HTMLElement | undefined;

/** the clip that had the focus when this draw began (a lane change replaces its node) */
let kept: string | null = null;

/** one clip is in the tab order: the focused one, else the selected one, else the first in time order. Set on the nodes after each draw,
 *  not as a prop: the arrow keys move it between draws. */
function syncTabStop() {
  if (!st.S) return;
  const order = clipOrder(V()), stop = order.find((c) => c.id === (kept || st.sel)) || order[0];
  document.querySelectorAll<HTMLElement>("#lanes .clip").forEach((n) => { n.tabIndex = stop && n.dataset.id === stop.id ? 0 : -1; });
  if (kept && (document.activeElement as HTMLElement | null)?.dataset?.id !== kept) clipNode(kept)?.focus({ preventScroll: true }); // focus() would scroll the timeline back to the clip
}

export function openPath(p: string[]) {
  st.path = p; st.sel = null; st.picked = []; refreshView(); select(null);
}

function setZoom(pps: number) { st.pps = pps; changed(); }

function rulerDown(ev: MouseEvent) {
  const at = (e: MouseEvent) => { const b = $("ruler").getBoundingClientRect(); seek((e.clientX - b.left) / st.pps); };
  at(ev);
  const up = () => { document.removeEventListener("mousemove", at); document.removeEventListener("mouseup", up); };
  document.addEventListener("mousemove", at); document.addEventListener("mouseup", up);
}

function clipDown(ev: MouseEvent, tr: Track, c: Clip) {
  const target = ev.target as HTMLElement;
  if (ev.shiftKey) {
    ev.preventDefault();
    if (!st.picked.length && st.sel && st.sel !== c.id) st.picked.push(st.sel);
    const at = st.picked.indexOf(c.id);
    if (at >= 0) st.picked.splice(at, 1); else st.picked.push(c.id);
    select(st.sel); return;
  }
  if (target.dataset.t !== undefined) return kfDrag(ev, c, +target.dataset.t);
  if (ev.detail === 2 && c.type === "compound") { ev.preventDefault(); openPath(st.path.concat([c.id])); return; }
  if (V().nested) { select(c.id); return; }
  drag(ev, tr, c, (target.dataset.edge as "l" | "r" | undefined) || "move");
}

/** an asset from the media pool dropped on a lane: one add_clip there (the shown tracks only: an opened compound is read-only) */
function laneDrop(e: DragEvent, tr: Track) {
  const id = e.dataTransfer?.getData(ASSET_DRAG);
  if (!id || V().nested) return;
  e.preventDefault();
  const at = (e.clientX - (e.currentTarget as HTMLElement).querySelector(".lclips")!.getBoundingClientRect().left) / st.pps;
  ops([dropEdit(tr, id, at)], "add " + id + " to " + tr.id);
}
const laneOver = (e: DragEvent) => { if (!V().nested && e.dataTransfer && Array.prototype.includes.call(e.dataTransfer.types, ASSET_DRAG)) e.preventDefault(); };

function ClipBox({ tr, c, i }: { tr: Track; c: Clip; i: number }) {
  const v = V(), pps = st.pps, d = st.drag && st.drag.id === c.id ? st.drag : null, kd = st.kfDrag && st.kfDrag.id === c.id && !v.nested ? st.kfDrag : null;
  const x0 = v.off + v.k * start(c), w = v.k * dur(c);
  let left = x0 * pps, width = Math.max(4, w * pps);
  if (d && d.mode === "l") { left += d.dx; width = Math.max(4, w * pps - d.dx); }
  else if (d && d.mode === "r") width = Math.max(4, w * pps + d.dx);
  const off = c.enabled === false || x0 + w <= v.lo + 1e-6 || x0 >= v.hi - 1e-6; // disabled, or outside the opened compound's window
  const a = c.asset && S().timeline.assets[c.asset];
  const thumb = a && (a.kind === "video" || a.kind === "image") ? "url(/api/thumb/" + encodeURIComponent(c.asset) + "?t=" + num(c.in || 0).toFixed(2) + ")" : "";
  const label = c.text || c.name || (a ? (a.path || "").split("/").pop() : c.type);
  const trn = c.transition && i > 0 ? c.transition : null;
  return (
    <div class={"clip" + (c.id === st.sel ? " sel" : "") + (st.picked.includes(c.id) ? " pick" : "") + (off ? " off" : "")} data-id={c.id} role="button"
      aria-label={t("clipLabel", c.id, c.type, start(c).toFixed(2))} title={c.id + " " + c.type + "  " + start(c).toFixed(2) + "-" + (start(c) + dur(c)).toFixed(2) + "s"}
      style={{ left: left + "px", width: width + "px", backgroundColor: COL[c.type] || "#555", backgroundImage: thumb, transform: d && d.mode === "move" ? "translate(" + d.dx + "px,0px)" : "" }}
      onMouseDown={(ev) => clipDown(ev, tr, c)}>
      {c.id + " · " + String(label).slice(0, 60)}
      {trn && <div class="tr" style={{ width: v.k * (typeof trn === "object" ? num(trn.duration || 0.5) : 0.5) * pps + "px" }} title={t("transition", trn.type || trn)} />}
      {!v.nested && <div class="h l" data-edge="l" />}
      {!v.nested && <div class="h r" data-edge="r" />}
      {kfTimes(c).map((kt) => (
        <div key={kt} class="kf" data-t={String(kt)} style={{ left: v.k * kt * pps + (kd && near(kd.kt, kt) ? kd.dx : 0) + "px" }}
          title={t("keyframeAt", kt, Object.keys(c.keyframes).filter((p) => pts(c.keyframes[p]).some((q) => near(q[0], kt))).join(", "))} />
      ))}
    </div>
  );
}

function Crumbs() {
  const p = st.path;
  return (
    <span id="crumbs">
      {[t("timeline")].concat(p).map((name, i) => [
        i ? " › " : "",
        i === p.length ? <span class="cur">{name}</span> : <a onClick={() => openPath(p.slice(0, i))}>{name}</a>,
      ])}
      {p.length ? t("readOnly") : ""}
    </span>
  );
}

function Lanes({ W }: { W: number }) {
  const tl = S().timeline, v = V(), pps = st.pps;
  const rows = v.tracks.slice().reverse(); // tracks[0] is the bottom layer: draw it last (lowest lane)
  const laneOf: Record<string, number> = {};
  rows.forEach((tr, i) => { tr.clips.forEach((c) => { laneOf[c.id] = i; }); });
  const H = rows.length * LANE;
  return [
    <div id="ruler" style={{ width: W + "px" }} onMouseDown={rulerDown}>
      {Array.from({ length: Math.ceil(W / pps / tickStep(pps)) }, (_, n) => n * tickStep(pps)).map((x) => <div key={"t" + x} class="tick" style={{ left: x * pps + "px" }}>{x + "s"}</div>)}
      {(tl.markers || []).map((m, n) => <div key={"m" + n} class="marker" style={{ left: num(m.t) * pps + "px" }} title={m.t + "s " + (m.label || "")}>{m.label || ""}</div>)}
    </div>,
    <div id="lanes">
      {rows.map((tr) => (
        <div key={tr.id} class="lane" data-track={tr.id} onDragOver={laneOver} onDrop={(e) => laneDrop(e, tr)}>
          <div class="lname"><b>{tr.id}</b><br /><span class="mut">{[tr.kind || "video", tr.magnetic ? "magnetic" : "", tr.muted ? "muted" : "", tr.hidden ? "hidden" : ""].filter(Boolean).join(" ")}</span></div>
          <div class="lclips">{tr.clips.map((c, i) => <ClipBox key={c.id} tr={tr} c={c} i={i} />)}</div>
        </div>
      ))}
    </div>,
    <svg id="links" width={W} height={H}>
      {rows.flatMap((tr, i) => tr.clips.map((c) => {
        if (!c.attach_to) return null;
        const pid = resolveRef(v.tracks, c.attach_to);
        if (pid === null || laneOf[pid] === undefined) return null;
        const x = (v.off + v.k * start(c)) * pps, y1 = i * LANE + LANE / 2, y2 = laneOf[pid] * LANE + LANE / 2;
        return [<path key={c.id + "l"} d={"M" + x + " " + y1 + " L" + x + " " + y2} stroke="#fc3" stroke-dasharray="3 3" />, <circle key={c.id + "c"} cx={x} cy={y2} r="3" fill="#fc3" />];
      }))}
    </svg>,
    <div id="ph" style={{ left: LABEL + st.t * pps + "px", height: H + 20 + "px" }} />,
  ];
}

export function Timeline() {
  const scroll = useRef<HTMLDivElement>(null);
  const ae = document.activeElement as HTMLElement | null;
  kept = ae && ae.classList && ae.classList.contains("clip") ? ae.dataset.id ?? null : null;
  useLayoutEffect(syncTabStop);
  useEffect(() => {
    const sc = scroll.current!;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(Math.max(10, Math.min(400, st.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
    };
    sc.addEventListener("wheel", wheel, { passive: false });
    return () => sc.removeEventListener("wheel", wheel);
  }, []);
  const W = Math.max(total() + 5, 10) * st.pps;
  return (
    <div id="tl">
      <div id="tbar">
        <span class="mut">{t("zoom")}</span>
        <input type="range" id="zoom" min="10" max="400" value={String(st.pps)} onInput={(e) => setZoom(+e.currentTarget.value)} />
        <span class="mut" id="dur">{st.S ? total().toFixed(2) + " s" : ""}</span>
        <Crumbs />
        <span class="mut">{t("tlHint")}</span>
      </div>
      <div id="scroll" ref={scroll}>
        <div id="inner" style={{ width: st.S ? W + LABEL + "px" : "" }}>
          {st.S ? <Lanes W={W} /> : [<div id="ruler" />, <div id="lanes" />, <svg id="links" />, <div id="ph" />]}
        </div>
      </div>
    </div>
  );
}
