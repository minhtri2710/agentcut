import { api, ops } from "./api.ts";
import { clipWords, cutWords } from "./edits.ts";
import { t } from "./i18n.ts";
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

function cut(c: Clip) {
  const ws = clipWords(c, st.tx[keyOf(c)]!.words!), { a, b } = st.txSel!;
  ops([cutWords(c, ws, a, b)], "cut words from " + c.id).then((r) => { if (r) { st.txSel = null; changed(); } });
}

export function Transcript() {
  const c = txClip(), tx = c ? st.tx[keyOf(c)] : undefined;
  if (!c) return <div id="transcript" class="mut">{t("txPick")}</div>;
  if (!tx || !tx.words) return <div id="transcript"><button id="txgo" disabled={!!tx} onClick={() => load(c)}>{tx ? t("txBusy") : t("txGo")}</button></div>;
  const ws = clipWords(c, tx.words), x = st.txSel && st.txSel.id === c.id && ws[st.txSel.a] && ws[st.txSel.b] ? st.txSel : null, sel = x && [Math.min(x.a, x.b), Math.max(x.a, x.b)];
  return (
    <div id="transcript" onKeyDown={(e) => { if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); e.stopPropagation(); cut(c); } }}>
      <div class="mut">{t("txHint")}</div>
      <div><button id="txcut" disabled={!sel} onClick={() => cut(c)}>{t("txCut")}</button></div>
      <p id="words">
        {!ws.length && <span class="mut">{t("txNone")}</span>}
        {ws.map((w, i) => (
          <button key={i} class={"word" + (w.on ? "" : " off") + (sel && i >= sel[0] && i <= sel[1] ? " pick" : "") + (w.on && st.t >= w.t0 && st.t < w.t1 ? " now" : "")} disabled={!w.on} data-i={i}
            onClick={(e) => { st.txSel = { id: c.id, a: e.shiftKey && x ? x.a : i, b: i }; seek(Math.max(w.t0, 0)); }}>{w.text}</button>
        ))}
      </p>
    </div>
  );
}

