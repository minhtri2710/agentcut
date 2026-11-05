// Python helper for the vision features, run through `uv run --with <pkgs>` (see vision.ts). Kept as a TS string so the
// same script ships with src/, dist/ and the compiled binary. It reads one JSON job from argv[1], prints one JSON result.
// Frames are decoded by FFmpeg (same decoder as the renderer) and handed over as raw bytes; progress lines go to stderr.
export const VISION_PY = String.raw`
import json, subprocess, sys

def frames(path, start, dur, fps, w, h, fmt="bgr24"):
    args = ["ffmpeg", "-v", "error", "-nostdin"]
    if start is not None: args += ["-ss", "%.6f" % start]
    if dur is not None: args += ["-t", "%.6f" % dur]
    vf = ("fps=%s," % fps if fps else "") + "scale=%d:%d:flags=bicubic" % (w, h)
    args += ["-i", path, "-an", "-sn", "-vf", vf, "-f", "rawvideo", "-pix_fmt", fmt, "-"]
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    n = w * h * (3 if fmt in ("bgr24", "rgb24") else 4)
    import numpy as np
    i = 0
    while True:
        b = p.stdout.read(n)
        if len(b) < n: break
        yield np.frombuffer(b, np.uint8).reshape(h, w, -1)
        i += 1
        sys.stderr.write("AGENTCUT_PROGRESS %d\n" % i); sys.stderr.flush()  # frames done, read by vision.ts
    p.stdout.close(); err = p.stderr.read().decode("utf8", "replace"); p.wait()
    if p.returncode not in (0, None) and err.strip(): raise SystemExit("ffmpeg: " + err[:400])

def subject(j):
    import cv2, numpy as np
    w, h = j["w"], j["h"]
    face = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    sal = cv2.saliency.StaticSaliencyFineGrained_create()  # spectral residual aliases on flat footage
    out = []
    for i, f in enumerate(frames(j["path"], j.get("start"), j.get("duration"), j.get("fps"), w, h)):
        t = (j.get("start") or 0) + i / j["fps"] if j.get("fps") else 0
        g = cv2.equalizeHist(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY))
        fs = face.detectMultiScale(g, scaleFactor=1.1, minNeighbors=5, minSize=(max(12, h // 12),) * 2)
        if len(fs):
            x, y, fw, fh = max(fs, key=lambda r: (r[2] * r[3], -r[0], -r[1]))
            out.append({"t": round(t, 4), "x": round((x + fw / 2) / w, 4), "y": round((y + fh / 2) / h, 4),
                        "w": round(fw / w, 4), "h": round(fh / h, 4), "kind": "face", "score": 1.0})
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
           "-framerate", str(j["fps"]), "-i", "-", "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le",
           "-alpha_bits", "16", "-map_metadata", "-1", "-fflags", "+bitexact", "-f", "mov", j["out"]]
    e = subprocess.Popen(enc, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    n = 0
    for f in frames(j["path"], None, None, j["fps"], w, h, "rgb24"):
        e.stdin.write(rgba(f).tobytes()); n += 1
    e.stdin.close(); err = e.stderr.read().decode("utf8", "replace"); e.wait()
    if e.returncode != 0: raise SystemExit("ffmpeg encode: " + err[:400])
    return {"out": j["out"], "frames": n}

job = json.loads(sys.argv[1])
res = {"subject": subject, "track": track, "matte": matte}[job["cmd"]](job)
sys.stdout.write(json.dumps(res))
`;
