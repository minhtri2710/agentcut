// AI vision ops: auto_reframe (subject-following focus keyframes), remove_background (cached alpha matte),
// track_to (an overlay/text follows a tracked box or the subject). The heavy lifting runs in vision.ts (uv + Python), and
// never inside apply_ops: an op whose analysis is not cached records its request in clip.pending (remove_background just
// sets its field), and `prepare` (prepare.ts) computes the missing assets and re-runs the pending ops.
import { coverOffset, fitBox } from "./media.ts";
import { allClips, type Clip, clipDur, clipStart, type Dict, EditError, findClip, MATTE_MODELS, MATTE_SIZES, parseLen, parseTime, resolve, round6, type Timeline } from "./model.ts";
import type { OpHelpers } from "./ops.ts";
import type { Project } from "./project.ts";
import * as V from "./vision.ts";
import { kfValue } from "./anim.ts";

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Where a video/image clip's source pixels land on the canvas (canvas px), for clips drawn with a static layout. */
type VAsset = Dict & { path: string; kind: string; width: number; height: number; fps?: number | null };
function asset(tl: Timeline, c: Clip): VAsset {
  const a = tl.assets[c.asset];
  if (!a?.width || !a?.height || !a.path) throw new EditError(`clip '${c.id}' has no probed video/image asset`, "bad_type");
  return a as VAsset;
}

export function layout(tl: Timeline, c: Clip) {
  const a = asset(tl, c);
  const W0 = tl.settings.width, H0 = tl.settings.height;
  const box: [number, number] = c.size ? [parseLen(c.size[0], W0), parseLen(c.size[1], H0)] : [W0, H0];
  const crop = c.crop || {}, [cl, cr, ct, cb] = ["left", "right", "top", "bottom"].map((k) => Number(crop[k] ?? 0));
  const cw = a.width * (1 - cl - cr), ch = a.height * (1 - ct - cb);
  const fit = c.fit === "blur" ? "contain" : c.fit ?? "cover";
  const fb = fitBox(cw, ch, box[0], box[1], fit);
  // fitBox rounds to the decode size; keep the exact scale for mapping
  const sx = fb.w / cw, sy = fb.h / ch;
  return { a, box, fit, cw, ch, cl, ct, sx, sy, w: fb.w, h: fb.h, ow: fb.ow, oh: fb.oh };
}

/** focus at clip-local time t (keyframed or static): the source point (0..1 of the picture after crop) the cover view centres on */
const focusAt = (c: Clip, t: number): [number, number] => {
  const f = c.focus ?? [0.5, 0.5], k = c.keyframes ?? {};
  return [clamp01(k.focus_x ? kfValue(k.focus_x, t) : Number(f[0])), clamp01(k.focus_y ? kfValue(k.focus_y, t) : Number(f[1]))];
};

function plainTarget(c: Clip) {
  if (c.type !== "video" && c.type !== "image") throw new EditError(`'${c.id}' is a ${c.type} clip; needs a video or image clip`, "bad_type", "pass the id of a video/image clip (see the project info)");
  const busy = ["rotation", "scale_x", "scale_y"].filter((k) => c[k] !== undefined && Number(c[k]) !== (k === "rotation" ? 0 : 1));
  const kf = Object.keys(c.keyframes ?? {}).filter((k) => !["focus_x", "focus_y", "opacity", "volume", "blur"].includes(k));
  // a mirrored or deshaken picture is drawn before the focus crop, so the analysed coordinates (of the unshifted source) would not match it;
  // the other filters (eq, lut, blur, sharpen, grayscale, vignette, denoise, chromakey) change pixel values only
  const flips = (c.filters ?? []).map((f: any) => (typeof f === "string" ? f : f?.type)).filter((t: string) => t === "hflip" || t === "vflip" || t === "stabilize").map((t: string) => "filter " + t);
  if (c.position || busy.length || kf.length || flips.length || c.motion || c.reverse || c.fit === "none")
    throw new EditError(`'${c.id}' is moved/animated (${[c.position && "position", ...busy, ...kf.map((k) => "keyframes." + k), ...flips, c.motion && "motion", c.reverse && "reverse", c.fit === "none" && "fit none"].filter(Boolean).join(", ")})`,
      "unsupported", "vision ops map source pixels through a static layout (fit cover/contain/blur, size, x/y, scale, focus); remove the animation, flip or stabilize, run the op, then re-add it");
}

/** source fraction (0..1 of the full source frame) -> canvas px, at clip-local time t */
function srcToCanvas(tl: Timeline, c: Clip, L: ReturnType<typeof layout>, t: number, u: number, v: number): [number, number] {
  const [fx, fy] = focusAt(c, t), s = Number(c.scale ?? 1);
  const cx = c.x !== undefined ? parseLen(c.x, tl.settings.width) : tl.settings.width / 2;
  const cy = c.y !== undefined ? parseLen(c.y, tl.settings.height) : tl.settings.height / 2;
  const px = (u * L.a.width - L.cl * L.a.width) * L.sx - coverOffset(fx, L.w, L.ow), py = (v * L.a.height - L.ct * L.a.height) * L.sy - coverOffset(fy, L.h, L.oh);
  return [cx + (px - L.ow / 2) * s, cy + (py - L.oh / 2) * s];
}
function canvasToSrc(tl: Timeline, c: Clip, L: ReturnType<typeof layout>, t: number, X: number, Y: number): [number, number] {
  const [ox, oy] = srcToCanvas(tl, c, L, t, 0, 0), [x1, y1] = srcToCanvas(tl, c, L, t, 1, 1);
  return [(X - ox) / (x1 - ox), (Y - oy) / (y1 - oy)];
}

const root = (p: Project | null) => p?.root;
const absPath = (p: Project | null, path: string) => (p ? p.abs(path) : path);
const num = (v: unknown, d: number, name: string, lo = 0) => {
  const x = v === undefined ? d : Number(v);
  if (!Number.isFinite(x) || x < lo) throw new EditError(`'${name}' must be a number >= ${lo}`, "bad_value");
  return x;
};

/** source seconds covered by a clip (no speed ramps) */
function srcRange(c: Clip) {
  if (c.keyframes?.speed) throw new EditError(`'${c.id}' has a speed ramp`, "unsupported", "remove keyframes.speed, run the op, then re-add the ramp");
  const speed = Number(c.speed ?? 1) || 1, in0 = parseTime(c.in ?? 0);
  return { in0, speed, len: clipDur(c) * speed };
}

/** Subject analysis job for a clip's source range. */
function subjectJob(p: Project | null, tl: Timeline, c: Clip, fps: number) {
  const a = asset(tl, c), { in0, len } = srcRange(c);
  return V.subjectJob(absPath(p, a.path), a.kind === "image" ? { still: true, srcW: a.width, srcH: a.height, root: root(p) }
    : { start: in0, duration: len, fps, srcW: a.width, srcH: a.height, root: root(p) });
}
/** Cached subject samples as [clip-local t, source fraction x, y | undefined]. `within` = [from, to] clip-local seconds keeps only the samples
 *  in that span; the counts and the summary describe exactly the samples kept. */
function subjectTrack(tl: Timeline, c: Clip, d: V.Derived, within?: [number, number]) {
  const a = asset(tl, c), { in0, speed } = srcRange(c);
  const at = (s: V.Sample) => (a.kind === "image" ? 0 : (s.t - in0) / speed);
  const samples = V.subjectSamples(d).filter((s) => !within || (at(s) >= within[0] - 1e-6 && at(s) <= within[1] + 1e-6));
  const pts = samples.map((s) => ({ t: at(s), x: s.kind === "none" ? undefined : s.x, y: s.kind === "none" ? undefined : s.y }));
  return { pts, face_samples: samples.filter((s) => s.kind === "face").length, n: samples.length, ...V.subjectSummary(samples) };
}

export const PREPARE_HINT = "run prepare to compute it; preview and render need it";
let sink: V.Derived[] | null = null;
/** Run f and collect the analyses that vision ops found missing (each recorded a pending request instead). */
export const collectMissing = <T,>(f: () => T) => collect(f, (d) => !V.isReady(d));
/** Like collectMissing, but also the analyses that are already cached (a pending request may have its file already). */
export const collectAnalyses = <T,>(f: () => T) => collect(f, () => true);
function collect<T>(f: () => T, keep: (d: V.Derived) => boolean): [T, V.Derived[]] {
  const prev = sink, got: V.Derived[] = [];
  sink = got;
  try { return [f(), got.filter(keep)]; } finally { sink = prev; prev?.push(...got); }
}
const clearPending = (c: Clip, op: string) => { if (c.pending) { delete c.pending[op]; if (!Object.keys(c.pending).length) delete c.pending; } };
/** The analysis d is cached: clear the request. Otherwise record it in clip.pending (d null = waiting on another request). */
function ready(c: Clip, op: string, req: Dict, d: V.Derived | null): d is V.Derived {
  if (d) sink?.push(d);
  if (d && V.isReady(d)) { clearPending(c, op); return true; }
  (c.pending ??= {})[op] = req;
  return false;
}
const pick = (a: Dict, keys: string[]) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
const pendingResult = (id: string, extra: Dict = {}) => ({ id, pending: true, ...extra, hint: PREPARE_HINT });

/** keyframes [t, v] from a dense path, simplified within tol */
function toKfs(ts: number[], vs: number[], tol: number) {
  return V.simplify(ts, [vs], tol).map((i) => [round6(ts[i]), r4(vs[i])]);
}

export function registerVisionOps(h: OpHelpers) {
  const get = (tl: Timeline, id: unknown): Clip => {
    if (id === undefined || id === null || id === "") throw new EditError("missing 'id'", "missing_arg", "pass a clip id or a ref like 'main#1'");
    return findClip(tl, h.resolveRef(tl, String(id)))[2];
  };

  h.op("auto_reframe", "Follow the subject (the largest face found by YuNet, with a confidence score, else the most salient region) inside a cover-fitted clip: writes smoothed keyframes.focus_x/focus_y (the subject position as the source point the view centres on, 0..1 after crop, kept within what the view can reach) so a 16:9 shot stays framed in 9:16 (or any crop). The result says what was followed: subject = face|saliency|mixed|none, plus warnings (no face found, low confidence, several faces) to check with preview_frame; samples counts the analysis samples and face_samples those with a face. Needs uv (downloads opencv on first use); the 0.23 MB face model is downloaded only by prepare with allow_download=true (CLI: prepare --allow-download), else prepare fails with code model_not_cached. The analysis is cached per file+range; when it is not cached yet the request is recorded (clip.pending, result pending=true) and prepare computes it and writes the keyframes.",
    { id: "video/image clip", fps: "analysis samples per second (6)", smooth: "smoothing sigma seconds (0.8; higher = calmer camera)", tolerance: "max focus error kept when thinning keyframes (0.01)", axis: "auto|x|y|both (auto = the axis that can pan)" },
    (p, tl, a) => {
      resolve(tl);
      const c = get(tl, a.id);
      plainTarget(c);
      if ((c.fit ?? "cover") !== "cover") throw new EditError(`'${c.id}' has fit '${c.fit}'; reframing needs fit 'cover'`, "unsupported", `update_clip id=${c.id} set={fit:'cover'} first`);
      const L = layout(tl, c);
      const panX = L.w - L.ow > 1, panY = L.h - L.oh > 1;
      const axis = a.axis ?? "auto";
      if (!["auto", "x", "y", "both"].includes(axis)) throw new EditError(`unknown axis '${axis}'`, "bad_value", "auto|x|y|both");
      const wantX = panX && axis !== "y", wantY = panY && axis !== "x";
      if (!wantX && !wantY) throw new EditError(`'${c.id}' fills its box exactly: there is nothing to pan`, "nothing_to_do", "auto_reframe helps when the source aspect differs from the clip box (e.g. 16:9 footage in a 9:16 canvas)");
      const fps = num(a.fps, 6, "fps", 0.5), sigma = num(a.smooth, 0.8, "smooth"), tol = num(a.tolerance, 0.01, "tolerance");
      const d = subjectJob(p, tl, c, fps);
      if (!ready(c, "auto_reframe", pick(a, ["fps", "smooth", "tolerance", "axis"]), d)) return pendingResult(c.id);
      const tr = subjectTrack(tl, c, d), ts = tr.pts.map((q) => q.t);
      // subject fraction -> the focus (the source point the view centres on), kept in the range the view can reach so thinned keyframes do not move while it is pinned at an edge
      const toFocus = (u: number, src: number, crop0: number, scale: number, full: number, view: number) => {
        const lo = view / (2 * full);
        return Math.min(1 - lo, Math.max(lo, ((u * src - crop0 * src) * scale) / full));
      };
      const kf = (c.keyframes ??= {});
      delete kf.focus_x; delete kf.focus_y;
      const f0 = c.focus ?? [0.5, 0.5], out: Dict = { id: c.id, samples: tr.n, face_samples: tr.face_samples, subject: tr.subject, ...(tr.warnings && { warnings: tr.warnings }) };
      const axes: [boolean, "x" | "y", 0 | 1][] = [[wantX, "x", 0], [wantY, "y", 1]];
      for (const [want, ax, i] of axes) {
        if (!want) continue;
        const path = V.smoothPath(ts, tr.pts.map((q) => q[ax]), sigma).map((u) => ax === "x"
          ? toFocus(u, L.a.width, L.cl, L.sx, L.w, L.ow) : toFocus(u, L.a.height, L.ct, L.sy, L.h, L.oh));
        const k = toKfs(ts, path, tol);
        if (k.length === 1 || L.a.kind === "image") { f0[i] = k[0][1]; continue; }
        kf[`focus_${ax}`] = k;
        out[`focus_${ax}`] = k.length;
      }
      if (!Object.keys(kf).length) delete c.keyframes;
      c.focus = f0.map(r4);
      out.focus = c.focus;
      return out;
    });

  h.op("remove_background", `AI background removal on a video/image clip (sets field remove_background; fast). The alpha matte is computed by prepare into the project cache (.agentcut/cache, keyed by file hash + model) and composited through the normal alpha path; preview/render fail with code not_prepared until it exists. Needs uv (downloads rembg + onnxruntime on first use). A model is never downloaded without consent: prepare fails with code model_not_cached until the model file is in <user cache>/models (~/.cache/agentcut/models, or AGENTCUT_CACHE) or prepare is run with allow_download=true (CLI: prepare --allow-download); sizes: ${MATTE_SIZES}. AgentCut runs onnxruntime children (the vision helper and piper) with ORT_DISABLE_TELEMETRY=1 (onnxruntime may otherwise send usage telemetry). off=true removes it.`,
    { id: "video/image clip", model: MATTE_MODELS.join("|") + " (u2netp: fast; u2net_human_seg: people)", off: "true to turn it off" },
    (p, tl, a) => {
      const c = get(tl, a.id);
      if (c.type !== "video" && c.type !== "image") throw new EditError(`'${c.id}' is a ${c.type} clip; needs a video or image clip`, "bad_type", "pass the id of a video/image clip (see the project info)");
      if (a.off) { delete c.remove_background; return { id: c.id, remove_background: false }; }
      c.remove_background = a.model ? { model: a.model } : true;
      const m = matteFor(p?.root, tl, c, absPath(p, tl.assets[c.asset].path));
      return V.isReady(m) ? { id: c.id, remove_background: c.remove_background, matte: m.file } : { remove_background: c.remove_background, ...pendingResult(c.id) };
    });

  h.op("track_to", "Make an overlay/text clip follow an object in a video clip (motion tracking): box [x, y, w, h] in canvas px (or %) around the object at timeline time 'at' is tracked (OpenCV CSRT) through the target's source; writes keyframes x/y on the clip and attaches it to the target. Without box it follows the subject (a YuNet face with a confidence score, else the most salient region) and the result carries subject/warnings as auto_reframe does; that needs the face model, downloaded only by prepare with allow_download=true. Needs uv (downloads opencv on first use). Cached; when not cached yet the request is recorded (pending=true) and prepare tracks and writes the keyframes.",
    { id: "follower clip (text/shape/image/video overlay)", target: "video clip with the object", box: "[x, y, w, h] canvas px or % (top-left + size) at 'at'", at: "timeline seconds where box is drawn (default: follower start)", shift: "[dx, dy] px added to the object centre", tracker: "csrt|kcf", fps: "tracking samples/s (15)", smooth: "sigma seconds (0.15)" },
    (p, tl, a) => {
      resolve(tl);
      const f = get(tl, a.id), t = get(tl, a.target);
      if (f.id === t.id) throw new EditError("a clip can't track itself", "bad_value", "id = the overlay that moves, target = the video it follows");
      h.refuseAttachedMagnetic(f, findClip(tl, f.id)[0], f.attach_to ?? t.id);
      if (t.type !== "video") throw new EditError(`target '${t.id}' is a ${t.type} clip; tracking needs a video`, "bad_type");
      plainTarget(t);
      const L = layout(tl, t), { in0, speed } = srcRange(t);
      const ts0 = clipStart(t), fs0 = clipStart(f);
      const s0 = Math.max(fs0, ts0), s1 = Math.min(fs0 + clipDur(f), ts0 + clipDur(t));
      if (s1 - s0 < 0.05) throw new EditError(`'${f.id}' (${fs0.toFixed(2)}-${(fs0 + clipDur(f)).toFixed(2)}s) does not overlap '${t.id}' in time`, "out_of_range", "move the follower over the target first");
      const fps = num(a.fps, 15, "fps", 0.5), W0 = tl.settings.width, H0 = tl.settings.height;
      const srcAt = (T: number) => in0 + (T - ts0) * speed;
      const req = { ...pick(a, ["box", "at", "shift", "tracker", "fps", "smooth"]), target: t.id };
      // the box maps to source pixels through the target's focus: a pending reframe of the target must land first
      if (t.pending?.auto_reframe) { ready(f, "track_to", req, null); return pendingResult(f.id, { waiting_for: `auto_reframe ${t.id}` }); }
      let pts: { T: number; u?: number; v?: number }[], lost = 0, followed: Dict = {};
      if (a.box !== undefined) {
        if (!Array.isArray(a.box) || a.box.length !== 4) throw new EditError("box must be [x, y, w, h]", "bad_value", "top-left corner + size in canvas px or %, e.g. [400, 600, 200, 200]");
        const [bx, by, bw, bh] = a.box.map((v: any, i: number) => parseLen(v, i % 2 ? H0 : W0));
        const at = a.at === undefined ? s0 : parseTime(a.at, "at");
        if (at < s0 - 1e-6 || at > s1 + 1e-6) throw new EditError(`'at' ${at}s is outside the tracked span ${s0.toFixed(2)}-${s1.toFixed(2)}s`, "out_of_range", "'at' must be a time where both clips are on screen");
        const [u0, v0] = canvasToSrc(tl, t, L, at - ts0, bx, by), [u1, v1] = canvasToSrc(tl, t, L, at - ts0, bx + bw, by + bh);
        const sb = [clamp01(u0), clamp01(v0), clamp01(u1) - clamp01(u0), clamp01(v1) - clamp01(v0)];
        if (sb[2] <= 0.002 || sb[3] <= 0.002) throw new EditError("box is outside the visible picture of the target", "out_of_range", "draw the box over the object as seen in preview_frame");
        if (a.tracker && !["csrt", "kcf"].includes(a.tracker)) throw new EditError(`unknown tracker '${a.tracker}'`, "bad_value", "csrt|kcf");
        const d = V.trackJob(absPath(p, L.a.path), { start: srcAt(s0), duration: (s1 - s0) * speed, at: srcAt(at), box: sb, fps, tracker: a.tracker, srcW: L.a.width, srcH: L.a.height, root: root(p) });
        if (!ready(f, "track_to", req, d)) return pendingResult(f.id);
        pts = V.readResult(d).samples.map((s) => { if (!s.ok) lost++; return { T: ts0 + (s.t - in0) / speed, u: s.ok ? s.x : undefined, v: s.ok ? s.y : undefined }; });
      } else {
        const d = subjectJob(p, tl, t, Math.min(fps, 10));
        if (!ready(f, "track_to", req, d)) return pendingResult(f.id);
        const tr = subjectTrack(tl, t, d, [s0 - ts0, s1 - ts0]);
        followed = { subject: tr.subject, ...(tr.warnings && { warnings: tr.warnings }) };
        pts = tr.pts.map((q) => ({ T: ts0 + q.t, u: q.x, v: q.y }));
        if (!pts.length) throw new EditError("no subject samples in the overlap", "vision_failed", "pass box to track a specific object");
      }
      const Ts = pts.map((q) => q.T), sigma = num(a.smooth, 0.15, "smooth");
      const us = V.smoothPath(Ts, pts.map((q) => q.u), sigma), vs = V.smoothPath(Ts, pts.map((q) => q.v), sigma);
      const [dx, dy] = Array.isArray(a.shift) ? [parseLen(a.shift[0], W0), parseLen(a.shift[1], H0)] : [0, 0];
      const xy = Ts.map((T, i) => srcToCanvas(tl, t, L, T - ts0, us[i], vs[i]));
      const lt = Ts.map((T) => T - fs0), X = xy.map((q) => q[0] + dx), Y = xy.map((q) => q[1] + dy);
      const keep = V.simplify(lt, [X, Y], 1.5);
      f.keyframes = { ...(f.keyframes ?? {}), x: keep.map((i) => [round6(lt[i]), Math.round(X[i] * 10) / 10]), y: keep.map((i) => [round6(lt[i]), Math.round(Y[i] * 10) / 10]) };
      delete f.position;
      if (!f.attach_to) { f.attach_to = t.id; f.offset = round6(fs0 - ts0); delete f.start; }
      return { id: f.id, target: t.id, samples: pts.length, lost, keyframes: keep.length, attached_to: f.attach_to, ...followed };
    });
}

/** Matte job for a clip with remove_background (path: the asset's absolute path). */
export function matteFor(root: string | undefined, tl: Timeline, c: Clip, path: string) {
  const a = asset(tl, c), rb = c.remove_background;
  return V.matteJob(path, { kind: a.kind, fps: a.fps, duration: a.duration, srcW: a.width, srcH: a.height, model: typeof rb === "object" ? rb.model : undefined, root });
}

/** Matte jobs of every enabled remove_background clip (compounds included) of an absolutized timeline. */
export function mattesFor(tl: Timeline, root: string) {
  return [...allClips(tl.tracks)].filter((c) => c.remove_background && c.enabled !== false && (c.type === "video" || c.type === "image"))
    .map((c) => ({ clip: c, job: matteFor(root, tl, c, tl.assets[c.asset].path) }));
}

/** Render prep on an absolutized copy: point every remove_background clip at its matte (`_matte`, never saved; any other `_matte` is dropped). Fails fast
 *  with not_prepared while a matte is missing or a vision request is pending, instead of computing inside a preview. */
export function attachPrepared(tl: Timeline, root: string) {
  for (const c of allClips(tl.tracks)) delete c._matte; // this is the only source of `_matte`: a hand-set one is never drawn
  const mattes = mattesFor(tl, root).filter(({ clip, job }) => {
    if (!V.isReady(job)) return true;
    clip._matte = { path: job.file, w: job.w, h: job.h };
    return false;
  }).map(({ clip }) => clip.id);
  const pending = [...allClips(tl.tracks)].flatMap((c) => Object.keys(c.pending ?? {}).map((op) => `${op} ${c.id}`));
  if (mattes.length || pending.length)
    throw new EditError(`not prepared: ${[...mattes.map((id) => `remove_background ${id} (matte missing)`), ...pending.map((x) => `${x} (pending)`)].join(", ")}`,
      "not_prepared", PREPARE_HINT, undefined, { mattes, pending });
  return tl;
}
