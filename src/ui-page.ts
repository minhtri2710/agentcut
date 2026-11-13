// The single-page UI served by `agentcut ui` (plain HTML/CSS/JS, no build step). The client code avoids backticks and
// "${" so it can live in this template string (the one interpolation below injects the keyframe enums).
import { ANIMATABLE, EASINGS } from "./model.ts";

export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>AgentCut</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
body{margin:0;font:13px/1.35 system-ui,sans-serif;background:#16181d;color:#dde;display:grid;grid-template-rows:auto 1fr auto;height:100vh;overflow:hidden}
header{display:flex;gap:8px;align-items:center;padding:6px 10px;background:#1f2229;border-bottom:1px solid #333}
header b{font-size:14px}
button{background:#2d323c;color:#eee;border:1px solid #444;border-radius:4px;padding:3px 9px;cursor:pointer;font:inherit}
button:hover{background:#3a404c}button:disabled{opacity:.4;cursor:default}
dialog{background:#1f2229;color:#dde;border:1px solid #555;border-radius:6px;max-width:420px}
#main{display:grid;grid-template-columns:1fr 360px;min-height:0}
#viewer{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:0;background:#0d0e11;position:relative}
#viewer img,#viewer video{max-width:100%;max-height:calc(100% - 30px);object-fit:contain;background:#000}
#vbar{display:flex;gap:8px;align-items:center;height:30px}
#side{border-left:1px solid #333;display:flex;flex-direction:column;min-height:0;overflow:auto;padding:8px;gap:6px}
#side>*{flex:none}
textarea{width:100%;background:#0f1115;color:#cfe;border:1px solid #333;border-radius:4px;font:12px ui-monospace,monospace;padding:6px}
#insp{height:300px}#ops{height:70px}
#msg{white-space:pre-wrap;font-size:12px;padding:6px;border-radius:4px;display:none}
#msg.err{display:block;background:#4a1d1d;color:#fcc}#msg.ok{display:block;background:#1d3a24;color:#cfc}
#out a{color:#8cf}#out img{width:100%;margin-top:4px;cursor:zoom-in}
progress{width:100%}
#tl{height:290px;border-top:1px solid #333;background:#1b1d23;display:flex;flex-direction:column}
#tbar{display:flex;gap:8px;align-items:center;padding:4px 8px;font-size:12px}
#scroll{flex:1;overflow:auto;position:relative}
#inner{position:relative}
#ruler{height:20px;position:sticky;top:0;background:#23262e;z-index:3;border-bottom:1px solid #333;cursor:pointer;margin-left:90px}
.tick{position:absolute;top:0;height:100%;border-left:1px solid #555;font-size:10px;padding-left:2px;color:#999}
.marker{position:absolute;top:0;width:0;height:100%;border-left:2px solid #fc3;font-size:10px;color:#fc3;padding-left:2px;white-space:nowrap}
.lane{position:relative;height:44px;border-bottom:1px solid #2a2d35;display:flex}
.lname{width:90px;flex:none;position:sticky;left:0;z-index:2;background:#23262e;padding:4px;font-size:11px;color:#aab;overflow:hidden;border-right:1px solid #333}
.lclips{position:relative;flex:1}
.clip{position:absolute;top:3px;height:38px;border-radius:4px;overflow:hidden;font-size:11px;padding:2px 6px;color:#fff;cursor:grab;
  background-repeat:repeat-x;background-size:auto 100%;border:1px solid rgba(255,255,255,.25);text-shadow:0 1px 2px #000;white-space:nowrap}
.clip.sel{outline:2px solid #fff;z-index:1}.clip.off{opacity:.45}
.clip .h{position:absolute;top:0;width:6px;height:100%;cursor:ew-resize}.clip .h.l{left:0}.clip .h.r{right:0}
.tr{position:absolute;top:0;height:100%;left:0;background:repeating-linear-gradient(45deg,rgba(255,255,255,.35) 0 4px,transparent 4px 8px);pointer-events:none}
#links{position:absolute;left:90px;top:20px;pointer-events:none;z-index:1}
#ph{position:absolute;top:0;width:2px;background:#f44;z-index:4;pointer-events:none}
.mut{color:#889}
.kf{position:absolute;bottom:1px;width:9px;height:9px;margin-left:-4px;background:#fc3;border:1px solid #000;transform:rotate(45deg);cursor:ew-resize;z-index:2}
#crumbs a{color:#8cf;cursor:pointer}#crumbs .cur{color:#fc3}
#kfbox{display:flex;flex-direction:column;gap:3px}#kfbox .row{display:flex;gap:4px;align-items:center}
#kfbox input{width:64px;background:#0f1115;color:#cfe;border:1px solid #333;border-radius:3px;font:12px ui-monospace,monospace;padding:2px 4px}
#kfbox select{background:#0f1115;color:#cfe;border:1px solid #333;border-radius:3px;font:inherit}#kfbox b{min-width:64px}
.clip.pick{outline:2px dashed #fc3}
</style></head>
<body>
<header>
  <b id="name">AgentCut</b><span class="mut" id="rev"></span>
  <button id="undo" title="undo (Cmd/Ctrl+Z)">Undo</button><button id="redo" title="redo (Shift+Cmd/Ctrl+Z)">Redo</button>
  <span style="flex:1"></span><span id="issues" class="mut"></span>
  <label class="mut"><input type="checkbox" id="draft" checked> draft</label>
  <button id="render">Render</button><button id="sheet">Contact sheet</button>
</header>
<div id="main">
  <div id="viewer"><img id="frame" alt="preview"><video id="video" style="display:none" controls></video>
    <div id="vbar"><button id="play">Play</button><button id="prepare" style="display:none">Prepare</button><span id="time">0.00 s</span><span class="mut" id="vstat"></span></div></div>
  <div id="side">
    <div class="mut" id="selinfo">Select a clip on the timeline.</div>
    <textarea id="insp" spellcheck="false" placeholder="clip JSON"></textarea>
    <div><button id="applyc" disabled>Apply clip</button> <button id="delc" disabled>Delete clip</button></div>
    <div id="cbtns"><button id="openc" style="display:none">Open compound</button> <button id="expc" style="display:none">Expand</button>
      <button id="group" style="display:none">Group</button> <span id="regroups"></span></div>
    <div id="kfbox"></div>
    <div id="msg"></div>
    <div class="mut">Ops batch (JSON list), applied atomically:</div>
    <textarea id="ops" spellcheck="false" placeholder='[{"op":"add_clip","track":"text","text":"Hi","at":0,"duration":2}]'></textarea>
    <div><button id="applyo">Apply ops</button></div>
    <div id="out"></div>
  </div>
</div>
<dialog id="consent" aria-labelledby="ctitle"><p id="ctitle"><b>Download a vision model?</b></p><ul id="clist"></ul>
  <p class="mut">Nothing is downloaded unless you confirm.</p><div><button id="cgo">Download and prepare</button> <button id="cno">Cancel</button></div></dialog>
<div id="tl">
  <div id="tbar"><span class="mut">zoom</span><input type="range" id="zoom" min="10" max="400" value="80"><span class="mut" id="dur"></span>
    <span id="crumbs"></span>
    <span class="mut">drag = move, edges = trim, shift-click = multi-select, double-click compound = open, click ruler = seek</span></div>
  <div id="scroll"><div id="inner"><div id="ruler"></div><div id="lanes"></div><svg id="links"></svg><div id="ph"></div></div></div>
</div>
<script>
"use strict";
var $ = function (id) { return document.getElementById(id); };
var ENUM = ${JSON.stringify({ animatable: ANIMATABLE, easings: EASINGS })};
var S = null, V = null, kfProp = "opacity", path = [], picked = [], sel = null, inspBase = "", t = 0, pps = 80, LABEL = 90, LANE = 44;
var COL = { video: "#3b6fb6", image: "#2f8f83", text: "#a35bb8", captions: "#b8865b", shape: "#7b8f2f", color: "#8f2f5a",
  lottie: "#2f5a8f", audio: "#2f8f4a", gap: "#444", compound: "#b85b5b" };

function num(v) { if (typeof v === "number") return v; var s = String(v).trim(), m;
  if ((m = /^(-?[\\d.]+)ms$/.exec(s))) return +m[1] / 1000; if ((m = /^(-?[\\d.]+)s$/.exec(s))) return +m[1];
  if (s.indexOf(":") >= 0) return s.split(":").reduce(function (a, x) { return a * 60 + +x; }, 0); return +s; }
function start(c) { return num(c.start || 0); }
function dur(c) { return num(c.duration || 0); }
function total() { return S ? S.duration : 0; }
function api(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
    .then(function (r) { return r.json(); }).then(function (j) { if (!j.ok) throw j.error || { message: "request failed" }; return j; });
}
function show(kind, text) { var m = $("msg"); m.className = kind; m.textContent = text; if (kind === "ok") setTimeout(function () { if (m.textContent === text) m.className = ""; }, 2500); }
function fail(e) {
  if (e && e.code === "not_prepared") $("prepare").style.display = "";
  var s = (e.code ? "[" + e.code + "] " : "") + (e.message || e) + (e.hint ? "\\nhint: " + e.hint : "");
  (e.issues || []).forEach(function (i) { s += "\\n- " + i.path + ": " + i.message + (i.hint ? " (" + i.hint + ")" : ""); });
  show("err", s);
}
/** every edit carries the revision this page shows: if an agent saved meanwhile the server answers "conflict" */
function ops(list, label) {
  return api("/api/ops", { ops: list, revision: S.revision, label: label }).then(function (r) {
    show("ok", "applied (revision " + r.revision + ")" + (r.errors ? ", " + r.errors + " error(s) remain" : ""));
    return r;
  }, fail);
}

// ------------------------------------------------------------ state
function setState(s) {
  S = s;
  $("name").textContent = s.timeline.name || "untitled";
  $("rev").textContent = "rev " + s.revision + " · " + s.timeline.settings.width + "x" + s.timeline.settings.height + " @" + s.timeline.settings.fps;
  $("issues").textContent = (s.errors || 0) + " errors, " + (s.warnings || 0) + " warnings";
  $("undo").disabled = !s.history.undo.length; $("undo").title = "undo: " + (s.history.undo.slice(-1)[0] || "");
  $("redo").disabled = !s.history.redo.length; $("redo").title = "redo: " + (s.history.redo.slice(-1)[0] || "");
  $("dur").textContent = total().toFixed(2) + " s";
  V = view();
  picked = picked.filter(function (id) { return findClip(id); });
  var c = sel && findClip(sel);
  if (!c) select(null);
  else if ($("insp").value === inspBase) select(sel); // refresh unless the user is editing
  drawTimeline(); requestFrame();
}
function findIn(tracks, id) { var r = null; tracks.forEach(function (tr) { tr.clips.forEach(function (c) { if (c.id === id) r = { c: c, tr: tr }; }); }); return r; }
function findClip(id) { var r = findIn(V.tracks, id); return r && r.c; }
function trackOf(id) { var r = findIn(V.tracks, id); return r && r.tr; }
/** the tracks shown: the timeline, or the nested tracks of the opened compound (path) drawn where render plays them.
 *  A nested time u plays at timeline time off + k * u (render.ts subT: u = in + local * speed, composed per opened level);
 *  [lo, hi] is the timeline range every opened compound shows (its [in, in + duration * speed] window). */
function view() {
  var tracks = S.timeline.tracks, off = 0, k = 1, lo = -Infinity, hi = Infinity;
  for (var i = 0; i < path.length; i++) {
    var f = findIn(tracks, path[i]);
    if (!f || f.c.type !== "compound") { path = path.slice(0, i); break; }
    var v = Number(f.c.speed || 1) || 1;
    lo = Math.max(lo, off + k * start(f.c)); hi = Math.min(hi, off + k * (start(f.c) + dur(f.c)));
    off += k * (start(f.c) - num(f.c.in || 0) / v); k /= v; tracks = f.c.tracks || [];
  }
  return { tracks: tracks, off: off, k: k, lo: lo, hi: hi, nested: path.length > 0 };
}
function openPath(p) { path = p; sel = null; picked = []; V = view(); select(null); drawTimeline(); }
function drawCrumbs() {
  var b = $("crumbs"); b.innerHTML = "";
  ["timeline"].concat(path).forEach(function (name, i) {
    if (i) b.appendChild(document.createTextNode(" › "));
    var a = document.createElement(i === path.length ? "span" : "a"); a.textContent = name;
    if (i === path.length) a.className = "cur"; else a.onclick = function () { openPath(path.slice(0, i)); };
    b.appendChild(a);
  });
  if (path.length) b.appendChild(document.createTextNode(" (read-only: expand to edit) "));
}
var es = new EventSource("/api/events");
es.addEventListener("state", function (e) { setState(JSON.parse(e.data)); });
/** newest SSE event per job id: a job can settle before its POST response resolves, and the POST body is only the snapshot at start */
var lastJob = {};
es.addEventListener("job", function (e) {
  var j = JSON.parse(e.data); lastJob[j.id] = j;
  var ids = Object.keys(lastJob); if (ids.length > 16) delete lastJob[ids[0]];
  onJob(j);
});
function settle(j) { var k = lastJob[j.id] || j; delete lastJob[j.id]; onJob(k); }
es.addEventListener("error", function (e) { if (e.data) fail(JSON.parse(e.data)); });

// ------------------------------------------------------------ timeline
function drawTimeline() {
  var tl = S.timeline, W = Math.max(total() + 5, 10) * pps, lanes = $("lanes");
  $("inner").style.width = (W + LABEL) + "px";
  var r = $("ruler"); r.innerHTML = ""; r.style.width = W + "px";
  var step = pps > 150 ? 0.5 : pps > 50 ? 1 : pps > 20 ? 5 : 10;
  for (var x = 0; x * pps < W; x += step) { var d = document.createElement("div"); d.className = "tick"; d.style.left = x * pps + "px"; d.textContent = x + "s"; r.appendChild(d); }
  (tl.markers || []).forEach(function (m) { var d = document.createElement("div"); d.className = "marker"; d.style.left = num(m.t) * pps + "px"; d.textContent = m.label || ""; d.title = m.t + "s " + (m.label || ""); r.appendChild(d); });
  lanes.innerHTML = ""; drawCrumbs();
  var rows = V.tracks.slice().reverse(); // tracks[0] is the bottom layer: draw it last (lowest lane)
  rows.forEach(function (tr) {
    var lane = document.createElement("div"); lane.className = "lane"; lane.dataset.track = tr.id;
    var nm = document.createElement("div"); nm.className = "lname";
    nm.innerHTML = "<b></b><br><span class=mut></span>"; nm.firstChild.textContent = tr.id;
    nm.lastChild.textContent = [tr.kind || "video", tr.magnetic ? "magnetic" : "", tr.muted ? "muted" : "", tr.hidden ? "hidden" : ""].filter(Boolean).join(" ");
    var cl = document.createElement("div"); cl.className = "lclips";
    tr.clips.forEach(function (c, i) { cl.appendChild(clipEl(tr, c, i)); });
    lane.appendChild(nm); lane.appendChild(cl); lanes.appendChild(lane);
  });
  var H = rows.length * LANE, svg = $("links");
  svg.setAttribute("width", W); svg.setAttribute("height", H); svg.innerHTML = "";
  var laneOf = {}; rows.forEach(function (tr, i) { tr.clips.forEach(function (c) { laneOf[c.id] = i; }); });
  rows.forEach(function (tr, i) { tr.clips.forEach(function (c) {
    if (!c.attach_to) return;
    var pid = resolveRef(c.attach_to); if (pid === null || laneOf[pid] === undefined) return;
    var x = (V.off + V.k * start(c)) * pps, y1 = i * LANE + LANE / 2, y2 = laneOf[pid] * LANE + LANE / 2;
    var ln = document.createElementNS("http://www.w3.org/2000/svg", "path");
    ln.setAttribute("d", "M" + x + " " + y1 + " L" + x + " " + y2); ln.setAttribute("stroke", "#fc3"); ln.setAttribute("stroke-dasharray", "3 3");
    var dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", x); dot.setAttribute("cy", y2); dot.setAttribute("r", 3); dot.setAttribute("fill", "#fc3");
    svg.appendChild(ln); svg.appendChild(dot);
  }); });
  $("ph").style.height = (H + 20) + "px"; movePlayhead(); drawRegroup();
}
function resolveRef(ref) {
  var m = /^(.+)#(-?\\d+)$/.exec(ref);
  if (!m) return ref;
  var tr = V.tracks.filter(function (x) { return x.id === m[1]; })[0]; if (!tr) return null;
  var i = +m[2]; if (i < 0) i += tr.clips.length; var c = tr.clips[i]; return c ? c.id : null;
}
function clipEl(tr, c, i) {
  var e = document.createElement("div"); e.className = "clip" + (c.id === sel ? " sel" : "") + (picked.indexOf(c.id) >= 0 ? " pick" : "");
  e.dataset.id = c.id;
  var x0 = V.off + V.k * start(c), x1 = x0 + V.k * dur(c);
  if (c.enabled === false || x1 <= V.lo + 1e-6 || x0 >= V.hi - 1e-6) e.classList.add("off"); // disabled, or outside the opened compound's window
  e.style.left = x0 * pps + "px"; e.style.width = Math.max(4, V.k * dur(c) * pps) + "px";
  e.style.backgroundColor = COL[c.type] || "#555";
  var a = c.asset && S.timeline.assets[c.asset];
  if (a && (a.kind === "video" || a.kind === "image")) e.style.backgroundImage = "url(/api/thumb/" + encodeURIComponent(c.asset) + "?t=" + num(c.in || 0).toFixed(2) + ")";
  var label = c.text || c.name || (a ? (a.path || "").split("/").pop() : c.type);
  e.textContent = c.id + " · " + String(label).slice(0, 60);
  e.title = c.id + " " + c.type + "  " + start(c).toFixed(2) + "-" + (start(c) + dur(c)).toFixed(2) + "s";
  var trn = c.transition && i > 0 ? c.transition : null;
  if (trn) { var td = typeof trn === "object" ? num(trn.duration || 0.5) : 0.5; var o = document.createElement("div"); o.className = "tr";
    o.style.width = V.k * td * pps + "px"; o.title = "transition " + (trn.type || trn); e.appendChild(o); }
  if (!V.nested) ["l", "r"].forEach(function (s) { var h = document.createElement("div"); h.className = "h " + s; h.dataset.edge = s; e.appendChild(h); });
  kfTimes(c).forEach(function (kt) {
    var k = document.createElement("div"); k.className = "kf"; k.style.left = V.k * kt * pps + "px"; k.dataset.t = kt;
    k.title = "keyframe " + kt + "s: " + Object.keys(c.keyframes).filter(function (p) { return pts(c.keyframes[p]).some(function (q) { return near(q[0], kt); }); }).join(", ");
    e.appendChild(k);
  });
  e.addEventListener("mousedown", function (ev) {
    if (ev.shiftKey) { ev.preventDefault(); if (!picked.length && sel && sel !== c.id) picked.push(sel); var i = picked.indexOf(c.id); if (i >= 0) picked.splice(i, 1); else picked.push(c.id); select(sel); return; }
    if (ev.target.dataset.t !== undefined) return kfDrag(ev, c, +ev.target.dataset.t);
    if (ev.detail === 2 && c.type === "compound") { ev.preventDefault(); openPath(path.concat([c.id])); return; } // the first click redraws, so no dblclick
    if (V.nested) { select(c.id); return; }
    drag(ev, tr, c, ev.target.dataset.edge || "move");
  });
  return e;
}
/** drag a clip: move (other lane = other track; magnetic = new index) or trim an edge; one op on release */
function drag(ev, tr, c, mode) {
  ev.preventDefault(); select(c.id);
  var el = $("lanes").querySelector('[data-id="' + c.id + '"]'), x0 = ev.clientX, s0 = start(c), d0 = dur(c), moved = false;
  function mm(e) {
    var dt = (e.clientX - x0) / pps; if (Math.abs(e.clientX - x0) > 3) moved = true;
    if (mode === "move") el.style.transform = "translate(" + (e.clientX - x0) + "px," + 0 + "px)";
    else if (mode === "l") { el.style.left = (s0 + dt) * pps + "px"; el.style.width = Math.max(4, (d0 - dt) * pps) + "px"; }
    else el.style.width = Math.max(4, (d0 + dt) * pps) + "px";
  }
  function mu(e) {
    document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu);
    if (!moved) { drawTimeline(); return; }
    var dt = +((e.clientX - x0) / pps).toFixed(3), op;
    if (mode === "l") op = { op: "trim_clip", id: c.id, trim_start: dt };
    else if (mode === "r") op = { op: "trim_clip", id: c.id, duration: +Math.max(0.04, d0 + dt).toFixed(3) };
    else {
      var lane = document.elementsFromPoint(e.clientX, e.clientY).filter(function (n) { return n.classList && n.classList.contains("lane"); })[0];
      var dest = lane ? lane.dataset.track : tr.id, dtr = V.tracks.filter(function (x) { return x.id === dest; })[0] || tr;
      op = { op: "move_clip", id: c.id };
      if (dest !== tr.id) op.track = dest;
      if (c.attach_to) { // a connected clip's start follows its parent: dragging changes its offset
        var batch = [{ op: "update_clip", id: c.id, set: { offset: +(num(c.offset || 0) + dt).toFixed(3) } }];
        if (op.track) batch.unshift(op);
        return ops(batch, "move " + c.id).then(function (r) { if (!r) drawTimeline(); });
      }
      if (dtr.magnetic) { var at = s0 + dt, idx = 0;
        dtr.clips.forEach(function (o) { if (o.id !== c.id && start(o) + dur(o) / 2 < at + (mode === "move" ? d0 / 2 : 0)) idx++; });
        op.index = idx; }
      else op.at = +Math.max(0, s0 + dt).toFixed(3);
    }
    ops([op], op.op + " " + c.id).then(function (r) { if (!r) drawTimeline(); });
  }
  document.addEventListener("mousemove", mm); document.addEventListener("mouseup", mu);
}
function movePlayhead() { $("ph").style.left = (LABEL + t * pps) + "px"; $("time").textContent = t.toFixed(2) + " s"; }
$("ruler").addEventListener("mousedown", function (ev) {
  function at(e) { var b = $("ruler").getBoundingClientRect(); seek((e.clientX - b.left) / pps); }
  at(ev);
  function up() { document.removeEventListener("mousemove", at); document.removeEventListener("mouseup", up); }
  document.addEventListener("mousemove", at); document.addEventListener("mouseup", up);
});
$("zoom").addEventListener("input", function () { pps = +$("zoom").value; drawTimeline(); });
$("scroll").addEventListener("wheel", function (e) { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault();
  pps = Math.max(10, Math.min(400, pps * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); $("zoom").value = pps; drawTimeline(); }, { passive: false });

// ------------------------------------------------------------ viewer
var want = null, busy = false;
function seek(x) { stopPlay(); t = Math.max(0, Math.min(total(), x)); movePlayhead(); requestFrame(); }
/** latest-wins frame fetch: at most one request in flight, debounced while scrubbing */
var deb = 0;
function requestFrame() { clearTimeout(deb); deb = setTimeout(function () { want = t; pump(); }, 60); }
function pump() {
  if (busy || want === null || !S) return;
  if (!(total() > 0)) { want = null; return; } // an empty timeline has no frame: the server would refuse it
  var st = S.timeline.settings, box = $("viewer").getBoundingClientRect();
  var scale = Math.max(0.25, Math.min(1, Math.ceil(4 * Math.min(box.width / st.width, box.height / st.height) * (window.devicePixelRatio || 1)) / 4));
  var at = Math.min(want, Math.max(0, total() - 1 / st.fps)); // the server refuses t at or past the duration: the playhead at the end shows the last frame
  var url = "/api/frame?t=" + at.toFixed(3) + "&scale=" + scale + "&rev=" + S.revision; want = null; busy = true;
  var t0 = performance.now();
  fetch(url).then(function (r) { if (!r.ok) return r.json().then(function (j) { throw j.error; }); return r.blob(); }).then(function (b) {
    var old = $("frame").src; $("frame").src = URL.createObjectURL(b); if (old.indexOf("blob:") === 0) URL.revokeObjectURL(old);
    $("vstat").textContent = Math.round(performance.now() - t0) + " ms/frame"; if (!prepJob) $("prepare").style.display = "none";
  }, function (e) {
    $("vstat").textContent = e && e.message ? e.message + (e.hint ? " (" + e.hint + ")" : "") : "frame failed";
    if (e && e.code === "not_prepared") $("prepare").style.display = "";
  }).then(function () { busy = false; pump(); });
}
var playJob = null, playStart = 0;
/** play = draft-render [playhead, end of the visible range] once per revision, then play it in <video> */
$("play").addEventListener("click", function () {
  if ($("video").style.display !== "none") { stopPlay(); return; }
  var sc = $("scroll"), end = Math.min(total(), Math.max(t + 1, (sc.scrollLeft + sc.clientWidth - LABEL) / pps));
  playStart = t; $("play").textContent = "Preparing…";
  api("/api/render", { play: true, start: t, end: end }).then(function (j) { playJob = j.id; settle(j); }, function (e) { $("play").textContent = "Play"; fail(e); });
});
var prepJob = null;
/** run prepare (mattes, vision analyses, pending requests) as a server job; the viewer redraws when it is done */
function startPrepare(allowDownload) {
  $("prepare").disabled = true; $("prepare").textContent = "Preparing…";
  api("/api/prepare", allowDownload ? { allow_download: true } : {}).then(function (j) { prepJob = j.id; settle(j); }, function (e) { $("prepare").disabled = false; $("prepare").textContent = "Prepare"; fail(e); });
}
$("prepare").addEventListener("click", function () { startPrepare(false); });
/** a missing model is downloaded only after a click here: Cancel and Escape show the failure instead, and nothing retries by itself */
var consentErr = null;
function askDownload(err) {
  consentErr = err; var d = $("consent"), l = $("clist"); l.innerHTML = "";
  err.models.forEach(function (m) { var li = document.createElement("li"); li.textContent = m.model + " (" + (m.approx_mb == null ? "size unknown" : "~" + m.approx_mb + " MB") + ")"; l.appendChild(li); });
  d.returnValue = ""; d.showModal(); $("cgo").focus();
}
$("cgo").addEventListener("click", function () { $("consent").close("go"); });
$("cno").addEventListener("click", function () { $("consent").close("no"); });
$("consent").addEventListener("close", function () { if ($("consent").returnValue === "go") startPrepare(true); else fail(consentErr); });
function stopPlay() { var v = $("video"); if (v.style.display === "none") return; v.pause(); v.style.display = "none"; $("frame").style.display = ""; $("play").textContent = "Play"; requestFrame(); }
$("video").addEventListener("timeupdate", function () { t = playStart + $("video").currentTime; movePlayhead(); });
$("video").addEventListener("ended", stopPlay);

// ------------------------------------------------------------ inspector
function select(id) {
  sel = id; var c = id && findClip(id);
  $("applyc").disabled = $("delc").disabled = !c || V.nested; $("insp").readOnly = V.nested;
  if (!c) { $("selinfo").textContent = "Select a clip on the timeline."; $("insp").value = inspBase = ""; }
  else { $("selinfo").textContent = c.id + " on " + trackOf(id).id + " (" + c.type + ")" + (V.nested ? " inside " + path[path.length - 1] + ": expand it to edit" : "");
    $("insp").value = inspBase = JSON.stringify(c, null, 2); }
  document.querySelectorAll(".clip").forEach(function (n) { n.classList.toggle("sel", n.dataset.id === id); n.classList.toggle("pick", picked.indexOf(n.dataset.id) >= 0); });
  var cmp = c && c.type === "compound";
  $("openc").style.display = cmp ? "" : "none";
  $("expc").style.display = cmp && !V.nested ? "" : "none";
  var g = groupIds(); $("group").style.display = g.length && !V.nested ? "" : "none"; $("group").textContent = "Group " + g.length + " clip(s)";
  drawKf(c);
}

// ------------------------------------------------------------ compound clips (nested edits: expand, edit, regroup)
function groupIds() { return picked.length ? picked.slice() : sel && findClip(sel) && !V.nested ? [sel] : []; }
/** one "Regroup <id>" button per expanded compound still on the timeline: expand_compound stamps what it places with group.id, make_compound from=<id> takes it back */
function drawRegroup() {
  var box = $("regroups"), seen = {}; box.innerHTML = "";
  if (V.nested) return;
  var used = {}; (function ids(tracks) { tracks.forEach(function (tr) { tr.clips.forEach(function (c) { used[c.id] = 1; if (c.type === "compound") ids(c.tracks || []); }); }); })(S.timeline.tracks); // like the server: nested ids count
  S.timeline.tracks.forEach(function (tr) { tr.clips.forEach(function (c) {
    var g = c.group && c.group.id; if (!g || seen[g] || used[g]) return;
    seen[g] = 1;
    var b = el("button", { textContent: "Regroup " + g, onclick: function () {
      ops([{ op: "make_compound", from: g }], "regroup " + g).then(function (r) { if (r) select(r.results[0].id); }); } });
    b.dataset.group = g; box.appendChild(b);
  }); });
}
$("openc").addEventListener("click", function () { openPath(path.concat([sel])); });
$("expc").addEventListener("click", function () {
  var c = findClip(sel);
  ops([{ op: "expand_compound", id: c.id }], "expand " + c.id).then(function (r) { if (r) { picked = []; select(null); } });
});
$("group").addEventListener("click", function () {
  var ids = groupIds();
  ops([{ op: "make_compound", ids: ids }], "group " + ids.join(",")).then(function (r) { if (r) { picked = []; select(r.results[0].id); } });
});

// ------------------------------------------------------------ keyframes (every edit = one set_keyframes op per prop)
function near(a, b) { return Math.abs(a - b) < 0.0005; }
function pts(list) { return (list || []).map(function (k) { return Array.isArray(k) ? [num(k[0]), +k[1], k[2]] : [num(k.t || 0), +(k.v !== undefined ? k.v : k.value), k.ease]; })
  .sort(function (a, b) { return a[0] - b[0]; }); }
function kfTimes(c) {
  var r = []; Object.keys(c.keyframes || {}).forEach(function (p) { pts(c.keyframes[p]).forEach(function (q) { if (!r.some(function (x) { return near(x, q[0]); })) r.push(q[0]); }); });
  return r;
}
function packKf(list) { return list.length ? list.slice().sort(function (a, b) { return a[0] - b[0]; }).map(function (q) { return q[2] && q[2] !== "linear" ? [+q[0].toFixed(3), q[1], q[2]] : [+q[0].toFixed(3), q[1]]; }) : null; }
function setKf(c, prop, list) { return ops([{ op: "set_keyframes", id: c.id, prop: prop, keyframes: packKf(list) }], "keyframes " + c.id + "." + prop); }
function kfBase(c, prop) {
  var st = S.timeline.settings, d = { x: st.width / 2, y: st.height / 2, scale: 1, scale_x: 1, scale_y: 1, opacity: 1, volume: 1, speed: 1, focus_x: 0.5, focus_y: 0.5 };
  return typeof c[prop] === "number" ? c[prop] : d[prop] !== undefined ? d[prop] : 0;
}
/** value at local time lt, linear between neighbours (a starting point for the new key; the renderer applies the easing) */
function kfAt(list, lt) {
  if (lt <= list[0][0]) return list[0][1];
  for (var i = 1; i < list.length; i++) if (lt <= list[i][0]) { var a = list[i - 1], b = list[i]; return +(a[1] + (b[1] - a[1]) * (lt - a[0]) / Math.max(1e-9, b[0] - a[0])).toFixed(4); }
  return list[list.length - 1][1];
}
function el(tag, props, kids) { var e = document.createElement(tag); Object.keys(props || {}).forEach(function (k) { e[k] = props[k]; }); (kids || []).forEach(function (k) { e.appendChild(k); }); return e; }
function drawKf(c) {
  var box = $("kfbox"); box.innerHTML = "";
  if (!c || c.type === "gap") return;
  var ro = V.nested, kf = c.keyframes || {};
  var prop = el("select", { id: "kfprop", disabled: ro, onchange: function () { kfProp = prop.value; } },
    ENUM.animatable.map(function (p) { return el("option", { value: p, textContent: p, selected: p === kfProp }); }));
  var add = el("button", { id: "kfadd", textContent: "+ key at playhead", disabled: ro });
  add.onclick = function () {
    var p = prop.value, lt = +Math.max(0, Math.min(dur(c), (t - V.off) / V.k - start(c))).toFixed(3), list = pts(kf[p]);
    var v = list.length ? kfAt(list, lt) : kfBase(c, p);
    setKf(c, p, list.filter(function (q) { return !near(q[0], lt); }).concat([[lt, v, undefined]]));
  };
  box.appendChild(el("div", { className: "row" }, [el("span", { className: "mut", textContent: "Keyframes" }), prop, add]));
  Object.keys(kf).forEach(function (p) {
    var list = pts(kf[p]);
    var rm = el("button", { textContent: "clear", title: "remove all " + p + " keyframes", disabled: ro }); rm.onclick = function () { setKf(c, p, []); };
    box.appendChild(el("div", { className: "row" }, [el("b", { textContent: p }), el("span", { className: "mut", textContent: "t (s) · value · easing into it" }), rm]));
    list.forEach(function (q, i) {
      var commit = function () {
        var nt = parseFloat(ti.value), nv = parseFloat(vi.value);
        if (!isFinite(nt) || !isFinite(nv)) return fail({ code: "bad_value", message: p + ": t and value must be numbers" });
        var next = list.slice(); next[i] = [nt, nv, es.value]; setKf(c, p, next);
      };
      var ti = el("input", { type: "number", step: "0.05", value: q[0], title: "time from clip start", disabled: ro, onchange: commit });
      var vi = el("input", { type: "number", step: "0.05", value: q[1], disabled: ro, onchange: commit });
      var es = el("select", { disabled: ro, onchange: commit }, ENUM.easings.map(function (n) { return el("option", { value: n, textContent: n, selected: (q[2] || "linear") === n }); }));
      var del = el("button", { textContent: "×", title: "delete this keyframe", disabled: ro }); del.onclick = function () { setKf(c, p, list.filter(function (_, j) { return j !== i; })); };
      box.appendChild(el("div", { className: "row kfrow" }, [ti, vi, es, del]));
    });
  });
}
/** drag a keyframe tick: moves every prop's point at that time; one batch of set_keyframes on release */
function kfDrag(ev, c, kt) {
  ev.preventDefault(); ev.stopPropagation(); select(c.id);
  var k = ev.target, x0 = ev.clientX, moved = false;
  function mm(e) { if (Math.abs(e.clientX - x0) > 2) moved = true; if (!V.nested) k.style.left = (kt * pps + e.clientX - x0) + "px"; }
  function mu(e) {
    document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu);
    if (!moved || V.nested) { seek(V.off + V.k * (start(c) + kt)); return; }
    var nt = +Math.max(0, Math.min(dur(c), kt + (e.clientX - x0) / pps)).toFixed(3), batch = [];
    Object.keys(c.keyframes).forEach(function (p) {
      var list = pts(c.keyframes[p]); if (!list.some(function (q) { return near(q[0], kt); })) return;
      list = list.filter(function (q) { return !near(q[0], nt); }).map(function (q) { return near(q[0], kt) ? [nt, q[1], q[2]] : q; });
      batch.push({ op: "set_keyframes", id: c.id, prop: p, keyframes: packKf(list) });
    });
    ops(batch, "move keyframe " + c.id).then(function (r) { if (!r) drawTimeline(); });
  }
  document.addEventListener("mousemove", mm); document.addEventListener("mouseup", mu);
}
$("applyc").addEventListener("click", function () {
  var now; try { now = JSON.parse($("insp").value); } catch (e) { return fail({ code: "bad_json", message: e.message }); }
  var was = JSON.parse(inspBase), set = {}, n = 0;
  function isO(v) { return v && typeof v === "object" && !Array.isArray(v); }
  // update_clip merges dicts (keyframes replace), so a key removed inside one has to be sent as null
  function gone(a, b) { var o = JSON.parse(JSON.stringify(b)); Object.keys(a).forEach(function (k) { if (!(k in b)) o[k] = null; else if (isO(a[k]) && isO(b[k])) o[k] = gone(a[k], b[k]); }); return o; }
  Object.keys(now).forEach(function (k) { if (k !== "id" && JSON.stringify(now[k]) !== JSON.stringify(was[k])) { set[k] = k !== "keyframes" && isO(was[k]) && isO(now[k]) ? gone(was[k], now[k]) : now[k]; n++; } });
  Object.keys(was).forEach(function (k) { if (!(k in now)) { set[k] = null; n++; } });
  if (!n) return show("ok", "nothing changed");
  ops([{ op: "update_clip", id: sel, set: set }], "update " + sel).then(function (r) { if (r) inspBase = $("insp").value; });
});
$("delc").addEventListener("click", function () { ops([{ op: "remove_clip", id: sel }], "remove " + sel); });
$("applyo").addEventListener("click", function () {
  var l; try { l = JSON.parse($("ops").value); } catch (e) { return fail({ code: "bad_json", message: e.message }); }
  ops(Array.isArray(l) ? l : [l]);
});
function hist(kind) { api("/api/" + kind, { revision: S.revision }).then(function () { show("ok", kind + " done"); }, fail); }
$("undo").addEventListener("click", function () { hist("undo"); });
$("redo").addEventListener("click", function () { hist("redo"); });
document.addEventListener("keydown", function (e) {
  if ($("consent").open || e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return; // the dialog owns the keys while open
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); hist(e.shiftKey ? "redo" : "undo"); }
  else if (e.key === " ") { e.preventDefault(); $("play").click(); }
  else if (e.key === "ArrowLeft" || e.key === "ArrowRight") { var f = 1 / S.timeline.settings.fps * (e.shiftKey ? 10 : 1); seek(t + (e.key === "ArrowLeft" ? -f : f)); }
});

// ------------------------------------------------------------ render / contact sheet
var renderJob = null;
$("render").addEventListener("click", function () {
  $("render").disabled = true; $("out").innerHTML = "<progress id=prog max=1 value=0></progress>";
  api("/api/render", { draft: $("draft").checked }).then(function (j) { renderJob = j.id; settle(j); }, function (e) { $("render").disabled = false; $("out").innerHTML = ""; fail(e); });
});
function onJob(j) {
  if (j.id === prepJob) {
    if (j.status === "running") { $("prepare").textContent = "Preparing " + Math.round(j.progress * 100) + "%"; return; }
    prepJob = null; $("prepare").disabled = false; $("prepare").textContent = "Prepare";
    if (j.status === "failed") { if (j.error.code === "model_not_cached" && j.error.models) askDownload(j.error); else fail(j.error); } else { $("prepare").style.display = "none"; show("ok", "prepared"); requestFrame(); }
  } else if (j.id === playJob) {
    if (j.status === "running") $("play").textContent = "Preparing " + Math.round(j.progress * 100) + "%";
    else if (j.status === "failed") { playJob = null; $("play").textContent = "Play"; fail(j.error); }
    else { playJob = null; var v = $("video"); v.src = j.url; v.style.display = ""; $("frame").style.display = "none"; $("play").textContent = "Stop"; v.play(); }
  } else if (j.id === renderJob) {
    var p = $("prog"); if (p) p.value = j.progress;
    if (j.status === "failed") { renderJob = null; $("render").disabled = false; $("out").innerHTML = ""; fail(j.error); }
    if (j.status === "done") {
      renderJob = null; $("render").disabled = false; var o = $("out"); o.innerHTML = "";
      var a = document.createElement("a"); a.href = j.url; a.target = "_blank"; a.textContent = "output: " + j.result.output.split("/").pop(); o.appendChild(a);
      var info = document.createElement("div"); info.className = "mut";
      info.textContent = j.result.duration + " s, " + j.result.width + "x" + j.result.height + (j.result.loudness ? ", " + j.result.loudness.integrated_lufs + " LUFS" : "") + (j.result.warnings && j.result.warnings.length ? " · " + j.result.warnings.join("; ") : "");
      o.appendChild(info);
      if (j.sheet_url) sheetImg(j.sheet_url);
    }
  }
}
function sheetImg(url) { var i = document.createElement("img"); i.src = url; i.title = "open full size"; i.onclick = function () { window.open(url); }; $("out").appendChild(i); }
$("sheet").addEventListener("click", function () {
  $("sheet").disabled = true;
  api("/api/sheet", { count: 12 }).then(function (r) { $("out").innerHTML = ""; sheetImg(r.url); }, fail).then(function () { $("sheet").disabled = false; });
});
window.addEventListener("resize", requestFrame);
</script></body></html>
`;
