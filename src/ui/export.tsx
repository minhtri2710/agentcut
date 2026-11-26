import { useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Selector } from "@astryxdesign/core/Selector";
import { Download, ExternalLink } from "lucide-react";
import { t } from "./i18n.ts";
import { startRender } from "./jobs.ts";
import { ico, Num, numOf } from "./kit.tsx";
import { changed, st } from "./state.ts";
import type { Dict } from "./types.ts";
import { seek } from "./viewer.tsx";

/** what the export dialog offers; the server checks the same list (ui.ts EXPORT_FORMATS) */
const FORMATS = [".mp4", ".mov", ".webm", ".mkv", ".gif", ".wav", ".mp3", ".m4a", ".flac", ".png", ".webp"];
const SUBTITLED = [".mp4", ".mov", ".mkv", ".webm"];

export function openExport() { st.exporting = true; changed(); }
const close = () => { st.exporting = false; changed(); };

/** the dialog's fields as the render request: only what was set (an empty range field is the timeline's start or end) */
function request(f: { format: string; codec: string; quality: string; from: number | null; to: number | null; subs: boolean }): Dict {
  const opts: Dict = { format: f.format, quality: f.quality };
  if (f.format === ".mp4" && f.codec) opts.codec = f.codec;
  if (f.from !== null) opts.start = f.from;
  if (f.to !== null) opts.end = f.to;
  if (SUBTITLED.includes(f.format) && f.subs) opts.subtitles = true;
  return opts;
}

export function ExportDialog() {
  const [format, setFormat] = useState(".mp4"), [codec, setCodec] = useState(""), [quality, setQuality] = useState("standard");
  const [from, setFrom] = useState<number | null>(null), [to, setTo] = useState<number | null>(null), [subs, setSubs] = useState(false);
  return (
    <Dialog id="export" isOpen={st.exporting} onOpenChange={(o) => { if (!o) close(); }} purpose="form" width={460}>
      <DialogHeader title={t("exportTitle")} onOpenChange={(o) => { if (!o) close(); }} />
      <form className="eform" onSubmit={(e) => { e.preventDefault(); close(); startRender(request({ format, codec, quality, from, to, subs })); }}>
        <Selector id="eformat" label={t("format")} value={format} onChange={(x) => setFormat(x!)} options={FORMATS.map((x) => ({ value: x, label: x.slice(1) }))} />
        <div className="row2">
          <Selector id="ecodec" label={t("codec")} value={codec} isDisabled={format !== ".mp4"} onChange={(x) => setCodec(x!)} options={[{ value: "", label: "h264" }, { value: "hevc", label: "hevc" }]} />
          <Selector id="equality" label={t("quality")} value={quality} onChange={(x) => setQuality(x!)} options={["standard", "high", "draft"]} />
        </div>
        <div className="row2">
          <label className="nfield">{t("from")}<Num id="efrom" min={0} step="any" placeholder="0" value={from ?? ""} onChange={(e) => setFrom(numOf(e.currentTarget))} /></label>
          <label className="nfield">{t("to")}<Num id="eto" min={0} step="any" placeholder={st.S ? st.S.duration.toFixed(2) : ""} value={to ?? ""} onChange={(e) => setTo(numOf(e.currentTarget))} /></label>
        </div>
        <CheckboxInput id="esubs" label={t("subtitles")} value={subs} isDisabled={!SUBTITLED.includes(format)} onChange={setSubs} />
        <div className="dactions">
          <Button label={t("cancel")} onClick={close} />
          <Button id="ego" type="submit" variant="primary" icon={ico(Download)} label={t("exportGo")} />
        </div>
      </form>
    </Dialog>
  );
}

/** a render's result: the file, its facts, the QA of the written file (issues with a time seek there) and the contact sheet */
export function Out() {
  const o = st.out, r = o && o.result, qa = r && r.qa;
  if (!o) return <div id="out" />;
  return (
    <div id="out" className="isec">
      {o.progress !== undefined && <ProgressBar id="prog" label={t("render")} max={1} value={o.progress} hasValueLabel />}
      {r && (
        <div className="outfile">
          <a href={o.url} target="_blank" rel="noreferrer">{ico(ExternalLink)} {t("output", String(r.output).split(/[\\/]/).pop()!)}</a>
          <div className="mut">{[r.duration !== undefined && r.duration + " s", r.width && r.width + "x" + r.height, r.loudness && r.loudness.integrated_lufs + " LUFS"].filter(Boolean).join(", ")
            + (r.warnings && r.warnings.length ? " · " + r.warnings.join("; ") : "")}</div>
        </div>
      )}
      {qa && (qa.ok ? <div id="qa" className="qaok"><Banner status="success" title={t("qaOk")} collapsible={false} /></div> : (
        <ul id="qa">
          {qa.issues.map((i: Dict, n: number) => (
            <li key={n}>{"[" + i.type + "] " + i.message + " "}{i.t !== undefined && <Button size="sm" variant="ghost" label={t("seekTo", i.t.toFixed(2))} onClick={() => seek(i.t)} />}</li>
          ))}
        </ul>
      ))}
      {r && r.qa_error && <div className="mut">{r.qa_error}</div>}
      {o.sheet && <img src={o.sheet} title={t("openFull")} alt="" onClick={() => { window.open(o.sheet); }} />}
    </div>
  );
}
