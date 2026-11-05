"""End-to-end smoke test: generates synthetic media, exercises every op through the CLI, renders.

Run:  .venv/bin/python tests/smoke_test.py      (needs ffmpeg on PATH)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BIN = Path(sys.executable).parent / ("agentcut.exe" if os.name == "nt" else "agentcut")


def sh(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args], check=True)


def cli(*args, ok=True, stdin=None):
    r = subprocess.run([str(BIN), *map(str, args)], capture_output=True, text=True, input=stdin)
    try:
        out = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise AssertionError(f"non-JSON output for {args}: {r.stdout[:300]} {r.stderr[-500:]}")
    if ok and not out.get("ok"):
        raise AssertionError(f"{args} failed: {json.dumps(out, ensure_ascii=False)[:800]}")
    return out


def main():
    tmp = Path(tempfile.mkdtemp(prefix="agentcut-smoke-"))
    m = tmp / "media"
    m.mkdir()
    sh("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6", "-f", "lavfi", "-i",
       "sine=frequency=440:duration=6", "-shortest", "-pix_fmt", "yuv420p", m / "a.mp4")
    sh("-f", "lavfi", "-i", "color=c=0x00ff00:size=640x360:rate=30:duration=3", "-vf",
       "drawbox=x=200:y=100:w=240:h=160:color=red:t=fill", "-pix_fmt", "yuv420p", m / "green.mp4")
    sh("-f", "lavfi", "-i", "gradients=size=800x800:n=4", "-frames:v", "1", m / "p.png")
    sh("-f", "lavfi", "-i", "aevalsrc='sin(2*PI*60*t)*exp(-25*mod(t,0.5))':s=44100:d=12", "-ac", "2", m / "beat.wav")
    # speech-ish: tone, 1.2 s silence, tone
    sh("-f", "lavfi", "-i", "sine=f=300:d=1.5", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.2", "-f", "lavfi", "-i",
       "sine=f=300:d=1.5", "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", m / "talk.wav")
    sh("-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4.2", "-i", m / "talk.wav", "-shortest",
       "-pix_fmt", "yuv420p", m / "talk.mp4")
    (m / "subs.srt").write_text("1\n00:00:00,200 --> 00:00:01,500\nXin chào thế giới\n\n2\n00:00:01,600 --> 00:00:03,000\nĐây là phụ đề\n",
                                encoding="utf-8")
    P = tmp / "proj"
    cli("init", P, "--preset", "square")
    os.chdir(P)
    beats = cli("beats", m / "beat.wav")
    assert abs(beats["tempo_bpm"] - 120) < 2, beats["tempo_bpm"]
    ops = [
        {"op": "add_clip", "track": "main", "src": str(m / "a.mp4"), "in": 0.5, "duration": 2.5, "filters": [{"type": "look", "name": "cinematic"}]},
        {"op": "add_clip", "track": "main", "src": str(m / "p.png"), "duration": 2, "transition": "dip_black", "motion": "pan_right"},
        {"op": "add_clip", "track": "main", "type": "color", "gradient": {"colors": ["#ff0080", "#00e0ff"], "angle": 45}, "duration": 2, "transition": "wipe_up"},
        {"op": "add_clip", "track": "main", "src": str(m / "talk.mp4"), "transition": {"type": "zoom", "duration": 0.4}},
        {"op": "add_clip", "track": "overlay", "src": str(m / "green.mp4"), "at": 1, "duration": 2, "size": ["40%", "40%"],
         "fit": "contain", "filters": [{"type": "chromakey", "color": "#00ff00", "similarity": 0.2}], "position": "bottom_left"},
        {"op": "add_clip", "track": "overlay", "type": "shape", "shape": "rect", "size": ["80%", 12], "fill": "#FFD60A", "radius": 6,
         "at": 0, "duration": 6, "y": "92%", "keyframes": {"scale_x": [[0, 0], [6, 1]]}},
        {"op": "add_clip", "track": "overlay", "type": "shape", "shape": "circle", "size": [200, 200], "fill": "#ffffff", "blend": "overlay",
         "at": 2, "duration": 2, "x": "70%", "y": "30%", "keyframes": {"rotation": [[0, 0], [2, 180, "ease_in_out"]]}},
        {"op": "add_clip", "track": "text", "text": "Typewriter thử nghiệm", "at": 0, "duration": 3, "enter": "typewriter", "align": "left",
         "position": "top_left", "font_size": 60, "letter_spacing": 2},
        {"op": "add_clip", "track": "text", "text": "words reveal effect", "at": 3, "duration": 2, "enter": "words", "exit": "wipe_right"},
        {"op": "add_captions", "srt": str(m / "subs.srt"), "at": 5, "style": "word", "highlight_color": "#FFD60A"},
        {"op": "add_clip", "track": "music", "src": str(m / "beat.wav"), "volume": 0.6, "fade_in": 0.5, "fade_out": 1,
         "keyframes": {"volume": [[0, 0.5], [4, 1]]}},
    ]
    r = cli("apply", "--ops", json.dumps(ops))
    ids = {x.get("id") for x in r["results"]}
    assert {"vid1", "img1", "col1", "vid2", "shp1", "cap1"} <= ids, ids
    # invalid batch must be rejected atomically
    bad = cli("apply", "--ops", json.dumps([{"op": "add_clip", "track": "text", "text": "x", "enter": "fade_inn"}]), ok=False)
    assert bad["error"]["code"] == "validation_failed" and "fade" in bad["error"].get("hint", ""), bad
    assert cli("op", "updat_clip", "id=vid1", ok=False)["error"]["hint"].startswith("did you mean 'update_clip'")
    # editing ops
    cli("set", "img1", "motion=ken_burns", "fit=contain")
    sp = cli("op", "split_clip", "id=vid1", "at=1.2")["results"][0]
    cli("op", "trim_clip", f"id={sp['right']}", "trim_start=0.2")
    cli("op", "remove_silence", "id=vid2", "min_silence=0.5")
    cli("op", "snap_to_beats", "track=main", f"beats={m / 'beat.wav'}", "every=2")
    cli("op", "move_clip", "id=col1", "index=0")
    cli("op", "duplicate_clip", "id=txt1", "at=6")
    cli("op", "add_marker", "t=1.5", "label=check")
    vo = cli("op", "add_voiceover", "text=Xin chào, đây là AgentCut", "voice=Linh", "captions=true", "at=0.5", ok=False)
    if not vo.get("ok"):
        print("  (voiceover skipped:", vo["error"]["message"], ")")
    info = cli("info")
    print(info["summary"])
    assert info["errors"] == 0, info
    # undo / redo
    d0 = cli("info")["duration"]
    cli("rm", "col1")
    cli("undo")
    assert cli("info")["duration"] == d0
    cli("redo")
    cli("undo")
    # look
    fr = cli("frame", "1.5", "--guides")
    assert Path(fr["image"]).exists()
    sh_ = cli("sheet", "--every", "1")
    assert Path(sh_["image"]).exists()
    # renders
    out = cli("render", "-o", "renders/full.mp4", "--quiet")
    assert out["frames"] > 0 and Path(out["contact_sheet"]).exists()
    assert out["loudness"]["integrated_lufs"] is not None and abs(out["loudness"]["integrated_lufs"] + 14) < 2.5, out["loudness"]
    sec = cli("render", "-o", "renders/part.webm", "--from", "1", "--to", "3", "--draft", "--no-sheet", "--quiet", "--workers", "1")
    assert abs(sec["duration"] - 2) < 0.05
    cli("render", "-o", "renders/clip.gif", "--to", "2", "--no-sheet", "--quiet")
    cli("render", "-o", "renders/master.mov", "--to", "1", "--no-sheet", "--quiet", "--scale", "0.5")
    for f in ("full.mp4", "part.webm", "clip.gif", "master.mov"):
        assert (P / "renders" / f).stat().st_size > 1000, f
    probe = cli("probe", "renders/full.mp4")
    assert probe["width"] == 1080 and probe["has_audio"]
    print(f"\nOK - smoke test passed in {tmp}")
    if "--keep" not in sys.argv:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
