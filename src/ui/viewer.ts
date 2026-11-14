import { api } from "./api.ts";
import { fail } from "./messages.ts";
import { settle } from "./jobs.ts";
import { $, LABEL, st, total } from "./state.ts";
import { frameFailText, frameScale } from "./text.ts";
import { movePlayhead } from "./timeline.ts";

let want: number | null = null, busy = false, deb = 0, playStart = 0;

export function seek(x: number) { stopPlay(); st.t = Math.max(0, Math.min(total(), x)); movePlayhead(); requestFrame(); }

/** latest-wins frame fetch: at most one request in flight, debounced while scrubbing */
export function requestFrame() { clearTimeout(deb); deb = window.setTimeout(() => { want = st.t; pump(); }, 60); }

function pump() {
  if (busy || want === null || !st.S) return;
  if (!(total() > 0)) { want = null; return; } // an empty timeline has no frame: the server would refuse it
  const set = st.S.timeline.settings, box = $("viewer").getBoundingClientRect();
  const scale = frameScale(box.width, box.height, set.width, set.height, window.devicePixelRatio);
  const at = Math.min(want, Math.max(0, total() - 1 / set.fps)); // the server refuses t at or past the duration: the playhead at the end shows the last frame
  const url = "/api/frame?t=" + at.toFixed(3) + "&scale=" + scale + "&rev=" + st.S.revision;
  want = null; busy = true;
  const t0 = performance.now(), frame = $<HTMLImageElement>("frame");
  fetch(url).then((r) => { if (!r.ok) return r.json().then((j) => { throw j.error; }); return r.blob(); }).then((b) => {
    const old = frame.src;
    frame.src = URL.createObjectURL(b); frame.classList.remove("none"); if (old.indexOf("blob:") === 0) URL.revokeObjectURL(old);
    $("vstat").textContent = Math.round(performance.now() - t0) + " ms/frame"; if (!st.prepJob) $("prepare").style.display = "none";
  }, (e) => {
    frame.classList.add("none"); // no frame for this revision: no stale or empty picture, the state text says why
    $("vstat").textContent = frameFailText(e);
    if (e && e.code === "not_prepared") $("prepare").style.display = "";
  }).then(() => { busy = false; pump(); });
}

export function stopPlay() {
  const v = $<HTMLVideoElement>("video");
  if (v.style.display === "none") return;
  v.pause(); v.style.display = "none"; $("frame").style.display = ""; $("play").textContent = "Play"; requestFrame();
}

export function initViewer() {
  // play = draft-render [playhead, end of the visible range] once per revision, then play it in <video>
  $("play").addEventListener("click", () => {
    if ($("video").style.display !== "none") { stopPlay(); return; }
    const sc = $("scroll"), end = Math.min(total(), Math.max(st.t + 1, (sc.scrollLeft + sc.clientWidth - LABEL) / st.pps));
    playStart = st.t; $("play").textContent = "Preparing…";
    api("/api/render", { play: true, start: st.t, end }).then((j) => { st.playJob = j.id; settle(j as any); }, (e) => { $("play").textContent = "Play"; fail(e); });
  });
  const v = $<HTMLVideoElement>("video");
  v.addEventListener("timeupdate", () => { st.t = playStart + v.currentTime; movePlayhead(); });
  v.addEventListener("ended", stopPlay);
  window.addEventListener("resize", requestFrame);
}
