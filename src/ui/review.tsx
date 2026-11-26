import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { CircleCheck, History as HistoryIcon, ListChecks, Redo2, Undo2 } from "lucide-react";
import { api } from "./api.ts";
import { hist } from "./history.ts";
import { t } from "./i18n.ts";
import { select } from "./inspector.tsx";
import { ico } from "./kit.tsx";
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
    <div id="review" className="pbody">
      <div className="row">
        <Button id="runreview" size="sm" variant="primary" icon={ico(ListChecks)} label={rv && rv.busy ? t("reviewing") : t("runReview")} isLoading={!!(rv && rv.busy)} isDisabled={!st.S} onClick={runReview} />
      </div>
      {r && <div className="mut">{(r.clean ? t("clean") : t("findingsN", r.findings.length)) + " · " + t("forRevision", r.revision)}{st.S && st.S.revision !== r.revision ? " · " + t("staleReview") : ""}</div>}
      {r && r.clean && <EmptyState isCompact icon={ico(CircleCheck)} title={t("clean")} />}
      {r && (
        <ul id="findings">
          {r.findings.map((f: Dict, i: number) => (
            <li key={i} data-type={f.type} onClick={() => goTo(f)} title={f.hint || ""}>
              <div className="row"><Badge variant="warning" label={f.type} /><span className="mut mono">{(f.t !== undefined ? f.t.toFixed(2) + " s" : "") + (f.id ? " · " + f.id : "")}</span></div>
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
    <li key={kind + i}>
      <button type="button" title={t(kind === "undo" ? "undoTo" : "redoTo")} onClick={() => hist(kind, i + 1)}>{e.label || "?"}</button>
      <span className="mut">{t("by", e.author || "unknown")}</span>
    </li>
  );
  return (
    <div id="history" className="pbody">
      {!h.undo.length && !h.redo.length && <EmptyState isCompact icon={ico(HistoryIcon)} title={t("history")} />}
      {h.undo.length ? <div className="ihead">{ico(Undo2)} {t("undoStack")}</div> : null}
      <ul id="hundo">{h.undo.slice().reverse().map((e, i) => row(e, i, "undo"))}</ul>
      {h.redo.length ? [<div key="rh" className="ihead">{ico(Redo2)} {t("redoStack")}</div>, <ul key="rl" id="hredo">{h.redo.slice().reverse().map((e, i) => row(e, i, "redo"))}</ul>] : null}
    </div>
  );
}
