import { ops } from "./api.ts";
import { libEdit } from "./edits.ts";
import { t, type Key } from "./i18n.ts";
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
  const c = st.S && st.sel && !V().nested ? findClip(st.sel) : null;
  return (
    <div id="library">
      <div class="mut">{t("libHint")}</div>
      {Object.entries(LIB).map(([kind, names], i) => (
        <details key={kind} open={i === 0}>
          <summary>{t(("lib_" + kind) as Key)}</summary>
          <div class="lgrid">
            {names.map((name) => (
              <button key={name} class="litem" data-lib={kind + "/" + name} draggable title={name} disabled={!st.S || (!!st.S && V().nested)}
                onClick={() => applyLib(kind, name, c)} onDragStart={(e) => { e.dataTransfer!.setData(LIB_DRAG, kind + "/" + name); e.dataTransfer!.effectAllowed = "copy"; }}>
                <img src={"/api/library/" + kind + "/" + name} alt="" loading="lazy" />
                <span>{name}</span>
              </button>
            ))}
          </div>
        </details>
      ))}
      <details>
        <summary>{t("lib_template")}</summary>
        <div class="mut">{t("tplHint")}</div>
        {Object.entries(TPL).map(([name, tp]) => (
          <button key={name} class="tplitem" data-template={name} disabled={!st.S || V().nested} onClick={() => { st.template = name; changed(); }}>
            <b>{name}</b> <span class="mut">{tp.doc}</span>
          </button>
        ))}
      </details>
    </div>
  );
}
