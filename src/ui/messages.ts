import { $ } from "./state.ts";
import { errText } from "./text.ts";
import type { ApiError } from "./types.ts";

/** what a write answers while the page has no state yet: nothing is sent */
export const NO_STATE: ApiError = { code: "no_state", message: "this page has not loaded the project yet" };

/** the box shows a message that only says the page has no state: the next state takes it away, and no other message */
let stateless = false;

export function show(kind: "ok" | "err", text: string) {
  const m = $("msg");
  m.className = kind; m.textContent = text; stateless = false;
  if (kind === "ok") setTimeout(() => { if (m.textContent === text) m.className = ""; }, 2500);
}

/** an API error in the message box (a conflict included: its text says the page is stale and to reload). noState: the error is the stream's, which means the page has no state. */
export function fail(e: ApiError, noState = e === NO_STATE) {
  if (e && e.code === "not_prepared") $("prepare").style.display = "";
  show("err", errText(e));
  stateless = noState;
}

/** a state arrived: the no-state message, if it is still the one shown, goes */
export function clearStateless() {
  if (!stateless) return;
  const m = $("msg");
  m.className = ""; m.textContent = ""; stateless = false;
}
