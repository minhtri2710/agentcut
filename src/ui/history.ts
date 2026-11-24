import { stamped } from "./api.ts";
import { fail, show } from "./messages.ts";
import { t } from "./i18n.ts";

/** undo or redo at the revision this page shows: an agent's save in between answers "conflict", which fail() shows */
export function hist(kind: "undo" | "redo") { stamped("/api/" + kind, {}).then(() => { show("ok", t(kind === "undo" ? "undone" : "redone")); }, fail); }

