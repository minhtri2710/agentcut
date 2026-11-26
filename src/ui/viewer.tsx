import { Button } from "@astryxdesign/core/Button";
import { clock } from "./view.ts";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Maximize, Pause, Play, Sparkles, StepBack, StepForward } from "lucide-react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { fail } from "./messages.ts";
import { settle, startPrepare } from "./jobs.ts";
import { ico } from "./kit.tsx";
import { $, changed, LABEL, st, total } from "./state.ts";
import { frameFailText, frameScale, prepareText } from "./text.ts";
import type { Job } from "./types.ts";

let want: number | null = null, busy = false, deb = 0, playStart = 0;

export function seek(x: number) { stopPlay(); st.t = Math.max(0, Math.min(total(), x)); changed(); requestFrame(); }

/** latest-wins frame fetch: at most one request in flight, debounced while scrubbing */
export function requestFrame() { clearTimeout(deb); deb = window.setTimeout(() => { want = st.t; pump(); }, 60); }

// #frame and #vstat are written here, not drawn from st: a blob URL is swapped per frame, and the state line must show again when it repeats.
function pump() {
  if (busy || want === null || !st.S) return;
  if (!(total() > 0)) { want = null; return; } // an empty timeline has no frame: the server would refuse it
  const set = st.S.timeline.settings, box = $("stage").getBoundingClientRect();
  const scale = frameScale(box.width, box.height, set.width, set.height, window.devicePixelRatio);
  const at = Math.min(want, Math.max(0, total() - 1 / set.fps)); // the server refuses t at or past the duration: the playhead at the end shows the last frame
  const url = "/api/frame?t=" + at.toFixed(3) + "&scale=" + scale + "&rev=" + st.S.revision;
  want = null; busy = true;
  const t0 = performance.now(), frame = $<HTMLImageElement>("frame");
  fetch(url).then((r) => { if (!r.ok) return r.json().then((j) => { throw j.error; }); return r.blob(); }).then((b) => {
    const old = frame.src;
    frame.src = URL.createObjectURL(b); frame.classList.remove("none"); if (old.indexOf("blob:") === 0) URL.revokeObjectURL(old);
    $("vstat").textContent = t("msPerFrame", Math.round(performance.now() - t0));
    if (!st.prep && st.needPrepare) { st.needPrepare = false; changed(); }
  }, (e) => {
    frame.classList.add("none"); // no frame for this revision: no stale or empty picture, the state text says why
    $("vstat").textContent = frameFailText(e);
    if (e && e.code === "not_prepared") { st.needPrepare = true; changed(); }
  }).then(() => { busy = false; pump(); });
}

export function stopPlay() {
  if (!st.playing) return;
  $<HTMLVideoElement>("video").pause(); st.playing = false; changed(); requestFrame();
}

/** play = draft-render [playhead, end of the visible range] once per revision, then play it in <video> */
function play() {
  if (st.playing) { stopPlay(); return; }
  const sc = $("scroll"), end = Math.min(total(), Math.max(st.t + 1, (sc.scrollLeft + sc.clientWidth - LABEL) / st.pps));
  playStart = st.t; st.play = { pct: null }; changed();
  api("/api/render", { play: true, start: st.t, end }).then((j) => { st.playJob = j.id; settle(j as Job); }, (e) => { st.play = null; changed(); fail(e); });
}

const playLabel = () => (st.playing ? t("stop") : !st.play ? t("play") : st.play.pct === null ? t("preparing") : t("preparingPct", st.play.pct));
const prepLabel = () => (st.prep === "starting" ? t("preparing") : st.prep ? prepareText(st.prep) : t("prepare"));
const step = (n: number) => { if (st.S) seek(st.t + n / st.S.timeline.settings.fps); };
const fullScreen = () => { const s = $("stage"); if (document.fullscreenElement) document.exitFullscreen(); else s.requestFullscreen?.().catch(() => {}); };

export function Viewer() {
  const set = st.S?.timeline.settings, empty = !!st.S && !(total() > 0), fps = set ? set.fps : 30;
  return (
    <section id="viewer">
      <div className="vhead"><span>{t("player")}</span><span className="grow" /><span className="mono">{set ? set.width + "×" + set.height + " · " + set.fps + " fps" : ""}</span></div>
      <div id="stage">
        <img id="frame" className="none" alt="preview" style={{ display: st.playing ? "none" : "", aspectRatio: set ? set.width + "/" + set.height : "" }} />
        <video id="video" controls style={{ display: st.playing ? "" : "none" }}
          onTimeUpdate={(e) => { st.t = playStart + e.currentTarget.currentTime; changed(); }} onEnded={stopPlay} />
        {empty && <div className="vempty"><b>{t("emptyTitle")}</b><span>{t("emptyHint")}</span></div>}
        <div className="mut" id="vstat"></div>
      </div>
      <div id="vbar">
        <span className="vtime mono" aria-hidden="true"><b>{clock(st.t, fps)}</b><span className="mut"> / {clock(total(), fps)}</span></span>
        <span className="vctl">
          <IconButton size="sm" variant="ghost" label={t("prevFrame")} tooltip={t("prevFrame")} icon={ico(StepBack)} isDisabled={empty} onClick={() => step(-1)} />
          <Button id="play" size="sm" variant={st.playing ? "secondary" : "primary"} icon={ico(st.playing ? Pause : Play)} label={playLabel()} isDisabled={empty} onClick={play} />
          <IconButton size="sm" variant="ghost" label={t("nextFrame")} tooltip={t("nextFrame")} icon={ico(StepForward)} isDisabled={empty} onClick={() => step(1)} />
        </span>
        <span className="vright">
          <Button id="prepare" size="sm" icon={ico(Sparkles)} label={prepLabel()} style={{ display: st.needPrepare || st.prep ? "" : "none" }} isDisabled={!!st.prep} onClick={() => startPrepare(false)} />
          <span id="time" className="mono mut">{st.t.toFixed(2) + " s"}</span>
          <IconButton size="sm" variant="ghost" label={t("fullScreen")} tooltip={t("fullScreen")} icon={ico(Maximize)} onClick={fullScreen} />
        </span>
      </div>
    </section>
  );
}
