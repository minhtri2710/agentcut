import { ops } from "./api.ts";
import { fieldValue } from "./edits.ts";
import { t, type Key } from "./i18n.ts";
import { fail } from "./messages.ts";
import { trackOf } from "./state.ts";
import type { Clip } from "./types.ts";

// build-ui.ts substitutes FORM's whole text wherever the name appears: read it once
const F = FORM;

/** fields the form leaves to the JSON tab: written by ops (group, pending, timed_for, words, tracks), keyframes (their own editor), or only meaningful when adding (preset, src) */
const SKIP = new Set(["id", "type", "group", "pending", "keyframes", "timed_for", "words", "tracks", "preset", "src"]);

/** the field's value as the input shows it: an object a list cannot show is left to the JSON tab */
const shown = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** one field edit = the update_clip the JSON tab would send for it */
function setField(c: Clip, set: Record<string, unknown>) { ops([{ op: "update_clip", id: c.id, set }], "update " + c.id); }

function commit(c: Clip, k: string, types: string[], raw: string, wrap = (v: unknown) => ({ [k]: v }) as Record<string, unknown>) {
  let v: unknown;
  try { v = fieldValue(types, raw); } catch (e) { return fail(e as { code: string; message: string }); }
  setField(c, wrap(v));
}

/** One row: a list for a field with named values, a checkbox for a boolean, else a text box. Inputs are not controlled: their key carries the value, so a new value
 *  from the project replaces the input while a redraw for anything else (the playhead, another clip) leaves what is being typed. */
function Field({ c, k, types, doc, ro, value, onSet }: { c: Clip; k: string; types: string[]; doc: string; ro: boolean; value: unknown; onSet: (raw: string) => void }) {
  const list = F.enums[k], id = "f-" + k, key = c.id + "." + k + "=" + shown(value); // another clip, or a new value, is a new input
  let input;
  if (list && (value === undefined || value === null || typeof value === "string"))
    input = <select key={key} id={id} disabled={ro} onChange={(e) => onSet(e.currentTarget.value)}>
      <option value="" selected={value === undefined || value === null}>—</option>
      {list.map((x) => <option value={x} selected={x === value}>{x}</option>)}
    </select>;
  else if (types.length === 1 && types[0] === "boolean")
    input = <input key={key} id={id} type="checkbox" disabled={ro} defaultChecked={value === true} onChange={(e) => onSet(e.currentTarget.checked ? "true" : "")} />;
  else if (types.some((x) => x === "number" || x === "string" || x === "boolean") && !(value !== null && typeof value === "object"))
    input = <input key={key} id={id} type="text" disabled={ro} defaultValue={shown(value)} spellcheck={false} onChange={(e) => onSet(e.currentTarget.value)} />;
  else input = <span class="mut">{value === undefined ? t("jsonOnly") : t("jsonEdit")}</span>; // an object or list: edited in the JSON tab
  return <label class="frow" title={doc}><span>{k}</span>{input}</label>;
}

export function ClipForm({ c, ro }: { c: Clip; ro: boolean }) {
  const magnetic = !!trackOf(c.id)?.magnetic;
  return (
    <div id="cform">
      {(F.types[c.type] || []).map(([sec, keys]) => (
        <fieldset key={sec}>
          <legend>{t(("sec_" + sec) as Key)}</legend>
          {keys.filter((k) => !SKIP.has(k)).map((k) => {
            const [types, doc] = F.fields[sec][k];
            if (sec === "media" && k === "color") { // the colour grade: one row per numeric field, merged into the grade by update_clip
              const g = (c.color && typeof c.color === "object" ? c.color : {}) as Record<string, unknown>;
              return F.grade.map(([gk, gdoc]) => (
                <Field key={"color." + gk} c={c} k={gk} types={gk === "look" ? ["string"] : ["number"]} doc={gdoc} ro={ro} value={g[gk]}
                  onSet={(raw) => commit(c, gk, gk === "look" ? ["string"] : ["number"], raw, (v) => ({ color: { [gk]: v } }))} />
              ));
            }
            return <Field key={k} c={c} k={k} types={types} doc={doc} ro={ro || (k === "start" && magnetic)} value={c[k]} onSet={(raw) => commit(c, k, types, raw)} />;
          })}
        </fieldset>
      ))}
    </div>
  );
}
