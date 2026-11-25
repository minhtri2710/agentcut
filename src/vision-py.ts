// Python helper for the vision features, run through `uv run --with <pkgs>` (see vision.ts). Kept as a TS string so the
// same script ships with src/, dist/ and the compiled binary. It reads one JSON job from argv[1], prints one JSON result.
// Frames are decoded by FFmpeg (same decoder as the renderer) and handed over as raw bytes; progress lines go to stderr.
import { FPS_END } from "./media.ts";
import { VIDEO_MAP } from "./ffinput.ts";
import { COLOR_SPACES, CONVERSIONS, conversionChain } from "./model.ts";

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

_MATRICES = ${JSON.stringify(COLOR_SPACES)}  # the project's COLOR_SPACES

_CONVERT = ${JSON.stringify(Object.fromEntries(CONVERSIONS.map((k) => [k, conversionChain(k).join(",")])))}  # the project's conversion to BT.709 for each key (conversionChain in model.ts): the filters FrameSource runs

def frames(path, start, dur, fps, w, h, fmt="bgr24", matrix=None, convert=None, container_start=None, seek=None):  # matrix: the picture is tagged with it before the conversion, as FrameSource reads it; only a name in the list above. convert: a key of _CONVERT, run right after
    if matrix is not None and matrix not in _MATRICES: raise SystemExit("matrix is not a name this helper reads with: %r" % (matrix,))
    if convert is not None and convert not in _CONVERT: raise SystemExit("convert is not a conversion this helper has: %r" % (convert,))
    if fps and container_start is None: raise SystemExit("a read at a frame rate needs the file's container_start")
    args = ["ffmpeg", "-v", "error", "-nostdin"]
    if fps: args += ["-copyts"]  # the file's own times stay; the filters below put them on the clip clock
    # seek: where the job builder put the input seek (FrameSource's pre-roll before the in-point), or None to read from the file's start; fps with start_time=0 drops what comes before the in-point.
    if seek is not None: args += ["-ss", "%.6f" % seek]
    # Sample i is the picture at start + i/fps on the clip clock (the container start and the in-point are subtracted), as FrameSource slots a clip: before the first picture, the first one holds.
    # A range has round(dur * fps) samples while the picture lasts. The read ends with the last slot that starts before the picture ends; eof_action=pass keeps that slot when the last frame rounds into it.
    clock = "settb=1/1000000,setpts=PTS-%.6f/TB,fps=%.6f:start_time=0:${FPS_END}," % (container_start + (start or 0), float(fps)) if fps else ""
    cut = "trim=end=%.6f," % ((int(dur * fps + 0.5) - 0.25) / fps) if fps and dur is not None else ""
    vf = clock + cut + ("setparams=colorspace=%s," % matrix if matrix else "") + (_CONVERT[convert] + "," if convert else "") + "scale=%d:%d:flags=bicubic" % (w, h)
    args += ["-protocol_whitelist", "file,pipe", "-i", path] + ${JSON.stringify(VIDEO_MAP)} + ["-an", "-sn", "-vf", vf, "-f", "rawvideo", "-pix_fmt", fmt, "-"]
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

def _verify(path, sha):  # every model is hashed right before it is loaded; a job with no sha256 is refused
    if not sha: raise SystemExit("the job has no sha256 for the model file: " + path)
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    if h.hexdigest() != sha: raise SystemExit("model file does not match its pinned sha256: " + path)

def subject(j):
    import cv2, numpy as np
    w, h = j["w"], j["h"]
    face_min = float(j["face_min"])
    _verify(j["face_model"], j.get("model_sha256"))
    det = cv2.FaceDetectorYN.create(j["face_model"], "", (w, h), face_min, 0.3, 5000)  # YuNet: score threshold, NMS threshold, top-k before NMS
    sal = cv2.saliency.StaticSaliencyFineGrained_create()  # spectral residual aliases on flat footage
    c01 = lambda v: min(1.0, max(0.0, v))  # a face box may reach past the frame edge
    out = []
    for i, f in enumerate(frames(j["path"], j.get("start"), j.get("duration"), j.get("fps"), w, h, container_start=j.get("container_start"), seek=j.get("seek"))):
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
    fr = list(frames(j["path"], s, j["duration"], fps, w, h, container_start=j.get("container_start"), seek=j.get("seek")))
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

def _rvm(path, w, h):  # Robust Video Matting: the four recurrent states carry over from frame to frame, in reading order
    import numpy as np, onnxruntime as ort
    sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    rec = [np.zeros((1, 1, 1, 1), np.float32)] * 4
    ratio = np.array([min(1.0, 512.0 / max(w, h))], np.float32)  # the model works at 256..512 px on the long side
    def mask(f):
        nonlocal rec
        out = sess.run(None, {"src": (f.astype(np.float32) / 255).transpose(2, 0, 1)[None], "r1i": rec[0], "r2i": rec[1], "r3i": rec[2], "r4i": rec[3], "downsample_ratio": ratio})
        rec = out[2:]
        return (np.clip(out[1][0, 0], 0, 1) * 255 + 0.5).astype(np.uint8)
    return mask

def matte(j):
    rvm = j.get("model") == "rvm_mobilenetv3"
    if not rvm:
        # AgentCut fetches and verifies every model first, and rembg 2.0.86 neither re-checks nor fetches a file that is present: the helper never fetches, so a missing or corrupt file fails
        for k in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"): os.environ[k] = "http://127.0.0.1:9"
        for k in ("NO_PROXY", "no_proxy"): os.environ.pop(k, None)
        from rembg import new_session, remove
    import numpy as np
    from PIL import Image
    _verify(j["model_file"], j.get("model_sha256"))
    w, h = j["w"], j["h"]
    if rvm: mask = _rvm(j["model_file"], w, h)
    else:
        sess = new_session(j.get("model", "u2netp"))
        mask = lambda f: np.asarray(remove(Image.fromarray(f), session=sess, only_mask=True).convert("L").resize((w, h)))
    def rgba(f):
        return np.dstack([f, mask(f)])
    if j["kind"] == "image":
        f = next(frames(j["path"], None, None, None, w, h, "rgb24", j.get("matrix"), j.get("convert")))
        Image.fromarray(rgba(f), "RGBA").save(j["out"], format="PNG")  # audio stays on the original asset
        return {"out": j["out"], "frames": 1}
    # MATTE_FACTS in media.ts assumes this writer: an intra-only prores_ks mov that starts at 0
    enc = ["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "%dx%d" % (w, h),
           "-framerate", "%.6f" % float(j["fps"]), "-protocol_whitelist", "file,pipe", "-i", "pipe:0", "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le",
           "-alpha_bits", "16", "-map_metadata", "-1", "-fflags", "+bitexact", "-f", "mov", j["out"]]
    errf = tempfile.TemporaryFile()
    e = _spawn(enc, stdin=subprocess.PIPE, stderr=errf)
    n = 0
    for f in frames(j["path"], None, None, j["fps"], w, h, "rgb24", j.get("matrix"), j.get("convert"), j.get("container_start")):
        e.stdin.write(rgba(f).tobytes()); n += 1
    e.stdin.close(); e.wait(); errf.seek(0); err = errf.read().decode("utf8", "replace")
    if e.returncode != 0: raise SystemExit("ffmpeg encode: " + err[:400])
    if n == 0: raise SystemExit("no frames decoded from the source")
    return {"out": j["out"], "frames": n}

def separate(j):
    # Spleeter 2 stems: STFT 4096 / hop 1024 (Hann), the models take the magnitude of the lowest 1024 bins in blocks of 512 frames and give
    # each stem's magnitude; the voice mask is the ratio of the squares (above 1024 bins: the mask's mean in that frame). Music = source - voice,
    # so the stems add up to the decoded sound. shortcut: the whole decoded sound is held in memory (~2 x 21 MB per minute), stream it if hour-long sources matter
    import numpy as np, onnxruntime as ort
    for f, sha in zip(j["model_files"], j.get("model_sha256") or [None] * 2): _verify(f, sha)
    SR, N, HOP, T, B = 44100, 4096, 1024, 512, 1024
    errf = tempfile.TemporaryFile()
    p = _spawn(["ffmpeg", "-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-i", j["path"], "-map", "0:a:0", "-vn", "-sn",
                "-af", "aresample=%d:first_pts=0" % SR, "-ac", "2", "-f", "f32le", "-"], stdout=subprocess.PIPE, stderr=errf)
    raw = p.stdout.read(); p.stdout.close(); p.wait(); errf.seek(0)
    if p.returncode != 0: raise SystemExit("ffmpeg exited %s: %s" % (p.returncode, errf.read().decode("utf8", "replace").strip()[:400]))
    x = np.frombuffer(raw, np.float32).reshape(-1, 2).T.copy(); del raw
    L = x.shape[1]
    if L == 0: return {"samples": 0}
    xp = np.pad(x, ((0, 0), (N, N + HOP)))
    w = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / N)).astype(np.float32)
    F = (xp.shape[1] - N) // HOP + 1
    so = ort.SessionOptions()
    sv, sa = (ort.InferenceSession(f, so, providers=["CPUExecutionProvider"]) for f in j["model_files"])
    voice = np.zeros_like(xp)
    for k, b0 in enumerate(range(0, F, T)):
        n = min(T, F - b0)
        S = np.fft.rfft(xp[:, (b0 + np.arange(n))[:, None] * HOP + np.arange(N)[None, :]] * w, axis=-1)
        mag = np.zeros((2, 1, T, B), np.float32); mag[:, 0, :n] = np.abs(S[:, :, :B])
        v = sv.run(None, {"x": mag})[0][:, 0, :n]; a = sa.run(None, {"x": mag})[0][:, 0, :n]
        m = (v * v + 5e-11) / (v * v + a * a + 1e-10)
        m = np.concatenate([m, np.repeat(m.mean(-1, keepdims=True), S.shape[-1] - B, -1)], -1)
        y = np.fft.irfft(S * m, n=N, axis=-1) * w
        for i in range(n): voice[:, (b0 + i) * HOP:(b0 + i) * HOP + N] += y[:, i]
        sys.stderr.write("AGENTCUT_PROGRESS %d\n" % (k + 1)); sys.stderr.flush()
    voice = voice[:, N:N + L] / 1.5  # the Hann^2 overlap at a quarter hop sums to 1.5
    for arr, out in ((voice, j["out"]), (x - voice, j["out_music"])):
        e = _spawn(["ffmpeg", "-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "2", "-i", "pipe:0", "-c:a", "flac", "-sample_fmt", "s32",
                    "-map_metadata", "-1", "-fflags", "+bitexact", "-f", "flac", out], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
        e.stdin.write(np.ascontiguousarray(arr.T).astype(np.float32).tobytes()); e.stdin.close(); e.wait()
        if e.returncode != 0: raise SystemExit("ffmpeg could not write a stem (exit %s)" % e.returncode)
    return {"samples": L, "sample_rate": SR}

job = json.loads(sys.argv[1])
res = {"subject": subject, "track": track, "matte": matte, "separate": separate}[job["cmd"]](job)
sys.stdout.write(json.dumps(res))
`;
