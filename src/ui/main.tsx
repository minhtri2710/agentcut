// The page's entry point: draws the page with React and the Astryx design system from st, and follows the server's event stream.
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ArrowLeftRight, AudioLines, Bot, Captions, Clapperboard, Download, Film, History as HistoryIcon, Images, LayoutGrid, LayoutTemplate, ListChecks, Redo2, Sparkles, SwatchBook, Type, Undo2 } from "lucide-react";
import { hist } from "./history.ts";
import { getLang, setLang, t, type Lang } from "./i18n.ts";
import { Frame, ico, LangSwitch } from "./kit.tsx";
import { select, Side } from "./inspector.tsx";
import { onJobEvent, startPrepare, startRender, startSheet } from "./jobs.ts";
import { Chat, onChatEvent } from "./chat.tsx";
import { Dashboard } from "./dashboard.tsx";
import { ExportDialog, openExport } from "./export.tsx";
import { TemplateDialog } from "./templates.tsx";
import { Library } from "./library.tsx";
import { Media } from "./media.tsx";
import { History, Review } from "./review.tsx";
import { Transcript } from "./transcript.tsx";
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
  const errors = S ? S.errors || 0 : 0, warnings = S ? S.warnings || 0 : 0;
  return (
    <header id="top">
      <span className="brand"><span className="logo">{ico(Clapperboard)}</span><b id="name">{S ? S.timeline.name || t("untitled") : "AgentCut"}</b></span>
      <span className="mut mono" id="rev">{S ? t("rev", S.revision, S.timeline.settings.width, S.timeline.settings.height, S.timeline.settings.fps) : ""}</span>
      <span className="sep" />
      <span className="hgroup">
        <IconButton id="undo" size="sm" variant="ghost" label={t("undo")} tooltip={t("undoTitle", S ? last(S.history.undo) : "Cmd/Ctrl+Z")} icon={ico(Undo2)}
          isDisabled={!!S && !S.history.undo.length} onClick={() => hist("undo")} />
        <IconButton id="redo" size="sm" variant="ghost" label={t("redo")} tooltip={t("redoTitle", S ? last(S.history.redo) : "Shift+Cmd/Ctrl+Z")} icon={ico(Redo2)}
          isDisabled={!!S && !S.history.redo.length} onClick={() => hist("redo")} />
      </span>
      <span className="grow" />
      <span id="issues" className="mut" title={t("issues", errors, warnings)}>{S && <><span className="dot" style={{ background: errors ? "#ff6b6b" : warnings ? "#ffd166" : "#3ddc97" }} />{t("issues", errors, warnings)}</>}</span>
      <LangSwitch onPick={switchLang} />
      <span className="sep" />
      <IconButton id="sheet" size="sm" variant="ghost" label={t("sheet")} tooltip={t("sheet")} icon={ico(LayoutGrid)} isDisabled={st.sheeting} onClick={startSheet} />
      <CheckboxInput id="draft" size="sm" label={t("draft")} value={st.draft} onChange={(v) => { st.draft = v; changed(); }} />
      <Button id="render" size="sm" icon={ico(Film)} label={t("render")} isDisabled={st.rendering} onClick={() => startRender()} />
      <Button id="exportb" size="sm" variant="primary" icon={ico(Download)} label={t("exportBtn")} isDisabled={st.rendering} onClick={openExport} />
    </header>
  );
}

/** the model download dialog: opened when st.consent is set; only its confirm button downloads (Escape and Cancel show the failure) */
let consentGo = false;
function Consent() {
  const err = st.consent;
  const closed = (open: boolean) => {
    if (open || !st.consent) return;
    const e = st.consent, go = consentGo;
    st.consent = null; consentGo = false; changed();
    if (go) startPrepare(true); else fail(e);
  };
  return (
    <Dialog id="consent" isOpen={!!err} onOpenChange={closed} width={440}>
      <DialogHeader title={t("consentTitle")} subtitle={t("consentNote")} />
      <ul id="clist">{(err?.models || []).map((m) => <li key={m.model}>{m.model + " (~" + m.approx_mb + " MB)"}</li>)}</ul>
      <div className="dactions">
        <Button id="cno" label={t("cancel")} onClick={() => closed(false)} />
        <Button id="cgo" data-autofocus variant="primary" label={t("consentGo")} onClick={() => { consentGo = true; closed(false); }} />
      </div>
    </Dialog>
  );
}

/** The left panel: CapCut's tool strip (an icon over its name) and the tool's panel. The library's kinds are tools of their own, as in CapCut
 *  (Text, Effects, Transitions, Filters, Captions); `lib` is the library kind the panel shows. */
const TABS = [
  { id: "media", label: () => t("media"), icon: Images, body: Media },
  { id: "lib-text", label: () => t("railText"), icon: Type, body: () => <Library only={["text"]} /> },
  { id: "lib-effect", label: () => t("railEffects"), icon: Sparkles, body: () => <Library only={["effect"]} /> },
  { id: "lib-transition", label: () => t("railTransitions"), icon: ArrowLeftRight, body: () => <Library only={["transition"]} /> },
  { id: "lib-look", label: () => t("railFilters"), icon: SwatchBook, body: () => <Library only={["look"]} /> },
  { id: "lib-caption", label: () => t("railCaptions"), icon: Captions, body: () => <Library only={["caption"]} /> },
  { id: "templates", label: () => t("railTemplates"), icon: LayoutTemplate, body: () => <Library only={[]} templates /> },
  { id: "transcript", label: () => t("transcript"), icon: AudioLines, body: Transcript },
  { id: "chat", label: () => t("railAgent"), icon: Bot, body: Chat },
  { id: "review", label: () => t("review"), icon: ListChecks, body: Review },
  { id: "history", label: () => t("history"), icon: HistoryIcon, body: History },
];

/** the rail as a vertical tab list: Up/Down move to the next tool and open it, Home/End to the first and last; Tab leaves the list */
function railKeys(e: React.KeyboardEvent) {
  const i = TABS.findIndex((x) => x.id === st.tab), n = TABS.length;
  const j = e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowUp" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
  if (j < 0) return;
  e.preventDefault();
  st.tab = TABS[j].id; changed();
  requestAnimationFrame(() => document.getElementById("tab-" + TABS[j].id)?.focus());
}

function Left() {
  const tab = TABS.find((x) => x.id === st.tab) || TABS[0];
  return (
    <aside id="left">
      <nav id="rail" role="tablist" aria-orientation="vertical" onKeyDown={railKeys}>
        {TABS.map((x) => (
          <button key={x.id} id={"tab-" + x.id} type="button" role="tab" className="rbtn" aria-selected={x === tab} tabIndex={x === tab ? 0 : -1} title={x.label()} onClick={() => { st.tab = x.id; changed(); }}>
            {ico(x.icon)}<span>{x.label()}</span>
          </button>
        ))}
      </nav>
      <div id="lpanel">
        <div className="phead">{tab.label()}</div>
        <tab.body />
      </div>
    </aside>
  );
}

function App() {
  const [, redraw] = useState(0);
  useLayoutEffect(() => onChange(() => redraw((n) => n + 1)), []);
  return (
    <Frame>
      <Header />
      <div id="main"><Left /><Viewer /><Side /></div>
      <Timeline />
      <Consent />
      <ExportDialog />
      <TemplateDialog />
      <div id="msg" role="status" aria-live="polite" onClick={(e) => { e.currentTarget.className = ""; }} />
    </Frame>
  );
}

document.documentElement.lang = getLang();
const root = createRoot($("app"));
if ($("app").dataset.dashboard !== undefined) root.render(<Dashboard />); // a folder of projects: the server has no project of its own
else startEditor();

function startEditor() {
  root.render(<App />);
  initKeyboard();
  window.addEventListener("resize", () => { changed(); requestFrame(); });
  const events = new EventSource("/api/events");
  events.addEventListener("state", (e) => { setState(JSON.parse((e as MessageEvent).data)); });
  events.addEventListener("job", (e) => { onJobEvent(JSON.parse((e as MessageEvent).data)); });
  events.addEventListener("chat", (e) => { onChatEvent(JSON.parse((e as MessageEvent).data)); });
  events.addEventListener("error", (e) => { const d = (e as MessageEvent).data; if (d) fail(JSON.parse(d), true); }); // the stream's error means the server could not build the state
}
