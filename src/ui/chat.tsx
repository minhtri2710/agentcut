import { useEffect } from "preact/hooks";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { fail } from "./messages.ts";
import { changed, st } from "./state.ts";
import type { ApiError, Dict } from "./types.ts";

/** an event of the chat agent's run (the server's "chat" event): kept in the log; a user message starts a run, done ends it */
export function onChatEvent(e: Dict) {
  if (e.kind === "user") st.chat.busy = true;
  if (e.kind === "done") st.chat.busy = false;
  if (e.kind !== "session") st.chat.log.push(e);
  changed();
}

function send(ev: Event) {
  ev.preventDefault();
  const box = (ev.currentTarget as HTMLFormElement).elements.namedItem("msg") as HTMLTextAreaElement, message = box.value.trim();
  if (message) api("/api/chat", { message }).then(() => { box.value = ""; }, (e: ApiError) => fail(e));
}

function Entry({ e }: { e: Dict }) {
  if (e.kind === "user") return <div class="cuser">{e.text}</div>;
  if (e.kind === "text") return <div class="cbot">{e.text}</div>;
  if (e.kind === "tool") return <div class="ctool">{"→ " + e.name + " " + JSON.stringify(e.input).slice(0, 200)}</div>;
  if (e.kind === "tool_result") return <div class={"ctool" + (e.ok ? "" : " cerr")}>{(e.ok ? "← " : "✗ ") + e.text.slice(0, 200)}</div>;
  return <div class={"mut" + (e.error ? " cerr" : "")}>{e.stopped ? t("chatStopped") : e.error ? e.error : t("chatDone")}</div>;
}

export function Chat() {
  useEffect(() => { fetch("/api/chat").then((r) => r.json()).then((j) => { st.chat.engine = j; st.chat.busy = j.busy; changed(); }); }, []);
  const eng = st.chat.engine;
  if (eng && !eng.available) return <div id="chat" class="mut">{t("chatMissing", eng.hint)}</div>;
  return (
    <div id="chat">
      <div id="clog">
        {!st.chat.log.length && <div class="mut">{t("chatHint")}</div>}
        {st.chat.log.map((e, i) => <Entry key={i} e={e} />)}
      </div>
      <form id="cform2" onSubmit={send}>
        <textarea name="msg" rows={3} placeholder={t("chatPlaceholder")} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form!.requestSubmit(); } }} />
        <div>
          <button id="csend" class="primary" disabled={st.chat.busy}>{t("chatSend")}</button>{" "}
          <button id="cstop" type="button" disabled={!st.chat.busy} onClick={() => api("/api/chat/stop").catch((e: ApiError) => fail(e))}>{t("chatStop")}</button>{" "}
          <button id="cnew" type="button" disabled={st.chat.busy} onClick={() => api("/api/chat/reset").then(() => { st.chat.log = []; changed(); }, (e: ApiError) => fail(e))}>{t("chatNew")}</button>
        </div>
      </form>
    </div>
  );
}
