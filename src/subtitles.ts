// Subtitle export: captions clips -> timed cues (the same pages and timing the renderer burns in) -> .srt / .vtt,
// or a soft subtitle stream muxed into a rendered video (mov_text in MP4/MOV, SubRip in MKV, WebVTT in WebM).
import { spawnSync } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { inp } from "./ffinput.ts";
import { captionPages, captionWords, pageSpans } from "./captions.ts";
import { EditError, parseTime, type Timeline, type Track } from "./model.ts";

export interface Cue { start: number; end: number; text: string; clip: string }
export const SUB_FORMATS: Record<string, "srt" | "vtt"> = { ".srt": "srt", ".vtt": "vtt" };
const EMBED: Record<string, string> = { ".mp4": "mov_text", ".m4v": "mov_text", ".mov": "mov_text", ".mkv": "srt", ".webm": "webvtt" };

/** Cues in timeline seconds, sorted. Hidden/muted-by-visibility tracks and disabled clips are skipped; compounds map to parent time. */
export function captionCues(tl: Timeline, ids?: string[]): Cue[] {
  const out: Cue[] = [];
  const walk = (tracks: Track[], base: number, w0: number, w1: number) => {
    for (const t of tracks) {
      if (t.hidden) continue;
      for (const c of t.clips) {
        if (c.enabled === false) continue;
        const s = parseTime(c.start ?? 0), e = s + parseTime(c.duration);
        if (c.type === "compound" && Array.isArray(c.tracks)) {
          if (Math.abs((Number(c.speed ?? 1) || 1) - 1) > 1e-6) continue; // retimed compounds: not representable as plain cues
          const a = Math.max(s, w0), b = Math.min(e, w1), cin = parseTime(c.in ?? 0);
          if (b > a) walk(c.tracks, base + a - w0, cin + (a - s), cin + (b - s));
          continue;
        }
        if (c.type !== "captions" || (ids && !ids.includes(c.id))) continue;
        const words = captionWords(c), pages = captionPages(words, Number(c.max_words ?? 3));
        pageSpans(words, pages).forEach(([ps, pe], i) => {
          const a = Math.max(s + ps, s, w0), b = Math.min(s + pe, e, w1);
          if (b - a < 1e-3) return;
          let text = pages[i].map((wi) => words[wi].text).join(" ");
          if (c.uppercase) text = text.toUpperCase();
          out.push({ start: base + a - w0, end: base + b - w0, text, clip: c.id });
        });
      }
    }
  };
  walk(tl.tracks, 0, 0, Infinity);
  return out.sort((x, y) => x.start - y.start || x.end - y.end);
}

function stamp(sec: number, sep: string) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}${sep}${p(ms % 1000, 3)}`;
}

export function formatCues(cues: Cue[], fmt: "srt" | "vtt"): string {
  const sep = fmt === "srt" ? "," : ".";
  const body = cues.map((q, i) => `${fmt === "srt" ? `${i + 1}\n` : ""}${stamp(q.start, sep)} --> ${stamp(q.end, sep)}\n${q.text.replace(/\n{2,}/g, "\n")}\n`).join("\n");
  return fmt === "vtt" ? `WEBVTT\n\n${body}` : body;
}

/** Cues for a rendered range [t0, t1): clipped and shifted so 0 is the first rendered frame. */
export const cuesInRange = (cues: Cue[], t0: number, t1: number): Cue[] =>
  cues.filter((q) => q.end > t0 + 1e-3 && q.start < t1 - 1e-3).map((q) => ({ ...q, start: Math.max(q.start, t0) - t0, end: Math.min(q.end, t1) - t0 }));

/** Remux `video` in place with a soft subtitle track (streams are copied, not re-encoded). */
export function embedCodec(video: string): string {
  const ext = extname(video).toLowerCase(), codec = EMBED[ext];
  if (!codec) throw new EditError(`cannot embed subtitles in ${ext || "this output"}`, "bad_format", `subtitles=true works with ${Object.keys(EMBED).join(" ")}; for other outputs use export_captions (.srt/.vtt)`);
  return codec;
}

export function embedSubtitles(video: string, cues: Cue[]) {
  const ext = extname(video).toLowerCase(), codec = embedCodec(video);
  const vtt = codec === "webvtt";
  const sub = `${video}.subs.${vtt ? "vtt" : "srt"}`, tmp = `${video}.subs${ext}`;
  writeFileSync(sub, formatCues(cues, vtt ? "vtt" : "srt"));
  try {
    const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-nostdin", ...inp(video), ...inp(sub), "-map", "0", "-map", "1", "-c", "copy", "-c:s", codec,
      ...(ext === ".mp4" ? ["-movflags", "+faststart"] : []), tmp], { encoding: "utf8" });
    if (r.status !== 0) throw new EditError(`subtitle mux failed: ${(r.stderr || "").slice(-600)}`, "encode_failed");
    renameSync(tmp, video);
  } finally {
    rmSync(sub, { force: true });
    rmSync(tmp, { force: true });
  }
}
