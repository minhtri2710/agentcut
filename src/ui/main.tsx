// The page's entry point: draws the page with Preact from st and follows the server's event stream.
import { render } from "preact";
import { useLayoutEffect, useState } from "preact/hooks";
import { hist } from "./history.ts";
import { getLang, setLang, t, type Lang } from "./i18n.ts";
import { select, Side } from "./inspector.tsx";
import { onJobEvent, startPrepare, startRender, startSheet } from "./jobs.ts";
import { initKeyboard } from "./keyboard.ts";
import { clearStateless, fail } from "./messages.ts";
import { $, changed, findClip, onChange, refreshView, st } from "./state.ts";
import { Timeline } from "./timeline.tsx";
import type { State } from "./types.ts";
import { requestFrame, Viewer } from "./viewer.tsx";

function setState(s: State) {
  st.S = s; clearStateless();
  refreshView();
  st.picked = st.picked.filter((id) => findClip(id));
  const c = st.sel && findClip(st.sel);
  if (!c) select(null);
  else if ($<HTMLTextAreaElement>("insp").value === st.inspBase) select(st.sel); // refresh unless the user is editing
  changed(); requestFrame();
}

function switchLang(l: Lang) { setLang(l); document.documentElement.lang = l; changed(); }

function Header() {
  const S = st.S, last = (l: { label?: string }[]) => l[l.length - 1]?.label || "";
  return (
    <header>
      <b id="name">{S ? S.timeline.name || t("untitled") : "AgentCut"}</b>
      <span class="mut" id="rev">{S ? t("rev", S.revision, S.timeline.settings.width, S.timeline.settings.height, S.timeline.settings.fps) : ""}</span>
      <button id="undo" disabled={!!S && !S.history.undo.length} title={t("undoTitle", S ? last(S.history.undo) : "Cmd/Ctrl+Z")} onClick={() => hist("undo")}>{t("undo")}</button>
      <button id="redo" disabled={!!S && !S.history.redo.length} title={t("redoTitle", S ? last(S.history.redo) : "Shift+Cmd/Ctrl+Z")} onClick={() => hist("redo")}>{t("redo")}</button>
      <span class="grow" />
      <span id="issues" class="mut">{S ? t("issues", S.errors || 0, S.warnings || 0) : ""}</span>
      <select id="lang" aria-label={t("language")} value={getLang()} onChange={(e) => switchLang(e.currentTarget.value as Lang)}>
        <option value="en">English</option><option value="vi">Tiếng Việt</option>
      </select>
      <label class="mut"><input type="checkbox" id="draft" defaultChecked /> {t("draft")}</label>
      <button id="render" class="primary" disabled={st.rendering} onClick={startRender}>{t("render")}</button>
      <button id="sheet" disabled={st.sheeting} onClick={startSheet}>{t("sheet")}</button>
    </header>
  );
}

/** the model download dialog: opened when st.consent is set; only its confirm button downloads */
function Consent() {
  const err = st.consent;
  useLayoutEffect(() => {
    const d = $<HTMLDialogElement>("consent");
    if (err && !d.open) { d.returnValue = ""; d.showModal(); $("cgo").focus(); }
  }, [err]);
  const closed = () => {
    const e = st.consent!;
    st.consent = null; changed();
    if ($<HTMLDialogElement>("consent").returnValue === "go") startPrepare(true); else fail(e);
  };
  return (
    <dialog id="consent" aria-labelledby="ctitle" onClose={closed}>
      <p id="ctitle"><b>{t("consentTitle")}</b></p>
      <ul id="clist">{(err?.models || []).map((m) => <li key={m.model}>{m.model + " (~" + m.approx_mb + " MB)"}</li>)}</ul>
      <p class="mut">{t("consentNote")}</p>
      <div><button id="cgo" onClick={() => $<HTMLDialogElement>("consent").close("go")}>{t("consentGo")}</button> <button id="cno" onClick={() => $<HTMLDialogElement>("consent").close("no")}>{t("cancel")}</button></div>
    </dialog>
  );
}

function App() {
  const [, redraw] = useState(0);
  useLayoutEffect(() => onChange(() => redraw((n) => n + 1)), []);
  return (
    <>
      <Header />
      <div id="main"><Viewer /><Side /></div>
      <Consent />
      <Timeline />
    </>
  );
}

document.documentElement.lang = getLang();
render(<App />, $("app"));
initKeyboard();
window.addEventListener("resize", requestFrame);
const events = new EventSource("/api/events");
events.addEventListener("state", (e) => { setState(JSON.parse((e as MessageEvent).data)); });
events.addEventListener("job", (e) => { onJobEvent(JSON.parse((e as MessageEvent).data)); });
events.addEventListener("error", (e) => { const d = (e as MessageEvent).data; if (d) fail(JSON.parse(d), true); }); // the stream's error means the server could not build the state
