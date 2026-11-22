import type { Clip } from "./types.ts";
import { timeValue } from "../time-parse.ts";

/** seconds from a number, "500ms", "1.5s", "1:02" or a bare numeric string */
export const num = timeValue;
export const start = (c: Clip): number => num(c.start || 0);
export const dur = (c: Clip): number => num(c.duration || 0);
