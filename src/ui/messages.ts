import { $ } from "./state.ts";
import { errText } from "./text.ts";
import type { ApiError } from "./types.ts";

export function show(kind: "ok" | "err", text: string) {
  const m = $("msg");
  m.className = kind; m.textContent = text;
  if (kind === "ok") setTimeout(() => { if (m.textContent === text) m.className = ""; }, 2500);
}

/** an API error in the message box (a conflict included: its text says the page is stale and to reload) */
export function fail(e: ApiError) {
  if (e && e.code === "not_prepared") $("prepare").style.display = "";
  show("err", errText(e));
}
