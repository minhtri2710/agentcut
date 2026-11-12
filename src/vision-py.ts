// Python helper for the vision features, run through `uv run --with <pkgs>` (see vision.ts). Kept as a TS string so the
// same script ships with src/, dist/ and the compiled binary. It reads one JSON job from argv[1], prints one JSON result.
// Frames are decoded by FFmpeg (same decoder as the renderer) and handed over as raw bytes; progress lines go to stderr.
export const VISION_PY = String.raw`
import json, os, signal, stat, subprocess, sys, tempfile, threading

_kids, _lock = [], threading.Lock()
def _spawn(args, **kw):  # every child goes through here so a stop can kill it; while a stop runs this blocks until the process exits
    with _lock:
        p = subprocess.Popen(args, **kw); _kids.append(p); return p

def _stop():  # kill and reap our own ffmpeg children, then leave at once; the lock is held to the end, so no child starts meanwhile
    with _lock:
        for p in _kids:
            try: p.kill()
            except OSError: pass
        for p in _kids:
            try: p.wait()
            except OSError: pass
        os._exit(143)

def _stop_on_eof():  # vision.ts closes our stdin to stop us (or dies, which closes it)
    try:
        while os.read(0, 65536): pass  # the raw fd: sys.stdin.buffer would hold its lock and abort the interpreter at a normal exit
    except Exception: pass
    _stop()
# SIGTERM (an abort, possibly forwarded by uv) stops us the same way. The handler runs on the main thread, which may hold the lock
# inside _spawn, so it hands the stop to a thread; that thread is not a daemon, so a main thread that exits first still waits for it.
signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=_stop).start())
# Armed only when stdin is a pipe or socket, i.e. vision.ts holds the other end. If uv handed us /dev/null or a tty instead, EOF
# would arrive at once and kill every run: then only the kill / EPIPE path stops us.
try: _m = os.fstat(0).st_mode
except OSError: _m = 0
if stat.S_ISFIFO(_m) or stat.S_ISSOCK(_m): threading.Thread(target=_stop_on_eof, daemon=True).start()

def frames(path, start, dur, fps, w, h, fmt="bgr24"):
    args = ["ffmpeg", "-v", "error", "-nostdin"]
    if start is not None: args += ["-ss", "%.6f" % start]
    if dur is not None: args += ["-t", "%.6f" % dur]
    vf = ("fps=%.6f," % float(fps) if fps else "") + "scale=%d:%d:flags=bicubic" % (w, h)
    args += ["-protocol_whitelist", "file,pipe", "-i", path, "-an", "-sn", "-vf", vf, "-f", "rawvideo", "-pix_fmt", fmt, "-"]
    errf = tempfile.TemporaryFile()  # a file, not a pipe: ffmpeg never blocks on a full stderr pipe while we read stdout
    p = _spawn(args, stdout=subprocess.PIPE, stderr=errf)
    n = w * h * (3 if fmt in ("bgr24", "rgb24") else 4)
    import numpy as np
    i = 0
    while True:
        b = p.stdout.read(n)
        if len(b) < n: break
        yield np.frombuffer(b, np.uint8).reshape(h, w, -1)
        i += 1
        sys.stderr.write("AGENTCUT_PROGRESS %d\n" % i); sys.stderr.flush()  # frames done, read by vision.ts
    p.stdout.close(); p.wait(); errf.seek(0); err = errf.read().decode("utf8", "replace")
    if p.returncode != 0: raise SystemExit("ffmpeg exited %s: %s" % (p.returncode, err.strip()[:400]))  # a decoder that died silently still means a short result

def subject(j):
    import cv2, numpy as np
    w, h = j["w"], j["h"]
    face_min = float(j["face_min"])
    det = cv2.FaceDetectorYN.create(j["face_model"], "", (w, h), face_min, 0.3, 5000)  # YuNet: score threshold, NMS threshold, top-k before NMS
    sal = cv2.saliency.StaticSaliencyFineGrained_create()  # spectral residual aliases on flat footage
    c01 = lambda v: min(1.0, max(0.0, v))  # a face box may reach past the frame edge
    out = []
    for i, f in enumerate(frames(j["path"], j.get("start"), j.get("duration"), j.get("fps"), w, h)):
        t = (j.get("start") or 0) + i / j["fps"] if j.get("fps") else 0
        _, fs = det.detect(f)  # None, or one row per face: x, y, w, h, ten landmark values, score
        fs = [r for r in (fs if fs is not None else []) if float(r[14]) >= face_min]
        if fs:
            r = max(fs, key=lambda r: (r[2] * r[3], -r[0], -r[1]))  # the largest face; ties go to the left, then the top
            x, y, fw, fh = (float(v) for v in r[:4])
            out.append({"t": round(t, 4), "x": round(c01((x + fw / 2) / w), 4), "y": round(c01((y + fh / 2) / h), 4),
                        "w": round(c01(fw / w), 4), "h": round(c01(fh / h), 4), "kind": "face", "score": round(float(r[14]), 4), "faces": len(fs)})
            continue
        ok, m = sal.computeSaliency(f)
        if not ok: out.append({"t": round(t, 4), "kind": "none", "score": 0.0}); continue
        m = cv2.normalize(m, None, 0, 255, cv2.NORM_MINMAX).astype("uint8")
        thr, mask = cv2.threshold(m, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        wt = (m.astype("float64") * (mask > 0))
        s = wt.sum()
        if s <= 0: out.append({"t": round(t, 4), "kind": "none", "score": 0.0}); continue
        ys, xs = np.mgrid[0:h, 0:w]
        cx, cy = (wt * xs).sum() / s / w, (wt * ys).sum() / s / h
        out.append({"t": round(t, 4), "x": round(float(cx + 0.5 / w), 4), "y": round(float(cy + 0.5 / h), 4),
                    "kind": "saliency", "score": round(float(m[mask > 0].mean() / 255), 4)})
    return {"samples": out}

def track(j):
    import cv2
    w, h, fps, s = j["w"], j["h"], j["fps"], j["start"]
    fr = list(frames(j["path"], s, j["duration"], fps, w, h))
    if not fr: raise SystemExit("no frames decoded in the tracking range")
    i0 = min(len(fr) - 1, max(0, round((j["at"] - s) * fps)))
    bx, by, bw, bh = j["box"]
    box = (int(round(bx * w)), int(round(by * h)), max(4, int(round(bw * w))), max(4, int(round(bh * h))))
    make = cv2.TrackerKCF_create if j.get("tracker") == "kcf" else cv2.TrackerCSRT_create
    res = [None] * len(fr)
    res[i0] = (box, True)
    for step in (1, -1):
        tr = make(); tr.init(fr[i0], box)
        i, last = i0 + step, box
        while 0 <= i < len(fr):
            ok, b = tr.update(fr[i])
            if ok: last = tuple(int(v) for v in b)
            res[i] = (last, bool(ok)); i += step
    out = []
    for i, (b, ok) in enumerate(res):
        x, y, bw2, bh2 = b
        out.append({"t": round(s + i / fps, 4), "x": round((x + bw2 / 2) / w, 4), "y": round((y + bh2 / 2) / h, 4),
                    "w": round(bw2 / w, 4), "h": round(bh2 / h, 4), "ok": ok})
    return {"samples": out, "init_index": i0}

def matte(j):
    if not j.get("allow_download"):  # no model fetch without consent: rembg's downloads go through these proxies, so a missing or corrupt model file fails instead
        for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"): os.environ[k] = "http://127.0.0.1:9"
        for k in ("NO_PROXY", "no_proxy"): os.environ.pop(k, None)
    import numpy as np
    from rembg import new_session, remove
    from PIL import Image
    sess = new_session(j.get("model", "u2netp"))
    w, h = j["w"], j["h"]
    def rgba(f):
        m = np.asarray(remove(Image.fromarray(f), session=sess, only_mask=True).convert("L").resize((w, h)))
        return np.dstack([f, m])
    if j["kind"] == "image":
        f = next(frames(j["path"], None, None, None, w, h, "rgb24"))
        Image.fromarray(rgba(f), "RGBA").save(j["out"], format="PNG")  # audio stays on the original asset
        return {"out": j["out"], "frames": 1}
    enc = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "%dx%d" % (w, h),
           "-framerate", "%.6f" % float(j["fps"]), "-protocol_whitelist", "file,pipe", "-i", "pipe:0", "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le",
           "-alpha_bits", "16", "-map_metadata", "-1", "-fflags", "+bitexact", "-f", "mov", j["out"]]
    errf = tempfile.TemporaryFile()
    e = _spawn(enc, stdin=subprocess.PIPE, stderr=errf)
    n = 0
    for f in frames(j["path"], None, None, j["fps"], w, h, "rgb24"):
        e.stdin.write(rgba(f).tobytes()); n += 1
    e.stdin.close(); e.wait(); errf.seek(0); err = errf.read().decode("utf8", "replace")
    if e.returncode != 0: raise SystemExit("ffmpeg encode: " + err[:400])
    if n == 0: raise SystemExit("no frames decoded from the source")
    return {"out": j["out"], "frames": n}

job = json.loads(sys.argv[1])
res = {"subject": subject, "track": track, "matte": matte}[job["cmd"]](job)
sys.stdout.write(json.dumps(res))
`;
