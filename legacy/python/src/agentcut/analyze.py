"""Media analysis: beats, scene cuts, silence, loudness. Plus TTS and optional transcription."""
from __future__ import annotations

import json
import platform
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from .media import need_ffmpeg, probe
from .model import EditError


def _decode_mono(path, sr=22050) -> np.ndarray:
    need_ffmpeg()
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr),
                        "-f", "f32le", "-"], capture_output=True)
    if r.returncode != 0:
        raise EditError(f"cannot decode audio from {path}: {r.stderr.decode()[:300]}", "decode_failed")
    return np.frombuffer(r.stdout, np.float32)


def beats(path, min_bpm=60.0, max_bpm=200.0) -> dict:
    """Onset-envelope + dynamic-programming beat tracker (Ellis 2007). No librosa needed."""
    sr, hop, n_fft = 22050, 512, 2048
    y = _decode_mono(path, sr)
    if len(y) < n_fft * 4:
        raise EditError("audio too short for beat detection", "too_short")
    win = np.hanning(n_fft).astype(np.float32)
    nfr = 1 + (len(y) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(nfr)[:, None]
    spec = np.abs(np.fft.rfft(y[idx] * win, axis=1))
    # mel-ish weighting: compress, emphasise < 8 kHz
    logm = np.log1p(100 * spec[:, : int(8000 / (sr / n_fft))])
    flux = np.maximum(0, np.diff(logm, axis=0)).mean(1)
    flux = np.concatenate([[0], flux])
    flux -= np.convolve(flux, np.ones(16) / 16, mode="same")  # remove slow trend
    onset = np.maximum(flux, 0)
    if onset.max() > 0:
        onset /= onset.std() + 1e-9
    fps = sr / hop
    # tempo via autocorrelation with a log-normal prior around 120 BPM
    ac = np.correlate(onset, onset, mode="full")[len(onset) - 1:]
    lags = np.arange(len(ac))
    lo, hi = int(fps * 60 / max_bpm), int(fps * 60 / min_bpm)
    bpm = 60 * fps / np.maximum(lags[lo:hi], 1)
    prior = np.exp(-0.5 * (np.log2(bpm / 120) / 0.9) ** 2)
    period = lo + int(np.argmax(ac[lo:hi] * prior))
    tempo = 60 * fps / period
    # DP beat tracking
    alpha, n = 100.0, len(onset)
    score = onset.copy()
    back = np.full(n, -1)
    pr = np.arange(-2 * period, -period // 2 + 1)
    txcost = -alpha * np.log(-pr / period) ** 2
    for i in range(n):
        j = i + pr
        ok = j >= 0
        if not ok.any():
            continue
        cand = score[j[ok]] + txcost[ok]
        k = int(np.argmax(cand))
        score[i] = onset[i] + cand[k]
        back[i] = j[ok][k]
    tail = score[max(0, n - period * 2):]
    i = max(0, n - period * 2) + int(np.argmax(tail))
    bt = []
    while i >= 0:
        bt.append(i)
        i = back[i]
    bt = bt[::-1]
    # sub-frame refinement: snap to the local onset peak (+-2 frames), parabolic interpolation,
    # and convert frame index -> time at the analysis window centre.
    refined = []
    for b in bt:
        lo_, hi_ = max(1, b - 2), min(n - 2, b + 2)
        j = lo_ + int(np.argmax(onset[lo_:hi_ + 1])) if hi_ >= lo_ else b
        y0, y1, y2 = onset[j - 1], onset[j], onset[j + 1] if j + 1 < n else onset[j]
        den = y0 - 2 * y1 + y2
        frac = 0.5 * (y0 - y2) / den if abs(den) > 1e-9 else 0.0
        refined.append(j + max(-0.5, min(0.5, frac)))
    bt = [int(round(x)) for x in refined]
    times = [round(float((x * hop + n_fft / 2) / sr), 3) for x in refined]
    # drop weak leading beats before the music starts
    thr = 0.1 * float(np.median(onset[bt])) if bt else 0
    while times and onset[bt[0]] < thr:
        bt.pop(0)
        times.pop(0)
    strength = onset[bt] if bt else np.array([])
    # bar phase: choose offset (0..3) whose beats have the most energy
    phase = int(np.argmax([strength[o::4].sum() if len(strength) else 0 for o in range(4)])) if len(times) >= 8 else 0
    if len(times) >= 4:
        tempo = 60.0 / float(np.median(np.diff(times)))
    dur = len(y) / sr
    return {"source": str(path), "tempo_bpm": round(float(tempo), 2), "beat_interval": round(60 / tempo, 4),
            "count": len(times), "beats": times, "bars": times[phase::4], "duration": round(dur, 3)}


def scenes(path, threshold: float = 0.3) -> dict:
    need_ffmpeg()
    info = probe(path)
    r = subprocess.run(["ffmpeg", "-v", "info", "-nostdin", "-i", str(path), "-an", "-vf",
                        f"scale=320:-2,select='gt(scene,{threshold})',showinfo", "-f", "null", "-"],
                       capture_output=True, text=True)
    cuts = [round(float(m), 3) for m in re.findall(r"pts_time:([\d.]+)", r.stderr)]
    dur = info.get("duration") or 0
    bounds = [0.0] + cuts + [dur]
    shots = [{"start": bounds[i], "end": bounds[i + 1], "duration": round(bounds[i + 1] - bounds[i], 3)}
             for i in range(len(bounds) - 1) if bounds[i + 1] - bounds[i] > 0.05]
    return {"source": str(path), "threshold": threshold, "cuts": cuts, "shots": shots, "duration": dur}


def silence(path, noise_db: float = -35, min_silence: float = 0.4) -> dict:
    need_ffmpeg()
    info = probe(path)
    if not info.get("has_audio") and info.get("kind") != "audio":
        raise EditError("file has no audio", "no_audio")
    r = subprocess.run(["ffmpeg", "-v", "info", "-nostdin", "-i", str(path), "-vn", "-af",
                        f"silencedetect=noise={noise_db}dB:d={min_silence}", "-f", "null", "-"],
                       capture_output=True, text=True)
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", r.stderr)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", r.stderr)]
    dur = float(info.get("duration") or 0)
    sil = []
    for i, s in enumerate(starts):
        e = ends[i] if i < len(ends) else dur
        sil.append([round(max(0, s), 3), round(e, 3)])
    speech, t = [], 0.0
    for s, e in sil:
        if s - t > 0.05:
            speech.append([round(t, 3), round(s, 3)])
        t = e
    if dur - t > 0.05:
        speech.append([round(t, 3), round(dur, 3)])
    return {"source": str(path), "noise_db": noise_db, "min_silence": min_silence, "silences": sil,
            "speech": speech, "duration": dur}


def loudness(path) -> dict:
    need_ffmpeg()
    r = subprocess.run(["ffmpeg", "-v", "info", "-nostdin", "-i", str(path), "-vn", "-af", "ebur128=peak=true",
                        "-f", "null", "-"], capture_output=True, text=True)
    txt = r.stderr[r.stderr.rfind("Summary:"):]
    def grab(label):
        m = re.search(label + r":\s+(-?[\d.]+|-inf)", txt)
        return float(m.group(1)) if m and m.group(1) != "-inf" else None
    return {"source": str(path), "integrated_lufs": grab("I"), "range_lu": grab("LRA"), "true_peak_dbfs": grab("Peak")}


# ---------------------------------------------------------------- TTS
def tts_voices() -> list[dict]:
    if shutil.which("say"):
        r = subprocess.run(["say", "-v", "?"], capture_output=True, text=True)
        out = []
        for line in r.stdout.splitlines():
            m = re.match(r"^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#\s*(.*)$", line)
            if m:
                full = m.group(1).strip()
                short = re.sub(r"\s*\(.*\)$", "", full)
                out.append({"name": short, "full_name": full, "lang": m.group(2), "sample": m.group(3)})
        return out
    if shutil.which("espeak-ng") or shutil.which("espeak"):
        return [{"name": "default", "lang": "en", "sample": "espeak"}]
    return []


def tts(text: str, out_path, voice: str | None = None, rate: int | None = None) -> dict:
    """Synthesize speech to out_path (.wav/.m4a). macOS `say`, else espeak."""
    need_ffmpeg()
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        raw = Path(tmp) / "tts.aiff"
        if shutil.which("say"):
            cmd = ["say", "-o", str(raw)]
            if voice:
                vs = tts_voices()
                names = [v["name"] for v in vs] + [v.get("full_name", "") for v in vs]
                if voice not in names:
                    from .model import suggest
                    s = suggest(voice, names)
                    raise EditError(f"voice '{voice}' not installed", "bad_voice",
                                    hint=(f"did you mean '{s}'? " if s else "") + "list voices with `agentcut voices` (Vietnamese: 'Linh')")
                cmd += ["-v", voice]
            if rate:
                cmd += ["-r", str(rate)]
            r = subprocess.run(cmd + [text], capture_output=True, text=True)
        elif shutil.which("espeak-ng") or shutil.which("espeak"):
            raw = Path(tmp) / "tts.wav"
            exe = shutil.which("espeak-ng") or shutil.which("espeak")
            cmd = [exe, "-w", str(raw)] + (["-v", voice] if voice else []) + (["-s", str(rate)] if rate else [])
            r = subprocess.run(cmd + [text], capture_output=True, text=True)
        else:
            raise EditError("no TTS engine found", "missing_dependency",
                            hint=f"on {platform.system()} install espeak-ng, or generate audio elsewhere and import it")
        if r.returncode != 0:
            raise EditError(f"tts failed: {r.stderr[:300]}", "tts_failed")
        c = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-ar", "48000", "-ac", "2", str(out_path)],
                           capture_output=True, text=True)
        if c.returncode != 0:
            raise EditError(f"tts convert failed: {c.stderr[:300]}", "tts_failed")
    info = probe(out_path)
    return {"path": str(out_path), "duration": info.get("duration"), "voice": voice}


def transcribe(path, language: str | None = None, model: str = "small") -> dict:
    """Word-level transcription via faster-whisper (optional dependency)."""
    try:
        from faster_whisper import WhisperModel  # type: ignore
    except ImportError:
        raise EditError("transcription needs faster-whisper", "missing_dependency",
                        hint="uv pip install 'agentcut[whisper]'  (or supply an .srt and use add_captions srt=...)")
    m = WhisperModel(model, device="auto", compute_type="int8")
    segs, info = m.transcribe(str(path), language=language, word_timestamps=True, vad_filter=True)
    words, text = [], []
    for s in segs:
        text.append(s.text.strip())
        for w in s.words or []:
            words.append({"text": w.word.strip(), "start": round(w.start, 3), "end": round(w.end, 3)})
    return {"source": str(path), "language": info.language, "text": " ".join(text), "words": words}


def dumps(d) -> str:
    return json.dumps(d, ensure_ascii=False)
