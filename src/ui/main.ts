// The page's entry point: wires every module and follows the server's event stream.
import { clearStateless, fail } from "./messages.ts";
import { initHistory } from "./history.ts";
import { initInspector, select } from "./inspector.ts";
import { initJobs, onJobEvent } from "./jobs.ts";
import { initKeyboard } from "./keyboard.ts";
import { $, findClip, refreshView, st, total } from "./state.ts";
import { drawTimeline, initTimeline } from "./timeline.ts";
import type { State } from "./types.ts";
import { initViewer, requestFrame } from "./viewer.ts";

function setState(s: State) {
  st.S = s; clearStateless();
  $("name").textContent = s.timeline.name || "untitled";
  $("rev").textContent = "rev " + s.revision + " · " + s.timeline.settings.width + "x" + s.timeline.settings.height + " @" + s.timeline.settings.fps;
  $("issues").textContent = (s.errors || 0) + " errors, " + (s.warnings || 0) + " warnings";
  const undo = $<HTMLButtonElement>("undo"), redo = $<HTMLButtonElement>("redo");
  undo.disabled = !s.history.undo.length; undo.title = "undo: " + (s.history.undo.slice(-1)[0]?.label || "");
  redo.disabled = !s.history.redo.length; redo.title = "redo: " + (s.history.redo.slice(-1)[0]?.label || "");
  $("dur").textContent = total().toFixed(2) + " s";
  refreshView();
  st.picked = st.picked.filter((id) => findClip(id));
  const c = st.sel && findClip(st.sel);
  if (!c) select(null);
  else if ($<HTMLTextAreaElement>("insp").value === st.inspBase) select(st.sel); // refresh unless the user is editing
  drawTimeline(); requestFrame();
}

initTimeline(); initViewer(); initInspector(); initJobs(); initHistory(); initKeyboard();
const events = new EventSource("/api/events");
events.addEventListener("state", (e) => { setState(JSON.parse((e as MessageEvent).data)); });
events.addEventListener("job", (e) => { onJobEvent(JSON.parse((e as MessageEvent).data)); });
events.addEventListener("error", (e) => { const d = (e as MessageEvent).data; if (d) fail(JSON.parse(d), true); }); // the stream names why it has no state
