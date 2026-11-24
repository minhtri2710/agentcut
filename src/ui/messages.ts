import { t } from "./i18n.ts";
import { $, changed, st } from "./state.ts";
import { errText } from "./text.ts";
import type { ApiError } from "./types.ts";

// The message box is written here, not drawn from st: a message must show again when it repeats the last one.

/** what a write answers while the page has no state yet: nothing is sent */
export const NO_STATE: ApiError = { code: "no_state", get message() { return t("noState"); } };

/** the box shows a message that only says the page has no state: the next state takes it away, and no other message */
let stateless = false;

export function show(kind: "ok" | "err", text: string) {
  const m = $("msg");
  m.className = kind; m.textContent = text; stateless = false;
  if (kind === "ok") setTimeout(() => { if (m.textContent === text) m.className = ""; }, 2500);
}

/** an API error in the message box (a conflict included: its text says the page is stale and to reload). noState: the message says the page has no current state (the stream's error, which can also reach a page that holds a now stale state, or the NO_STATE refusal); the next state takes it away. */
export function fail(e: ApiError, noState = e === NO_STATE) {
  if (e && e.code === "not_prepared") { st.needPrepare = true; changed(); }
  show("err", errText(e));
  stateless = noState;
}

/** a state arrived: the no-state message, if it is still the one shown, goes */
export function clearStateless() {
  if (!stateless) return;
  const m = $("msg");
  m.className = ""; m.textContent = ""; stateless = false;
}
