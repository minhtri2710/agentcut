import { api } from "./api.ts";
import { fail, show } from "./messages.ts";
import { $, st } from "./state.ts";
import { prepareText } from "./text.ts";
import type { ApiError, Job } from "./types.ts";
import { requestFrame } from "./viewer.ts";

/** newest SSE event per job id: a job can settle before its POST response resolves, and the POST body is only the snapshot at start */
const lastJob: Record<string, Job> = {};
let consentErr: ApiError | null = null;

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
function startPrepare(allowDownload: boolean) {
  const b = $<HTMLButtonElement>("prepare");
  b.disabled = true; b.textContent = "Preparing…";
  api("/api/prepare", allowDownload ? { allow_download: true } : {}).then((j) => { st.prepJob = j.id; settle(j as Job); }, (e) => { b.disabled = false; b.textContent = "Prepare"; fail(e); });
}

/** a missing model is downloaded only after a click here: Cancel and Escape show the failure instead, and nothing retries by itself */
function askDownload(err: ApiError) {
  consentErr = err;
  const d = $<HTMLDialogElement>("consent"), l = $("clist");
  l.innerHTML = "";
  err.models!.forEach((m) => { const li = document.createElement("li"); li.textContent = m.model + " (~" + m.approx_mb + " MB)"; l.appendChild(li); });
  d.returnValue = ""; d.showModal(); $("cgo").focus();
}

function onJob(j: Job) {
  if (j.id === st.prepJob) {
    const b = $<HTMLButtonElement>("prepare");
    if (j.status === "running") { b.textContent = prepareText(j); return; }
    st.prepJob = null; b.disabled = false; b.textContent = "Prepare";
    if (j.status === "failed" || j.status === "cancelled") { if (j.error!.code === "model_not_cached" && j.error!.models) askDownload(j.error!); else fail(j.error!); }
    else { b.style.display = "none"; show("ok", "prepared"); requestFrame(); }
  } else if (j.id === st.playJob) {
    if (j.status === "running") $("play").textContent = "Preparing " + Math.round(j.progress * 100) + "%";
    else if (j.status === "failed" || j.status === "cancelled") { st.playJob = null; $("play").textContent = "Play"; fail(j.error!); }
    else {
      st.playJob = null;
      const v = $<HTMLVideoElement>("video");
      v.src = j.url!; v.style.display = ""; $("frame").style.display = "none"; $("play").textContent = "Stop";
      v.play().catch((e) => { if (e.name !== "AbortError") fail(e); }); // a stop right after the start interrupts play()
    }
  } else if (j.id === st.renderJob) {
    const p = $<HTMLProgressElement>("prog");
    if (p) p.value = j.progress;
    const render = $<HTMLButtonElement>("render");
    if (j.status === "failed" || j.status === "cancelled") { st.renderJob = null; render.disabled = false; $("out").innerHTML = ""; fail(j.error!); }
    if (j.status === "done") {
      st.renderJob = null; render.disabled = false;
      const o = $("out"), r = j.result!;
      o.innerHTML = "";
      const a = document.createElement("a"); a.href = j.url!; a.target = "_blank"; a.textContent = "output: " + r.output.split("/").pop(); o.appendChild(a);
      const info = document.createElement("div"); info.className = "mut";
      info.textContent = r.duration + " s, " + r.width + "x" + r.height + (r.loudness ? ", " + r.loudness.integrated_lufs + " LUFS" : "") + (r.warnings && r.warnings.length ? " · " + r.warnings.join("; ") : "");
      o.appendChild(info);
      if (j.sheet_url) sheetImg(j.sheet_url);
    }
  }
}

function sheetImg(url: string) {
  const i = document.createElement("img");
  i.src = url; i.title = "open full size"; i.onclick = () => { window.open(url); };
  $("out").appendChild(i);
}

export function initJobs() {
  $("prepare").addEventListener("click", () => { startPrepare(false); });
  $("cgo").addEventListener("click", () => { $<HTMLDialogElement>("consent").close("go"); });
  $("cno").addEventListener("click", () => { $<HTMLDialogElement>("consent").close("no"); });
  $("consent").addEventListener("close", () => { if ($<HTMLDialogElement>("consent").returnValue === "go") startPrepare(true); else fail(consentErr!); });
  $("render").addEventListener("click", () => {
    const b = $<HTMLButtonElement>("render");
    b.disabled = true; $("out").innerHTML = "<progress id=prog max=1 value=0></progress>";
    api("/api/render", { draft: $<HTMLInputElement>("draft").checked }).then((j) => { st.renderJob = j.id; settle(j as Job); }, (e) => { b.disabled = false; $("out").innerHTML = ""; fail(e); });
  });
  $("sheet").addEventListener("click", () => {
    const b = $<HTMLButtonElement>("sheet");
    b.disabled = true;
    api("/api/sheet", { count: 12 }).then((r) => { $("out").innerHTML = ""; sheetImg(r.url); }, fail).then(() => { b.disabled = false; });
  });
}
