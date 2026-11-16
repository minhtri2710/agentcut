import { stamped } from "./api.ts";
import { fail, show } from "./messages.ts";
import { $ } from "./state.ts";

/** undo or redo at the revision this page shows: an agent's save in between answers "conflict", which fail() shows */
export function hist(kind: "undo" | "redo") { stamped("/api/" + kind, {}).then(() => { show("ok", kind + " done"); }, fail); }

export function initHistory() {
  $("undo").addEventListener("click", () => { hist("undo"); });
  $("redo").addEventListener("click", () => { hist("redo"); });
}
