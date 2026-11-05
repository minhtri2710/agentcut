"""Easing, keyframes and animation presets (enter/exit, transitions, motion)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from .model import parse_time


def _back_out(t, s=1.70158):
    t -= 1
    return t * t * ((s + 1) * t + s) + 1


def _bounce_out(t):
    n, d = 7.5625, 2.75
    if t < 1 / d:
        return n * t * t
    if t < 2 / d:
        t -= 1.5 / d
        return n * t * t + 0.75
    if t < 2.5 / d:
        t -= 2.25 / d
        return n * t * t + 0.9375
    t -= 2.625 / d
    return n * t * t + 0.984375


def _elastic_out(t):
    if t in (0, 1):
        return t
    return 2 ** (-10 * t) * math.sin((t * 10 - 0.75) * (2 * math.pi) / 3) + 1


EASE = {
    "linear": lambda t: t,
    "ease_in": lambda t: t ** 3,
    "ease_out": lambda t: 1 - (1 - t) ** 3,
    "ease_in_out": lambda t: 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2,
    "back_out": _back_out,
    "bounce_out": _bounce_out,
    "elastic_out": _elastic_out,
    "hold": lambda t: 0.0 if t < 1 else 1.0,
}


def ease(name, t):
    t = min(1.0, max(0.0, t))
    return EASE.get(name or "linear", EASE["linear"])(t)


def _kf(k):
    if isinstance(k, dict):
        return parse_time(k.get("t", 0)), float(k.get("v", k.get("value", 0))), k.get("ease")
    return parse_time(k[0]), float(k[1]), (k[2] if len(k) > 2 else None)


def keyframe_value(kfs, t: float, default: float | None = None):
    pts = sorted((_kf(k) for k in kfs), key=lambda x: x[0])
    if not pts:
        return default
    if t <= pts[0][0]:
        return pts[0][1]
    for (t0, v0, _), (t1, v1, e) in zip(pts, pts[1:]):
        if t <= t1:
            if t1 - t0 <= 1e-9:
                return v1
            return v0 + (v1 - v0) * ease(e or "linear", (t - t0) / (t1 - t0))
    return pts[-1][1]


@dataclass
class Mods:
    opacity: float = 1.0
    dx: float = 0.0
    dy: float = 0.0
    scale: float = 1.0
    rotation: float = 0.0
    blur: float = 0.0
    masks: list = field(default_factory=list)  # ("wipe", dir, p) | ("circle", p)
    chars: float | None = None  # typewriter fraction
    words: float | None = None  # word reveal fraction


DEFAULT_EASE = {"pop": "back_out", "drop": "bounce_out", "typewriter": "linear", "words": "linear"}


def apply_anim(kind: str, p: float, m: Mods, W: float, H: float):
    """Apply an entrance-style animation at eased progress p (0 = hidden, 1 = settled)."""
    q = 1 - p
    mn = min(W, H)
    if kind == "fade":
        m.opacity *= p
    elif kind == "slide_up":
        m.dy += q * 0.08 * H
        m.opacity *= min(1, p * 1.5)
    elif kind == "slide_down":
        m.dy -= q * 0.08 * H
        m.opacity *= min(1, p * 1.5)
    elif kind == "slide_left":
        m.dx += q * 0.10 * W
        m.opacity *= min(1, p * 1.5)
    elif kind == "slide_right":
        m.dx -= q * 0.10 * W
        m.opacity *= min(1, p * 1.5)
    elif kind == "pop":
        m.scale *= max(0.0, 0.3 + 0.7 * p)
        m.opacity *= min(1, max(0.0, p) * 3)
    elif kind == "zoom_in":
        m.scale *= 1.3 - 0.3 * p
        m.opacity *= p
    elif kind == "zoom_out":
        m.scale *= 0.7 + 0.3 * p
        m.opacity *= p
    elif kind.startswith("wipe_"):
        m.masks.append(("wipe", kind[5:], p))
    elif kind == "blur":
        m.blur += q * 0.03 * mn
        m.opacity *= p
    elif kind == "drop":
        m.dy -= q * 0.3 * H
        m.opacity *= min(1, p * 4)
    elif kind == "spin":
        m.rotation -= q * 120
        m.scale *= 0.5 + 0.5 * p
        m.opacity *= p
    elif kind == "typewriter":
        m.chars = p
    elif kind == "words":
        m.words = p


def enter_exit(c: dict, tl: float, D: float, m: Mods, W: float, H: float):
    from .model import norm_anim
    for key in ("enter", "exit"):
        spec = norm_anim(c.get(key), 0.5)
        if not spec:
            continue
        kind = spec["type"]
        d = spec["duration"]
        if kind in ("typewriter", "words") and not (isinstance(c.get(key), dict) and "duration" in c[key]):
            d = min(1.5, D * 0.6)
        d = max(1e-3, min(d, D))
        e = spec.get("ease") or DEFAULT_EASE.get(kind, "ease_out")
        if key == "enter" and tl < d:
            apply_anim(kind, ease(e, tl / d), m, W, H)
        elif key == "exit" and tl > D - d:
            apply_anim(kind, ease(e if e not in ("back_out", "bounce_out") else "ease_in_out", (D - tl) / d), m, W, H)


def transition_mods(kind: str, p: float, mB: Mods, mA: Mods | None, W: float, H: float):
    """Modify incoming (B) and outgoing (A) clips at eased progress p. Returns overlay (rgba, alpha) or None."""
    q = 1 - p
    mn = min(W, H)
    if kind == "crossfade":
        mB.opacity *= p
    elif kind in ("dip_black", "dip_white"):
        if p < 0.5:
            mB.opacity = 0.0
        elif mA:
            mA.opacity = 0.0
        col = (0, 0, 0) if kind == "dip_black" else (255, 255, 255)
        return col, 1 - abs(2 * p - 1)
    elif kind.startswith(("slide_", "push_")):
        d = kind.split("_")[1]
        vx, vy = {"left": (W, 0), "right": (-W, 0), "up": (0, H), "down": (0, -H)}[d]
        mB.dx += q * vx
        mB.dy += q * vy
        if kind.startswith("push_") and mA:
            mA.dx -= p * vx
            mA.dy -= p * vy
    elif kind.startswith("wipe_"):
        mB.masks.append(("wipe", kind[5:], p))
    elif kind == "zoom":
        mB.scale *= 1.25 - 0.25 * p
        mB.opacity *= p
        if mA:
            mA.scale *= 1 + 0.15 * p
    elif kind == "circle":
        mB.masks.append(("circle", p))
    elif kind == "blur":
        mB.blur += q * 0.04 * mn
        mB.opacity *= p
        if mA:
            mA.blur += p * 0.04 * mn
    return None


def motion_mods(c: dict, tl: float, D: float, m: Mods, W: float, H: float):
    spec = c.get("motion")
    if not spec:
        return
    if isinstance(spec, str):
        spec = {"type": spec}
    kind, a = spec.get("type"), float(spec.get("amount", 1.0))
    u = min(1.0, max(0.0, tl / D)) if D > 0 else 0
    ue = ease("ease_in_out", u)
    if kind == "ken_burns":
        m.scale *= 1 + 0.12 * a * ue
    elif kind == "ken_burns_out":
        m.scale *= 1 + 0.12 * a * (1 - ue)
    elif kind == "zoom_slow":
        m.scale *= 1 + 0.05 * a * u
    elif kind in ("pan_left", "pan_right", "pan_up", "pan_down"):
        m.scale *= 1 + 0.12 * a
        off = 0.05 * a * (1 - 2 * ue)  # +0.05 -> -0.05
        if kind == "pan_left":
            m.dx += off * W
        elif kind == "pan_right":
            m.dx -= off * W
        elif kind == "pan_up":
            m.dy += off * H
        else:
            m.dy -= off * H
    elif kind == "pulse":
        f = float(spec.get("freq", 1.0))
        m.scale *= 1 + 0.04 * a * (0.5 - 0.5 * math.cos(2 * math.pi * f * tl))
    elif kind == "float":
        f = float(spec.get("freq", 0.4))
        m.dy += 0.012 * H * a * math.sin(2 * math.pi * f * tl)
    elif kind == "shake":
        mn = min(W, H)
        amp = 0.008 * mn * a
        m.dx += amp * (math.sin(tl * 37.1) + 0.6 * math.sin(tl * 71.3 + 1.3))
        m.dy += amp * (math.sin(tl * 43.7 + 0.7) + 0.6 * math.sin(tl * 59.9 + 2.1))
        m.rotation += 0.4 * a * math.sin(tl * 29.3)
