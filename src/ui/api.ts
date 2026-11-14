import { fail, show } from "./messages.ts";
import { S } from "./state.ts";
import type { Dict, Op } from "./types.ts";

/** POST JSON; resolves with the body when it says ok, rejects with its error */
export function api(path: string, body?: Dict): Promise<Dict> {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
    .then((r) => r.json()).then((j) => { if (!j.ok) throw j.error || { message: "request failed" }; return j; });
}

/** every edit carries the revision this page shows: if an agent saved meanwhile the server answers "conflict". Resolves undefined when the edit failed (the error is shown). */
export function ops(list: Op[], label?: string): Promise<Dict | undefined> {
  return api("/api/ops", { ops: list, revision: S().revision, label }).then((r): Dict | undefined => {
    show("ok", "applied (revision " + r.revision + ")" + (r.errors ? ", " + r.errors + " error(s) remain" : ""));
    return r;
  }, (e) => { fail(e); return undefined; });
}
