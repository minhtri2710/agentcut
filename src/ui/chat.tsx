import { useEffect, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Selector } from "@astryxdesign/core/Selector";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Bot, MessageSquarePlus, Send, Square } from "lucide-react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import { ico } from "./kit.tsx";
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

function Entry({ e }: { e: Dict }) {
  if (e.kind === "user") return <div className="cuser">{e.text}</div>;
  if (e.kind === "text") return <div className="cbot">{e.text}</div>;
  if (e.kind === "tool") return <div className="ctool">{"→ " + e.name + " " + JSON.stringify(e.input).slice(0, 200)}</div>;
  if (e.kind === "tool_result") return <div className={"ctool" + (e.ok ? "" : " cerr")}>{(e.ok ? "← " : "✗ ") + e.text.slice(0, 200)}</div>;
  return <div className={"mut" + (e.error ? " cerr" : "")}>{e.stopped ? t("chatStopped") : e.error ? e.error : t("chatDone")}</div>;
}

export function Chat() {
  const [msg, setMsg] = useState("");
  useEffect(() => { fetch("/api/chat").then((r) => r.json()).then((j) => { st.chat.engine = j; st.chat.busy = j.busy; st.chat.cli = j.cli ?? j.clis[0] ?? null; changed(); }); }, []);
  const eng = st.chat.engine;
  const newChat = () => api("/api/chat/reset").then(() => { st.chat.log = []; changed(); }, (e: ApiError) => fail(e));
  if (!eng) return <div id="chat" className="pbody" />; // no form before the CLI to send is known
  if (!eng.available) return <div id="chat" className="pbody"><EmptyState isCompact icon={ico(Bot)} title={t("chat")} description={t("chatMissing", eng.hint)} /></div>;
  const send = (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const message = msg.trim();
    if (message) api("/api/chat", { message, cli: st.chat.cli }).then(() => setMsg(""), (e: ApiError) => fail(e));
  };
  return (
    <div id="chat" className="pbody">
      {eng.clis.length > 1 && (
        <Selector id="ccli" size="sm" label={t("chatCli")} value={st.chat.cli ?? ""} isDisabled={st.chat.busy} options={eng.clis} onChange={(v) => { st.chat.cli = v; newChat(); }} />
      )}
      <div id="clog">
        {!st.chat.log.length && <EmptyState isCompact icon={ico(Bot)} title={t("chat")} description={t("chatHint")} />}
        {st.chat.log.map((e, i) => <Entry key={i} e={e} />)}
      </div>
      <form id="cform2" onSubmit={send}>
        <TextArea htmlName="msg" label={t("chat")} isLabelHidden rows={3} placeholder={t("chatPlaceholder")} value={msg} onChange={setMsg}
          onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.currentTarget.form!.requestSubmit(); } }} />
        <div className="row">
          <Button id="csend" type="submit" size="sm" variant="primary" icon={ico(Send)} label={t("chatSend")} isDisabled={st.chat.busy} />
          <IconButton id="cstop" size="sm" label={t("chatStop")} tooltip={t("chatStop")} icon={ico(Square)} isDisabled={!st.chat.busy} onClick={() => api("/api/chat/stop").catch((e: ApiError) => fail(e))} />
          <span className="grow" />
          <IconButton id="cnew" size="sm" variant="ghost" label={t("chatNew")} tooltip={t("chatNew")} icon={ico(MessageSquarePlus)} isDisabled={st.chat.busy} onClick={newChat} />
        </div>
      </form>
    </div>
  );
}
