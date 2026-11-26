import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AudioLines, Scissors } from "lucide-react";
import { api, ops } from "./api.ts";
import { clipWords, cutWords } from "./edits.ts";
import { t } from "./i18n.ts";
import { ico } from "./kit.tsx";
import { fail } from "./messages.ts";
import { changed, findClip, S, st, V } from "./state.ts";
import type { ApiError, Clip } from "./types.ts";
import { seek } from "./viewer.tsx";

/** the clip the transcript is of: the selected video/audio clip whose source plays forward at one speed (what remove_range cuts) */
function txClip(): Clip | null {
  const c = st.S && st.sel && !V().nested ? findClip(st.sel) : null;
  return c && (c.type === "video" || c.type === "audio") && c.asset && !c.reverse && !c.freeze && !c.loop && !(c.keyframes && c.keyframes.speed) ? c : null;
}
const keyOf = (c: Clip) => c.asset + "|" + (S().timeline.assets[c.asset] || {}).path;

function load(c: Clip) {
  const k = keyOf(c);
  st.tx[k] = { busy: true }; changed();
  api("/api/transcript", { asset: c.asset }).then((r) => { st.tx[k] = { words: r.words }; changed(); }, (e: ApiError) => { delete st.tx[k]; changed(); fail(e); });
}

/** The cut is made only with words that still match the file: the server's copy follows the file's version, so a source replaced since the panel loaded refreshes the words instead. */
function cut(c: Clip) {
  const k = keyOf(c), had = st.tx[k]!.words!, { a, b } = st.txSel!;
  const timing = (x: Clip | null) => x && JSON.stringify([x.asset, x.in, x.start, x.duration, x.speed]);
  api("/api/transcript", { asset: c.asset }).then((r) => {
    const now = findClip(c.id); // the project may have changed while the words were checked: cut only the clip the words were picked on
    if (JSON.stringify(r.words) !== JSON.stringify(had) || timing(now) !== timing(c)) { st.tx[k] = { words: r.words }; st.txSel = null; changed(); fail({ code: "stale", message: t("txStale") }); return; }
    ops([cutWords(now!, clipWords(now!, had), a, b)], "cut words from " + c.id).then((x) => { if (x) { st.txSel = null; changed(); } });
  }, (e: ApiError) => fail(e));
}

export function Transcript() {
  const c = txClip(), tx = c ? st.tx[keyOf(c)] : undefined;
  if (!c) return <div id="transcript" className="pbody"><EmptyState isCompact icon={ico(AudioLines)} title={t("transcript")} description={t("txPick")} /></div>;
  if (!tx || !tx.words) return (
    <div id="transcript" className="pbody">
      <EmptyState isCompact icon={ico(AudioLines)} title={c.id} description={t("txHint")}
        actions={<Button id="txgo" size="sm" variant="primary" label={tx ? t("txBusy") : t("txGo")} isLoading={!!tx} onClick={() => load(c)} />} />
    </div>
  );
  const ws = clipWords(c, tx.words), x = st.txSel && st.txSel.id === c.id && ws[st.txSel.a] && ws[st.txSel.b] ? st.txSel : null, sel = x && [Math.min(x.a, x.b), Math.max(x.a, x.b)];
  return (
    <div id="transcript" className="pbody" onKeyDown={(e) => { if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); e.stopPropagation(); cut(c); } }}>
      <div className="mut">{t("txHint")}</div>
      <div className="row"><Button id="txcut" size="sm" variant="destructive" icon={ico(Scissors)} label={t("txCut")} isDisabled={!sel} onClick={() => cut(c)} /></div>
      <p id="words">
        {!ws.length && <span className="mut">{t("txNone")}</span>}
        {ws.map((w, i) => (
          <button key={i} type="button" className={"word" + (w.on ? "" : " off") + (sel && i >= sel[0] && i <= sel[1] ? " pick" : "") + (w.on && st.t >= w.t0 && st.t < w.t1 ? " now" : "")} disabled={!w.on} data-i={i}
            onClick={(e) => { st.txSel = { id: c.id, a: e.shiftKey && x ? x.a : i, b: i }; seek(Math.max(w.t0, 0)); }}>{w.text}</button>
        ))}
      </p>
    </div>
  );
}
