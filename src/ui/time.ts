import type { Clip } from "./types.ts";

/** seconds from a number, "500ms", "1.5s", "1:02" or a bare numeric string */
export function num(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v).trim();
  let m: RegExpExecArray | null;
  if ((m = /^(-?[\d.]+)ms$/.exec(s))) return +m[1] / 1000;
  if ((m = /^(-?[\d.]+)s$/.exec(s))) return +m[1];
  if (s.indexOf(":") >= 0) return s.split(":").reduce((a, x) => a * 60 + +x, 0);
  return +s;
}
export const start = (c: Clip): number => num(c.start || 0);
export const dur = (c: Clip): number => num(c.duration || 0);
