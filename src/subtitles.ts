// Subtitle export: captions clips -> timed cues (the same pages and timing the renderer burns in) -> .srt / .vtt,
// or a soft subtitle stream muxed into a rendered video (mov_text in MP4/MOV, SubRip in MKV, WebVTT in WebM).
import { rmSync } from "node:fs";
import { extname } from "node:path";
import { inp } from "./ffinput.ts";
import { captionPages, captionWords, pageSpans } from "./captions.ts";
import { run } from "./proc.ts";
import { EditError, isRetimed, parseTime, type Timeline, type Track, visibleSpan } from "./model.ts";
import { commit, createFile, partSibling } from "./safe-write.ts";

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
          if (isRetimed(c)) continue; // not representable as plain cues
          const a = Math.max(s, w0), b = Math.min(e, w1), cin = parseTime(c.in ?? 0);
          if (b > a) walk(c.tracks, base + a - w0, cin + (a - s), cin + (b - s));
          continue;
        }
        if (c.type !== "captions" || (ids && !ids.includes(c.id))) continue;
        const words = captionWords(c), pages = captionPages(words, Number(c.max_words ?? 3));
        pageSpans(words, pages).forEach(([ps, pe], i) => {
          const v = visibleSpan(Math.max(s + ps, s), Math.min(s + pe, e), w0, w1);
          if (!v) return;
          const [a, b] = v;
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

// WebVTT cue text is markup: & < > must be entities (this also removes any `-->`). SubRip has no escapes and its players read <tags>;
// only the cue arrow, which a strict parser reads as a timing line, is broken by an invisible word joiner (it still shows as -->).
const escapeCue = (text: string, fmt: "srt" | "vtt") =>
  fmt === "vtt" ? text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : text.replace(/-->/g, "--\u2060>");

export function formatCues(cues: Cue[], fmt: "srt" | "vtt"): string {
  const sep = fmt === "srt" ? "," : ".";
  const body = cues.map((q, i) => `${fmt === "srt" ? `${i + 1}\n` : ""}${stamp(q.start, sep)} --> ${stamp(q.end, sep)}\n${escapeCue(q.text, fmt).replace(/\n{2,}/g, "\n")}\n`).join("\n");
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

export async function embedSubtitles(video: string, cues: Cue[], base?: string, signal?: AbortSignal) {
  const ext = extname(video).toLowerCase(), codec = embedCodec(video);
  // Only SubRip is fed from an srt sidecar. ffmpeg's srt reader turns <i> into a style, and its webvtt writer does not escape, so mov_text
  // reads the vtt sidecar (its text is plain: entities decode to the literal characters) and webvtt is stream-copied (the entities stay).
  const vtt = codec !== "srt";
  // new names next to the video; nothing exists at them. The sidecar is named like the mux output (a part name of the video, so the next
  // render of it sweeps one a SIGKILL left behind), which hides its format from ffmpeg: it is named with -f.
  const sub = partSibling(video, base), tmp = partSibling(video, base);
  createFile(sub, formatCues(cues, vtt ? "vtt" : "srt"));
  try {
    const r = await run("ffmpeg", ["-v", "error", "-y", "-nostdin", ...inp(video), "-f", vtt ? "webvtt" : "srt", ...inp(sub), "-map", "0", "-map", "1", "-c", "copy", ...(codec === "webvtt" ? [] : ["-c:s", codec]),
      ...(ext === ".mp4" ? ["-movflags", "+faststart"] : []), tmp], { signal });
    if (r.status !== 0) throw new EditError(`subtitle mux failed: ${r.stderr.slice(-600)}`, "encode_failed");
    commit(tmp, video);
  } finally {
    rmSync(sub, { force: true });
    rmSync(tmp, { force: true });
  }
}
