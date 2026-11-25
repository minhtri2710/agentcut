import { useLayoutEffect, useState } from "preact/hooks";
import { stamped } from "./api.ts";
import { t } from "./i18n.ts";
import { fail, show } from "./messages.ts";
import { errText } from "./text.ts";
import { $, changed, st } from "./state.ts";
import type { ApiError, Dict } from "./types.ts";

const fileName = (p?: string) => (p || "").split(/[\\/]/).pop() || "";
/** the project's assets of these kinds, as [id, path]; a pick sends the id (a path would be read against the server's current directory first) */
const assetsOf = (...kinds: string[]) => (st.S ? Object.entries(st.S.timeline.assets).filter(([, a]) => kinds.includes(a.kind)).map(([id, a]) => [id, a.path] as [string, string]) : []);
const VISUAL = ["video", "image"];

/** one arg's control; its name is the arg's (items: one text + one media per row) */
function Field({ name, kind, rows }: { name: string; kind: string; rows: number }) {
  const pick = (kinds: string[]) => <select name={name}><option value="">{t("tplNoPick")}</option>{assetsOf(...kinds).map(([id, path]) => <option value={id}>{fileName(path) || id}</option>)}</select>;
  if (kind === "media") return <div class="tplmedia">{assetsOf(...VISUAL).map(([id, path]) => <label class="row"><input type="checkbox" name={name} value={id} /> {fileName(path) || id}</label>)}</div>;
  if (kind === "audio") return pick(["audio"]);
  if (kind === "visual") return pick(VISUAL);
  if (kind === "lines") return <textarea name={name} rows={3} />;
  if (kind === "number") return <input name={name} type="number" step="any" min="0" />;
  if (kind === "text_preset" || kind === "transition") return <select name={name}><option value="" />{LIB[kind === "text_preset" ? "text" : "transition"].map((n) => <option value={n}>{n}</option>)}</select>;
  if (kind === "items") return (
    <div class="tplitems">{Array.from({ length: rows }, () => (
      <div class="row"><input name={name + ".text"} /><select name={name + ".media"}><option value="" />{assetsOf(...VISUAL).map(([id, path]) => <option value={id}>{fileName(path) || id}</option>)}</select></div>
    ))}</div>
  );
  return <input name={name} spellcheck={false} />; // text, color
}

/** the form as apply_template args: only what was filled in (the op refuses a missing required arg with its message) */
function argsOf(form: HTMLFormElement, args: Dict): Dict {
  const fd = new FormData(form), out: Dict = {};
  for (const [k, spec] of Object.entries(args)) {
    if (spec.kind === "media") { const ids = fd.getAll(k).map(String); if (ids.length) out[k] = ids.map((asset) => ({ asset })); continue; }
    if (spec.kind === "items") {
      const texts = fd.getAll(k + ".text").map((x) => String(x).trim()), media = fd.getAll(k + ".media").map(String);
      const items = texts.map((text, i) => ({ text, media: media[i] })).filter((x) => x.text || x.media).map((x) => ({ text: x.text, ...(x.media ? { media: { asset: x.media } } : {}) }));
      if (items.length) out[k] = items;
      continue;
    }
    const v = String(fd.get(k) ?? "").trim();
    if (!v) continue;
    out[k] = spec.kind === "number" ? Number(v) : spec.kind === "lines" ? v.split("\n").map((x) => x.trim()).filter(Boolean) : v;
  }
  return out;
}

export function TemplateDialog() {
  const [rows, setRows] = useState(3), [err, setErr] = useState("");
  useLayoutEffect(() => { const d = $<HTMLDialogElement>("tpl"); if (st.template && !d.open) { setRows(3); setErr(""); d.showModal(); } }, [st.template]);
  const name = st.template, tp = name ? TPL[name] : null;
  const submit = (e: Event) => {
    e.preventDefault();
    if (!name || !tp) return;
    stamped("/api/ops", { ops: [{ op: "apply_template", name, ...argsOf(e.currentTarget as HTMLFormElement, tp.args) }], label: "template " + name }).then((r) => {
      show("ok", t("applied", r.revision) + (r.errors ? t("errorsRemain", r.errors) : ""));
      $<HTMLDialogElement>("tpl").close();
    }, (x: ApiError) => { fail(x); setErr(errText(x)); }); // the modal hides the status line: the error shows in the form too
  };
  return (
    <dialog id="tpl" aria-labelledby="ttitle" onClose={() => { st.template = null; changed(); }}>
      {tp && (
        <form class="eform" key={name} onSubmit={submit}>
          <p id="ttitle"><b>{name}</b> <span class="mut">{tp.doc}</span></p>
          {Object.entries(tp.args).map(([k, spec]) => {
            const Box = spec.kind === "media" || spec.kind === "items" ? "div" : "label"; // a group of controls is not one label's
            return (
              <Box class="targ" data-arg={k}>
                <span>{spec.required ? t("tplRequired", k) : k} <span class="mut">{spec.doc}</span></span>
                <Field name={k} kind={spec.kind} rows={rows} />
                {spec.kind === "items" && <button type="button" onClick={() => setRows(rows + 1)}>{t("tplItem")}</button>}
              </Box>
            );
          })}
          {err && <p id="terr" role="alert">{err}</p>}
          <div><button id="tgo" class="primary">{t("tplApply")}</button> <button type="button" onClick={() => $<HTMLDialogElement>("tpl").close()}>{t("cancel")}</button></div>
        </form>
      )}
    </dialog>
  );
}
