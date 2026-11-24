import { ops } from "./api.ts";
import { clipPatch, regroupIds } from "./edits.ts";
import { t } from "./i18n.ts";
import { kfAt, kfBase, near, packKf, pts, type Kf } from "./keyframes.ts";
import { fail, show } from "./messages.ts";
import { $, changed, findClip, S, st, trackOf, V } from "./state.ts";
import { dur, start } from "./time.ts";
import { openPath } from "./timeline.tsx";
import type { Clip } from "./types.ts";

// #insp and #ops are not drawn from st: what the user types there stays until they apply it or pick another clip.

export function select(id: string | null) {
  st.sel = id;
  const c = id ? findClip(id) : null;
  $<HTMLTextAreaElement>("insp").value = st.inspBase = c ? JSON.stringify(c, null, 2) : "";
  changed();
}

// ------------------------------------------------------------ compound clips (nested edits: expand, edit, regroup)
function groupIds(): string[] { return st.picked.length ? st.picked.slice() : st.sel && findClip(st.sel) && !V().nested ? [st.sel] : []; }

function expand() {
  const c = findClip(st.sel!)!;
  ops([{ op: "expand_compound", id: c.id }], "expand " + c.id).then((r) => { if (r) { st.picked = []; select(null); } });
}

function group() {
  const ids = groupIds();
  ops([{ op: "make_compound", ids }], "group " + ids.join(",")).then((r) => { if (r) { st.picked = []; select(r.results[0].id); } });
}

function regroup(g: string) {
  ops([{ op: "make_compound", from: g }], "regroup " + g).then((r) => { if (r) select(r.results[0].id); });
}

function applyClip() {
  const insp = $<HTMLTextAreaElement>("insp");
  let now;
  try { now = JSON.parse(insp.value); } catch (e) { return fail({ code: "bad_json", message: (e as Error).message }); }
  const { set, n } = clipPatch(JSON.parse(st.inspBase), now);
  if (!n) return show("ok", t("nothingChanged"));
  ops([{ op: "update_clip", id: st.sel, set }], "update " + st.sel).then((r) => { if (r) st.inspBase = insp.value; });
}

function applyOps() {
  let l;
  try { l = JSON.parse($<HTMLTextAreaElement>("ops").value); } catch (e) { return fail({ code: "bad_json", message: (e as Error).message }); }
  ops(Array.isArray(l) ? l : [l]);
}

// ------------------------------------------------------------ keyframes (every edit = one set_keyframes op per prop)
function setKf(c: Clip, prop: string, list: Kf[]) { return ops([{ op: "set_keyframes", id: c.id, prop, keyframes: packKf(list) }], "keyframes " + c.id + "." + prop); }

function addKey(c: Clip) {
  const p = st.kfProp, v = V(), lt = +Math.max(0, Math.min(dur(c), (st.t - v.off) / v.k - start(c))).toFixed(3), list = pts((c.keyframes || {})[p]);
  const val = list.length ? kfAt(list, lt) : kfBase(c, p, S().timeline.settings);
  setKf(c, p, list.filter((q) => !near(q[0], lt)).concat([[lt, val, undefined] as Kf]));
}

/** a key row's inputs changed: its time, value and easing are read from the row */
function commitKey(e: Event, c: Clip, p: string, list: Kf[], i: number) {
  const [ti, vi, ease] = (e.currentTarget as HTMLElement).parentElement!.children as unknown as [HTMLInputElement, HTMLInputElement, HTMLSelectElement];
  const nt = parseFloat(ti.value), nv = parseFloat(vi.value);
  if (!isFinite(nt) || !isFinite(nv)) return fail({ code: "bad_value", message: p + ": t and value must be numbers" });
  const next = list.slice(); next[i] = [nt, nv, ease.value]; setKf(c, p, next);
}

function Keyframes({ c, ro }: { c: Clip | null; ro: boolean }) {
  if (!c || c.type === "gap") return <div id="kfbox" />;
  const kf = c.keyframes || {};
  return (
    <div id="kfbox">
      <div class="row">
        <span class="mut">{t("keyframes")}</span>
        <select id="kfprop" disabled={ro} value={st.kfProp} onChange={(e) => { st.kfProp = e.currentTarget.value; }}>
          {ENUM.animatable.map((p) => <option value={p}>{p}</option>)}
        </select>
        <button id="kfadd" disabled={ro} onClick={() => addKey(c)}>{t("addKey")}</button>
      </div>
      {Object.keys(kf).map((p) => {
        const list = pts(kf[p]);
        return [
          <div key={p} class="row"><b>{p}</b><span class="mut">{t("kfCols")}</span><button title={t("clearTitle", p)} disabled={ro} onClick={() => setKf(c, p, [])}>{t("clear")}</button></div>,
          list.map((q, i) => (
            <div key={p + i} class="row kfrow">
              <input type="number" step="0.05" value={q[0]} title={t("kfTime")} disabled={ro} onChange={(e) => commitKey(e, c, p, list, i)} />
              <input type="number" step="0.05" value={q[1]} disabled={ro} onChange={(e) => commitKey(e, c, p, list, i)} />
              <select disabled={ro} value={q[2] || "linear"} onChange={(e) => commitKey(e, c, p, list, i)}>{ENUM.easings.map((n) => <option value={n}>{n}</option>)}</select>
              <button title={t("kfDelete")} disabled={ro} onClick={() => setKf(c, p, list.filter((_, j) => j !== i))}>×</button>
            </div>
          )),
        ];
      })}
    </div>
  );
}

function Out() {
  const o = st.out;
  return (
    <div id="out">
      {o && o.progress !== undefined && <progress id="prog" max={1} value={o.progress} />}
      {o && o.link && [<a href={o.link.url} target="_blank">{t("output", o.link.name)}</a>, <div class="mut">{o.link.info}</div>]}
      {o && o.sheet && <img src={o.sheet} title={t("openFull")} onClick={() => { window.open(o.sheet); }} />}
    </div>
  );
}

export function Side() {
  const v = st.S ? V() : null, nested = !!v && v.nested, c = st.S && st.sel ? findClip(st.sel) : null, cmp = !!c && c.type === "compound";
  const g = st.S ? groupIds() : [];
  return (
    <div id="side">
      <div class="mut" id="selinfo">{c ? t("selInfo", c.id, trackOf(c.id)!.id, c.type) + (nested ? t("insideCompound", st.path[st.path.length - 1]) : "") : t("selectClip")}</div>
      <textarea id="insp" spellcheck={false} placeholder={t("clipJson")} readOnly={nested} />
      <div><button id="applyc" disabled={!c || nested} onClick={applyClip}>{t("applyClip")}</button> <button id="delc" disabled={!c || nested} onClick={() => { ops([{ op: "remove_clip", id: st.sel }], "remove " + st.sel); }}>{t("deleteClip")}</button></div>
      <div id="cbtns">
        <button id="openc" style={{ display: cmp ? "" : "none" }} onClick={() => openPath(st.path.concat([st.sel!]))}>{t("openCompound")}</button>{" "}
        <button id="expc" style={{ display: cmp && !nested ? "" : "none" }} onClick={expand}>{t("expand")}</button>{" "}
        <button id="group" style={{ display: g.length && !nested ? "" : "none" }} onClick={group}>{t("group", g.length)}</button>{" "}
        <span id="regroups">{st.S && !nested && regroupIds(S().timeline.tracks).map((id) => <button key={id} data-group={id} onClick={() => regroup(id)}>{t("regroup", id)}</button>)}</span>
      </div>
      <Keyframes c={c} ro={nested} />
      <div id="msg" />
      <div class="mut">{t("opsHint")}</div>
      <textarea id="ops" spellcheck={false} placeholder='[{"op":"add_clip","track":"text","text":"Hi","at":0,"duration":2}]' />
      <div><button id="applyo" onClick={applyOps}>{t("applyOps")}</button></div>
      <Out />
    </div>
  );
}
