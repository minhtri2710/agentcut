import { useEffect, useLayoutEffect, useRef } from "react";
import { Slider } from "@astryxdesign/core/Slider";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Copy, Eye, EyeOff, Film, Lock, LockOpen, Magnet, Music, Scissors, Snowflake, Trash2, Type as TypeIcon, Volume2, VolumeX, ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { ico } from "./kit.tsx";
import { ops } from "./api.ts";
import { drag, kfDrag } from "./drag.ts";
import { dropEdit } from "./edits.ts";
import { t } from "./i18n.ts";
import { select } from "./inspector.tsx";
import { kfTimes, near, pts } from "./keyframes.ts";
import { applyLib, LIB_DRAG } from "./library.tsx";
import { ASSET_DRAG } from "./media.tsx";
import { $, changed, findClip, LABEL, LANE, MAIN_LANE, refreshView, S, st, total, V } from "./state.ts";
import { dur, num, start } from "./time.ts";
import type { Clip, Track } from "./types.ts";
import { clipOrder, edgeZone, laneRows, PAIR, resolveRef, tickStep } from "./view.ts";
import { playsFrom } from "../pair.ts";
import { seek } from "./viewer.tsx";

/** a clip's colour by type: the theme's hue palette (background, border), so the lanes read like the rest of the page */
const HUE: Record<string, string> = { video: "blue", image: "teal", text: "purple", captions: "orange", shape: "yellow", color: "pink", lottie: "cyan", audio: "green", gap: "gray", compound: "red" };

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

/** the zoom's range in px per second: the low end fits a 20 minute timeline in about 1,200 px */
const ZMIN = 1, ZMAX = 400;
const clampZoom = (pps: number) => Math.max(ZMIN, Math.min(ZMAX, pps));
function setZoom(pps: number) { st.pps = pps; changed(); }
/** the whole timeline fills the visible lanes, from its start */
function fitZoom() { const sc = $("scroll"); if (st.S && total() > 0) { setZoom(clampZoom((sc.clientWidth - LABEL - 24) / total())); sc.scrollLeft = 0; } }

/** CapCut's edit tools over the timeline, on the selected clip at the playhead: split, delete, duplicate, freeze */
function Tools() {
  const c = st.S && st.sel && !V().nested ? findClip(st.sel) : null, v = st.S ? V() : null;
  const at = +st.t.toFixed(3), a0 = c && v ? v.off + v.k * start(c) : 0, a1 = c && v ? v.off + v.k * (start(c) + dur(c)) : 0;
  const inside = !!c && at > a0 + 1e-3 && at < a1 - 1e-3, on = !!c && at >= a0 - 1e-3 && at <= a1 + 1e-3; // a freeze also takes the first or last frame
  const tool = (id: string, label: string, icon: Parameters<typeof ico>[0], ok: boolean, run: () => void) =>
    <IconButton id={id} size="sm" variant="ghost" label={label} tooltip={label} icon={ico(icon)} isDisabled={!ok} onClick={run} />;
  return (
    <span className="row" id="tools">
      {tool("tsplit", t("toolSplit"), Scissors, inside, () => ops([{ op: "split_clip", id: c!.id, at }], "split " + c!.id))}
      {tool("tdel", t("deleteClip"), Trash2, !!c, () => ops([{ op: "remove_clip", id: c!.id }], "remove " + c!.id))}
      {tool("tdup", t("toolDuplicate"), Copy, !!c, () => ops([{ op: "duplicate_clip", id: c!.id }], "duplicate " + c!.id))}
      {tool("tfreeze", t("toolFreeze"), Snowflake, on && c!.type === "video", () => ops([{ op: "freeze_frame", id: c!.id, at }], "freeze " + c!.id))}
    </span>
  );
}

function rulerDown(ev: MouseEvent) {
  const at = (e: MouseEvent) => { const b = $("ruler").getBoundingClientRect(); seek((e.clientX - b.left) / st.pps); };
  at(ev);
  const up = () => { document.removeEventListener("mousemove", at); document.removeEventListener("mouseup", up); };
  document.addEventListener("mousemove", at); document.addEventListener("mouseup", up);
}

/** the zone under a press: the trim zones are the painted handles (inside the border) plus the border itself */
const edgeAt = (ev: MouseEvent, box: HTMLElement) => {
  // the zones are the handles as drawn: ClipBox sizes them from the width it sets, which padding and borders can make the box wider than
  const r = box.getBoundingClientRect();
  return edgeZone(ev.clientX, r.left, r.width, box.clientLeft, parseFloat(box.style.width) || r.width);
};

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
  drag(ev, tr, c, edgeAt(ev, target.closest<HTMLElement>(".clip")!));
}

/** an asset from the media pool dropped on a lane: one add_clip there (the shown tracks only: an opened compound is read-only) */
/** what was dropped on a lane: a media pool asset is a new clip there; a library item goes on the clip under the pointer, or a text preset is a new title there */
function laneDrop(e: DragEvent, lane: HTMLElement, tr: Track) {
  const dt = e.dataTransfer, id = dt?.getData(ASSET_DRAG), lib = dt?.getData(LIB_DRAG);
  if ((!id && !lib) || V().nested) return;
  e.preventDefault();
  const at = (e.clientX - lane.querySelector(".lclips")!.getBoundingClientRect().left) / st.pps;
  if (id) return ops([dropEdit(tr, { asset: id }, at)], "add " + id + " to " + tr.id);
  const [kind, name] = lib!.split("/"), on = (e.target as HTMLElement).closest<HTMLElement>(".clip");
  if (!on && kind === "text") return ops([dropEdit(tr, { text: t("libTitle"), duration: 3, preset: name }, at)], "add " + name + " title to " + tr.id);
  applyLib(kind, name, on ? findClip(on.dataset.id!) : null);
}
const laneOver = (e: DragEvent) => { if (!V().nested && e.dataTransfer && [ASSET_DRAG, LIB_DRAG].some((k) => Array.prototype.includes.call(e.dataTransfer!.types, k))) e.preventDefault(); };

/** waveform peaks per asset (and file path: a relinked asset is another sound), fetched once per page */
const waves = new Map<string, { rate: number; peaks: number[] } | "loading" | "failed">();
function peaksOf(id: string, path: string) {
  const key = id + "|" + path, w = waves.get(key);
  if (w === undefined) {
    waves.set(key, "loading");
    fetch("/api/peaks/" + encodeURIComponent(id)).then((r) => r.json()).then((j) => { waves.set(key, j.ok ? { rate: j.rate, peaks: j.peaks } : "failed"); changed(); }, () => { waves.set(key, "failed"); });
  }
  return w && w !== "loading" && w !== "failed" ? w : null;
}

/** an audio clip's sound as bars, one per 2 px: the loudest peak of the source stretch each bar covers ([in, in + duration * speed]) */
function Wave({ c, path, width }: { c: Clip; path: string; width: number }) {
  const w = peaksOf(c.asset, path);
  if (!w) return null;
  const sp = Number(c.speed || 1) || 1, in0 = num(c.in || 0), span = dur(c) * sp, bars = Math.max(1, Math.floor(width / 2));
  let d = "";
  for (let b = 0; b < bars; b++) {
    let m = 0;
    for (let k = Math.floor((in0 + (span * b) / bars) * w.rate), end = Math.min(w.peaks.length, Math.ceil((in0 + (span * (b + 1)) / bars) * w.rate)); k < end; k++) m = Math.max(m, w.peaks[k]);
    const h = Math.max(0.5, (m / 255) * 13);
    d += "M" + (b * 2 + 1) + " " + (14 - h).toFixed(1) + "V" + (14 + h).toFixed(1);
  }
  return <svg className="wave" width={width} height="28"><path d={d} /></svg>;
}

const TILE = 68; // px: one thumbnail of the strip (16:9 at the clip's height)
/** a video clip's thumbnail strip: one frame per tile, at the source time the tile's middle plays (rounded to 0.5 s, so zooming reuses frames).
 *  A clip whose source does not run forward at one speed (freeze, reverse, loop, speed ramp) shows its in-point frame. */
function thumbs(c: Clip, id: string, kind: string, width: number, k: number, pps: number): { image: string; position: string } {
  const url = (t: number) => "url(/api/thumb/" + encodeURIComponent(id) + "?t=" + t.toFixed(2) + ")", in0 = num(c.in || 0);
  if (kind === "image" || c.freeze || c.reverse || c.loop || (c.keyframes && c.keyframes.speed)) return { image: url(in0), position: "" };
  const sp = Number(c.speed || 1) || 1, n = Math.min(24, Math.max(1, Math.ceil(width / TILE))), xs = Array.from({ length: n }, (_, i) => i * TILE);
  return { image: xs.map((x) => url(Math.round((in0 + ((x + TILE / 2) / (k * pps)) * sp) * 2) / 2)).join(","), position: xs.map((x) => x + "px 0").join(",") };
}

function ClipBox({ tr, c, i }: { tr: Track; c: Clip; i: number }) {
  const v = V(), pps = st.pps, d = st.drag && st.drag.id === c.id ? st.drag : null, kd = st.kfDrag && st.kfDrag.id === c.id && !v.nested ? st.kfDrag : null;
  const x0 = v.off + v.k * start(c), w = v.k * dur(c);
  let left = x0 * pps, width = Math.max(4, w * pps);
  if (d && d.mode === "l") { left += d.dx; width = Math.max(4, w * pps - d.dx); }
  else if (d && d.mode === "r") width = Math.max(4, w * pps + d.dx);
  const off = c.enabled === false || x0 + w <= v.lo + 1e-6 || x0 >= v.hi - 1e-6; // disabled, or outside the opened compound's window
  const a = c.asset && S().timeline.assets[c.asset];
  const strip = a && (a.kind === "video" || a.kind === "image") && c.type !== "audio" ? thumbs(c, c.asset, a.kind, width, v.k, pps) : null;
  const label = c.text || c.name || (a ? (a.path || "").split("/").pop() : c.type);
  const trn = c.transition && playsFrom(tr, i, PAIR) ? c.transition : null; // the cue shows a transition that plays (pair.ts, as the renderer pairs)
  return (
    <div className={"clip" + (c.id === st.sel ? " sel" : "") + (st.picked.includes(c.id) ? " pick" : "") + (off ? " off" : "")} data-id={c.id} role="button"
      aria-label={t("clipLabel", c.id, c.type, start(c).toFixed(2))} title={c.id + " " + c.type + "  " + start(c).toFixed(2) + "-" + (start(c) + dur(c)).toFixed(2) + "s"}
      style={{ left: left + "px", width: width + "px", ["--hue" as string]: "var(--color-background-" + (HUE[c.type] || "gray") + ")", ["--hue-line" as string]: "var(--color-border-" + (HUE[c.type] || "gray") + ")", backgroundImage: strip ? strip.image : "", backgroundPosition: strip ? strip.position : "", backgroundRepeat: strip && strip.position ? "no-repeat" : "", transform: d && d.mode === "move" ? "translate(" + d.dx + "px,0px)" : "" }}
      onMouseDown={(ev) => clipDown(ev.nativeEvent, tr, c)}
      onMouseMove={v.nested ? undefined : (ev) => { const b = ev.currentTarget; b.style.cursor = edgeAt(ev.nativeEvent, b) === "move" ? "" : "ew-resize"; }}>
      {c.type === "audio" && a && <Wave c={c} path={a.path || ""} width={width} />}
      <span className="clabel">{c.id + " · " + String(label).slice(0, 60)}</span>
      {c.effects && c.effects.length ? <span className="fx" title={c.effects.map((e: { type?: string }) => e.type).join(", ")}>fx</span> : null}
      {trn && <div className="tr" style={{ width: v.k * (typeof trn === "object" ? num(trn.duration || 0.5) : 0.5) * pps + "px" }} title={t("transition", trn.type || trn)} />}
      {/* the trim handles show the trim zones edgeZone hit-tests (8 px, at most a quarter of the clip each) */}
      {!v.nested && <div className="h l" data-edge="l" style={{ width: Math.min(8, width / 4) + "px" }} />}
      {!v.nested && <div className="h r" data-edge="r" style={{ width: Math.min(8, width / 4) + "px" }} />}
      {kfTimes(c).filter((kt) => kt >= -1e-6 && kt <= dur(c) + 1e-6).map((kt) => ( // a split's right half keeps the curve's keys before its head
        <div key={kt} className="kf" data-t={String(kt)} style={{ left: v.k * kt * pps + (kd && near(kd.kt, kt) ? kd.dx : 0) + "px" }}
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
        i === p.length ? <span key={i} className="cur">{name}</span> : <a key={i} href="#" onClick={(e) => { e.preventDefault(); openPath(p.slice(0, i)); }}>{name}</a>,
      ])}
      {p.length ? t("readOnly") : ""}
    </span>
  );
}

/** a track header's hide, mute or lock toggle: one update_track (the shown tracks are the timeline's: an opened compound's are read-only) */
function toggleTrack(tr: Track, field: "hidden" | "muted" | "locked") {
  ops([{ op: "update_track", id: tr.id, set: { [field]: !tr[field] } }], (tr[field] ? "un" : "") + { hidden: "hide ", muted: "mute ", locked: "lock " }[field] + tr.id);
}

/** a track header toggle: its icon shows the state (on: the track is hidden, muted or locked) */
function Toggle({ tr, field, on, off, label, ro }: { tr: Track; field: "hidden" | "muted" | "locked"; on: Parameters<typeof ico>[0]; off: Parameters<typeof ico>[0]; label: string; ro: boolean }) {
  return <ToggleButton data-toggle={field} size="sm" isIconOnly label={label} isPressed={!!tr[field]} isDisabled={ro} icon={ico(off)} pressedIcon={ico(on)} onPressedChange={() => toggleTrack(tr, field)} />;
}

/** a lane's height: the main (magnetic) track is taller, as CapCut's main track and Final Cut's primary storyline are */
const laneH = (tr: Track) => (tr.magnetic ? MAIN_LANE : LANE);
const TRACK_ICON = (tr: Track) => (tr.kind === "audio" ? Music : tr.id === "text" ? TypeIcon : tr.magnetic ? Magnet : Film);

function Lanes({ W }: { W: number }) {
  const tl = S().timeline, v = V(), pps = st.pps;
  const rows = laneRows(v.tracks), firstAudio = rows.findIndex((t) => t.kind === "audio");
  const laneOf: Record<string, number> = {}, top: number[] = [];
  let H = 0;
  rows.forEach((tr, i) => { top.push(H); H += laneH(tr); tr.clips.forEach((c) => { laneOf[c.id] = i; }); });
  const mid = (i: number) => top[i] + laneH(rows[i]) / 2;
  return [
    <div key="ruler" id="ruler" style={{ width: W + "px", marginLeft: LABEL + "px" }} onMouseDown={(e) => rulerDown(e.nativeEvent)}>
      {Array.from({ length: Math.ceil(W / pps / tickStep(pps)) }, (_, n) => n * tickStep(pps)).map((x) => <div key={"t" + x} className="tick" style={{ left: x * pps + "px" }}>{x + "s"}</div>)}
      {(tl.markers || []).map((m, n) => <div key={"m" + n} className="marker" style={{ left: num(m.t) * pps + "px" }} title={m.t + "s " + (m.label || "")}>{m.label || ""}</div>)}
    </div>,
    <div key="lanes" id="lanes">
      {rows.map((tr, i) => (
        <div key={tr.id} className={"lane" + (tr.magnetic ? " main" : "") + (i === firstAudio && i > 0 ? " first-audio" : "") + (tr.locked ? " locked" : "") + (tr.hidden ? " hidden" : "") + (tr.muted ? " muted" : "")} data-track={tr.id} onDragOver={(e) => laneOver(e.nativeEvent)} onDrop={(e) => laneDrop(e.nativeEvent, e.currentTarget, tr)}>
          <div className="lname" title={[tr.kind || "video", tr.magnetic ? "magnetic" : ""].filter(Boolean).join(" ")}>
            <b>{ico(TRACK_ICON(tr))}{tr.id}</b>
            <div className="tbtns">
              {tr.kind !== "audio" && <Toggle tr={tr} field="hidden" on={EyeOff} off={Eye} label={t(tr.hidden ? "showTrack" : "hideTrack", tr.id)} ro={v.nested} />}
              <Toggle tr={tr} field="muted" on={VolumeX} off={Volume2} label={t(tr.muted ? "unmuteTrack" : "muteTrack", tr.id)} ro={v.nested} />
              <Toggle tr={tr} field="locked" on={Lock} off={LockOpen} label={t(tr.locked ? "unlockTrack" : "lockTrack", tr.id)} ro={v.nested} />
            </div>
          </div>
          <div className="lclips">{tr.clips.map((c, i) => <ClipBox key={c.id} tr={tr} c={c} i={i} />)}</div>
        </div>
      ))}
    </div>,
    <svg key="links" id="links" width={W} height={H} style={{ left: LABEL + "px" }}>
      {rows.flatMap((tr, i) => tr.clips.map((c) => {
        if (!c.attach_to) return null;
        const pid = resolveRef(v.tracks, c.attach_to);
        if (pid === null || laneOf[pid] === undefined) return null;
        const x = (v.off + v.k * start(c)) * pps, y1 = mid(i), y2 = mid(laneOf[pid]);
        return [<path key={c.id + "l"} d={"M" + x + " " + y1 + " L" + x + " " + y2} stroke="var(--color-text-warning)" strokeDasharray="3 3" />, <circle key={c.id + "c"} cx={x} cy={y2} r="3" fill="var(--color-text-warning)" />];
      }))}
    </svg>,
    <div key="ph" id="ph" style={{ left: LABEL + st.t * pps + "px", height: H + 24 + "px" }} />,
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
      setZoom(clampZoom(st.pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    };
    sc.addEventListener("wheel", wheel, { passive: false });
    return () => sc.removeEventListener("wheel", wheel);
  }, []);
  const shown = scroll.current ? scroll.current.clientWidth - LABEL : 0; // the lanes and the ruler fill the box at least
  const W = Math.max((total() + 5) * st.pps, 10 * st.pps, shown);
  return (
    <section id="tl">
      <div id="tbar">
        <Tools />
        <Crumbs />
        <span className="grow" />
        <span className="mut mono" id="dur" title={t("tlHint")}>{st.S ? total().toFixed(2) + " s" : ""}</span>
        <span className="zoom">
          <IconButton size="sm" variant="ghost" label={t("zoomOut")} tooltip={t("zoomOut")} icon={ico(ZoomOut)} onClick={() => setZoom(clampZoom(st.pps / 1.5))} />
          <Slider id="zoom" label={t("zoom")} isLabelHidden valueDisplay="none" min={ZMIN} max={ZMAX} step={1} value={Math.round(st.pps)} onChange={(v: number) => setZoom(v)} width={120} />
          <IconButton size="sm" variant="ghost" label={t("zoomIn")} tooltip={t("zoomIn")} icon={ico(ZoomIn)} onClick={() => setZoom(clampZoom(st.pps * 1.5))} />
          <IconButton id="zfit" size="sm" variant="ghost" label={t("zoomFit")} tooltip={t("zoomFit")} icon={ico(Maximize2)} onClick={fitZoom} />
        </span>
      </div>
      <div id="scroll" ref={scroll}>
        <div id="inner" style={{ width: st.S ? W + LABEL + "px" : "" }}>
          {st.S ? <Lanes W={W} /> : [<div key="ruler" id="ruler" style={{ marginLeft: LABEL + "px" }} />, <div key="lanes" id="lanes" />, <svg key="links" id="links" />, <div key="ph" id="ph" />]}
        </div>
      </div>
    </section>
  );
}
