// The inspector's CapCut tabs: the fields people reach for, grouped (Basic, Audio, Speed, Animation, Colour), each a labelled slider with its number
// and, for an animatable field, a keyframe diamond. Every edit is the update_clip (or set_keyframes) the JSON tab would send.
import { useState } from "react";
import { Selector } from "@astryxdesign/core/Selector";
import { Slider } from "@astryxdesign/core/Slider";
import { Switch } from "@astryxdesign/core/Switch";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Diamond } from "lucide-react";
import { ops } from "./api.ts";
import { t, type Key } from "./i18n.ts";
import { kfAt, kfBase, near, packKf, pts, type Kf } from "./keyframes.ts";
import { blurOnEnter, ico, Num } from "./kit.tsx";
import { S, st, V } from "./state.ts";
import { dur, start } from "./time.ts";
import type { Clip, Dict } from "./types.ts";

const set = (c: Clip, s: Dict) => ops([{ op: "update_clip", id: c.id, set: s }], "update " + c.id);

/** the clip's local time at the playhead, inside the clip */
const localT = (c: Clip) => { const v = V(); return +Math.max(0, Math.min(dur(c), (st.t - v.off) / v.k - start(c))).toFixed(3); };

/** the keyframe diamond of an animatable prop: hollow with no keys, cyan with keys, gold with a key at the playhead; a click adds or removes that key
 *  (a new key takes the curve's value there, else the clip's own value: kfBase, as the More tab's "+ key" does) */
function KeyDiamond({ c, prop, ro }: { c: Clip; prop: string; ro: boolean }) {
  const list = pts((c.keyframes || {})[prop]), lt = localT(c), here = list.findIndex((q) => near(q[0], lt));
  const toggle = () => {
    const next: Kf[] = here >= 0 ? list.filter((_, i) => i !== here) : list.concat([[lt, list.length ? kfAt(list, lt) : kfBase(c, prop, S().timeline.settings), undefined]]);
    ops([{ op: "set_keyframes", id: c.id, prop, keyframes: packKf(next) }], "keyframes " + c.id + "." + prop);
  };
  const label = here >= 0 ? t("kfRemoveHere", prop) : t("kfAddHere", prop);
  return <button type="button" className={"kfd" + (here >= 0 ? " at" : list.length ? " on" : "")} title={label} aria-label={label} disabled={ro} onClick={toggle}>{ico(Diamond)}</button>;
}

/** One row: label, slider + number, and the keyframe diamond when the prop animates. The value commits when the drag ends or the number is typed.
 *  min, max, step and def are in the units the row shows (read maps the stored value to them, write maps back). */
function Prop({ c, k, label, min, max, step, def, ro, anim, read = (v) => v, write = (v) => v, unit = "" }: {
  c: Clip; k: string; label: string; min: number; max: number; step: number; def: number; ro: boolean; anim?: string;
  read?: (v: number) => number; write?: (v: number) => unknown; unit?: string;
}) {
  const stored = typeof c[k] === "number" ? read(c[k]) : def;
  const [v, setV] = useState(stored), [seen, setSeen] = useState(stored);
  if (stored !== seen) { setSeen(stored); setV(stored); } // a new value from the project replaces what the row shows
  const commit = (x: number) => { if (Number.isFinite(x) && x !== stored) set(c, { [k]: write(x) }); };
  const animated = !!anim && !!(c.keyframes || {})[anim];
  return (
    <div className="prop" data-prop={k}>
      <label>{label}</label>
      <div className="pval">
        <Slider label={label} isLabelHidden valueDisplay="none" min={min} max={max} step={step} value={Math.max(min, Math.min(max, v))} isDisabled={ro || animated}
          onChange={(x: number) => setV(x)} onChangeEnd={(x: number) => commit(x)} />
        <Num aria-label={label} step={step} value={String(+v.toFixed(3))} disabled={ro || animated}
          onChange={(e) => setV(+e.currentTarget.value)} onBlur={(e) => commit(+e.currentTarget.value)} onKeyDown={blurOnEnter} />
      </div>
      {anim ? <KeyDiamond c={c} prop={anim} ro={ro} /> : <span>{unit}</span>}
    </div>
  );
}

/** a named-value field as a list (none clears it) */
function Choice({ c, k, label, list, ro, read = (x) => x, write = (x) => x }: { c: Clip; k: string; label: string; list: string[]; ro: boolean; read?: (x: unknown) => unknown; write?: (x: string | null) => unknown }) {
  const v = read(c[k]);
  return (
    <div className="prop"><label>{label}</label>
      <div className="pval one"><Selector label={label} isLabelHidden size="sm" hasClear value={typeof v === "string" ? v : null} options={list} hasSearch={list.length > 12} isDisabled={ro} onChange={(x) => set(c, { [k]: write(x) })} width="100%" /></div><span />
    </div>
  );
}

function Toggle({ c, k, label, ro, on = false }: { c: Clip; k: string; label: string; ro: boolean; on?: boolean }) {
  const v = on ? c[k] !== false : c[k] === true;
  return <div className="prop"><label>{label}</label><div className="pval one"><Switch label={label} isLabelHidden size="sm" value={v} isDisabled={ro} onChange={(x) => set(c, { [k]: on ? (x ? null : false) : x || null })} /></div><span /></div>;
}

const visual = (c: Clip) => c.type !== "audio" && c.type !== "gap";
const sounds = (c: Clip) => c.type === "video" || c.type === "audio" || c.type === "compound";
const named = (x: unknown) => (typeof x === "string" ? x : x && typeof x === "object" ? (x as Dict).type : undefined);

function Group({ title, children }: { title: Key; children: React.ReactNode }) {
  return <div className="pgroup"><div className="ihead">{t(title)}</div>{children}</div>;
}

export const PROP_TABS = [
  { id: "basic", label: "tabBasic" as Key, has: (c: Clip) => c.type !== "gap" },
  { id: "audio", label: "tabAudio" as Key, has: sounds },
  { id: "speed", label: "tabSpeed" as Key, has: (c: Clip) => c.type === "video" || c.type === "audio" || c.type === "compound" || c.type === "lottie" },
  { id: "anim", label: "tabAnim" as Key, has: visual },
  { id: "color", label: "tabColor" as Key, has: (c: Clip) => c.type === "video" || c.type === "image" },
];

export function PropTab({ c, tab, ro }: { c: Clip; tab: string; ro: boolean }) {
  const W = S().timeline.settings.width, H = S().timeline.settings.height, g = (c.color && typeof c.color === "object" ? c.color : {}) as Dict;
  const grade = (k: string, label: string, min: number, max: number, def: number) => (
    <div className="prop" key={k}><label>{label}</label>
      <div className="pval"><GradeSlider c={c} k={k} min={min} max={max} def={def} value={typeof g[k] === "number" ? g[k] : def} ro={ro} label={label} /></div><span />
    </div>
  );
  if (tab === "basic") return (
    <>
      {c.type === "text" && (
        <Group title="grpText">
          <TextBox c={c} ro={ro} />
          <Prop c={c} k="font_size" label={t("pSize")} min={8} max={400} step={1} def={72} ro={ro} />
          <Choice c={c} k="align" label={t("pAlign")} list={["left", "center", "right"]} ro={ro} />
        </Group>
      )}
      {visual(c) && (
        <Group title="grpTransform">
          <Prop c={c} k="scale" label={t("pScale")} min={5} max={500} step={1} def={100} ro={ro} anim="scale" read={(v) => v * 100} write={(v) => +(v / 100).toFixed(4)} unit="%" />
          <Prop c={c} k="x" label="X" min={0} max={W} step={1} def={W / 2} ro={ro} anim="x" />
          <Prop c={c} k="y" label="Y" min={0} max={H} step={1} def={H / 2} ro={ro} anim="y" />
          <Prop c={c} k="rotation" label={t("pRotate")} min={-180} max={180} step={1} def={0} ro={ro} anim="rotation" unit="°" />
          <Prop c={c} k="opacity" label={t("pOpacity")} min={0} max={100} step={1} def={100} ro={ro} anim="opacity" read={(v) => v * 100} write={(v) => +(v / 100).toFixed(3)} unit="%" />
        </Group>
      )}
      {visual(c) && (
        <Group title="grpBlend">
          <Choice c={c} k="blend" label={t("pBlend")} list={FORM.enums.blend} ro={ro} />
          {(c.type === "video" || c.type === "image") && <Choice c={c} k="fit" label={t("pFit")} list={FORM.enums.fit} ro={ro} />}
          <Choice c={c} k="position" label={t("pPosition")} list={FORM.enums.position} ro={ro} />
        </Group>
      )}
      <Group title="grpClip"><Toggle c={c} k="enabled" label={t("pEnabled")} ro={ro} on /></Group>
    </>
  );
  if (tab === "audio") return (
    <Group title="tabAudio">
      <Prop c={c} k="volume" label={t("pVolume")} min={0} max={400} step={1} def={100} ro={ro} anim="volume" read={(v) => v * 100} write={(v) => +(v / 100).toFixed(3)} unit="%" />
      <Prop c={c} k="fade_in" label={t("pFadeIn")} min={0} max={10} step={0.1} def={0} ro={ro} unit="s" />
      <Prop c={c} k="fade_out" label={t("pFadeOut")} min={0} max={10} step={0.1} def={0} ro={ro} unit="s" />
      <Prop c={c} k="pan" label={t("pPan")} min={-1} max={1} step={0.05} def={0} ro={ro} />
      <Prop c={c} k="pitch" label={t("pPitch")} min={-12} max={12} step={1} def={0} ro={ro} />
      <Toggle c={c} k="muted" label={t("pMute")} ro={ro} />
      <Toggle c={c} k="denoise" label={t("pDenoise")} ro={ro} />
      <Choice c={c} k="eq" label="EQ" list={FORM.enums.eq} ro={ro} read={named} />
      <Choice c={c} k="compressor" label={t("pCompressor")} list={FORM.enums.compressor} ro={ro} read={named} />
    </Group>
  );
  if (tab === "speed") return (
    <Group title="tabSpeed">
      <Prop c={c} k="speed" label={t("pSpeed")} min={0.1} max={8} step={0.05} def={1} ro={ro || !!(c.keyframes || {}).speed} unit="×" />
      {c.type === "video" && <Toggle c={c} k="reverse" label={t("pReverse")} ro={ro} />}
      {(c.type === "video" || c.type === "lottie") && <Toggle c={c} k="loop" label={t("pLoop")} ro={ro} on={c.type === "lottie"} />}
      {(c.keyframes || {}).speed && <div className="mut">{t("speedRamp")}</div>}
    </Group>
  );
  if (tab === "anim") return (
    <>
      <Group title="grpIn"><Choice c={c} k="enter" label={t("pIn")} list={FORM.enums.enter} ro={ro} read={named} /></Group>
      <Group title="grpOut"><Choice c={c} k="exit" label={t("pOut")} list={FORM.enums.exit} ro={ro} read={named} /></Group>
      <Group title="grpLoop"><Choice c={c} k="motion" label={t("pMotion")} list={FORM.enums.motion} ro={ro} read={named} /></Group>
      <Group title="grpTransition"><Choice c={c} k="transition" label={t("pTransition")} list={FORM.enums.transition} ro={ro} read={named} /></Group>
    </>
  );
  return (
    <>
      <Group title="grpLook">
        <div className="prop"><label>{t("pLook")}</label>
          <div className="pval one"><Selector label={t("pLook")} isLabelHidden size="sm" hasClear value={typeof g.look === "string" ? g.look : null} options={FORM.enums.look} isDisabled={ro} onChange={(x) => set(c, { color: { look: x } })} width="100%" /></div><span />
        </div>
      </Group>
      <Group title="grpAdjust">
        {grade("exposure", t("cExposure"), -3, 3, 0)}
        {grade("contrast", t("cContrast"), 0, 3, 1)}
        {grade("saturation", t("cSaturation"), 0, 3, 1)}
        {grade("vibrance", t("cVibrance"), -2, 2, 0)}
        {grade("temperature", t("cTemperature"), -1, 1, 0)}
        {grade("tint", t("cTint"), -1, 1, 0)}
      </Group>
    </>
  );
}

/** a colour grade number: merged into the grade by update_clip */
function GradeSlider({ c, k, min, max, def, value, ro, label }: { c: Clip; k: string; min: number; max: number; def: number; value: number; ro: boolean; label: string }) {
  const [v, setV] = useState(value), [seen, setSeen] = useState(value);
  if (value !== seen) { setSeen(value); setV(value); }
  const commit = (x: number) => { if (Number.isFinite(x) && x !== value) set(c, { color: { [k]: x === def ? null : +x.toFixed(3) } }); };
  return (
    <>
      <Slider label={label} isLabelHidden valueDisplay="none" min={min} max={max} step={0.01} value={Math.max(min, Math.min(max, v))} isDisabled={ro} onChange={(x: number) => setV(x)} onChangeEnd={commit} />
      <Num aria-label={label} step={0.01} value={String(+v.toFixed(2))} disabled={ro}
        onChange={(e) => setV(+e.currentTarget.value)} onBlur={(e) => commit(+e.currentTarget.value)} onKeyDown={blurOnEnter} />
    </>
  );
}

/** a text clip's words: committed when the box is left */
function TextBox({ c, ro }: { c: Clip; ro: boolean }) {
  const [v, setV] = useState(String(c.text ?? "")), [seen, setSeen] = useState(c.text);
  if (c.text !== seen) { setSeen(c.text); setV(String(c.text ?? "")); }
  return <TextArea label={t("grpText")} isLabelHidden rows={3} value={v} isDisabled={ro} onChange={setV} onBlur={() => { if (v !== c.text) set(c, { text: v }); }} />;
}
