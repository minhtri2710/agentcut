import { num } from "./time.ts";
import type { Clip } from "./types.ts";
import { kfPoint } from "../time-parse.ts";

/** a keyframe as the page edits it: [time, value, easing into it] */
export type Kf = [number, number, string | undefined];

export const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.0005;

/** the keyframes of one prop (arrays or {t, v|value, ease} objects) as sorted [t, v, ease] */
export function pts(list: any[] | undefined): Kf[] {
  return (list || [])
    .map((k) => kfPoint(k, num))
    .sort((a, b) => a[0] - b[0]);
}

/** the distinct times that carry a key on any prop */
export function kfTimes(c: Clip): number[] {
  const r: number[] = [];
  Object.keys(c.keyframes || {}).forEach((p) => pts(c.keyframes[p]).forEach((q) => { if (!r.some((x) => near(x, q[0]))) r.push(q[0]); }));
  return r;
}

/** the set_keyframes payload for a prop (null clears it): linear easing is left out */
export function packKf(list: Kf[]): (number | string | undefined)[][] | null {
  return list.length
    ? list.slice().sort((a, b) => a[0] - b[0]).map((q) => (q[2] && q[2] !== "linear" ? [+q[0].toFixed(3), q[1], q[2]] : [+q[0].toFixed(3), q[1]]))
    : null;
}

/** the clip's own value of a prop, else the default a key starts from */
export function kfBase(c: Clip, prop: string, set: { width: number; height: number }): number {
  const d: Record<string, number> = { x: set.width / 2, y: set.height / 2, scale: 1, scale_x: 1, scale_y: 1, opacity: 1, volume: 1, speed: 1, focus_x: 0.5, focus_y: 0.5 };
  return typeof c[prop] === "number" ? c[prop] : d[prop] !== undefined ? d[prop] : 0;
}

/** value at local time lt, linear between neighbours (a starting point for the new key; the renderer applies the easing) */
export function kfAt(list: Kf[], lt: number): number {
  if (lt <= list[0][0]) return list[0][1];
  for (let i = 1; i < list.length; i++) {
    if (lt <= list[i][0]) { const a = list[i - 1], b = list[i]; return +(a[1] + (b[1] - a[1]) * (lt - a[0]) / Math.max(1e-9, b[0] - a[0])).toFixed(4); }
  }
  return list[list.length - 1][1];
}
