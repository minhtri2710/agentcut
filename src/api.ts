// High-level API shared by the CLI and the MCP server. Every function returns JSON-able objects.
import { basename, extname, isAbsolute, join, resolve as presolve } from "node:path";
import * as AN from "./analyze.ts";
import * as AFX from "./audiofx.ts";
import { loadCanvas } from "./canvas.ts";
import * as FB from "./feedback.ts";
import { fontsKnown, listFonts, needsProbe } from "./fonts.ts";
import { LOOKS } from "./color.ts";
import { needFfmpeg, probe as probeMedia } from "./media.ts";
import { scopes as frameScopes } from "./scopes.ts";
import * as M from "./model.ts";
import * as SUB from "./subtitles.ts";
import { applyOps, opsDoc as opsDocs, OPS } from "./ops.ts";
import { attachPrepared } from "./ops-vision.ts";
import * as CACHE from "./cache.ts";
import * as PREP from "./prepare.ts";
import { analyzeSubject, modelCached, visionEngine } from "./vision.ts";
import { CAPTION_PRESETS, TEMPLATES, TEXT_PRESETS } from "./presets.ts";
import { checkRevision, findProject, Project, refuseSource, summarize } from "./project.ts";
import { writeFile } from "./safe-write.ts";

const renderMod = async () => { await loadCanvas(); return import("./render.ts"); };
const TEXTY = /"(text|words|srt|preset|apply_template|add_captions|add_voiceover|font)"/;

export const openProject = (p?: string) => new Project(findProject(p));
/** The font checks of validate need Skia in two cases, and only then is it loaded (the edit path otherwise never draws): a text or captions clip holds a
 *  character the glyph probe draws (fonts.ts needsProbe), or the family list is not known without Skia (no cache that matches the font folders),
 *  so an unknown font name could not be reported. Loading rewrites the cache, so the next call needs no load. A timeline that cannot be walked loads it. */
const loadForText = async (tl: M.Timeline) => {
  try {
    const texts = [...M.allClips(tl.tracks)].map(M.fontSample).filter((s): s is string => s !== null);
    if (!texts.length || (fontsKnown() && !texts.some((s) => [...s].some(needsProbe)))) return;
  } catch { /* fall through: validate reports what is wrong, and a font check may still run */ }
  await loadCanvas();
};
/** timeline ready to draw: absolute paths + prepared background mattes (EditError not_prepared if prepare is needed) */
const drawable = (p: Project, tl: M.Timeline) => attachPrepared(p.absolutized(tl), p.root);
/** write an output file; files in previews/ keep that folder under its automatic size cap */
function writeOut(p: Project | null, out: string, data: string | Uint8Array) {
  if (p) refuseSource(p.root, p.load(), out);
  writeFile(out, data, p?.root);
  if (p) CACHE.capPreviews(p, out);
}

function brief(issues: M.Issue[], limit = 15) {
  const errs = issues.filter((i) => i.level === "error"), warns = issues.filter((i) => i.level === "warning");
  return { errors: errs.length, warnings: warns.length, issues: [...errs, ...warns].slice(0, limit) };
}

export function create(path: string, o: { preset?: string; width?: number; height?: number; fps?: number; name?: string; empty?: boolean } = {}) {
  const p = Project.create(path, o);
  const tl = p.load();
  return { project: p.root, settings: tl.settings, tracks: tl.tracks.map((t) => t.id),
    next: "apply_ops [{op:'add_clip', track:'main', src:'/abs/clip.mp4'}] or [{op:'apply_template', name:'promo', ...}], then contact_sheet, then render" };
}

export async function info(project?: string, fmt: "summary" | "json" | "both" = "summary") {
  const p = openProject(project);
  await loadForText(p.load());
  const tl = p.load(); // read after the wait, so what is reported is what is on disk now
  const out: M.Dict = { project: p.root, revision: tl.revision, duration: M.totalDuration(M.resolve(tl)), ...brief(p.validate(tl)) };
  if (fmt !== "json") out.summary = summarize(tl);
  if (fmt !== "summary") out.timeline = tl;
  return out;
}

/** A batch's identity for an issue of `tl` (resolved, as validated): tracks are named by id and a clip with a unique id by that id alone,
 *  so inserting, moving or compounding a track or clip does not make an old issue look new. Copies of a duplicated id (a saved invalid state)
 *  are told apart by their order among the copies (`<"x"#2>`), so a batch that adds another copy raises a new error; `bare` keys them by id
 *  alone, which `before` also holds so that the copy left after a repair keeps its old issues. */
const issueKeyer = (tl: M.Timeline) => {
  const count = new Map<string, number>(), nth = new Map<string, number>(), ord = new Map<M.Clip, number>();
  for (const c of M.allClips(tl.tracks)) if (c?.id) count.set(c.id, (count.get(c.id) ?? 0) + 1);
  for (const c of M.allClips(tl.tracks)) if (c?.id && count.get(c.id)! > 1) { nth.set(c.id, (nth.get(c.id) ?? 0) + 1); ord.set(c, nth.get(c.id)!); }
  return (i: M.Issue, bare = false) => issueKey(tl, bare ? new Map() : ord, i);
};
function issueKey(tl: M.Timeline, ord: Map<M.Clip, number>, i: M.Issue) {
  let key = i.path.match(/^[^.]*/)![0], rest = i.path.slice(key.length), level: M.Track[] | undefined = tl.tracks;
  for (let m: RegExpMatchArray | null; level && (m = rest.match(/^\.tracks\[(\d+)\]/)); ) {
    const tr: M.Track | undefined = level[+m[1]];
    rest = rest.slice(m[0].length); level = undefined;
    key += tr?.id ? `.tracks{${JSON.stringify(tr.id)}}` : m[0];
    const cm = rest.match(/^\.clips\[(\d+)\]/);
    if (!cm) break;
    const c: M.Clip | undefined = tr?.clips?.[+cm[1]];
    rest = rest.slice(cm[0].length);
    const tag = c && typeof c === "object" ? `<${c.id ?? "?"}>` : "";
    if (tag && rest.startsWith(tag)) rest = rest.slice(tag.length);
    key = c?.id ? `<${JSON.stringify(c.id)}${ord.has(c) ? `#${ord.get(c)}` : ""}>` : `${key}${cm[0]}`;
    level = c?.tracks;
  }
  return `${key}${rest}|${i.message.replace(/\.tracks\[\d+\]\.clips\[\d+\]</g, "<")}`;
}

/** revision: the revision the caller based the ops on (stale -> EditError "conflict"). Without it the batch is applied to
 *  the latest timeline: if another process saves in between, the ops are re-applied to the new state (each conflict means
 *  another writer committed, so this converges; bounded by a 10 s deadline like the project lock, which starts at the first conflict).
 *  An op that needs a transcription, speech, a silence scan or beats throws AN.NeedsAnalysis; the analysis runs here (async, stopped by `signal`),
 *  is kept for the call, and the batch is re-run from a fresh load: one round per analysis the batch asks for, plus the last. */
export async function apply(project: string | undefined, ops: M.Dict[] | M.Dict, o: { dryRun?: boolean; allowInvalid?: boolean; label?: string; revision?: number; signal?: AbortSignal } = {}) {
  const list = Array.isArray(ops) ? ops : ops && typeof ops === "object" ? ops.ops ?? [ops] : undefined;
  if (!Array.isArray(list)) throw new M.EditError("ops must be an array of op objects, or one op object", "bad_request", "each op is {op: name, ...args}");
  if (TEXTY.test(JSON.stringify(list))) await loadCanvas(); // glyph coverage checks for fonts/presets
  const p = openProject(project);
  try { return await applyRounds(p, list, o); } finally { AN.release(p); }
}

async function applyRounds(p: Project, list: M.Dict[], o: { dryRun?: boolean; allowInvalid?: boolean; label?: string; revision?: number; signal?: AbortSignal }) {
  let until = 0; // set by the first conflict: the analyses a batch waits for do not count against it
  for (;;) {
    const tl = p.load();
    await loadForText(tl);
    if (o.revision !== undefined) checkRevision(o.revision, tl.revision);
    const cur = M.resolve(structuredClone(tl)); // validate resolves a copy, so its paths index the resolved order
    const curKey = issueKeyer(cur), before = new Set(p.validate(cur).filter((i) => i.level === "error").flatMap((i) => [curKey(i), curKey(i, true)]));
    let saved = false; // files the ops wrote into media/ stay only when the batch is saved
    try {
      const [next, results] = applyOps(p, tl, list);
      const issues = p.validate(next);
      const nextKey = issueKeyer(next), added = issues.filter((i) => i.level === "error" && !before.has(nextKey(i)));
      if (added.length && !o.allowInvalid)
        throw new M.EditError(`batch rejected: it would add ${added.length} validation error(s); nothing was changed`, "validation_failed",
          added[0].hint ?? "fix the listed fields and resend the whole batch", undefined, { issues: added.slice(0, 15) });
      if (!o.dryRun && list.length) { // an empty batch applies nothing: no revision, no undo entry, redo stays
        try { p.save(next, o.label ?? [...new Set(list.map((x) => x.op))].join(", ").slice(0, 120)); saved = true; }
        catch (e) { if (e instanceof M.EditError && e.code === "conflict" && o.revision === undefined && Date.now() < (until ||= Date.now() + 10_000)) continue; throw e; }
      }
      const prep = results.some((r) => r.pending) ? { prepare_needed: true, next: "prepare (vision requests recorded; preview/render need them)" } : {};
      return { ok: true, project: p.root, dry_run: !!o.dryRun, revision: next.revision, results, duration: M.totalDuration(next), ...brief(issues), ...prep };
    } catch (e) {
      if (!(e instanceof AN.NeedsAnalysis)) throw e;
      await AN.compute(p, e.req, o.signal);
    } finally { p.discardStaged(saved); }
  }
}

export async function validate(project?: string) {
  const p = openProject(project);
  await loadForText(p.load());
  const issues = p.validate();
  return { valid: !issues.some((i) => i.level === "error"), ...brief(issues, 100) };
}

const stillFmt = (out: string) => (/\.png$/i.test(out) ? "png" : "jpeg");
const outPath = (p: Project, out: string | undefined, dflt: string) => (out ? (isAbsolute(out) ? out : presolve(out)) : join(p.root, dflt));

/** Output scale: a finite number in (0, 4]; `undefined` takes `dflt`. Frames, sheets, scopes and renders share it. */
const scaleOf = (v: number | undefined, dflt: number) => {
  if (v === undefined) return dflt;
  if (!(typeof v === "number" && v > 0 && v <= MAX_SCALE)) throw new M.EditError(`scale must be a number above 0 and at most ${MAX_SCALE}, got ${JSON.stringify(v)}`, "bad_value", "0.5 is half size, 1 is the timeline size");
  return v;
};
const MAX_SCALE = 4, MAX_SHEET_TILES = 64; // the sheet already stopped `every` at 64 tiles

/** A timeline with no duration has no frame to show. */
const emptyTimeline = (what: string) => new M.EditError(`the timeline is empty: ${what}`, "empty", "add clips first");

/** A time outside a timeline that has a duration, as the error every frame request gives: the hint names the last frame that exists. */
const outsideTimeline = (tl: M.Timeline, T: number, message: string, name: string) => new M.EditError(message, "bad_value",
  `a frame is one point in time: use 0 <= ${name} < ${+T.toFixed(3)} (the duration); the last frame starts at ${+Math.max(0, T - 1 / tl.settings.fps).toFixed(3)}`);

/** The time of a single frame (a preview, scopes or a still): 0 <= t < duration. `name` is the argument the caller gave it as. */
function frameTime(tl: M.Timeline, t: number | string, name: string) {
  const tt = M.parseTime(t), T = M.totalDuration(M.resolve(M.clone(tl)));
  if (!(T > 0)) throw emptyTimeline("there is no frame to show");
  if (!(tt >= 0 && tt < T)) throw outsideTimeline(tl, T, `${name} ${tt}s is outside the timeline`, name);
  return tt;
}

/** One rendered frame as encoded bytes (no file written). */
export async function frameImage(project: string | undefined, t: number | string, o: { scale?: number; guides?: boolean; format?: "png" | "jpeg" } = {}) {
  const p = openProject(project);
  const tl = p.load();
  p.requireValid(tl);
  const tt = frameTime(tl, t, "t");
  const { renderFrame } = await renderMod();
  return { t: tt, revision: tl.revision, data: await renderFrame(drawable(p, tl), p.root, tt, scaleOf(o.scale, 0.5), !!o.guides, o.format ?? "jpeg") };
}

export async function frame(project: string | undefined, t: number | string, o: { out?: string; scale?: number; guides?: boolean } = {}) {
  const tt = M.parseTime(t);
  const out = outPath(openProject(project), o.out, `previews/frame-${tt.toFixed(2).padStart(7, "0")}s.jpg`);
  const { data: png } = await frameImage(project, tt, { scale: o.scale, guides: o.guides, format: stillFmt(out) });
  writeOut(openProject(project), out, png);
  return { image: out, t: tt, bytes: png.length };
}

/** Objective exposure/colour check of the composited frame at t: waveform + vectorscope + histogram image and luma/chroma stats. */
export async function scopes(project: string | undefined, t: number | string, o: { out?: string; scale?: number; signal?: AbortSignal } = {}) {
  const p = openProject(project);
  const tl = p.load();
  p.requireValid(tl);
  const tt = frameTime(tl, t, "t");
  const { renderFrame } = await renderMod();
  const out = outPath(p, o.out, `previews/scopes-${tt.toFixed(2).padStart(7, "0")}s.jpg`);
  refuseSource(p.root, tl, out);
  const png = await renderFrame(drawable(p, tl), p.root, tt, scaleOf(o.scale, 0.5), false, "png");
  const res = { t: tt, ...(await frameScopes(png, out, p.root, o.signal)) };
  CACHE.capPreviews(p, out);
  return res;
}

export async function sheet(project: string | undefined, o: { times?: (number | string)[] | string; every?: number; count?: number; cols?: number; out?: string; tileWidth?: number; guides?: boolean } = {}) {
  const p = openProject(project);
  const tl = p.load();
  p.requireValid(tl);
  const T = M.totalDuration(M.resolve(tl));
  if (!(T > 0)) throw emptyTimeline("a sheet has no frames to show");
  let ts: number[];
  if (o.every !== undefined && !(o.every > 0)) throw new M.EditError(`every must be a number above 0, got ${JSON.stringify(o.every)}`, "bad_value");
  if (o.count !== undefined && !(Number.isInteger(o.count) && o.count >= 1 && o.count <= MAX_SHEET_TILES)) throw new M.EditError(`count must be a whole number from 1 to ${MAX_SHEET_TILES}, got ${JSON.stringify(o.count)}`, "bad_value");
  if (o.times) {
    const list = typeof o.times === "string" ? o.times.split(",") : o.times;
    if (list.length > MAX_SHEET_TILES) throw new M.EditError(`times lists ${list.length} frames; a sheet holds at most ${MAX_SHEET_TILES}`, "bad_value", "split it into several sheets");
    ts = list.map((x) => M.parseTime(x));
    const bad = ts.filter((t) => !(t >= 0 && t < T));
    if (bad.length) throw outsideTimeline(tl, T, `times ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} outside the timeline (the duration is ${+T.toFixed(3)}s)`, "each time");
  } else if (o.every) { ts = []; for (let t = 0; t < T && ts.length < 64; t += o.every) ts.push(+t.toFixed(3)); }
  else { const n = Math.max(1, o.count ?? 12); ts = Array.from({ length: n }, (_, i) => +((T * (i + 0.5)) / n).toFixed(3)); }
  const { contactSheet } = await renderMod();
  const out = outPath(p, o.out, `previews/sheet-${Date.now()}.jpg`);
  const png = await contactSheet(drawable(p, tl), p.root, ts, o.cols ?? 4, o.tileWidth ?? 320, !!o.guides, stillFmt(out));
  writeOut(p, out, png);
  return { image: out, times: ts, duration: T };
}

const inspectMod = async () => { await loadCanvas(); return import("./inspect.ts"); };

/** Audio as an image (waveform per track + rendered mix, ruler, clip boundaries, markers, optional spectrogram) + findings. */
export async function audioCheck(project: string | undefined, o: { source?: string; spectrogram?: boolean; start?: number | string; end?: number | string; width?: number; minSilence?: number; out?: string; signal?: AbortSignal } = {}) {
  const p = o.source ? null : openProject(project);
  const tl = p ? p.load() : null;
  if (p && tl) p.requireValid(tl);
  await loadCanvas();
  const { inspectAudio } = await import("./inspect-audio.ts");
  const res = await inspectAudio(p && tl ? p.absolutized(tl) : null, {
    source: o.source ? presolve(o.source) : undefined, spectrogram: o.spectrogram, width: o.width, minSilence: o.minSilence, signal: o.signal,
    start: o.start !== undefined ? M.parseTime(o.start) : undefined, end: o.end !== undefined ? M.parseTime(o.end) : undefined });
  const out = o.out ? (isAbsolute(o.out) ? o.out : presolve(o.out)) : p ? join(p.root, `previews/audio-${Date.now()}.png`) : presolve(`${o.source}.audio.png`);
  writeOut(p, out, res.image);
  const { image, ...rest } = res;
  return { image: out, ...rest };
}

/** Dense frame strips: one row per transition (default) or per given window, so motion can be judged from stills. */
export async function motion(project: string | undefined, o: { start?: number | string; end?: number | string; frames?: number; pad?: number; out?: string; tileWidth?: number } = {}) {
  const p = openProject(project);
  const tl = p.load();
  p.requireValid(tl);
  const { motionStrips, transitionWindows } = await inspectMod();
  const at = drawable(p, M.resolve(tl));
  const windows = o.start !== undefined || o.end !== undefined
    ? [{ label: "range", start: M.parseTime(o.start ?? 0), end: o.end !== undefined ? M.parseTime(o.end) : M.totalDuration(at) }]
    : transitionWindows(at, o.pad ?? 0.15);
  const r = await motionStrips(at, p.root, windows, { frames: o.frames, tileWidth: o.tileWidth });
  const base = o.out ? (isAbsolute(o.out) ? o.out : presolve(o.out)) : join(p.root, `previews/motion-${Date.now()}.jpg`);
  const images = r.images.map((buf, i) => {
    const f = i ? base.replace(/(\.[^.]+)?$/, `-${i + 1}$1`) : base;
    writeOut(p, f, buf);
    return f;
  });
  return { images, strips: r.strips };
}

/** Editorial lint with times: unsafe/short text, shot lengths, off-beat cuts, black frames + validation warnings. */
export async function review(project: string | undefined, o: { beats?: number[] | string; minShot?: number; maxShot?: number; cps?: number; black?: boolean; signal?: AbortSignal } = {}) {
  const p = openProject(project);
  const tl = p.load();
  await loadForText(tl);
  const issues = p.validate(tl);
  p.requireValid(tl);
  const { review: rv } = await inspectMod();
  const beats = typeof o.beats === "string" && o.beats !== "music" ? o.beats.split(",").map((x) => M.parseTime(x)) : o.beats as number[] | "music" | undefined;
  return rv(drawable(p, M.resolve(tl)), p.root, { ...o, beats, issues });
}

const INTERCHANGE: Record<string, "fcpxml" | "otio"> = { ".fcpxml": "fcpxml", ".otio": "otio" };

/** Hand the edit to a human editor: FCPXML (Final Cut Pro) or OpenTimelineIO (DaVinci Resolve, Premiere, Avid...). */
export async function exportTimeline(project: string | undefined, o: { format?: string; out?: string } = {}) {
  const p = openProject(project);
  const tl = p.load();
  p.requireValid(tl);
  const ext = o.out ? o.out.slice(o.out.lastIndexOf(".")).toLowerCase() : "";
  const format = (o.format ?? INTERCHANGE[ext] ?? "fcpxml").toLowerCase();
  if (format !== "fcpxml" && format !== "otio") throw new M.EditError(`unknown interchange format '${format}'`, "bad_format", "use fcpxml (Final Cut Pro) or otio (DaVinci Resolve / Premiere / Avid)");
  const out = o.out ? (isAbsolute(o.out) ? o.out : presolve(o.out)) : p.defaultOutput(`.${format}`);
  try {
    const { exportTimeline: ex } = await import("./export.ts");
    return ex(p.absolutized(M.resolve(tl)), format, out, p.root);
  } finally { if (!o.out) p.releaseOutput(out); }
}

/** Write the captions clips (timeline times, the pages the renderer shows) as .srt or .vtt. ids limits it to some clips. */
export function exportCaptions(project: string | undefined, o: { out?: string; format?: string; ids?: string[] } = {}) {
  const p = openProject(project);
  const tl = p.load();
  p.requireValid(tl);
  const ext = o.out ? extname(o.out).toLowerCase() : "";
  // an explicit format is the caller's word and names the content whatever the file is called; the extension alone must be one we know
  const format = (o.format ?? (o.out ? SUB.SUB_FORMATS[ext] : "srt") ?? "").toLowerCase();
  if (format !== "srt" && format !== "vtt") throw new M.EditError(`unknown subtitle format '${o.format ?? (ext || o.out)}'`, "bad_format", "use .srt or .vtt, or pass format srt|vtt with the output");
  const cues = SUB.captionCues(p.absolutized(M.resolve(tl)), o.ids);
  if (!cues.length) throw new M.EditError(o.ids ? `no caption cues in ${o.ids.join(", ")}` : "the timeline has no captions clips", "empty", "add captions first: add_captions words=[...] | srt=... | transcribe=...");
  const out = o.out ? presolve(o.out) : p.defaultOutput(`.${format}`);
  try {
    refuseSource(p.root, tl, out);
    writeFile(out, SUB.formatCues(cues, format), p.root);
  } finally { if (!o.out) p.releaseOutput(out); }
  return { output: out, format, cues: cues.length, duration: +cues[cues.length - 1].end.toFixed(3), clips: [...new Set(cues.map((q) => q.clip))] };
}

/** .png / .webp: one frame at `start`; alpha follows encode.ts planOutput (on with a transparent background, off composites on black). webp is lossless at quality=high. */
async function renderStill(project: string | undefined, out: string, o: { start?: number | string; end?: number | string; scale?: number; quality?: string; draft?: boolean; codec?: string; alpha?: boolean; subtitles?: boolean; signal?: AbortSignal }) {
  o.signal?.throwIfAborted();
  const p = openProject(project);
  const tl = p.load();
  p.requireValid(tl);
  const ext = extname(out).toLowerCase();
  if (o.codec && o.codec.toLowerCase() !== "auto") throw new M.EditError(`codec '${o.codec}' doesn't apply to ${ext}`, "bad_codec", "omit codec for a still image, or render a video");
  if (o.end !== undefined) throw new M.EditError(`end doesn't apply to ${ext}: a still renders one frame at start`, "bad_value", "omit end, or render a video");
  if (o.subtitles) throw new M.EditError(`subtitles don't apply to ${ext}`, "bad_value", "omit subtitles, or render .mp4/.mov/.mkv/.webm");
  const t = frameTime(tl, o.start ?? 0, "start");
  let scale = scaleOf(o.scale, 1), quality = o.quality ?? "standard";
  if (o.draft) { scale = Math.min(scale, 0.5); quality = "draft"; }
  const transparent = M.parseColor(tl.settings.background ?? "#000000")[3] === 0;
  const alpha = o.alpha ?? transparent;
  const at = drawable(p, tl);
  const { stillFrame } = await renderMod();
  const { ALPHA_ON_OPAQUE } = await import("./encode.ts");
  const flat = transparent && !alpha ? { ...at, settings: { ...at.settings, background: "#000000" } } : at; // alpha off: composite on black, as video does
  const img = await stillFrame(flat, p.root, t, scale, ext === ".png" ? "png" : quality === "high" ? "webp_lossless" : "webp");
  o.signal?.throwIfAborted();
  writeOut(p, out, img.data);
  return { output: out, t, width: img.width, height: img.height, alpha, bytes: img.data.length, ...(alpha && !transparent ? { warnings: [ALPHA_ON_OPAQUE] } : {}) };
}

export async function render(project: string | undefined, o: {
  out?: string; start?: number | string; end?: number | string; scale?: number; quality?: string; draft?: boolean;
  sheet?: boolean; workers?: number; fast?: boolean; codec?: string; alpha?: boolean; subtitles?: boolean; progress?: (d: number, n: number) => void;
  /** abort the render (MCP shutdown): children are stopped, temp files removed, the call rejects with signal.reason */
  signal?: AbortSignal;
} = {}) {
  if (o.out && INTERCHANGE[o.out.slice(o.out.lastIndexOf(".")).toLowerCase()]) return exportTimeline(project, { out: o.out });
  if (o.out && SUB.SUB_FORMATS[extname(o.out).toLowerCase()]) return exportCaptions(project, { out: o.out });
  if (o.out && /^\.(png|webp)$/.test(extname(o.out).toLowerCase())) return renderStill(project, isAbsolute(o.out) ? o.out : presolve(o.out), o);
  const p = openProject(project);
  CACHE.sweepStale(p);
  const tl = p.load();
  p.requireValid(tl);
  let scale = scaleOf(o.scale, 1), quality = o.quality ?? "standard";
  if (o.draft) { scale = Math.min(scale, 0.5); quality = "draft"; }
  const out = o.out ? (isAbsolute(o.out) ? o.out : presolve(o.out)) : p.defaultOutput(".mp4", o.draft ? "draft" : "");
  try {
    const start = M.parseTime(o.start ?? 0);
    let cues: SUB.Cue[] = [];
    if (o.subtitles) { // checked before rendering: wrong container or no captions fails fast
      SUB.embedCodec(out);
      cues = SUB.captionCues(p.absolutized(M.resolve(M.clone(tl))));
      if (!cues.length) throw new M.EditError("subtitles=true but the timeline has no captions clips", "empty", "add captions first, or drop subtitles");
    }
    const { contactSheet } = await renderMod();
    const { renderVideo, AUDIO_FORMATS } = await import("./encode.ts");
    // audio-only outputs mix sound only: no mattes or reframe/track keyframes needed, so no not_prepared gate
    const res: M.Dict = await renderVideo(AUDIO_FORMATS[extname(out).toLowerCase()] ? p.absolutized(tl) : drawable(p, tl), p.root, out, {
      start, end: o.end !== undefined ? M.parseTime(o.end) : undefined, scale, quality, workers: o.workers,
      hwEncode: o.fast ?? !!o.draft, fontDirs: [join(p.root, "fonts")], progress: o.progress, codec: o.codec as any, alpha: o.alpha, signal: o.signal,
    });
    // The output is committed. A cancel during the subtitle mux rejects (the output stays, without its subtitle stream); after it, the contact sheet
    // and the loudness pass are skipped once the signal is aborted, and the result says so, so the render is done.
    if (res.audio_only) return res;
    if (o.subtitles) {
      const [t0, t1] = res.range as [number, number];
      const inRange = SUB.cuesInRange(cues, t0, t1);
      try { await SUB.embedSubtitles(out, inRange, p.root, o.signal); }
      catch (e) { throw e instanceof M.EditError && e.code === "aborted" ? new M.EditError(e.message, "aborted", `the output was written without its subtitle stream: ${out}`) : e; }
      res.subtitles = { cues: inRange.length, codec: SUB.embedCodec(out) };
    }
    FB.recordEvent({ type: "render", speed_x: res.speed_x, frames: res.frames, width: res.width, height: res.height, workers: res.workers,
      encoder: res.encoder, seconds: res.render_seconds, layers: tl.tracks.reduce((n, t) => n + t.clips.length, 0),
      effects: tl.tracks.some((t) => t.clips.some((c) => c.effects?.length || c.mask || c.fit === "blur")) });
    if (o.sheet !== false && !out.endsWith(".gif")) {
      const skipped = "skipped: cancelled after the output was written";
      const loud = res.has_audio && !o.signal?.aborted ? AN.loudness(out, o.signal) : undefined;
      loud?.catch(() => {}); // an abort rejects it while the contact sheet is still being drawn; the await below reports it
      try {
        o.signal?.throwIfAborted();
        const ts = Array.from({ length: 8 }, (_, i) => +(start + (res.duration * (i + 0.5)) / 8).toFixed(3));
        const png = await contactSheet(drawable(p, tl), p.root, ts, 4, 300);
        o.signal?.throwIfAborted();
        const sp = join(p.root, "previews", `render-${basename(out, extname(out))}-${Date.now()}.sheet.jpg`);
        writeFile(sp, png, p.root); // capped below together with the output, so neither evicts the other
        res.contact_sheet = sp;
      } catch (e: any) { res.contact_sheet_error = o.signal?.aborted ? skipped : e.message; }
      if (loud) {
        try { res.loudness = await loud; } catch (e) { if (!o.signal?.aborted) throw e; res.loudness_error = skipped; }
      } else if (res.has_audio) res.loudness_error = skipped;
    }
    CACHE.capPreviews(p, out, ...(res.contact_sheet ? [res.contact_sheet as string] : [])); // UI play drafts are rendered into previews/
    return res;
  } finally { if (!o.out) p.releaseOutput(out); }
}

export const undo = (project?: string, steps = 1, revision?: number) => { const p = openProject(project); const r = p.undo(steps, revision); return { undone: r.labels, requested: r.requested, done: r.done, revision: r.revision, duration: M.totalDuration(M.resolve(p.load())) }; };
export const redo = (project?: string, steps = 1, revision?: number) => { const p = openProject(project); const r = p.redo(steps, revision); return { redone: r.labels, requested: r.requested, done: r.done, revision: r.revision, duration: M.totalDuration(M.resolve(p.load())) }; };
export const history = (project?: string) => openProject(project).history();
export const probe = (path: string) => probeMedia(presolve(path));
export const fonts = async (q = "", limit = 60) => { await loadCanvas(); return { fonts: listFonts(q, limit) }; };
export const voices = (lang?: string) => { const r = AN.ttsVoices(); return { ...r, voices: r.voices.filter((v) => !lang || v.lang.toLowerCase().startsWith(lang.toLowerCase())) }; };

export function capabilities() {
  const pick = (t: Record<string, { doc: string }>) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.doc]));
  return {
    clip_types: M.CLIP_TYPES, enter_exit_animations: M.ENTER_EXIT, transitions: M.TRANSITIONS, motions: M.MOTIONS, easings: M.EASINGS,
    effects: M.EFFECTS, filters: M.FILTERS, looks: Object.keys(LOOKS), masks: M.MASKS, shapes: M.SHAPES, blend_modes: M.BLENDS,
    fit_modes: M.FITS, positions: M.POSITIONS, caption_styles: M.CAPTION_STYLES, animatable: M.ANIMATABLE,
    text_presets: pick(TEXT_PRESETS), caption_presets: pick(CAPTION_PRESETS),
    templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, { doc: v.doc, args: v.args }])),
    canvas_presets: Object.fromEntries(Object.entries(M.PRESETS).map(([k, [w, h]]) => [k, `${w}x${h}`])),
    output_formats: [".mp4 (H.264; codec=hevc for H.265)", ".mov (ProRes 422; codec=prores_4444 keeps alpha)", ".webm (VP9, alpha ok)", ".mkv", ".gif",
      ".wav/.mp3/.m4a/.aac/.flac (audio only)",
      ".png / .webp (one still frame at start; alpha kept with a transparent background; webp lossless at quality=high; no end, sheet or loudness)", ".fcpxml (Final Cut Pro project)", ".otio (OpenTimelineIO: Resolve, Premiere, Avid)"],
    render_codecs: ["auto", "h264", "hevc", "prores", "prores_4444", "vp9"],
    subtitle_formats: [".srt", ".vtt (export_captions)", "render subtitles=true: soft track in .mp4/.mov (mov_text), .mkv (srt), .webm (webvtt)"],
    audio_fx: { ...AFX.AUDIO_FX_DOC, eq_presets: AFX.EQ_PRESETS, eq_bands: Object.fromEntries(Object.entries(AFX.EQ_BANDS).map(([k, v]) => [k, v.doc])), compressor_presets: AFX.COMPRESSORS },
    matte_models: M.MATTE_MODELS.map((name) => ({ name, approx_mb: M.MATTE_MB[name], cached: modelCached(name) })),
    engines: { transcribe: AN.transcribeEngine(), tts: { ...AN.ttsProviders(), voices: "the installed voices list" }, vision: visionEngine() },
    ops: Object.keys(OPS),
  };
}
export const schema = () => M.schemaDoc();
export const opsDoc = () => opsDocs();
/** start/end: the stretch of the media to transcribe (seconds or mm:ss), like a render range: start defaults to 0, end to the media's end. */
async function transcribe(p: string, language?: string, model?: string, start?: number | string, end?: number | string, signal?: AbortSignal) {
  const f = presolve(p);
  if (start === undefined && end === undefined) return AN.transcribe(f, language, model, undefined, signal);
  return AN.transcribe(f, language, model, [start === undefined ? 0 : M.parseTime(start, "start"), end === undefined ? Number(probeMedia(f).duration) : M.parseTime(end, "end")], signal);
}
/** Speech into a file. The output is judged as a render's is: it may not replace the project's own files. A project is used when named or found, not required. */
async function tts(text: string | undefined, out: string | undefined, voice?: string, rate?: number, project?: string, signal?: AbortSignal) {
  if (!out) throw new M.EditError("tts needs an output path", "missing_input", "-o out.wav (CLI) / output=out.wav (MCP)");
  let p: Project | null = null;
  try { p = openProject(project); } catch (e: any) { if (e.code !== "no_project" || project || process.env.AGENTCUT_PROJECT) throw e; }
  const path = presolve(out);
  if (p) refuseSource(p.root, p.load(), path);
  return AN.tts(text, path, voice, rate, p?.root, signal);
}
export const analyze = { beats: (p: string, signal?: AbortSignal) => AN.beats(presolve(p), signal), scenes: (p: string, th?: number, signal?: AbortSignal) => AN.scenes(presolve(p), th, signal), silence: (p: string, n?: number, m?: number, signal?: AbortSignal) => AN.silence(presolve(p), n, m, signal), loudness: async (p: string, signal?: AbortSignal) => { needFfmpeg(); return AN.loudness(presolve(p), signal); }, transcribe, tts,
  subject: async (p: string, fps?: number, allowDownload?: boolean, project?: string) => { const f = presolve(p), a = probeMedia(f); if (a.kind !== "video" && a.kind !== "image") throw new M.EditError(`${p} is not a video or image`, "bad_media"); return analyzeSubject(f, { still: a.kind === "image", fps, duration: a.duration, srcW: a.width, srcH: a.height, root: project === undefined ? undefined : openProject(project).root }, allowDownload); } };

export const feedback = {
  add: (a: M.Dict) => FB.addNote(a as any),
  list: (status = "open", kind?: string) => ({ notes: FB.listNotes({ status, kind }) }),
  summary: (sinceDays?: number, limit?: number) => FB.summary({ sinceDays, limit }),
  report: (out?: string, sinceDays?: number) => {
    const md = FB.summaryMarkdown(FB.summary({ sinceDays }));
    if (out) { writeFile(presolve(out), md); return { report: presolve(out) }; }
    return { markdown: md };
  },
  resolve: (id: string, status?: "resolved" | "wontfix" | "open", note?: string) => FB.resolveNote(id, status, note),
};

/** Compute the derived assets the timeline needs (mattes, vision analyses) and apply the pending vision requests. Slow:
 *  MCP runs it as a background job (render_status); preview/render fail with not_prepared until it ran. */
export const prepare = (project?: string, o: { progress?: (done: number, total: number) => void; signal?: AbortSignal; allowDownload?: boolean } = {}) => {
  const p = openProject(project);
  CACHE.sweepStale(p);
  return PREP.prepare(p, o);
};
export const prepareStatus = (project?: string) => PREP.prepareStatus(openProject(project));
export const cache = {
  info: (project?: string) => CACHE.cacheInfo(openProject(project)),
  prune: (project?: string, o: { maxMb?: number; olderThan?: string | number } = {}) => CACHE.prune(openProject(project), o),
};
