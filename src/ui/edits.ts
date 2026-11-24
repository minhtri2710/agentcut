import { near, packKf, pts } from "./keyframes.ts";
import { dur, num, start } from "./time.ts";
import type { Clip, Dict, Op, Track } from "./types.ts";

export type DragMode = "move" | "l" | "r";

/** The ops a clip drag turns into on release: move (other lane = other track; magnetic = new index) or trim an edge.
 *  dt is the dragged time; s0 and d0 are the clip's start and duration when the drag began; dest is the lane the pointer ended on. */
export function dragEdit(mode: DragMode, c: Clip, tr: Track, tracks: Track[], dest: string, dt: number, s0: number, d0: number): { ops: Op[]; label: string } {
  if (mode === "l") return { ops: [{ op: "trim_clip", id: c.id, trim_start: dt }], label: "trim_clip " + c.id };
  if (mode === "r") return { ops: [{ op: "trim_clip", id: c.id, duration: +Math.max(0.04, d0 + dt).toFixed(3) }], label: "trim_clip " + c.id };
  const dtr = tracks.filter((x) => x.id === dest)[0] || tr;
  const op: Op = { op: "move_clip", id: c.id };
  if (dest !== tr.id) op.track = dest;
  if (c.attach_to) { // a connected clip's start follows its parent: dragging changes its offset
    const batch: Op[] = [{ op: "update_clip", id: c.id, set: { offset: +(num(c.offset || 0) + dt).toFixed(3) } }];
    if (op.track) batch.unshift(op);
    return { ops: batch, label: "move " + c.id };
  }
  if (dtr.magnetic) {
    const at = s0 + dt;
    let idx = 0;
    dtr.clips.forEach((o) => { if (o.id !== c.id && start(o) + dur(o) / 2 < at + d0 / 2) idx++; });
    op.index = idx;
  } else op.at = +Math.max(0, s0 + dt).toFixed(3);
  return { ops: [op], label: "move_clip " + c.id };
}

/** A clip (its fields: an asset, or a text with a preset) dropped on a lane at time `at`: one add_clip. A magnetic track takes it at the index the drop point falls in (before every clip whose middle is later), any other track at that time. */
export function dropEdit(tr: Track, fields: Dict, at: number): Op {
  if (!tr.magnetic) return { op: "add_clip", track: tr.id, ...fields, at: +Math.max(0, at).toFixed(3) };
  return { op: "add_clip", track: tr.id, ...fields, index: tr.clips.filter((o) => start(o) + dur(o) / 2 < at).length };
}

/** A library item (library.ts LIBRARY) put on clip c, or on nothing selected (null): an effect goes on the clip or the whole video, a look becomes a picture's grade base,
 *  a transition leads into the clip, a text or caption preset restyles a clip of that type. null: the item does not go there. */
export function libEdit(kind: string, name: string, c: Clip | null): Op | null {
  if (kind === "effect") return c ? { op: "add_effect", id: c.id, type: name } : { op: "add_effect", type: name };
  if (!c) return null;
  if (kind === "look") return c.type === "video" || c.type === "image" ? { op: "update_clip", id: c.id, set: { color: { look: name } } } : null;
  if (kind === "transition") return { op: "add_transition", to: c.id, type: name };
  return c.type === (kind === "text" ? "text" : "captions") ? { op: "update_clip", id: c.id, set: { preset: name } } : null;
}

/** dragging a keyframe tick by `delta` seconds moves every prop's point at time kt: one set_keyframes per prop that has one there */
export function kfMoveBatch(c: Clip, kt: number, delta: number): Op[] {
  const nt = +Math.max(0, Math.min(dur(c), kt + delta)).toFixed(3), batch: Op[] = [];
  Object.keys(c.keyframes).forEach((p) => {
    let list = pts(c.keyframes[p]);
    if (!list.some((q) => near(q[0], kt))) return;
    list = list.filter((q) => !near(q[0], nt)).map((q) => (near(q[0], kt) ? [nt, q[1], q[2]] as typeof q : q));
    batch.push({ op: "set_keyframes", id: c.id, prop: p, keyframes: packKf(list) });
  });
  return batch;
}

/** The update_clip `set` for an inspector edit: what differs from the text the box was filled with.
 *  update_clip merges dicts (keyframes replace), so a key removed inside one is sent as null. n counts the changed keys. */
export function clipPatch(was: Dict, now: Dict): { set: Dict; n: number } {
  const set: Dict = {};
  let n = 0;
  const isO = (v: any) => v && typeof v === "object" && !Array.isArray(v);
  const gone = (a: Dict, b: Dict): Dict => {
    const o = JSON.parse(JSON.stringify(b));
    Object.keys(a).forEach((k) => { if (!(k in b)) o[k] = null; else if (isO(a[k]) && isO(b[k])) o[k] = gone(a[k], b[k]); });
    return o;
  };
  Object.keys(now).forEach((k) => {
    if (k !== "id" && JSON.stringify(now[k]) !== JSON.stringify(was[k])) { set[k] = k !== "keyframes" && isO(was[k]) && isO(now[k]) ? gone(was[k], now[k]) : now[k]; n++; }
  });
  Object.keys(was).forEach((k) => { if (!(k in now)) { set[k] = null; n++; } });
  return { set, n };
}

/** The group ids to offer "Regroup" for: expand_compound stamps what it places with group.id, make_compound from=<id> takes it back.
 *  Not offered when the id is taken by a clip, nested ones included (the server would answer "exists"). */
export function regroupIds(tracks: Track[]): string[] {
  const used = new Set<string>();
  (function ids(ts: Track[]) { ts.forEach((tr) => tr.clips.forEach((c) => { used.add(c.id); if (c.type === "compound") ids(c.tracks || []); })); })(tracks);
  const seen = new Set<string>(), out: string[] = [];
  tracks.forEach((tr) => tr.clips.forEach((c) => {
    const g = c.group && c.group.id;
    if (!g || seen.has(g) || used.has(g)) return;
    seen.add(g); out.push(g);
  }));
  return out;
}

/** What a form input holds, as the field's json types read it: empty removes the field (null), "true"/"false" is a boolean where one is allowed,
 *  a numeric text a number where numbers are allowed, else the text where strings are; anything else throws bad_value. */
export function fieldValue(types: string[], raw: string): unknown {
  const s = raw.trim();
  if (s === "") return null;
  if (types.includes("boolean") && (s === "true" || s === "false")) return s === "true";
  if (types.includes("number") && !Number.isNaN(Number(s))) return Number(s);
  if (types.includes("string")) return s;
  throw { code: "bad_value", message: `expected ${types.join(" or ")}, got ${JSON.stringify(s)}` };
}

/** a transcript word on the timeline: its media times mapped through clip c (start + (media - in) / speed), and whether c plays it */
export type TlWord = { text: string; t0: number; t1: number; on: boolean };
export function clipWords(c: Clip, words: { text: string; start: number; end: number }[]): TlWord[] {
  const s = start(c), d = dur(c), cin = num(c.in || 0), sp = Number(c.speed || 1) || 1;
  return words.map((w) => {
    const t0 = s + (w.start - cin) / sp, t1 = s + (w.end - cin) / sp;
    return { text: w.text, t0, t1, on: t1 > s + 1e-3 && t0 < s + d - 1e-3 };
  });
}

/** cutting words i..j (in either order) out of clip c: one remove_range of their span, kept inside the clip */
export function cutWords(c: Clip, ws: TlWord[], i: number, j: number): Op {
  const a = Math.min(i, j), b = Math.max(i, j), s = start(c), e = s + dur(c);
  return { op: "remove_range", id: c.id, start: +Math.max(s, ws[a].t0).toFixed(3), end: +Math.min(e, ws[b].t1).toFixed(3) };
}
