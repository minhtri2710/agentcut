import { fail, NO_STATE, show } from "./messages.ts";
import { t } from "./i18n.ts";
import { st } from "./state.ts";
import type { Dict, Op } from "./types.ts";

/** POST JSON; resolves with the body when it says ok, rejects with its error */
export function api(path: string, body?: Dict): Promise<Dict> {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).then((j) => { if (!j.ok) throw j.error || { message: "request failed" }; return j; });
}

/** POST carrying the revision this page shows: if an agent saved meanwhile the server answers "conflict". Before the first state there is no revision: rejects with NO_STATE and sends nothing. */
export function stamped(path: string, body: Dict): Promise<Dict> {
  return st.S ? api(path, { ...body, revision: st.S.revision }) : Promise.reject(NO_STATE);
}

/** every edit goes out stamped. Resolves undefined when the edit failed (the error is shown). */
/** revision: the one the edit was computed from, when that is not the page's current one (an answer the server measured at a revision) */
export function ops(list: Op[], label?: string, revision?: number): Promise<Dict | undefined> {
  return (revision === undefined ? stamped("/api/ops", { ops: list, label }) : api("/api/ops", { ops: list, label, revision })).then((r): Dict | undefined => {
    show("ok", t("applied", r.revision) + (r.errors ? t("errorsRemain", r.errors) : ""));
    return r;
  }, (e) => { fail(e); return undefined; });
}
