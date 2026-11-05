"""Project folder: project.json + media/ + renders/ + previews/ + .agentcut/history (undo/redo)."""
from __future__ import annotations

import copy
import json
import os
import shutil
import time
from pathlib import Path

from .model import EditError, PRESETS, new_timeline, resolve, total_duration, validate
from .text import FontIndex

PROJECT_FILE = "project.json"
MAX_HISTORY = 100


def find_project(start: str | Path | None = None) -> Path:
    env = os.environ.get("AGENTCUT_PROJECT")
    if start is None and env:
        start = env
    p = Path(start or os.getcwd()).expanduser().resolve()
    if p.is_file() and p.name.endswith(".json"):
        return p.parent
    cur = p
    while True:
        if (cur / PROJECT_FILE).exists():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    raise EditError(f"no {PROJECT_FILE} found in {p} or its parents", "no_project",
                    hint="create one with `agentcut init <dir> --preset reels` (or pass --project <dir>)")


class Project:
    def __init__(self, root: str | Path):
        self.root = Path(root).expanduser().resolve()
        self.file = self.root / PROJECT_FILE
        if not self.file.exists():
            raise EditError(f"{self.file} does not exist", "no_project", hint="run `agentcut init` first")
        self.hist = self.root / ".agentcut" / "history"
        self.fonts = FontIndex(extra_dirs=[self.root / "fonts"])

    # ------------------------------------------------------------ create/load
    @classmethod
    def create(cls, root: str | Path, preset: str | None = None, width=None, height=None, fps=30, name=None,
               exist_ok=False) -> "Project":
        root = Path(root).expanduser().resolve()
        if (root / PROJECT_FILE).exists() and not exist_ok:
            raise EditError(f"project already exists at {root}", "exists", hint="open it instead, or choose another folder")
        if preset:
            if preset not in PRESETS:
                from .model import suggest
                s = suggest(preset, PRESETS)
                raise EditError(f"unknown preset '{preset}'", "bad_preset",
                                hint=(f"did you mean '{s}'? " if s else "") + f"presets: {', '.join(PRESETS)}")
            width, height = PRESETS[preset]
        width, height = int(width or 1920), int(height or 1080)
        for d in ("media", "renders", "previews", "fonts", ".agentcut/history"):
            (root / d).mkdir(parents=True, exist_ok=True)
        tl = new_timeline(width, height, fps, name or root.name)
        (root / PROJECT_FILE).write_text(json.dumps(tl, indent=2, ensure_ascii=False))
        return cls(root)

    def load(self) -> dict:
        try:
            return json.loads(self.file.read_text())
        except json.JSONDecodeError as e:
            raise EditError(f"project.json is not valid JSON: {e}", "bad_json",
                            hint="fix the file by hand or `agentcut undo` to restore the last good version")

    def save(self, tl: dict, label: str = "edit", snapshot: bool = True):
        resolve(tl)
        if snapshot:
            self._push("undo", self.file.read_text(), label)
            self._clear("redo")
        tmp = self.file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(tl, indent=2, ensure_ascii=False))
        os.replace(tmp, self.file)

    # ------------------------------------------------------------ history
    def _stack(self, name) -> Path:
        d = self.hist / name
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _entries(self, name):
        return sorted(self._stack(name).glob("*.json"))

    def _push(self, name, content: str, label: str):
        d = self._stack(name)
        n = len(self._entries(name))
        ts = f"{time.time():.6f}".replace(".", "")
        (d / f"{ts}.json").write_text(json.dumps({"label": label, "time": time.time(), "timeline": content}))
        ents = self._entries(name)
        for old in ents[:-MAX_HISTORY]:
            old.unlink()

    def _clear(self, name):
        shutil.rmtree(self._stack(name), ignore_errors=True)

    def _pop(self, name):
        ents = self._entries(name)
        if not ents:
            return None
        data = json.loads(ents[-1].read_text())
        ents[-1].unlink()
        return data

    def undo(self, steps: int = 1) -> list[str]:
        labels = []
        for _ in range(steps):
            d = self._pop("undo")
            if d is None:
                break
            self._push("redo", self.file.read_text(), d["label"])
            self.file.write_text(d["timeline"])
            labels.append(d["label"])
        if not labels:
            raise EditError("nothing to undo", "empty_history")
        return labels

    def redo(self, steps: int = 1) -> list[str]:
        labels = []
        for _ in range(steps):
            d = self._pop("redo")
            if d is None:
                break
            self._push("undo", self.file.read_text(), d["label"])
            self.file.write_text(d["timeline"])
            labels.append(d["label"])
        if not labels:
            raise EditError("nothing to redo", "empty_history")
        return labels

    def history(self) -> dict:
        return {"undo": [json.loads(p.read_text())["label"] for p in self._entries("undo")][-20:],
                "redo": [json.loads(p.read_text())["label"] for p in self._entries("redo")][-20:]}

    # ------------------------------------------------------------ paths
    def rel(self, p: str | Path) -> str:
        p = Path(p).expanduser().resolve()
        try:
            return str(p.relative_to(self.root))
        except ValueError:
            return str(p)

    def abs(self, p: str | Path) -> Path:
        p = Path(p).expanduser()
        return p if p.is_absolute() else self.root / p

    def absolutized(self, tl: dict) -> dict:
        t = copy.deepcopy(tl)
        for a in t.get("assets", {}).values():
            if a.get("path"):
                a["path"] = str(self.abs(a["path"]))
        return t

    def validate(self, tl: dict | None = None) -> list[dict]:
        tl = self.load() if tl is None else tl
        return validate(self.absolutized(resolve(copy.deepcopy(tl))), fonts=self.fonts)

    def default_output(self, ext=".mp4", tag="") -> Path:
        name = self.load().get("name", "video")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        return self.root / "renders" / f"{name}{('-' + tag) if tag else ''}-{stamp}{ext}"


def summarize(tl: dict, issues: list[dict] | None = None) -> str:
    """Token-cheap text view of a timeline."""
    from .model import norm_anim, parse_time
    resolve(tl)
    st = tl["settings"]
    lines = [f"{tl.get('name', 'untitled')}: {st['width']}x{st['height']} @{st['fps']}fps, duration {total_duration(tl):.2f}s"
             f", bg {st.get('background', '#000')}, loudness {st.get('loudness')}"]
    if tl.get("assets"):
        lines.append("assets:")
        for aid, a in tl["assets"].items():
            dims = f" {a.get('width')}x{a.get('height')}" if a.get("width") else ""
            dur = f" {a.get('duration'):.2f}s" if a.get("duration") else ""
            au = " +audio" if a.get("has_audio") and a.get("kind") == "video" else ""
            lines.append(f"  {aid}: {a.get('kind')}{dims}{dur}{au}  {Path(a.get('path', '')).name}")
    lines.append("tracks (bottom -> top):")
    for i, tr in enumerate(tl["tracks"]):
        flags = [tr.get("kind", "video")]
        for f in ("magnetic", "muted", "hidden"):
            if tr.get(f):
                flags.append(f)
        if tr.get("role"):
            flags.append(f"role={tr['role']}")
        if tr.get("duck"):
            flags.append(f"duck={tr['duck']}dB")
        lines.append(f"  [{i}] {tr['id']} ({', '.join(flags)}) {len(tr.get('clips', []))} clips")
        for c in tr.get("clips", []):
            s = parse_time(c.get("start", 0))
            d = parse_time(c.get("duration", 0))
            desc = c["type"]
            if c.get("asset"):
                desc += f" {c['asset']}"
                if c.get("in"):
                    desc += f"@{parse_time(c['in']):.2f}"
            if c.get("text"):
                t = c["text"].replace("\n", " / ")
                desc += f' "{t[:40]}{"…" if len(t) > 40 else ""}"'
            if c["type"] == "captions":
                desc += f" style={c.get('style', 'karaoke')} words={len(c.get('words') or [])}" + (" srt" if c.get("srt") else "")
            extras = []
            for key in ("enter", "exit", "transition", "motion"):
                v = norm_anim(c.get(key), 0.5) if key != "motion" else c.get(key)
                if v:
                    extras.append(f"{key}={v['type'] if isinstance(v, dict) else v}")
            if c.get("keyframes"):
                extras.append("kf=" + ",".join(c["keyframes"]))
            if c.get("filters"):
                extras.append("filters=" + ",".join((f.get("type") if isinstance(f, dict) else f) for f in c["filters"]))
            if c.get("speed", 1) != 1:
                extras.append(f"speed={c['speed']}")
            if c.get("volume", 1) != 1:
                extras.append(f"vol={c['volume']}")
            if c.get("position"):
                extras.append(f"pos={c['position']}")
            if c.get("enabled") is False:
                extras.append("DISABLED")
            lines.append(f"      {s:7.2f}–{s + d:7.2f}  {c['id']:<8} {desc}" + (f"  [{' '.join(extras)}]" if extras else ""))
    if tl.get("markers"):
        lines.append("markers: " + ", ".join(f"{m.get('t')}s {m.get('label', '')}".strip() for m in tl["markers"][:40]))
    if issues:
        errs = [i for i in issues if i["level"] == "error"]
        warns = [i for i in issues if i["level"] == "warning"]
        lines.append(f"validation: {len(errs)} errors, {len(warns)} warnings")
        for i in (errs + warns)[:12]:
            lines.append(f"  {i['level']}: {i['path']}: {i['message']}" + (f" ({i['hint']})" if i.get("hint") else ""))
    return "\n".join(lines)
