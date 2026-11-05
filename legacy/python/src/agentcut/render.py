"""Frame compositor, audio mixer and encoder.

Video/image sources are decoded + fitted by FFmpeg, then composited in NumPy/OpenCV with
full keyframe control. Audio is mixed by one FFmpeg filter graph. Output is encoded by FFmpeg.
"""
from __future__ import annotations

import math
import os
import subprocess
import sys
import tempfile
import time
from collections import OrderedDict
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw

from . import anim
from .media import FrameSource
from .model import (EditError, VISUAL_TYPES, norm_anim, parse_color, parse_len, parse_time, resolve,
                    total_duration)
from .text import FONTS, TextStyle, caption_pages, caption_words, render_text


def _even(v: float) -> int:
    v = int(round(v))
    return v + (v % 2)


class _LRU(OrderedDict):
    def __init__(self, n=24):
        super().__init__()
        self.n = n

    def get_or(self, key, fn):
        if key in self:
            self.move_to_end(key)
            return self[key]
        v = fn()
        self[key] = v
        if len(self) > self.n:
            self.popitem(last=False)
        return v


# ---------------------------------------------------------------- per-clip renderer
class ClipLayer:
    def __init__(self, r: "Renderer", track: dict, ti: int, ci: int, c: dict):
        self.r, self.track, self.ti, self.ci, self.c = r, track, ti, ci, c
        self.type = c["type"]
        self.start = parse_time(c.get("start", 0))
        self.dur = parse_time(c.get("duration", 0))
        self.end = self.start + self.dur
        self.src: FrameSource | None = None
        self.cache = _LRU(32)
        self.prev: ClipLayer | None = None
        self.next: ClipLayer | None = None
        self.q = 1.0  # source oversampling for zoom-ins
        self.opaque = False  # every pixel alpha=255 -> fast paths
        k = r.k
        if self.type in ("video", "image"):
            a = r.tl["assets"][c["asset"]]
            box = c.get("size")
            bw = parse_len(box[0], r.W0) * k if box else r.W
            bh = parse_len(box[1], r.H0) * k if box else r.H
            kfs = (c.get("keyframes") or {}).get("scale")
            mx = float(c.get("scale", 1)) * (max(float(anim._kf(x)[1]) for x in kfs) if kfs else 1)
            if c.get("motion"):
                mx *= 1.15
            self.q = min(2.0, max(1.0, mx))
            self.box = (bw, bh)
            self.asset = a
            keyed = any((f.get("type") if isinstance(f, dict) else f) == "chromakey" for f in c.get("filters") or [])
            self.opaque = not a.get("alpha") and not keyed and c.get("fit", "cover") in ("cover", "fill")
        if self.type == "captions":
            self.words = caption_words(c)
            self.pages = caption_pages(self.words, int(c.get("max_words", 3)))
            if not c.get("duration") and self.words:
                self.dur = self.words[-1]["end"] + 0.3
                self.end = self.start + self.dur

    # -------------------------------------------------------------- sources
    def _media_source(self):
        if self.src is None:
            c, a, r = self.c, self.asset, self.r
            self.src = FrameSource(r.path(a["path"]), kind=a["kind"], src_w=a["width"], src_h=a["height"],
                                   fps=r.fps, src_in=parse_time(c.get("in", 0)), speed=float(c.get("speed", 1) or 1),
                                   fit=c.get("fit", "cover"), box=(self.box[0] * self.q, self.box[1] * self.q),
                                   focus=c.get("focus") or (0.5, 0.5), crop=c.get("crop"), filters=c.get("filters"),
                                   loop=bool(c.get("loop")), src_duration=a.get("duration"))
        return self.src

    def _text_style(self):
        c = self.c
        sample = c.get("text") or " ".join(w["text"] for w in getattr(self, "words", []))
        if c.get("uppercase"):
            sample = sample.upper()
        return self.cache.get_or("__style", lambda: TextStyle(c, self.r.k, min(self.r.W0, self.r.H0), self.r.fonts, sample))

    def layer(self, tl: float, m: anim.Mods) -> np.ndarray | None:
        c, r = self.c, self.r
        if self.type in ("video", "image"):
            idx = int(round(tl * r.fps))
            return self._media_source().read(idx)
        if self.type == "text":
            st = self._text_style()
            text = str(c.get("text", ""))
            mw = parse_len(c.get("max_width", "88%"), r.W0) * r.k
            nchars = len(text.upper() if st.uppercase else text)
            vis_c = None if m.chars is None else int(math.floor(m.chars * nchars + 1e-6))
            nwords = len(text.split())
            vis_w = None if m.words is None else int(math.ceil(m.words * nwords - 1e-6))
            return self.cache.get_or(("t", vis_c, vis_w), lambda: render_text(text, st, mw, visible_chars=vis_c, visible_words=vis_w))
        if self.type == "captions":
            return self._caption_layer(tl, m)
        if self.type == "shape":
            return self.cache.get_or("shape", self._shape)
        if self.type == "color":
            self.opaque = parse_color(c.get("color", "black"))[3] == 255 if not c.get("gradient") else all(
                parse_color(x)[3] == 255 for x in c["gradient"].get("colors", []))
            return self.cache.get_or("color", self._color)
        return None

    def _caption_layer(self, tl, m):
        c, r = self.c, self.r
        words, pages = self.words, self.pages
        if not words:
            return None
        cur = None
        for pi, pg in enumerate(pages):
            s = words[pg[0]]["start"]
            nxt = words[pages[pi + 1][0]]["start"] if pi + 1 < len(pages) else None
            e = words[pg[-1]]["end"]
            hold_end = min(nxt, e + 0.6) if nxt is not None else e + 0.3
            if s <= tl < max(e, hold_end):
                cur = pi
                break
        if cur is None:
            return None
        pg = pages[cur]
        active = None
        for j, wi in enumerate(pg):
            if words[wi]["start"] <= tl:
                active = j
        style = c.get("style", "karaoke")
        st = self._text_style()
        mw = parse_len(c.get("max_width", "84%"), r.W0) * r.k
        page_start = words[pg[0]]["start"]
        if style == "word":
            j = active if active is not None else 0
            w = words[pg[j]]
            since = tl - w["start"]
            if since < 0.12:
                m.scale *= 0.8 + 0.2 * anim.ease("back_out", since / 0.12)
            return self.cache.get_or(("w", cur, j), lambda: render_text(w["text"], st, mw, highlight_color=c.get("highlight_color"),
                                                                         active_word=0 if c.get("highlight_color") else None))
        if tl - page_start < 0.1:
            m.scale *= 0.92 + 0.08 * anim.ease("ease_out", (tl - page_start) / 0.1)
        text = " ".join(words[i]["text"] for i in pg)
        if style == "reveal":
            vis = (active or 0) + 1
            return self.cache.get_or(("r", cur, vis), lambda: render_text(text, st, mw, visible_words=vis))
        if style == "line":
            return self.cache.get_or(("l", cur), lambda: render_text(text, st, mw))
        hc = c.get("highlight_color", "#FFD60A")
        hb = c.get("highlight_bg")
        return self.cache.get_or(("k", cur, active), lambda: render_text(text, st, mw, active_word=active,
                                                                         highlight_color=hc, highlight_bg=hb))

    def _shape(self):
        c, r, k = self.c, self.r, self.r.k
        size = c.get("size") or [200, 200]
        w, h = max(1, round(parse_len(size[0], r.W0) * k)), max(1, round(parse_len(size[1], r.H0) * k))
        st = c.get("stroke") or {}
        sw = int(round(float(st.get("width", 0)) * k)) if st else 0
        img = Image.new("RGBA", (w + 2 * sw, h + 2 * sw), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        fill = parse_color(c.get("fill", c.get("color", "white")))
        box = [sw, sw, sw + w - 1, sw + h - 1]
        kw = dict(fill=fill, outline=parse_color(st.get("color", "black")) if sw else None, width=sw)
        if c.get("shape", "rect") in ("circle", "ellipse"):
            d.ellipse(box, **kw)
        else:
            d.rounded_rectangle(box, radius=float(c.get("radius", 0)) * k, **kw)
        return np.asarray(img)

    def _color(self):
        c, r, k = self.c, self.r, self.r.k
        size = c.get("size")
        w = round(parse_len(size[0], r.W0) * k) if size else r.W
        h = round(parse_len(size[1], r.H0) * k) if size else r.H
        g = c.get("gradient")
        if g:
            cols = [np.array(parse_color(x), np.float32) for x in g.get("colors", ["#000", "#fff"])]
            ang = math.radians(float(g.get("angle", 90)))
            yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
            dx, dy = math.sin(ang), -math.cos(ang)
            proj = (xx - w / 2) * dx + (yy - h / 2) * dy
            span = abs(w / 2 * dx) + abs(h / 2 * dy) + 1e-6
            u = np.clip((proj / span + 1) / 2, 0, 1) * (len(cols) - 1)
            i0 = np.clip(np.floor(u).astype(int), 0, len(cols) - 2) if len(cols) > 1 else np.zeros_like(u, int)
            f = (u - i0)[..., None]
            stack = np.stack(cols)
            out = stack[i0] * (1 - f) + stack[np.minimum(i0 + 1, len(cols) - 1)] * f
            return out.astype(np.uint8)
        col = parse_color(c.get("color", "black"))
        arr = np.empty((h, w, 4), np.uint8)
        arr[:] = col
        return arr

    def close(self):
        if self.src:
            self.src.close()
            self.src = None


# ---------------------------------------------------------------- compositor
class Renderer:
    def __init__(self, tl: dict, root: str | Path = ".", scale: float = 1.0, fonts=FONTS):
        self.tl = resolve(tl)
        self.root = Path(root)
        st = tl["settings"]
        self.W0, self.H0 = int(st["width"]), int(st["height"])
        self.k = float(scale)
        self.W, self.H = _even(self.W0 * self.k), _even(self.H0 * self.k)
        self.k = self.W / self.W0
        self.fps = float(st["fps"])
        self.bg = np.array(parse_color(st.get("background", "#000000"))[:3], np.uint8)
        self.fonts = fonts
        self.duration = total_duration(tl)
        self.layers: list[ClipLayer] = []
        self._masks = {}
        for ti, tr in enumerate(tl["tracks"]):
            if tr.get("hidden") or tr.get("kind", "video") == "audio":
                continue
            prev = None
            for ci, c in enumerate(tr.get("clips", [])):
                if c.get("enabled", True) is False:
                    prev = None
                    continue
                if c.get("type") not in VISUAL_TYPES and c.get("type") != "gap":
                    continue
                L = ClipLayer(self, tr, ti, ci, c)
                if c.get("type") == "gap":
                    prev = None
                    continue
                if prev is not None:
                    L.prev, prev.next = prev, L
                self.layers.append(L)
                prev = L

    def path(self, p: str) -> str:
        pp = Path(p)
        return str(pp if pp.is_absolute() else self.root / pp)

    def close(self):
        for L in self.layers:
            L.close()

    # -------------------------------------------------------------- props
    def _base_center(self, c, lw, lh):
        W0, H0, k = self.W0, self.H0, self.k
        pos = c.get("position")
        mn = min(W0, H0)
        mg = parse_len(c.get("margin"), mn, 0.06 * mn if pos else 0) * k
        W, H = self.W, self.H
        cx, cy = W / 2, H / 2
        if c.get("type") == "captions" and not pos and "y" not in c:
            cy = H * (0.70 if H > W else 0.84)
        if pos:
            if "top" in pos:
                cy = mg + lh / 2
            if "bottom" in pos:
                cy = H - mg - lh / 2
            if "left" in pos:
                cx = mg + lw / 2
            if "right" in pos:
                cx = W - mg - lw / 2
        if "x" in c:
            cx = parse_len(c["x"], W0) * k
        if "y" in c:
            cy = parse_len(c["y"], H0) * k
        return cx, cy

    def _transition(self, L: ClipLayer):
        spec = norm_anim(L.c.get("transition"), 0.5)
        if not spec or L.prev is None:
            return None
        d = min(spec["duration"], L.dur, L.prev.dur)
        if d <= 0 or L.prev.end < L.start + d - 1e-6:
            # no overlap: degrade to a plain entrance over the clip's first d seconds
            pass
        return spec["type"], d, spec.get("ease") or "ease_in_out"

    def frame(self, t: float, guides: bool = False) -> np.ndarray:
        canvas = np.empty((self.H, self.W, 3), np.uint8)
        canvas[:] = self.bg
        W, H = self.W, self.H
        for L in self.layers:
            if not (L.start - 1e-9 <= t < L.end - 1e-9):
                if t > L.end + 1.0:
                    L.close()
                continue
            c = L.c
            tl = t - L.start
            m = anim.Mods()
            kf = c.get("keyframes") or {}
            props = {p: (anim.keyframe_value(kf[p], tl) if p in kf else None) for p in
                     ("x", "y", "scale", "scale_x", "scale_y", "rotation", "opacity", "blur")}
            anim.motion_mods(c, tl, L.dur, m, W, H)
            anim.enter_exit(c, tl, L.dur, m, W, H)
            overlay = None
            tr = self._transition(L)
            if tr and tl < tr[1]:
                p = anim.ease(tr[2], tl / tr[1])
                overlay = anim.transition_mods(tr[0], p, m, None, W, H)
            if L.next is not None:
                trn = self._transition(L.next)
                if trn and L.next.start - 1e-9 <= t < L.next.start + trn[1]:
                    p = anim.ease(trn[2], (t - L.next.start) / trn[1])
                    anim.transition_mods(trn[0], p, anim.Mods(), m, W, H)
            layer = L.layer(tl, m)
            if layer is None or m.opacity <= 0.001:
                if overlay:
                    self._overlay(canvas, overlay)
                continue
            opacity = float(props["opacity"] if props["opacity"] is not None else c.get("opacity", 1)) * m.opacity
            base_scale = float(props["scale"] if props["scale"] is not None else c.get("scale", 1))
            sx = base_scale * float(props["scale_x"] if props["scale_x"] is not None else c.get("scale_x", 1))
            sy = base_scale * float(props["scale_y"] if props["scale_y"] is not None else c.get("scale_y", 1))
            q = L.q
            lh, lw = layer.shape[:2]
            cx, cy = self._base_center(c, lw * sx / q, lh * sy / q)
            if props["x"] is not None:
                cx = props["x"] * self.k
            if props["y"] is not None:
                cy = props["y"] * self.k
            cx += m.dx
            cy += m.dy
            rot = float(props["rotation"] if props["rotation"] is not None else c.get("rotation", 0)) + m.rotation
            blur = float(props["blur"] or 0) * self.k + m.blur
            if c.get("radius") and L.type in ("video", "image"):
                layer = self._round(layer, float(c["radius"]) * self.k * q)
            if c.get("shadow") and L.type in ("video", "image", "shape"):
                layer = self._shadow(layer, c["shadow"], q)
            opaque = L.opaque and not c.get("radius") and not c.get("shadow")
            self._draw(canvas, layer, cx, cy, sx * m.scale / q, sy * m.scale / q, rot, opacity,
                       c.get("blend", "normal"), blur / max(1e-6, sx * m.scale / q), m.masks, opaque)
            if overlay:
                self._overlay(canvas, overlay)
        out = canvas
        if guides:
            self._guides(out)
        return out

    def _overlay(self, canvas, ov):
        col, a = ov
        if a <= 0.001:
            return
        solid = np.empty_like(canvas)
        solid[:] = col
        cv2.addWeighted(canvas, 1 - a, solid, a, 0, dst=canvas)

    def _round(self, layer, r):
        h, w = layer.shape[:2]
        key = ("round", w, h, round(r))
        mask = self._masks.get(key)
        if mask is None:
            img = Image.new("L", (w, h), 0)
            ImageDraw.Draw(img).rounded_rectangle([0, 0, w - 1, h - 1], radius=r, fill=255)
            mask = self._masks[key] = np.asarray(img)
        out = layer.copy()
        out[..., 3] = (out[..., 3].astype(np.uint16) * mask // 255).astype(np.uint8)
        return out

    def _shadow(self, layer, spec, q):
        spec = {} if spec is True else spec
        k = self.k * q
        col = parse_color(spec.get("color", "#00000099"))
        ox, oy, bl = float(spec.get("x", 0)) * k, float(spec.get("y", 12)) * k, float(spec.get("blur", 30)) * k
        pad = int(abs(ox) + abs(oy) + bl * 2) + 2
        h, w = layer.shape[:2]
        out = np.zeros((h + 2 * pad, w + 2 * pad, 4), np.float32)
        a = np.zeros((h + 2 * pad, w + 2 * pad), np.float32)
        y0, x0 = pad + int(round(oy)), pad + int(round(ox))
        a[y0:y0 + h, x0:x0 + w] = layer[..., 3]
        if bl > 0:
            a = cv2.GaussianBlur(a, (0, 0), bl / 2)
        a *= col[3] / 255
        out[..., :3] = col[:3]
        out[..., 3] = a
        la = layer[..., 3:4].astype(np.float32) / 255
        reg = out[pad:pad + h, pad:pad + w]
        reg[..., :3] = layer[..., :3] * la + reg[..., :3] * (1 - la)
        reg[..., 3] = layer[..., 3] + reg[..., 3] * (1 - la[..., 0])
        return np.clip(out, 0, 255).astype(np.uint8)

    def _draw(self, canvas, layer, cx, cy, sx, sy, rot, opacity, blend, blur, masks, opaque=False):
        H, W = canvas.shape[:2]
        lh, lw = layer.shape[:2]
        if abs(sx) < 1e-4 or abs(sy) < 1e-4:
            return
        if blur > 0.5:
            layer = cv2.GaussianBlur(layer, (0, 0), blur / 2)
        a = math.radians(rot)
        ca, sa = math.cos(a), math.sin(a)
        # layer px -> canvas: translate(-lw/2,-lh/2), scale, rotate, translate(cx,cy)
        M = np.array([[ca * sx, -sa * sy, 0], [sa * sx, ca * sy, 0]], np.float64)
        M[:, 2] = [cx, cy] - M[:, :2] @ [lw / 2, lh / 2]
        corners = np.array([[0, 0, 1], [lw, 0, 1], [0, lh, 1], [lw, lh, 1]], np.float64) @ M.T
        x0, y0 = np.floor(corners.min(0)).astype(int)
        x1, y1 = np.ceil(corners.max(0)).astype(int)
        simple = abs(rot) < 1e-3 and abs(sx - 1) < 1e-3 and abs(sy - 1) < 1e-3
        if simple:
            ox, oy = int(round(cx - lw / 2)), int(round(cy - lh / 2))
            x0, y0, x1, y1 = ox, oy, ox + lw, oy + lh
        lx0, ly0, lx1, ly1 = x0, y0, x1, y1  # unclipped layer bbox (for masks)
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        if x1 <= x0 or y1 <= y0:
            return
        bw, bh = x1 - x0, y1 - y0
        dst = canvas[y0:y1, x0:x1]
        full = opacity >= 0.999 and not masks and blend == "normal"
        if simple:
            src8 = layer[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
            if opaque and full:
                dst[:] = src8[..., :3]
                return
            rgb = src8[..., :3]
            alpha = src8[..., 3].astype(np.float32) * (opacity / 255.0)
        else:
            Mi = M.copy()
            Mi[:, 2] -= [x0, y0]
            interp = cv2.INTER_AREA if max(sx, sy) < 0.7 else cv2.INTER_LINEAR
            if opaque:  # no premultiply needed: colour is valid everywhere
                src = cv2.warpAffine(layer, Mi, (bw, bh), flags=interp, borderMode=cv2.BORDER_REPLICATE)
                al = cv2.warpAffine(np.full(layer.shape[:2], 255, np.uint8), Mi, (bw, bh), flags=interp,
                                    borderMode=cv2.BORDER_CONSTANT, borderValue=0)
                rgb = src[..., :3]
                alpha = al.astype(np.float32) * (opacity / 255.0)
            else:
                lf = layer.astype(np.float32)
                lf[..., :3] *= lf[..., 3:4] * (1 / 255.0)  # premultiply
                src = cv2.warpAffine(lf, Mi, (bw, bh), flags=interp, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
                al = src[..., 3]
                rgb = np.clip(src[..., :3] * (255.0 / np.maximum(al, 1e-3))[..., None], 0, 255).astype(np.uint8)
                alpha = al * (opacity / 255.0)
        if masks:
            yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
            for mk in masks:
                alpha = alpha * self._mask(mk, xx, yy, lx0, ly0, lx1, ly1)
        rgb = np.ascontiguousarray(rgb)
        d = np.ascontiguousarray(dst)
        if blend != "normal":
            rgb = np.clip(_blend(blend, rgb.astype(np.float32), d.astype(np.float32)), 0, 255).astype(np.uint8)
        alpha = np.ascontiguousarray(alpha, dtype=np.float32)
        dst[:] = cv2.blendLinear(rgb, d, alpha, 1.0 - alpha)

    @staticmethod
    def _mask(mk, xx, yy, x0, y0, x1, y1):
        w, h = max(1, x1 - x0), max(1, y1 - y0)
        if mk[0] == "wipe":
            d, p = mk[1], mk[2]
            f = 0.03
            if d == "left":
                u = (x1 - xx) / w
            elif d == "right":
                u = (xx - x0) / w
            elif d == "up":
                u = (y1 - yy) / h
            else:
                u = (yy - y0) / h
            return np.clip((p * (1 + f) - u) / f, 0, 1)
        if mk[0] == "circle":
            p = mk[1]
            r = p * math.hypot(w, h) / 2
            dist = np.sqrt((xx - (x0 + w / 2)) ** 2 + (yy - (y0 + h / 2)) ** 2)
            fe = 0.02 * max(w, h)
            return np.clip((r - dist) / fe + 0.5, 0, 1)
        return 1.0

    def _guides(self, img):
        H, W = img.shape[:2]
        ov = img.copy()
        if H > W:  # vertical social UI zones
            cv2.rectangle(ov, (0, 0), (W, int(H * 0.10)), (255, 0, 80), -1)
            cv2.rectangle(ov, (0, int(H * 0.80)), (W, H), (255, 0, 80), -1)
            cv2.rectangle(ov, (int(W * 0.86), int(H * 0.45)), (W, int(H * 0.80)), (255, 0, 80), -1)
        cv2.addWeighted(ov, 0.25, img, 0.75, 0, img)
        cv2.rectangle(img, (int(W * 0.05), int(H * 0.05)), (int(W * 0.95), int(H * 0.95)), (0, 255, 255), max(1, W // 600))


def _blend(mode, s, d):
    if mode == "multiply":
        return s * d / 255.0
    if mode == "screen":
        return 255.0 - (255.0 - s) * (255.0 - d) / 255.0
    if mode == "add":
        return np.minimum(255.0, s + d)
    if mode == "overlay":
        return np.where(d < 128, 2 * s * d / 255.0, 255.0 - 2 * (255.0 - s) * (255.0 - d) / 255.0)
    if mode == "darken":
        return np.minimum(s, d)
    if mode == "lighten":
        return np.maximum(s, d)
    return s


# ---------------------------------------------------------------- audio
def _atempo(speed: float) -> list[str]:
    out, s = [], speed
    while s > 2.0:
        out.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        out.append("atempo=0.5")
        s /= 0.5
    if abs(s - 1) > 1e-4:
        out.append(f"atempo={s:.5f}")
    return out


def _kf_expr(kfs, var="t") -> str:
    pts = sorted((anim._kf(k)[:2] for k in kfs), key=lambda x: x[0])
    expr = f"{pts[-1][1]}"
    for (t0, v0), (t1, v1) in reversed(list(zip(pts, pts[1:]))):
        expr = f"if(lt({var},{t1}),{v0}+({v1}-{v0})*({var}-{t0})/{max(1e-6, t1 - t0)},{expr})"
    return f"if(lt({var},{pts[0][0]}),{pts[0][1]},{expr})"


def audio_sources(tl: dict) -> list[dict]:
    out = []
    for tr in tl["tracks"]:
        if tr.get("muted"):
            continue
        for c in tr.get("clips", []):
            if c.get("enabled", True) is False or c.get("muted") or c.get("type") not in ("video", "audio"):
                continue
            a = tl["assets"].get(c.get("asset"))
            if not a or not a.get("has_audio") and a.get("kind") != "audio":
                continue
            vol = float(c.get("volume", 1)) * float(tr.get("volume", 1))
            if vol <= 0:
                continue
            out.append({"track": tr, "clip": c, "asset": a, "volume": vol})
    return out


def build_audio(tl: dict, root: Path, out_wav: str, t0: float = 0.0, t1: float | None = None) -> str:
    resolve(tl)
    T = total_duration(tl)
    t1 = T if t1 is None else t1
    sr = int(tl["settings"].get("sample_rate", 48000))
    srcs = audio_sources(tl)
    voice = []
    for tr in tl["tracks"]:
        if tr.get("role") in ("voice", "dialogue") and not tr.get("muted"):
            for c in tr.get("clips", []):
                if c.get("enabled", True) is not False and c.get("type") in ("audio", "video"):
                    s = parse_time(c.get("start", 0))
                    voice.append([s, s + parse_time(c["duration"])])
    voice.sort()
    merged = []
    for s, e in voice:
        if merged and s - merged[-1][1] < 0.5:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    args = ["ffmpeg", "-v", "error", "-y", "-nostdin"]
    graph, labels = [], []
    for i, s in enumerate(srcs):
        c, a = s["clip"], s["asset"]
        if c.get("loop"):
            args += ["-stream_loop", "-1"]
        p = Path(a["path"])
        args += ["-i", str(p if p.is_absolute() else root / p)]
        speed = float(c.get("speed", 1) or 1)
        cin = parse_time(c.get("in", 0))
        dur = parse_time(c["duration"])
        start = parse_time(c.get("start", 0))
        ch = [f"atrim=start={cin}:duration={dur * speed}", "asetpts=PTS-STARTPTS"] + _atempo(speed)
        ch += [f"aresample={sr}", "aformat=sample_fmts=fltp:channel_layouts=stereo", f"volume={s['volume']:.4f}"]
        kf = (c.get("keyframes") or {}).get("volume")
        if kf:
            ch.append(f"volume='{_kf_expr(kf)}':eval=frame")
        if c.get("fade_in"):
            ch.append(f"afade=t=in:st=0:d={float(c['fade_in'])}")
        if c.get("fade_out"):
            ch.append(f"afade=t=out:st={max(0, dur - float(c['fade_out']))}:d={float(c['fade_out'])}")
        ch.append(f"adelay={int(round(start * 1000))}:all=1")
        duck = s["track"].get("duck")
        if duck and merged and s["track"].get("role") not in ("voice", "dialogue"):
            g = 10 ** (float(duck) / 20)
            r = 0.25
            terms = [f"clip(min((t-{a0 - r:.3f})/{r},({a1 + r:.3f}-t)/{r}),0,1)" for a0, a1 in merged]
            e = terms[0]
            for tt in terms[1:]:
                e = f"max({e},{tt})"
            ch.append(f"volume='1-{1 - g:.4f}*{e}':eval=frame")
        graph.append(f"[{i}:a]" + ",".join(ch) + f"[a{i}]")
        labels.append(f"[a{i}]")
    if labels:
        graph.append("".join(labels) + f"amix=inputs={len(labels)}:duration=longest:normalize=0,"
                     f"apad=whole_dur={T},atrim=0:{T}[mix]")
    else:
        args += ["-f", "lavfi", "-i", f"anullsrc=r={sr}:cl=stereo"]
        graph.append(f"[0:a]atrim=0:{max(T, 0.04)}[mix]")
    raw = out_wav + ".raw.wav"
    graph.append("[mix]anull[out]")
    args += ["-filter_complex", ";".join(graph), "-map", "[out]", "-ac", "2", "-ar", str(sr), "-c:a", "pcm_f32le", raw]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise EditError(f"audio mix failed: {r.stderr.strip()[-600:]}", "audio_failed")
    post = []
    lufs = tl["settings"].get("loudness", -14)
    if lufs is not None and labels:
        target = f"I={float(lufs)}:TP=-1.5:LRA=11"
        m = subprocess.run(["ffmpeg", "-v", "info", "-nostdin", "-i", raw, "-af", f"loudnorm={target}:print_format=json",
                            "-f", "null", "-"], capture_output=True, text=True)
        import json as _json
        import re as _re
        js = _re.findall(r"\{[^{}]*\}", m.stderr)
        meas = _json.loads(js[-1]) if js else None
        if meas and meas.get("input_i") not in (None, "-inf") and float(meas["input_i"]) > -70:
            post.append(f"loudnorm={target}:measured_I={meas['input_i']}:measured_TP={meas['input_tp']}:"
                        f"measured_LRA={meas['input_lra']}:measured_thresh={meas['input_thresh']}:"
                        f"offset={meas['target_offset']}:linear=true,aresample={sr}")
    post.append(f"atrim=start={t0}:end={t1},asetpts=PTS-STARTPTS")
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-i", raw, "-af", ",".join(post), "-ac", "2", "-ar", str(sr),
                        "-c:a", "pcm_s16le", out_wav], capture_output=True, text=True)
    os.unlink(raw)
    if r.returncode != 0:
        raise EditError(f"audio loudness pass failed: {r.stderr.strip()[-600:]}", "audio_failed")
    return out_wav


# ---------------------------------------------------------------- encode
FORMATS = {  # ext -> (video args, audio args)
    ".mp4": (["-c:v", "libx264", "-pix_fmt", "yuv420p"], ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]),
    ".m4v": (["-c:v", "libx264", "-pix_fmt", "yuv420p"], ["-c:a", "aac", "-b:a", "192k"]),
    ".mov": (["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"], ["-c:a", "pcm_s16le"]),
    ".webm": (["-c:v", "libvpx-vp9", "-b:v", "0", "-row-mt", "1", "-pix_fmt", "yuv420p"], ["-c:a", "libopus", "-b:a", "160k"]),
    ".mkv": (["-c:v", "libx264", "-pix_fmt", "yuv420p"], ["-c:a", "aac", "-b:a", "192k"]),
}
QUALITY = {
    "draft": {"crf": 30, "preset": "ultrafast", "vp9": 40},
    "standard": {"crf": 20, "preset": "veryfast", "vp9": 32},
    "high": {"crf": 16, "preset": "slow", "vp9": 24},
}

_COUNTER = None


def _init_worker(counter):
    global _COUNTER
    _COUNTER = counter


def _encode_frames(r: "Renderer", t0: float, i0: int, i1: int, venc: list, out: str, audio: str | None = None,
                   aenc: list | None = None, progress=None, total=None):
    fps = r.fps
    n = i1 - i0
    cmd = ["ffmpeg", "-v", "error", "-y", "-nostdin", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{r.W}x{r.H}",
           "-r", f"{fps}", "-i", "-"]
    if audio:
        cmd += ["-i", audio, "-map", "0:v", "-map", "1:a"]
    cmd += [*venc, *(aenc or ["-an"]), "-t", f"{n / fps:.6f}", out]
    errf = tempfile.TemporaryFile()
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=errf)
    last = 0.0
    try:
        for i in range(i0, i1):
            proc.stdin.write(r.frame(t0 + i / fps).tobytes())
            if _COUNTER is not None:
                with _COUNTER.get_lock():
                    _COUNTER.value += 1
            if progress and (time.time() - last > 0.5 or i == i1 - 1):
                last = time.time()
                progress(i + 1, total or i1)
        proc.stdin.close()
    except BrokenPipeError:
        pass
    finally:
        r.close()
    if proc.wait() != 0:
        errf.seek(0)
        raise EditError(f"encoder failed: {errf.read().decode(errors='replace')[-600:]}", "encode_failed")


def _segment_job(args):
    tl, root, scale, font_dirs, t0, i0, i1, venc, out = args
    from .text import FontIndex
    r = Renderer(tl, root, scale=scale, fonts=FontIndex(extra_dirs=font_dirs))
    _encode_frames(r, t0, i0, i1, venc, out)
    return out


def default_workers(n_frames: int, fps: float) -> int:
    cpus = os.cpu_count() or 2
    return max(1, min(8, cpus // 2, int(n_frames / (fps * 1.5)) or 1))


def render_video(tl: dict, root: str | Path, output: str | Path, *, start: float = 0.0, end: float | None = None,
                 scale: float = 1.0, quality: str = "standard", progress=None, fonts=FONTS, workers: int | None = None) -> dict:
    root = Path(root)
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    ext = output.suffix.lower()
    gif = ext == ".gif"
    if not gif and ext not in FORMATS:
        raise EditError(f"unsupported output format '{ext}'", "bad_format", hint="use .mp4, .mov, .webm, .mkv or .gif")
    scale = scale if not gif else min(scale, 0.5)
    r = Renderer(tl, root, scale=scale, fonts=fonts)
    T = r.duration
    end = T if end is None else min(end, T)
    if end - start <= 0:
        raise EditError("nothing to render (duration is 0 or range empty)", "empty", hint="add clips or fix --from/--to")
    fps = r.fps
    n = int(round((end - start) * fps))
    q = QUALITY.get(quality, QUALITY["standard"])
    venc, aenc = (list(x) for x in FORMATS[".mp4" if gif else ext])
    if "libx264" in venc:
        venc += ["-crf", str(q["crf"]), "-preset", q["preset"]]
    if "libvpx-vp9" in venc:
        venc += ["-crf", str(q["vp9"])]
    workers = workers or default_workers(n, fps)
    t_begin = time.time()
    with tempfile.TemporaryDirectory(prefix="agentcut-") as tmp:
        wav = os.path.join(tmp, "mix.wav")
        build_audio(tl, root, wav, start, end)
        target = os.path.join(tmp, "tmp.mp4") if gif else str(output)
        if workers <= 1:
            _encode_frames(r, start, 0, n, venc, target, wav, aenc, progress, n)
        else:
            r.close()
            import multiprocessing as mp
            from concurrent.futures import ProcessPoolExecutor
            ctx = mp.get_context("spawn")
            counter = ctx.Value("i", 0)
            bounds = [round(n * k / workers) for k in range(workers + 1)]
            seg_ext = ".mov" if ext == ".mov" else (".webm" if ext == ".webm" else ".mkv")
            jobs = [(tl, str(root), scale, getattr(fonts, "extra_dirs", []), start, bounds[k], bounds[k + 1], venc,
                     os.path.join(tmp, f"seg{k:03d}{seg_ext}")) for k in range(workers) if bounds[k + 1] > bounds[k]]
            with ProcessPoolExecutor(len(jobs), mp_context=ctx, initializer=_init_worker, initargs=(counter,)) as ex:
                futs = [ex.submit(_segment_job, j) for j in jobs]
                while not all(f.done() for f in futs):
                    time.sleep(0.3)
                    if progress:
                        progress(min(n, counter.value), n)
                segs = [f.result() for f in futs]
            lst = os.path.join(tmp, "list.txt")
            with open(lst, "w") as f:
                f.writelines("file '" + s_.replace("\\", "/").replace("'", "'\\''") + "'\n" for s_ in segs)
            cc = subprocess.run(["ffmpeg", "-v", "error", "-y", "-nostdin", "-f", "concat", "-safe", "0", "-i", lst, "-i", wav,
                                 "-map", "0:v", "-map", "1:a", "-c:v", "copy", *aenc, "-t", f"{n / fps:.6f}", target],
                                capture_output=True, text=True)
            if cc.returncode != 0:
                raise EditError(f"concat failed: {cc.stderr[-600:]}", "encode_failed")
            if progress:
                progress(n, n)
        if gif:
            gw = min(r.W, 540)
            g = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", target, "-vf",
                                f"fps={min(fps, 15)},scale={gw}:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
                                str(output)], capture_output=True, text=True)
            if g.returncode != 0:
                raise EditError(f"gif conversion failed: {g.stderr[-400:]}", "encode_failed")
    el = time.time() - t_begin
    return {"output": str(output), "duration": round(n / fps, 3), "frames": n, "width": r.W, "height": r.H,
            "fps": fps, "range": [start, end], "workers": workers, "render_seconds": round(el, 2),
            "speed_x": round((n / fps) / el, 2) if el > 0 else None, "size_bytes": output.stat().st_size}


def render_frame(tl: dict, root, t: float, scale: float = 1.0, guides: bool = False, fonts=FONTS) -> np.ndarray:
    r = Renderer(tl, root, scale=scale, fonts=fonts)
    try:
        return r.frame(t, guides=guides)
    finally:
        r.close()


def contact_sheet(tl: dict, root, times: list[float], cols: int = 4, tile_w: int = 480, guides=False, fonts=FONTS) -> np.ndarray:
    """Render frames at the given times into one labelled grid image (RGB)."""
    st = tl["settings"]
    scale = min(1.0, tile_w / st["width"])
    r = Renderer(tl, root, scale=scale, fonts=fonts)
    tiles = []
    try:
        for t in sorted(times):
            f = r.frame(min(t, max(0, r.duration - 1 / r.fps)), guides=guides)
            f = np.ascontiguousarray(f)
            label = f"{t:6.2f}s"
            cv2.rectangle(f, (0, 0), (8 + 11 * len(label), 24), (0, 0, 0), -1)
            cv2.putText(f, label, (5, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
            tiles.append(f)
    finally:
        r.close()
    if not tiles:
        raise EditError("no frames", "empty")
    cols = max(1, min(cols, len(tiles)))
    h, w = tiles[0].shape[:2]
    rows = math.ceil(len(tiles) / cols)
    sheet = np.full((rows * h + (rows - 1) * 4, cols * w + (cols - 1) * 4, 3), 30, np.uint8)
    for i, tile in enumerate(tiles):
        y, x = divmod(i, cols)
        sheet[y * (h + 4):y * (h + 4) + h, x * (w + 4):x * (w + 4) + w] = tile
    return sheet


def save_png(arr: np.ndarray, path) -> str:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr).save(path)
    return str(path)


def log(msg):
    print(msg, file=sys.stderr, flush=True)
