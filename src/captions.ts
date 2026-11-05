// Caption sources: word timings, SRT/VTT parsing, paging. Pure (no Skia).
import { readFileSync } from "node:fs";
import type { Dict } from "./model.ts";

// ------------------------------------------------------------------ captions
export interface CWord { text: string; start: number; end: number }

export function parseSrt(path: string): CWord[] {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "").replace(/\r/g, "");
  const ts = /(\d+:)?(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+:)?(\d+):(\d+)[,.](\d+)/;
  const sec = (h: string | undefined, m: string, s: string, ms: string) => (h ? parseInt(h) : 0) * 3600 + +m * 60 + +s + +ms / 10 ** ms.length;
  const out: CWord[] = [];
  for (const b of raw.split(/\n\s*\n/)) {
    const lines = b.trim().split("\n").filter((l) => l.trim());
    const i = lines.findIndex((l) => ts.test(l));
    if (i < 0) continue;
    const g = ts.exec(lines[i])!;
    const text = lines.slice(i + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (text) out.push({ text, start: sec(g[1], g[2], g[3], g[4]), end: sec(g[5], g[6], g[7], g[8]) });
  }
  return out;
}

export function phrasesToWords(phrases: CWord[]): CWord[] {
  const words: CWord[] = [];
  for (const ph of phrases) {
    const toks = ph.text.split(/\s+/).filter(Boolean);
    const total = toks.reduce((a, t) => a + t.length + 1, 0);
    let t = ph.start;
    for (const tok of toks) {
      const d = ((ph.end - ph.start) * (tok.length + 1)) / total;
      words.push({ text: tok, start: +t.toFixed(3), end: +(t + d).toFixed(3) });
      t += d;
    }
  }
  return words;
}

export function captionWords(c: Dict): CWord[] {
  if (c.words?.length)
    return c.words.map((w: any) => ({ text: String(w.text ?? w.word ?? w.w ?? "").trim(), start: Number(w.start ?? w.s ?? 0), end: Number(w.end ?? w.e ?? 0) }))
      .filter((w: CWord) => w.text);
  if (c.srt) return phrasesToWords(parseSrt(c.srt));
  return [];
}

export function captionPages(words: CWord[], maxWords = 3, maxGap = 0.6): number[][] {
  const pages: number[][] = [];
  let cur: number[] = [];
  words.forEach((w, i) => {
    const last = cur.length ? words[cur[cur.length - 1]] : null;
    if (last && (cur.length >= maxWords || w.start - last.end > maxGap || /[.!?,;:]$/.test(last.text))) { pages.push(cur); cur = []; }
    cur.push(i);
  });
  if (cur.length) pages.push(cur);
  return pages;
}


/** [start, end] (clip-local seconds) each page is on screen: until the next page starts, at most 0.6 s past its last word (0.3 s for the last page). */
export function pageSpans(words: CWord[], pages: number[][]): [number, number][] {
  return pages.map((pg, pi) => {
    const s = words[pg[0]].start, e = words[pg[pg.length - 1]].end;
    const nxt = pi + 1 < pages.length ? words[pages[pi + 1][0]].start : null;
    return [s, Math.max(e, nxt !== null ? Math.min(nxt, e + 0.6) : e + 0.3)];
  });
}
