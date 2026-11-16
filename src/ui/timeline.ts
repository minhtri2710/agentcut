import { drag, kfDrag } from "./drag.ts";
import { drawRegroup, select } from "./inspector.ts";
import { kfTimes, near, pts } from "./keyframes.ts";
import { $, LABEL, LANE, refreshView, S, st, total, V } from "./state.ts";
import { dur, num, start } from "./time.ts";
import type { Clip, Track } from "./types.ts";
import { clipOrder, resolveRef, tickStep } from "./view.ts";
import { seek } from "./viewer.ts";

const COL: Record<string, string> = { video: "#3b6fb6", image: "#2f8f83", text: "#a35bb8", captions: "#b8865b", shape: "#7b8f2f", color: "#8f2f5a",
  lottie: "#2f5a8f", audio: "#2f8f4a", gap: "#444", compound: "#b85b5b" };

/** clip id -> its node in the shown timeline: ids are free text, so no CSS selector is built from one */
export let clipNodes = new Map<string, HTMLElement>();

export function drawTimeline() {
  if (!st.S) return; // the zoom before the first state: nothing to draw yet, the first state draws at the scale set
  const tl = S().timeline, v = V(), pps = st.pps, W = Math.max(total() + 5, 10) * pps, lanes = $("lanes");
  clipNodes = new Map();
  const ae = document.activeElement as HTMLElement | null, keep = ae && ae.classList && ae.classList.contains("clip") ? ae.dataset.id : null; // the rebuild below drops the focused clip
  $("inner").style.width = (W + LABEL) + "px";
  const r = $("ruler");
  r.innerHTML = ""; r.style.width = W + "px";
  const step = tickStep(pps);
  for (let x = 0; x * pps < W; x += step) { const d = document.createElement("div"); d.className = "tick"; d.style.left = x * pps + "px"; d.textContent = x + "s"; r.appendChild(d); }
  (tl.markers || []).forEach((m) => { const d = document.createElement("div"); d.className = "marker"; d.style.left = num(m.t) * pps + "px"; d.textContent = m.label || ""; d.title = m.t + "s " + (m.label || ""); r.appendChild(d); });
  lanes.innerHTML = ""; drawCrumbs();
  const rows = v.tracks.slice().reverse(); // tracks[0] is the bottom layer: draw it last (lowest lane)
  rows.forEach((tr) => {
    const lane = document.createElement("div"); lane.className = "lane"; lane.dataset.track = tr.id;
    const nm = document.createElement("div"); nm.className = "lname";
    nm.innerHTML = "<b></b><br><span class=mut></span>"; nm.firstChild!.textContent = tr.id;
    nm.lastChild!.textContent = [tr.kind || "video", tr.magnetic ? "magnetic" : "", tr.muted ? "muted" : "", tr.hidden ? "hidden" : ""].filter(Boolean).join(" ");
    const cl = document.createElement("div"); cl.className = "lclips";
    tr.clips.forEach((c, i) => { cl.appendChild(clipEl(tr, c, i)); });
    lane.appendChild(nm); lane.appendChild(cl); lanes.appendChild(lane);
  });
  const H = rows.length * LANE, svg = $("links");
  svg.setAttribute("width", String(W)); svg.setAttribute("height", String(H)); svg.innerHTML = "";
  const laneOf: Record<string, number> = {};
  rows.forEach((tr, i) => { tr.clips.forEach((c) => { laneOf[c.id] = i; }); });
  rows.forEach((tr, i) => { tr.clips.forEach((c) => {
    if (!c.attach_to) return;
    const pid = resolveRef(v.tracks, c.attach_to); if (pid === null || laneOf[pid] === undefined) return;
    const x = (v.off + v.k * start(c)) * pps, y1 = i * LANE + LANE / 2, y2 = laneOf[pid] * LANE + LANE / 2;
    const ln = document.createElementNS("http://www.w3.org/2000/svg", "path");
    ln.setAttribute("d", "M" + x + " " + y1 + " L" + x + " " + y2); ln.setAttribute("stroke", "#fc3"); ln.setAttribute("stroke-dasharray", "3 3");
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(x)); dot.setAttribute("cy", String(y2)); dot.setAttribute("r", "3"); dot.setAttribute("fill", "#fc3");
    svg.appendChild(ln); svg.appendChild(dot);
  }); });
  $("ph").style.height = (H + 20) + "px"; movePlayhead(); drawRegroup();
  const order = clipOrder(v), stop = order.filter((c) => c.id === (keep || st.sel))[0] || order[0]; // one clip is in the tab order
  if (stop) { const n = clipNodes.get(stop.id)!; n.tabIndex = 0; if (keep) n.focus({ preventScroll: true }); } // focus() would scroll the timeline back to the clip
}

export function openPath(p: string[]) {
  st.path = p; st.sel = null; st.picked = []; refreshView(); select(null); drawTimeline();
}

function drawCrumbs() {
  const b = $("crumbs");
  b.innerHTML = "";
  ["timeline"].concat(st.path).forEach((name, i) => {
    if (i) b.appendChild(document.createTextNode(" › "));
    const a = document.createElement(i === st.path.length ? "span" : "a"); a.textContent = name;
    if (i === st.path.length) a.className = "cur"; else a.onclick = () => { openPath(st.path.slice(0, i)); };
    b.appendChild(a);
  });
  if (st.path.length) b.appendChild(document.createTextNode(" (read-only: expand to edit) "));
}

function clipEl(tr: Track, c: Clip, i: number): HTMLElement {
  const v = V(), pps = st.pps;
  const e = document.createElement("div"); e.className = "clip" + (c.id === st.sel ? " sel" : "") + (st.picked.indexOf(c.id) >= 0 ? " pick" : "");
  clipNodes.set(c.id, e); e.dataset.id = c.id; e.tabIndex = -1; e.setAttribute("role", "button");
  e.setAttribute("aria-label", c.id + ", " + c.type + ", starts at " + start(c).toFixed(2) + " s");
  const x0 = v.off + v.k * start(c), x1 = x0 + v.k * dur(c);
  if (c.enabled === false || x1 <= v.lo + 1e-6 || x0 >= v.hi - 1e-6) e.classList.add("off"); // disabled, or outside the opened compound's window
  e.style.left = x0 * pps + "px"; e.style.width = Math.max(4, v.k * dur(c) * pps) + "px";
  e.style.backgroundColor = COL[c.type] || "#555";
  const a = c.asset && S().timeline.assets[c.asset];
  if (a && (a.kind === "video" || a.kind === "image")) e.style.backgroundImage = "url(/api/thumb/" + encodeURIComponent(c.asset) + "?t=" + num(c.in || 0).toFixed(2) + ")";
  const label = c.text || c.name || (a ? (a.path || "").split("/").pop() : c.type);
  e.textContent = c.id + " · " + String(label).slice(0, 60);
  e.title = c.id + " " + c.type + "  " + start(c).toFixed(2) + "-" + (start(c) + dur(c)).toFixed(2) + "s";
  const trn = c.transition && i > 0 ? c.transition : null;
  if (trn) {
    const td = typeof trn === "object" ? num(trn.duration || 0.5) : 0.5, o = document.createElement("div"); o.className = "tr";
    o.style.width = v.k * td * pps + "px"; o.title = "transition " + (trn.type || trn); e.appendChild(o);
  }
  if (!v.nested) (["l", "r"] as const).forEach((s) => { const h = document.createElement("div"); h.className = "h " + s; h.dataset.edge = s; e.appendChild(h); });
  kfTimes(c).forEach((kt) => {
    const k = document.createElement("div"); k.className = "kf"; k.style.left = v.k * kt * pps + "px"; k.dataset.t = String(kt);
    k.title = "keyframe " + kt + "s: " + Object.keys(c.keyframes).filter((p) => pts(c.keyframes[p]).some((q) => near(q[0], kt))).join(", ");
    e.appendChild(k);
  });
  e.addEventListener("mousedown", (ev) => {
    const target = ev.target as HTMLElement;
    if (ev.shiftKey) {
      ev.preventDefault();
      if (!st.picked.length && st.sel && st.sel !== c.id) st.picked.push(st.sel);
      const at = st.picked.indexOf(c.id);
      if (at >= 0) st.picked.splice(at, 1); else st.picked.push(c.id);
      select(st.sel); return;
    }
    if (target.dataset.t !== undefined) return kfDrag(ev, c, +target.dataset.t);
    if (ev.detail === 2 && c.type === "compound") { ev.preventDefault(); openPath(st.path.concat([c.id])); return; } // the first click redraws, so no dblclick
    if (V().nested) { select(c.id); return; }
    drag(ev, tr, c, (target.dataset.edge as "l" | "r" | undefined) || "move");
  });
  return e;
}

export function movePlayhead() { $("ph").style.left = (LABEL + st.t * st.pps) + "px"; $("time").textContent = st.t.toFixed(2) + " s"; }

export function initTimeline() {
  $("ruler").addEventListener("mousedown", (ev) => {
    const at = (e: MouseEvent) => { const b = $("ruler").getBoundingClientRect(); seek((e.clientX - b.left) / st.pps); };
    at(ev);
    const up = () => { document.removeEventListener("mousemove", at); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", at); document.addEventListener("mouseup", up);
  });
  const zoom = $<HTMLInputElement>("zoom");
  zoom.addEventListener("input", () => { st.pps = +zoom.value; drawTimeline(); });
  $("scroll").addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    st.pps = Math.max(10, Math.min(400, st.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); zoom.value = String(st.pps); drawTimeline();
  }, { passive: false });
}
