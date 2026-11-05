"""Timeline data model: schema, defaults, time/colour parsing, validation, resolution.

The timeline is plain JSON so an agent can read/write it directly. Everything here is
pure (no I/O besides optional file-existence checks) so it is cheap to call often.
"""
from __future__ import annotations

import copy
import difflib
import re
from typing import Any

SCHEMA_VERSION = 1

PRESETS = {
    "reels": (1080, 1920), "tiktok": (1080, 1920), "shorts": (1080, 1920), "story": (1080, 1920),
    "youtube": (1920, 1080), "landscape": (1920, 1080), "720p": (1280, 720), "4k": (3840, 2160),
    "square": (1080, 1080), "portrait": (1080, 1350),
}

CLIP_TYPES = ["video", "image", "text", "captions", "shape", "color", "audio", "gap"]
VISUAL_TYPES = {"video", "image", "text", "captions", "shape", "color"}
MEDIA_TYPES = {"video", "image", "audio"}

ENTER_EXIT = ["fade", "slide_up", "slide_down", "slide_left", "slide_right", "pop", "zoom_in",
              "zoom_out", "wipe_left", "wipe_right", "wipe_up", "wipe_down", "blur", "drop",
              "spin", "typewriter", "words"]
TRANSITIONS = ["crossfade", "dip_black", "dip_white", "slide_left", "slide_right", "slide_up",
               "slide_down", "push_left", "push_right", "push_up", "push_down", "wipe_left",
               "wipe_right", "wipe_up", "wipe_down", "zoom", "circle", "blur"]
MOTIONS = ["ken_burns", "ken_burns_out", "pan_left", "pan_right", "pan_up", "pan_down",
           "pulse", "float", "shake", "zoom_slow"]
EASINGS = ["linear", "ease_in", "ease_out", "ease_in_out", "back_out", "bounce_out",
           "elastic_out", "hold"]
FITS = ["cover", "contain", "fill", "none"]
BLENDS = ["normal", "multiply", "screen", "add", "overlay", "darken", "lighten"]
POSITIONS = ["center", "top", "bottom", "left", "right", "top_left", "top_right",
             "bottom_left", "bottom_right"]
CAPTION_STYLES = ["karaoke", "word", "reveal", "line"]
SHAPES = ["rect", "circle", "ellipse"]
FILTERS = {
    "eq": "brightness (-1..1, 0), contrast (0..3, 1), saturation (0..3, 1), gamma (0.1..10, 1)",
    "look": "name: warm|cool|vintage|bw|cinematic|vivid|fade|teal_orange",
    "lut": "path to a .cube 3D LUT file",
    "blur": "radius px",
    "sharpen": "amount (0..3, 1)",
    "grayscale": "no params",
    "vignette": "strength (0..1, 0.5)",
    "hflip": "mirror horizontally", "vflip": "mirror vertically",
    "chromakey": "color (#00ff00), similarity (0.1), blend (0.05) - makes that colour transparent",
    "denoise": "strength (1..10, 4)",
    "ffmpeg": "value: raw FFmpeg -vf filter string (escape hatch)",
}
ANIMATABLE = ["x", "y", "scale", "scale_x", "scale_y", "rotation", "opacity", "volume", "blur"]

# field -> (allowed python types, description). Used for validation + `schema` output.
_ANY = object
COMMON_FIELDS = {
    "id": ((str,), "unique id (auto-assigned)"),
    "type": ((str,), "|".join(CLIP_TYPES)),
    "name": ((str,), "free label for humans/agents"),
    "start": ((int, float, str), "timeline start seconds (computed on magnetic tracks)"),
    "duration": ((int, float, str), "seconds on the timeline"),
    "enabled": ((bool,), "false hides/mutes the clip"),
    "note": ((str,), "free-form note, ignored by renderer"),
}
VISUAL_FIELDS = {
    "x": ((int, float, str), "centre x in px or '50%' (default centre / from position)"),
    "y": ((int, float, str), "centre y in px or '50%'"),
    "position": ((str,), "|".join(POSITIONS) + " - anchor preset, combined with margin"),
    "margin": ((int, float, str), "distance from edge for position presets (px or %)"),
    "scale": ((int, float), "uniform scale (1 = fitted size)"),
    "scale_x": ((int, float), "extra horizontal scale"),
    "scale_y": ((int, float), "extra vertical scale"),
    "rotation": ((int, float), "degrees clockwise"),
    "opacity": ((int, float), "0..1"),
    "blend": ((str,), "|".join(BLENDS)),
    "keyframes": ((dict,), "{prop: [[t, value, easing?], ...]} t relative to clip start; props: " + ",".join(ANIMATABLE)),
    "enter": ((str, dict), "entrance animation: name or {type, duration, ease}: " + ",".join(ENTER_EXIT)),
    "exit": ((str, dict), "exit animation: name or {type, duration, ease}"),
    "transition": ((str, dict), "transition FROM the previous clip on the same track: name or {type, duration}: " + ",".join(TRANSITIONS)),
    "motion": ((str, dict), "continuous motion preset: name or {type, amount}: " + ",".join(MOTIONS)),
    "radius": ((int, float), "rounded corner radius px (picture-in-picture look)"),
    "shadow": ((dict, bool), "{color, x, y, blur} drop shadow behind the layer/text"),
}
MEDIA_FIELDS = {
    "asset": ((str,), "asset id from project assets"),
    "src": ((str,), "file path (auto-imported as an asset)"),
    "in": ((int, float, str), "source in-point seconds (trim start)"),
    "speed": ((int, float), "playback speed (0.1..8), affects audio pitch-free via atempo"),
    "volume": ((int, float), "linear gain 0..4 (1 = unchanged); video clips too"),
    "muted": ((bool,), "drop this clip's audio"),
    "fade_in": ((int, float), "audio fade-in seconds"),
    "fade_out": ((int, float), "audio fade-out seconds"),
    "fit": ((str,), "|".join(FITS) + " into the box (canvas or size)"),
    "size": ((list,), "[w, h] box in px or % (default: canvas) - e.g. picture-in-picture"),
    "focus": ((list,), "[fx, fy] 0..1 crop focus for fit=cover (reframe 16:9 -> 9:16)"),
    "crop": ((dict,), "{left, right, top, bottom} fractions 0..1 removed from the source"),
    "filters": ((list,), "list of {type, ...}: " + ",".join(FILTERS)),
    "loop": ((bool,), "loop the source if the clip is longer than the media"),
}
TEXT_FIELDS = {
    "text": ((str,), "the text; \\n for line breaks"),
    "font": ((str,), "family + style e.g. 'Arial Bold' or a .ttf/.otf path (see `agentcut fonts`)"),
    "font_size": ((int, float), "px (default 72 scaled to canvas)"),
    "color": ((str,), "#RRGGBB, #RRGGBBAA or CSS name"),
    "stroke": ((dict,), "{color, width}"),
    "background": ((dict, str), "box behind text: colour or {color, padding, radius}"),
    "align": ((str,), "left|center|right"),
    "max_width": ((int, float, str), "wrap width px or % (default 88%)"),
    "line_height": ((int, float), "multiplier (default 1.15)"),
    "uppercase": ((bool,), "force upper case"),
    "letter_spacing": ((int, float), "extra px between characters"),
}
CAPTION_FIELDS = {
    "words": ((list,), "[{text, start, end}] word timings, seconds relative to clip start"),
    "srt": ((str,), "path to .srt/.vtt (phrase timings; words are interpolated)"),
    "style": ((str,), "|".join(CAPTION_STYLES)),
    "max_words": ((int,), "words per caption page (default 3)"),
    "highlight_color": ((str,), "colour of the active word"),
    "highlight_bg": ((str,), "pill colour behind the active word"),
}
SHAPE_FIELDS = {
    "shape": ((str,), "|".join(SHAPES)),
    "size": ((list,), "[w, h] px or %"),
    "fill": ((str,), "fill colour"),
    "stroke": ((dict,), "{color, width}"),
    "radius": ((int, float), "corner radius (rect)"),
}
COLOR_FIELDS = {
    "color": ((str,), "solid colour (full frame unless size given)"),
    "gradient": ((dict,), "{colors: [c1, c2, ...], angle: degrees}"),
    "size": ((list,), "[w, h] px or %"),
}
GAP_FIELDS: dict = {}


def fields_for(ctype: str) -> dict:
    f = dict(COMMON_FIELDS)
    if ctype in VISUAL_TYPES:
        f.update(VISUAL_FIELDS)
    if ctype in ("video", "image", "audio"):
        f.update(MEDIA_FIELDS)
    if ctype == "audio":
        for k in ("fit", "size", "focus", "crop", "filters"):
            f.pop(k, None)
        f["keyframes"] = ((dict,), "{volume: [[t, gain, easing?], ...]} volume automation")
    if ctype == "image":
        for k in ("in", "speed", "volume", "muted", "fade_in", "fade_out", "loop"):
            f.pop(k, None)
    if ctype in ("text", "captions"):
        f.update(TEXT_FIELDS)
    if ctype == "captions":
        f.update(CAPTION_FIELDS)
    if ctype == "shape":
        f.update(SHAPE_FIELDS)
    if ctype == "color":
        f.update(COLOR_FIELDS)
    return f


TRACK_FIELDS = {
    "id": ((str,), "unique track id"),
    "kind": ((str,), "video|audio (audio tracks are not drawn)"),
    "name": ((str,), "label"),
    "magnetic": ((bool,), "true: clips play back-to-back in list order, starts are computed (like Final Cut's primary storyline)"),
    "role": ((str,), "dialogue|voice|music|sfx|titles|other - used for ducking and mixing"),
    "duck": ((int, float), "dB to lower this track while any voice/dialogue clip plays (e.g. -12)"),
    "volume": ((int, float), "track gain multiplier"),
    "muted": ((bool,), "mute the track"),
    "hidden": ((bool,), "do not draw the track"),
    "clips": ((list,), "clips, drawn in order (later on top within the track)"),
}
SETTINGS_FIELDS = {
    "width": ((int,), "canvas width px"),
    "height": ((int,), "canvas height px"),
    "fps": ((int, float), "frames per second"),
    "background": ((str,), "canvas colour"),
    "duration": ((int, float, type(None)), "force total duration (default: end of last clip)"),
    "loudness": ((int, float, type(None)), "target integrated loudness LUFS (default -14, null = off)"),
    "sample_rate": ((int,), "audio sample rate (48000)"),
    "safe_area": ((bool,), "draw safe-area guides in previews (never in renders)"),
}


# ---------------------------------------------------------------- errors
class EditError(Exception):
    """An error with a machine-readable code and a hint for the agent."""

    def __init__(self, message: str, code: str = "invalid", hint: str | None = None, path: str | None = None,
                 details: dict | None = None):
        super().__init__(message)
        self.code, self.hint, self.path, self.details = code, hint, path, details

    def to_dict(self):
        d = {"code": self.code, "message": str(self)}
        if self.hint:
            d["hint"] = self.hint
        if self.path:
            d["path"] = self.path
        if self.details:
            d.update(self.details)
        return d


def suggest(word: str, options) -> str | None:
    m = difflib.get_close_matches(str(word), list(options), n=1, cutoff=0.55)
    return m[0] if m else None


# ---------------------------------------------------------------- parsing
_TIME_RE = re.compile(r"^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$")


def parse_time(v: Any, field: str = "time") -> float:
    """Accept 3, 2.5, '2.5', '2.5s', '1500ms', '00:01.5', '1:02:03.25'."""
    if isinstance(v, bool):
        raise EditError(f"{field}: expected seconds, got boolean", "bad_time")
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip().lower()
        try:
            if s.endswith("ms"):
                return float(s[:-2]) / 1000
            if s.endswith("s"):
                return float(s[:-1])
            m = _TIME_RE.match(s)
            if m:
                h, mnt, sec = m.groups()
                return int(h or 0) * 3600 + int(mnt) * 60 + float(sec)
            return float(s)
        except ValueError:
            pass
    raise EditError(f"{field}: cannot parse time {v!r}", "bad_time",
                    hint="use seconds (2.5), '2.5s', '1500ms' or 'mm:ss.ms'")


def parse_color(v: Any, default=(255, 255, 255, 255)) -> tuple:
    if v is None:
        return default
    from PIL import ImageColor
    if isinstance(v, (list, tuple)):
        t = tuple(int(c) for c in v)
        return t + (255,) * (4 - len(t))
    s = str(v).strip()
    if s.lower() in ("transparent", "none"):
        return (0, 0, 0, 0)
    try:
        c = ImageColor.getrgb(s)
    except ValueError:
        raise EditError(f"unknown colour {v!r}", "bad_color", hint="use #RRGGBB, #RRGGBBAA or a CSS name like 'white'")
    return tuple(c) + (255,) * (4 - len(c))


def parse_len(v: Any, ref: float, default: float | None = None) -> float | None:
    """px number or 'NN%' of ref."""
    if v is None:
        return default
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    s = str(v).strip()
    if s.endswith("%"):
        return float(s[:-1]) / 100 * ref
    if s.endswith("px"):
        s = s[:-2]
    try:
        return float(s)
    except ValueError:
        raise EditError(f"cannot parse length {v!r}", "bad_length", hint="use px (120) or percent ('10%')")


def norm_anim(v: Any, default_dur: float) -> dict | None:
    """'fade' | {type, duration, ease} -> dict."""
    if v in (None, False, "none", ""):
        return None
    if isinstance(v, str):
        return {"type": v, "duration": default_dur}
    if isinstance(v, dict):
        d = dict(v)
        d.setdefault("duration", default_dur)
        d["duration"] = parse_time(d["duration"], "duration")
        return d
    raise EditError(f"bad animation spec {v!r}", "bad_anim")


# ---------------------------------------------------------------- timeline helpers
def new_timeline(width=1920, height=1080, fps=30, name="untitled") -> dict:
    return {
        "version": SCHEMA_VERSION,
        "name": name,
        "settings": {"width": width, "height": height, "fps": fps, "background": "#000000",
                     "duration": None, "loudness": -14, "sample_rate": 48000},
        "assets": {},
        "tracks": [
            {"id": "main", "kind": "video", "magnetic": True, "clips": []},
            {"id": "overlay", "kind": "video", "clips": []},
            {"id": "text", "kind": "video", "role": "titles", "clips": []},
            {"id": "voice", "kind": "audio", "role": "voice", "clips": []},
            {"id": "music", "kind": "audio", "role": "music", "duck": -12, "clips": []},
        ],
        "markers": [],
    }


def iter_clips(tl: dict):
    for ti, tr in enumerate(tl.get("tracks", [])):
        for ci, c in enumerate(tr.get("clips", [])):
            yield tr, ti, ci, c


def find_clip(tl: dict, cid: str):
    for tr, ti, ci, c in iter_clips(tl):
        if c.get("id") == cid:
            return tr, ci, c
    ids = [c.get("id") for *_, c in iter_clips(tl)]
    s = suggest(cid, ids)
    raise EditError(f"clip '{cid}' not found", "not_found",
                    hint=(f"did you mean '{s}'?" if s else f"existing clips: {', '.join(map(str, ids[:30])) or '(none)'}"))


def find_track(tl: dict, tid: str) -> dict:
    for tr in tl.get("tracks", []):
        if tr.get("id") == tid:
            return tr
    ids = [t.get("id") for t in tl.get("tracks", [])]
    s = suggest(tid, ids)
    raise EditError(f"track '{tid}' not found", "not_found",
                    hint=(f"did you mean '{s}'? " if s else "") + f"tracks: {', '.join(ids)}; create one with add_track")


def new_id(tl: dict, prefix: str) -> str:
    used = {c.get("id") for *_, c in iter_clips(tl)} | {t.get("id") for t in tl.get("tracks", [])}
    used |= set(tl.get("assets", {}))
    n = 1
    while f"{prefix}{n}" in used:
        n += 1
    return f"{prefix}{n}"


def clip_end(c: dict) -> float:
    return parse_time(c.get("start", 0)) + parse_time(c.get("duration", 0))


def resolve(tl: dict) -> dict:
    """Compute starts on magnetic tracks (in place) and return the timeline."""
    for tr in tl.get("tracks", []):
        if not tr.get("magnetic"):
            continue
        t = 0.0
        for i, c in enumerate(tr.get("clips", [])):
            dur = parse_time(c.get("duration", 0))
            tdur = 0.0
            tr_spec = norm_anim(c.get("transition"), 0.5) if i > 0 else None
            if tr_spec:
                prev = tr["clips"][i - 1]
                tdur = min(tr_spec["duration"], dur, parse_time(prev.get("duration", 0)))
            start = max(0.0, t - tdur)
            c["start"] = round(start, 6)
            t = start + dur
    return tl


def total_duration(tl: dict) -> float:
    st = tl.get("settings", {})
    if st.get("duration"):
        return parse_time(st["duration"])
    end = 0.0
    for tr, _, _, c in iter_clips(tl):
        if c.get("enabled", True) is False:
            continue
        end = max(end, clip_end(c))
    return round(end, 6)


# ---------------------------------------------------------------- validation
def _check_fields(obj: dict, fields: dict, path: str, issues: list, what: str):
    for k, v in obj.items():
        if k not in fields:
            s = suggest(k, fields)
            issues.append({"level": "error", "path": f"{path}.{k}", "message": f"unknown {what} field '{k}'",
                           "hint": f"did you mean '{s}'?" if s else f"allowed: {', '.join(fields)}"})
            continue
        types = fields[k][0]
        if v is not None and not isinstance(v, types) or (isinstance(v, bool) and bool not in types and v is not None):
            issues.append({"level": "error", "path": f"{path}.{k}",
                           "message": f"'{k}' has type {type(v).__name__}, expected {'/'.join(t.__name__ for t in types)}"})


def _check_name(v, options, path, issues, what):
    name = v.get("type") if isinstance(v, dict) else v
    if name in (None, False, "none", ""):
        return
    if name not in options:
        s = suggest(name, options)
        issues.append({"level": "error", "path": path, "message": f"unknown {what} '{name}'",
                       "hint": f"did you mean '{s}'?" if s else f"options: {', '.join(options)}"})


def validate(tl: dict, check_files: bool = True, fonts=None) -> list[dict]:
    """Return a list of issues: {level: error|warning, path, message, hint?}."""
    import os
    issues: list[dict] = []
    if not isinstance(tl, dict):
        return [{"level": "error", "path": "$", "message": "timeline must be a JSON object"}]
    for k in tl:
        if k not in ("version", "name", "settings", "assets", "tracks", "markers", "meta"):
            issues.append({"level": "warning", "path": f"$.{k}", "message": f"unknown top-level key '{k}' (ignored)"})
    st = tl.get("settings", {})
    _check_fields(st, SETTINGS_FIELDS, "$.settings", issues, "settings")
    for k in ("width", "height"):
        v = st.get(k)
        if not isinstance(v, int) or v < 16 or v > 8192:
            issues.append({"level": "error", "path": f"$.settings.{k}", "message": f"{k} must be an int 16..8192"})
        elif v % 2:
            issues.append({"level": "warning", "path": f"$.settings.{k}", "message": f"{k} is odd; H.264 export will pad to even"})
    if not isinstance(st.get("fps"), (int, float)) or not 1 <= st.get("fps", 0) <= 120:
        issues.append({"level": "error", "path": "$.settings.fps", "message": "fps must be 1..120"})

    assets = tl.get("assets", {})
    for aid, a in assets.items():
        p = a.get("path")
        if check_files and p and not os.path.exists(p):
            issues.append({"level": "error", "path": f"$.assets.{aid}.path", "message": f"file not found: {p}",
                           "hint": "re-import the file or fix the path (relative paths are resolved from the project folder)"})

    ids: dict[str, str] = {}
    tracks = tl.get("tracks", [])
    if not isinstance(tracks, list):
        issues.append({"level": "error", "path": "$.tracks", "message": "tracks must be a list"})
        return issues
    for ti, tr in enumerate(tracks):
        tp = f"$.tracks[{ti}]"
        _check_fields(tr, TRACK_FIELDS, tp, issues, "track")
        tid = tr.get("id")
        if not tid:
            issues.append({"level": "error", "path": f"{tp}.id", "message": "track needs an id"})
        elif tid in ids:
            issues.append({"level": "error", "path": f"{tp}.id", "message": f"duplicate id '{tid}'"})
        ids[tid] = tp
        kind = tr.get("kind", "video")
        prev_end = None
        for ci, c in enumerate(tr.get("clips", [])):
            p = f"{tp}.clips[{ci}]"
            if not isinstance(c, dict):
                issues.append({"level": "error", "path": p, "message": "clip must be an object"})
                continue
            ctype = c.get("type")
            if ctype not in CLIP_TYPES:
                s = suggest(ctype, CLIP_TYPES)
                issues.append({"level": "error", "path": f"{p}.type", "message": f"unknown clip type {ctype!r}",
                               "hint": f"did you mean '{s}'?" if s else f"types: {', '.join(CLIP_TYPES)}"})
                continue
            p = f"{p}<{c.get('id', '?')}>"
            _check_fields(c, fields_for(ctype), p, issues, ctype)
            cid = c.get("id")
            if not cid:
                issues.append({"level": "error", "path": f"{p}.id", "message": "clip needs an id"})
            elif cid in ids:
                issues.append({"level": "error", "path": f"{p}.id", "message": f"duplicate id '{cid}' (also {ids[cid]})"})
            ids[cid] = p
            if kind == "audio" and ctype not in ("audio", "video", "gap"):
                issues.append({"level": "warning", "path": p, "message": f"{ctype} clip on audio track '{tid}' will not be drawn"})
            if kind != "audio" and ctype == "audio":
                issues.append({"level": "warning", "path": p, "message": "audio clip on a video track (fine, but an audio track is clearer)"})
            try:
                dur = parse_time(c.get("duration", 0), "duration")
                start = parse_time(c.get("start", 0), "start")
                if dur <= 0:
                    issues.append({"level": "error", "path": f"{p}.duration", "message": "duration must be > 0"})
                if start < 0:
                    issues.append({"level": "error", "path": f"{p}.start", "message": "start must be >= 0"})
            except EditError as e:
                issues.append({"level": "error", "path": p, "message": str(e), "hint": e.hint})
                continue
            if ctype in MEDIA_TYPES:
                aid = c.get("asset")
                if not aid:
                    issues.append({"level": "error", "path": f"{p}.asset", "message": "media clip needs 'asset' (or 'src' when adding)"})
                elif aid not in assets:
                    s = suggest(aid, assets)
                    issues.append({"level": "error", "path": f"{p}.asset", "message": f"asset '{aid}' not in project",
                                   "hint": f"did you mean '{s}'?" if s else "import it first (import_media) or add with 'src'"})
                else:
                    a = assets[aid]
                    if ctype in ("video", "audio") and a.get("duration") and not c.get("loop"):
                        src_need = parse_time(c.get("in", 0)) + dur * float(c.get("speed", 1) or 1)
                        if src_need > a["duration"] + 0.05:
                            issues.append({"level": "warning", "path": f"{p}.duration",
                                           "message": f"clip needs {src_need:.2f}s of source but '{aid}' is {a['duration']:.2f}s; last frame will be held",
                                           "hint": "shorten duration, lower 'in', or set loop: true"})
                    if ctype == "video" and a.get("kind") == "image":
                        issues.append({"level": "warning", "path": f"{p}.type", "message": "asset is an image; use type 'image'"})
                    if ctype == "audio" and a.get("kind") == "image":
                        issues.append({"level": "error", "path": f"{p}.type", "message": "asset is an image, cannot be audio"})
            if ctype == "text" and not str(c.get("text", "")).strip():
                issues.append({"level": "error", "path": f"{p}.text", "message": "text clip has empty text"})
            if ctype == "captions" and not (c.get("words") or c.get("srt")):
                issues.append({"level": "error", "path": p, "message": "captions need 'words' or 'srt'"})
            if ctype == "captions" and c.get("srt") and check_files and not os.path.exists(c["srt"]):
                issues.append({"level": "error", "path": f"{p}.srt", "message": f"file not found: {c['srt']}"})
            for key, opts, what in (("enter", ENTER_EXIT, "animation"), ("exit", ENTER_EXIT, "animation"),
                                    ("transition", TRANSITIONS, "transition"), ("motion", MOTIONS, "motion")):
                if key in c:
                    _check_name(c[key], opts, f"{p}.{key}", issues, what)
            if "transition" in c and c["transition"] and ci == 0:
                issues.append({"level": "warning", "path": f"{p}.transition", "message": "first clip on a track has no previous clip; use 'enter' instead"})
            if "transition" in c and c["transition"] and ci > 0 and not tr.get("magnetic"):
                issues.append({"level": "warning", "path": f"{p}.transition",
                               "message": "transition on a non-magnetic track only works if this clip overlaps the previous one by the transition duration"})
            for key, opts in (("fit", FITS), ("blend", BLENDS), ("position", POSITIONS), ("style", CAPTION_STYLES), ("shape", SHAPES)):
                if key in c and c[key] not in opts:
                    s = suggest(c[key], opts)
                    issues.append({"level": "error", "path": f"{p}.{key}", "message": f"invalid {key} '{c[key]}'",
                                   "hint": f"did you mean '{s}'?" if s else f"options: {', '.join(opts)}"})
            for fi, flt in enumerate(c.get("filters", []) or []):
                ft = flt.get("type") if isinstance(flt, dict) else flt
                if ft not in FILTERS:
                    s = suggest(ft, FILTERS)
                    issues.append({"level": "error", "path": f"{p}.filters[{fi}]", "message": f"unknown filter '{ft}'",
                                   "hint": f"did you mean '{s}'?" if s else f"filters: {', '.join(FILTERS)}"})
                elif ft == "lut" and check_files and not os.path.exists(str(flt.get("path", ""))):
                    issues.append({"level": "error", "path": f"{p}.filters[{fi}].path", "message": "LUT file not found"})
            for prop, kfs in (c.get("keyframes") or {}).items():
                if prop not in ANIMATABLE:
                    s = suggest(prop, ANIMATABLE)
                    issues.append({"level": "error", "path": f"{p}.keyframes.{prop}", "message": f"'{prop}' is not animatable",
                                   "hint": f"did you mean '{s}'?" if s else f"animatable: {', '.join(ANIMATABLE)}"})
                    continue
                if not isinstance(kfs, list) or not kfs:
                    issues.append({"level": "error", "path": f"{p}.keyframes.{prop}", "message": "keyframes must be a non-empty list of [t, value, easing?]"})
                    continue
                for k in kfs:
                    kk = k if isinstance(k, (list, tuple)) else [k.get("t"), k.get("v", k.get("value")), k.get("ease")] if isinstance(k, dict) else None
                    if not kk or len(kk) < 2:
                        issues.append({"level": "error", "path": f"{p}.keyframes.{prop}", "message": f"bad keyframe {k!r}; use [t, value] or [t, value, 'ease_out']"})
                    elif len(kk) > 2 and kk[2] and kk[2] not in EASINGS:
                        issues.append({"level": "error", "path": f"{p}.keyframes.{prop}", "message": f"unknown easing '{kk[2]}'", "hint": f"easings: {', '.join(EASINGS)}"})
            if fonts is not None and ctype in ("text", "captions"):
                try:
                    from .text import font_for_text
                    sample = c.get("text") or " ".join(str(w.get("text", "")) for w in (c.get("words") or []))
                    if c.get("uppercase"):
                        sample = sample.upper()
                    _, _, fb = font_for_text(fonts, c.get("font"), sample)
                    if fb:
                        issues.append({"level": "warning", "path": f"{p}.font",
                                       "message": f"font '{c.get('font')}' lacks some characters in the text; using '{fb}' instead",
                                       "hint": f"pick a font that supports the language, e.g. '{fb}'"})
                except EditError as e:
                    issues.append({"level": "error", "path": f"{p}.font", "message": str(e), "hint": e.hint})
            if not tr.get("magnetic") and kind != "audio" and prev_end is not None and start < prev_end - 1e-6 and not c.get("transition"):
                issues.append({"level": "info", "path": p, "message": f"overlaps previous clip on track '{tid}' (drawn on top)"})
            prev_end = max(prev_end or 0, start + dur)
    if not any(tr.get("clips") for tr in tracks):
        issues.append({"level": "warning", "path": "$.tracks", "message": "timeline is empty"})
    return issues


def schema_doc() -> dict:
    """A compact, agent-readable description of the timeline format."""
    def f(d):
        return {k: v[1] for k, v in d.items()}
    return {
        "timeline": {
            "version": SCHEMA_VERSION,
            "settings": f(SETTINGS_FIELDS),
            "assets": "{asset_id: {path, kind: video|image|audio, duration, width, height, fps, has_audio}} - filled by import_media",
            "tracks": "list; index 0 is drawn FIRST (bottom). Later tracks are drawn on top.",
            "markers": "[{t, label}] free annotations (e.g. beats)",
        },
        "track": f(TRACK_FIELDS),
        "clip_types": {t: f({k: v for k, v in fields_for(t).items() if k not in COMMON_FIELDS}) for t in CLIP_TYPES},
        "common_clip_fields": f(COMMON_FIELDS),
        "units": {"time": "seconds (2.5, '2.5s', '1500ms', '00:02.5')", "length": "px or '10%' of canvas",
                  "color": "#RRGGBB / #RRGGBBAA / CSS name"},
        "enums": {"enter_exit": ENTER_EXIT, "transitions": TRANSITIONS, "motions": MOTIONS, "easings": EASINGS,
                  "fit": FITS, "blend": BLENDS, "position": POSITIONS, "caption_styles": CAPTION_STYLES,
                  "filters": FILTERS, "presets": {k: f"{w}x{h}" for k, (w, h) in PRESETS.items()}},
    }


def deep_merge(dst: dict, patch: dict) -> dict:
    """RFC-7386-ish merge: None deletes a key, dicts merge, everything else replaces."""
    for k, v in patch.items():
        if v is None:
            dst.pop(k, None)
        elif isinstance(v, dict) and isinstance(dst.get(k), dict) and k not in ("keyframes",):
            deep_merge(dst[k], v)
        else:
            dst[k] = copy.deepcopy(v)
    return dst


def set_dotted(obj: dict, key: str, value):
    parts = key.split(".")
    for p in parts[:-1]:
        obj = obj.setdefault(p, {})
    if value is None:
        obj.pop(parts[-1], None)
    else:
        obj[parts[-1]] = value
