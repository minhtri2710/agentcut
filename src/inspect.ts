// Visual self-checks: dense frame strips around transitions / a time window, and an editorial review (lint) with times.
import { createCanvas } from "@napi-rs/canvas";
import * as AN from "./analyze.ts";
import {
  type Clip, clipDur, clipEnd, clipStart, type Dict, EditError, type Issue, normAnim, parseTime, resolve, type Timeline, totalDuration,
} from "./model.ts";
import { type Layer, refuseJpegSize, Renderer, renderTiles, safeZones, tileSize } from "./render.ts";

const r3 = (x: number) => +x.toFixed(3);
const visual = (tl: Timeline) => tl.tracks.filter((t) => !t.hidden && (t.kind ?? "video") !== "audio");

// ------------------------------------------------------------------ motion strips
export interface Window { label: string; start: number; end: number }

/** Every transition on a visual track: the overlap plus `pad` s either side. tl must be resolved. */
export function transitionWindows(tl: Timeline, pad = 0.15): Window[] {
  const out: Window[] = [];
  for (const tr of visual(tl)) tr.clips.forEach((c, i) => {
    const spec = i > 0 ? normAnim(c.transition, 0.5) : null;
    if (!spec || c.enabled === false) return;
    const d = Math.min(spec.duration, clipDur(c), clipDur(tr.clips[i - 1])), s = clipStart(c);
    out.push({ label: `${spec.type} ${tr.clips[i - 1].id} -> ${c.id} (${tr.id})`, start: s - pad, end: s + d + pad });
  });
  return out.sort((a, b) => a.start - b.start);
}

/** One strip (row of `frames` time-labelled frames) per window; rows are paged `perImage` to an image. tl absolutized. */
export async function motionStrips(tl: Timeline, root: string, windows: Window[], o: { frames?: number; tileWidth?: number; perImage?: number } = {}) {
  resolve(tl);
  const T = totalDuration(tl), fps = Number(tl.settings.fps) || 30;
  const n = o.frames ?? 10; // api.motion refuses a count outside 2..24
  const ws = windows.map((w) => ({ ...w, start: Math.max(0, w.start), end: Math.min(T, w.end) })).filter((w) => w.end > w.start);
  if (!ws.length) throw new EditError("no time window to inspect", "empty", "the timeline has no transitions: pass start/end (or times) to inspect a range");
  const times = ws.map((w) => Array.from({ length: n }, (_, i) => +Math.min(w.start + ((w.end - w.start) * i) / (n - 1), T - 1 / fps).toFixed(3)));
  const tileW = o.tileWidth ?? Math.max(80, Math.min(320, Math.floor(1800 / n))), gap = 3, head = 20, per = Math.max(1, o.perImage ?? 6), rowsMax = Math.min(per, ws.length);
  refuseJpegSize("a motion image", tileW, (w) => { const t = tileSize(tl, w); return [n * t.W + (n - 1) * gap, rowsMax * (head + t.H + gap)]; }, { width: ["fewer frames"], height: [] });
  const tiles = await renderTiles(tl, root, times.flat(), tileW);
  const tw = tiles[0].width, th = tiles[0].height;
  const images: Buffer[] = [];
  for (let p = 0; p < ws.length; p += per) {
    const rows = ws.slice(p, p + per);
    const cv = createCanvas(n * tw + (n - 1) * gap, rows.length * (head + th + gap)), ctx = cv.getContext("2d");
    ctx.fillStyle = "#1e1e1e"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.font = "600 13px Menlo, Consolas, monospace";
    rows.forEach((w, r) => {
      const y = r * (head + th + gap);
      ctx.fillStyle = "#ffd600"; ctx.fillText(`${w.label}  ${w.start.toFixed(2)}-${w.end.toFixed(2)}s  (${((w.end - w.start) / (n - 1)).toFixed(3)}s/frame)`, 4, y + 15);
      for (let i = 0; i < n; i++) ctx.drawImage(tiles[(p + r) * n + i], i * (tw + gap), y + head);
    });
    images.push(cv.encodeSync("jpeg", 85));
  }
  return { images, strips: ws.map((w, i) => ({ label: w.label, start: r3(w.start), end: r3(w.end), times: times[i] })) };
}

// ------------------------------------------------------------------ review
export interface ReviewOpts {
  beats?: number[] | "music"; minShot?: number; maxShot?: number; cps?: number; black?: boolean; issues?: Issue[]; signal?: AbortSignal;
}
export interface Finding { type: string; t: number; end?: number; id?: string; message: string; hint?: string }

const TEXTY = new Set(["text", "captions"]);

/** Beat times on the timeline: explicit list, "music" (analyse the music-role tracks' clips), else markers named beat*. */
async function timelineBeats(tl: Timeline, b: ReviewOpts["beats"], signal?: AbortSignal): Promise<{ beats: number[]; from: string }> {
  if (Array.isArray(b)) return { beats: b.map(Number).sort((x, y) => x - y), from: "option" };
  if (b === "music") {
    const out: number[] = [];
    for (const tr of tl.tracks) if (tr.role === "music" && !tr.muted) for (const c of tr.clips) {
      const a = tl.assets[c.asset];
      if (!a || c.type !== "audio" && c.type !== "video") continue;
      const cin = parseTime(c.in ?? 0), sp = Number(c.speed ?? 1) || 1, s = clipStart(c), e = clipEnd(c);
      for (const x of (await AN.beats(a.path, signal)).beats) { const t = s + (x - cin) / sp; if (t >= s - 1e-6 && t <= e + 1e-6) out.push(t); }
    }
    if (!out.length) throw new EditError("no beats found on music tracks", "no_beats", "add music (track role=music) or pass beats as a list of timeline seconds");
    return { beats: out.sort((x, y) => x - y), from: "music" };
  }
  return { beats: (tl.markers ?? []).filter((m) => /^beat/i.test(String(m.label ?? ""))).map((m) => Number(m.t)).sort((x, y) => x - y), from: "markers" };
}

/** Review a resolved, absolutized timeline. Returns findings sorted by time. */
export async function review(tl: Timeline, root: string, o: ReviewOpts = {}) {
  resolve(tl);
  const W = tl.settings.width, H = tl.settings.height, T = totalDuration(tl), fps = Number(tl.settings.fps) || 30;
  const out: Finding[] = [];
  const at = new Map<string, Clip>();
  for (const tr of tl.tracks) for (const c of tr.clips) at.set(c.id, c);

  // validation warnings/errors (incl. clips needing more source than the media has) - reused, not re-checked
  for (const i of o.issues ?? []) {
    if (i.level === "info") continue;
    const id = /<([^>]+)>/.exec(i.path)?.[1], c = id ? at.get(id) : undefined;
    out.push({ type: `validation_${i.level}`, t: c ? r3(clipStart(c)) : 0, id, message: `${i.path}: ${i.message}`, hint: i.hint });
  }

  // shots on the primary storyline
  const portrait = H > W, minShot = o.minShot ?? 0.4, maxShot = o.maxShot ?? (portrait ? 6 : 12);
  const main = visual(tl).find((t) => t.magnetic);
  const shots = (main?.clips ?? []).filter((c) => c.enabled !== false && c.type !== "gap");
  for (const c of shots) {
    const d = clipDur(c);
    if (d < minShot) out.push({ type: "shot_too_short", t: r3(clipStart(c)), end: r3(clipEnd(c)), id: c.id, message: `${c.id} is on screen ${d.toFixed(2)}s (< ${minShot}s): reads as a flash frame`, hint: "lengthen it, or remove it (remove_clip)" });
    if (d > maxShot) out.push({ type: "shot_too_long", t: r3(clipStart(c)), end: r3(clipEnd(c)), id: c.id, message: `${c.id} holds ${d.toFixed(1)}s (> ${maxShot}s)`, hint: "split it (split_clip) or trim it; add motion (ken_burns) if it must stay" });
  }

  // cuts vs beats
  const { beats, from } = await timelineBeats(tl, o.beats, o.signal);
  if (beats.length >= 2 && main) {
    const tol = Math.max(1.5 / fps, 0.05);
    main.clips.slice(1).forEach((c) => {
      const t = clipStart(c);
      if (t < beats[0] - tol || t > beats[beats.length - 1] + tol) return;
      const near = beats.reduce((b, x) => (Math.abs(x - t) < Math.abs(b - t) ? x : b), beats[0]);
      if (Math.abs(near - t) > tol) out.push({ type: "cut_off_beat", t: r3(t), id: c.id, message: `cut into ${c.id} at ${t.toFixed(2)}s is ${((t - near) * 1000).toFixed(0)} ms from the beat at ${near.toFixed(2)}s`, hint: "snap_to_beats, or roll_edit the cut onto the beat" });
    });
  }

  // text: reading time + safe area (boxes measured by the renderer's own layout at a small scale)
  const cps = o.cps ?? 15;
  const r = new Renderer(structuredClone(tl), root, Math.min(1, 540 / W));
  try {
    const z = safeZones(W, H), [sx, sy, sw, sh] = z.title;
    const texts = r.layers.filter((L) => TEXTY.has(L.type));
    for (const L of texts) {
      const c = L.c;
      if (L.type === "text") {
        const chars = [...String(c.text ?? "").replace(/\s+/g, " ").trim()].length, need = Math.max(1, chars / cps);
        if (L.dur < need) out.push({ type: "text_too_short", t: r3(L.start), end: r3(L.end), id: c.id, message: `"${String(c.text).slice(0, 40)}" (${chars} chars) is on screen ${L.dur.toFixed(2)}s; needs ~${need.toFixed(1)}s at ${cps} chars/s`, hint: `update_clip ${c.id} set duration=${need.toFixed(1)} (or shorten the text)` });
      }
      for (const t of probeTimes(L)) {
        const b = await r.layoutBox(L, t);
        if (!b) continue;
        const [x, y, w, h] = b.map((v) => v / r.k);
        const where: string[] = [];
        if (x < sx - 0.5 || y < sy - 0.5 || x + w > sx + sw + 0.5 || y + h > sy + sh + 0.5) where.push("outside the title-safe area (5% inset)");
        for (const [name, ux, uy, uw, uh] of z.ui) if (x < ux + uw && x + w > ux && y < uy + uh && y + h > uy) where.push(`under the ${name}`);
        if (where.length) {
          out.push({ type: "text_unsafe", t: r3(L.start + t), id: c.id, message: `${c.id} box [${[x, y, w, h].map(Math.round).join(", ")}] is ${where.join(" and ")}`, hint: "move it toward the centre (position/margin or y: \"40%\"-\"75%\"), shrink font_size/max_width; check with preview_frame guides=true" });
          break;
        }
      }
    }
  } finally { r.close(); }

  // black frames: sample the composite at low resolution
  if (o.black !== false && T > 0) for (const f of await blackRuns(tl, root, T, fps)) out.push(f);

  out.sort((a, b) => a.t - b.t);
  const counts: Record<string, number> = {};
  for (const f of out) counts[f.type] = (counts[f.type] ?? 0) + 1;
  return { clean: !out.length, findings: out, counts, checked: { duration: r3(T), shots: shots.length, beats: beats.length ? `${beats.length} (${from})` : "none known", black_frames: o.black !== false } };
}

/** clip-local times at which a text layer's box is measured: middle (text), each caption page start */
function probeTimes(L: Layer): number[] {
  if (L.type !== "captions") return [L.dur / 2];
  return L.pages.slice(0, 40).map((pg) => Math.max(0, L.words[pg[0]].start) + 0.15).filter((t) => t < L.dur);
}

async function blackRuns(tl: Timeline, root: string, T: number, fps: number): Promise<Finding[]> {
  const step = 0.2, r = new Renderer(structuredClone(tl), root, Math.min(1, 64 / tl.settings.width));
  const dips: [number, number][] = [];
  for (const tr of visual(tl)) tr.clips.forEach((c, i) => {
    const s = i > 0 ? normAnim(c.transition, 0.5) : null;
    if (s && s.type === "dip_black") dips.push([clipStart(c), clipStart(c) + s.duration]);
  });
  const black: number[] = [];
  try {
    for (let t = 0; t < T - 1e-6; t += step) {
      const tt = Math.min(t, T - 1 / fps);
      await r.frame(tt);
      const px = r.pixels();
      let bright = 0;
      for (let i = 0; i < px.length; i += 4) if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] > 24) bright++;
      if (bright / (px.length / 4) < 0.03 && !dips.some(([a, b]) => tt >= a - 1e-6 && tt <= b + 1e-6)) black.push(tt);
    }
  } finally { r.close(); }
  const out: Finding[] = [];
  for (let i = 0; i < black.length; i++) {
    let j = i;
    while (j + 1 < black.length && black[j + 1] - black[j] < step * 1.5) j++;
    // shortcut: needs >= 2 consecutive dark samples (>= ~0.2-0.4 s); a single one is usually a fade's darkest frame
    if (j > i)
      out.push({ type: "black_frames", t: r3(black[i]), end: r3(Math.min(T, black[j] + step)), message: `the picture is black from ~${black[i].toFixed(1)}s to ~${Math.min(T, black[j] + step).toFixed(1)}s`, hint: "a gap with nothing below it, a clip past its media, or a dark source: fill it or check the clip there" });
    i = j;
  }
  return out;
}
