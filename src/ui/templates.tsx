import { useEffect, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Hammer, Plus } from "lucide-react";
import { stamped } from "./api.ts";
import { t } from "./i18n.ts";
import { ico, Num, numOf } from "./kit.tsx";
import { fail, show } from "./messages.ts";
import { errText } from "./text.ts";
import { changed, st } from "./state.ts";
import type { ApiError, Dict } from "./types.ts";

const fileName = (p?: string) => (p || "").split(/[\\/]/).pop() || "";
/** the project's assets of these kinds as options; a pick sends the id (a path would be read against the server's current directory first) */
const assetsOf = (...kinds: string[]) => (st.S ? Object.entries(st.S.timeline.assets).filter(([, a]) => kinds.includes(a.kind)).map(([id, a]) => ({ value: id, label: fileName(a.path) || id })) : []);
const VISUAL = ["video", "image"];
const NONE = { value: "", label: "—" };

/** what the form holds per arg: text for most kinds, picked asset ids for media, rows of {text, media} for items */
type Vals = Record<string, unknown>;
type Row = { text: string; media: string };

/** one arg's control */
function Field({ name, kind, label, val, set }: { name: string; kind: string; label: string; val: unknown; set: (v: unknown) => void }) {
  const pick = (opts: { value: string; label: string }[]) => <Selector htmlName={name} label={label} isLabelHidden size="sm" value={(val as string) || ""} options={[{ value: "", label: t("tplNoPick") }, ...opts]} onChange={(v) => set(v ?? "")} />;
  if (kind === "media") {
    const ids = (val as string[]) || [], opts = assetsOf(...VISUAL);
    return <div className="tplmedia">{opts.map((o) => ( // the picks in the list's order, not the order they were ticked
      <CheckboxInput key={o.value} data-asset={o.value} size="sm" label={o.label} value={ids.includes(o.value)} onChange={(on) => set(opts.map((x) => x.value).filter((x) => (x === o.value ? on : ids.includes(x))))} />
    ))}</div>;
  }
  if (kind === "audio") return pick(assetsOf("audio"));
  if (kind === "visual") return pick(assetsOf(...VISUAL));
  if (kind === "lines") return <TextArea htmlName={name} label={label} isLabelHidden size="sm" rows={3} value={(val as string) || ""} onChange={set} />;
  if (kind === "number") return <Num name={name} aria-label={label} min={0} step="any" value={(val as number | null) ?? ""} onChange={(e) => set(numOf(e.currentTarget))} />;
  if (kind === "text_preset" || kind === "transition") return pick(LIB[kind === "text_preset" ? "text" : "transition"].map((n) => ({ value: n, label: n })));
  if (kind === "items") {
    const rows = (val as Row[]) || [];
    const setRow = (i: number, r: Partial<Row>) => set(rows.map((x, j) => (j === i ? { ...x, ...r } : x)));
    return (
      <div className="tplitems">{rows.map((r, i) => (
        <div key={i} className="row2">
          <TextInput htmlName={name + ".text"} label={label} isLabelHidden size="sm" value={r.text} onChange={(v) => setRow(i, { text: v })} />
          <Selector htmlName={name + ".media"} label={label} isLabelHidden size="sm" value={r.media} options={[NONE, ...assetsOf(...VISUAL)]} onChange={(v) => setRow(i, { media: v ?? "" })} />
        </div>
      ))}
        <div><Button size="sm" variant="ghost" icon={ico(Plus)} label={t("tplItem")} onClick={() => set(rows.concat([{ text: "", media: "" }]))} /></div>
      </div>
    );
  }
  return <TextInput htmlName={name} label={label} isLabelHidden size="sm" hasSpellCheck={false} value={(val as string) || ""} onChange={set} />; // text, color
}

/** the form as apply_template args: only what was filled in (the op refuses a missing required arg with its message) */
function argsOf(vals: Vals, args: Dict): Dict {
  const out: Dict = {};
  for (const [k, spec] of Object.entries(args)) {
    const v = vals[k];
    if (spec.kind === "media") { if ((v as string[] | undefined)?.length) out[k] = (v as string[]).map((asset) => ({ asset })); continue; }
    if (spec.kind === "items") {
      const items = ((v as Row[]) || []).map((x) => ({ text: x.text.trim(), media: x.media })).filter((x) => x.text || x.media).map((x) => ({ text: x.text, ...(x.media ? { media: { asset: x.media } } : {}) }));
      if (items.length) out[k] = items;
      continue;
    }
    if (spec.kind === "number") { if (typeof v === "number") out[k] = v; continue; }
    const s = String(v ?? "").trim();
    if (s) out[k] = spec.kind === "lines" ? s.split("\n").map((x) => x.trim()).filter(Boolean) : s;
  }
  return out;
}

const fresh = (args: Dict): Vals => Object.fromEntries(Object.entries(args).filter(([, s]) => s.kind === "items").map(([k]) => [k, Array.from({ length: 3 }, () => ({ text: "", media: "" }))]));

export function TemplateDialog() {
  const name = st.template, tp = name ? TPL[name] : null;
  const [vals, setVals] = useState<Vals>({}), [err, setErr] = useState("");
  useEffect(() => { if (tp) { setVals(fresh(tp.args)); setErr(""); } }, [name]);
  const close = () => { st.template = null; changed(); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name || !tp) return;
    stamped("/api/ops", { ops: [{ op: "apply_template", name, ...argsOf(vals, tp.args) }], label: "template " + name }).then((r) => {
      show("ok", t("applied", r.revision) + (r.errors ? t("errorsRemain", r.errors) : ""));
      close();
    }, (x: ApiError) => { fail(x); setErr(errText(x)); }); // the modal hides the status line: the error shows in the form too
  };
  return (
    <Dialog id="tpl" isOpen={!!tp} onOpenChange={(o) => { if (!o) close(); }} purpose="form" width={560}>
      {tp && <DialogHeader title={name} subtitle={tp.doc} onOpenChange={(o) => { if (!o) close(); }} />}
      {tp && (
        <form className="eform" key={name} onSubmit={submit}>
          {Object.entries(tp.args).map(([k, spec]) => (
            <div key={k} className="targ" data-arg={k}>
              <div className="tlabel"><b>{spec.required ? t("tplRequired", k) : k}</b> <span className="mut">{spec.doc}</span></div>
              <Field name={k} kind={spec.kind} label={k} val={vals[k]} set={(v) => setVals((o) => ({ ...o, [k]: v }))} />
            </div>
          ))}
          {err && <div id="terr" role="alert"><Banner status="error" title={err} collapsible={false} /></div>}
          <div className="dactions">
            <Button label={t("cancel")} onClick={close} />
            <Button id="tgo" type="submit" variant="primary" icon={ico(Hammer)} label={t("tplApply")} />
          </div>
        </form>
      )}
    </Dialog>
  );
}
