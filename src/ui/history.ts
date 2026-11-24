import { stamped } from "./api.ts";
import { fail, show } from "./messages.ts";
import { t } from "./i18n.ts";

/** undo or redo `steps` entries at the revision this page shows: an agent's save in between answers "conflict", which fail() shows */
export function hist(kind: "undo" | "redo", steps = 1) { stamped("/api/" + kind, { steps }).then(() => { show("ok", t(kind === "undo" ? "undone" : "redone")); }, fail); }

