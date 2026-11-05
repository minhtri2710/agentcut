"""AgentCut MCP server (stdio). Tools mirror the CLI; image tools return real images so the agent can SEE.

Run:  agentcut-mcp            (or: agentcut mcp)
Claude Code:  claude mcp add agentcut -- agentcut-mcp
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import traceback
import uuid
from typing import Any

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.utilities.types import Image

from . import __version__, api
from .docs import GUIDE
from .model import EditError

INSTRUCTIONS = """AgentCut: a JSON-timeline video editor. Read `guide` once. Typical loop:
create_project -> probe_media/analyze_* -> apply_ops (atomic batch) -> validate -> contact_sheet/preview_frame (look!)
-> render (draft first) -> fix with apply_ops/undo -> final render. All times are seconds; tracks[0] is the bottom layer.
`project` args are optional after create_project/open_project (the server remembers the current project)."""

mcp = MCPServer("agentcut", instructions=INSTRUCTIONS, version=__version__)
_state: dict[str, Any] = {"project": os.environ.get("AGENTCUT_PROJECT")}
_jobs: dict[str, dict] = {}


def _proj(project: str | None) -> str | None:
    if project:
        _state["project"] = project
        return project
    if _state["project"]:
        return _state["project"]
    raise EditError("no project selected", "no_project", hint="call create_project or open_project first, or pass project=<folder>")


def _ok(d: dict) -> str:
    return json.dumps({"ok": True, **d}, ensure_ascii=False, default=str)


def _err(e: Exception) -> str:
    if isinstance(e, EditError):
        return json.dumps({"ok": False, "error": e.to_dict()}, ensure_ascii=False)
    tb = traceback.format_exc() if os.environ.get("AGENTCUT_DEBUG") else None
    return json.dumps({"ok": False, "error": {"code": "internal", "message": f"{type(e).__name__}: {e}", **({"trace": tb} if tb else {})}})


async def _run(fn, *a, **kw):
    try:
        return _ok(await asyncio.to_thread(fn, *a, **kw))
    except Exception as e:  # noqa: BLE001
        return _err(e)


def tool(fn):
    return mcp.tool(structured_output=False)(fn)


# ------------------------------------------------------------------ docs
@tool
async def guide() -> str:
    """Read first: how AgentCut works (tracks, magnetic timeline, ops cheat-sheet, vocabulary, good-video rules)."""
    return GUIDE.strip()


@tool
async def capabilities() -> str:
    """Lists every clip type, transition, enter/exit animation, motion preset, filter/look, blend mode, preset and op name."""
    return await _run(api.capabilities)


@tool
async def ops_reference() -> str:
    """Every edit op accepted by apply_ops with its arguments."""
    return await _run(api.ops_doc)


@tool
async def timeline_schema() -> str:
    """The timeline JSON format (fields per clip type, units, enums). Use when editing project.json directly."""
    return await _run(api.schema)


# ------------------------------------------------------------------ project
@tool
async def create_project(path: str, preset: str = "reels", width: int | None = None, height: int | None = None,
                         fps: float = 30, name: str | None = None) -> str:
    """Create a project folder and make it current. preset: reels|tiktok|shorts (1080x1920), youtube (1920x1080),
    square, portrait (1080x1350), 4k, 720p; or pass width/height. Default tracks: main (magnetic), overlay, text, voice, music."""
    async def go():
        res = await asyncio.to_thread(api.create, path, None if width else preset, width, height, fps, name)
        _state["project"] = res["project"]
        return res
    try:
        return _ok(await go())
    except Exception as e:  # noqa: BLE001
        return _err(e)


@tool
async def open_project(path: str) -> str:
    """Select an existing project folder as current and return its summary."""
    _state["project"] = path
    return await _run(api.info, path, "summary")


@tool
async def project_info(project: str | None = None, include_json: bool = False) -> str:
    """Compact text summary of the timeline (tracks bottom->top, clips with times/ids) + validation counts.
    include_json=true also returns the full timeline JSON."""
    try:
        return await _run(api.info, _proj(project), "both" if include_json else "summary")
    except EditError as e:
        return _err(e)


@tool
async def apply_ops(ops: list[dict], project: str | None = None, dry_run: bool = False, allow_invalid: bool = False) -> str:
    """Apply a batch of edit ops atomically (all succeed or nothing changes). Each op is {"op": name, ...args}.
    Main ops: add_clip, add_sequence, update_clip, remove_clip, move_clip, trim_clip, split_clip, duplicate_clip,
    set_keyframes, add_transition, add_captions, add_voiceover, snap_to_beats, remove_silence, import_media,
    add_track, update_track, set_settings, add_marker, replace_timeline. See guide/ops_reference.
    A batch that would introduce validation errors is rejected (nothing changes) with the issues + hints.
    Returns per-op results (new clip ids!) plus validation issues."""
    try:
        return await _run(api.apply, _proj(project), ops, dry_run, None, allow_invalid)
    except EditError as e:
        return _err(e)


@tool
async def validate(project: str | None = None) -> str:
    """Check the timeline. Each issue has level, JSON path, message and usually a hint with the fix."""
    try:
        return await _run(api.validate, _proj(project))
    except EditError as e:
        return _err(e)


@tool
async def undo(steps: int = 1, project: str | None = None) -> str:
    """Undo the last N edit batches."""
    try:
        return await _run(api.undo, _proj(project), steps)
    except EditError as e:
        return _err(e)


@tool
async def redo(steps: int = 1, project: str | None = None) -> str:
    """Redo N undone edit batches."""
    try:
        return await _run(api.redo, _proj(project), steps)
    except EditError as e:
        return _err(e)


# ------------------------------------------------------------------ look
@tool
async def preview_frame(t: float, project: str | None = None, scale: float = 0.4, guides: bool = False) -> list:
    """Render ONE frame at time t (seconds) and return it as an image - use it to check text, layout and transitions.
    guides=true overlays safe areas (red = social UI zones on vertical video)."""
    try:
        res = await asyncio.to_thread(api.frame, _proj(project), t, None, scale, guides)
        return [Image(path=res["image"]), _ok(res)]
    except Exception as e:  # noqa: BLE001
        return [_err(e)]


@tool
async def contact_sheet(project: str | None = None, times: list[float] | None = None, every: float | None = None,
                        count: int = 12, cols: int = 4, guides: bool = False) -> list:
    """Grid of timestamped frames across the timeline (no full render needed). Default: 12 evenly spaced frames.
    Pass times=[...] to inspect specific moments (e.g. around a transition) or every=1.0."""
    try:
        res = await asyncio.to_thread(api.sheet, _proj(project), times, every, count, cols, None, 300, guides)
        return [Image(path=res["image"]), _ok(res)]
    except Exception as e:  # noqa: BLE001
        return [_err(e)]


# ------------------------------------------------------------------ render
def _render_job(job_id, project, kwargs):
    job = _jobs[job_id]

    def prog(i, n):
        job["progress"] = round(i / max(1, n), 3)
    try:
        job["result"] = api.render(project, progress=prog, **kwargs)
        job["status"] = "done"
    except Exception as e:  # noqa: BLE001
        job["status"] = "failed"
        job["error"] = json.loads(_err(e))["error"]
    job["finished"] = time.time()


async def _wait_job(job_id, wait_seconds):
    job = _jobs.get(job_id)
    if not job:
        return json.dumps({"ok": False, "error": {"code": "not_found", "message": f"no job {job_id}"}})
    t_end = time.time() + max(0, wait_seconds)
    while job["status"] == "running" and time.time() < t_end:
        await asyncio.sleep(0.5)
    out = {k: v for k, v in job.items() if k not in ("thread",)}
    out["elapsed"] = round((job.get("finished") or time.time()) - job["started"], 1)
    if job["status"] == "running":
        out["hint"] = f"still rendering; call render_status(job_id='{job_id}')"
    return json.dumps({"ok": job["status"] != "failed", **out}, ensure_ascii=False, default=str)


@tool
async def render(project: str | None = None, output: str | None = None, start: float = 0.0, end: float | None = None,
                 draft: bool = False, quality: str = "standard", scale: float = 1.0, wait_seconds: float = 55) -> str:
    """Export the video (.mp4 default; .mov ProRes, .webm, .mkv, .gif by extension). draft=true renders half-size fast.
    start/end render only a section. Waits up to wait_seconds, otherwise returns a job_id for render_status.
    The result includes a contact sheet path and measured loudness - check them."""
    try:
        proj = _proj(project)
    except EditError as e:
        return _err(e)
    job_id = uuid.uuid4().hex[:8]
    _jobs[job_id] = {"job_id": job_id, "status": "running", "progress": 0.0, "started": time.time(), "project": proj}
    kw = dict(out=output, start=start, end=end, scale=scale, quality=quality, draft=draft)
    th = threading.Thread(target=_render_job, args=(job_id, proj, kw), daemon=True)
    _jobs[job_id]["thread"] = th
    th.start()
    return await _wait_job(job_id, wait_seconds)


@tool
async def render_status(job_id: str, wait_seconds: float = 30) -> str:
    """Status/result of a render job (waits up to wait_seconds for it to finish)."""
    return await _wait_job(job_id, wait_seconds)


@tool
async def view_image(path: str) -> list:
    """Return any local PNG/JPG (e.g. a render's contact_sheet) as an image so you can look at it."""
    if not os.path.exists(path):
        return [json.dumps({"ok": False, "error": {"code": "not_found", "message": path}})]
    return [Image(path=path)]


# ------------------------------------------------------------------ media analysis
@tool
async def probe_media(path: str) -> str:
    """Duration, size, fps, audio presence, alpha of a media file."""
    return await _run(api.probe, path)


@tool
async def analyze_beats(path: str, max_beats: int = 128) -> str:
    """Tempo + beat times + bar starts of a music file (use with snap_to_beats or to time text)."""
    from .analyze import beats

    def go():
        r = beats(path)
        if len(r["beats"]) > max_beats:
            r["beats"], r["truncated"] = r["beats"][:max_beats], True
        return r
    return await _run(go)


@tool
async def analyze_scenes(path: str, threshold: float = 0.3) -> str:
    """Shot boundaries in a video: cut times and shot list [{start,end,duration}]."""
    from .analyze import scenes
    return await _run(scenes, path, threshold)


@tool
async def analyze_silence(path: str, noise_db: float = -35, min_silence: float = 0.4) -> str:
    """Silent and speech ranges in a media file (for trimming dead air; see op remove_silence)."""
    from .analyze import silence
    return await _run(silence, path, noise_db, min_silence)


@tool
async def measure_loudness(path: str) -> str:
    """EBU R128 integrated loudness (LUFS), loudness range and true peak of a file."""
    from .analyze import loudness
    return await _run(loudness, path)


@tool
async def transcribe(path: str, language: str | None = None) -> str:
    """Word-level transcript with timings (requires the optional faster-whisper dependency)."""
    from .analyze import transcribe as tr
    return await _run(tr, path, language)


@tool
async def list_fonts(query: str = "") -> str:
    """Search installed fonts by name (e.g. 'bold', 'Avenir'). Use the returned name in a text clip's font field."""
    return await _run(api.fonts, query)


@tool
async def list_voices(lang: str | None = None) -> str:
    """Installed text-to-speech voices (lang filter like 'vi' or 'en'); use with op add_voiceover."""
    return await _run(api.voices, lang)


def main():
    mcp.run("stdio")


if __name__ == "__main__":
    main()
