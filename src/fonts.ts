// Font resolution on top of Skia's system font manager (@napi-rs/canvas GlobalFonts).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { C, canvasLoaded, queueFontDir } from "./canvas.ts";
import { EditError, suggest } from "./model.ts";
import { writeFile } from "./safe-write.ts";

const WEIGHTS: Record<string, number> = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, roman: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, heavy: 800, black: 900, ultra: 900,
};
const SANS = ["Arial", "Helvetica Neue", "Helvetica", "Segoe UI", "Noto Sans", "DejaVu Sans", "Liberation Sans", "Roboto"];
const EMOJI = ["Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla"];
const DEFAULTS = ["Arial", "Helvetica Neue", "Segoe UI", "Noto Sans", "DejaVu Sans", "Liberation Sans"];

let familyMap: Map<string, string> | null = null; // lower -> canonical
let familyMapFromSkia = false;
const registered = new Set<string>();
const CACHE = join(process.env.AGENTCUT_CACHE ?? join(homedir(), ".cache", "agentcut"), "font-families.json");
const SYS_DIRS = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts", join(homedir(), "Library/Fonts"),
  "/usr/share/fonts", "/usr/local/share/fonts", join(homedir(), ".fonts"), join(homedir(), ".local/share/fonts"), "C:/Windows/Fonts"];
const sig = () => [...SYS_DIRS, ...registered].map((d) => { try { return `${d}:${statSync(d).mtimeMs}`; } catch { return ""; } }).join("|");

/** Family names. Uses Skia when it is loaded (and refreshes the cache), otherwise a cache file (no Skia load). */
function families(): Map<string, string> {
  if (familyMap && (familyMapFromSkia || !canvasLoaded())) return familyMap;
  if (canvasLoaded()) {
    familyMap = new Map();
    for (const f of C().GlobalFonts.families as any[]) familyMap.set(f.family.toLowerCase(), f.family);
    familyMapFromSkia = true;
    // 0700, not the umask default: the vision helper refuses a group-writable cache dir
    try { mkdirSync(dirname(CACHE), { recursive: true, mode: 0o700 }); writeFile(CACHE, JSON.stringify({ sig: sig(), families: [...familyMap.values()] }), dirname(CACHE)); } catch { /* cache is optional */ }
    return familyMap;
  }
  try {
    const c = JSON.parse(readFileSync(CACHE, "utf8"));
    if (c.sig === sig()) { familyMap = new Map(c.families.map((f: string) => [f.toLowerCase(), f])); return familyMap; }
  } catch { /* no cache yet */ }
  return (familyMap = new Map()); // unknown: callers treat an empty map as "cannot check"
}
export function refreshFonts() { familyMap = null; familyMapFromSkia = false; cache.clear(); }
export const fontsKnown = () => families().size > 0;

export function registerFontDir(dir: string) {
  if (registered.has(dir) || !existsSync(dir)) return;
  registered.add(dir);
  queueFontDir(dir);
  refreshFonts();
}

export interface FontSpec { family: string; weight: number; italic: boolean; stack: string[] }

const cache = new Map<string, FontSpec>();
export function resolveFont(spec: string | undefined | null, weight?: number | string, italic?: boolean): FontSpec {
  const key = `${spec}|${weight}|${italic}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const fam = families();
  let family: string | undefined, w = 400, it = !!italic, unregistered = false;
  if (!spec) {
    family = DEFAULTS.map((d) => fam.get(d.toLowerCase())).find(Boolean) ?? [...fam.values()][0];
    w = 700;
  } else if (/\.(ttf|otf|ttc|woff2?)$/i.test(spec) && existsSync(spec)) {
    // the path hash keeps two files with the same name apart
    const alias = `agentcut-${basename(spec).replace(/\W+/g, "-")}-${createHash("sha1").update(resolve(spec)).digest("hex").slice(0, 8)}`;
    if (canvasLoaded()) { if (!fam.has(alias.toLowerCase())) { C().GlobalFonts.registerFromPath(spec, alias); refreshFonts(); } } else unregistered = true;
    family = alias;
  } else {
    const words = spec.trim().split(/\s+/);
    // longest family prefix wins; remaining words are style tokens
    for (let n = words.length; n > 0 && !family; n--) {
      const f = fam.get(words.slice(0, n).join(" ").toLowerCase());
      if (!f) continue;
      const rest = words.slice(n).map((x) => x.toLowerCase().replace(/[-_]/g, ""));
      if (rest.every((r) => r in WEIGHTS || r === "italic" || r === "oblique")) {
        family = f;
        for (const r of rest) if (r in WEIGHTS) w = WEIGHTS[r]; else it = true;
      }
    }
    if (!family) {
      const s = suggest(spec, [...fam.values()]);
      throw new EditError(`font '${spec}' not found`, "font_not_found", `${s ? `did you mean '${s}'? ` : ""}list fonts with \`agentcut fonts <query>\` or pass a .ttf path`);
    }
  }
  if (weight !== undefined && weight !== null) w = typeof weight === "number" ? weight : WEIGHTS[String(weight).toLowerCase()] ?? (Number(weight) || 400);
  const stack = [family!, ...SANS.filter((s) => fam.has(s.toLowerCase()) && s !== family), ...EMOJI.filter((s) => fam.has(s.toLowerCase()))];
  const out = { family: family!, weight: w, italic: it, stack };
  if (!unregistered) cache.set(key, out); // an alias not yet registered with Skia must be resolved again once it is
  return out;
}

export function cssFont(f: FontSpec, size: number): string {
  return `${f.italic ? "italic " : ""}${f.weight} ${Math.max(1, size).toFixed(2)}px ${f.stack.map((s) => `"${s}"`).join(", ")}`;
}

// Glyph coverage: if `family` has the glyph, its width is identical whichever fallback follows.
let probeCtx: any = null;
const covCache = new Map<string, boolean>();
export function missingChars(family: string, text: string): string {
  const fam = families();
  const pair = [["Courier New", "Arial"], ["DejaVu Sans Mono", "DejaVu Sans"], ["Menlo", "Helvetica"], ["Consolas", "Segoe UI"]]
    .find(([a, b]) => fam.has(a.toLowerCase()) && fam.has(b.toLowerCase()));
  if (!pair) return "";
  if (!canvasLoaded()) return "";
  probeCtx ??= C().createCanvas(8, 8).getContext("2d");
  let miss = "";
  for (const ch of new Set([...text])) {
    if (ch.trim() === "" || ch.charCodeAt(0) < 128 && /[\x20-\x7e]/.test(ch)) continue;
    const k = `${family}|${ch}`;
    let ok = covCache.get(k);
    if (ok === undefined) {
      probeCtx.font = `400 40px "${family}", "${pair[0]}"`;
      const a = probeCtx.measureText(ch).width;
      probeCtx.font = `400 40px "${family}", "${pair[1]}"`;
      const b = probeCtx.measureText(ch).width;
      ok = Math.abs(a - b) < 0.01;
      covCache.set(k, ok);
    }
    if (!ok) miss += ch;
  }
  return miss;
}

/** Validation helper: error if the font is unknown; info naming the fallback if glyphs are missing. */
const checkMemo = new Map<string, { error?: string; hint?: string; fallback?: string }>();
/** Memoized: validation runs before and after every batch with mostly the same texts. */
export function fontCheck(font: string | undefined, text: string) {
  if (!fontsKnown()) return {};
  const key = `${font ?? ""}\u0000${text}`;
  let r = checkMemo.get(key);
  if (!r) { r = fontCheckRaw(font, text); if (checkMemo.size > 5000) checkMemo.clear(); checkMemo.set(key, r); }
  return r;
}
function fontCheckRaw(font: string | undefined, text: string): { error?: string; hint?: string; fallback?: string } {
  try {
    const f = resolveFont(font);
    const miss = missingChars(f.family, text.replace(/\p{Extended_Pictographic}/gu, ""));
    if (!miss) return {};
    const fb = f.stack.slice(1).find((s) => !missingChars(s, miss));
    return { fallback: fb ?? "system fallback" };
  } catch (e: any) {
    return { error: e.message, hint: e.hint };
  }
}

/** Pick the first candidate font that has every glyph of text (used for caption defaults). */
export function firstCovering(cands: string[], text: string): string | undefined {
  for (const c of cands) {
    try {
      const f = resolveFont(c);
      if (!missingChars(f.family, text)) return c;
    } catch { /* not installed */ }
  }
  return undefined;
}

export function listFonts(query = "", limit = 60) {
  const q = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: { name: string; family: string; weight: number; style: string }[] = [];
  for (const f of C().GlobalFonts.families as any[]) {
    for (const s of f.styles) {
      const wname = Object.entries(WEIGHTS).find(([, v]) => v === s.weight)?.[0] ?? String(s.weight);
      const name = `${f.family} ${wname[0].toUpperCase()}${wname.slice(1)}${s.style === "italic" ? " Italic" : ""}`;
      if (q.every((w) => name.toLowerCase().includes(w))) out.push({ name, family: f.family, weight: s.weight, style: s.style });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out.slice(0, limit);
}
