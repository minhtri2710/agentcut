import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Item } from "@astryxdesign/core/Item";
import { LayoutTemplate } from "lucide-react";
import { ops } from "./api.ts";
import { libEdit } from "./edits.ts";
import { t, type Key } from "./i18n.ts";
import { ico } from "./kit.tsx";
import { fail } from "./messages.ts";
import { changed, findClip, st, V } from "./state.ts";
import type { Clip } from "./types.ts";

/** the drag type that carries "kind/name" of a library item to a clip or a lane */
export const LIB_DRAG = "application/x-agentcut-library";

/** put a library item on clip c (null: nothing selected), or say it does not go there */
export function applyLib(kind: string, name: string, c: Clip | null) {
  const op = libEdit(kind, name, c);
  if (!op) return fail({ code: "bad_target", message: t(c ? "libNotFor" : "libPick", name, c ? c.type : "") });
  ops([op], kind + " " + name + (c ? " on " + c.id : ""));
}

export function Library() {
  const c = st.S && st.sel && !V().nested ? findClip(st.sel) : null, off = !st.S || V().nested;
  return (
    <div id="library" className="pbody">
      <div className="mut">{t("libHint")}</div>
      {Object.entries(LIB).map(([kind, names], i) => (
        <Collapsible key={kind} trigger={<span className="ihead">{t(("lib_" + kind) as Key)} <span className="mut">{names.length}</span></span>} defaultIsOpen={i === 0}>
          <div className="lgrid">
            {names.map((name) => (
              <button key={name} type="button" className="litem" data-lib={kind + "/" + name} draggable title={name} disabled={off}
                onClick={() => applyLib(kind, name, c)} onDragStart={(e) => { e.dataTransfer.setData(LIB_DRAG, kind + "/" + name); e.dataTransfer.effectAllowed = "copy"; }}>
                <img src={"/api/library/" + kind + "/" + name} alt="" loading="lazy" />
                <span>{name}</span>
              </button>
            ))}
          </div>
        </Collapsible>
      ))}
      <Collapsible trigger={<span className="ihead">{t("lib_template")} <span className="mut">{Object.keys(TPL).length}</span></span>} defaultIsOpen={false}>
        <div className="mut">{t("tplHint")}</div>
        <div className="tpllist">
          {Object.entries(TPL).map(([name, tp]) => (
            <Item key={name} data-template={name} density="compact" startContent={ico(LayoutTemplate)} label={name} description={tp.doc} descriptionLines={2}
              isDisabled={off} onClick={() => { st.template = name; changed(); }} />
          ))}
        </div>
      </Collapsible>
    </div>
  );
}
