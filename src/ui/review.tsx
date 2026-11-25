import { api } from "./api.ts";
import { hist } from "./history.ts";
import { t } from "./i18n.ts";
import { select } from "./inspector.tsx";
import { fail } from "./messages.ts";
import { changed, findClip, st } from "./state.ts";
import { openPath } from "./timeline.tsx";
import type { ApiError, Dict, HistoryEntry } from "./types.ts";
import { seek } from "./viewer.tsx";

function runReview() {
  st.review = { busy: true }; changed();
  api("/api/review").then((r) => { st.review = { busy: false, result: r }; changed(); }, (e: ApiError) => { st.review = null; changed(); fail(e); });
}

/** a finding: the playhead goes to its time, and its clip (on the timeline, not inside a compound) is selected */
function goTo(f: Dict) {
  if (st.path.length) openPath([]);
  if (f.t !== undefined) seek(f.t);
  if (f.id && findClip(f.id)) select(f.id);
}

export function Review() {
  const rv = st.review, r = rv && rv.result;
  return (
    <div id="review" class="panel">
      <button id="runreview" class="primary" disabled={!st.S || !!(rv && rv.busy)} onClick={runReview}>{rv && rv.busy ? t("reviewing") : t("runReview")}</button>
      {r && <div class="mut">{(r.clean ? t("clean") : t("findingsN", r.findings.length)) + " · " + t("forRevision", r.revision)}{st.S && st.S.revision !== r.revision ? " · " + t("staleReview") : ""}</div>}
      {r && (
        <ul id="findings">
          {r.findings.map((f: Dict) => (
            <li data-type={f.type} onClick={() => goTo(f)} title={f.hint || ""}>
              <b>{f.type}</b> <span class="mut">{(f.t !== undefined ? f.t.toFixed(2) + " s" : "") + (f.id ? " · " + f.id : "")}</span>
              <div>{f.message}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** the undo and redo stacks, newest first: a click undoes (or redoes) every entry down to the one clicked */
export function History() {
  const h = st.S ? st.S.history : { undo: [], redo: [] };
  const row = (e: HistoryEntry, i: number, kind: "undo" | "redo") => (
    <li key={kind + i}><button title={t(kind === "undo" ? "undoTo" : "redoTo")} onClick={() => hist(kind, i + 1)}>{e.label || "?"}</button> <span class="mut">{t("by", e.author || "unknown")}</span></li>
  );
  return (
    <div id="history" class="panel">
      <div class="mut">{t("undoStack")}</div>
      <ul id="hundo">{h.undo.slice().reverse().map((e, i) => row(e, i, "undo"))}</ul>
      {h.redo.length ? [<div class="mut">{t("redoStack")}</div>, <ul id="hredo">{h.redo.slice().reverse().map((e, i) => row(e, i, "redo"))}</ul>] : null}
    </div>
  );
}
