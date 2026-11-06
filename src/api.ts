// High-level API shared by the CLI and the MCP server. Every function returns JSON-able objects.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve as presolve } from "node:path";
import * as AN from "./analyze.ts";
import * as AFX from "./audiofx.ts";
import { loadCanvas } from "./canvas.ts";
import * as FB from "./feedback.ts";
import { listFonts } from "./fonts.ts";
import { LOOKS } from "./color.ts";
import { probe as probeMedia } from "./media.ts";
import { scopes as frameScopes } from "./scopes.ts";
import * as M from "./model.ts";
import * as SUB from "./subtitles.ts";
import { applyOps, opsDoc as opsDocs, OPS } from "./ops.ts";
import { attachPrepared } from "./ops-vision.ts";
import * as CACHE from "./cache.ts";
import * as PREP from "./prepare.ts";
import { analyzeSubject } from "./vision.ts";
import { CAPTION_PRESETS, TEMPLATES, TEXT_PRESETS } from "./presets.ts";
import { checkRevision, findProject, Project, summarize } from "./project.ts";

const renderMod = async () => { await loadCanvas(); return import("./render.ts"); };
const TEXTY = /"(text|words|srt|preset|apply_template|add_captions|add_voiceover|font)"/;

export const openProject = (p?: string) => new Project(findProject(p));
/** timeline ready to draw: absolute paths + prepared background mattes (EditError not_prepared if prepare is needed) */
const drawable = (p: Project, tl: M.Timeline) => attachPrepared(p.absolutized(tl), p.root);
/** write an output file; files in previews/ keep that folder under its automatic size cap */
function writeOut(p: Project | null, out: string, data: string | Uint8Array) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, data);
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

export function info(project?: string, fmt: "summary" | "json" | "both" = "summary") {
  const p = openProject(project);
  const tl = p.load();
  const out: M.Dict = { project: p.root, revision: tl.revision, duration: M.totalDuration(M.resolve(tl)), ...brief(p.validate(tl)) };
  if (fmt !== "json") out.summary = summarize(tl);
  if (fmt !== "summary") out.timeline = tl;
  return out;
}

/** revision: the revision the caller based the ops on (stale -> EditError "conflict"). Without it the batch is applied to
 *  the latest timeline: if another process saves in between, the ops are re-applied to the new state (each conflict means
 *  another writer committed, so this converges; bounded by a 10 s deadline like the project lock). */
export async function apply(project: string | undefined, ops: M.Dict[] | M.Dict, o: { dryRun?: boolean; allowInvalid?: boolean; label?: string; revision?: number } = {}) {
  if (TEXTY.test(JSON.stringify(ops))) await loadCanvas(); // glyph coverage checks for fonts/presets
  const p = openProject(project);
  const list: M.Dict[] = Array.isArray(ops) ? ops : ops.ops ?? [ops];
  const key = (i: M.Issue) => `${i.path.split("<")[0]}|${i.message}`;
  for (const until = Date.now() + 10_000; ;) {
    const tl = p.load();
    if (o.revision !== undefined) checkRevision(o.revision, tl.revision);
    const before = new Set(p.validate(tl).filter((i) => i.level === "error").map(key));
    const [next, results] = applyOps(p, tl, list);
    const issues = p.validate(next);
    const added = issues.filter((i) => i.level === "error" && !before.has(key(i)));
    if (added.length && !o.allowInvalid)
      throw new M.EditError(`batch rejected: it would add ${added.length} validation error(s); nothing was changed`, "validation_failed",
        added[0].hint ?? "fix the listed fields and resend the whole batch", undefined, { issues: added.slice(0, 15) });
    if (!o.dryRun) {
      try { p.save(next, o.label ?? [...new Set(list.map((x) => x.op))].join(", ").slice(0, 120)); }
      catch (e) { if (e instanceof M.EditError && e.code === "conflict" && o.revision === undefined && Date.now() < until) continue; throw e; }
    }
    const prep = results.some((r) => r.pending) ? { prepare_needed: true, next: "prepare (vision requests recorded; preview/render need them)" } : {};
    return { ok: true, dry_run: !!o.dryRun, revision: next.revision, results, duration: M.totalDuration(next), ...brief(issues), ...prep };
  }
}

export function validate(project?: string) {
  const p = openProject(project);
  const issues = p.validate();
  return { valid: !issues.some((i) => i.level === "error"), ...brief(issues, 100) };
}

function requireValid(p: Project, tl: M.Timeline) {
  const errs = p.validate(tl).filter((i) => i.level === "error");
  if (errs.length) throw new M.EditError(`timeline has ${errs.length} error(s); first: ${errs[0].path}: ${errs[0].message}`, "invalid_timeline", errs[0].hint ?? "run validate for the full list");
}

const stillFmt = (out: string) => (/\.png$/i.test(out) ? "png" : "jpeg");
const outPath = (p: Project, out: string | undefined, dflt: string) => (out ? (isAbsolute(out) ? out : presolve(out)) : join(p.root, dflt));

/** One rendered frame as encoded bytes (no file written). */
export async function frameImage(project: string | undefined, t: number | string, o: { scale?: number; guides?: boolean; format?: "png" | "jpeg" } = {}) {
  const p = openProject(project);
  const tl = p.load();
  requireValid(p, tl);
  const tt = M.parseTime(t);
  const { renderFrame } = await renderMod();
  return { t: tt, revision: tl.revision, data: await renderFrame(drawable(p, tl), p.root, tt, o.scale ?? 0.5, !!o.guides, o.format ?? "jpeg") };
}

export async function frame(project: string | undefined, t: number | string, o: { out?: string; scale?: number; guides?: boolean } = {}) {
  const tt = M.parseTime(t);
  const out = outPath(openProject(project), o.out, `previews/frame-${tt.toFixed(2).padStart(7, "0")}s.jpg`);
  const { data: png } = await frameImage(project, tt, { scale: o.scale, guides: o.guides, format: stillFmt(out) });
  writeOut(openProject(project), out, png);
  return { image: out, t: tt, bytes: png.length };
}

/** Objective exposure/colour check of the composited frame at t: waveform + vectorscope + histogram image and luma/chroma stats. */
export async function scopes(project: string | undefined, t: number | string, o: { out?: string; scale?: number } = {}) {
  const p = openProject(project);
  const tl = p.load();
  requireValid(p, tl);
  const tt = M.parseTime(t);
  const { renderFrame } = await renderMod();
  const out = outPath(p, o.out, `previews/scopes-${tt.toFixed(2).padStart(7, "0")}s.jpg`);
  const png = await renderFrame(drawable(p, tl), p.root, tt, o.scale ?? 0.5, false, "png");
  mkdirSync(dirname(out), { recursive: true });
  const res = { t: tt, ...frameScopes(png, out) };
  CACHE.capPreviews(p, out);
  return res;
}

export async function sheet(project: string | undefined, o: { times?: (number | string)[] | string; every?: number; count?: number; cols?: number; out?: string; tileWidth?: number; guides?: boolean } = {}) {
  const p = openProject(project);
  const tl = p.load();
  requireValid(p, tl);
  const T = M.totalDuration(M.resolve(tl));
  let ts: number[];
  if (o.times) ts = (typeof o.times === "string" ? o.times.split(",") : o.times).map((x) => M.parseTime(x));
  else if (o.every) { ts = []; for (let t = 0; t < T && ts.length < 64; t += o.every) ts.push(+t.toFixed(3)); }
  else { const n = Math.max(1, o.count ?? 12); ts = Array.from({ length: n }, (_, i) => +((T * (i + 0.5)) / n).toFixed(3)); }
  const { contactSheet } = await renderMod();
  const out = outPath(p, o.out, `previews/sheet-${Date.now()}.jpg`);
  const png = await contactSheet(drawable(p, tl), p.root, ts, o.cols ?? 4, o.tileWidth ?? 320, !!o.guides, stillFmt(out));
  writeOut(p, out, png);
  return { image: out, times: ts, duration: T };
}

const inspectMod = async () => { await loadCanvas(); return import("./inspect.ts"); };

/** Audio as an image (waveform per track + rendered mix, ruler, clip boundaries, markers, optional spectrogram) + findings. */
export async function audioCheck(project: string | undefined, o: { source?: string; spectrogram?: boolean; start?: number | string; end?: number | string; width?: number; minSilence?: number; out?: string } = {}) {
  const p = o.source ? null : openProject(project);
  const tl = p ? p.load() : null;
  if (p && tl) requireValid(p, tl);
  await loadCanvas();
  const { inspectAudio } = await import("./inspect-audio.ts");
  const res = await inspectAudio(p && tl ? p.absolutized(tl) : null, {
    source: o.source ? presolve(o.source) : undefined, spectrogram: o.spectrogram, width: o.width, minSilence: o.minSilence,
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
  requireValid(p, tl);
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
export async function review(project: string | undefined, o: { beats?: number[] | string; minShot?: number; maxShot?: number; cps?: number; black?: boolean } = {}) {
  const p = openProject(project);
  const tl = p.load();
  const issues = p.validate(tl);
  requireValid(p, tl);
  const { review: rv } = await inspectMod();
  const beats = typeof o.beats === "string" && o.beats !== "music" ? o.beats.split(",").map((x) => M.parseTime(x)) : o.beats as number[] | "music" | undefined;
  return rv(drawable(p, M.resolve(tl)), p.root, { ...o, beats, issues });
}

const INTERCHANGE: Record<string, "fcpxml" | "otio"> = { ".fcpxml": "fcpxml", ".otio": "otio" };

/** Hand the edit to a human editor: FCPXML (Final Cut Pro) or OpenTimelineIO (DaVinci Resolve, Premiere, Avid...). */
export async function exportTimeline(project: string | undefined, o: { format?: string; out?: string } = {}) {
  const p = openProject(project);
  const tl = p.load();
  requireValid(p, tl);
  const ext = o.out ? o.out.slice(o.out.lastIndexOf(".")).toLowerCase() : "";
  const format = (o.format ?? INTERCHANGE[ext] ?? "fcpxml").toLowerCase();
  if (format !== "fcpxml" && format !== "otio") throw new M.EditError(`unknown interchange format '${format}'`, "bad_format", "use fcpxml (Final Cut Pro) or otio (DaVinci Resolve / Premiere / Avid)");
  const out = o.out ? (isAbsolute(o.out) ? o.out : presolve(o.out)) : p.defaultOutput(`.${format}`);
  mkdirSync(dirname(out), { recursive: true });
  const { exportTimeline: ex } = await import("./export.ts");
  return ex(p.absolutized(M.resolve(tl)), format, out);
}

/** Write the captions clips (timeline times, the pages the renderer shows) as .srt or .vtt. ids limits it to some clips. */
export function exportCaptions(project: string | undefined, o: { out?: string; format?: string; ids?: string[] } = {}) {
  const p = openProject(project);
  const tl = p.load();
  requireValid(p, tl);
  const ext = o.out ? extname(o.out).toLowerCase() : "";
  const format = (o.format ?? SUB.SUB_FORMATS[ext] ?? "srt").toLowerCase();
  if (format !== "srt" && format !== "vtt") throw new M.EditError(`unknown subtitle format '${o.format ?? ext}'`, "bad_format", "use .srt or .vtt");
  const cues = SUB.captionCues(p.absolutized(M.resolve(tl)), o.ids);
  if (!cues.length) throw new M.EditError(o.ids ? `no caption cues in ${o.ids.join(", ")}` : "the timeline has no captions clips", "empty", "add captions first: add_captions words=[...] | srt=... | transcribe=...");
  const out = o.out ? presolve(o.out) : p.defaultOutput(`.${format}`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, SUB.formatCues(cues, format));
  return { output: out, format, cues: cues.length, duration: +cues[cues.length - 1].end.toFixed(3), clips: [...new Set(cues.map((q) => q.clip))] };
}

export async function render(project: string | undefined, o: {
  out?: string; start?: number | string; end?: number | string; scale?: number; quality?: string; draft?: boolean;
  sheet?: boolean; workers?: number; fast?: boolean; codec?: string; alpha?: boolean; subtitles?: boolean; progress?: (d: number, n: number) => void;
  /** abort the render (MCP shutdown): children are stopped, temp files removed, the call rejects with signal.reason */
  signal?: AbortSignal;
} = {}) {
  if (o.out && INTERCHANGE[o.out.slice(o.out.lastIndexOf(".")).toLowerCase()]) return exportTimeline(project, { out: o.out });
  if (o.out && SUB.SUB_FORMATS[extname(o.out).toLowerCase()]) return exportCaptions(project, { out: o.out });
  const p = openProject(project);
  CACHE.sweepStale(p);
  const tl = p.load();
  requireValid(p, tl);
  let scale = o.scale ?? 1, quality = o.quality ?? "standard";
  if (o.draft) { scale = Math.min(scale, 0.5); quality = "draft"; }
  const out = o.out ? (isAbsolute(o.out) ? o.out : presolve(o.out)) : p.defaultOutput(".mp4", o.draft ? "draft" : "");
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
  o.signal?.throwIfAborted();
  if (res.audio_only) return res;
  if (o.subtitles) {
    const [t0, t1] = res.range as [number, number];
    const inRange = SUB.cuesInRange(cues, t0, t1);
    SUB.embedSubtitles(out, inRange);
    res.subtitles = { cues: inRange.length, codec: SUB.embedCodec(out) };
  }
  FB.recordEvent({ type: "render", speed_x: res.speed_x, frames: res.frames, width: res.width, height: res.height, workers: res.workers,
    encoder: res.encoder, seconds: res.render_seconds, layers: tl.tracks.reduce((n, t) => n + t.clips.length, 0),
    effects: tl.tracks.some((t) => t.clips.some((c) => c.effects?.length || c.mask || c.fit === "blur")) });
  if (o.sheet !== false && !out.endsWith(".gif")) {
    const loud = AN.loudnessAsync(out);
    try {
      const ts = Array.from({ length: 8 }, (_, i) => +(start + (res.duration * (i + 0.5)) / 8).toFixed(3));
      const png = await contactSheet(drawable(p, tl), p.root, ts, 4, 300);
      const sp = out.replace(/\.[^.]+$/, ".sheet.jpg");
      writeFileSync(sp, png);
      res.contact_sheet = sp;
    } catch (e: any) { res.contact_sheet_error = e.message; }
    res.loudness = await loud;
  }
  CACHE.capPreviews(p, out); // UI play drafts are rendered into previews/
  return res;
}

export const undo = (project?: string, steps = 1, revision?: number) => { const p = openProject(project); const r = p.undo(steps, revision); return { undone: r.labels, revision: r.revision, duration: M.totalDuration(M.resolve(p.load())) }; };
export const redo = (project?: string, steps = 1, revision?: number) => { const p = openProject(project); const r = p.redo(steps, revision); return { redone: r.labels, revision: r.revision, duration: M.totalDuration(M.resolve(p.load())) }; };
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
      ".wav/.mp3/.m4a/.aac/.flac (audio only)", ".fcpxml (Final Cut Pro project)", ".otio (OpenTimelineIO: Resolve, Premiere, Avid)"],
    render_codecs: ["auto", "h264", "hevc", "prores", "prores_4444", "vp9"],
    subtitle_formats: [".srt", ".vtt (export_captions)", "render subtitles=true: soft track in .mp4/.mov (mov_text), .mkv (srt), .webm (webvtt)"],
    audio_fx: { ...AFX.AUDIO_FX_DOC, eq_presets: AFX.EQ_PRESETS, eq_bands: Object.fromEntries(Object.entries(AFX.EQ_BANDS).map(([k, v]) => [k, v.doc])), compressor_presets: AFX.COMPRESSORS },
    ops: Object.keys(OPS),
  };
}
export const schema = () => M.schemaDoc();
export const opsDoc = () => opsDocs();
export const analyze = { beats: (p: string) => AN.beats(presolve(p)), scenes: (p: string, th?: number) => AN.scenes(presolve(p), th), silence: (p: string, n?: number, m?: number) => AN.silence(presolve(p), n, m), loudness: (p: string) => AN.loudness(presolve(p)), transcribe: (p: string, l?: string) => AN.transcribe(presolve(p), l), tts: AN.tts,
  subject: async (p: string, fps?: number) => { const f = presolve(p), a = probeMedia(f); if (a.kind !== "video" && a.kind !== "image") throw new M.EditError(`${p} is not a video or image`, "bad_media"); return analyzeSubject(f, { still: a.kind === "image", fps, duration: a.duration, srcW: a.width, srcH: a.height }); } };

export const feedback = {
  add: (a: M.Dict) => FB.addNote(a as any),
  list: (status = "open", kind?: string) => ({ notes: FB.listNotes({ status, kind }) }),
  summary: (sinceDays?: number, limit?: number) => FB.summary({ sinceDays, limit }),
  report: (out?: string, sinceDays?: number) => {
    const md = FB.summaryMarkdown(FB.summary({ sinceDays }));
    if (out) { mkdirSync(dirname(presolve(out)), { recursive: true }); writeFileSync(presolve(out), md); return { report: presolve(out) }; }
    return { markdown: md };
  },
  resolve: (id: string, status?: "resolved" | "wontfix" | "open", note?: string) => FB.resolveNote(id, status, note),
};

/** Compute the derived assets the timeline needs (mattes, vision analyses) and apply the pending vision requests. Slow:
 *  MCP runs it as a background job (render_status); preview/render fail with not_prepared until it ran. */
export const prepare = (project?: string, o: { progress?: (done: number, total: number) => void; signal?: AbortSignal } = {}) => {
  const p = openProject(project);
  CACHE.sweepStale(p);
  return PREP.prepare(p, o);
};
export const prepareStatus = (project?: string) => PREP.prepareStatus(openProject(project));
export const cache = {
  info: (project?: string) => CACHE.cacheInfo(openProject(project)),
  prune: (project?: string, o: { maxMb?: number; olderThan?: string | number } = {}) => CACHE.prune(openProject(project), o),
};
