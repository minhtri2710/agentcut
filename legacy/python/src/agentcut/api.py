"""High-level API shared by the CLI and the MCP server. Every function returns JSON-able dicts."""
from __future__ import annotations

import time
from pathlib import Path

from . import analyze, ops as ops_mod
from .media import probe as _probe
from .model import EditError, PRESETS, parse_time, schema_doc, total_duration
from .project import Project, find_project, summarize
from .render import contact_sheet, render_frame, render_video, save_png
from .text import FONTS


def open_project(path=None) -> Project:
    return Project(find_project(path))


def _issues_brief(issues, limit=15):
    errs = [i for i in issues if i["level"] == "error"]
    warns = [i for i in issues if i["level"] == "warning"]
    return {"errors": len(errs), "warnings": len(warns), "issues": (errs + warns)[:limit]}


def create(path, preset=None, width=None, height=None, fps=30, name=None, empty=False) -> dict:
    p = Project.create(path, preset=preset, width=width, height=height, fps=fps, name=name)
    tl = p.load()
    if empty:
        tl["tracks"] = []
        p.save(tl, "init", snapshot=False)
    return {"project": str(p.root), "settings": tl["settings"], "tracks": [t["id"] for t in tl["tracks"]],
            "next": "add media with apply_ops [{op:'add_clip', track:'main', src:'/path/clip.mp4'}], then preview_frame / contact_sheet, then render"}


def info(project=None, fmt="summary") -> dict:
    p = open_project(project)
    tl = p.load()
    issues = p.validate(tl)
    out = {"project": str(p.root), "duration": total_duration(tl), **_issues_brief(issues)}
    if fmt in ("summary", "both"):
        out["summary"] = summarize(tl)
    if fmt in ("json", "both"):
        out["timeline"] = tl
    return out


def apply(project, ops: list[dict], dry_run=False, label=None, allow_invalid=False) -> dict:
    """Atomic batch. Rejected (nothing saved) if it introduces new validation errors, unless allow_invalid."""
    p = open_project(project)
    tl = p.load()
    if isinstance(ops, dict):
        ops = ops.get("ops", [ops])
    before = {(i["path"].split("<")[0], i["message"]) for i in p.validate(tl) if i["level"] == "error"}
    new, results = ops_mod.apply_ops(p, tl, ops)
    issues = p.validate(new)
    added = [i for i in issues if i["level"] == "error" and (i["path"].split("<")[0], i["message"]) not in before]
    if added and not allow_invalid:
        raise EditError(f"batch rejected: it would add {len(added)} validation error(s); nothing was changed",
                        "validation_failed", hint=added[0].get("hint") or "fix the listed fields and resend the whole batch",
                        details={"issues": added[:15]})
    if not dry_run:
        p.save(new, label or ", ".join(sorted({o.get('op', '?') for o in ops}))[:120])
    return {"ok": True, "dry_run": dry_run, "results": results, "duration": total_duration(new), **_issues_brief(issues)}


def validate(project=None) -> dict:
    p = open_project(project)
    issues = p.validate()
    return {"valid": not any(i["level"] == "error" for i in issues), **_issues_brief(issues, 100)}


def frame(project, t, out=None, scale=0.5, guides=False) -> dict:
    p = open_project(project)
    tl = p.load()
    _require_valid(p, tl)
    t = parse_time(t)
    arr = render_frame(p.absolutized(tl), p.root, t, scale=scale, guides=guides, fonts=p.fonts)
    out = Path(out) if out else p.root / "previews" / f"frame-{t:07.2f}s.png"
    save_png(arr, out)
    return {"image": str(out), "t": t, "width": arr.shape[1], "height": arr.shape[0]}


def sheet(project, times=None, every=None, count=12, cols=4, out=None, tile_width=360, guides=False) -> dict:
    p = open_project(project)
    tl = p.load()
    _require_valid(p, tl)
    T = total_duration(tl)
    if times:
        ts = [parse_time(x) for x in (times.split(",") if isinstance(times, str) else times)]
    elif every:
        ts, t = [], 0.0
        while t < T and len(ts) < 64:
            ts.append(round(t, 3))
            t += float(every)
    else:
        n = max(1, int(count))
        ts = [round(T * (i + 0.5) / n, 3) for i in range(n)]
    arr = contact_sheet(p.absolutized(tl), p.root, ts, cols=cols, tile_w=tile_width, guides=guides, fonts=p.fonts)
    out = Path(out) if out else p.root / "previews" / f"sheet-{time.strftime('%H%M%S')}.png"
    save_png(arr, out)
    return {"image": str(out), "times": ts, "duration": T}


def _require_valid(p, tl):
    errs = [i for i in p.validate(tl) if i["level"] == "error"]
    if errs:
        e = errs[0]
        raise EditError(f"timeline has {len(errs)} error(s); first: {e['path']}: {e['message']}", "invalid_timeline",
                        hint=e.get("hint") or "run validate for the full list")


def render(project=None, out=None, start=0.0, end=None, scale=1.0, quality="standard", draft=False,
           sheet_after=True, progress=None, workers=None) -> dict:
    p = open_project(project)
    tl = p.load()
    _require_valid(p, tl)
    if draft:
        scale, quality = min(scale, 0.5), "draft"
    out = Path(out) if out else p.default_output(".mp4", "draft" if draft else "")
    if not out.is_absolute():
        out = Path.cwd() / out
    res = render_video(p.absolutized(tl), p.root, out, start=parse_time(start or 0),
                       end=parse_time(end) if end is not None else None, scale=scale, quality=quality,
                       progress=progress, fonts=p.fonts, workers=workers)
    if sheet_after and out.suffix.lower() != ".gif":
        try:
            T = res["duration"]
            ts = [round(parse_time(start or 0) + T * (i + 0.5) / 8, 3) for i in range(8)]
            arr = contact_sheet(p.absolutized(tl), p.root, ts, cols=4, tile_w=320, fonts=p.fonts)
            sp = out.with_suffix(".sheet.png")
            save_png(arr, sp)
            res["contact_sheet"] = str(sp)
        except Exception as e:  # never fail the render because of the sheet
            res["contact_sheet_error"] = str(e)
        try:
            res["loudness"] = analyze.loudness(out)
        except Exception:
            pass
    return res


def undo(project=None, steps=1):
    p = open_project(project)
    return {"undone": p.undo(steps), "duration": total_duration(p.load())}


def redo(project=None, steps=1):
    p = open_project(project)
    return {"redone": p.redo(steps), "duration": total_duration(p.load())}


def history(project=None):
    return open_project(project).history()


def probe(path):
    return _probe(path)


def fonts(query="", limit=40):
    return {"fonts": [{"name": f["name"], "family": f["family"], "style": f["style"]} for f in FONTS.search(query, limit)]}


def voices(lang=None):
    vs = analyze.tts_voices()
    if lang:
        vs = [v for v in vs if v["lang"].lower().startswith(lang.lower())]
    return {"voices": vs}


def capabilities():
    from . import model
    return {
        "clip_types": model.CLIP_TYPES,
        "enter_exit_animations": model.ENTER_EXIT,
        "transitions": model.TRANSITIONS,
        "motions": model.MOTIONS,
        "easings": model.EASINGS,
        "filters": model.FILTERS,
        "looks": list(__import__("agentcut.media", fromlist=["LOOKS"]).LOOKS),
        "blend_modes": model.BLENDS,
        "positions": model.POSITIONS,
        "caption_styles": model.CAPTION_STYLES,
        "animatable": model.ANIMATABLE,
        "presets": {k: f"{w}x{h}" for k, (w, h) in PRESETS.items()},
        "output_formats": [".mp4", ".mov (ProRes)", ".webm (VP9)", ".mkv", ".gif"],
        "ops": list(ops_mod.OPS),
    }


def schema():
    return schema_doc()


def ops_doc():
    return ops_mod.ops_doc()
