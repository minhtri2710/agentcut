"""Media probing and decoding through FFmpeg pipes."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from .model import EditError

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".heic"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aiff", ".aif"}


def need_ffmpeg():
    for b in ("ffmpeg", "ffprobe"):
        if not shutil.which(b):
            raise EditError(f"'{b}' not found on PATH", "missing_dependency", hint="install FFmpeg: brew install ffmpeg")


def probe(path: str | Path) -> dict:
    need_ffmpeg()
    path = Path(path)
    if not path.exists():
        raise EditError(f"file not found: {path}", "not_found")
    out = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise EditError(f"ffprobe cannot read {path}: {out.stderr.strip()[:300]}", "bad_media")
    info = json.loads(out.stdout)
    streams = info.get("streams", [])
    v = next((s for s in streams if s.get("codec_type") == "video"), None)
    a = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = info.get("format", {})
    dur = float(fmt.get("duration") or (v or a or {}).get("duration") or 0)
    ext = path.suffix.lower()
    res: dict = {"path": str(path), "has_audio": a is not None}
    if v is not None:
        w, h = int(v.get("width", 0)), int(v.get("height", 0))
        rot = 0
        for sd in v.get("side_data_list", []) or []:
            if "rotation" in sd:
                rot = int(float(sd["rotation"]))
        rot = int(v.get("tags", {}).get("rotate", rot))
        if abs(rot) % 180 == 90:
            w, h = h, w
        num, den = (v.get("avg_frame_rate") or v.get("r_frame_rate") or "0/1").split("/")
        fps = float(num) / float(den) if float(den or 0) else 0
        nb = int(v.get("nb_frames") or 0)
        still = ext in IMAGE_EXT or (v.get("codec_name") in ("png", "mjpeg", "webp", "bmp", "tiff") and (nb <= 1) and dur < 0.1)
        if ext == ".gif" and nb <= 1:
            still = True
        res.update(kind="image" if still else "video", width=w, height=h,
                   fps=round(fps, 3) if not still else None, codec=v.get("codec_name"),
                   alpha=v.get("pix_fmt", "").startswith(("rgba", "yuva", "argb", "bgra", "ya", "pal8")))
        if not still:
            res["duration"] = round(dur, 3)
    elif a is not None or ext in AUDIO_EXT:
        res.update(kind="audio", duration=round(dur, 3), sample_rate=int(a.get("sample_rate", 0)) if a else None,
                   channels=a.get("channels") if a else None)
    else:
        raise EditError(f"no audio or video stream in {path}", "bad_media")
    return res


def _even(x: float) -> int:
    return max(2, int(round(x)))


def fit_box(src_w, src_h, box_w, box_h, fit: str):
    """Return (scaled_w, scaled_h, out_w, out_h, needs_crop)."""
    if fit == "fill":
        return box_w, box_h, box_w, box_h, False
    if fit == "none":
        return src_w, src_h, src_w, src_h, False
    s = (max if fit == "cover" else min)(box_w / src_w, box_h / src_h)
    sw, sh = max(1, round(src_w * s)), max(1, round(src_h * s))
    if fit == "cover":
        return sw, sh, min(sw, box_w), min(sh, box_h), True
    return sw, sh, sw, sh, False


LOOKS = {
    "warm": "colorbalance=rs=0.08:gs=0.02:bs=-0.08:rm=0.05:bm=-0.05,eq=saturation=1.1",
    "cool": "colorbalance=rs=-0.06:bs=0.08:rm=-0.04:bm=0.06",
    "vintage": "curves=preset=vintage,eq=saturation=0.85",
    "bw": "hue=s=0,eq=contrast=1.15",
    "cinematic": "eq=contrast=1.12:saturation=0.9,colorbalance=rs=-0.05:bs=0.06:rh=0.06:bh=-0.04",
    "teal_orange": "colorbalance=rs=-0.1:bs=0.1:rh=0.1:bh=-0.1,eq=saturation=1.15",
    "vivid": "eq=saturation=1.35:contrast=1.08",
    "fade": "curves=all='0/0.08 1/0.92',eq=saturation=0.85",
}


def filter_chain(filters: list | None) -> list[str]:
    out = []
    for f in filters or []:
        if isinstance(f, str):
            f = {"type": f}
        t = f.get("type")
        if t == "eq":
            out.append("eq=" + ":".join(f"{k}={f[k]}" for k in ("brightness", "contrast", "saturation", "gamma") if k in f) if
                       any(k in f for k in ("brightness", "contrast", "saturation", "gamma")) else "null")
        elif t == "look":
            name = f.get("name", "cinematic")
            if name not in LOOKS:
                raise EditError(f"unknown look '{name}'", "bad_filter", hint=f"looks: {', '.join(LOOKS)}")
            out.append(LOOKS[name])
        elif t == "lut":
            p = str(f["path"]).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
            out.append(f"lut3d=file='{p}'")
        elif t == "blur":
            out.append(f"gblur=sigma={float(f.get('radius', 5)) / 2:.2f}")
        elif t == "sharpen":
            out.append(f"unsharp=5:5:{float(f.get('amount', 1)):.2f}")
        elif t == "grayscale":
            out.append("hue=s=0")
        elif t == "vignette":
            out.append(f"vignette=angle={0.2 + 0.6 * float(f.get('strength', 0.5)):.3f}")
        elif t == "hflip":
            out.append("hflip")
        elif t == "vflip":
            out.append("vflip")
        elif t == "denoise":
            out.append(f"hqdn3d={float(f.get('strength', 4)):.1f}")
        elif t == "chromakey":
            c = str(f.get("color", "#00ff00")).replace("#", "0x")
            out.append(f"format=rgba,chromakey={c}:{float(f.get('similarity', 0.1))}:{float(f.get('blend', 0.05))}")
        elif t == "ffmpeg":
            out.append(str(f["value"]))
        else:
            raise EditError(f"unknown filter '{t}'", "bad_filter")
    return out


class FrameSource:
    """Sequential RGBA reader of a video (or image) scaled/cropped to an exact size.

    read(i) returns local frame i (0-based, at the timeline fps). Sequential reads are
    streamed; backwards or long forward jumps respawn FFmpeg with an input seek.
    """

    def __init__(self, path, *, kind, src_w, src_h, fps, src_in=0.0, speed=1.0, fit="cover",
                 box=(1920, 1080), focus=(0.5, 0.5), crop=None, filters=None, loop=False, src_duration=None):
        self.path, self.kind, self.fps = str(path), kind, fps
        self.src_in, self.speed, self.loop, self.src_duration = src_in, speed, loop, src_duration
        crop = crop or {}
        cl, cr, ct, cb = (float(crop.get(k, 0)) for k in ("left", "right", "top", "bottom"))
        cw, ch = max(2, round(src_w * (1 - cl - cr))), max(2, round(src_h * (1 - ct - cb)))
        vf = []
        if cl or cr or ct or cb:
            vf.append(f"crop={cw}:{ch}:{round(src_w * cl)}:{round(src_h * ct)}")
        vf += filter_chain(filters)
        bw, bh = max(1, round(box[0])), max(1, round(box[1]))
        sw, sh, ow, oh, needs_crop = fit_box(cw, ch, bw, bh, fit)
        vf.append(f"scale={sw}:{sh}:flags=bicubic")
        if needs_crop and (sw > ow or sh > oh):
            fx, fy = float(focus[0]), float(focus[1])
            vf.append(f"crop={ow}:{oh}:{round((sw - ow) * fx)}:{round((sh - oh) * fy)}")
        vf.append("format=rgba")
        self.w, self.h = ow, oh
        self.vf = vf
        self.proc = None
        self.pos = -1
        self.last = None
        self.static = None
        self.eof = False

    def _spawn(self, i: int):
        self.close()
        t0 = self.src_in + i * self.speed / self.fps
        if self.loop and self.src_duration:
            t0 = t0 % self.src_duration
        vf = [f"setpts=(PTS-STARTPTS)/{self.speed}", f"fps={self.fps}"] + self.vf
        args = ["ffmpeg", "-v", "error", "-nostdin"]
        if self.loop:
            args += ["-stream_loop", "-1"]
        args += ["-ss", f"{t0:.6f}", "-i", self.path, "-an", "-sn", "-vf", ",".join(vf),
                 "-f", "rawvideo", "-pix_fmt", "rgba", "-"]
        self.errf = tempfile.TemporaryFile()
        self.proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=self.errf, bufsize=self.w * self.h * 4 * 2)
        self.pos = i - 1
        self.eof = False

    def _read_one(self):
        n = self.w * self.h * 4
        buf = self.proc.stdout.read(n)
        if len(buf) < n:
            self.eof = True
            return None
        return np.frombuffer(buf, np.uint8).reshape(self.h, self.w, 4)

    def read(self, i: int) -> np.ndarray:
        if self.kind == "image":
            if self.static is None:
                args = ["ffmpeg", "-v", "error", "-nostdin", "-i", self.path, "-frames:v", "1",
                        "-vf", ",".join(self.vf), "-f", "rawvideo", "-pix_fmt", "rgba", "-"]
                r = subprocess.run(args, capture_output=True)
                n = self.w * self.h * 4
                if r.returncode != 0 or len(r.stdout) < n:
                    raise EditError(f"cannot decode image {self.path}: {r.stderr.decode()[:300]}", "decode_failed")
                self.static = np.frombuffer(r.stdout[:n], np.uint8).reshape(self.h, self.w, 4)
            return self.static
        if i < 0:
            i = 0
        if self.eof and i > self.pos:
            return self.last if self.last is not None else np.zeros((self.h, self.w, 4), np.uint8)
        if self.proc is None or i <= self.pos or i - self.pos > max(4, int(self.fps * 2)):
            if i == self.pos and self.last is not None:
                return self.last
            self._spawn(i)
        while self.pos < i:
            f = self._read_one()
            if f is None:
                if self.last is None:
                    err = ""
                    if self.proc:
                        self.proc.wait()
                        self.errf.seek(0)
                        err = self.errf.read().decode(errors="replace")[:300]
                    if err:
                        raise EditError(f"decode failed for {self.path}: {err}", "decode_failed")
                    self.last = np.zeros((self.h, self.w, 4), np.uint8)
                return self.last
            self.last = f
            self.pos += 1
        return self.last

    def close(self):
        if self.proc:
            try:
                self.proc.stdout.close()
                self.proc.kill()
                self.proc.wait(timeout=2)
            except Exception:
                pass
            self.proc = None


def media_duration(path) -> float:
    return float(probe(path).get("duration") or 0)
