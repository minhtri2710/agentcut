// Edit operations. Every op is {"op": name, ...args}; batches are atomic (applied to a copy).
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { basename, extname, join, resolve as presolve } from "node:path";
import * as AN from "./analyze.ts";
import { AUDIO_FX_KEYS } from "./audiofx.ts";
import { firstCovering } from "./fonts.ts";
import { AUDIO_EXT, probe } from "./media.ts";
import {
  allClips, CLIP_TYPES, type Clip, clipDur, clipEnd, clipStart, deepMerge, type Dict, EditError, EFFECTS, findClip, findTrack, newId,
  normAnim, parseTime, PRESETS, resolve, round6, suggest, type Timeline, totalDuration, type Track, TRANSITIONS,
} from "./model.ts";
import { expandPreset, TEMPLATES } from "./presets.ts";
import type { Project } from "./project.ts";
import { captionWords, scriptToWords } from "./captions.ts";
import { registerEditOps, shiftKfs } from "./ops-edit.ts";
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
  if (copy && p) {
    let dst = join(p.root, "media", basename(src));
    for (let i = 1; existsSync(dst) && presolve(dst) !== src; i++) dst = join(p.root, "media", `${basename(src, extname(src))}-${i}${extname(src)}`);
    if (presolve(dst) !== src) copyFileSync(src, dst);
    src = dst;
  }
  const info = probe(src);
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
  const strip = (tracks: Track[]) => { for (const t of tracks) { t.clips = t.clips.filter((c) => c.asset !== a.id); for (const c of t.clips) if (c.type === "compound") strip(c.tracks ?? []); } };
  strip(tl.tracks);
  delete tl.assets[a.id];
  return { removed: a.id, removed_clips: users };
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

op("update_track", "Update track properties (set: {...}).", { id: "track id", set: "fields" }, (p, tl, a) => {
  const tr = findTrack(tl, a.id);
  const patch = { ...(a.set ?? Object.fromEntries(Object.entries(a).filter(([k]) => k !== "op" && k !== "id"))) };
  delete patch.clips;
  deepMerge(tr, patch);
  return { track: tr.id };
});
op("remove_track", "Delete a track and its clips.", { id: "track id" }, (p, tl, a) => {
  const tr = findTrack(tl, a.id);
  tl.tracks.splice(tl.tracks.indexOf(tr), 1);
  return { removed: tr.id, clips: tr.clips.map((c) => c.id) };
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
  else if (tl.tracks.some((t) => t.clips.some((x) => x.id === c.id))) throw new EditError(`clip id '${c.id}' already exists`, "exists");
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

function addClip(p: Project, tl: Timeline, a: Dict): Dict {
  if (a.attach_to) { a = { ...a, attach_to: resolveRef(tl, a.attach_to) }; findClip(tl, a.attach_to); }
  if (!a.track) {
    const isAudio = a.type === "audio" || (a.src && AUDIO_EXT.has(extname(a.src).toLowerCase()));
    const t = a.words || a.srt ? "captions" : "text" in a ? "text" : isAudio ? "music" : "main";
    a = { ...a, track: t };
  }
  // "at" relative to end must be computed before this clip exists
  if (typeof a.at === "string" && /^end/i.test(a.at)) a = { ...a, at: parseAt(tl, a.at) };
  const c = makeClip(p, tl, a);
  const tr = ensureTrack(tl, a.track, c.type);
  place(tl, tr, c, a);
  resolve(tl);
  return { id: c.id, type: c.type, track: tr.id, start: c.start, duration: c.duration };
}

op("add_clip", "Add a clip. Type is inferred (src/asset -> video|image|audio|lottie, text -> text, words/srt -> captions). " +
  "Magnetic tracks append back-to-back (index/after/before); other tracks use 'at' (seconds, or 'end'/'end-2'). " +
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

op("update_clip", "Merge fields into a clip: set {field: value}; null deletes. Shorthand: pass fields directly.",
  { id: "clip id", set: "fields (dicts merge; keyframes replace)" }, (p, tl, a) => {
    const [tr, , c] = findClip(tl, a.id);
    const patch: Dict = { ...(a.set ?? Object.fromEntries(Object.entries(a).filter(([k]) => k !== "op" && k !== "id"))) };
    if (patch.src) { patch.asset = importAsset(p, tl, patch.src); delete patch.src; }
    if (patch.attach_to) patch.attach_to = resolveRef(tl, patch.attach_to);
    if (patch.srt) patch.srt = absPath(patch.srt);
    for (const k of ["id", "type"]) if (k in patch && patch[k] !== c[k]) throw new EditError(`cannot change clip '${k}' with update_clip`, "immutable", "remove the clip and add a new one");
    if ("start" in patch && tr.magnetic) throw new EditError("start is computed on magnetic tracks", "magnetic", "use move_clip with index, or use a non-magnetic track");
    if (patch.preset) {
      const { preset, ...rest } = patch;
      Object.assign(patch, expandPreset(c.type as any, preset, String(c.text ?? ""), rest));
      delete patch.preset;
    }
    if (typeof patch.start === "string") patch.start = parseAt(tl, patch.start);
    deepMerge(c, patch);
    if (!tr.magnetic) tr.clips.sort((x, y) => clipStart(x) - clipStart(y));
    resolve(tl);
    return { id: c.id, start: c.start, duration: c.duration };
  });

op("remove_clip", "Remove a clip (and clips attached to it). Magnetic tracks close the gap; ripple=true does it on other tracks too.", { id: "clip id", ripple: "bool", keep_attached: "detach instead of removing attached clips" }, (p, tl, a) => {
  const [tr, ci, c] = findClip(tl, a.id);
  tr.clips.splice(ci, 1);
  const attached: string[] = [];
  for (const t of tl.tracks) t.clips = t.clips.filter((x) => {
    if (x.attach_to !== c.id) return true;
    if (a.keep_attached) { delete x.attach_to; return true; }
    attached.push(x.id); return false;
  });
  if (a.ripple && !tr.magnetic) { const d = clipDur(c), s = clipStart(c); for (const x of tr.clips) if (clipStart(x) >= s) x.start = round6(Math.max(0, clipStart(x) - d)); }
  resolve(tl);
  return { removed: c.id, removed_attached: attached };
});

op("move_clip", "Move a clip in time and/or to another track.", { id: "clip id", at: "start (non-magnetic)", shift: "+/- seconds", track: "destination", index: "magnetic position" }, (p, tl, a) => {
  const [tr, ci, c] = findClip(tl, a.id);
  const dest = a.track ? findTrack(tl, a.track) : tr;
  const old = clipStart(c);
  tr.clips.splice(ci, 1);
  const b: Dict = {};
  for (const k of ["index", "after", "before"]) if (k in a) b[k] = a[k];
  if (!dest.magnetic) b.at = a.shift !== undefined ? Math.max(0, old + parseTime(a.shift)) : a.at ?? old;
  if (dest.magnetic && b.index === 0) delete c.transition;
  place(tl, dest, c, b);
  resolve(tl);
  return { id: c.id, track: dest.id, start: c.start };
});

op("trim_clip", "Trim: trim_start cuts N s from the head (moves in-point), trim_end from the tail; or set in/duration/end.",
  { id: "clip id", trim_start: "s", trim_end: "s", in: "source in", duration: "s", end: "timeline end" }, (p, tl, a) => {
    const [tr, , c] = findClip(tl, a.id);
    const speed = Number(c.speed ?? 1) || 1;
    const in0 = parseTime(c.in ?? 0), d0 = clipDur(c);
    if (a.in !== undefined) c.in = round6(parseTime(a.in));
    if (a.duration !== undefined) c.duration = round6(parseTime(a.duration));
    if (a.end !== undefined) c.duration = round6(parseAt(tl, a.end) - clipStart(c));
    if (a.trim_start) {
      const d = parseTime(a.trim_start);
      c.in = round6(parseTime(c.in ?? 0) + d * speed);
      c.duration = round6(clipDur(c) - d);
      if (!tr.magnetic) c.start = round6(clipStart(c) + d);
    }
    if (a.trim_end) c.duration = round6(clipDur(c) - parseTime(a.trim_end));
    if (clipDur(c) <= 0) throw new EditError("trim leaves a non-positive duration", "bad_trim");
    const out: Dict = { id: c.id, in: c.in ?? 0, start: c.start, duration: c.duration };
    // detached audio follows: same source in-point change, same amount cut from the head/tail
    const la = linkedAudio(tl, c);
    if (la && !c.reverse) {
      const au = la[1], head = a.trim_start ? parseTime(a.trim_start) : 0, tail = d0 - head - clipDur(c);
      const nd = clipDur(au) - head - tail, ni = parseTime(au.in ?? 0) + (parseTime(c.in ?? 0) - in0) * ((Number(au.speed ?? 1) || 1) / speed);
      if (nd > 0.04 && ni >= 0) { au.in = round6(ni); au.duration = round6(nd); out.audio = au.id; }
      else out.warning = `detached audio '${au.id}' was not trimmed (it would become empty); trim it yourself`;
    }
    resolve(tl);
    return { ...out, start: c.start };
  });

/** Give every clip nested in a copied compound a fresh id (ids are unique project-wide); fixes nested attach_to. */
function renameNested(tl: Timeline, c: Clip) {
  if (c.type !== "compound") return;
  const map = new Map<string, string>();
  const walk = (tracks: Track[]) => { for (const t of tracks) for (const x of t.clips) {
    const nid = newId(tl, PREFIX[x.type] ?? "clip"); map.set(x.id, nid); x.id = nid; // newId sees x's new id from now on
    if (x.type === "compound") walk(x.tracks ?? []);
  } };
  walk(c.tracks ?? []);
  const fix = (tracks: Track[]) => { for (const t of tracks) for (const x of t.clips) { if (x.attach_to && map.has(x.attach_to)) x.attach_to = map.get(x.attach_to); if (x.type === "compound") fix(x.tracks ?? []); } };
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
  if (!c.keyframes) return;
  delete c.keyframes.speed;
  shiftKfs(c, -left);
  if (!Object.keys(c.keyframes).length) delete c.keyframes;
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
  if (c.type === "compound") right.in = round6(parseTime(c.in ?? 0) + left * (Number(c.speed ?? 1) || 1));
  if (c.type === "video" || c.type === "audio") {
    if (c.reverse) c.in = round6(parseTime(c.in ?? 0) + (d - left) * (Number(c.speed ?? 1) || 1)), right.in = round6(parseTime(right.in ?? 0));
    else right.in = round6(parseTime(c.in ?? 0) + left * (Number(c.speed ?? 1) || 1));
  }
  delete right.transition; delete right.enter; delete c.exit; delete c.fade_out; delete right.fade_in;
  rightKfs(right, left);
  if (c.type === "captions" && c.words) {
    right.words = c.words.filter((w: any) => w.end > left).map((w: any) => ({ ...w, start: round6(w.start - left), end: round6(w.end - left) }));
    c.words = c.words.filter((w: any) => w.start < left);
  }
  if (!tr.magnetic) right.start = round6(t);
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
    const s = clipStart(c0);
    const srcT = parseTime(c0.in ?? 0) + (t - s) * (Number(c0.speed ?? 1) || 1);
    let insertAfter = c0;
    if (t > s + 1e-3 && t < s + clipDur(c0) - 1e-3) insertAfter = splitAt(tl, a.id, t)[0];
    const [tr, ci] = findClip(tl, insertAfter.id);
    const fz: Clip = { ...structuredClone(c0), id: newId(tl, "frz"), in: round6(srcT), duration: round6(parseTime(a.duration ?? 2)), freeze: true };
    for (const k of ["transition", "enter", "exit", "keyframes", "fade_in", "fade_out", "reverse"]) delete fz[k];
    if (!tr.magnetic) {
      fz.start = round6(t);
      for (const x of tr.clips) if (clipStart(x) >= t - 1e-6) x.start = round6(clipStart(x) + clipDur(fz));
    }
    tr.clips.splice(ci + 1, 0, fz);
    resolve(tl);
    return { id: fz.id, start: fz.start, duration: fz.duration };
  });

op("duplicate_clip", "Copy a clip (optionally to another track/time).", { id: "clip id", track: "track id", at: "start" }, (p, tl, a) => {
  const [tr, , c] = findClip(tl, a.id);
  const dup: Clip = { ...structuredClone(c), id: newId(tl, PREFIX[c.type]) };
  delete dup.group; // a copy is not part of the expanded compound's regroup set
  const dest = a.track ? findTrack(tl, a.track) : tr;
  place(tl, dest, dup, dest.magnetic ? (dest === tr ? { after: c.id } : {}) : { at: a.at ?? clipEnd(c) });
  renameNested(tl, dup);
  resolve(tl);
  return { id: dup.id, track: dest.id, start: dup.start };
});

op("set_keyframes", "Animate a property: [[t, value, easing?], ...], t relative to clip start. prop 'speed' = speed ramp (video audio is dropped).",
  { id: "clip id", prop: "x|y|scale|scale_x|scale_y|rotation|opacity|blur|volume|speed", keyframes: "list or null" }, (p, tl, a) => {
    const [, , c] = findClip(tl, a.id);
    const k = (c.keyframes ??= {});
    if (a.keyframes == null) delete k[a.prop]; else k[a.prop] = a.keyframes;
    if (!Object.keys(k).length) delete c.keyframes;
    return { id: c.id, keyframes: c.keyframes ?? {} };
  });

op("add_transition", "Set the transition into a clip from the previous clip on its track.",
  { to: "incoming clip id", type: TRANSITIONS.join("|"), duration: "s (0.5)" }, (p, tl, a) => {
    const [tr, ci, c] = findClip(tl, a.to ?? a.id);
    if (ci === 0) throw new EditError("first clip on the track has no previous clip", "no_previous", "use update_clip enter: 'fade' instead");
    const t = a.type ?? "crossfade";
    if (t === "none") delete c.transition;
    else {
      if (!TRANSITIONS.includes(t)) { const s = suggest(t, TRANSITIONS); throw new EditError(`unknown transition '${t}'`, "bad_transition", s ? `did you mean '${s}'?` : TRANSITIONS.join(", ")); }
      c.transition = { type: t, duration: parseTime(a.duration ?? 0.5) };
      if (!tr.magnetic) c.start = round6(Math.max(0, clipEnd(tr.clips[ci - 1]) - c.transition.duration));
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
  if (a.transcribe) {
    const s = a.transcribe;
    const path = tl.assets[s] ? p.abs(tl.assets[s].path) : absPath(s);
    a.words = AN.transcribe(path, a.language).words;
    delete a.transcribe; delete a.language;
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
  { words: "[{text,start,end}]", srt: "path", transcribe: "media path or asset id", language: "for transcribe", preset: "caption preset", track: "captions", at: "start (0)", style: "karaoke|word|reveal|line", "...": "text style overrides" },
  addCaptions);

op("add_voiceover", "Text-to-speech into media/ (voice: OS voice e.g. 'Linh' via say/SAPI/espeak, 'piper[:model.onnx]', or 'openai:<voice>' for an OpenAI-compatible server; see list_voices), placed on the voice track. captions=true (or a caption preset name) adds timed captions.",
  { text: "script", voice: "voice name, optionally provider-prefixed", rate: "words/min", track: "voice", at: "start (default end of voice track)", captions: "bool | preset name | caption fields" }, (p, tl, a) => {
    const out = join(p.root, "media", `vo-${Date.now()}.wav`);
    const res = AN.tts(a.text, out, a.voice, a.rate);
    const tid = a.track ?? "voice";
    const tr = ensureTrack(tl, tid, "audio");
    if (!tr.role) tr.role = "voice";
    const at = a.at !== undefined ? parseAt(tl, a.at) : trackEnd(tr);
    const clip = addClip(p, tl, { track: tid, src: out, at });
    const result: Dict = { clip, duration: res.duration, path: p.rel(out) };
    if (a.captions) {
      const sil = AN.silence(out, -40, 0.15);
      const speech = sil.speech.length ? sil.speech : [[0, res.duration]];
      const words = scriptToWords(a.text, speech);
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
  if (!beatCache.has(path)) beatCache.set(path, AN.beats(path).beats);
  return beatCache.get(path)!;
}

op("snap_to_beats", "Retime a magnetic track so every cut lands on a beat. beats: list | beats.json | audio path | asset id.",
  { track: "main", beats: "required", every: "cut every N beats (1)", offset: "first beat index (0)" }, (p, tl, a) => {
    const tr = findTrack(tl, a.track ?? "main");
    if (!tr.magnetic) throw new EditError("snap_to_beats works on magnetic tracks", "magnetic");
    const beats = beatList(p, tl, a.beats);
    const every = +(a.every ?? 1), off = +(a.offset ?? 0);
    const cuts = beats.filter((_, i) => i >= off && (i - off) % every === 0);
    if (cuts.length < 2) throw new EditError("not enough beats", "not_enough");
    resolve(tl);
    const starts = [0, ...cuts.slice(1, tr.clips.length)];
    const changed: Dict[] = [];
    tr.clips.forEach((c, i) => {
      if (i + 1 >= starts.length) return;
      const nxt = tr.clips[i + 1];
      const td = nxt?.transition ? normAnim(nxt.transition, 0.5)!.duration : 0;
      const dur = starts[i + 1] - starts[i] + td;
      if (dur > 0.05) { c.duration = round6(dur); changed.push({ id: c.id, duration: c.duration }); }
    });
    resolve(tl);
    return { retimed: changed, beats_used: changed.length, track_end: +trackEnd(tr).toFixed(3) };
  });

op("remove_silence", "Cut dead air out of a video/audio clip (Auto-Editor / CapCut 'remove pauses'): the clip becomes its speech segments.",
  { id: "clip id", noise_db: "-35", min_silence: "s (0.4)", padding: "s kept around speech (0.1)" }, (p, tl, a) => {
    const [tr, ci, c] = findClip(tl, a.id);
    if (c.type !== "video" && c.type !== "audio") throw new EditError("remove_silence needs a video or audio clip", "bad_type");
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
      if (j) { nc.id = newId(tl, PREFIX[c.type]); delete nc.transition; delete nc.enter; }
      nc.in = round6(s); nc.duration = round6((e - s) / speed); delete nc.keyframes;
      if (!tr.magnetic) { nc.start = round6(t); t += nc.duration as number; }
      tr.clips.splice(ci + j, 0, nc);
      ids.push(nc.id);
    });
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

op("replace_timeline", "Replace the whole timeline JSON (validated, undoable).", { timeline: "full timeline object" }, (p, tl, a) => {
  const n = a.timeline;
  if (!n || typeof n !== "object" || !n.tracks || !n.settings) throw new EditError("timeline must contain settings and tracks", "bad_timeline");
  n.assets ??= {}; n.markers ??= [];
  for (const k of Object.keys(tl)) delete (tl as Dict)[k];
  Object.assign(tl, structuredClone(n));
  return { tracks: tl.tracks.length, duration: totalDuration(resolve(tl)) };
});

// ---------------------------------------------------------------- pro editing ops (separate modules, registered here)
export interface OpHelpers {
  op: typeof op; PREFIX: typeof PREFIX; parseAt: typeof parseAt; place: typeof place; resolveRef: typeof resolveRef;
  ensureTrack: typeof ensureTrack; splitAt: typeof splitAt; trackEnd: typeof trackEnd; addClip: typeof addClip; importAsset: typeof importAsset;
}
const helpers: OpHelpers = { op, PREFIX, parseAt, place, resolveRef, ensureTrack, splitAt, trackEnd, addClip, importAsset };
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
