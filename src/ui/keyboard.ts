import { hist } from "./history.ts";
import { select } from "./inspector.tsx";
import { $, S, st, V } from "./state.ts";
import { clipNode } from "./timeline.tsx";
import { clipOrder } from "./view.ts";
import { seek } from "./viewer.tsx";

/** the control holds focus from the keyboard: :focus-visible, and no mouse press since the last Tab (a key press after a click makes the clicked control :focus-visible too) */
let mouseFocus = false; // which came last: a mouse press (true) or Tab (false)
const kbFocus = (n: Element) => !mouseFocus && n.matches(":focus-visible");

/** Left / Right walk the clips in time order, Enter or Space selects the focused one (a click does the same) */
function clipKey(e: KeyboardEvent, n: HTMLElement) {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(n.dataset.id!); return; }
  const order = clipOrder(V()), i = order.map((c) => c.id).indexOf(n.dataset.id!), next = order[i + (e.key === "ArrowLeft" ? -1 : 1)];
  e.preventDefault();
  if (!next) return;
  n.tabIndex = -1;
  const m = clipNode(next.id)!;
  m.tabIndex = 0; m.focus();
}

export function initKeyboard() {
  document.addEventListener("mousedown", () => { mouseFocus = true; }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Tab") mouseFocus = false; }, true);
  document.addEventListener("keydown", (e) => {
    const g = e.target as HTMLElement;
    if (document.querySelector("dialog[open]") || g.tagName === "TEXTAREA" || g.tagName === "INPUT") return; // an open dialog owns the keys
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); hist(e.shiftKey ? "redo" : "undo"); return; }
    if (g.classList && g.classList.contains("clip") && (e.key === "Enter" || e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === " ") && kbFocus(g)) return clipKey(e, g);
    // a control reached with the keyboard keeps its own keys; one clicked with the mouse does not, so Space still plays. A slider's arrows are its own either way.
    if (g.getAttribute("role") === "slider") return;
    if ((g.tagName === "BUTTON" || g.tagName === "SELECT" || g.tagName === "A" || /^(button|combobox|tab|radio|option|checkbox|switch)$/.test(g.getAttribute("role") || "")) && kbFocus(g)) return;
    // the page owns these keys (an arrow with Cmd/Ctrl/Alt stays the browser's): its own arrow scroll would also slide the timeline under the playhead
    if (e.key === " ") { e.preventDefault(); $("play").click(); }
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && st.S && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); const f = 1 / S().timeline.settings.fps * (e.shiftKey ? 10 : 1); seek(st.t + (e.key === "ArrowLeft" ? -f : f)); }
  });
}
