"""Edit operations. Every op is a JSON object {"op": name, ...args}; batches are atomic.

Ops mutate a timeline dict in place and return a small JSON result (ids, durations).
"""
from __future__ import annotations

import copy
import shutil
from pathlib import Path

from . import analyze
from .media import probe
from .model import (CLIP_TYPES, PRESETS, TRANSITIONS, EditError, deep_merge, find_clip, find_track,
                    new_id, parse_time, resolve, suggest, total_duration)

PREFIX = {"video": "vid", "image": "img", "text": "txt", "captions": "cap", "shape": "shp", "color": "col",
          "audio": "aud", "gap": "gap"}
OPS: dict[str, dict] = {}


def op(name, doc, args):
    def deco(fn):
        OPS[name] = {"fn": fn, "doc": doc, "args": args}
        return fn
    return deco


def _abspath(p: str) -> str:
    return str(Path(p).expanduser().resolve())


# ---------------------------------------------------------------- media
def import_asset(proj, tl, path, aid=None, copy_file=False) -> str:
    src = Path(path).expanduser()
    if not src.is_absolute() and not src.exists() and proj and (proj.root / src).exists():
        src = proj.root / src
    src = src.resolve()
    if not src.exists():
        raise EditError(f"file not found: {path}", "not_found", hint="use an absolute path or a path relative to the current directory")
    for k, a in tl["assets"].items():  # dedupe by path
        if proj and Path(proj.abs(a["path"])).resolve() == src:
            return k
    if copy_file and proj:
        dst = proj.root / "media" / src.name
        if dst.resolve() != src:
            i = 1
            while dst.exists():
                dst = proj.root / "media" / f"{src.stem}-{i}{src.suffix}"
                i += 1
            shutil.copy2(src, dst)
        src = dst
    info = probe(src)
    if aid is None:
        base = "".join(ch if ch.isalnum() else "_" for ch in src.stem.lower()).strip("_")[:24] or "asset"
        aid = base
        n = 2
        while aid in tl["assets"]:
            aid = f"{base}_{n}"
            n += 1
    elif aid in tl["assets"]:
        raise EditError(f"asset id '{aid}' already exists", "exists")
    info["path"] = proj.rel(src) if proj else str(src)
    tl["assets"][aid] = info
    return aid


@op("import_media", "Import a media file (video/image/audio) as an asset. Returns asset id + probe info.",
    {"path": "file path (required)", "id": "asset id (optional)", "copy": "copy into project media/ (default false)"})
def op_import(proj, tl, a):
    aid = import_asset(proj, tl, a["path"], a.get("id"), bool(a.get("copy")))
    return {"asset": aid, **{k: v for k, v in tl["assets"][aid].items() if k != "path"}}


@op("remove_asset", "Remove an asset (fails if clips still use it unless force=true).", {"id": "asset id", "force": "bool"})
def op_remove_asset(proj, tl, a):
    aid = a["id"]
    if aid not in tl["assets"]:
        raise EditError(f"asset '{aid}' not found", "not_found")
    users = [c["id"] for tr in tl["tracks"] for c in tr["clips"] if c.get("asset") == aid]
    if users and not a.get("force"):
        raise EditError(f"asset '{aid}' is used by {', '.join(users)}", "in_use", hint="remove those clips or pass force=true")
    if users:
        for tr in tl["tracks"]:
            tr["clips"] = [c for c in tr["clips"] if c.get("asset") != aid]
    del tl["assets"][aid]
    return {"removed": aid, "removed_clips": users}


# ---------------------------------------------------------------- settings / tracks
@op("set_settings", "Change canvas/output settings.",
    {"preset": "|".join(PRESETS), "width": "px", "height": "px", "fps": "number", "background": "colour",
     "duration": "seconds or null", "loudness": "LUFS or null", "name": "project name"})
def op_settings(proj, tl, a):
    st = tl["settings"]
    if a.get("preset"):
        if a["preset"] not in PRESETS:
            s = suggest(a["preset"], PRESETS)
            raise EditError(f"unknown preset '{a['preset']}'", "bad_preset", hint=f"did you mean '{s}'?" if s else ", ".join(PRESETS))
        st["width"], st["height"] = PRESETS[a["preset"]]
    for k in ("width", "height", "fps", "background", "duration", "loudness", "sample_rate", "safe_area"):
        if k in a:
            st[k] = a[k]
    if "name" in a:
        tl["name"] = a["name"]
    return {"settings": st}


@op("add_track", "Add a track. Tracks later in the list draw on top.",
    {"id": "track id", "kind": "video|audio", "magnetic": "bool", "role": "voice|music|sfx|titles|dialogue",
     "duck": "dB (music ducking)", "index": "insert position (default: top for video, end for audio)",
     "above": "track id to place above", "below": "track id to place below"})
def op_add_track(proj, tl, a):
    tid = a.get("id") or new_id(tl, "track")
    if any(t["id"] == tid for t in tl["tracks"]):
        raise EditError(f"track '{tid}' already exists", "exists")
    tr = {"id": tid, "kind": a.get("kind", "video"), "clips": []}
    for k in ("magnetic", "role", "duck", "volume", "muted", "hidden", "name"):
        if k in a:
            tr[k] = a[k]
    if "above" in a:
        idx = tl["tracks"].index(find_track(tl, a["above"])) + 1
    elif "below" in a:
        idx = tl["tracks"].index(find_track(tl, a["below"]))
    elif "index" in a:
        idx = int(a["index"])
    elif tr["kind"] == "audio":
        idx = len(tl["tracks"])
    else:  # top-most video track (below audio tracks, which are not drawn anyway)
        idx = max([i + 1 for i, t in enumerate(tl["tracks"]) if t.get("kind", "video") != "audio"] or [0])
    tl["tracks"].insert(idx, tr)
    return {"track": tid, "index": idx}


@op("update_track", "Update track properties (set: {...}).", {"id": "track id", "set": "fields to merge"})
def op_update_track(proj, tl, a):
    tr = find_track(tl, a["id"])
    patch = dict(a.get("set") or {k: v for k, v in a.items() if k not in ("op", "id")})
    patch.pop("clips", None)
    deep_merge(tr, patch)
    return {"track": tr["id"]}


@op("remove_track", "Delete a track and its clips.", {"id": "track id"})
def op_remove_track(proj, tl, a):
    tr = find_track(tl, a["id"])
    tl["tracks"].remove(tr)
    return {"removed": tr["id"], "clips": [c["id"] for c in tr["clips"]]}


@op("move_track", "Reorder a track (changes draw order).", {"id": "track id", "index": "new index"})
def op_move_track(proj, tl, a):
    tr = find_track(tl, a["id"])
    tl["tracks"].remove(tr)
    tl["tracks"].insert(int(a["index"]), tr)
    return {"track": tr["id"], "index": tl["tracks"].index(tr)}


# ---------------------------------------------------------------- clips
_ADD_META = {"op", "track", "at", "index", "after", "before", "end"}


def _infer_type(tl, a):
    if a.get("type"):
        return a["type"]
    if a.get("words") or a.get("srt"):
        return "captions"
    if "text" in a:
        return "text"
    if a.get("shape"):
        return "shape"
    if a.get("asset"):
        return {"image": "image", "audio": "audio"}.get(tl["assets"][a["asset"]]["kind"], "video")
    if a.get("color") or a.get("gradient"):
        return "color"
    raise EditError("cannot infer clip type", "missing_type", hint=f"pass type: {'|'.join(CLIP_TYPES)}")


def _default_duration(tl, c):
    t = c["type"]
    if t in ("video", "audio"):
        asset = tl["assets"][c["asset"]]
        if asset.get("kind") == "image":
            return 3.0
        avail = float(asset.get("duration") or 3) - parse_time(c.get("in", 0))
        return round(max(0.1, avail / float(c.get("speed", 1) or 1)), 3)
    if t == "captions":
        from .text import caption_words
        ws = caption_words(c)
        return round((ws[-1]["end"] + 0.3) if ws else 3.0, 3)
    if t == "gap":
        return 1.0
    return 3.0


def track_end(tr) -> float:
    return max([parse_time(c.get("start", 0)) + parse_time(c.get("duration", 0)) for c in tr["clips"]] or [0.0])


def make_clip(proj, tl, a) -> dict:
    a = dict(a)
    if a.get("src"):
        a["asset"] = import_asset(proj, tl, a.pop("src"))
    if a.get("asset") and a["asset"] not in tl["assets"]:
        s = suggest(a["asset"], tl["assets"])
        raise EditError(f"asset '{a['asset']}' not found", "not_found",
                        hint=(f"did you mean '{s}'? " if s else "") + "import it first or pass src")
    if a.get("srt"):
        a["srt"] = _abspath(a["srt"])
    for f in a.get("filters") or []:
        if isinstance(f, dict) and f.get("type") == "lut" and f.get("path"):
            f["path"] = _abspath(f["path"])
    c = {"id": a.pop("id", None), "type": _infer_type(tl, a)}
    if c["type"] not in CLIP_TYPES:
        s = suggest(c["type"], CLIP_TYPES)
        raise EditError(f"unknown clip type '{c['type']}'", "bad_type", hint=f"did you mean '{s}'?" if s else ", ".join(CLIP_TYPES))
    for k, v in a.items():
        if k not in _ADD_META and k != "type" and v is not None:
            c[k] = copy.deepcopy(v)
    if not c["id"]:
        c["id"] = new_id(tl, PREFIX[c["type"]])
    elif any(x["id"] == c["id"] for tr in tl["tracks"] for x in tr["clips"]):
        raise EditError(f"clip id '{c['id']}' already exists", "exists")
    if "end" in a and "duration" not in c:
        c["duration"] = parse_time(a["end"]) - parse_time(a.get("at", a.get("start", 0)))
    if "duration" not in c:
        c["duration"] = _default_duration(tl, c)
    c["duration"] = round(parse_time(c["duration"]), 6)
    return c


def _place(tl, tr, c, a):
    clips = tr["clips"]
    if tr.get("magnetic"):
        if "after" in a:
            idx = clips.index(find_clip(tl, a["after"])[2]) + 1
        elif "before" in a:
            idx = clips.index(find_clip(tl, a["before"])[2])
        elif "index" in a:
            idx = int(a["index"])
        else:
            idx = len(clips)
        clips.insert(idx, c)
        c.pop("start", None)
    else:
        if "at" in a or "start" in a:
            c["start"] = round(parse_time(a.get("at", a.get("start"))), 6)
        elif "after" in a:
            c["start"] = round(parse_time(find_clip(tl, a["after"])[2]["start"]) + parse_time(find_clip(tl, a["after"])[2]["duration"]), 6)
        else:
            c["start"] = round(track_end(tr), 6)
        clips.append(c)
        clips.sort(key=lambda x: parse_time(x.get("start", 0)))


def _ensure_track(tl, tid, ctype):
    try:
        return find_track(tl, tid)
    except EditError:
        kind = "audio" if ctype == "audio" else "video"
        op_add_track(None, tl, {"id": tid, "kind": kind})
        return find_track(tl, tid)


@op("add_clip", "Add a clip. Type is inferred (src/asset -> video|image|audio, text -> text, words/srt -> captions). "
    "On magnetic tracks clips append back-to-back (use index/after/before); elsewhere use 'at' (default: end of track). "
    "Any clip field (see schema) may be passed directly.",
    {"track": "track id (created if missing)", "type": "clip type", "src": "file path (auto-import)", "asset": "asset id",
     "at": "start seconds (non-magnetic)", "index|after|before": "position on magnetic track", "duration": "seconds",
     "end": "alternative to duration", "...": "any clip field: text, font, font_size, color, enter, exit, transition, "
     "motion, keyframes, filters, position, x, y, scale, fit, size, in, speed, volume..."})
def op_add_clip(proj, tl, a):
    ctype_hint = a.get("type") or ("audio" if a.get("src") and Path(a["src"]).suffix.lower() in
                                   (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".aiff") else None)
    if "track" not in a:
        guess = {"text": "text", "captions": "captions", "audio": "music"}.get(_infer_type_safe(tl, a) or ctype_hint or "", "main")
        a = {**a, "track": guess}
    c = make_clip(proj, tl, a)
    tr = _ensure_track(tl, a["track"], c["type"])
    _place(tl, tr, c, a)
    resolve(tl)
    return {"id": c["id"], "type": c["type"], "track": tr["id"], "start": c.get("start"), "duration": c["duration"]}


def _infer_type_safe(tl, a):
    try:
        return _infer_type(tl, a) if not a.get("src") else None
    except EditError:
        return None


@op("add_sequence", "Append many clips to a (magnetic) track at once - the fastest way to build a slideshow/montage. "
    "items: list of clip specs; defaults: fields applied to every item (e.g. {duration: 2, transition: 'crossfade', motion: 'ken_burns'}).",
    {"track": "track id (default main)", "items": "list of clip specs (src/asset/text/...)", "defaults": "shared fields"})
def op_add_sequence(proj, tl, a):
    tid = a.get("track", "main")
    out = []
    for i, item in enumerate(a.get("items") or []):
        if isinstance(item, str):
            item = {"src": item}
        spec = {**(a.get("defaults") or {}), **item, "track": tid}
        if i == 0 and "transition" in (a.get("defaults") or {}) and "transition" not in item:
            spec.pop("transition", None)
            tr = _maybe_track(tl, tid)
            if tr is None or not tr["clips"]:
                pass
            else:
                spec["transition"] = a["defaults"]["transition"]
        out.append(op_add_clip(proj, tl, spec))
    return {"added": out, "track_end": round(track_end(find_track(tl, tid)), 3)}


def _maybe_track(tl, tid):
    try:
        return find_track(tl, tid)
    except EditError:
        return None


@op("update_clip", "Merge fields into a clip: set {field: value}; null deletes a field. Shorthand: pass fields directly.",
    {"id": "clip id", "set": "fields to merge (dicts merge deeply; keyframes replace)"})
def op_update_clip(proj, tl, a):
    tr, ci, c = find_clip(tl, a["id"])
    patch = dict(a.get("set") or {k: v for k, v in a.items() if k not in ("op", "id")})
    if "src" in patch:
        patch["asset"] = import_asset(proj, tl, patch.pop("src"))
    if patch.get("srt"):
        patch["srt"] = _abspath(patch["srt"])
    for k in ("id", "type"):
        if k in patch and patch[k] != c.get(k):
            raise EditError(f"cannot change clip '{k}' with update_clip", "immutable",
                            hint="remove the clip and add a new one")
    if "start" in patch and tr.get("magnetic"):
        raise EditError("start is computed on magnetic tracks", "magnetic", hint="use move_clip with index, or put the clip on a non-magnetic track")
    deep_merge(c, patch)
    if not tr.get("magnetic"):
        tr["clips"].sort(key=lambda x: parse_time(x.get("start", 0)))
    resolve(tl)
    return {"id": c["id"], "start": c.get("start"), "duration": c.get("duration")}


@op("remove_clip", "Remove a clip. On magnetic tracks later clips close the gap; ripple=true does the same on other tracks.",
    {"id": "clip id", "ripple": "bool (non-magnetic tracks)"})
def op_remove_clip(proj, tl, a):
    tr, ci, c = find_clip(tl, a["id"])
    tr["clips"].pop(ci)
    if a.get("ripple") and not tr.get("magnetic"):
        d = parse_time(c["duration"])
        for x in tr["clips"]:
            if parse_time(x.get("start", 0)) >= parse_time(c.get("start", 0)):
                x["start"] = round(max(0, parse_time(x["start"]) - d), 6)
    resolve(tl)
    return {"removed": c["id"]}


@op("move_clip", "Move a clip in time and/or to another track.",
    {"id": "clip id", "at": "new start (non-magnetic)", "track": "destination track", "index": "position on magnetic track",
     "shift": "relative seconds (+/-) on non-magnetic tracks"})
def op_move_clip(proj, tl, a):
    tr, ci, c = find_clip(tl, a["id"])
    dest = find_track(tl, a["track"]) if a.get("track") else tr
    old_start = parse_time(c.get("start", 0))
    tr["clips"].pop(ci)
    b = {k: a[k] for k in ("index", "after", "before") if k in a}
    if not dest.get("magnetic"):
        if "shift" in a:
            b["at"] = max(0.0, old_start + parse_time(a["shift"]))
        else:
            b["at"] = a.get("at", old_start)
    _place(tl, dest, c, b)
    resolve(tl)
    return {"id": c["id"], "track": dest["id"], "start": c.get("start")}


@op("trim_clip", "Trim a clip. trim_start cuts N seconds from the head (moves in-point), trim_end from the tail; or set in/duration/end.",
    {"id": "clip id", "trim_start": "seconds", "trim_end": "seconds", "in": "source in", "duration": "seconds", "end": "timeline end"})
def op_trim(proj, tl, a):
    tr, ci, c = find_clip(tl, a["id"])
    speed = float(c.get("speed", 1) or 1)
    if "in" in a:
        c["in"] = round(parse_time(a["in"]), 6)
    if "duration" in a:
        c["duration"] = round(parse_time(a["duration"]), 6)
    if "end" in a:
        c["duration"] = round(parse_time(a["end"]) - parse_time(c.get("start", 0)), 6)
    if a.get("trim_start"):
        d = parse_time(a["trim_start"])
        c["in"] = round(parse_time(c.get("in", 0)) + d * speed, 6)
        c["duration"] = round(parse_time(c["duration"]) - d, 6)
        if not tr.get("magnetic"):
            c["start"] = round(parse_time(c.get("start", 0)) + d, 6)
    if a.get("trim_end"):
        c["duration"] = round(parse_time(c["duration"]) - parse_time(a["trim_end"]), 6)
    if parse_time(c["duration"]) <= 0:
        raise EditError("trim leaves a non-positive duration", "bad_trim")
    resolve(tl)
    return {"id": c["id"], "in": c.get("in", 0), "start": c.get("start"), "duration": c["duration"]}


@op("split_clip", "Split a clip at a timeline time; returns the id of the new right-hand clip.",
    {"id": "clip id", "at": "timeline seconds"})
def op_split(proj, tl, a):
    tr, ci, c = find_clip(tl, a["id"])
    resolve(tl)
    t = parse_time(a["at"])
    s, d = parse_time(c.get("start", 0)), parse_time(c["duration"])
    if not s < t < s + d:
        raise EditError(f"split point {t} is outside clip {c['id']} ({s:.3f}–{s + d:.3f})", "out_of_range")
    left = t - s
    right = copy.deepcopy(c)
    right["id"] = new_id(tl, PREFIX[c["type"]])
    c["duration"] = round(left, 6)
    right["duration"] = round(d - left, 6)
    if c["type"] in ("video", "audio"):
        right["in"] = round(parse_time(c.get("in", 0)) + left * float(c.get("speed", 1) or 1), 6)
    for k in ("transition", "enter"):
        right.pop(k, None)
    c.pop("exit", None)
    if c.get("fade_out"):
        c.pop("fade_out")
    right.pop("fade_in", None)
    if c.get("keyframes"):
        right.pop("keyframes", None)  # keyframes are clip-relative; keep them on the left part only
    if c["type"] == "captions" and c.get("words"):
        right["words"] = [{**w, "start": round(w["start"] - left, 3), "end": round(w["end"] - left, 3)}
                          for w in c["words"] if w["end"] > left]
        c["words"] = [w for w in c["words"] if w["start"] < left]
    if not tr.get("magnetic"):
        right["start"] = round(t, 6)
    tr["clips"].insert(ci + 1, right)
    resolve(tl)
    return {"left": c["id"], "right": right["id"]}


@op("duplicate_clip", "Copy a clip (optionally to another track/time).", {"id": "clip id", "track": "track id", "at": "start"})
def op_duplicate(proj, tl, a):
    tr, ci, c = find_clip(tl, a["id"])
    dup = copy.deepcopy(c)
    dup["id"] = new_id(tl, PREFIX[c["type"]])
    dest = find_track(tl, a["track"]) if a.get("track") else tr
    b = {}
    if dest.get("magnetic"):
        b["after"] = c["id"] if dest is tr else None
        b = {k: v for k, v in b.items() if v}
    else:
        b["at"] = a.get("at", parse_time(c.get("start", 0)) + parse_time(c["duration"]))
    _place(tl, dest, dup, b)
    resolve(tl)
    return {"id": dup["id"], "track": dest["id"], "start": dup.get("start")}


@op("set_keyframes", "Animate a property: keyframes [[t, value, easing?], ...] with t relative to clip start.",
    {"id": "clip id", "prop": "x|y|scale|scale_x|scale_y|rotation|opacity|volume|blur", "keyframes": "list or null to clear"})
def op_keyframes(proj, tl, a):
    tr, ci, c = find_clip(tl, a["id"])
    kfs = c.setdefault("keyframes", {})
    if a.get("keyframes") is None:
        kfs.pop(a["prop"], None)
    else:
        kfs[a["prop"]] = a["keyframes"]
    if not kfs:
        c.pop("keyframes")
    return {"id": c["id"], "keyframes": c.get("keyframes", {})}


@op("add_transition", "Set the transition into a clip from the previous clip on its track.",
    {"to": "clip id (the incoming clip)", "type": "|".join(TRANSITIONS), "duration": "seconds (default 0.5)"})
def op_transition(proj, tl, a):
    tr, ci, c = find_clip(tl, a.get("to") or a.get("id"))
    if ci == 0:
        raise EditError("first clip on the track has no previous clip", "no_previous", hint="use update_clip enter: 'fade' instead")
    t = a.get("type", "crossfade")
    if t not in TRANSITIONS:
        s = suggest(t, TRANSITIONS)
        raise EditError(f"unknown transition '{t}'", "bad_transition", hint=f"did you mean '{s}'?" if s else ", ".join(TRANSITIONS))
    if t == "none":
        c.pop("transition", None)
    else:
        c["transition"] = {"type": t, "duration": parse_time(a.get("duration", 0.5))}
    if not tr.get("magnetic"):
        prev = tr["clips"][ci - 1]
        want = parse_time(prev["start"]) + parse_time(prev["duration"]) - c["transition"]["duration"]
        c["start"] = round(max(0, want), 6)
    resolve(tl)
    return {"id": c["id"], "transition": c.get("transition"), "start": c.get("start")}


@op("add_marker", "Add a timeline marker (note/beat/todo).", {"t": "seconds", "label": "text"})
def op_marker(proj, tl, a):
    tl.setdefault("markers", []).append({"t": parse_time(a["t"]), "label": a.get("label", "")})
    tl["markers"].sort(key=lambda m: m["t"])
    return {"markers": len(tl["markers"])}


@op("clear_markers", "Remove all markers (or those whose label contains `match`).", {"match": "substring"})
def op_clear_markers(proj, tl, a):
    m = a.get("match")
    before = len(tl.get("markers", []))
    tl["markers"] = [x for x in tl.get("markers", []) if m and m not in x.get("label", "")]
    return {"removed": before - len(tl["markers"])}


# ---------------------------------------------------------------- captions / voice / beats
@op("add_captions", "Add animated captions (CapCut-style) from word timings, an .srt/.vtt, or by transcribing a media file.",
    {"words": "[{text,start,end}]", "srt": "path", "transcribe": "media path or asset id (needs agentcut[whisper])",
     "language": "for transcribe", "track": "default 'captions'", "at": "start seconds (default 0)",
     "style": "karaoke|word|reveal|line", "...": "text styling fields: font, font_size, color, stroke, highlight_color, position, y..."})
def op_captions(proj, tl, a):
    a = dict(a)
    if a.get("transcribe"):
        src = a.pop("transcribe")
        path = proj.abs(tl["assets"][src]["path"]) if src in tl["assets"] else Path(src)
        res = analyze.transcribe(path, a.pop("language", None))
        a["words"] = res["words"]
    if not (a.get("words") or a.get("srt")):
        raise EditError("add_captions needs words, srt or transcribe", "missing_input")
    a.setdefault("track", "captions")
    a["type"] = "captions"
    a.setdefault("stroke", {"color": "#000000", "width": 6})
    a.setdefault("uppercase", True)
    a.setdefault("at", 0)
    if "font" not in a:  # chunky default, but only if it has every glyph (e.g. Vietnamese diacritics)
        from .text import FONTS, caption_words, font_for_text
        sample = " ".join(w["text"] for w in caption_words(a))
        sample = sample.upper() if a.get("uppercase") else sample
        for cand in ("Arial Black", "Arial Bold", None):
            try:
                _, _, fb = font_for_text(FONTS, cand, sample)
            except EditError:
                continue
            if fb is None:
                if cand:
                    a["font"] = cand
                break
    return op_add_clip(proj, tl, a)


@op("add_voiceover", "Synthesize speech (macOS `say`; Vietnamese voice: 'Linh') into media/ and add it to the voice track. "
    "captions=true also adds estimated word-timed captions.",
    {"text": "script", "voice": "voice name (see voices)", "rate": "words/min", "track": "default 'voice'",
     "at": "start seconds (default: end of voice track)", "captions": "bool or caption style fields"})
def op_voiceover(proj, tl, a):
    import time as _t
    out = proj.root / "media" / f"vo-{int(_t.time() * 1000)}.wav"
    res = analyze.tts(a["text"], out, a.get("voice"), a.get("rate"))
    tid = a.get("track", "voice")
    tr = _maybe_track(tl, tid)
    if tr is None:
        op_add_track(proj, tl, {"id": tid, "kind": "audio", "role": "voice"})
        tr = find_track(tl, tid)
    at = parse_time(a["at"]) if "at" in a else track_end(tr)
    clip = op_add_clip(proj, tl, {"track": tid, "src": str(out), "at": at})
    result = {"clip": clip, "duration": res["duration"], "path": proj.rel(out)}
    if a.get("captions"):
        from .text import phrases_to_words
        sil = analyze.silence(out, -40, 0.15)
        speech = sil["speech"] or [[0, res["duration"]]]
        s0, s1 = speech[0][0], speech[-1][1]
        words = phrases_to_words([{"text": a["text"], "start": s0, "end": s1}])
        extra = a["captions"] if isinstance(a["captions"], dict) else {}
        result["captions"] = op_captions(proj, tl, {"words": words, "at": at, **extra})
    return result


@op("snap_to_beats", "Retime a magnetic track so each cut lands on a beat. beats: list of seconds or a beats JSON "
    "file/asset analysed with `agentcut beats`; every: cut every N beats; offset: first beat index.",
    {"track": "default main", "beats": "list | path | asset id", "every": "int (default 1)", "offset": "int (default 0)",
     "align_start": "move the first cut to beat[offset] by inserting/resizing a leading gap (default false)"})
def op_snap(proj, tl, a):
    tr = find_track(tl, a.get("track", "main"))
    if not tr.get("magnetic"):
        raise EditError("snap_to_beats works on magnetic tracks", "magnetic")
    b = a.get("beats")
    if isinstance(b, str):
        import json as _j
        p = proj.abs(tl["assets"][b]["path"]) if b in tl["assets"] else Path(b)
        b = _j.loads(Path(p).read_text())["beats"] if str(p).endswith(".json") else analyze.beats(p)["beats"]
    beats = [float(x) for x in (b or [])]
    every, off = int(a.get("every", 1)), int(a.get("offset", 0))
    cuts = beats[off::every]
    clips = [c for c in tr["clips"]]
    if len(cuts) < 2:
        raise EditError("not enough beats", "not_enough")
    resolve(tl)
    changed = []
    # cut i (start of clip i+1) should land on cuts[i+1]; clip 0 starts at 0 (or cuts[0] with align_start)
    starts = [0.0] + cuts[1:len(clips)]
    if a.get("align_start"):
        starts[0] = cuts[0]
    for i, c in enumerate(clips):
        if i + 1 >= len(starts):
            break
        nxt = clips[i + 1] if i + 1 < len(clips) else None
        td = 0.0
        if nxt is not None and nxt.get("transition"):
            from .model import norm_anim
            td = norm_anim(nxt["transition"], 0.5)["duration"]
        dur = starts[i + 1] - starts[i] + td
        if i == 0 and a.get("align_start") and starts[0] > 0:
            dur = starts[1] - 0 + td
        if dur > 0.05:
            c["duration"] = round(dur, 4)
            changed.append({"id": c["id"], "duration": c["duration"]})
    resolve(tl)
    return {"retimed": changed, "beats_used": len(changed), "track_end": round(track_end(tr), 3)}


@op("remove_silence", "Cut dead air out of a video/audio clip (like Auto-Editor/CapCut 'remove pauses'). The clip is "
    "replaced by its speech segments on the same track.",
    {"id": "clip id", "noise_db": "silence threshold (default -35)", "min_silence": "seconds (default 0.4)", "padding": "keep seconds around speech (0.1)"})
def op_remove_silence(proj, tl, a):
    tr, ci, c = find_clip(tl, a["id"])
    if c["type"] not in ("video", "audio"):
        raise EditError("remove_silence needs a video or audio clip", "bad_type")
    asset = tl["assets"][c["asset"]]
    res = analyze.silence(proj.abs(asset["path"]), float(a.get("noise_db", -35)), float(a.get("min_silence", 0.4)))
    pad = float(a.get("padding", 0.1))
    cin = parse_time(c.get("in", 0))
    speed = float(c.get("speed", 1) or 1)
    cout = cin + parse_time(c["duration"]) * speed
    segs = []
    for s, e in res["speech"]:
        s, e = max(cin, s - pad), min(cout, e + pad)
        if e - s > 0.08:
            if segs and s <= segs[-1][1]:
                segs[-1][1] = e
            else:
                segs.append([s, e])
    if not segs:
        raise EditError("no speech found with these settings", "no_speech", hint="raise noise_db (e.g. -30) or lower min_silence")
    new = []
    t = parse_time(c.get("start", 0))
    tr["clips"].pop(ci)
    for j, (s, e) in enumerate(segs):
        nc = copy.deepcopy(c)
        if j:
            nc["id"] = new_id(tl, PREFIX[c["type"]])
            nc.pop("transition", None)
            nc.pop("enter", None)
        nc["in"] = round(s, 4)
        nc["duration"] = round((e - s) / speed, 4)
        nc.pop("keyframes", None)
        if not tr.get("magnetic"):
            nc["start"] = round(t, 4)
            t += nc["duration"]
        tr["clips"].insert(ci + j, nc)
        new.append(nc["id"])
    resolve(tl)
    kept = sum(e - s for s, e in segs)
    return {"segments": new, "kept_seconds": round(kept / speed, 3), "removed_seconds": round((cout - cin - kept) / speed, 3)}


@op("replace_timeline", "Replace the whole timeline JSON (validated; undoable).", {"timeline": "full timeline object"})
def op_replace(proj, tl, a):
    new = a["timeline"]
    if not isinstance(new, dict) or "tracks" not in new or "settings" not in new:
        raise EditError("timeline must contain settings and tracks", "bad_timeline")
    new.setdefault("assets", {})
    tl.clear()
    tl.update(copy.deepcopy(new))
    return {"tracks": len(tl["tracks"]), "duration": total_duration(resolve(tl))}


# ---------------------------------------------------------------- runner
def apply_ops(proj, tl: dict, ops: list[dict]) -> list[dict]:
    """Apply ops to a COPY of tl; returns (new_tl, results). Raises EditError naming the failing op index."""
    work = copy.deepcopy(tl)
    results = []
    for i, o in enumerate(ops):
        if not isinstance(o, dict) or "op" not in o:
            raise EditError(f"ops[{i}] must be an object with an 'op' field", "bad_op", path=f"ops[{i}]")
        name = o["op"]
        if name not in OPS:
            s = suggest(name, OPS)
            raise EditError(f"ops[{i}]: unknown op '{name}'", "unknown_op", path=f"ops[{i}]",
                            hint=(f"did you mean '{s}'? " if s else "") + f"ops: {', '.join(OPS)}")
        try:
            res = OPS[name]["fn"](proj, work, dict(o))
        except EditError as e:
            e.path = f"ops[{i}]({name})"
            raise
        except KeyError as e:
            raise EditError(f"ops[{i}]({name}): missing required argument {e}", "missing_arg", path=f"ops[{i}]",
                            hint=f"args: {OPS[name]['args']}")
        results.append({"op": name, **(res or {})})
    resolve(work)
    return work, results


def ops_doc() -> dict:
    return {k: {"doc": v["doc"], "args": v["args"]} for k, v in OPS.items()}
