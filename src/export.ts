// Interchange export: FCPXML (Final Cut Pro) and OpenTimelineIO (.otio: DaVinci Resolve, Premiere via plugin, Avid...).
// Pure functions over an already resolved + absolutized timeline (no Skia, node: APIs only). The agent builds the edit,
// a human finishes it in an NLE. Only the editorial skeleton travels: cuts, source ranges, transitions, constant speed,
// volume, titles. The result reports two lists of {id, type, reason}: `skipped` names what is not exported (a clip, or named
// fields of an exported clip: looks, effects, keyframes, masks, generators) and `approximated` names what is exported in another form.
//
// Transitions: AgentCut overlaps clip B onto clip A by d. NLEs keep clips contiguous and let the transition borrow media
// handles, so the cut goes to the overlap midpoint: A loses ceil(d/2) at its end, B starts floor(d/2) later in its
// source (in += floor(d/2) * speed), and a transition of duration d is centred on the cut.
import { audioSources, voiceSpans } from "./audio.ts";
import { AUDIO_FX_KEYS } from "./audiofx.ts";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { own } from "./own.ts";
import { allClips, clipDur, clipStart, type Clip, type Dict, EditError, type Issue, normAnim, parseColor, parseTime, pastEnd, type Timeline, type Track } from "./model.ts";
import { refuseSource } from "./project.ts";
import { writeFile } from "./safe-write.ts";

export interface Skipped { id: string; type: string; reason: string } // one entry of `skipped` or `approximated`
export type InterchangeFormat = "fcpxml" | "otio";

// ------------------------------------------------------------------ time
interface Rate { fps: number; num: number; den: number; ntsc: boolean } // frameDuration = num/den seconds
export function rateOf(fps: unknown): Rate {
  const f = Number(fps) > 0 ? Number(fps) : 30;
  const r = Math.round(f);
  if (Math.abs(r - f) > 1e-3 && Math.abs(f - (r * 1000) / 1001) < 5e-3) return { fps: (r * 1000) / 1001, num: 1001, den: r * 1000, ntsc: true };
  const den = Math.round(f * 100);
  return { fps: den / 100, num: 100, den, ntsc: false };
}
const gcd = (a: number, b: number): number => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a || 1; };
/** Rational seconds string "n/ds" (reduced; whole seconds as "ns"). */
function rat(n: number, d: number): string {
  if (!n) return "0s";
  const g = gcd(n, d);
  return d / g === 1 ? `${n / g}s` : `${n / g}/${d / g}s`;
}
/** speed as a fraction p/q (q <= 1000) so retimed values stay exact rationals. */
function frac(x: number): [number, number] {
  for (const q of [1, 2, 4, 5, 8, 10, 20, 25, 50, 100, 1000]) { const p = x * q; if (Math.abs(p - Math.round(p)) < 1e-9) return [Math.round(p), q]; }
  return [Math.round(x * 1000), 1000];
}

// ------------------------------------------------------------------ plan (shared by both formats)
type Kind = "media" | "still" | "title" | "gap";
interface Placed {
  c: Clip; tr: Track; kind: Kind;
  start: number; dur: number;         // timeline frames (after transition trims)
  srcIn: number;                       // source in-point, frames at the timeline rate, after the head trim
  speed: number;
  video: boolean; audio: boolean;      // which components of the source are used
  volume: number; enabled: boolean;
}
interface Trans { cut: number; left: number; right: number; name: string; id: string } // left = before cut (in_offset)
interface Spine { entries: Placed[]; trans: (Trans | null)[] } // trans[i] sits between entries[i-1] and entries[i]
interface Lane { track: Track; lane: number; items: Placed[] }
interface Plan {
  rate: Rate; total: number; main: Track | null; spine: Spine;
  above: Lane[]; below: Lane[];       // FCPXML lanes (+1.. above the storyline, -1.. below / audio)
  videoLanes: Lane[]; audioLanes: Lane[]; // OTIO tracks (bottom -> top), main included
  skipped: Skipped[]; approximated: Skipped[]; exported: Set<string>;
}

const LAYOUT = ["x", "y", "position", "size", "scale", "scale_x", "scale_y", "rotation", "crop", "focus", "margin"];
const DROPPED: Record<string, string> = {
  effects: "effects", filters: "filters", color: "colour grade", keyframes: "keyframes", mask: "mask", motion: "motion", enter: "enter animation",
  exit: "exit animation", border: "border", shadow: "shadow", radius: "rounded corners", reverse: "reverse", freeze: "freeze",
  loop: "loop", remove_background: "background removal", gradient: "gradient", glow: "glow", background: "text background",
  denoise: "denoise", eq: "audio eq", compressor: "compressor", pan: "pan", pitch: "pitch", normalize: "normalize",
};

function buildPlan(tl: Timeline, fmt: InterchangeFormat): Plan {
  const rate = rateOf(tl.settings?.fps);
  const F = (sec: number) => Math.round(sec * rate.fps + 1e-9);
  const skipped: Skipped[] = [], approximated: Skipped[] = [];
  const exported = new Set<string>();
  const assets = tl.assets || {};
  const tracks = tl.tracks || [];
  const mi = tracks.findIndex((t) => t.magnetic && (t.kind ?? "video") !== "audio");
  const main = mi >= 0 ? tracks[mi] : null;

  const notes = (c: Clip, kind: Kind) => {
    const lost: string[] = [];
    for (const [k, label] of Object.entries(DROPPED)) {
      const v = c[k];
      if (k === "color" && kind === "title") continue; // a title's colour is its fill, not a grade
      if (v === undefined || v === null || v === false || v === "none" || (Array.isArray(v) && !v.length)) continue;
      if (k === "keyframes" && kind === "media" && !Object.keys(v).some((x) => x !== "speed")) continue; // a speed ramp is listed as approximated
      lost.push(label);
    }
    if (LAYOUT.some((k) => c[k] !== undefined && c[k] !== null) && kind !== "gap") lost.push("layout (position/size/scale/rotation/crop)");
    if (c.blend && c.blend !== "normal") lost.push(`blend '${c.blend}'`);
    // FCPXML conform types are fit / fill / none: blur gets the conform of contain, and fill (stretch) the conform of cover. OTIO has no conform, so the NLE's default applies
    const fitTo = fmt === "fcpxml" ? own({ blur: "fit 'contain'", fill: "fit 'cover'" }, c.fit) : c.fit && c.fit !== "cover" ? "the NLE's default fit" : undefined;
    if (fitTo) approximated.push({ id: c.id, type: "fit", reason: `fit '${c.fit}' exported as ${fitTo}${c.fit === "blur" ? " (the blurred background is not carried)" : ""}` });
    if (fmt === "otio") {
      if (c.opacity !== undefined && c.opacity !== 1) lost.push("opacity");
      if (c.fade_in || c.fade_out) lost.push("audio fades");
    }
    if (lost.length) skipped.push({ id: c.id, type: "fields", reason: `not exported: ${[...new Set(lost)].join(", ")}` });
  };

  /** Classify a clip; returns null (and records why) when it cannot be exported. */
  const place = (c: Clip, tr: Track, start: number, end: number, head = 0): Placed | null => {
    const audioTrack = (tr.kind ?? "video") === "audio";
    const enabled = c.enabled !== false && !(tr.hidden && !audioTrack) && !(tr.muted && audioTrack);
    const base = { c, tr, start, dur: end - start, srcIn: 0, speed: 1, video: false, audio: false, volume: 1, enabled };
    if (c.type === "gap") return { ...base, kind: "gap" };
    if (audioTrack && c.type !== "audio" && c.type !== "video") { skipped.push({ id: c.id, type: c.type, reason: "visual clip on an audio track (not drawn)" }); return null; }
    if (c.type === "text") {
      if (!String(c.text ?? "").trim()) { skipped.push({ id: c.id, type: c.type, reason: "empty text" }); return null; }
      if (fmt === "otio") approximated.push({ id: c.id, type: "text", reason: "OTIO has no titles: exported as a named Gap with metadata.agentcut (text, font, colour)" });
      notes(c, "title");
      return { ...base, kind: "title", video: true };
    }
    if (c.type === "video" || c.type === "image" || c.type === "audio") {
      const a = assets[c.asset];
      if (!a || !a.path) { skipped.push({ id: c.id, type: c.type, reason: `asset '${c.asset}' missing` }); return null; }
      if (a.kind === "lottie") { skipped.push({ id: c.id, type: c.type, reason: "Lottie animations have no NLE equivalent" }); return null; }
      if (a.kind === "image" || c.type === "image") {
        if (audioTrack) return null;
        notes(c, "still");
        return { ...base, kind: "still", video: true, volume: 1 };
      }
      const speed = Number(c.speed ?? 1) || 1;
      if (c.keyframes?.speed) approximated.push({ id: c.id, type: "speed_ramp", reason: `speed keyframes exported as constant speed ${speed}` });
      const hasAudio = a.kind === "audio" || !!a.has_audio;
      const wantVideo = a.kind === "video" && c.type === "video" && !audioTrack;
      const wantAudio = hasAudio && !c.muted && !(tr.muted && !audioTrack) && (c.volume ?? 1) > 0;
      if (!wantVideo && !wantAudio) { skipped.push({ id: c.id, type: c.type, reason: hasAudio ? "muted: nothing left to export" : "no audio stream" }); return null; }
      notes(c, "media");
      const inF = F(parseTime(c.in ?? 0));
      return {
        ...base, kind: "media", srcIn: inF + head * speed, speed, video: wantVideo, audio: wantAudio,
        volume: Number(c.volume ?? 1) * Number(tr.volume ?? 1),
      };
    }
    const why: Record<string, string> = {
      captions: "animated captions have no NLE equivalent (re-create from the transcript / SRT)",
      shape: "shape generators are not exported", color: "colour/gradient generators are not exported",
      lottie: "Lottie animations have no NLE equivalent", compound: "compound clips are not exported yet (expand_compound first)",
    };
    skipped.push({ id: c.id, type: String(c.type), reason: own(why, c.type) ?? `unknown clip type '${c.type}'` });
    return null;
  };

  // ---- primary storyline (spine)
  const spine: Spine = { entries: [], trans: [] };
  let total = 0;
  for (const tr of tracks) for (const c of tr.clips || []) if (c.enabled !== false || tr === main) total = Math.max(total, F(clipStart(c) + clipDur(c)));
  if (tl.settings?.duration) total = F(parseTime(tl.settings.duration));
  if (main) {
    const cs = main.clips || [];
    const S = cs.map((c) => F(clipStart(c))), E = cs.map((c) => F(clipStart(c) + clipDur(c)));
    // raw overlaps (frames) between consecutive clips; cut at the overlap midpoint
    const ov = cs.map((c, i) => (i > 0 ? Math.max(0, E[i - 1] - S[i]) : 0));
    const cutStart = cs.map((_, i) => S[i] + Math.floor(ov[i] / 2));
    const cutEnd = cs.map((_, i) => (i + 1 < cs.length && ov[i + 1] > 0 ? cutStart[i + 1] : E[i]));
    let t = 0;
    cs.forEach((c, i) => {
      if (cutStart[i] > t) { spine.entries.push(gapEntry(main, t, cutStart[i])); spine.trans.push(null); }
      if (cutEnd[i] <= cutStart[i]) { skipped.push({ id: c.id, type: c.type, reason: "too short after transition trims" }); return; }
      const head = cutStart[i] - S[i];
      let p = place(c, main, cutStart[i], cutEnd[i], head);
      if (p && p.kind === "media" && !p.video) approximated.push({ id: c.id, type: c.type, reason: "audio-only clip on the primary storyline exported as a gap" });
      if (!p || p.kind === "gap" || (p.kind === "media" && !p.video)) {
        p = gapEntry(main, cutStart[i], cutEnd[i]);
        p.c = { id: c.id, type: "gap", duration: 0, name: c.type === "gap" ? c.name : `${c.name ?? c.id} (${c.type})` };
      }
      let tr: Trans | null = null;
      const spec = i > 0 && ov[i] > 0 ? normAnim(c.transition, 0.5) : null;
      if (ov[i] > 0 && spine.entries.length) {
        const name = spec?.type ?? "crossfade";
        tr = { cut: cutStart[i], left: Math.floor(ov[i] / 2), right: ov[i] - Math.floor(ov[i] / 2), name, id: c.id };
        if (name !== "crossfade") approximated.push({ id: c.id, type: "transition", reason: `'${name}' exported as a cross dissolve` });
      }
      spine.entries.push(p);
      spine.trans.push(tr);
      if (p.kind !== "gap") exported.add(c.id);
      t = cutEnd[i];
    });
    // clamp transitions that would overlap each other or exceed their clips (NLEs reject that)
    for (let i = 1; i < spine.entries.length; i++) {
      const tr = spine.trans[i];
      if (!tr) continue;
      const prev = spine.entries[i - 1], cur = spine.entries[i];
      const prevUsed = spine.trans[i - 1]?.right ?? 0;
      const left = Math.max(0, Math.min(tr.left, prev.dur - prevUsed)), right = Math.max(0, Math.min(tr.right, cur.dur));
      if (left !== tr.left || right !== tr.right) approximated.push({ id: tr.id, type: "transition", reason: `exported shortened to ${left + right} frames so it fits its clips` });
      tr.left = left; tr.right = right;
      if (left + right === 0) spine.trans[i] = null;
    }
    if (spine.entries.length) total = Math.max(total, spine.entries.at(-1)!.start + spine.entries.at(-1)!.dur);
  }
  const spineEnd = spine.entries.length ? spine.entries.at(-1)!.start + spine.entries.at(-1)!.dur : 0;
  if (spineEnd < total || !spine.entries.length) { spine.entries.push(gapEntry(main, spineEnd, Math.max(total, spineEnd + 1))); spine.trans.push(null); }

  // ---- other tracks -> lanes
  const above: Lane[] = [], below: Lane[] = [], videoLanes: Lane[] = [], audioLanes: Lane[] = [];
  let up = 1, down = -1;
  const order = [...tracks.keys()];
  const belowIdx = mi >= 0 ? order.filter((i) => i < mi && (tracks[i].kind ?? "video") !== "audio").reverse() : [];
  const aboveIdx = order.filter((i) => i !== mi && !belowIdx.includes(i) && (tracks[i].kind ?? "video") !== "audio");
  const audioIdx = order.filter((i) => (tracks[i].kind ?? "video") === "audio");
  const lanesOf = new Map<number, Placed[][]>();
  for (const ti of order) {
    if (ti === mi) continue;
    const tr = tracks[ti];
    const placed: Placed[] = [];
    for (const c of tr.clips || []) {
      if (c.type === "gap") continue;
      const s = F(clipStart(c)), e = F(clipStart(c) + clipDur(c));
      if (e <= s) continue;
      const p = place(c, tr, s, e);
      if (!p) continue;
      if (c.transition && normAnim(c.transition, 0.5)) skipped.push({ id: c.id, type: "transition", reason: "transitions are only exported on the primary (magnetic) storyline" });
      placed.push(p);
      exported.add(c.id);
    }
    placed.sort((a, b) => a.start - b.start);
    const lanes: Placed[][] = []; // greedy interval colouring: overlapping clips go to extra lanes
    for (const p of placed) {
      let l = lanes.find((ln) => ln.at(-1)!.start + ln.at(-1)!.dur <= p.start);
      if (!l) lanes.push((l = []));
      l.push(p);
    }
    lanesOf.set(ti, lanes);
  }
  for (const ti of aboveIdx) for (const items of lanesOf.get(ti) ?? []) above.push({ track: tracks[ti], lane: up++, items });
  for (const ti of [...belowIdx, ...audioIdx]) for (const items of lanesOf.get(ti) ?? []) below.push({ track: tracks[ti], lane: down--, items });
  for (const ti of order) {
    const tr = tracks[ti];
    if (ti === mi) { videoLanes.push({ track: tr, lane: 0, items: spine.entries }); continue; }
    for (const [k, items] of (lanesOf.get(ti) ?? []).entries()) ((tr.kind ?? "video") === "audio" ? audioLanes : videoLanes).push({ track: tr, lane: k, items });
  }
  // per exported clip: a volume OTIO keeps only as metadata, and a range that runs past its source (loop, freeze and a speed ramp are not exported, so the range written is in + duration x speed)
  for (const ln of [...videoLanes, ...audioLanes]) for (const p of ln.items) {
    if (p.kind !== "media") continue;
    if (fmt === "otio" && p.audio && p.volume !== 1) approximated.push({ id: p.c.id, type: "volume", reason: `volume ${+p.volume.toFixed(4)} (${db(p.volume)}) is written only to metadata.agentcut: OTIO has no gain field, set it in the NLE` });
    const a = assets[p.c.asset], need = (p.srcIn + p.dur * p.speed) / rate.fps, over: Issue[] = [];
    if (typeof a.duration === "number" && a.duration > 0) pastEnd(over, "", p.c.asset, a, need, "");
    if (over.length) approximated.push({ id: p.c.id, type: "source_length", reason: `clip ${p.c.id} needs ${+need.toFixed(2)} s, source has ${+a.duration!.toFixed(2)} s` });
  }
  for (const c of allClips(tracks)) {
    const ops = Object.keys(c.pending ?? {});
    if (ops.length) skipped.push({ id: c.id, type: "pending", reason: `${ops.join(", ")} requested and not prepared, so the keyframes it would write do not exist yet; keyframes are never exported anyway (re-create the motion in the NLE)` });
  }
  for (const [k, v] of Object.entries(tl.settings || {}))
    if (k === "effects" && Array.isArray(v) && v.length) skipped.push({ id: "settings", type: "effects", reason: "whole-frame effects are not exported" });
  // track settings matter only on a track that feeds the mix: an empty, muted or silent track's duck or audio processing changes nothing
  const used = tracks.filter((tr) => audioSources({ ...tl, tracks: [tr] }).length);
  // the mix ducks only under voice/dialogue clips, and never a voice or dialogue track
  const voiced = voiceSpans(tl).length > 0;
  for (const tr of used) if (tr.duck && voiced && tr.role !== "voice" && tr.role !== "dialogue") skipped.push({ id: tr.id, type: "duck", reason: "auto-ducking is not exported (set volume keyframes in the NLE)" });
  for (const tr of used) {
    const fx = AUDIO_FX_KEYS.filter((k) => tr[k] !== undefined && tr[k] !== null && tr[k] !== false);
    if (fx.length) skipped.push({ id: tr.id, type: "audio_fx", reason: `track audio processing not exported: ${fx.join(", ")}` });
  }
  return { rate, total, main, spine, above, below, videoLanes, audioLanes, skipped, approximated, exported };

  function gapEntry(tr: Track | null, s: number, e: number): Placed {
    return { c: { id: "gap", type: "gap", duration: 0 }, tr: tr ?? tracks[0], kind: "gap", start: s, dur: e - s, srcIn: 0, speed: 1, video: false, audio: false, volume: 1, enabled: true };
  }
}

// ------------------------------------------------------------------ XML helpers
type Attrs = Record<string, string | number | undefined | null>;
interface XEl { tag: string; attrs: Attrs; kids: (XEl | string)[] }
const X = (tag: string, attrs: Attrs = {}, ...kids: (XEl | string | null | undefined | false)[]): XEl =>
  ({ tag, attrs, kids: kids.filter((k): k is XEl | string => !!k || k === "") });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function ser(e: XEl, ind = ""): string {
  const a = Object.entries(e.attrs).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => ` ${k}="${esc(String(v))}"`).join("");
  if (!e.kids.length) return `${ind}<${e.tag}${a}/>`;
  if (e.kids.every((k) => typeof k === "string") || e.tag === "text" || e.tag === "text-style")
    return `${ind}<${e.tag}${a}>${e.kids.map((k) => (typeof k === "string" ? escText(k) : ser(k))).join("")}</${e.tag}>`;
  return `${ind}<${e.tag}${a}>\n${e.kids.map((k) => (typeof k === "string" ? ind + "  " + escText(k) : ser(k, ind + "  "))).join("\n")}\n${ind}</${e.tag}>`;
}

const fileUrl = (p: string) => pathToFileURL(p).href;
const db = (v: number) => (v <= 0 ? "-96dB" : `${+(20 * Math.log10(v)).toFixed(2) || 0}dB`);
const FACES = /^(thin|hairline|extralight|ultralight|light|book|regular|normal|roman|medium|semibold|demibold|bold|extrabold|ultrabold|heavy|black|ultra|italic|oblique|condensed|narrow)$/i;
function splitFont(font: unknown): [string | undefined, string | undefined] {
  if (!font) return [undefined, undefined];
  let s = String(font);
  if (/\.(ttf|otf|ttc|woff2?)$/i.test(s)) s = basename(s, extname(s)).replace(/[-_]/g, " ");
  const w = s.trim().split(/\s+/);
  const face: string[] = [];
  while (w.length > 1 && FACES.test(w.at(-1)!)) face.unshift(w.pop()!);
  return [w.join(" "), face.length ? face.join(" ") : undefined];
}
const col = (v: unknown, d: [number, number, number, number]) => parseColor(v, d).map((x) => +(x / 255).toFixed(4)).join(" ");
const ROLE: Record<string, string> = { voice: "dialogue", dialogue: "dialogue", music: "music", sfx: "effects" };

// ------------------------------------------------------------------ FCPXML 1.10
export function exportFcpxml(tl: Timeline, o: { name?: string } = {}): { xml: string; skipped: Skipped[]; approximated: Skipped[]; clips: number } {
  const plan = buildPlan(tl, "fcpxml");
  const { rate, skipped, approximated } = plan;
  // FCP convention: keep the timebase denominator (e.g. 6700/3000s), whole seconds as "Ns"
  const T = (frames: number) => { const u = Math.round(frames) * rate.num; return !u ? "0s" : u % rate.den === 0 ? `${u / rate.den}s` : `${u}/${rate.den}s`; };
  const FD = (r: Rate) => `${r.num}/${r.den}s`;
  const st = tl.settings || {};
  const W = Number(st.width) || 1920, H = Number(st.height) || 1080;
  const name = o.name ?? tl.name ?? "AgentCut";
  const resources: XEl[] = [];
  let rid = 1;
  const seqFmt = `r${rid++}`;
  resources.push(X("format", { id: seqFmt, frameDuration: FD(rate), width: W, height: H, colorSpace: "1-1-1 (Rec. 709)" }));
  const fmtIds = new Map<string, string>([[`${W}x${H}@${rate.den}/${rate.num}`, seqFmt]]);
  const formatFor = (w: number, h: number, fps: number | null) => {
    const r = fps ? rateOf(fps) : rate;
    const key = `${w}x${h}@${r.den}/${r.num}`;
    if (!fmtIds.has(key)) { const id = `r${rid++}`; fmtIds.set(key, id); resources.push(X("format", { id, frameDuration: FD(r), width: w, height: h })); }
    return fmtIds.get(key)!;
  };
  const assetIds = new Map<string, string>();
  const assetRef = (aid: string) => {
    if (assetIds.has(aid)) return assetIds.get(aid)!;
    const a = tl.assets[aid];
    const id = `r${rid++}`;
    assetIds.set(aid, id);
    const isAudio = a.kind === "audio", isImage = a.kind === "image", hasAudio = isAudio || !!a.has_audio;
    const dur = isImage ? "0s" : T(Math.floor(Number(a.duration ?? 0) * rate.fps + 1e-6));
    resources.push(X("asset", {
      id, name: basename(a.path, extname(a.path)), start: "0s", duration: dur,
      hasVideo: isAudio ? undefined : "1", format: isAudio ? undefined : formatFor(Number(a.width) || W, Number(a.height) || H, isImage ? null : Number(a.fps) || null),
      hasAudio: hasAudio ? "1" : undefined, videoSources: isAudio ? undefined : "1", audioSources: hasAudio ? "1" : undefined,
      audioChannels: hasAudio ? String(a.channels ?? 2) : undefined, audioRate: hasAudio ? String(a.sample_rate ?? 48000) : undefined,
    }, X("media-rep", { kind: "original-media", src: fileUrl(a.path) })));
    return id;
  };
  let titleFx: string | undefined, dissolveFx: string | undefined, xfadeFx: string | undefined;
  const fx = (which: "title" | "dissolve" | "xfade") => {
    if (which === "title") return (titleFx ??= (resources.push(X("effect", { id: `r${rid}`, name: "Basic Title", uid: ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti" })), `r${rid++}`));
    if (which === "dissolve") return (dissolveFx ??= (resources.push(X("effect", { id: `r${rid}`, name: "Cross Dissolve", uid: "FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265" })), `r${rid++}`));
    return (xfadeFx ??= (resources.push(X("effect", { id: `r${rid}`, name: "Audio Crossfade", uid: "FFAudioTransition" })), `r${rid++}`));
  };
  let tsN = 0;

  /** local start of an item's own timeline (what anchored offsets / `start` are measured in) */
  const localStart = (p: Placed) => (p.kind === "media" ? Math.round(p.srcIn / p.speed) : 0);

  const element = (p: Placed, offset: number, lane?: number, anchored: XEl[] = [], markers: XEl[] = []): XEl => {
    const c = p.c;
    const common = { lane: lane || undefined, offset: T(offset), name: c.name ?? c.id };
    const enabled = p.enabled ? undefined : "0";
    const conform = c.fit === "contain" || c.fit === "blur" ? "fit" : c.fit === "none" ? "none" : "fill";
    const blend = c.opacity !== undefined && Number(c.opacity) !== 1 ? X("adjust-blend", { amount: String(Number(c.opacity)) }) : null;
    const vol = () => {
      const fades = [c.fade_in ? X("fadeIn", { type: "easeIn", duration: T(Number(c.fade_in) * rate.fps) }) : null,
        c.fade_out ? X("fadeOut", { type: "easeOut", duration: T(Number(c.fade_out) * rate.fps) }) : null];
      if (p.volume === 1 && !fades.some(Boolean)) return null;
      return X("adjust-volume", { amount: p.volume === 1 ? undefined : db(p.volume) }, fades.some(Boolean) ? X("param", { name: "amount" }, ...fades) : null);
    };
    if (p.kind === "gap") return X("gap", { ...common, name: c.type === "gap" ? (c.name ?? "Gap") : `Gap (${c.name ?? c.id})`, lane: undefined, start: "0s", duration: T(p.dur) }, ...anchored, ...markers);
    if (p.kind === "title") {
      const id = `ts${++tsN}`;
      const [font, face] = splitFont(c.font);
      const bold = c.weight !== undefined && (/bold|black|heavy/i.test(String(c.weight)) || Number(c.weight) >= 600);
      const stroke = c.stroke && typeof c.stroke === "object" && Number(c.stroke.width) > 0 ? c.stroke : null;
      let text = String(c.text);
      if (c.uppercase) text = text.toUpperCase();
      return X("title", { ref: fx("title"), ...common, start: "0s", duration: T(p.dur), enabled },
        X("text", {}, X("text-style", { ref: id }, text)),
        X("text-style-def", { id }, X("text-style", {
          font: font ?? "Helvetica", fontSize: Math.round(Number(c.font_size ?? Math.round(0.065 * Math.min(W, H)))), fontFace: face ?? (bold ? "Bold" : "Regular"),
          fontColor: col(c.color, [255, 255, 255, 255]), bold: bold ? "1" : undefined, italic: c.italic ? "1" : undefined,
          strokeColor: stroke ? col(stroke.color, [0, 0, 0, 255]) : undefined, strokeWidth: stroke ? String(stroke.width) : undefined,
          kerning: c.letter_spacing ? String(c.letter_spacing) : undefined, alignment: ["left", "center", "right"].includes(c.align) ? c.align : "center",
        })),
        blend, ...anchored, ...markers);
    }
    if (p.kind === "still") {
      const ref = assetRef(c.asset);
      return X("clip", { ...common, start: "0s", duration: T(p.dur), enabled },
        X("adjust-conform", { type: conform }), blend,
        X("video", { ref, offset: "0s", name: c.name ?? c.id, start: "0s", duration: T(p.dur) }),
        ...anchored, ...markers);
    }
    // media (video / audio)
    const ref = assetRef(c.asset);
    const ls = localStart(p);
    let timeMap: XEl | null = null;
    if (p.speed !== 1) {
      const [sp, sq] = frac(p.speed);
      const end = ls + p.dur;
      timeMap = X("timeMap", {}, X("timept", { time: "0s", value: "0s", interp: "linear" }),
        X("timept", { time: T(end), value: rat(end * rate.num * sp, rate.den * sq), interp: "linear" }));
    }
    const a = tl.assets[c.asset];
    const srcEnable = p.video && p.audio ? undefined : p.video ? (a.has_audio ? "video" : undefined) : a.kind === "audio" ? undefined : "audio";
    const role = !p.video && p.audio ? own(ROLE, String(p.tr.role ?? "")) : undefined;
    return X("asset-clip", { ref, ...common, start: T(ls), duration: T(p.dur), enabled, srcEnable, audioRole: role },
      timeMap, p.video ? X("adjust-conform", { type: conform }) : null, p.video ? blend : null, p.audio ? vol() : null, ...anchored, ...markers);
  };

  // anchor connected items to the spine entry covering their start (or their attach_to target)
  const entries = plan.spine.entries;
  const anchoredBy = entries.map(() => [] as XEl[]);
  const markersBy = entries.map(() => [] as XEl[]);
  const coverIdx = (f: number, target?: string) => {
    if (target) { const k = entries.findIndex((e) => e.c.id === target && e.kind !== "gap" && e.start <= f && f < e.start + e.dur); if (k >= 0) return k; }
    const k = entries.findIndex((e) => e.start <= f && f < e.start + e.dur);
    return k >= 0 ? k : f < 0 ? 0 : entries.length - 1;
  };
  let clips = 0;
  for (const ln of [...plan.above, ...plan.below]) for (const p of ln.items) {
    const k = coverIdx(p.start, p.c.attach_to);
    const parent = entries[k];
    anchoredBy[k].push(element(p, localStart(parent) + (p.start - parent.start), ln.lane));
    clips++;
  }
  for (const m of tl.markers || []) {
    const f = Math.round(parseTime(m.t ?? m.time ?? 0) * rate.fps);
    const k = coverIdx(f);
    markersBy[k].push(X("marker", { start: T(localStart(entries[k]) + f - entries[k].start), duration: T(1), value: String(m.label ?? m.name ?? "marker") }));
  }
  const spineKids: XEl[] = [];
  entries.forEach((p, i) => {
    const tr = plan.spine.trans[i];
    if (tr) spineKids.push(X("transition", { name: "Cross Dissolve", offset: T(tr.cut - tr.left), duration: T(tr.left + tr.right) },
      X("filter-video", { ref: fx("dissolve"), name: "Cross Dissolve" }), X("filter-audio", { ref: fx("xfade"), name: "Audio Crossfade" })));
    spineKids.push(element(p, p.start, undefined, anchoredBy[i], markersBy[i]));
    if (p.kind !== "gap") clips++;
  });
  const seqDur = entries.at(-1)!.start + entries.at(-1)!.dur;
  const audioRate = ({ 32000: "32k", 44100: "44.1k", 48000: "48k", 88200: "88.2k", 96000: "96k" } as Record<number, string>)[Number(st.sample_rate)] ?? "48k";
  const doc = X("fcpxml", { version: "1.10" },
    X("resources", {}, ...resources),
    X("library", {}, X("event", { name }, X("project", { name },
      X("sequence", { format: seqFmt, duration: T(seqDur), tcStart: "0s", tcFormat: rate.ntsc ? "DF" : "NDF", audioLayout: "stereo", audioRate },
        X("spine", {}, ...spineKids))))));
  // resources must be declared before use; element() appended lazily, so re-sort: formats, effects, assets
  const rank = (e: XEl) => (e.tag === "format" ? 0 : e.tag === "effect" ? 1 : 2);
  (doc.kids[0] as XEl).kids.sort((a, b) => rank(a as XEl) - rank(b as XEl));
  return { xml: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n${ser(doc)}\n`, skipped, approximated, clips };
}

// ------------------------------------------------------------------ OpenTimelineIO (JSON)
export function exportOtio(tl: Timeline, o: { name?: string } = {}): { json: string; skipped: Skipped[]; approximated: Skipped[]; clips: number } {
  const plan = buildPlan(tl, "otio");
  const { rate, skipped, approximated } = plan;
  const R = rate.fps;
  const RT = (v: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate: R, value: v });
  const TR = (s: number, d: number) => ({ OTIO_SCHEMA: "TimeRange.1", duration: RT(d), start_time: RT(s) });
  const st = tl.settings || {};
  const meta = (p: Placed): Dict => {
    const c = p.c, m: Dict = { id: c.id, type: c.type };
    if (p.volume !== 1) { m.volume = +p.volume.toFixed(4); m.volume_db = +(p.volume > 0 ? 20 * Math.log10(p.volume) : -96).toFixed(2); }
    if (c.type === "text") for (const k of ["text", "font", "font_size", "color", "align", "position", "x", "y"]) if (c[k] !== undefined) m[k] = c[k];
    if (c.note) m.note = c.note;
    return { agentcut: m };
  };
  const gap = (d: number, name = "", metadata: Dict = {}, enabled = true) =>
    ({ OTIO_SCHEMA: "Gap.1", metadata, name, source_range: TR(0, d), effects: [], markers: [], enabled, color: null });
  const ref = (aid: string) => {
    const a = tl.assets[aid];
    const range = a.kind === "image" || !a.duration ? null : TR(0, Math.floor(Number(a.duration) * R + 1e-6));
    return { OTIO_SCHEMA: "ExternalReference.1", metadata: { agentcut: { asset: aid, kind: a.kind, width: a.width ?? null, height: a.height ?? null } },
      name: basename(a.path), available_range: range, available_image_bounds: null, target_url: fileUrl(a.path) };
  };
  let clips = 0;
  const item = (p: Placed, audio: boolean): Dict => {
    const c = p.c;
    const nm = c.name ?? c.id;
    if (p.kind === "gap") return gap(p.dur, c.type === "gap" ? (c.name ?? "") : nm);
    if (audio && p.kind !== "media") return gap(p.dur);
    if (p.kind === "title") return gap(p.dur, `Title: ${String(c.text).replace(/\s+/g, " ").slice(0, 60)}`, meta(p), p.enabled);
    if (audio && !p.audio) return gap(p.dur);
    if (!audio && p.kind === "media" && !p.video) return gap(p.dur);
    clips++;
    const effects = p.speed !== 1 ? [{ OTIO_SCHEMA: "LinearTimeWarp.1", metadata: {}, name: "speed", effect_name: "LinearTimeWarp", enabled: true, time_scalar: p.speed }] : [];
    return {
      OTIO_SCHEMA: "Clip.2", metadata: meta(p), name: nm, source_range: TR(p.kind === "still" ? 0 : p.srcIn, p.dur),
      effects, markers: [], enabled: p.enabled, color: null, media_references: { DEFAULT_MEDIA: ref(c.asset) }, active_media_reference_key: "DEFAULT_MEDIA",
    };
  };
  const track = (name: string, kind: "Video" | "Audio", items: Placed[], trans: (Trans | null)[] | null, audio: boolean, enabled = true) => {
    const children: Dict[] = [];
    let t = 0;
    items.forEach((p, i) => {
      if (p.start > t) children.push(gap(p.start - t));
      const tr = trans?.[i];
      const node = item(p, audio);
      const prev = children.at(-1);
      if (tr && prev && prev.OTIO_SCHEMA === "Clip.2" && node.OTIO_SCHEMA === "Clip.2")
        children.push({ OTIO_SCHEMA: "Transition.1", metadata: { agentcut: { type: tr.name } }, name: tr.name, transition_type: "SMPTE_Dissolve", in_offset: RT(tr.left), out_offset: RT(tr.right) });
      children.push(node);
      t = p.start + p.dur;
    });
    return { OTIO_SCHEMA: "Track.1", metadata: {}, name, source_range: null, effects: [], markers: [], enabled, color: null, children, kind };
  };
  const laneName = (ln: Lane) => (ln.lane ? `${ln.track.id} ${ln.lane + 1}` : ln.track.id);
  const video: Dict[] = [], audio: Dict[] = [];
  for (const ln of plan.videoLanes) {
    const trans = ln.lane === 0 && ln.track === plan.main ? plan.spine.trans : null;
    video.push(track(laneName(ln), "Video", ln.items, trans, false, !ln.track.hidden));
    if (ln.items.some((p) => p.kind === "media" && p.audio)) audio.push(track(`${laneName(ln)} audio`, "Audio", ln.items, trans, true, !ln.track.muted));
  }
  for (const ln of plan.audioLanes) audio.push(track(laneName(ln), "Audio", ln.items, null, true, !ln.track.muted));
  const markers = (tl.markers || []).map((m) => ({
    OTIO_SCHEMA: "Marker.2", metadata: {}, name: String(m.label ?? m.name ?? "marker"), color: "RED", comment: "",
    marked_range: TR(Math.round(parseTime(m.t ?? m.time ?? 0) * R), 0),
  }));
  const doc = {
    OTIO_SCHEMA: "Timeline.1",
    metadata: { agentcut: { width: st.width, height: st.height, fps: st.fps, background: st.background ?? "#000000", sample_rate: st.sample_rate ?? 48000 } },
    name: o.name ?? tl.name ?? "AgentCut",
    global_start_time: RT(0),
    tracks: { OTIO_SCHEMA: "Stack.1", metadata: {}, name: "tracks", source_range: null, effects: [], markers, enabled: true, color: null, children: [...video, ...audio] },
  };
  return { json: JSON.stringify(doc, null, 2) + "\n", skipped, approximated, clips };
}

// ------------------------------------------------------------------ file output
/** Write `tl` (resolved + absolutized) as FCPXML or OTIO to `out`; `base` is the project folder when `out` is inside it. */
export function exportTimeline(tl: Timeline, format: InterchangeFormat | string, out: string, base?: string) {
  const f = String(format).toLowerCase();
  let body: string, skipped: Skipped[], approximated: Skipped[], clips: number;
  if (f === "fcpxml") ({ xml: body, skipped, approximated, clips } = exportFcpxml(tl));
  else if (f === "otio") ({ json: body, skipped, approximated, clips } = exportOtio(tl));
  else throw new EditError(`unknown interchange format '${format}'`, "bad_format", "use fcpxml (Final Cut Pro) or otio (DaVinci Resolve / Premiere / Avid)");
  if (base) refuseSource(base, tl, out);
  writeFile(out, body, base);
  return {
    output: out, format: f, clips, skipped, approximated,
    next: f === "fcpxml" ? "open in Final Cut Pro (File > Import > XML); media is linked by absolute file:// paths"
      : "import in DaVinci Resolve (File > Import > Timeline) or Premiere (OTIO plugin); media is linked by absolute file:// paths",
  };
}
