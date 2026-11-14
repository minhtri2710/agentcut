import type { ApiError, Job } from "./types.ts";

/** an error as the message box shows it: [code] message, the hint, one line per issue */
export function errText(e: ApiError | string): string {
  const x = e as ApiError;
  let s = (x.code ? "[" + x.code + "] " : "") + (x.message || e) + (x.hint ? "\nhint: " + x.hint : "");
  (x.issues || []).forEach((i) => { s += "\n- " + i.path + ": " + i.message + (i.hint ? " (" + i.hint + ")" : ""); });
  return s;
}

/** the viewer's state line when a frame request failed */
export const frameFailText = (e: ApiError | undefined): string => (e && e.message ? e.message + (e.hint ? " (" + e.hint + ")" : "") : "frame failed");

/** whole MB, rounded as the matte sizes are; a model under 1 MB (the face model) shows two decimals so it never reads 0/0 */
export const mbOf = (b: number, total: number): string => (total < 1e6 ? (b / 1e6).toFixed(2) : String(Math.round(b / 1e6)));

/** the Prepare button's text while its job runs */
export function prepareText(j: Job): string {
  return j.download
    ? "Downloading " + j.download.model + " " + mbOf(j.download.bytes, j.download.total_bytes) + "/" + mbOf(j.download.total_bytes, j.download.total_bytes) + " MB"
    : "Preparing " + Math.round(j.progress * 100) + "%";
}

/** the preview scale asked of the server: the viewer box over the project size, at the device pixel ratio, in quarter steps from 0.25 to 1 */
export function frameScale(boxW: number, boxH: number, w: number, h: number, dpr: number): number {
  return Math.max(0.25, Math.min(1, Math.ceil(4 * Math.min(boxW / w, boxH / h) * (dpr || 1)) / 4));
}
