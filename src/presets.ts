// Style presets (text + captions) and whole-video templates. Templates expand into ordinary ops, so the
// result is a normal timeline the agent can keep editing.
import { firstCovering } from "./fonts.ts";
import { type Dict, EditError, parseLen, suggest } from "./model.ts";
import { own } from "./own.ts";
import { edgesOf, safeMargin, safeWidth, safeZones } from "./safe.ts";

const heavy = (text = "AÁÀẢÃẠ") => firstCovering(["Arial Black", "Helvetica Neue Condensed Black", "Avenir Next Heavy", "Arial Bold", "Helvetica Neue Bold", "DejaVu Sans Bold"], text);
const bold = (text = "AÁ") => firstCovering(["Arial Bold", "Helvetica Neue Bold", "Segoe UI Bold", "Noto Sans Bold", "DejaVu Sans Bold"], text);

export const TEXT_PRESETS: Record<string, { doc: string; make: (text: string) => Dict }> = {
  title_bold: { doc: "huge white uppercase title, black outline, pop in", make: (t) => ({ font: heavy(t.toUpperCase()), font_size: 118, color: "white", stroke: { color: "black", width: 10 }, uppercase: true, enter: "pop", exit: "fade" }) },
  subtitle_box: { doc: "dark text on a yellow rounded box, slides up", make: (t) => ({ font: bold(t), font_size: 64, color: "#111111", background: { color: "#FFD60A", padding: 26, radius: 22 }, enter: "slide_up", exit: "fade" }) },
  neon: { doc: "white text with a cyan neon glow", make: (t) => ({ font: bold(t), font_size: 96, color: "#ffffff", glow: { color: "#00E5FF", blur: 32 }, enter: "fade", exit: "fade" }) },
  gradient: { doc: "pink-purple-blue gradient fill, zooms in", make: (t) => ({ font: heavy(t), font_size: 112, gradient: { colors: ["#FF3CAC", "#784BA0", "#2B86C5"], angle: 90 }, shadow: { color: "#00000088", y: 6, blur: 16 }, enter: "zoom_in", exit: "fade" }) },
  lower_third: { doc: "name/label bottom-left on a translucent bar", make: (t) => ({ font: bold(t), font_size: 54, color: "white", align: "left", position: "bottom_left", margin: "8%", background: { color: "#000000b0", padding: 22, radius: 10 }, enter: "slide_right", exit: "fade" }) },
  quote: { doc: "italic quote, words appear one by one", make: (t) => ({ font: bold(t), italic: true, font_size: 76, color: "white", shadow: true, enter: "words", exit: "fade", line_height: 1.25 }) },
  typewriter: { doc: "green monospace typewriter", make: () => ({ font: firstCovering(["Courier New Bold", "Menlo Bold", "DejaVu Sans Mono Bold", "Consolas Bold"], "Aa"), font_size: 70, color: "#00FF88", enter: "typewriter", align: "left" }) },
  sticker: { doc: "black text on a white tilted pill, bounces in", make: (t) => ({ font: heavy(t), font_size: 84, color: "#111111", background: { color: "#ffffff", padding: 30, radius: 60 }, rotation: -6, shadow: { color: "#00000066", y: 10, blur: 24 }, enter: "bounce", exit: "pop" }) },
  outline: { doc: "hollow outline text", make: (t) => ({ font: heavy(t), font_size: 120, color: "#00000000", stroke: { color: "white", width: 4 }, uppercase: true, enter: "fade" }) },
  cinematic: { doc: "spaced-out thin caps, slow fade", make: (t) => ({ font: firstCovering(["Helvetica Neue Light", "Avenir Next Ultra Light", "Arial"], t), font_size: 64, color: "#f5f5f5", uppercase: true, letter_spacing: 14, enter: { type: "fade", duration: 1 }, exit: { type: "fade", duration: 1 } }) },
};

export const CAPTION_PRESETS: Record<string, { doc: string; make: (text: string) => Dict }> = {
  tiktok: { doc: "uppercase heavy words, black outline, yellow active word (karaoke)", make: (t) => ({ font: heavy(t.toUpperCase()), uppercase: true, font_size: 84, stroke: { color: "#000000", width: 7 }, style: "karaoke", highlight_color: "#FFD60A", max_words: 3 }) },
  bold_pop: { doc: "one big word at a time, pops", make: (t) => ({ font: heavy(t.toUpperCase()), uppercase: true, font_size: 120, stroke: { color: "#000000", width: 9 }, style: "word", highlight_color: "#FFD60A" }) },
  pill: { doc: "active word on a purple pill", make: (t) => ({ font: bold(t), font_size: 70, color: "white", stroke: { color: "#000000", width: 4 }, style: "karaoke", highlight_bg: "#7C3AED", highlight_color: "#ffffff", max_words: 4 }) },
  clean: { doc: "sentence-case subtitles on a dark box", make: (t) => ({ font: bold(t), font_size: 54, color: "white", background: { color: "#000000a0", padding: 16, radius: 12 }, style: "line", max_words: 7 }) },
  reveal: { doc: "words appear as they are spoken", make: (t) => ({ font: heavy(t), font_size: 78, color: "white", stroke: { color: "#000", width: 6 }, style: "reveal", max_words: 5 }) },
  neon: { doc: "glowing cyan karaoke", make: (t) => ({ font: bold(t), font_size: 76, color: "#ffffff", glow: { color: "#00E5FF", blur: 26 }, style: "karaoke", highlight_color: "#00E5FF", max_words: 3 }) },
};

export function expandPreset(kind: "text" | "captions", name: string, text: string, given: Dict): Dict {
  const table = kind === "captions" ? CAPTION_PRESETS : TEXT_PRESETS;
  const p = own(table, name);
  if (!p) {
    const s = suggest(name, Object.keys(table));
    throw new EditError(`unknown ${kind} preset '${name}'`, "bad_preset", `${s ? `did you mean '${s}'? ` : ""}presets: ${Object.keys(table).join(", ")}`);
  }
  const base = p.make(text);
  if (!base.font) delete base.font;
  return { ...base, ...given }; // explicit fields win
}

// ------------------------------------------------------------------ templates
type Media = string | Dict;
const src = (m: Media) => (typeof m === "string" ? { src: m } : m);

type Size = { width: number; height: number };
type Template = { doc: string; args: Dict; build: (a: Dict, size: Size) => Dict[] };
/** Placement fields for text set in `preset`: its own position, with a margin that keeps the box inside the safe area of a W x H canvas (never less than the preset's own margin).
 * A preset with no position stays where it is, centred, except on a canvas with UI zones, where a wide centred box would cover the side buttons: it goes to the top.
 * Text anchored on the left also gets the widest `max_width` that ends before the side zones; the box ring (stroke + background padding) is counted, a shadow or glow is not. */
function placed(preset: string, text: string, W: number, H: number): Dict {
  const base = own(TEXT_PRESETS, preset)?.make(text) ?? {}, mn = Math.min(W, H);
  const position: string | undefined = base.position ?? (safeZones(W, H).ui.length ? "top" : undefined);
  if (!position) return {};
  const margin = safeMargin(W, H, edgesOf(position), (parseLen(base.margin, mn, 0.06 * mn) / mn) * 100);
  const left = edgesOf(position).includes("left") ? parseLen(margin.split(" ")[0], mn) : undefined;
  return { position, margin, ...(left === undefined ? {} : { max_width: safeWidth(W, H, left, 2 * (2 + Number(base.stroke?.width ?? 0) + Number(base.background?.padding ?? 0)) + 2) }) };
}

/** `build` reads only the args the template declares: its `a` is typed from them, so another key is a compile error (apply_template refuses it at run time). `size` is the project's width and height: text placed against an edge takes its margin from the safe area. */
const tpl = <A extends Dict>(t: { doc: string; args: A; build: (a: { [K in keyof A]?: any }, size: Size) => Dict[] }): Template => t;

export const TEMPLATES: Record<string, Template> = {
  slideshow: tpl({
    doc: "photos/clips with Ken Burns + crossfades, optional title and music (cuts snap to beats)",
    args: { media: "list of paths/clip specs (required)", title: "text", music: "path", seconds: "per item (2.5)", transition: "crossfade", title_preset: "text preset for the title (title_bold)", every: "beats per cut (4)" },
    build: (a, { width, height }) => {
      const ops: Dict[] = [{ op: "add_sequence", track: "main", items: a.media.map(src), defaults: { duration: a.seconds ?? 2.5, transition: { type: a.transition ?? "crossfade", duration: 0.5 }, motion: "ken_burns", fit: "blur" } }];
      if (a.title) ops.push({ op: "add_clip", track: "text", text: a.title, attach_to: "main#0", offset: 0.3, match_duration: true, end_offset: 0.2, preset: a.title_preset ?? "title_bold", ...placed(a.title_preset ?? "title_bold", String(a.title), width, height) });
      if (a.music) ops.push({ op: "add_clip", track: "music", src: a.music, fade_out: 1.5, until_end: true }, { op: "snap_to_beats", track: "main", beats: a.music, every: a.every ?? 4 });
      return ops;
    },
  }),
  promo: tpl({
    doc: "product promo: hook title, one proof point per clip, CTA end card, beat-synced",
    args: { media: "clips/photos (required)", hook: "opening line", points: "list of short lines", cta: "end card text", music: "path", brand_color: "#FFD60A", seconds: "per clip (2)", every: "beats per cut (2)" },
    build: (a, { width, height }) => {
      const n = a.media.length, seg = a.seconds ?? 2;
      const ops: Dict[] = [{ op: "add_sequence", track: "main", items: a.media.map(src), defaults: { duration: seg, transition: { type: "zoom", duration: 0.3 }, fit: "cover" } }];
      if (a.hook) ops.push({ op: "add_clip", track: "text", text: a.hook, attach_to: "main#0", offset: 0.15, match_duration: true, end_offset: 0.1, preset: "title_bold", position: "top", margin: safeMargin(width, height, ["top"], 16) });
      (a.points || []).slice(0, Math.max(0, n - 1)).forEach((p: string, i: number) =>
        ops.push({ op: "add_clip", track: "text", text: p, attach_to: `main#${i + 1}`, offset: 0.25, match_duration: true, end_offset: 0.1, preset: "subtitle_box", y: "64%", ...(a.brand_color ? { background: { color: a.brand_color, padding: 26, radius: 22 } } : {}) }));
      if (a.cta) ops.push({ op: "add_clip", track: "main", type: "color", gradient: { colors: [a.brand_color ?? "#111111", "#000000"], angle: 160 }, duration: 2.5, transition: "flash" },
        { op: "add_clip", track: "text", text: a.cta, attach_to: "main#-1", offset: 0.3, match_duration: true, preset: "sticker" });
      if (a.music) ops.push({ op: "add_clip", track: "music", src: a.music, fade_out: 1, until_end: true }, { op: "snap_to_beats", track: "main", beats: a.music, every: a.every ?? 2 });
      return ops;
    },
  }),
  beat_montage: tpl({
    doc: "fast montage: a cut on every N beats, flash/glitch transitions, shake on drops",
    args: { media: "clips/photos (required)", music: "path (required)", every: "beats per cut (1)", title: "optional" },
    build: (a) => {
      if (!a.music) throw new EditError("beat_montage needs music", "missing_arg");
      const trs = ["flash", "glitch", "zoom_blur", "push_left", "spin"];
      const items = a.media.map((m: Media, i: number) => ({ ...src(m), ...(i ? { transition: { type: trs[i % trs.length], duration: 0.2 } } : {}), effects: i % 3 === 2 ? [{ type: "rgb_split", amount: 8 }] : undefined }));
      const ops: Dict[] = [{ op: "add_sequence", track: "main", items, defaults: { duration: 1, fit: "cover", motion: "zoom_slow" } },
        { op: "add_clip", track: "music", src: a.music, until_end: true, fade_out: 0.8 },
        { op: "snap_to_beats", track: "main", beats: a.music, every: a.every ?? 1 }];
      if (a.title) ops.push({ op: "add_clip", track: "text", text: a.title, attach_to: "main#0", offset: 0.1, match_duration: true, preset: "gradient" });
      return ops;
    },
  }),
  quote: tpl({
    doc: "single quote card over a background clip/photo or gradient",
    args: { text: "quote (required)", author: "attribution", background: "path (optional)", seconds: "6", music: "path" },
    build: (a) => {
      if (typeof a.text !== "string" || !a.text.trim()) throw new EditError("quote needs text", "missing_arg", "pass text: the quote");
      const d = a.seconds ?? 6;
      const ops: Dict[] = [a.background ? { op: "add_clip", track: "main", src: a.background, duration: d, motion: "zoom_slow", color: { look: "moody" }, effects: [{ type: "vignette", intensity: 0.6 }] }
        : { op: "add_clip", track: "main", type: "color", gradient: { colors: ["#0f2027", "#203a43", "#2c5364"], angle: 135 }, duration: d }];
      ops.push({ op: "add_clip", track: "text", text: `“${a.text}”`, at: 0.4, duration: d - 0.6, preset: "quote", max_width: "80%" });
      if (a.author) ops.push({ op: "add_clip", track: "text", text: `— ${a.author}`, at: 1.6, duration: d - 1.8, font_size: 44, color: "#ffffffcc", y: "72%", enter: "fade" });
      if (a.music) ops.push({ op: "add_clip", track: "music", src: a.music, duration: d, fade_in: 0.5, fade_out: 1.2 });
      return ops;
    },
  }),
  listicle: tpl({
    doc: "numbered list: title card, then one clip per item with a numbered label",
    args: { title: "headline (required)", items: "[{text, media}] (required)", seconds: "per item (3)", music: "path" },
    build: (a, { width, height }) => {
      const s = a.seconds ?? 3;
      const ops: Dict[] = [{ op: "add_clip", track: "main", type: "color", gradient: { colors: ["#111827", "#1f2937"], angle: 180 }, duration: 2.2 },
        { op: "add_clip", track: "text", text: a.title, attach_to: "main#0", offset: 0.2, match_duration: true, preset: "title_bold" }];
      (a.items || []).forEach((it: Dict, i: number) => {
        const label = `${i + 1}. ${it.text}`;
        ops.push({ op: "add_clip", track: "main", ...src(it.media), duration: s, transition: { type: "slide_left", duration: 0.35 }, fit: "blur" });
        ops.push({ op: "add_clip", track: "text", text: label, attach_to: `main#${i + 1}`, offset: 0.4, match_duration: true, end_offset: 0.1, preset: "lower_third", ...placed("lower_third", label, width, height) });
      });
      if (a.music) ops.push({ op: "add_clip", track: "music", src: a.music, until_end: true, fade_out: 1 });
      return ops;
    },
  }),
};
