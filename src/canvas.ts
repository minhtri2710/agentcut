// Lazy access to the Skia binding: loading it costs ~110 ms, and most edit commands never draw anything.
import type * as Canvas from "@napi-rs/canvas";

let mod: typeof Canvas | null = null;
const pendingFontDirs: string[] = [];

export const canvasLoaded = () => mod !== null;
export function setCanvas(m: typeof Canvas) {
  if (mod) return;
  mod = m;
  for (const d of pendingFontDirs.splice(0)) m.GlobalFonts.loadFontsFromDir(d);
}
export function C(): typeof Canvas {
  if (!mod) throw new Error("internal: Skia not loaded (call loadCanvas first)");
  return mod;
}
export async function loadCanvas() {
  if (!mod) setCanvas(await import("@napi-rs/canvas"));
  return mod!;
}
export function queueFontDir(d: string) { if (mod) mod.GlobalFonts.loadFontsFromDir(d); else pendingFontDirs.push(d); }
