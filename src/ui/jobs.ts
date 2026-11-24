import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { fail, show } from "./messages.ts";
import { $, changed, st } from "./state.ts";
import type { Job } from "./types.ts";
import { requestFrame } from "./viewer.tsx";

/** newest SSE event per job id: a job can settle before its POST response resolves, and the POST body is only the snapshot at start */
const lastJob: Record<string, Job> = {};

/** a "job" event from the server */
export function onJobEvent(j: Job) {
  lastJob[j.id] = j;
  const ids = Object.keys(lastJob);
  if (ids.length > 16) delete lastJob[ids[0]];
  onJob(j);
}
/** the POST that started a job answered: act on the newest news of it */
export function settle(j: Job) { const k = lastJob[j.id] || j; delete lastJob[j.id]; onJob(k); }

/** run prepare (mattes, vision analyses, pending requests) as a server job; the viewer redraws when it is done */
export function startPrepare(allowDownload: boolean) {
  st.prep = "starting"; changed();
  api("/api/prepare", allowDownload ? { allow_download: true } : {}).then((j) => { st.prepJob = j.id; settle(j as Job); }, (e) => { st.prep = null; changed(); fail(e); });
}

export function startRender() {
  st.rendering = true; st.out = { progress: 0 }; changed();
  api("/api/render", { draft: $<HTMLInputElement>("draft").checked }).then((j) => { st.renderJob = j.id; settle(j as Job); }, (e) => { st.rendering = false; st.out = null; changed(); fail(e); });
}

export function startSheet() {
  st.sheeting = true; changed();
  api("/api/sheet", { count: 12 }).then((r) => { st.out = { sheet: r.url }; }, fail).then(() => { st.sheeting = false; changed(); });
}

function onJob(j: Job) {
  if (j.id === st.prepJob) {
    if (j.status === "running") { st.prep = j; changed(); return; }
    st.prepJob = null; st.prep = null;
    // a missing model is downloaded only after a click in the dialog (st.consent): Cancel and Escape show the failure instead, and nothing retries by itself
    if (j.status === "failed" || j.status === "cancelled") { if (j.error!.code === "model_not_cached" && j.error!.models) st.consent = j.error!; else fail(j.error!); }
    else { st.needPrepare = false; show("ok", t("prepared")); requestFrame(); }
    changed();
  } else if (j.id === st.playJob) {
    if (j.status === "running") st.play = { pct: Math.round(j.progress * 100) };
    else if (j.status === "failed" || j.status === "cancelled") { st.playJob = null; st.play = null; fail(j.error!); }
    else {
      st.playJob = null; st.play = null; st.playing = true;
      const v = $<HTMLVideoElement>("video");
      v.src = j.url!;
      v.play().catch((e) => { if (e.name !== "AbortError") fail(e); }); // a stop right after the start interrupts play()
    }
    changed();
  } else if (j.id === st.renderJob) {
    if (j.status === "running") st.out = { progress: j.progress };
    else if (j.status === "failed" || j.status === "cancelled") { st.renderJob = null; st.rendering = false; st.out = null; fail(j.error!); }
    else {
      const r = j.result!;
      st.renderJob = null; st.rendering = false;
      st.out = {
        link: { url: j.url!, name: r.output.split("/").pop(), info: r.duration + " s, " + r.width + "x" + r.height + (r.loudness ? ", " + r.loudness.integrated_lufs + " LUFS" : "") + (r.warnings && r.warnings.length ? " · " + r.warnings.join("; ") : "") },
        sheet: j.sheet_url,
      };
    }
    changed();
  }
}
