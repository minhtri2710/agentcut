"""`agentcut` CLI. Always prints one JSON object on stdout; progress/logs go to stderr.

Exit codes: 0 ok · 1 edit/validation error (JSON has error.code/hint) · 2 usage error · 3 internal error.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

from . import __version__, api
from .model import EditError, set_dotted


def _val(s: str):
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return s


def kv(pairs: list[str]) -> dict:
    out: dict = {}
    for p in pairs or []:
        if "=" not in p:
            raise EditError(f"expected key=value, got '{p}'", "usage", hint="e.g. text='Hello' duration=3 stroke.width=6")
        k, v = p.split("=", 1)
        set_dotted(out, k.strip(), _val(v))
    return out


def emit(obj, code=0, pretty=None):
    if pretty is None:
        pretty = sys.stdout.isatty()
    print(json.dumps(obj, indent=2 if pretty else None, ensure_ascii=False, default=str))
    sys.exit(code)


def _read_ops(src: str | None, inline: str | None):
    if inline:
        data = json.loads(inline)
    elif src in (None, "-"):
        data = json.loads(sys.stdin.read())
    else:
        if not os.path.exists(src):
            raise EditError(f"ops file not found: {src}", "not_found", hint="pass a JSON file, '-' for stdin, or --ops '[...]'")
        with open(src) as f:
            data = json.load(f)
    if isinstance(data, dict):
        data = data.get("ops", [data])
    return data


def build_parser():
    p = argparse.ArgumentParser(prog="agentcut", description="Agent-first video editor (JSON timeline, CLI + MCP). "
                                "Start with `agentcut guide`.")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("-p", "--project", default=argparse.SUPPRESS,
                        help="project folder (default: search upward from cwd, or $AGENTCUT_PROJECT)")
    common.add_argument("--pretty", action="store_true", default=argparse.SUPPRESS, help="indent JSON output")
    p.add_argument("-p", "--project", help="project folder (default: search upward from cwd, or $AGENTCUT_PROJECT)")
    p.add_argument("--pretty", action="store_true", help="indent JSON output")
    p.add_argument("--version", action="version", version=__version__)
    s = p.add_subparsers(dest="cmd", required=True, metavar="command")

    def sub(name, help_, aliases=()):
        return s.add_parser(name, help=help_, aliases=list(aliases), parents=[common])

    sp = sub("init", "create a project folder")
    sp.add_argument("dir")
    sp.add_argument("--preset", help="reels|tiktok|shorts|youtube|square|portrait|4k|720p")
    sp.add_argument("--width", type=int)
    sp.add_argument("--height", type=int)
    sp.add_argument("--fps", type=float, default=30)
    sp.add_argument("--name")
    sp.add_argument("--empty", action="store_true", help="no default tracks")

    sp = sub("info", "timeline summary + validation", aliases=["show", "status"])
    sp.add_argument("--json", action="store_true", help="include the full timeline JSON")
    sp.add_argument("--text", action="store_true", help="print only the human summary (not JSON)")

    sp = sub("apply", "apply a batch of ops (file, '-' for stdin, or --ops JSON); atomic")
    sp.add_argument("file", nargs="?")
    sp.add_argument("--ops", help="inline JSON list of ops")
    sp.add_argument("--dry-run", action="store_true", help="validate the result without saving")
    sp.add_argument("--allow-invalid", action="store_true", help="save even if the batch adds validation errors")

    sp = sub("op", "run one op: agentcut op add_clip track=main src=a.mp4 duration=3")
    sp.add_argument("name")
    sp.add_argument("args", nargs="*", help="key=value (values parsed as JSON when possible; dotted keys nest)")
    sp.add_argument("--json", help="args as a JSON object")
    sp.add_argument("--dry-run", action="store_true")

    sp = sub("add", "shortcut for op add_clip: agentcut add track=text text='Hi' at=1 enter=pop")
    sp.add_argument("args", nargs="*")
    sp = sub("set", "shortcut for op update_clip: agentcut set txt1 color=red stroke.width=4")
    sp.add_argument("id")
    sp.add_argument("args", nargs="*")
    sp = sub("rm", "remove a clip")
    sp.add_argument("id")
    sp.add_argument("--ripple", action="store_true")

    sub("validate", "check the timeline; errors include path + hint")

    sp = sub("frame", "render one preview frame to PNG")
    sp.add_argument("t", help="time (seconds)")
    sp.add_argument("-o", "--output")
    sp.add_argument("--scale", type=float, default=0.5)
    sp.add_argument("--guides", action="store_true", help="draw safe-area guides")

    sp = sub("sheet", "contact sheet of the timeline (no full render needed)")
    sp.add_argument("--every", type=float)
    sp.add_argument("--times", help="comma-separated seconds")
    sp.add_argument("--count", type=int, default=12)
    sp.add_argument("--cols", type=int, default=4)
    sp.add_argument("--tile-width", type=int, default=360)
    sp.add_argument("--guides", action="store_true")
    sp.add_argument("-o", "--output")

    sp = sub("render", "export the video (mp4/mov/webm/mkv/gif)", aliases=["export"])
    sp.add_argument("-o", "--output")
    sp.add_argument("--from", dest="start", default=0)
    sp.add_argument("--to", dest="end")
    sp.add_argument("--scale", type=float, default=1.0)
    sp.add_argument("--quality", choices=["draft", "standard", "high"], default="standard")
    sp.add_argument("--draft", action="store_true", help="half resolution, fast encode")
    sp.add_argument("--no-sheet", action="store_true", help="skip the post-render contact sheet + loudness check")
    sp.add_argument("--workers", type=int, help="parallel render processes (default: auto)")
    sp.add_argument("--quiet", action="store_true")

    sp = sub("undo", "undo the last N edits")
    sp.add_argument("steps", nargs="?", type=int, default=1)
    sp = sub("redo", "redo N edits")
    sp.add_argument("steps", nargs="?", type=int, default=1)
    sub("history", "list undo/redo labels")

    sp = sub("probe", "media info (duration, size, fps, audio)")
    sp.add_argument("file")
    sp = sub("beats", "beat grid of a music file")
    sp.add_argument("file")
    sp.add_argument("--markers", action="store_true", help="also add beat markers to the project")
    sp.add_argument("--full", action="store_true", help="include every beat (default: trimmed list for brevity)")
    sp = sub("scenes", "shot/scene cuts in a video")
    sp.add_argument("file")
    sp.add_argument("--threshold", type=float, default=0.3)
    sp = sub("silence", "silent vs speech ranges")
    sp.add_argument("file")
    sp.add_argument("--noise-db", type=float, default=-35)
    sp.add_argument("--min-silence", type=float, default=0.4)
    sp = sub("loudness", "EBU R128 loudness of a file")
    sp.add_argument("file")
    sp = sub("transcribe", "word-level transcript (needs agentcut[whisper])")
    sp.add_argument("file")
    sp.add_argument("--language")
    sp = sub("tts", "text to speech file")
    sp.add_argument("text")
    sp.add_argument("-o", "--output", required=True)
    sp.add_argument("--voice")
    sp.add_argument("--rate", type=int)
    sp = sub("voices", "installed TTS voices")
    sp.add_argument("--lang", help="e.g. vi, en")
    sp = sub("fonts", "search installed fonts")
    sp.add_argument("query", nargs="?", default="")

    sub("schema", "timeline format reference")
    sub("ops", "list edit ops with their arguments")
    sub("capabilities", "transitions, animations, filters, presets...", aliases=["caps"])
    sub("guide", "how to use AgentCut (read this first)", aliases=["docs"])
    sub("mcp", "run the MCP server on stdio")
    return p


def main(argv=None):
    parser = build_parser()
    a = parser.parse_args(argv)
    pretty = True if a.pretty else None
    proj = a.project
    try:
        c = a.cmd
        if c == "init":
            res = api.create(a.dir, a.preset, a.width, a.height, a.fps, a.name, a.empty)
        elif c in ("info", "show", "status"):
            res = api.info(proj, "both" if a.json else "summary")
            if a.text:
                print(res["summary"])
                return
        elif c == "apply":
            res = api.apply(proj, _read_ops(a.file, a.ops), dry_run=a.dry_run, allow_invalid=a.allow_invalid)
        elif c == "op":
            args = json.loads(a.json) if a.json else {}
            args.update(kv(a.args))
            res = api.apply(proj, [{"op": a.name, **args}], dry_run=a.dry_run)
        elif c == "add":
            res = api.apply(proj, [{"op": "add_clip", **kv(a.args)}])
        elif c == "set":
            res = api.apply(proj, [{"op": "update_clip", "id": a.id, "set": kv(a.args)}])
        elif c == "rm":
            res = api.apply(proj, [{"op": "remove_clip", "id": a.id, "ripple": a.ripple}])
        elif c == "validate":
            res = api.validate(proj)
            emit({"ok": res["valid"], **res}, 0 if res["valid"] else 1, pretty)
        elif c == "frame":
            res = api.frame(proj, a.t, a.output, a.scale, a.guides)
        elif c == "sheet":
            res = api.sheet(proj, a.times, a.every, a.count, a.cols, a.output, a.tile_width, a.guides)
        elif c in ("render", "export"):
            def prog(i, n):
                if not a.quiet:
                    print(json.dumps({"progress": round(i / n, 3), "frame": i, "frames": n}), file=sys.stderr, flush=True)
            res = api.render(proj, a.output, a.start, a.end, a.scale, a.quality, a.draft, not a.no_sheet, prog, a.workers)
        elif c == "undo":
            res = api.undo(proj, a.steps)
        elif c == "redo":
            res = api.redo(proj, a.steps)
        elif c == "history":
            res = api.history(proj)
        elif c == "probe":
            res = api.probe(a.file)
        elif c == "beats":
            from .analyze import beats
            res = beats(a.file)
            if a.markers:
                api.apply(proj, [{"op": "add_marker", "t": t, "label": f"beat {i}"} for i, t in enumerate(res["beats"])])
                res["markers_added"] = len(res["beats"])
            if not a.full and len(res["beats"]) > 64:
                res["beats_truncated"] = True
                res["beats"] = res["beats"][:64]
        elif c == "scenes":
            from .analyze import scenes
            res = scenes(a.file, a.threshold)
        elif c == "silence":
            from .analyze import silence
            res = silence(a.file, a.noise_db, a.min_silence)
        elif c == "loudness":
            from .analyze import loudness
            res = loudness(a.file)
        elif c == "transcribe":
            from .analyze import transcribe
            res = transcribe(a.file, a.language)
        elif c == "tts":
            from .analyze import tts
            res = tts(a.text, a.output, a.voice, a.rate)
        elif c == "voices":
            res = api.voices(a.lang)
        elif c == "fonts":
            res = api.fonts(a.query)
        elif c == "schema":
            res = api.schema()
        elif c == "ops":
            res = api.ops_doc()
        elif c in ("capabilities", "caps"):
            res = api.capabilities()
        elif c in ("guide", "docs"):
            from .docs import GUIDE
            print(GUIDE.strip())
            return
        elif c == "mcp":
            from .mcp_server import main as mcp_main
            mcp_main()
            return
        else:
            parser.error(f"unknown command {c}")
        emit({"ok": True, **res} if isinstance(res, dict) else {"ok": True, "result": res}, 0, pretty)
    except EditError as e:
        emit({"ok": False, "error": e.to_dict()}, 1, pretty)
    except json.JSONDecodeError as e:
        emit({"ok": False, "error": {"code": "bad_json", "message": str(e), "hint": "ops must be valid JSON"}}, 2, pretty)
    except SystemExit:
        raise
    except KeyboardInterrupt:
        emit({"ok": False, "error": {"code": "interrupted", "message": "interrupted"}}, 130, pretty)
    except Exception as e:
        tb = traceback.format_exc() if os.environ.get("AGENTCUT_DEBUG") else None
        emit({"ok": False, "error": {"code": "internal", "message": f"{type(e).__name__}: {e}", **({"trace": tb} if tb else {}),
                                     "hint": "set AGENTCUT_DEBUG=1 for a traceback"}}, 3, pretty)


if __name__ == "__main__":
    main()
