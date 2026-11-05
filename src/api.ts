// High-level API shared by the CLI and the MCP server. Every function returns JSON-able objects.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as presolve } from "node:path";
import * as AN from "./analyze.ts";
import { loadCanvas } from "./canvas.ts";
import { listFonts } from "./fonts.ts";
import { LOOKS, probe as probeMedia } from "./media.ts";
import * as M from "./model.ts";
import { applyOps, opsDoc as opsDocs, OPS } from "./ops.ts";
import { CAPTION_PRESETS, TEMPLATES, TEXT_PRESETS } from "./presets.ts";
import { findProject, Project, summarize } from "./project.ts";

const renderMod = async () => { await loadCanvas(); return import("./render.ts"); };
const TEXTY = /"(text|words|srt|preset|apply_template|add_captions|add_voiceover|font)"/;

export const openProject = (p?: string) => new Project(findProject(p));

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
  const out: M.Dict = { project: p.root, duration: M.totalDuration(M.resolve(tl)), ...brief(p.validate(tl)) };
  if (fmt !== "json") out.summary = summarize(tl);
  if (fmt !== "summary") out.timeline = tl;
  return out;
}

export async function apply(project: string | undefined, ops: M.Dict[] | M.Dict, o: { dryRun?: boolean; allowInvalid?: boolean; label?: string } = {}) {
  if (TEXTY.test(JSON.stringify(ops))) await loadCanvas(); // glyph coverage checks for fonts/presets
  const p = openProject(project);
  const tl = p.load();
  const list: M.Dict[] = Array.isArray(ops) ? ops : ops.ops ?? [ops];
  const key = (i: M.Issue) => `${i.path.split("<")[0]}|${i.message}`;
  const before = new Set(p.validate(tl).filter((i) => i.level === "error").map(key));
  const [next, results] = applyOps(p, tl, list);
  const issues = p.validate(next);
  const added = issues.filter((i) => i.level === "error" && !before.has(key(i)));
  if (added.length && !o.allowInvalid)
    throw new M.EditError(`batch rejected: it would add ${added.length} validation error(s); nothing was changed`, "validation_failed",
      added[0].hint ?? "fix the listed fields and resend the whole batch", undefined, { issues: added.slice(0, 15) });
  if (!o.dryRun) p.save(next, o.label ?? [...new Set(list.map((x) => x.op))].join(", ").slice(0, 120));
  return { ok: true, dry_run: !!o.dryRun, results, duration: M.totalDuration(next), ...brief(issues) };
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

const outPath = (p: Project, out: string | undefined, dflt: string) => (out ? (isAbsolute(out) ? out : presolve(out)) : join(p.root, dflt));

export async function frame(project: string | undefined, t: number | string, o: { out?: string; scale?: number; guides?: boolean } = {}) {
  const p = openProject(project);
  const tl = p.load();
  requireValid(p, tl);
  const tt = M.parseTime(t);
  const { renderFrame } = await renderMod();
  const png = await renderFrame(p.absolutized(tl), p.root, tt, o.scale ?? 0.5, !!o.guides);
  const out = outPath(p, o.out, `previews/frame-${tt.toFixed(2).padStart(7, "0")}s.png`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  return { image: out, t: tt, bytes: png.length };
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
  const png = await contactSheet(p.absolutized(tl), p.root, ts, o.cols ?? 4, o.tileWidth ?? 320, !!o.guides);
  const out = outPath(p, o.out, `previews/sheet-${Date.now()}.png`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  return { image: out, times: ts, duration: T };
}

export async function render(project: string | undefined, o: {
  out?: string; start?: number | string; end?: number | string; scale?: number; quality?: string; draft?: boolean;
  sheet?: boolean; workers?: number; fast?: boolean; progress?: (d: number, n: number) => void;
} = {}) {
  const p = openProject(project);
  const tl = p.load();
  requireValid(p, tl);
  let scale = o.scale ?? 1, quality = o.quality ?? "standard";
  if (o.draft) { scale = Math.min(scale, 0.5); quality = "draft"; }
  const out = o.out ? (isAbsolute(o.out) ? o.out : presolve(o.out)) : p.defaultOutput(".mp4", o.draft ? "draft" : "");
  const start = M.parseTime(o.start ?? 0);
  const { contactSheet } = await renderMod();
  const { renderVideo } = await import("./encode.ts");
  const res: M.Dict = await renderVideo(p.absolutized(tl), p.root, out, {
    start, end: o.end !== undefined ? M.parseTime(o.end) : undefined, scale, quality, workers: o.workers,
    hwEncode: o.fast ?? !!o.draft, fontDirs: [join(p.root, "fonts")], progress: o.progress,
  });
  if (o.sheet !== false && !out.endsWith(".gif")) {
    const loud = AN.loudnessAsync(out);
    try {
      const ts = Array.from({ length: 8 }, (_, i) => +(start + (res.duration * (i + 0.5)) / 8).toFixed(3));
      const png = await contactSheet(p.absolutized(tl), p.root, ts, 4, 300);
      const sp = out.replace(/\.[^.]+$/, ".sheet.png");
      writeFileSync(sp, png);
      res.contact_sheet = sp;
    } catch (e: any) { res.contact_sheet_error = e.message; }
    res.loudness = await loud;
  }
  return res;
}

export const undo = (project?: string, steps = 1) => { const p = openProject(project); return { undone: p.undo(steps), duration: M.totalDuration(M.resolve(p.load())) }; };
export const redo = (project?: string, steps = 1) => { const p = openProject(project); return { redone: p.redo(steps), duration: M.totalDuration(M.resolve(p.load())) }; };
export const history = (project?: string) => openProject(project).history();
export const probe = (path: string) => probeMedia(presolve(path));
export const fonts = async (q = "", limit = 60) => { await loadCanvas(); return { fonts: listFonts(q, limit) }; };
export const voices = (lang?: string) => ({ voices: AN.ttsVoices().filter((v) => !lang || v.lang.toLowerCase().startsWith(lang.toLowerCase())) });

export function capabilities() {
  const pick = (t: Record<string, { doc: string }>) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.doc]));
  return {
    clip_types: M.CLIP_TYPES, enter_exit_animations: M.ENTER_EXIT, transitions: M.TRANSITIONS, motions: M.MOTIONS, easings: M.EASINGS,
    effects: M.EFFECTS, filters: M.FILTERS, looks: Object.keys(LOOKS), masks: M.MASKS, shapes: M.SHAPES, blend_modes: M.BLENDS,
    fit_modes: M.FITS, positions: M.POSITIONS, caption_styles: M.CAPTION_STYLES, animatable: M.ANIMATABLE,
    text_presets: pick(TEXT_PRESETS), caption_presets: pick(CAPTION_PRESETS),
    templates: Object.fromEntries(Object.entries(TEMPLATES).map(([k, v]) => [k, { doc: v.doc, args: v.args }])),
    canvas_presets: Object.fromEntries(Object.entries(M.PRESETS).map(([k, [w, h]]) => [k, `${w}x${h}`])),
    output_formats: [".mp4 (H.264)", ".mov (ProRes 422)", ".webm (VP9)", ".mkv", ".gif"],
    ops: Object.keys(OPS),
  };
}
export const schema = () => M.schemaDoc();
export const opsDoc = () => opsDocs();
export const analyze = { beats: (p: string) => AN.beats(presolve(p)), scenes: (p: string, th?: number) => AN.scenes(presolve(p), th), silence: (p: string, n?: number, m?: number) => AN.silence(presolve(p), n, m), loudness: (p: string) => AN.loudness(presolve(p)), transcribe: (p: string, l?: string) => AN.transcribe(presolve(p), l), tts: AN.tts };
