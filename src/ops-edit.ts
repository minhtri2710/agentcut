// Pro trimming/audio ops: detach_audio, attach_audio, j_cut, l_cut, slip_clip, roll_edit, slide_clip.
// Content stays locked to the source: growing a clip's head moves its in-point back and shifts its keyframes.
import { canLoop, type Clip, clipDur, clipEnd, clipStart, computedDuration, type Dict, EditError, findClip, hasSourceTime, lengthTarget, linkedAudio, newId, ownDuration, parseTime, resolve, round6, soleAudio, sourceLen, type Timeline, type Track } from "./model.ts";
import { AUDIO_FX_KEYS } from "./audiofx.ts";
import type { OpHelpers } from "./ops.ts";

const MIN = 0.04, EPS = 1e-6;
type Side = "head" | "tail";
type Edge = [Clip, Side, 1 | -1]; // clip side that grows by sign * by
const spd = (c: Clip) => Number(c.speed ?? 1) || 1;
const cin = (c: Clip) => parseTime(c.in ?? 0, "in");
const isAV = (c: Clip) => c.type === "video" || c.type === "audio";
const fmt = (x: number) => (Number.isFinite(x) ? +x.toFixed(3) : "unlimited");
const allClips = (tl: Timeline) => tl.tracks.flatMap((t) => t.clips);
/** What detach_audio copies and attach_audio checks: the audio clip keeps the video's value, and edits that change one apart from the other put the sound out of sync. */
const SYNC_KEYS = ["in", "speed", "reverse", "loop", "enabled"] as const;
/** What detach_audio moves onto the audio clip (the video keeps its own volume and fades) and attach_audio moves back. */
const MOVE_KEYS = ["volume", "fade_in", "fade_out", "stem", ...AUDIO_FX_KEYS] as const;

/** source seconds available (Infinity when looping / unknown / speed-ramped) */
function srcLen(tl: Timeline, c: Clip): number {
  const a = tl.assets[c.asset], d = a ? Number(sourceLen(a, c.type)) : NaN; // a video clip ends with the picture
  return isAV(c) && d > 0 && !c.loop && !c.keyframes?.speed ? d : Infinity;
}
/** timeline seconds a side can grow before running out of source media */
function room(tl: Timeline, c: Clip, side: Side): number {
  if (!hasSourceTime(c) || c.freeze) return Infinity;
  const before = cin(c) / spd(c), after = (srcLen(tl, c) - cin(c) - clipDur(c) * spd(c)) / spd(c);
  return (side === "head") !== !!c.reverse ? before : after; // reversed clips play the source backwards
}
/** a caption word with the s/e aliases (captionWords) resolved to start/end */
export const normWord = (w: any) => ({ ...w, start: parseTime(w.start ?? w.s ?? 0), end: parseTime(w.end ?? w.e ?? 0) }); // same parse as captionWords
/** Move a clip's content e seconds in clip-local time: keyframes (not a speed ramp), effect windows and caption words; what ends before the clip's head is dropped. */
export function shiftKfs(c: Clip, e: number, srtHint = "give the clip 'words' (seconds relative to the clip start) instead of srt, or edit the srt times") {
  if (!e) return;
  if (c.type === "captions" && !c.words?.length && c.srt)
    throw new EditError(`captions '${c.id}' come from srt, whose times cannot be moved by this edit`, "bad_type", srtHint);
  if (c.type === "captions" && Array.isArray(c.words))
    c.words = c.words.map(normWord).filter((w: any) => w.end + e > 0).map((w: any) => ({ ...w, start: round6(w.start + e), end: round6(w.end + e) }));
  if (c.type === "captions" && Array.isArray(c.timed_for?.cut)) // the recorded cut is relative to the clip's start, as the words are
    c.timed_for = { ...c.timed_for, cut: c.timed_for.cut.map((r: any) => (Array.isArray(r) ? [r[0], r[1], round6(r[2] + e), r[3]] : r)) };
  if (Array.isArray(c.effects)) { // an effect with no start/duration covers the whole clip and stays
    c.effects = c.effects.flatMap((f: any) => {
      if (f?.type === "flash") { // fires at start + at for its own length (duration), whatever its window: keep that moment, drop it once it is over
        const a = parseTime(f.start ?? 0) + parseTime(f.at ?? 0) + e;
        if (a + parseTime(f.duration ?? 0.25) <= EPS) return [];
        const { start, ...rest } = f;
        return [{ ...rest, at: round6(a) }];
      }
      if (!f || typeof f !== "object" || (f.start === undefined && f.duration === undefined)) return [f];
      const s = parseTime(f.start ?? 0) + e, s2 = Math.max(0, s), d = (f.duration === undefined ? Infinity : parseTime(f.duration)) - (s2 - s);
      return d > EPS ? [{ ...f, start: round6(s2), ...(Number.isFinite(d) ? { duration: round6(d) } : {}) }] : [];
    });
    if (!c.effects.length) delete c.effects;
  }
  kfTimes(c, (t) => t + e);
}
/** map the times of a clip's keyframes (not a speed ramp) */
function kfTimes(c: Clip, f: (t: number) => number) {
  if (!c.keyframes) return;
  for (const [k, list] of Object.entries(c.keyframes as Dict)) if (k !== "speed" && Array.isArray(list))
    c.keyframes[k] = list.map((x: any) => Array.isArray(x) ? [round6(f(parseTime(x[0]))), ...x.slice(1)] : x && typeof x === "object" && "t" in x ? { ...x, t: round6(f(parseTime(x.t))) } : x);
}
/** Scale a clip's content times by r, as a speed edit scales its length: keyframes (not a speed ramp), effect windows (a flash's moment, not its own length) and fades.
 *  A field in `given` (sent in the same edit) is kept as sent. */
export function scaleKfs(c: Clip, r: number, given: Dict = {}) {
  const s = (v: unknown) => round6(parseTime(v as any) * r);
  for (const k of ["fade_in", "fade_out"]) if (c[k] && !(k in given)) c[k] = s(c[k]);
  if (Array.isArray(c.effects) && !("effects" in given))
    c.effects = c.effects.map((f: any) => !f || typeof f !== "object" ? f : {
      ...f, ...(f.start !== undefined ? { start: s(f.start) } : {}), ...(f.at !== undefined ? { at: s(f.at) } : {}),
      ...(f.duration !== undefined && f.type !== "flash" ? { duration: s(f.duration) } : {}),
    });
  if (!("keyframes" in given)) kfTimes(c, (t) => t * r);
}
/** grow one side of a clip by e seconds (negative shrinks), keeping its content in place */
function extend(c: Clip, side: Side, e: number) {
  const src = hasSourceTime(c) && !c.freeze;
  if (side === "head") { if (src && !c.reverse) c.in = round6(Math.max(0, cin(c) - e * spd(c))); shiftKfs(c, e); }
  else if (src && c.reverse) c.in = round6(Math.max(0, cin(c) - e * spd(c)));
  c.duration = round6(clipDur(c) + e);
}
/** no non-zero amount lies in lo..hi (the ops refuse by 0), so a hint must not offer it as a range */
const noFit = (lo: number, hi: number) => hi < lo - EPS || (lo > -EPS && hi < EPS);
const named = (xs: Clip[]) => { const ids = xs.map((x) => `'${x.id}'`); return ids.length > 1 ? `each of ${ids.join(", ")}` : ids[0]; };
/** a piece that plays the other way round from its video: a trim of either moves its source the wrong way, so no trim cure is named */
const opposed = (v: Clip, aud: Clip) => !!aud.reverse !== !!v.reverse;
const opposedText = (v: Clip, aud: Clip) => { const way = (c: Clip) => c.reverse ? "backwards" : "forwards"; return `'${aud.id}' plays ${way(aud)} but '${v.id}' plays ${way(v)}`; };
const REVERSED_AUDIO = "trim_clip on a reversed video does not reach its audio"; // ops.ts: `c.reverse ? undefined : soleAudio`
/** the trim that lifts a source bound of a reversed video with one detached audio clip, trimming both clips so they stay in line:
 *  trim_end moves `in` on each; trim_start would also move the audio's start (its offset), so the audio's head is cut by a shorter duration instead */
const alongReversed = (end: "trim_start" | "trim_end", v: Clip, aud: Clip, first = " first") => end === "trim_end"
  ? `trim_clip trim_end${first}, on ${named([v, aud])} (${REVERSED_AUDIO})`
  : `trim_clip trim_start on '${v.id}'${first}, then shorten '${aud.id}' by the same amount (trim_clip id='${aud.id}' duration=<its duration minus that amount>); ${REVERSED_AUDIO}`;
function applyEdges(tl: Timeline, edges: Edge[], by: number, what: string, lo = -Infinity, hi = Infinity) {
  for (const [c] of edges) if (c.keyframes?.speed)
    throw new EditError(`${what}: '${c.id}' has a speed ramp`, "unsupported", "remove keyframes.speed before rolling or sliding this cut; speed-ramped content cannot yet be rebased by these edits");
  for (const [c] of edges) ownDuration(c); // a computed length would be overwritten
  for (const [c, side, sg] of edges) {
    const r = room(tl, c, side), d = clipDur(c), s0 = clipStart(c);
    if (sg > 0) { lo = Math.max(lo, MIN - d); hi = Math.min(hi, r); } else { lo = Math.max(lo, -r); hi = Math.min(hi, d - MIN); }
    if (side === "head") { if (sg > 0) hi = Math.min(hi, s0); else lo = Math.max(lo, -s0); } // a head cannot move before timeline 0: a clamp there would desync its content
  }
  if (by < lo - EPS || by > hi + EPS)
    throw new EditError(`${what}: by=${by} is out of range`, "out_of_range",
      `${noFit(lo, hi) ? "no by fits: the clips' limits leave no room for this edit" : `allowed by: ${fmt(lo)} .. ${fmt(hi)} s`} (clips must stay >= ${MIN}s, within their source media and at or after timeline 0)`, undefined, { min_by: fmt(lo), max_by: fmt(hi) });
  for (const [c, side, sg] of edges) extend(c, side, sg * by);
}

function amount(a: Dict, k: "seconds" | "by", positive: boolean): number {
  if (a[k] === undefined || a[k] === null) throw new EditError(`missing '${k}'`, "missing_arg", positive ? `${k}: seconds > 0, e.g. 0.5` : `${k}: +/- seconds, e.g. 0.25 (later) or -0.5 (earlier)`);
  const v = parseTime(a[k], k);
  if (positive ? v <= 0 : Math.abs(v) < EPS) throw new EditError(`${k} must be ${positive ? "> 0" : "non-zero"} (got ${v})`, "bad_amount", positive ? "pass seconds > 0; use undo to revert an earlier cut" : "positive = later, negative = earlier");
  return v;
}

const withAudio = (tl: Timeline, edges: Edge[], op: string): Edge[] => [...edges, ...edges.flatMap(([c, s, g]) => { const l = soleAudio(tl, c, op); return l ? [[l[1], s, g] as Edge] : []; })];

/** other audible (non-music) clips overlapping [t0, t1] - they keep playing under a J/L-cut */
function audibleUnder(tl: Timeline, t0: number, t1: number, skip: string[]): string[] {
  const out: string[] = [];
  for (const tr of tl.tracks) {
    if (tr.muted || tr.role === "music") continue;
    for (const c of tr.clips) {
      if (skip.includes(c.id) || c.enabled === false || c.muted || !isAV(c) || c.freeze) continue;
      const as = tl.assets[c.asset];
      if (as && (as.has_audio || as.kind === "audio") && clipStart(c) < t1 - 1e-3 && clipEnd(c) > t0 + 1e-3) out.push(c.id);
    }
  }
  return out;
}

export function registerEditOps(h: OpHelpers) {
  const get = (tl: Timeline, a: Dict): [Track, number, Clip] => {
    if (a.id === undefined || a.id === null || a.id === "") throw new EditError("missing 'id'", "missing_arg", "pass a clip id or a ref like 'main#1' (track#index, -1 = last)");
    return findClip(tl, h.resolveRef(tl, String(a.id)));
  };

  function detach(tl: Timeline, v: Clip, trackId?: string): Clip {
    if (v.type !== "video") throw new EditError(`detach_audio needs a video clip; '${v.id}' is ${v.type}`, "bad_type", v.type === "audio" ? "it is already an audio clip: edit it directly" : "pass the id of a video clip that has sound");
    const ex = linkedAudio(tl, v).map(([, x]) => x.id);
    if (ex.length) throw new EditError(`audio of '${v.id}' is already detached as '${ex.join("', '")}'`, "already_detached", `nothing to do: edit '${ex[0]}' directly, or use j_cut/l_cut/slip_clip on '${v.id}'`, undefined, { audio: ex[0] });
    if (v.muted) throw new EditError(`'${v.id}' is muted, so there is no audio to detach`, "muted", `unmute first: update_clip id=${v.id} muted=false`);
    if (!tl.assets[v.asset]?.has_audio) throw new EditError(`'${v.id}' (asset '${v.asset}') has no audio stream`, "no_audio", "add sound with add_clip type=audio instead");
    if (v.freeze) throw new EditError(`'${v.id}' is a freeze frame, which plays no audio`, "no_audio");
    if (v.keyframes?.speed) throw new EditError(`'${v.id}' has a speed ramp, which only a video clip follows`, "unsupported", "its sound already plays at the ramped speed: leave it on the clip, or remove keyframes.speed to detach");
    const tid = trackId ?? "dialogue";
    const tr = h.ensureTrack(tl, tid, "audio");
    if ((tr.kind ?? "video") !== "audio" || tr.magnetic) throw new EditError(`track '${tid}' must be a non-magnetic audio track`, "bad_track", "omit track (default 'dialogue') or add_track kind=audio");
    const aud: Clip = { id: newId(tl, h.PREFIX.audio), type: "audio", name: `audio of ${v.id}`, asset: v.asset, duration: round6(clipDur(v)), attach_to: v.id, offset: 0 };
    for (const k of [...SYNC_KEYS, ...MOVE_KEYS]) if (v[k] !== undefined) {
      aud[k] = structuredClone(v[k]);
      if (k === "stem" || (AUDIO_FX_KEYS as readonly string[]).includes(k)) delete v[k]; // the sound now lives on aud; the muted video keeps no audio fields
    }
    if (v.keyframes?.volume) aud.keyframes = { volume: structuredClone(v.keyframes.volume) };
    if (v.group) aud.group = structuredClone(v.group); // the sound belongs to the same expanded compound
    tr.clips.push(aud);
    v.muted = true;
    resolve(tl);
    return aud;
  }

  /** [video, its detached audio, whether we detached it now]; accepts the audio clip itself too */
  function audioOf(tl: Timeline, c: Clip, op: string, trackId?: string): [Clip, Clip, boolean] {
    if (c.type === "audio" && c.attach_to) return [findClip(tl, c.attach_to)[2], c, false];
    const l = soleAudio(tl, c, op);
    if (l) return [c, l[1], false];
    if (c.type === "video" && c.muted) throw new EditError(`'${c.id}' is muted and has no detached audio clip`, "muted", `unmute it (update_clip id=${c.id} muted=false) and retry`);
    return [c, detach(tl, c, trackId), true];
  }

  h.op("detach_audio", "Split a video clip's sound into its own audio clip (on track 'dialogue', created if missing; a new track gets no role, so it ducks nothing) connected to the video " +
    "(attach_to, offset 0, same duration/in/speed/volume/fades/volume keyframes; audio processing fields move to it); the video becomes muted. Needed for J/L-cuts; j_cut/l_cut call it automatically. " +
    "split_clip/trim_clip on the video keep its detached audio in sync.",
    { id: "video clip id or ref ('main#1')", track: "audio track id (default 'dialogue')" }, (p, tl, a) => {
      const [, , v] = get(tl, a);
      const aud = detach(tl, v, a.track);
      return { id: v.id, audio: aud.id, track: tl.tracks.find((t) => t.clips.includes(aud))!.id, start: aud.start, duration: aud.duration };
    });

  h.op("attach_audio", "Inverse of detach_audio: put a video's detached sound back on the video and remove the audio clip. Its processing (eq, compressor, pan, denoise, pitch, normalize, stem), volume, fades and volume keyframes move back to the video, which is unmuted (muted, if the audio clip was). " +
    "Refused (out_of_sync, naming the field) when the audio no longer lines up with the picture: offset other than 0, or in/duration/speed/reverse/loop/enabled/group different from the video's (a J/L-cut or slip); refused (audio_state) when the audio's track is muted or at volume 0, the video is a freeze frame, or the audio has its own length rule (until_end, match_duration naming a clip). Clips attached to the audio clip are attached to the video. A speed ramp needs this first.",
    { id: "video clip id or ref, or its detached audio clip" }, (p, tl, a) => {
      const [, , c] = get(tl, a);
      const v = c.type === "audio" && c.attach_to ? findClip(tl, c.attach_to)[2] : c;
      if (v.type !== "video") throw new EditError(`attach_audio needs a video clip with detached audio; '${c.id}' is ${c.type}`, "bad_type", "pass the video's id, or the id of its audio clip");
      const aud = soleAudio(tl, v, "attach_audio")?.[1];
      if (!aud) throw new EditError(`'${v.id}' has no detached audio`, "not_detached", "its sound is already on the clip; detach_audio, j_cut or l_cut create a detached audio clip");
      resolve(tl);
      const sync = (x: Clip) => ({ offset: x === aud ? parseTime(x.offset ?? 0, "offset") : 0, duration: clipDur(x), in: cin(x), speed: spd(x), reverse: !!x.reverse, loop: !!x.loop, enabled: x.enabled !== false, group: JSON.stringify(x.group ?? null) });
      const [pv, pa] = [sync(v), sync(aud)];
      for (const k of Object.keys(pv) as (keyof typeof pv)[]) {
        const same = typeof pv[k] === "number" ? Math.abs((pv[k] as number) - (pa[k] as number)) < 1e-3 : pv[k] === pa[k];
        if (!same) throw new EditError(`'${aud.id}' no longer lines up with '${v.id}': ${k} is ${pa[k]}, the video's is ${pv[k]}`, "out_of_sync",
          `make ${k} match the video's (undo the J/L-cut or slip), or remove_clip id=${aud.id} to drop that audio and its processing`, undefined, { audio: aud.id, field: k });
      }
      const trackOf = (c: Clip) => tl.tracks.find((t) => t.clips.includes(c))!;
      const atr = trackOf(aud);
      const quiet = (t: Track) => (t.muted ? `track '${t.id}' is muted` : !(Number(t.volume ?? 1) > 0) ? `track '${t.id}' has volume 0` : ""); // the sound is silent on one track and audible on the other
      const silent = quiet(atr) || quiet(trackOf(v)) || (v.freeze ? `'${v.id}' is a freeze frame, which plays no audio` : aud.until_end || typeof aud.match_duration === "string" ? `'${aud.id}' has its own length rule (until_end or match_duration)` : "");
      if (silent) throw new EditError(`attach_audio would change what '${aud.id}' plays: ${silent}`, "audio_state",
        "unmute or raise that track and unfreeze the video; remove until_end/match_duration from the audio; or remove_clip the audio to drop it", undefined, { audio: aud.id });
      for (const k of MOVE_KEYS) { if (aud[k] !== undefined) v[k] = structuredClone(aud[k]); else delete v[k]; }
      if (aud.keyframes?.volume) v.keyframes = { ...v.keyframes, volume: structuredClone(aud.keyframes.volume) };
      else if (v.keyframes) { delete v.keyframes.volume; if (!Object.keys(v.keyframes).length) delete v.keyframes; }
      if (aud.muted) v.muted = true; else delete v.muted;
      if (aud.note) v.note = v.note ? `${v.note}\n${aud.note}` : aud.note;
      for (const x of allClips(tl)) { // aud lines up with v exactly, so what followed aud keeps its place and length
        if (x.attach_to === aud.id) x.attach_to = v.id;
        if (x.match_duration === aud.id) x.match_duration = v.id;
      }
      atr.clips = atr.clips.filter((x) => x !== aud);
      resolve(tl);
      return { id: v.id, removed: aud.id, ...(aud.name && aud.name !== `audio of ${v.id}` ? { dropped_name: aud.name } : {}) };
    });

  const cutDoc = (lead: boolean) => (lead
    ? "J-cut: this (incoming) clip's audio starts `seconds` BEFORE its picture, e.g. hear B's voice over the end of A: j_cut id='main#1' seconds=0.8. "
    : "L-cut: this (outgoing) clip's audio keeps playing `seconds` AFTER its picture ends, e.g. A's voice continues over the start of B: l_cut id='main#0' seconds=1. ") +
    "Detaches the audio first if needed (detach_audio) and extends that audio clip; repeated calls add up. Clamped to the available source media" +
    (lead ? " and to timeline 0" : "") + " (result.clamped). The neighbouring clip's own audio still plays underneath (result.under lists it): " +
    "pair with " + (lead ? "l_cut/fade_out/volume keyframes on the previous clip" : "fade_in/volume keyframes on the next clip") + " if it should not, and use crossfade for a smooth blend.";
  for (const lead of [true, false]) {
    h.op(lead ? "j_cut" : "l_cut", cutDoc(lead),
      { id: "video clip id or ref ('main#1'), or its detached audio clip", seconds: "s > 0", crossfade: `s: sets fade_${lead ? "in" : "out"} on the extended audio`, track: "audio track if detaching (default 'dialogue')" },
      (p, tl, a) => {
        const [, , c] = get(tl, a);
        const req = amount(a, "seconds", true);
        const [v, aud, detached] = audioOf(tl, c, lead ? "j_cut" : "l_cut", a.track);
        ownDuration(aud);
        resolve(tl);
        const side: Side = lead ? "head" : "tail";
        const limit = Math.min(room(tl, aud, side), lead ? clipStart(aud) : Infinity);
        let s = req;
        const out: Dict = { id: v.id, audio: aud.id, detached };
        if (s > limit + EPS) {
          if (limit < 0.01) {
            const own = linkedAudio(tl, v).map(([, x]) => x), pieces = detached ? [] : own, vt = tl.tracks.find((t) => t.clips.includes(v));
            const trim = (end: "trim_start" | "trim_end") => { // trim_clip carries the audio of a forward video with one audio clip; a reversed video's audio it leaves alone, a video with several it refuses, and an attached clip that is not the video's own sound it never reaches
              if (!detached && !own.includes(aud)) return `'${aud.id}' is not the sound of '${v.id}', so trimming '${v.id}' gives it no source`;
              if (opposed(v, aud)) return `${opposedText(v, aud)}, so trimming '${v.id}' gives it no source`;
              if (pieces.length < 2) return pieces.length && v.reverse ? alongReversed(end, v, aud) : `trim_clip ${end} on '${v.id}' first`;
              if (v.reverse) return end === "trim_end" ? alongReversed(end, v, aud) : `'${v.id}' is reversed and has ${pieces.length} audio clips, which no trim_start keeps in line`;
              // shortcut: assumes the audio clips tile the video, so the refusing one is the last (tail) or the first (head) and a split at its inner edge gives it a picture of its own
              return `'${v.id}' has ${pieces.length} audio clips, so trim_clip refuses it: split_clip '${v.id}' at ${round6(lead ? clipEnd(aud) : clipStart(aud))} first so that '${aud.id}' has a picture of its own, then repeat the ${lead ? "j_cut" : "l_cut"}`; // the stored edge: splitAt gives a piece starting there to the right half whole, a rounded time would split it
            };
            const jcures = () => [room(tl, aud, side) < 0.01 && `spare source at the audio's head: ${trim("trim_start")}`, // each bound that tripped gets its own cure
              clipStart(aud) < 0.01 && `a clip that starts after timeline 0: ${vt?.magnetic ? `add a clip before it (add_clip track='${vt.id}' before='${v.id}'), or move_clip '${v.id}' to a non-magnetic track at a later time` : `move_clip '${v.id}' to a later time`}`].filter(Boolean).join("; and ");
            throw new EditError(`cannot ${lead ? "lead" : "extend"} the audio of '${v.id}': ${lead && clipStart(aud) < 0.01 ? "it already starts at 0" : "no more source media"}`, "out_of_range",
              lead ? `a J-cut needs ${jcures()}` : `an L-cut needs source after the clip's out-point; ${trim("trim_end")}${canLoop(tl.assets, detached ? v : aud) ? `; or set loop: true on '${detached ? v.id : aud.id}'` : ""}`); // a refused batch discards the audio clip made here; detach copied the video's loop to it
          }
          s = round6(limit);
          out.clamped = { requested: req, applied: s, reason: lead && clipStart(aud) <= room(tl, aud, side) ? "timeline start" : "source media" };
        }
        extend(aud, side, s);
        if (lead) aud.offset = round6(parseTime(aud.offset ?? 0, "offset") - s);
        if (a.crossfade !== undefined) aud[lead ? "fade_in" : "fade_out"] = round6(Math.min(parseTime(a.crossfade, "crossfade"), clipDur(aud)));
        resolve(tl);
        const t0 = lead ? clipStart(aud) : clipEnd(v), t1 = lead ? clipStart(v) : clipEnd(aud);
        Object.assign(out, { seconds: s, audio_start: aud.start, audio_in: aud.in ?? 0, audio_duration: aud.duration, offset: aud.offset });
        const under = audibleUnder(tl, t0, t1, [v.id, aud.id]);
        if (under.length) out.under = under;
        return out;
      });
  }

  h.op("slip_clip", "Slip: show a different part of the source without moving the clip (in += by*speed; start/duration unchanged). " +
    "Its detached audio (detach_audio/j_cut/l_cut) slips too, keeping sync. Positive by = later source material.",
    { id: "video/audio clip id or ref", by: "+/- seconds of source" }, (p, tl, a) => {
      const [, , c] = get(tl, a);
      if (!isAV(c)) throw new EditError(`slip_clip needs a video or audio clip; '${c.id}' is ${c.type}`, "bad_type", "images/text have no source in-point; use move_clip to move them");
      const by = amount(a, "by", false);
      const pieces = linkedAudio(tl, c).map(([, x]) => x), list = [c, ...pieces];
      let lo = -Infinity, hi = Infinity;
      for (const x of list) {
        lo = Math.max(lo, -cin(x) / spd(x));
        hi = Math.min(hi, (srcLen(tl, x) - cin(x) - (x.freeze ? 0 : clipDur(x) * spd(x))) / spd(x));
      }
      const low = by < lo - EPS, high = by > hi + EPS; // loop lifts only the source end, so it is offered for that bound alone
      // a loop flag is the clip's own: update_clip on the video does not reach its pieces
      const loopTail = high && !low && canLoop(tl.assets, ...list) ? `; or set loop: true${pieces.length ? ` on ${named(list.filter((x) => !x.loop))} (update_clip on the video does not reach its audio)` : ""}` : "";
      // each trim end opens one bound: a forward clip's trim_end opens the later source (high) and its trim_start the earlier (low); a reversed clip is the other way round
      const ends = [low && (c.reverse ? "trim_end" : "trim_start"), high && (c.reverse ? "trim_start" : "trim_end")].filter(Boolean) as ("trim_start" | "trim_end")[];
      // trim_clip refuses a video with several audio clips, and no trim keeps them in line with a reversed one, so then no trim is offered
      const mixed = pieces.find((x) => opposed(c, x));
      // trim_clip never trims a computed piece: only trim_end on a forward video reaches it with no clear (`in` stays, resolve shortens the piece, and the link is kept); trim_start leaves its `in`, a reversed video leaves the piece alone, and a length that follows another clip is not moved by the video's trim
      const clear = pieces.length === 1 && !mixed && computedDuration(pieces[0]) && (c.reverse || low || lengthTarget(pieces[0]) !== c.id);
      const first = clear ? "" : " first";
      const trims = pieces.length > 1 ? `it has ${pieces.length} audio clips, which no trim_clip keeps in line` : mixed ? `${opposedText(c, mixed)}, so no trim cure is named` : (clear ? `update_clip id=${pieces[0].id} match_duration=null first, then ` : "") + (pieces.length && c.reverse ? ends.map((e) => alongReversed(e, c, pieces[0], first)).join("; and ") : `trim_clip ${ends.join(" and ")}${first}`);
      if (low || high) throw new EditError(`slip_clip: by=${by} is out of range`, "out_of_range",
        `${noFit(lo, hi) ? `no slip fits: the clip${pieces.length ? " or its audio" : ""} has no spare source to slide over (${trims}` : `allowed by: ${fmt(lo)} .. ${fmt(hi)} s (in-point must stay >= 0 and the clip within its source`}${loopTail})`, undefined, { min_by: fmt(lo), max_by: fmt(hi) });
      for (const x of list) x.in = round6(Math.max(0, cin(x) + by * spd(x)));
      resolve(tl);
      const out: Dict = { id: c.id, in: c.in, start: c.start, duration: c.duration };
      if (pieces.length) out.audio = pieces.map((x) => ({ id: x.id, in: x.in }));
      return out;
    });

  h.op("roll_edit", "Roll: move the cut between this clip and the NEXT clip on its track by `by` seconds; total length is unchanged " +
    "(this.duration += by; next.in += by*speed, next.duration -= by). Both need spare source media; refused (out_of_range) if a head would move before timeline 0. Detached audio rolls with the picture.",
    { id: "outgoing (left) clip id or ref", by: "+/- seconds (positive = cut later)" }, (p, tl, a) => {
      const [tr, ci, l] = get(tl, a);
      const r = tr.clips[ci + 1];
      if (!r) throw new EditError(`'${l.id}' is the last clip on '${tr.id}'; there is no cut after it to roll`, "no_next", "pass the clip BEFORE the cut; to change only this clip's end use trim_clip");
      const by = amount(a, "by", false);
      resolve(tl);
      if (!tr.magnetic && (Math.abs(clipEnd(l) - clipStart(r)) > 1e-3 || r.attach_to))
        throw new EditError(`'${l.id}' and '${r.id}' do not touch (${clipEnd(l).toFixed(3)} vs ${clipStart(r).toFixed(3)})`, "not_adjacent", "roll_edit needs two adjacent clips; use trim_clip / move_clip for separate clips");
      applyEdges(tl, withAudio(tl, [[l, "tail", 1], [r, "head", -1]], "roll_edit"), by, "roll_edit");
      if (!tr.magnetic) r.start = round6(clipStart(r) + by);
      resolve(tl);
      return { left: { id: l.id, in: l.in ?? 0, duration: l.duration }, right: { id: r.id, start: r.start, in: r.in ?? 0, duration: r.duration }, cut: round6(clipStart(r)) };
    });

  h.op("slide_clip", "Slide: move a clip along its track keeping its content and length; the previous clip grows/shrinks by `by` and the next one " +
    "gives/takes the same time from its head (next.in += by*speed). Magnetic tracks need a clip before and after. On other tracks start += by and only " +
    "touching neighbours are adjusted (others are left alone; result.overlaps warns). Detached audio follows; refused (out_of_range) if it would move before timeline 0.",
    { id: "clip id or ref", by: "+/- seconds (positive = later)" }, (p, tl, a) => {
      const [tr, ci, c] = get(tl, a);
      const by = amount(a, "by", false);
      if (c.attach_to) throw new EditError(`'${c.id}' is attached to '${c.attach_to}'`, "attached", `change its offset instead: update_clip id=${c.id} offset=...`);
      resolve(tl);
      let prev: Clip | undefined = tr.clips[ci - 1], next: Clip | undefined = tr.clips[ci + 1];
      if (tr.magnetic) {
        if (!prev || !next) throw new EditError(`slide on magnetic track '${tr.id}' needs a clip before and after '${c.id}'`, "no_neighbour", "for the first/last clip use roll_edit on the cut, trim_clip, or move_clip index=...");
      } else {
        const s = clipStart(c), e = clipEnd(c);
        if (prev && (Math.abs(clipEnd(prev) - s) > 1e-3 || prev.attach_to)) prev = undefined;
        if (next && (Math.abs(clipStart(next) - e) > 1e-3 || next.attach_to)) next = undefined;
      }
      const edges: Edge[] = [];
      if (prev) edges.push([prev, "tail", 1]);
      if (next) edges.push([next, "head", -1]);
      const own = soleAudio(tl, c, "slide_clip")?.[1]; // c's detached audio follows it and must not be pushed before 0 either
      applyEdges(tl, withAudio(tl, edges, "slide_clip"), by, "slide_clip", Math.max(tr.magnetic ? -Infinity : -clipStart(c), own ? -clipStart(own) : -Infinity));
      if (!tr.magnetic) {
        c.start = round6(clipStart(c) + by);
        if (next) next.start = round6(clipStart(next) + by);
        tr.clips.sort((x, y) => clipStart(x) - clipStart(y));
      }
      resolve(tl);
      const out: Dict = { id: c.id, start: c.start, duration: c.duration };
      if (prev) out.prev = { id: prev.id, duration: prev.duration };
      if (next) out.next = { id: next.id, start: next.start, in: next.in ?? 0, duration: next.duration };
      if (!tr.magnetic) {
        const ov = tr.clips.filter((x) => x !== c && x !== prev && x !== next && clipStart(x) < clipEnd(c) - 1e-3 && clipEnd(x) > clipStart(c) + 1e-3).map((x) => x.id);
        if (ov.length) out.overlaps = ov;
      }
      return out;
    });
}
