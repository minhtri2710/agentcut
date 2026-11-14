import { ops } from "./api.ts";
import { clipPatch, regroupIds } from "./edits.ts";
import { kfAt, kfBase, near, packKf, pts, type Kf } from "./keyframes.ts";
import { fail, show } from "./messages.ts";
import { $, el, findClip, S, st, trackOf, V } from "./state.ts";
import { dur, start } from "./time.ts";
import { openPath } from "./timeline.ts";
import type { Clip } from "./types.ts";

export function select(id: string | null) {
  st.sel = id;
  const v = V(), c = id ? findClip(id) : null;
  const applyc = $<HTMLButtonElement>("applyc"), delc = $<HTMLButtonElement>("delc"), insp = $<HTMLTextAreaElement>("insp");
  applyc.disabled = delc.disabled = !c || v.nested; insp.readOnly = v.nested;
  if (!c) { $("selinfo").textContent = "Select a clip on the timeline."; insp.value = st.inspBase = ""; }
  else {
    $("selinfo").textContent = c.id + " on " + trackOf(c.id)!.id + " (" + c.type + ")" + (v.nested ? " inside " + st.path[st.path.length - 1] + ": expand it to edit" : "");
    insp.value = st.inspBase = JSON.stringify(c, null, 2);
  }
  document.querySelectorAll<HTMLElement>(".clip").forEach((n) => { n.classList.toggle("sel", n.dataset.id === id); n.classList.toggle("pick", st.picked.indexOf(n.dataset.id!) >= 0); });
  const cmp = c && c.type === "compound";
  $("openc").style.display = cmp ? "" : "none";
  $("expc").style.display = cmp && !v.nested ? "" : "none";
  const g = groupIds();
  $("group").style.display = g.length && !v.nested ? "" : "none"; $("group").textContent = "Group " + g.length + " clip(s)";
  drawKf(c);
}

// ------------------------------------------------------------ compound clips (nested edits: expand, edit, regroup)
function groupIds(): string[] { return st.picked.length ? st.picked.slice() : st.sel && findClip(st.sel) && !V().nested ? [st.sel] : []; }

/** one "Regroup <id>" button per expanded compound still on the timeline */
export function drawRegroup() {
  const box = $("regroups");
  box.innerHTML = "";
  if (V().nested) return;
  regroupIds(S().timeline.tracks).forEach((g) => {
    const b = el("button", { textContent: "Regroup " + g, onclick: () => {
      ops([{ op: "make_compound", from: g }], "regroup " + g).then((r) => { if (r) select(r.results[0].id); }); } });
    b.dataset.group = g; box.appendChild(b);
  });
}

// ------------------------------------------------------------ keyframes (every edit = one set_keyframes op per prop)
function setKf(c: Clip, prop: string, list: Kf[]) { return ops([{ op: "set_keyframes", id: c.id, prop, keyframes: packKf(list) }], "keyframes " + c.id + "." + prop); }

function drawKf(c: Clip | null) {
  const box = $("kfbox");
  box.innerHTML = "";
  if (!c || c.type === "gap") return;
  const ro = V().nested, kf = c.keyframes || {};
  const prop: HTMLSelectElement = el("select", { id: "kfprop", disabled: ro, onchange: () => { st.kfProp = prop.value; } },
    ENUM.animatable.map((p) => el("option", { value: p, textContent: p, selected: p === st.kfProp })));
  const add = el("button", { id: "kfadd", textContent: "+ key at playhead", disabled: ro });
  add.onclick = () => {
    const p = prop.value, v = V(), lt = +Math.max(0, Math.min(dur(c), (st.t - v.off) / v.k - start(c))).toFixed(3), list = pts(kf[p]);
    const val = list.length ? kfAt(list, lt) : kfBase(c, p, S().timeline.settings);
    setKf(c, p, list.filter((q) => !near(q[0], lt)).concat([[lt, val, undefined] as Kf]));
  };
  box.appendChild(el("div", { className: "row" }, [el("span", { className: "mut", textContent: "Keyframes" }), prop, add]));
  Object.keys(kf).forEach((p) => {
    const list = pts(kf[p]);
    const rm = el("button", { textContent: "clear", title: "remove all " + p + " keyframes", disabled: ro }); rm.onclick = () => { setKf(c, p, []); };
    box.appendChild(el("div", { className: "row" }, [el("b", { textContent: p }), el("span", { className: "mut", textContent: "t (s) · value · easing into it" }), rm]));
    list.forEach((q, i) => {
      const commit = () => {
        const nt = parseFloat(ti.value), nv = parseFloat(vi.value);
        if (!isFinite(nt) || !isFinite(nv)) return fail({ code: "bad_value", message: p + ": t and value must be numbers" });
        const next = list.slice(); next[i] = [nt, nv, ease.value]; setKf(c, p, next);
      };
      const ti: HTMLInputElement = el("input", { type: "number", step: "0.05", value: q[0], title: "time from clip start", disabled: ro, onchange: commit });
      const vi: HTMLInputElement = el("input", { type: "number", step: "0.05", value: q[1], disabled: ro, onchange: commit });
      const ease: HTMLSelectElement = el("select", { disabled: ro, onchange: commit }, ENUM.easings.map((n) => el("option", { value: n, textContent: n, selected: (q[2] || "linear") === n })));
      const del = el("button", { textContent: "×", title: "delete this keyframe", disabled: ro }); del.onclick = () => { setKf(c, p, list.filter((_, j) => j !== i)); };
      box.appendChild(el("div", { className: "row kfrow" }, [ti, vi, ease, del]));
    });
  });
}

export function initInspector() {
  $("openc").addEventListener("click", () => openPath(st.path.concat([st.sel!])));
  $("expc").addEventListener("click", () => {
    const c = findClip(st.sel!)!;
    ops([{ op: "expand_compound", id: c.id }], "expand " + c.id).then((r) => { if (r) { st.picked = []; select(null); } });
  });
  $("group").addEventListener("click", () => {
    const ids = groupIds();
    ops([{ op: "make_compound", ids }], "group " + ids.join(",")).then((r) => { if (r) { st.picked = []; select(r.results[0].id); } });
  });
  const insp = $<HTMLTextAreaElement>("insp");
  $("applyc").addEventListener("click", () => {
    let now;
    try { now = JSON.parse(insp.value); } catch (e) { return fail({ code: "bad_json", message: (e as Error).message }); }
    const { set, n } = clipPatch(JSON.parse(st.inspBase), now);
    if (!n) return show("ok", "nothing changed");
    ops([{ op: "update_clip", id: st.sel, set }], "update " + st.sel).then((r) => { if (r) st.inspBase = insp.value; });
  });
  $("delc").addEventListener("click", () => { ops([{ op: "remove_clip", id: st.sel }], "remove " + st.sel); });
  $("applyo").addEventListener("click", () => {
    let l;
    try { l = JSON.parse($<HTMLTextAreaElement>("ops").value); } catch (e) { return fail({ code: "bad_json", message: (e as Error).message }); }
    ops(Array.isArray(l) ? l : [l]);
  });
}
