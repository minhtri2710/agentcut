import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Selector } from "@astryxdesign/core/Selector";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Boxes, Braces, FolderOpen, Group, MousePointerClick, Plus, SquareStack, Trash2, Ungroup, X } from "lucide-react";
import { ops } from "./api.ts";
import { clipPatch, regroupIds } from "./edits.ts";
import { t } from "./i18n.ts";
import { kfAt, kfBase, near, packKf, pts, type Kf } from "./keyframes.ts";
import { blurOnEnter, ico, Num } from "./kit.tsx";
import { fail, show } from "./messages.ts";
import { $, changed, findClip, S, st, trackOf, V } from "./state.ts";
import { dur, start } from "./time.ts";
import { Out } from "./export.tsx";
import { ClipForm } from "./form.tsx";
import { PROP_TABS, PropTab } from "./props.tsx";
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

/** one field of a key row changed: the row keeps its other two */
function commitKey(c: Clip, p: string, list: Kf[], i: number, part: Partial<{ t: number; v: number; ease: string }>) {
  const [t0, v0, e0] = list[i], next = list.slice();
  next[i] = [part.t ?? t0, part.v ?? v0, part.ease ?? e0 ?? "linear"];
  setKf(c, p, next);
}

function Keyframes({ c, ro }: { c: Clip | null; ro: boolean }) {
  if (!c || c.type === "gap") return <div id="kfbox" />;
  const kf = c.keyframes || {};
  return (
    <div id="kfbox" className="isec">
      <div className="ihead">{t("keyframes")}</div>
      <div className="row">
        <Selector id="kfprop" label={t("keyframes")} isLabelHidden size="sm" isDisabled={ro} value={st.kfProp} options={ENUM.animatable} onChange={(v) => { st.kfProp = v!; changed(); }} width="100%" />
        <Button id="kfadd" size="sm" icon={ico(Plus)} label={t("addKey")} isDisabled={ro} onClick={() => addKey(c)} />
      </div>
      {Object.keys(kf).map((p) => {
        const list = pts(kf[p]), key = c.id + "." + p + "=" + JSON.stringify(list); // a new value from the project replaces the row's inputs
        return (
          <div key={p} className="kfprop">
            <div className="row"><Badge label={p} /><span className="mut grow">{t("kfCols")}</span>
              <IconButton size="sm" variant="ghost" label={t("clearTitle", p)} icon={ico(Trash2)} isDisabled={ro} onClick={() => setKf(c, p, [])} /></div>
            {list.map((q, i) => (
              <div key={key + i} className="kfrow">
                <Num data-col="t" aria-label={t("kfTime")} step={0.05} defaultValue={q[0]} disabled={ro} onKeyDown={blurOnEnter}
                  onBlur={(e) => { const x = e.currentTarget.valueAsNumber; if (Number.isFinite(x) && x !== q[0]) commitKey(c, p, list, i, { t: x }); }} />
                <Num data-col="v" aria-label={p} step={0.05} defaultValue={q[1]} disabled={ro} onKeyDown={blurOnEnter}
                  onBlur={(e) => { const x = e.currentTarget.valueAsNumber; if (Number.isFinite(x) && x !== q[1]) commitKey(c, p, list, i, { v: x }); }} />
                <Selector data-col="ease" size="sm" label="easing" isLabelHidden value={q[2] || "linear"} options={ENUM.easings} isDisabled={ro} onChange={(v) => commitKey(c, p, list, i, { ease: v! })} />
                <IconButton data-col="del" size="sm" variant="ghost" label={t("kfDelete")} icon={ico(X)} isDisabled={ro} onClick={() => setKf(c, p, list.filter((_, j) => j !== i))} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

export function Side() {
  const v = st.S ? V() : null, nested = !!v && v.nested, c = st.S && st.sel ? findClip(st.sel) : null, cmp = !!c && c.type === "compound";
  const g = st.S ? groupIds() : [];
  // CapCut's tabs for the clip's type, then More: every field (the full form), the JSON and the keyframe list
  const tabs = c ? PROP_TABS.filter((x) => x.has(c)).concat([{ id: "more", label: "tabMore", has: () => true }]) : [];
  const tab = tabs.some((x) => x.id === st.inspTab) ? st.inspTab : tabs[0]?.id ?? "basic";
  return (
    <aside id="side">
      <div className="ihead" id="selinfo">{c ? t("selInfo", c.id, trackOf(c.id)!.id, c.type) + (nested ? t("insideCompound", st.path[st.path.length - 1]) : "") : t("selectClip")}</div>
      {c && (
        <TabList value={tab} size="sm" hasDivider onChange={(x) => { st.inspTab = x; changed(); }}>
          {tabs.map((x) => <Tab key={x.id} id={"itab-" + x.id} value={x.id} label={t(x.label)} />)}
        </TabList>
      )}
      <div id="sidebody">
      {!c && <EmptyState isCompact icon={ico(MousePointerClick)} title={t("inspector")} description={t("inspectorHint")} />}
      {c && tab !== "more" && <PropTab c={c} tab={tab} ro={nested} />}
      {c && tab === "more" && c.type !== "gap" && <ClipForm c={c} ro={nested} />}
      <div className="isec" style={{ display: c && tab === "more" ? "" : "none" }}>
        <div className="ihead">{ico(Braces)} {t("jsonTab")}</div>
        <textarea id="insp" className="code" spellCheck={false} placeholder={t("clipJson")} readOnly={nested} />
        <div className="row"><Button id="applyc" size="sm" variant="primary" label={t("applyClip")} isDisabled={!c || nested} onClick={applyClip} /></div>
      </div>
      <div className="row wrap" id="cbtns">
        <Button id="delc" size="sm" variant="destructive" icon={ico(Trash2)} label={t("deleteClip")} style={{ display: c ? "" : "none" }} isDisabled={!c || nested} onClick={() => { ops([{ op: "remove_clip", id: st.sel }], "remove " + st.sel); }} />
        <Button id="openc" size="sm" icon={ico(FolderOpen)} label={t("openCompound")} style={{ display: cmp ? "" : "none" }} onClick={() => openPath(st.path.concat([st.sel!]))} />
        <Button id="expc" size="sm" icon={ico(Ungroup)} label={t("expand")} style={{ display: cmp && !nested ? "" : "none" }} onClick={expand} />
        <Button id="group" size="sm" icon={ico(Group)} label={t("group", g.length)} style={{ display: g.length && !nested ? "" : "none" }} onClick={group} />
        <span id="regroups">{st.S && !nested && regroupIds(S().timeline.tracks).map((id) => <Button key={id} data-group={id} size="sm" icon={ico(Boxes)} label={t("regroup", id)} onClick={() => regroup(id)} />)}</span>
      </div>
      <div style={{ display: !c || tab === "more" ? "" : "none" }}><Keyframes c={c} ro={nested} /></div>
      <div className="isec" id="opsbox" style={{ display: !c || tab === "more" ? "" : "none" }}>
        <div className="ihead">{ico(Braces)} {t("opsTitle")}</div>
        <div className="mut">{t("opsHint")}</div>
        <textarea id="ops" className="code" spellCheck={false} placeholder='[{"op":"add_clip","track":"text","text":"Hi","at":0,"duration":2}]' />
        <div className="row"><Button id="applyo" size="sm" icon={ico(SquareStack)} label={t("applyOps")} onClick={applyOps} /></div>
      </div>
      <Out />
      </div>
    </aside>
  );
}
