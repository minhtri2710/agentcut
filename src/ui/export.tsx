import { useLayoutEffect } from "preact/hooks";
import { t } from "./i18n.ts";
import { startRender } from "./jobs.ts";
import { $, changed, st } from "./state.ts";
import type { Dict } from "./types.ts";
import { seek } from "./viewer.tsx";

/** what the export dialog offers; the server checks the same list (ui.ts EXPORT_FORMATS) */
const FORMATS = [".mp4", ".mov", ".webm", ".mkv", ".gif", ".wav", ".mp3", ".m4a", ".flac", ".png", ".webp"];
const SUBTITLED = [".mp4", ".mov", ".mkv", ".webm"];

export function openExport() { st.exporting = true; changed(); }

/** the dialog's fields as the render request: only what was set (an empty range field is the timeline's start or end) */
function submit(e: Event) {
  e.preventDefault();
  const f = (e.currentTarget as HTMLFormElement).elements, v = (n: string) => (f.namedItem(n) as HTMLInputElement | HTMLSelectElement).value;
  const opts: Dict = { format: v("format"), quality: v("quality") };
  if (v("format") === ".mp4" && v("codec")) opts.codec = v("codec");
  if (v("start")) opts.start = +v("start");
  if (v("end")) opts.end = +v("end");
  if (SUBTITLED.includes(v("format")) && (f.namedItem("subtitles") as HTMLInputElement).checked) opts.subtitles = true;
  $<HTMLDialogElement>("export").close();
  startRender(opts);
}

export function ExportDialog() {
  useLayoutEffect(() => { const d = $<HTMLDialogElement>("export"); if (st.exporting && !d.open) d.showModal(); }, [st.exporting]);
  return (
    <dialog id="export" aria-labelledby="etitle" onClose={() => { st.exporting = false; changed(); }}>
      <form class="eform" onSubmit={submit}>
        <p id="etitle"><b>{t("exportTitle")}</b></p>
        <label>{t("format")}<select name="format">{FORMATS.map((x) => <option value={x}>{x.slice(1)}</option>)}</select></label>
        <label>{t("codec")}<select name="codec"><option value="">h264</option><option value="hevc">hevc</option></select></label>
        <label>{t("quality")}<select name="quality"><option value="standard">standard</option><option value="high">high</option><option value="draft">draft</option></select></label>
        <label>{t("from")}<input name="start" type="number" min="0" step="0.1" placeholder="0" /></label>
        <label>{t("to")}<input name="end" type="number" min="0" step="0.1" placeholder={st.S ? st.S.duration.toFixed(2) : ""} /></label>
        <label class="row"><input name="subtitles" type="checkbox" /> {t("subtitles")}</label>
        <div><button id="ego" class="primary">{t("exportGo")}</button> <button type="button" onClick={() => $<HTMLDialogElement>("export").close()}>{t("cancel")}</button></div>
      </form>
    </dialog>
  );
}

/** a render's result: the file, its facts, the QA of the written file (issues with a time seek there) and the contact sheet */
export function Out() {
  const o = st.out, r = o && o.result, qa = r && r.qa;
  return (
    <div id="out">
      {o && o.progress !== undefined && <progress id="prog" max={1} value={o.progress} />}
      {r && [
        <a href={o!.url} target="_blank">{t("output", String(r.output).split(/[\\/]/).pop()!)}</a>,
        <div class="mut">{[r.duration !== undefined && r.duration + " s", r.width && r.width + "x" + r.height, r.loudness && r.loudness.integrated_lufs + " LUFS"].filter(Boolean).join(", ")
          + (r.warnings && r.warnings.length ? " · " + r.warnings.join("; ") : "")}</div>,
      ]}
      {qa && (qa.ok ? <div id="qa" class="qaok">{t("qaOk")}</div> : (
        <ul id="qa">
          {qa.issues.map((i: Dict) => <li>{"[" + i.type + "] " + i.message + " "}{i.t !== undefined && <button onClick={() => seek(i.t)}>{t("seekTo", i.t.toFixed(2))}</button>}</li>)}
        </ul>
      ))}
      {r && r.qa_error && <div class="mut">{r.qa_error}</div>}
      {o && o.sheet && <img src={o.sheet} title={t("openFull")} onClick={() => { window.open(o.sheet); }} />}
    </div>
  );
}
