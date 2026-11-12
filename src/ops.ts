// Edit operations. Every op is {"op": name, ...args}; batches are atomic (applied to a copy).
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve as presolve } from "node:path";
import * as AN from "./analyze.ts";
import { AUDIO_FX_KEYS } from "./audiofx.ts";
import { firstCovering } from "./fonts.ts";
import { AUDIO_EXT, probe } from "./media.ts";
import {
  allClips, CLIP_TYPES, type Clip, clipDur, clipEnd, clipStart, deepMerge, type Dict, EditError, EFFECTS, findClip, findTrack, newId,
  normAnim, parseTime, PRESETS, resolve, round6, SCHEMA_VERSION, suggest, type Timeline, totalDuration, lengthTarget, type Track, TRANSITIONS, unfollow, computedDuration, ownDuration, hasSourceTime,
} from "./model.ts";
import { expandPreset, TEMPLATES } from "./presets.ts";
import { checkRevision, type Project } from "./project.ts";
import { copyFile, lexists } from "./safe-write.ts";
import { captionWords, scriptToWords } from "./captions.ts";
import { normWord, registerEditOps, shiftKfs } from "./ops-edit.ts";
import { registerCompoundOps } from "./ops-compound.ts";
import { registerAudioOps } from "./ops-audio.ts";
import { registerVisionOps } from "./ops-vision.ts";

const PREFIX: Record<string, string> = { video: "vid", image: "img", text: "txt", captions: "cap", shape: "shp", color: "col", audio: "aud", gap: "gap", lottie: "lot" };
type OpFn = (p: Project, tl: Timeline, a: Dict) => Dict;
export const OPS: Record<string, { fn: OpFn; doc: string; args: Dict }> = {};
const op = (name: string, doc: string, args: Dict, fn: OpFn) => { OPS[name] = { fn, doc, args }; };

const absPath = (p: string) => presolve(p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));

/** "3", "2.5s", "end", "end-2" (relative to the current end of the timeline) */
function parseAt(tl: Timeline, v: unknown): number {
  if (typeof v === "string") {
    const m = /^end\s*([+-]\s*[\d.]+\s*s?)?$/i.exec(v.trim());
    if (m) { resolve(tl); return Math.max(0, totalDuration(tl) + (m[1] ? parseTime(m[1].replace(/\s/g, "").replace(/^\+/, "")) : 0)); }
  }
  return parseTime(v, "at");
}

// ---------------------------------------------------------------- media
export function importAsset(p: Project | null, tl: Timeline, path: string, id?: string, copy = false): string {
  let src = absPath(path);
  if (!existsSync(src) && p && existsSync(join(p.root, path))) src = join(p.root, path);
  if (!existsSync(src)) throw new EditError(`file not found: ${path}`, "not_found", "use an absolute path or a path relative to the current directory");
  for (const [k, a] of Object.entries(tl.assets)) if (p && presolve(p.abs(a.path)) === src) return k;
  const info = probe(src); // before the copy: a file that is not media leaves nothing in media/
  if (copy && p) {
    let dst = join(p.root, "media", basename(src));
    for (let i = 1; lexists(dst) && presolve(dst) !== src; i++) dst = join(p.root, "media", `${basename(src, extname(src))}-${i}${extname(src)}`);
    if (presolve(dst) !== src) { copyFile(src, dst, p.root); p.stage(dst); }
    src = dst;
  }
  if (!id) {
    const base = basename(src, extname(src)).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "asset";
    id = base;
    for (let n = 2; tl.assets[id]; n++) id = `${base}_${n}`;
  } else if (tl.assets[id]) throw new EditError(`asset id '${id}' already exists`, "exists");
  info.path = p ? p.rel(src) : src;
  tl.assets[id] = info;
  return id;
}

op("import_media", "Import a media file (video/image/audio/Lottie .json) as an asset. Returns id + probe info.",
  { path: "file path (required)", id: "asset id", copy: "copy into project media/ (false)" },
  (p, tl, a) => { const id = importAsset(p, tl, a.path, a.id, !!a.copy); const { path, ...rest } = tl.assets[id]; return { asset: id, ...rest }; });

op("remove_asset", "Remove an asset (force=true also removes clips using it).", { id: "asset id", force: "bool" }, (p, tl, a) => {
  if (!tl.assets[a.id]) throw new EditError(`asset '${a.id}' not found`, "not_found");
  const users = [...allClips(tl.tracks)].filter((c) => c.asset === a.id).map((c) => c.id); // incl. clips inside compounds
  if (users.length && !a.force) throw new EditError(`asset '${a.id}' is used by ${users.join(", ")}`, "in_use", "remove those clips or pass force=true");
  const unlinked: string[] = [];
  const strip = (tracks: Track[]) => { // followers of a removed clip (same level) keep their last length
    const gone = new Set<string>();
    for (const t of tracks) t.clips = t.clips.filter((c) => { if (c.asset !== a.id) return true; gone.add(c.id); return false; });
    unlinked.push(...unfollow(tracks.flatMap((t) => t.clips), (id) => gone.has(id)));
    for (const t of tracks) for (const c of t.clips) if (c.type === "compound") strip(c.tracks ?? []);
  };
  strip(tl.tracks);
  delete tl.assets[a.id];
  return { removed: a.id, removed_clips: users, unlinked_durations: unlinked };
});

// ---------------------------------------------------------------- settings / tracks
op("set_settings", "Change canvas/output settings. effects: whole-frame effects (letterbox, grain, vignette...).",
  { preset: Object.keys(PRESETS).join("|"), width: "px", height: "px", fps: "n", background: "colour", duration: "s|null", loudness: "LUFS|null", effects: "list", name: "project name" },
  (p, tl, a) => {
    const st = tl.settings;
    if (a.preset) {
      if (!PRESETS[a.preset]) { const s = suggest(a.preset, Object.keys(PRESETS)); throw new EditError(`unknown preset '${a.preset}'`, "bad_preset", s ? `did you mean '${s}'?` : Object.keys(PRESETS).join(", ")); }
      [st.width, st.height] = PRESETS[a.preset];
    }
    for (const k of ["width", "height", "fps", "background", "duration", "loudness", "sample_rate", "effects"]) if (k in a) st[k] = a[k];
    if (a.name) tl.name = a.name;
    return { settings: st };
  });

op("add_track", "Add a track. Later tracks draw on top.",
  { id: "track id", kind: "video|audio", magnetic: "bool", role: "voice|music|sfx|titles|dialogue", duck: "dB", index: "position", above: "track id", below: "track id" },
  (p, tl, a) => {
    const id = a.id || newId(tl, "track");
    if (tl.tracks.some((t) => t.id === id)) throw new EditError(`track '${id}' already exists`, "exists");
    const tr: Track = { id, kind: a.kind ?? "video", clips: [] };
    for (const k of ["magnetic", "role", "duck", "volume", "muted", "hidden", "name", ...AUDIO_FX_KEYS]) if (k in a) tr[k] = a[k];
    let idx: number;
    if (a.above) idx = tl.tracks.indexOf(findTrack(tl, a.above)) + 1;
    else if (a.below) idx = tl.tracks.indexOf(findTrack(tl, a.below));
    else if (a.index !== undefined) idx = +a.index;
    else if (tr.kind === "audio") idx = tl.tracks.length;
    else idx = Math.max(0, ...tl.tracks.map((t, i) => ((t.kind ?? "video") !== "audio" ? i + 1 : 0)));
    tl.tracks.splice(idx, 0, tr);
    return { track: id, index: idx };
  });

op("update_track", "Update track properties (set: {...}). magnetic=true is refused while the track holds an attached clip (attached_magnetic).", { id: "track id", set: "fields" }, (p, tl, a) => {
  const tr = findTrack(tl, a.id);
  const patch = { ...(a.set ?? Object.fromEntries(Object.entries(a).filter(([k]) => k !== "op" && k !== "id"))) };
  delete patch.clips;
  deepMerge(tr, patch);
  if (patch.magnetic) for (const x of tr.clips) refuseAttachedMagnetic(x, tr);
  return { track: tr.id };
});
op("remove_track", "Delete a track and its clips.", { id: "track id" }, (p, tl, a) => {
  const tr = findTrack(tl, a.id);
  tl.tracks.splice(tl.tracks.indexOf(tr), 1);
  const gone = new Set(tr.clips.map((c) => c.id));
  return { removed: tr.id, clips: [...gone], unlinked_durations: unfollow(tl.tracks.flatMap((t) => t.clips), (id) => gone.has(id)) };
});
op("move_track", "Reorder a track (draw order).", { id: "track id", index: "new index" }, (p, tl, a) => {
  const tr = findTrack(tl, a.id);
  tl.tracks.splice(tl.tracks.indexOf(tr), 1);
  tl.tracks.splice(+a.index, 0, tr);
  return { track: tr.id, index: tl.tracks.indexOf(tr) };
});

// ---------------------------------------------------------------- clips
const ADD_META = new Set(["op", "track", "at", "index", "after", "before", "end", "type", "id", "src"]);

function inferType(tl: Timeline, a: Dict): string {
  if (a.type) return a.type;
  if (a.words || a.srt) return "captions";
  if ("text" in a) return "text";
  if (a.shape) return "shape";
  if (a.asset) return ({ image: "image", audio: "audio", lottie: "lottie" } as Dict)[tl.assets[a.asset].kind] ?? "video";
  if (a.color || a.gradient) return "color";
  throw new EditError("cannot infer clip type", "missing_type", `pass type: ${CLIP_TYPES.join("|")}`);
}

function defaultDuration(tl: Timeline, c: Clip): number {
  if (c.type === "video" || c.type === "audio" || c.type === "lottie") {
    const a = tl.assets[c.asset];
    if (a.kind === "image") return 3;
    if (c.freeze) return 2;
    const avail = Number(a.duration ?? 3) - parseTime(c.in ?? 0);
    return round6(Math.max(0.1, avail / (Number(c.speed ?? 1) || 1)));
  }
  if (c.type === "captions") { const w = captionWords(c); return w.length ? round6(w[w.length - 1].end + 0.3) : 3; }
  if (c.type === "gap") return 1;
  return 3;
}

export const trackEnd = (tr: Track) => Math.max(0, ...tr.clips.map(clipEnd));

function makeClip(p: Project, tl: Timeline, a: Dict): Clip {
  a = { ...a };
  if (a.src) a.asset = importAsset(p, tl, a.src);
  if (a.asset && !tl.assets[a.asset]) { const s = suggest(a.asset, Object.keys(tl.assets)); throw new EditError(`asset '${a.asset}' not found`, "not_found", `${s ? `did you mean '${s}'? ` : ""}import it first or pass src`); }
  if (a.srt) a.srt = absPath(a.srt);
  for (const f of a.filters ?? []) if (f && typeof f === "object" && f.type === "lut" && f.path) f.path = absPath(f.path);
  const type = inferType(tl, a);
  if (!CLIP_TYPES.includes(type)) { const s = suggest(type, CLIP_TYPES); throw new EditError(`unknown clip type '${type}'`, "bad_type", s ? `did you mean '${s}'?` : CLIP_TYPES.join(", ")); }
  if (a.preset) {
    if (type !== "text" && type !== "captions") throw new EditError("preset applies to text and captions clips", "bad_preset");
    const sample = type === "text" ? String(a.text ?? "") : captionWords(a).map((w) => w.text).join(" ");
    const { preset, ...given } = a;
    a = expandPreset(type, preset, sample, given);
  }
  const c: Clip = { id: a.id, type, duration: 0 };
  for (const [k, v] of Object.entries(a)) if (!ADD_META.has(k) && v !== undefined && v !== null) c[k] = structuredClone(v);
  if (!c.id) c.id = newId(tl, PREFIX[type]);
  else if ([...allClips(tl.tracks)].some((x) => x.id === c.id)) throw new EditError(`clip id '${c.id}' already exists`, "exists");
  if (a.end !== undefined && a.duration === undefined) c.duration = parseAt(tl, a.end) - parseAt(tl, a.at ?? a.start ?? 0);
  else if (a.duration === undefined) c.duration = defaultDuration(tl, c);
  c.duration = round6(parseTime(c.duration));
  return c;
}

function place(tl: Timeline, tr: Track, c: Clip, a: Dict) {
  const clips = tr.clips;
  if (tr.magnetic) {
    let idx = clips.length;
    if (a.after) idx = clips.indexOf(findClip(tl, a.after)[2]) + 1;
    else if (a.before) idx = clips.indexOf(findClip(tl, a.before)[2]);
    else if (a.index !== undefined) idx = +a.index;
    clips.splice(idx, 0, c);
    delete c.start;
  } else {
    if (a.at !== undefined || a.start !== undefined) c.start = round6(parseAt(tl, a.at ?? a.start));
    else if (a.after) c.start = round6(clipEnd(findClip(tl, a.after)[2]));
    else c.start = round6(trackEnd(tr));
    clips.push(c);
    clips.sort((x, y) => clipStart(x) - clipStart(y));
  }
}

function ensureTrack(tl: Timeline, id: string, type: string): Track {
  if (!tl.tracks.some((t) => t.id === id)) OPS.add_track.fn(null as any, tl, { id, kind: type === "audio" ? "audio" : "video", ...(id === "music" ? { role: "music", duck: -20 } : id === "voice" ? { role: "voice" } : {}) });
  return findTrack(tl, id);
}

/** "main#2" / "main#-1" -> clip id at that index on that track (at the time the op runs). */
function resolveRef(tl: Timeline, ref: string): string {
  const m = /^(.+)#(-?\d+)$/.exec(ref);
  if (!m) return ref;
  const tr = findTrack(tl, m[1]);
  const i = +m[2] < 0 ? tr.clips.length + +m[2] : +m[2];
  const c = tr.clips[i];
  if (!c) throw new EditError(`no clip at ${ref} (track has ${tr.clips.length})`, "not_found");
  return c.id;
}

/** A match_duration clip reference ("<id>" or "track#n") -> the id of the clip to follow; bad_ref if it is unknown, the clip itself, an until_end clip, or a cycle. */
function followTarget(tl: Timeline, c: Clip | null, ref: string): string {
  const hint = "name a clip on this timeline: an id or a ref like 'voice#-1'";
  let t: Clip;
  try { t = findClip(tl, resolveRef(tl, ref))[2]; }
  catch (e) { if (e instanceof EditError) throw new EditError(`match_duration '${ref}': ${e.message}`, "bad_ref", e.hint ?? hint); throw e; }
  const bad = (why: string, fix: string) => new EditError(`match_duration '${ref}': ${why}`, "bad_ref", fix);
  if (t === c) throw bad("a clip cannot follow its own duration", "name another clip");
  if (t.until_end) throw bad(`'${t.id}' has until_end, so its length follows the timeline end`, "follow a clip with its own duration");
  const clips = tl.tracks.flatMap((x) => x.clips);
  for (let x: Clip | undefined = t, seen = new Set<Clip>(); c && x && lengthTarget(x) !== undefined && !seen.has(x); x = clips.find((y) => y.id === lengthTarget(x!))) {
    seen.add(x);
    if (lengthTarget(x) === c.id) throw bad(`'${t.id}' already follows '${c.id}'`, "break the cycle: give one of the clips its own duration");
  }
  return t.id;
}

/** until_end and a followed length both set the duration */
function lengthOnce(c: Clip) {
  if (c.until_end && typeof c.match_duration === "string")
    throw new EditError("until_end and match_duration both set the length; keep one", "bad_value", `update_clip id=${c.id} until_end=null, or match_duration=null`);
}

/** a clip whose length was computed (it followed a clip, or its attach_to target) or stretched (until_end) becomes a plain-duration clip (its resolved length stays) */
function dropFollow(c: Clip) { if (computedDuration(c)) { delete c.match_duration; delete c.end_offset; } delete c.until_end; }

/** Put a piece cut from a clip at timeline time `start`. An attached piece keeps its target and moves by offset (resolve() recomputes its start from the target); others set start on non-magnetic tracks. */
function placeAt(tl: Timeline, tr: Track, piece: Clip, start: number) {
  if (piece.attach_to) { piece.offset = round6(start - clipStart(findClip(tl, piece.attach_to)[2])); }
  else if (!tr.magnetic) piece.start = round6(start);
}

/** An attached clip cannot sit on a magnetic track: starts there are computed from order, so an offset has no meaning. `to`: the target the clip is about to be attached to. */
function refuseAttachedMagnetic(c: Clip, dest: Track, to = c.attach_to) {
  if (to && dest.magnetic) throw new EditError(`'${c.id}' is attached to '${to}' and track '${dest.id}' is magnetic`, "attached_magnetic", `update_clip id=${c.id} attach_to=null first, or choose a non-magnetic track`);
}

/**
 * Shift `moved` clips of the non-magnetic track `tr` by d seconds; the other clips of `tr` keep their timeline place.
 * A moved clip with no moving ancestor in its attach_to chain moves by start (attached: by offset, clamped at 0); with one, it follows.
 * A clip of `tr` outside `moved` whose target moves gets its offset reset so it stays where it was. Clips on other tracks that follow a moved clip move with it.
 * Leaves the timeline resolved.
 */
function shiftClips(tl: Timeline, tr: Track, moved: Clip[], d: number) {
  const byId = new Map<string, Clip>([...allClips(tl.tracks)].map((x) => [x.id, x]));
  const inSet = new Set(moved), onTrack = new Set(tr.clips);
  // `seen`: a cycle saved with allow_invalid, or built earlier in the same batch, must not recurse forever; a chain of any depth is followed
  const moves = (c: Clip | undefined, seen = new Set<Clip>()): boolean => !!c && !seen.has(c) && (seen.add(c), inSet.has(c) || (!onTrack.has(c) && !!c.attach_to && moves(byId.get(c.attach_to), seen)));
  const stay: [Clip, number][] = [];
  for (const x of tr.clips) {
    const t = x.attach_to ? byId.get(x.attach_to) : undefined;
    if (!x.attach_to) { if (inSet.has(x)) x.start = round6(Math.max(0, clipStart(x) + d)); }
    else if (!t) continue;
    else if (inSet.has(x)) { if (!moves(t)) x.offset = round6(Math.max(0, clipStart(t) + parseTime(x.offset ?? 0) + d) - clipStart(t)); }
    else if (moves(t)) stay.push([x, clipStart(x)]);
  }
  resolve(tl); // the targets' real new starts (a shift can stop at 0)
  for (const [x, s] of stay) placeAt(tl, tr, x, s);
  if (stay.length) resolve(tl); // placeAt writes offsets only
}

function addClip(p: Project, tl: Timeline, a: Dict): Dict {
  if (a.attach_to) { a = { ...a, attach_to: resolveRef(tl, a.attach_to) }; findClip(tl, a.attach_to); }
  if (typeof a.match_duration === "string") a = { ...a, match_duration: followTarget(tl, null, a.match_duration) };
  if (!a.track) {
    const isAudio = a.type === "audio" || (a.src && AUDIO_EXT.has(extname(a.src).toLowerCase()));
    const t = a.words || a.srt ? "captions" : "text" in a ? "text" : isAudio ? "music" : "main";
    a = { ...a, track: t };
  }
  // "at" relative to end must be computed before this clip exists
  if (typeof a.at === "string" && /^end/i.test(a.at)) a = { ...a, at: parseAt(tl, a.at) };
  const c = makeClip(p, tl, a);
  lengthOnce(c);
  const tr = ensureTrack(tl, a.track, c.type);
  refuseAttachedMagnetic(c, tr);
  place(tl, tr, c, a);
  resolve(tl);
  return { id: c.id, type: c.type, track: tr.id, start: c.start, duration: c.duration };
}

op("add_clip", "Add a clip. Type is inferred (src/asset -> video|image|audio|lottie, text -> text, words/srt -> captions). " +
  "Magnetic tracks append back-to-back (index/after/before) and refuse attach_to (attached_magnetic); other tracks use 'at' (seconds, or 'end'/'end-2'). " +
  "preset expands a text/caption style (see capabilities). Any clip field may be passed directly.",
  { track: "track id (created if missing)", src: "file path (auto-import)", asset: "asset id", type: "clip type", at: "start", "index|after|before": "magnetic position", duration: "s", end: "alt. to duration", preset: "text/caption preset", "...": "any clip field" },
  addClip);

op("add_sequence", "Append many clips to a (magnetic) track: the fastest way to build a slideshow/montage. defaults apply to every item.",
  { track: "default main", items: "list of clip specs or paths", defaults: "shared fields (duration, transition, motion, fit...)" },
  (p, tl, a) => {
    const tid = a.track ?? "main";
    const out: Dict[] = [];
    (a.items ?? []).forEach((it: any, i: number) => {
      if (typeof it === "string") it = { src: it };
      const spec: Dict = { ...(a.defaults ?? {}), ...it, track: tid };
      const tr = tl.tracks.find((t) => t.id === tid);
      if (i === 0 && !("transition" in it) && (!tr || !tr.clips.length)) delete spec.transition;
      for (const k of Object.keys(spec)) if (spec[k] === undefined) delete spec[k];
      out.push(addClip(p, tl, spec));
    });
    return { added: out, track_end: +trackEnd(findTrack(tl, tid)).toFixed(3) };
  });

op("update_clip", "Merge fields into a clip: set {field: value}; null deletes. Shorthand: pass fields directly. start on an attached clip sets its offset (start with offset is refused); a clip on a magnetic track cannot be attached (attached_magnetic).",
  { id: "clip id", set: "fields (dicts merge; keyframes replace)" }, (p, tl, a) => {
    const [tr, , c] = findClip(tl, a.id);
    const patch: Dict = { ...(a.set ?? Object.fromEntries(Object.entries(a).filter(([k]) => k !== "op" && k !== "id"))) };
    if (patch.src) { patch.asset = importAsset(p, tl, patch.src); delete patch.src; }
    if (patch.attach_to) patch.attach_to = resolveRef(tl, patch.attach_to);
    if (typeof patch.match_duration === "string") patch.match_duration = followTarget(tl, c, patch.match_duration);
    if (patch.srt) patch.srt = absPath(patch.srt);
    for (const k of ["id", "type"]) if (k in patch && patch[k] !== c[k]) throw new EditError(`cannot change clip '${k}' with update_clip`, "immutable", "remove the clip and add a new one");
    if ("start" in patch && tr.magnetic) throw new EditError("start is computed on magnetic tracks", "magnetic", "use move_clip with index, or use a non-magnetic track");
    if (patch.preset) {
      const { preset, ...rest } = patch;
      Object.assign(patch, expandPreset(c.type as any, preset, String(c.text ?? ""), rest));
      delete patch.preset;
    }
    if (typeof patch.start === "string") patch.start = parseAt(tl, patch.start);
    if ("duration" in patch && !("match_duration" in patch)) ownDuration(c);
    deepMerge(c, patch);
    lengthOnce(c);
    if (patch.attach_to) refuseAttachedMagnetic(c, tr);
    if (c.attach_to && patch.start != null) { // an attached clip is placed by its offset, against the (new) target
      if ("offset" in patch) throw new EditError("start and offset both place an attached clip", "bad_value", "keep one of start and offset");
      placeAt(tl, tr, c, clipStart(c));
    }
    if (!tr.magnetic) tr.clips.sort((x, y) => clipStart(x) - clipStart(y));
    resolve(tl);
    return { id: c.id, start: c.start, duration: c.duration };
  });

op("remove_clip", "Remove a clip (and clips attached to it, and those attached to them; clips whose match_duration names it keep their last length as a plain number, listed in unlinked_durations). Magnetic tracks close the gap; ripple=true does it on other tracks too.", { id: "clip id", ripple: "bool", keep_attached: "detach instead of removing attached clips" }, (p, tl, a) => {
  const [tr, ci, c] = findClip(tl, a.id);
  tr.clips.splice(ci, 1);
  const attached: string[] = [], gone = new Set([c.id]), top = tl.tracks.flatMap((t) => t.clips);
  if (a.keep_attached) { for (const x of top) if (x.attach_to === c.id) delete x.attach_to; }
  else for (let n = -1; n !== gone.size;) { // a clip attached to a removed clip goes too, down the whole chain
    n = gone.size;
    for (const x of top) if (x.attach_to && gone.has(x.attach_to) && !gone.has(x.id)) { gone.add(x.id); attached.push(x.id); }
  }
  for (const t of tl.tracks) t.clips = t.clips.filter((x) => !attached.includes(x.id));
  if (a.ripple && !tr.magnetic) { const d = clipDur(c), s = clipStart(c); shiftClips(tl, tr, tr.clips.filter((x) => clipStart(x) >= s), -d); }
  const unlinked = unfollow(tl.tracks.flatMap((t) => t.clips), (id) => gone.has(id)); // a follower keeps its last length; it is not removed
  resolve(tl);
  return { removed: c.id, removed_attached: attached, unlinked_durations: unlinked };
});

op("move_clip", "Move a clip in time and/or to another track. An attached clip moves by its offset and stays attached; a magnetic track refuses it (attached_magnetic).", { id: "clip id", at: "start (non-magnetic)", shift: "+/- seconds", track: "destination", index: "magnetic position" }, (p, tl, a) => {
  const [tr, ci, c] = findClip(tl, a.id);
  const dest = a.track ? findTrack(tl, a.track) : tr;
  refuseAttachedMagnetic(c, dest);
  const old = clipStart(c);
  tr.clips.splice(ci, 1);
  const b: Dict = {};
  for (const k of ["index", "after", "before"]) if (k in a) b[k] = a[k];
  if (!dest.magnetic) b.at = a.shift !== undefined ? Math.max(0, old + parseTime(a.shift)) : a.at ?? old;
  if (dest.magnetic && b.index === 0) delete c.transition;
  place(tl, dest, c, b);
  if (c.attach_to) placeAt(tl, dest, c, clipStart(c));
  resolve(tl);
  return { id: c.id, track: dest.id, start: c.start };
});

op("trim_clip", "Trim: trim_start cuts N s from the head (moves in-point of video/audio/lottie/compound clips and shifts keyframes), trim_end from the tail; or set in/duration/end. A length edit ends until_end. An attached clip keeps its target and moves by its offset.",
  { id: "clip id", trim_start: "s", trim_end: "s", in: "source in", duration: "s", end: "timeline end" }, (p, tl, a) => {
    const [tr, , c] = findClip(tl, a.id);
    if (a.duration !== undefined || a.end !== undefined || a.trim_start || a.trim_end) ownDuration(c);
    const speed = Number(c.speed ?? 1) || 1;
    const in0 = parseTime(c.in ?? 0), d0 = clipDur(c);
    if (a.in !== undefined) c.in = round6(parseTime(a.in));
    if (a.duration !== undefined) c.duration = round6(parseTime(a.duration));
    if (a.end !== undefined) c.duration = round6(parseAt(tl, a.end) - clipStart(c));
    if (a.trim_start) {
      const d = parseTime(a.trim_start);
      // a reversed clip plays its source backwards: its head is the end of the content, so `in` stays; a freeze keeps its frame
      if (hasSourceTime(c) && !c.reverse && !c.freeze) c.in = round6(parseTime(c.in ?? 0) + d * speed);
      shiftKfs(c, -d);
      c.duration = round6(clipDur(c) - d);
      if (!tr.magnetic) placeAt(tl, tr, c, clipStart(c) + d);
    }
    if (a.trim_end) {
      const e = parseTime(a.trim_end);
      if (hasSourceTime(c) && c.reverse && !c.freeze) { // the tail of a reversed clip is the start of the content
        const ni = parseTime(c.in ?? 0) + e * speed;
        if (ni < 0) throw new EditError(`trim_end=${e} would move the in-point of '${c.id}' before 0`, "out_of_range", "the source has nothing before its start to extend into");
        c.in = round6(ni);
      }
      c.duration = round6(clipDur(c) - e);
    }
    if (clipDur(c) <= 0) throw new EditError("trim leaves a non-positive duration", "bad_trim");
    const out: Dict = { id: c.id, in: c.in ?? 0, start: c.start, duration: c.duration };
    // detached audio follows: same source in-point change, same amount cut from the head/tail
    const la = linkedAudio(tl, c);
    if (la && !c.reverse) {
      const au = la[1], head = a.trim_start ? parseTime(a.trim_start) : 0, tail = d0 - head - clipDur(c);
      const nd = clipDur(au) - head - tail, ni = parseTime(au.in ?? 0) + (parseTime(c.in ?? 0) - in0 + (c.freeze ? head * speed : 0)) * ((Number(au.speed ?? 1) || 1) / speed); // a freeze keeps its frame, its audio still advances
      if (nd > 0.04 && ni >= 0 && !computedDuration(au)) { au.in = round6(ni); au.duration = round6(nd); shiftKfs(au, -head); out.audio = au.id; }
      else out.warning = `detached audio '${au.id}' was not trimmed (it would become empty, or its length is computed); trim it yourself`;
    }
    resolve(tl);
    return { ...out, start: c.start, duration: c.duration };
  });

/** Give every clip nested in a copied compound a fresh id (ids are unique project-wide); fixes nested attach_to and match_duration references. */
function renameNested(tl: Timeline, c: Clip) {
  if (c.type !== "compound") return;
  const map = new Map<string, string>();
  const walk = (tracks: Track[]) => { for (const t of tracks) for (const x of t.clips) {
    const nid = newId(tl, PREFIX[x.type] ?? "clip"); map.set(x.id, nid); x.id = nid; // newId sees x's new id from now on
    if (x.type === "compound") walk(x.tracks ?? []);
  } };
  walk(c.tracks ?? []);
  const fix = (tracks: Track[]) => { for (const t of tracks) for (const x of t.clips) { if (x.attach_to && map.has(x.attach_to)) x.attach_to = map.get(x.attach_to); if (typeof x.match_duration === "string" && map.has(x.match_duration)) x.match_duration = map.get(x.match_duration); if (x.type === "compound") fix(x.tracks ?? []); } };
  fix(c.tracks ?? []);
}

/** Audio clip created by detach_audio/j_cut/l_cut for video clip v (same asset, connected to it). */
export function linkedAudio(tl: Timeline, v: Clip): [Track, Clip] | undefined {
  if (v.type !== "video") return undefined;
  for (const tr of tl.tracks) for (const x of tr.clips) if (x.type === "audio" && x.attach_to === v.id && x.asset === v.asset) return [tr, x];
  return undefined;
}

/** right half of a split: the same curves (focus pan, volume, ...) in its own clip-local time; a speed ramp can't be cut this way */
function rightKfs(c: Clip, left: number) {
  delete c.keyframes?.speed;
  shiftKfs(c, -left); // keyframes, effect windows and caption words; srt cues cannot be moved, so that split is refused
  if (c.keyframes && !Object.keys(c.keyframes).length) delete c.keyframes;
}

function splitAt(tl: Timeline, id: string, t: number): [Clip, Clip, Track, number] {
  const [tr, ci, c] = findClip(tl, id);
  resolve(tl);
  const s = clipStart(c), d = clipDur(c);
  if (!(s < t && t < s + d)) throw new EditError(`split point ${t} is outside clip ${c.id} (${s.toFixed(3)}–${(s + d).toFixed(3)})`, "out_of_range");
  const left = t - s;
  const right: Clip = structuredClone(c);
  right.id = newId(tl, PREFIX[c.type]);
  c.duration = round6(left); right.duration = round6(d - left);
  dropFollow(c); dropFollow(right); // both halves keep their split lengths
  if (c.type === "compound") right.in = round6(parseTime(c.in ?? 0) + left * (Number(c.speed ?? 1) || 1));
  if (c.type === "video" || c.type === "audio") {
    if (c.reverse) c.in = round6(parseTime(c.in ?? 0) + (d - left) * (Number(c.speed ?? 1) || 1)), right.in = round6(parseTime(right.in ?? 0));
    else right.in = round6(parseTime(c.in ?? 0) + left * (Number(c.speed ?? 1) || 1));
  }
  delete right.transition; delete right.enter; delete c.exit; delete c.fade_out; delete right.fade_in;
  rightKfs(right, left);
  if (c.type === "captions" && c.words) c.words = c.words.map(normWord).filter((w: any) => w.start < left);
  placeAt(tl, tr, right, t);
  tr.clips.splice(ci + 1, 0, right);
  renameNested(tl, right);
  // keep detached audio (J/L cuts) in sync: split it at the same time, the right half follows the right picture
  const la = linkedAudio(tl, c);
  if (la && !la[1].reverse) {
    const [atr, au] = la;
    const as = clipStart(au), ae = as + clipDur(au), asp = Number(au.speed ?? 1) || 1;
    if (as < t - 1e-6 && t < ae - 1e-6) {
      const ar: Clip = structuredClone(au);
      ar.id = newId(tl, "aud");
      ar.in = round6(parseTime(au.in ?? 0) + (t - as) * asp);
      ar.duration = round6(ae - t); au.duration = round6(t - as);
      dropFollow(au); dropFollow(ar);
      ar.attach_to = right.id; ar.offset = 0; ar.name = `audio of ${right.id}`;
      delete au.fade_out; delete ar.fade_in;
      rightKfs(ar, t - as);
      atr.clips.splice(atr.clips.indexOf(au) + 1, 0, ar);
    } else if (as >= t - 1e-6) { au.attach_to = right.id; au.offset = round6(as - t); }
  }
  resolve(tl);
  return [c, right, tr, ci];
}

op("split_clip", "Split a clip at a timeline time; returns the new right-hand clip id.", { id: "clip id", at: "timeline seconds" }, (p, tl, a) => {
  const [l, r] = splitAt(tl, a.id, parseAt(tl, a.at));
  return { left: l.id, right: r.id };
});

op("freeze_frame", "Freeze the frame at a timeline time for `duration` seconds (CapCut 'Freeze'). Later clips on a magnetic track are pushed back.",
  { id: "video clip id", at: "timeline seconds", duration: "s (2)" }, (p, tl, a) => {
    const [, , c0] = findClip(tl, a.id);
    if (c0.type !== "video") throw new EditError("freeze_frame needs a video clip", "bad_type");
    const t = parseAt(tl, a.at);
    const s = clipStart(c0), atStart = t <= s + 1e-3; // a freeze of the first frame plays before the clip
    const srcT = parseTime(c0.in ?? 0) + Math.max(0, t - s) * (Number(c0.speed ?? 1) || 1);
    let insertAfter = c0;
    if (!atStart && t < s + clipDur(c0) - 1e-3) insertAfter = splitAt(tl, a.id, t)[0];
    const [tr] = findClip(tl, insertAfter.id);
    const fz: Clip = { ...structuredClone(c0), id: newId(tl, "frz"), in: round6(srcT), duration: round6(parseTime(a.duration ?? 2)), freeze: true };
    for (const k of ["transition", "enter", "exit", "keyframes", "fade_in", "fade_out", "reverse"]) delete fz[k];
    dropFollow(fz);
    if (atStart && tr.magnetic && c0.transition) { fz.transition = c0.transition; delete c0.transition; } // the cut from the previous clip now leads into the freeze
    if (!tr.magnetic) shiftClips(tl, tr, tr.clips.filter((x) => clipStart(x) >= t - 1e-6), clipDur(fz)); // leaves the target's shifted start resolved for placeAt
    placeAt(tl, tr, fz, t);
    tr.clips.splice(tr.clips.indexOf(insertAfter) + (atStart ? 0 : 1), 0, fz);
    resolve(tl);
    return { id: fz.id, start: fz.start, duration: fz.duration };
  });

op("duplicate_clip", "Copy a clip (optionally to another track/time). A magnetic track refuses a copy of an attached clip (attached_magnetic).", { id: "clip id", track: "track id", at: "start" }, (p, tl, a) => {
  const [tr, , c] = findClip(tl, a.id);
  const dup: Clip = { ...structuredClone(c), id: newId(tl, PREFIX[c.type]) };
  delete dup.group; // a copy is not part of the expanded compound's regroup set
  const dest = a.track ? findTrack(tl, a.track) : tr;
  refuseAttachedMagnetic(c, dest);
  place(tl, dest, dup, dest.magnetic ? (dest === tr ? { after: c.id } : {}) : { at: a.at ?? clipEnd(c) });
  if (!dest.magnetic) {
    placeAt(tl, dest, dup, clipStart(dup));
    if (dup.attach_to && dup.match_duration === true) { delete dup.match_duration; delete dup.end_offset; } // the copy sits elsewhere: it keeps the length it had
  }
  renameNested(tl, dup);
  const la = linkedAudio(tl, c); // the copy of a picture with detached sound gets its own copy of that sound, connected to it
  if (la) {
    const ad: Clip = { ...structuredClone(la[1]), id: newId(tl, PREFIX.audio), attach_to: dup.id, name: `audio of ${dup.id}` };
    delete ad.group;
    la[0].clips.push(ad);
    la[0].clips.sort((x, y) => clipStart(x) - clipStart(y));
  }
  resolve(tl);
  return { id: dup.id, track: dest.id, start: dup.start, ...(la ? { audio: la[0].clips.find((x) => x.attach_to === dup.id)!.id } : {}) };
});

op("set_keyframes", "Animate a property: [[t, value, easing?], ...], t relative to clip start. prop 'speed' = speed ramp (video audio is dropped).",
  { id: "clip id", prop: "x|y|scale|scale_x|scale_y|rotation|opacity|blur|volume|speed", keyframes: "list or null" }, (p, tl, a) => {
    const [, , c] = findClip(tl, a.id);
    const k = (c.keyframes ??= {});
    if (a.keyframes == null) delete k[a.prop]; else k[a.prop] = a.keyframes;
    if (!Object.keys(k).length) delete c.keyframes;
    return { id: c.id, keyframes: c.keyframes ?? {} };
  });

op("add_transition", "Set the transition into a clip from the previous clip on its track. An attached clip moves by its offset and stays attached.",
  { to: "incoming clip id", type: TRANSITIONS.join("|"), duration: "s (0.5)" }, (p, tl, a) => {
    const [tr, ci, c] = findClip(tl, a.to ?? a.id);
    if (ci === 0) throw new EditError("first clip on the track has no previous clip", "no_previous", "use update_clip enter: 'fade' instead");
    const t = a.type ?? "crossfade";
    if (t === "none") delete c.transition;
    else {
      if (!TRANSITIONS.includes(t)) { const s = suggest(t, TRANSITIONS); throw new EditError(`unknown transition '${t}'`, "bad_transition", s ? `did you mean '${s}'?` : TRANSITIONS.join(", ")); }
      c.transition = { type: t, duration: parseTime(a.duration ?? 0.5) };
      if (!tr.magnetic) placeAt(tl, tr, c, Math.max(0, clipEnd(tr.clips[ci - 1]) - c.transition.duration));
    }
    resolve(tl);
    return { id: c.id, transition: c.transition ?? null, start: c.start };
  });

op("add_effect", "Add a CapCut-style effect to a clip (or to the whole video with id omitted).",
  { id: "clip id (omit = whole frame)", type: Object.keys(EFFECTS).join("|"), start: "s (relative to clip)", duration: "s", "...": "effect params (intensity, amount, ratio...)" }, (p, tl, a) => {
    const { op: _o, id, ...fx } = a;
    if (!(fx.type in EFFECTS)) { const s = suggest(fx.type, Object.keys(EFFECTS)); throw new EditError(`unknown effect '${fx.type}'`, "bad_effect", s ? `did you mean '${s}'?` : Object.keys(EFFECTS).join(", ")); }
    if (!id) { (tl.settings.effects ??= []).push(fx); return { scope: "global", effects: tl.settings.effects.length }; }
    const [, , c] = findClip(tl, id);
    (c.effects ??= []).push(fx);
    return { id: c.id, effects: c.effects.length };
  });

op("add_marker", "Add a timeline marker.", { t: "seconds", label: "text" }, (p, tl, a) => {
  (tl.markers ??= []).push({ t: parseAt(tl, a.t), label: a.label ?? "" });
  tl.markers.sort((x, y) => x.t - y.t);
  return { markers: tl.markers.length };
});
op("clear_markers", "Remove markers (all, or those whose label contains match).", { match: "substring" }, (p, tl, a) => {
  const before = tl.markers.length;
  tl.markers = a.match ? tl.markers.filter((m) => !String(m.label).includes(a.match)) : [];
  return { removed: before - tl.markers.length };
});

// ---------------------------------------------------------------- captions / voice / beats / templates
function addCaptions(p: Project, tl: Timeline, a: Dict) {
  a = { ...a };
  if (a.transcribe_range !== undefined && !a.transcribe) throw new EditError("transcribe_range needs transcribe", "bad_value", "give transcribe=<media> with it, or drop transcribe_range");
  if (a.transcribe) {
    const s = a.transcribe;
    const path = tl.assets[s] ? p.abs(tl.assets[s].path) : absPath(s);
    a.words = AN.transcribe(path, a.language, undefined, a.transcribe_range).words;
    delete a.transcribe; delete a.language; delete a.transcribe_range;
  }
  if (!(a.words?.length || a.srt)) throw new EditError("add_captions needs words, srt or transcribe", "missing_input");
  if (a.srt) a.srt = absPath(a.srt);
  const sample = captionWords(a).map((w) => w.text).join(" ");
  const presetName = a.preset ?? "tiktok";
  delete a.preset;
  const given = Object.fromEntries(Object.entries(a).filter(([k]) => !["op", "track", "at"].includes(k)));
  const spec = { ...expandPreset("captions", presetName, sample, given), track: a.track ?? "captions", at: a.at ?? 0, type: "captions" };
  return addClip(p, tl, spec);
}
op("add_captions", "Add animated captions from word timings, .srt/.vtt, or by transcribing media (needs whisper). preset: tiktok (default), bold_pop, pill, clean, reveal, neon.",
  { words: "[{text,start,end}]", srt: "path", transcribe: "media path or asset id", transcribe_range: "[start, end] seconds of the media to transcribe: only the speech; whisper may invent text over a long music-only stretch and times words early after a music lead-in", language: "for transcribe", preset: "caption preset", track: "captions", at: "start (0)", style: "karaoke|word|reveal|line", "...": "text style overrides" },
  addCaptions);

op("add_voiceover", "Text-to-speech into media/ (voice: OS voice e.g. 'Linh' via say/SAPI/espeak, 'piper[:model.onnx]', or 'openai:<voice>' for an OpenAI-compatible server; see list_voices), placed on the voice track. captions=true (or a caption preset name) adds timed captions. Each sentence is synthesized separately (one request per sentence for openai; rate applies to each), so captions follow the real sentence timing. piper runs with ORT_DISABLE_TELEMETRY=1.",
  { text: "script", voice: "voice name, optionally provider-prefixed", rate: "words/min", track: "voice", at: "start (default end of voice track)", captions: "bool | preset name | caption fields" }, (p, tl, a) => {
    const out = join(p.root, "media", `vo-${Date.now()}.wav`);
    p.stage(out);
    const res = AN.tts(a.text, out, a.voice, a.rate, p.root);
    const tid = a.track ?? "voice";
    const tr = ensureTrack(tl, tid, "audio");
    if (!tr.role) tr.role = "voice";
    const at = a.at !== undefined ? parseAt(tl, a.at) : trackEnd(tr);
    const clip = addClip(p, tl, { track: tid, src: out, at });
    const result: Dict = { clip, duration: res.duration, path: p.rel(out) };
    if (a.captions) {
      const speech = AN.silence(out, -40, 0.15).speech;
      // each sentence keeps its real span; clause pauses inside it still align when detectable
      const words = res.sentences.flatMap((s) => {
        const inside = speech.map(([x, y]) => [Math.max(x, s.start), Math.min(y, s.end)]).filter(([x, y]) => y - x > 0.05);
        return scriptToWords(s.text, inside.length ? inside : [[s.start, s.end]]);
      });
      const extra = typeof a.captions === "object" ? a.captions : typeof a.captions === "string" ? { preset: a.captions } : {};
      result.captions = addCaptions(p, tl, { words, at, ...extra });
    }
    return result;
  });

const beatCache = new Map<string, number[]>();
function beatList(p: Project, tl: Timeline, b: unknown): number[] {
  if (Array.isArray(b)) return b.map(Number);
  if (typeof b !== "string") throw new EditError("beats must be a list of seconds, a beats .json, an audio path or asset id", "bad_beats");
  const path = tl.assets[b] ? p.abs(tl.assets[b].path) : absPath(b);
  if (path.endsWith(".json")) return JSON.parse(readFileSync(path, "utf8")).beats;
  if (!existsSync(path)) throw new EditError(`file not found: ${path}`, "not_found");
  const st = statSync(path), key = `${path}\0${st.mtimeMs}\0${st.size}`; // a replaced file is another key
  if (!beatCache.has(key)) beatCache.set(key, AN.beats(path).beats);
  return beatCache.get(key)!;
}

op("snap_to_beats", "Retime a magnetic track so every cut lands on a beat. beats: list | beats.json | audio path | asset id. Clips with a computed length (match_duration) are kept as they are (kept_computed).",
  { track: "main", beats: "required", every: "cut every N beats (1)", offset: "first beat index (0)" }, (p, tl, a) => {
    const tr = findTrack(tl, a.track ?? "main");
    if (!tr.magnetic) throw new EditError("snap_to_beats works on magnetic tracks", "magnetic");
    const beats = beatList(p, tl, a.beats);
    const every = +(a.every ?? 1), off = +(a.offset ?? 0);
    const cuts = beats.filter((_, i) => i >= off && (i - off) % every === 0);
    if (cuts.length < 2) throw new EditError("not enough beats", "not_enough");
    resolve(tl);
    const starts = [0, ...cuts.slice(1, tr.clips.length)];
    const changed: Clip[] = [], kept: string[] = [];
    tr.clips.forEach((c, i) => {
      if (i + 1 >= starts.length) return;
      if (computedDuration(c)) { kept.push(c.id); return; } // its length is computed; retiming it would be overwritten
      const nxt = tr.clips[i + 1];
      const td = nxt?.transition ? normAnim(nxt.transition, 0.5)!.duration : 0;
      const dur = starts[i + 1] - starts[i] + td;
      if (dur > 0.05) { c.duration = round6(dur); delete c.until_end; changed.push(c); }
    });
    resolve(tl);
    return { retimed: changed.map((c) => ({ id: c.id, duration: c.duration })), kept_computed: kept, beats_used: changed.length, track_end: +trackEnd(tr).toFixed(3) };
  });

op("remove_silence", "Cut dead air out of a video/audio clip (Auto-Editor / CapCut 'remove pauses'): the clip becomes its speech segments; a video's detached audio is cut into the same segments.",
  { id: "clip id", noise_db: "-35", min_silence: "s (0.4)", padding: "s kept around speech (0.1)" }, (p, tl, a) => {
    const [tr, ci, c] = findClip(tl, a.id);
    if (c.type !== "video" && c.type !== "audio") throw new EditError("remove_silence needs a video or audio clip", "bad_type");
    resolve(tl);
    const la = linkedAudio(tl, c);
    if (la?.[1].reverse) throw new EditError(`the detached audio '${la[1].id}' of '${c.id}' plays reversed, so it cannot be cut into the same segments`, "reversed_audio", `update_clip id=${la[1].id} set={reverse: null}, or remove_clip id=${la[1].id}`);
    const res = AN.silence(p.abs(tl.assets[c.asset].path), +(a.noise_db ?? -35), +(a.min_silence ?? 0.4));
    const pad = +(a.padding ?? 0.1), speed = Number(c.speed ?? 1) || 1;
    const cin = parseTime(c.in ?? 0), cout = cin + clipDur(c) * speed;
    const segs: number[][] = [];
    for (const [s0, e0] of res.speech) {
      const s = Math.max(cin, s0 - pad), e = Math.min(cout, e0 + pad);
      if (e - s > 0.08) { const l = segs[segs.length - 1]; if (l && s <= l[1]) l[1] = e; else segs.push([s, e]); }
    }
    if (!segs.length) throw new EditError("no speech found with these settings", "no_speech", "raise noise_db (e.g. -30) or lower min_silence");
    tr.clips.splice(ci, 1);
    let t = clipStart(c);
    const ids: string[] = [];
    segs.forEach(([s, e], j) => {
      const nc: Clip = structuredClone(c);
      if (j) { nc.id = newId(tl, PREFIX[c.type]); delete nc.transition; delete nc.enter; delete nc.fade_in; }
      if (j < segs.length - 1) { delete nc.exit; delete nc.fade_out; } // the fades and the exit belong to the ends of the whole clip
      nc.in = round6(s); nc.duration = round6((e - s) / speed); delete nc.keyframes; dropFollow(nc);
      shiftKfs(nc, -(s - cin) / speed); // effect windows stay on their content
      placeAt(tl, tr, nc, t); t += nc.duration as number;
      tr.clips.splice(ci + j, 0, nc);
      ids.push(nc.id);
    });
    if (la) { // detached audio is cut into the same segments, each attached to its picture with the same lead
      const [atr, au] = la, vs = clipStart(c), ve = clipEnd(c), as = clipStart(au), ae = as + clipDur(au), asp = Number(au.speed ?? 1) || 1;
      // [lo, hi) is the source run (in pre-cut timeline time) and off its place from the segment's start
      const parts: { j: number; lo: number; hi: number; off: number }[] = [];
      const add = (j: number, lo: number, hi: number, off: number) => {
        if (hi - lo <= 1e-3) return;
        const l = parts[parts.length - 1]; // runs that touch in the source and on the timeline stay one piece
        if (l && l.j === j && Math.abs(l.hi - lo) < 1e-6 && Math.abs(l.off + l.hi - l.lo - off) < 1e-6) l.hi = hi; else parts.push({ j, lo, hi, off });
      };
      segs.forEach(([s, e], j) => {
        const o0 = vs + (s - cin) / speed, o1 = vs + (e - cin) / speed; // where the segment sat before the cut
        if (j === 0 && as < vs - 1e-6) add(j, as, Math.min(vs, ae), as - vs); // a J-cut lead keeps its length before the first segment
        add(j, Math.max(as, o0), Math.min(ae, o1), Math.max(as, o0) - o0);
        if (j === segs.length - 1 && ae > ve + 1e-6) add(j, Math.max(ve, as), ae, o1 - o0 + Math.max(ve, as) - ve); // an L-cut lead keeps its length after the last
      });
      let at = atr.clips.indexOf(au);
      atr.clips.splice(at, 1);
      parts.forEach(({ j, lo, hi, off }, k) => {
        const ap: Clip = structuredClone(au);
        if (k) { ap.id = newId(tl, "aud"); ap.name = `audio of ${ids[j]}`; }
        ap.in = round6(parseTime(au.in ?? 0) + (lo - as) * asp); ap.duration = round6(hi - lo);
        ap.attach_to = ids[j]; ap.offset = round6(off);
        dropFollow(ap);
        if (k) delete ap.fade_in;
        if (k < parts.length - 1) delete ap.fade_out;
        if (lo > as) rightKfs(ap, lo - as);
        atr.clips.splice(at++, 0, ap);
      });
    }
    resolve(tl);
    const kept = segs.reduce((x, [s, e]) => x + e - s, 0);
    return { segments: ids, kept_seconds: +(kept / speed).toFixed(3), removed_seconds: +((cout - cin - kept) / speed).toFixed(3) };
  });

op("apply_template", "Build a whole video from a template (expands into ordinary ops you can edit afterwards). Templates: " + Object.keys(TEMPLATES).join(", ") + ".",
  { name: Object.keys(TEMPLATES).join("|"), "...": "template args (see capabilities.templates)" }, (p, tl, a) => {
    const t = TEMPLATES[a.name];
    if (!t) { const s = suggest(a.name, Object.keys(TEMPLATES)); throw new EditError(`unknown template '${a.name}'`, "bad_template", `${s ? `did you mean '${s}'? ` : ""}templates: ${Object.keys(TEMPLATES).join(", ")}`); }
    if (["slideshow", "promo", "beat_montage"].includes(a.name) && !a.media?.length) throw new EditError(`template '${a.name}' needs media: [paths]`, "missing_arg");
    const ops = t.build(a);
    const results = ops.map((o, i) => {
      const { op: name, ...args } = o;
      try { return { op: name, ...OPS[name].fn(p, tl, args) }; }
      catch (e: any) { if (e instanceof EditError) e.path = `template ${a.name} step ${i} (${name})`; throw e; }
    });
    return { template: a.name, steps: results.length, results, duration: totalDuration(resolve(tl)) };
  });

op("replace_timeline", "Replace the whole timeline JSON (validated, undoable). A timeline that carries `revision` replaces only a project still at that revision (else conflict: re-read it and resend); without `revision` it replaces whatever is there. The saved revision is always the project's own.", { timeline: "full timeline object" }, (p, tl, a) => {
  const n = a.timeline;
  if (!n || typeof n !== "object" || !n.tracks || !n.settings) throw new EditError("timeline must contain settings and tracks", "bad_timeline");
  if (n.version !== SCHEMA_VERSION)
    throw new EditError(`the op input timeline has schema version ${JSON.stringify(n.version) ?? "missing"}; this build uses version ${SCHEMA_VERSION}`, "bad_version", `set "version": ${SCHEMA_VERSION}`);
  if (n.revision != null) checkRevision(n.revision, tl.revision);
  n.assets ??= {}; n.markers ??= [];
  const revision = tl.revision; // the project's own counter: an input's revision is ignored
  for (const k of Object.keys(tl)) delete (tl as Dict)[k];
  Object.assign(tl, structuredClone(n), { revision });
  return { tracks: tl.tracks.length, duration: totalDuration(resolve(tl)) };
});

// ---------------------------------------------------------------- pro editing ops (separate modules, registered here)
export interface OpHelpers {
  op: typeof op; PREFIX: typeof PREFIX; parseAt: typeof parseAt; place: typeof place; resolveRef: typeof resolveRef;
  ensureTrack: typeof ensureTrack; splitAt: typeof splitAt; trackEnd: typeof trackEnd; addClip: typeof addClip; importAsset: typeof importAsset;
  refuseAttachedMagnetic: typeof refuseAttachedMagnetic;
}
const helpers: OpHelpers = { op, PREFIX, parseAt, place, resolveRef, ensureTrack, splitAt, trackEnd, addClip, importAsset, refuseAttachedMagnetic };
registerEditOps(helpers);
registerCompoundOps(helpers);
registerAudioOps(helpers);
registerVisionOps(helpers);

// ---------------------------------------------------------------- runner
export function applyOps(p: Project, tl: Timeline, ops: Dict[]): [Timeline, Dict[]] {
  const work = structuredClone(tl);
  const results: Dict[] = [];
  ops.forEach((o, i) => {
    if (!o || typeof o !== "object" || !o.op) throw new EditError(`ops[${i}] must be an object with an 'op' field`, "bad_op", undefined, `ops[${i}]`);
    const def = OPS[o.op];
    if (!def) { const s = suggest(o.op, Object.keys(OPS)); throw new EditError(`ops[${i}]: unknown op '${o.op}'`, "unknown_op", `${s ? `did you mean '${s}'? ` : ""}ops: ${Object.keys(OPS).join(", ")}`, `ops[${i}]`); }
    try {
      const { op: _n, ...args } = o;
      results.push({ op: o.op, ...def.fn(p, work, args) });
    } catch (e: any) {
      if (e instanceof EditError) { e.path = e.path ? `ops[${i}](${o.op}) ${e.path}` : `ops[${i}](${o.op})`; throw e; }
      if (e instanceof TypeError && /undefined|null/.test(e.message)) throw new EditError(`ops[${i}](${o.op}): missing or invalid argument (${e.message})`, "missing_arg", `args: ${JSON.stringify(def.args)}`, `ops[${i}]`);
      throw e;
    }
  });
  resolve(work);
  return [work, results];
}

export const opsDoc = () => Object.fromEntries(Object.entries(OPS).map(([k, v]) => [k, { doc: v.doc, args: v.args }]));
export { firstCovering };
