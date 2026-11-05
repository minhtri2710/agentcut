"""Fonts and text rendering (Pillow). Word-level layout so captions can highlight words."""
from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .model import EditError, parse_color, suggest

FONT_DIRS = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts",
             str(Path.home() / "Library/Fonts"), "/usr/share/fonts", "/usr/local/share/fonts",
             str(Path.home() / ".fonts"), "C:/Windows/Fonts"]
DEFAULT_FONTS = ["Arial Bold", "Helvetica Neue Bold", "DejaVu Sans Bold", "Liberation Sans Bold", "Arial"]
CACHE = Path(os.environ.get("AGENTCUT_CACHE", Path.home() / ".cache" / "agentcut"))


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()


class FontIndex:
    def __init__(self, extra_dirs=()):
        self.extra_dirs = [str(d) for d in extra_dirs]
        self._faces: list[dict] | None = None

    @property
    def faces(self) -> list[dict]:
        if self._faces is None:
            self._faces = self._scan()
        return self._faces

    def _scan(self) -> list[dict]:
        dirs = [d for d in FONT_DIRS + self.extra_dirs if os.path.isdir(d)]
        cache_file = CACHE / "fonts.json"
        sig = {d: os.path.getmtime(d) for d in dirs}
        try:
            data = json.loads(cache_file.read_text())
            if data.get("sig") == sig:
                return data["faces"]
        except Exception:
            pass
        faces = []
        for d in dirs:
            for root, _, files in os.walk(d):
                for fn in files:
                    if not fn.lower().endswith((".ttf", ".otf", ".ttc")):
                        continue
                    p = os.path.join(root, fn)
                    for idx in range(32 if fn.lower().endswith(".ttc") else 1):
                        try:
                            f = ImageFont.truetype(p, 12, index=idx)
                        except Exception:
                            break
                        fam, style = f.getname()
                        faces.append({"family": fam, "style": style or "Regular", "path": p, "index": idx,
                                      "name": f"{fam} {style}".strip()})
        try:
            CACHE.mkdir(parents=True, exist_ok=True)
            cache_file.write_text(json.dumps({"sig": sig, "faces": faces}))
        except Exception:
            pass
        return faces

    def search(self, query: str = "", limit: int = 50) -> list[dict]:
        q = _norm(query)
        res = [f for f in self.faces if not q or all(w in _norm(f["name"]) for w in q.split())]
        seen, out = set(), []
        for f in sorted(res, key=lambda f: (f["family"], f["style"])):
            if f["name"] not in seen:
                seen.add(f["name"])
                out.append(f)
        return out[:limit]

    @lru_cache(maxsize=256)
    def resolve(self, spec: str | None) -> tuple[str, int]:
        """'Arial Bold' | 'Arial' | '/path/font.ttf' -> (path, index)."""
        if not spec:
            for d in DEFAULT_FONTS:
                try:
                    return self.resolve(d)
                except EditError:
                    continue
            if self.faces:
                return self.faces[0]["path"], self.faces[0]["index"]
            raise EditError("no fonts found on this system", "no_fonts", hint="pass a .ttf path in 'font'")
        if os.path.exists(spec):
            return spec, 0
        q = _norm(spec)
        exact = [f for f in self.faces if _norm(f["name"]) == q]
        if not exact:
            exact = [f for f in self.faces if _norm(f["family"]) == q and _norm(f["style"]) in ("regular", "roman", "normal", "")]
        if not exact:
            exact = [f for f in self.faces if _norm(f["family"]) == q]
        if not exact:
            words = q.split()
            exact = sorted([f for f in self.faces if all(w in _norm(f["name"]) for w in words)], key=lambda f: len(f["name"]))
        if exact:
            return exact[0]["path"], exact[0]["index"]
        s = suggest(spec, sorted({f["name"] for f in self.faces}))
        raise EditError(f"font '{spec}' not found", "font_not_found",
                        hint=(f"did you mean '{s}'? " if s else "") + "list fonts with `agentcut fonts <query>` or pass a .ttf path")


FONTS = FontIndex()


@lru_cache(maxsize=128)
def load_font(path: str, index: int, size: int):
    return ImageFont.truetype(path, max(4, int(size)), index=index)


@lru_cache(maxsize=64)
def _notdef(path: str, index: int):
    f = load_font(path, index, 32)
    return [bytes(f.getmask(ch)) for ch in ("\uFFFF", "\U0010FFFD")]


@lru_cache(maxsize=4096)
def _has_glyph(path: str, index: int, ch: str) -> bool:
    if ch.isspace() or ord(ch) < 128:
        return True
    f = load_font(path, index, 32)
    m = bytes(f.getmask(ch))
    return m not in _notdef(path, index)


def missing_glyphs(path: str, index: int, text: str) -> str:
    return "".join(sorted({ch for ch in text if not _has_glyph(path, index, ch)}))


FALLBACK_BOLD = ["Arial Bold", "Helvetica Neue Bold", "Arial Unicode MS", "DejaVu Sans Bold", "Noto Sans Bold",
                 "Segoe UI Bold", "Arial", "Noto Sans", "DejaVu Sans"]
FALLBACK_REGULAR = ["Arial", "Helvetica Neue", "Arial Unicode MS", "Noto Sans", "DejaVu Sans", "Segoe UI"]


def font_for_text(fonts: "FontIndex", spec: str | None, text: str) -> tuple[str, int, str | None]:
    """Resolve a font; if it lacks glyphs used in text (e.g. Vietnamese diacritics), fall back to one that has them."""
    path, idx = fonts.resolve(spec)
    if not missing_glyphs(path, idx, text):
        return path, idx, None
    bold = any(w in (spec or "bold").lower() for w in ("bold", "black", "heavy", "semibold"))
    for cand in (FALLBACK_BOLD if bold else FALLBACK_REGULAR):
        try:
            p2, i2 = fonts.resolve(cand)
        except EditError:
            continue
        if not missing_glyphs(p2, i2, text):
            return p2, i2, cand
    return path, idx, None


def _rgba(c):
    return tuple(parse_color(c))


class TextStyle:
    def __init__(self, clip: dict, k: float, base_min_dim: float, fonts: FontIndex = FONTS, sample_text: str = ""):
        self.k = k
        self.font_path, self.font_index, self.fallback = font_for_text(fonts, clip.get("font"), sample_text)
        self.size = float(clip.get("font_size", round(0.065 * base_min_dim))) * k
        self.color = _rgba(clip.get("color", "white"))
        st = clip.get("stroke") or {}
        self.stroke_w = int(round(float(st.get("width", 0)) * k)) if st else 0
        self.stroke_c = _rgba(st.get("color", "black")) if st else None
        bg = clip.get("background")
        if isinstance(bg, str):
            bg = {"color": bg}
        self.bg = bg
        sh = clip.get("shadow")
        if sh is True:
            sh = {}
        self.shadow = None if not sh and sh != {} else {
            "color": _rgba(sh.get("color", "#000000aa")), "x": float(sh.get("x", 0)) * k,
            "y": float(sh.get("y", 4)) * k, "blur": float(sh.get("blur", 10)) * k}
        self.align = clip.get("align", "center")
        self.line_height = float(clip.get("line_height", 1.15))
        self.letter_spacing = float(clip.get("letter_spacing", 0)) * k
        self.uppercase = bool(clip.get("uppercase", False))
        self.font = load_font(self.font_path, self.font_index, round(self.size))


def layout(text: str, style: TextStyle, max_width: float):
    """Return lines: [{words:[{text, x, w}], w}] plus total size. Words keep their index."""
    font = style.font
    space = font.getlength(" ") + style.letter_spacing
    lines, idx = [], 0

    def wlen(w):
        return font.getlength(w) + style.letter_spacing * max(0, len(w) - 1)

    for para in text.split("\n"):
        cur, cur_w = [], 0.0
        for word in para.split(" "):
            if word == "":
                continue
            ww = wlen(word)
            if cur and cur_w + space + ww > max_width:
                lines.append({"words": cur, "w": cur_w})
                cur, cur_w = [], 0.0
            x = cur_w + (space if cur else 0)
            cur.append({"text": word, "x": x, "w": ww, "i": idx})
            idx += 1
            cur_w = x + ww
        lines.append({"words": cur, "w": cur_w})
    asc, desc = font.getmetrics()
    lh = (asc + desc) * style.line_height
    width = max([l["w"] for l in lines] + [1])
    return lines, width, lh, asc + desc


def render_text(text: str, style: TextStyle, max_width: float, *, visible_chars: int | None = None,
                visible_words: int | None = None, active_word: int | None = None,
                highlight_color=None, highlight_bg=None, word_alpha: dict | None = None) -> np.ndarray:
    """Render text to an RGBA uint8 array (tight box incl. padding/stroke/shadow)."""
    if style.uppercase:
        text = text.upper()
    lines, width, lh, glyph_h = layout(text, style, max_width)
    pad = style.stroke_w + 2
    bg = style.bg
    bpad = float(bg.get("padding", 0.35 * style.size)) * (style.k if "padding" in (bg or {}) else 1) if bg else 0
    sh = style.shadow
    spad = int(abs(sh["x"]) + abs(sh["y"]) + sh["blur"] * 2) if sh else 0
    margin = int(pad + bpad + spad)
    W = int(width + 2 * margin + 2)
    H = int(lh * (len(lines) - 1) + glyph_h + 2 * margin + 2)
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    txt = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(txt)
    if bg:
        bd = ImageDraw.Draw(img)
        r = float(bg.get("radius", 0.2 * style.size)) * (style.k if "radius" in bg else 1)
        bd.rounded_rectangle([margin - bpad, margin - bpad, margin + width + bpad, margin + lh * (len(lines) - 1) + glyph_h + bpad],
                             radius=r, fill=_rgba(bg.get("color", "#000000aa")))
    hl_c = _rgba(highlight_color) if highlight_color else None
    hl_bg = _rgba(highlight_bg) if highlight_bg else None
    chars_left = visible_chars
    for li, line in enumerate(lines):
        if style.align == "left":
            ox = margin
        elif style.align == "right":
            ox = margin + width - line["w"]
        else:
            ox = margin + (width - line["w"]) / 2
        oy = margin + li * lh
        for w in line["words"]:
            if visible_words is not None and w["i"] >= visible_words:
                continue
            s = w["text"]
            if chars_left is not None:
                if chars_left <= 0:
                    break
                s = s[:chars_left]
                chars_left -= len(w["text"]) + 1
            color = style.color
            if word_alpha and w["i"] in word_alpha:
                color = color[:3] + (int(color[3] * word_alpha[w["i"]]),)
            if active_word is not None and w["i"] == active_word:
                if hl_bg:
                    p = 0.12 * style.size
                    d.rounded_rectangle([ox + w["x"] - p * 1.5, oy - p * 0.6, ox + w["x"] + w["w"] + p * 1.5, oy + glyph_h + p * 0.6],
                                        radius=0.25 * style.size, fill=hl_bg)
                if hl_c:
                    color = hl_c
            x = ox + w["x"]
            if style.letter_spacing:
                for ch in s:
                    d.text((x, oy), ch, font=style.font, fill=color, stroke_width=style.stroke_w, stroke_fill=style.stroke_c)
                    x += style.font.getlength(ch) + style.letter_spacing
            else:
                d.text((x, oy), s, font=style.font, fill=color, stroke_width=style.stroke_w, stroke_fill=style.stroke_c)
    if sh:
        a = txt.split()[3]
        shadow = Image.new("RGBA", (W, H), sh["color"])
        shadow.putalpha(a.point(lambda v: v * sh["color"][3] // 255))
        shadow = shadow.transform((W, H), Image.AFFINE, (1, 0, -sh["x"], 0, 1, -sh["y"]))
        if sh["blur"] > 0:
            shadow = shadow.filter(ImageFilter.GaussianBlur(sh["blur"] / 2))
        img = Image.alpha_composite(img, shadow)
    img = Image.alpha_composite(img, txt)
    return np.asarray(img)


# ------------------------------------------------------------------ captions
def parse_srt(path: str) -> list[dict]:
    """SRT/VTT -> [{text, start, end}] phrases."""
    raw = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    blocks = re.split(r"\n\s*\n", raw.replace("\r", ""))
    ts = re.compile(r"(\d+:)?(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+:)?(\d+):(\d+)[,.](\d+)")

    def sec(h, m, s, ms):
        return int((h or "0:")[:-1] or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / (10 ** len(ms))
    out = []
    for b in blocks:
        lines = [l for l in b.strip().split("\n") if l.strip()]
        for i, l in enumerate(lines):
            m = ts.search(l)
            if m:
                g = m.groups()
                text = " ".join(lines[i + 1:])
                text = re.sub(r"<[^>]+>", "", text).strip()
                if text:
                    out.append({"text": text, "start": sec(*g[:4]), "end": sec(*g[4:])})
                break
    return out


def phrases_to_words(phrases: list[dict]) -> list[dict]:
    """Spread phrase timing over words proportionally to their length."""
    words = []
    for ph in phrases:
        toks = ph["text"].split()
        if not toks:
            continue
        total = sum(len(t) + 1 for t in toks)
        t = ph["start"]
        span = ph["end"] - ph["start"]
        for tok in toks:
            d = span * (len(tok) + 1) / total
            words.append({"text": tok, "start": round(t, 3), "end": round(t + d, 3)})
            t += d
    return words


def caption_words(clip: dict) -> list[dict]:
    if clip.get("words"):
        ws = []
        for w in clip["words"]:
            ws.append({"text": str(w.get("text", w.get("word", w.get("w", "")))).strip(),
                       "start": float(w.get("start", w.get("s", 0))), "end": float(w.get("end", w.get("e", 0)))})
        return [w for w in ws if w["text"]]
    if clip.get("srt"):
        return phrases_to_words(parse_srt(clip["srt"]))
    return []


def caption_pages(words: list[dict], max_words: int = 3, max_gap: float = 0.6) -> list[list[int]]:
    pages, cur = [], []
    for i, w in enumerate(words):
        brk = cur and (len(cur) >= max_words or w["start"] - words[cur[-1]]["end"] > max_gap
                       or words[cur[-1]]["text"][-1:] in ".!?,;:")
        if brk:
            pages.append(cur)
            cur = []
        cur.append(i)
    if cur:
        pages.append(cur)
    return pages
