// Audio inspection for agents that can only see stills: one image (time ruler, per-track waveforms, the rendered mix,
// optional spectrogram, clip boundaries, markers, findings) + numeric findings (clipping/overs, silences, cut-offs, ducking).
import { closeSync, fstatSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import * as AN from "./analyze.ts";
import { audioSources, buildAudio } from "./audio.ts";
import { inp } from "./ffinput.ts";
import { needFfmpeg } from "./media.ts";
import { run } from "./proc.ts";
import { own } from "./own.ts";
import { type Clip, clipEnd, clipStart, type Dict, EditError, resolve, type Timeline, totalDuration } from "./model.ts";

const WIN = 0.02; // analysis window (s)
const DUCK_MARGIN_DB = 6; // music_not_ducked fires when music power is within this many dB of the voice power
const DUCK_NEIGHBOURHOOD_S = 0.5; // each side: music_not_ducked compares power over speech windows within +-0.5 s (1 s) of a window
const HINT_GAP_DB = 12; // the hint aims at the 6 dB threshold plus 6 dB of margin (covers the ~4 dB stem/metric bias seen against LUFS)
const db = (x: number) => (x > 1e-9 ? 20 * Math.log10(x) : -180);
const r3 = (x: number) => +x.toFixed(3), r1 = (x: number) => +x.toFixed(1);

interface Win { rms: Float64Array; peak: Float64Array; dur: number }
interface Lane extends Win { id: string; role?: string; clips: Clip[] }

/** 16-bit PCM WAV (what buildAudio / our ffmpeg calls write) -> per-WIN rms (channel mean power) and sample peak (max over channels), linear; read in blocks so no sample array is kept */
function readWindows(path: string): Win {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size, h = Buffer.alloc(24);
    readSync(fd, h, 0, 12, 0);
    if (h.toString("ascii", 0, 4) !== "RIFF" || h.toString("ascii", 8, 12) !== "WAVE") throw new EditError(`not a WAV file: ${path}`, "decode_failed");
    let o = 12, nch = 0, sr = 0, bits = 0;
    while (o + 8 <= size) {
      h.fill(0); readSync(fd, h, 0, 24, o);
      const id = h.toString("ascii", 0, 4), n = h.readUInt32LE(4);
      if (id === "fmt ") { nch = h.readUInt16LE(10); sr = h.readUInt32LE(12); bits = h.readUInt16LE(22); }
      if (id === "data") {
        if (bits !== 16 || !nch) throw new EditError(`unsupported WAV (${bits}-bit, ${nch} ch): ${path}`, "decode_failed");
        const frames = Math.floor(Math.min(n, size - o - 8) / (2 * nch)), dur = frames / sr;
        const nw = Math.ceil(dur / WIN), w = Math.max(1, Math.round(WIN * sr)), per = 500; // windows per block
        const rms = new Float64Array(nw), peak = new Float64Array(nw), buf = Buffer.allocUnsafeSlow(per * w * nch * 2);
        for (let k0 = 0; k0 < nw; k0 += per) {
          const f0 = k0 * w;
          if (f0 >= frames) break; // the 20 ms window rounds up at some rates (11025 Hz: 221 frames), so the last windows can lie past the data: they stay 0
          const nf = Math.min(frames - f0, per * w), got = readSync(fd, buf, 0, nf * nch * 2, o + 8 + f0 * nch * 2);
          const x = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(got / 2));
          for (let k = k0; k < Math.min(nw, k0 + per); k++) {
            let sum = 0, pk = 0, cnt = 0;
            const a = (k - k0) * w * nch, e = Math.min(x.length, a + w * nch);
            for (let i = a; i < e; i++) { const v = x[i] / 32768; sum += v * v; cnt++; const av = v < 0 ? -v : v; if (av > pk) pk = av; }
            rms[k] = cnt ? Math.sqrt(sum / cnt) : 0; peak[k] = pk;
          }
        }
        return { rms, peak, dur };
      }
      o += 8 + n + (n % 2);
    }
    throw new EditError(`WAV has no data chunk: ${path}`, "decode_failed");
  } finally { closeSync(fd); }
}

/** rms (dBFS) over the windows lying fully inside [t0, t1); outside the signal counts as silence */
function levelDb(rms: Float64Array, t0: number, t1: number) {
  const a0 = Math.ceil(t0 / WIN - 1e-6), e0 = Math.floor(t1 / WIN + 1e-6);
  let s = 0;
  for (let k = Math.max(0, a0); k < Math.min(rms.length, e0); k++) s += rms[k] * rms[k];
  return db(Math.sqrt(s / Math.max(1, e0 - a0)));
}

/** runs of windows where pred holds, merged across gaps < gap s, kept when >= min s */
function runs(n: number, pred: (k: number) => boolean, min = 0, gap = 0): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    if (!pred(k)) continue;
    let e = k;
    while (e + 1 < n && pred(e + 1)) e++;
    const s0 = k * WIN, e0 = (e + 1) * WIN, l = out[out.length - 1];
    if (l && s0 - l[1] <= gap) l[1] = e0; else out.push([s0, e0]);
    k = e;
  }
  return out.filter(([s, e]) => e - s >= min - 1e-9);
}

async function toWav(src: string, out: string, sr: number, signal?: AbortSignal) {
  needFfmpeg();
  // keep the channel layout: upmixing mono to stereo pans it down 3 dB and would hide clipping
  const r = await run("ffmpeg", ["-v", "error", "-y", "-nostdin", ...inp(src), "-vn", "-ar", String(sr), "-c:a", "pcm_s16le", out], { signal });
  if (r.status !== 0) throw new EditError(`cannot decode audio from ${src}: ${r.stderr.slice(-300)}`, "decode_failed", "is it a media file with an audio stream?");
}

export interface AudioCheckOpts { source?: string; spectrogram?: boolean; start?: number; end?: number; width?: number; minSilence?: number; signal?: AbortSignal }

/** tl must be absolutized. Returns the encoded image (PNG) + findings. */
export async function inspectAudio(tl: Timeline | null, o: AudioCheckOpts = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "agentcut-audio-"));
  try {
    const lanes: Lane[] = [];
    let mixPath: string;
    let markers: Dict[] = [], cuts: number[] = [];
    if (o.source) {
      mixPath = join(tmp, "mix.wav");
      await toWav(o.source, mixPath, 48000, o.signal);
    } else {
      if (!tl) throw new EditError("no project or source", "no_project");
      resolve(tl);
      markers = tl.markers ?? [];
      const main = tl.tracks.find((t) => t.magnetic && (t.kind ?? "video") !== "audio");
      cuts = (main?.clips ?? []).slice(1).map(clipStart);
      for (const [j, tr] of tl.tracks.entries()) {
        // stem: every other track at volume 0 (still feeds ducking), raw gain stage, mix rate (16 kHz stems cost no time but dropped the voice's >8 kHz energy, ~0.9 dB)
        const stem: Timeline = { ...tl, settings: { ...tl.settings, loudness: null, sample_rate: 48000 },
          tracks: tl.tracks.map((t, i) => (i === j ? t : { ...t, volume: 0 })) };
        const srcs = audioSources(stem);
        if (!srcs.length) continue;
        const wav = join(tmp, `stem${j}.wav`);
        await buildAudio(stem, wav, 0, undefined, o.signal);
        lanes.push({ id: tr.id, role: tr.role, clips: tr.clips.filter((c) => srcs.some((s) => s.clip.id === c.id) || c.type === "compound"), ...readWindows(wav) });
      }
      mixPath = join(tmp, "mix.wav");
      await buildAudio(structuredClone(tl), mixPath, 0, undefined, o.signal);
    }
    const mw = readWindows(mixPath);
    const T = o.source ? mw.dur : Math.max(mw.dur, totalDuration(tl!));
    const findings: Dict[] = [];
    const loud = await AN.loudness(mixPath, o.signal);

    // 1. clipping (sample peak >= -0.1 dBFS) and overs (> -1 dBFS, the usual true-peak ceiling)
    for (const [s, e] of runs(mw.peak.length, (k) => mw.peak[k] >= 0.9886, 0, 0.1))
      findings.push({ type: "clipping", start: r3(s), end: r3(e), peak_dbfs: r1(db(Math.max(...mw.peak.subarray(Math.floor(s / WIN), Math.ceil(e / WIN))))),
        hint: "lower the loud clip's volume (or the track's) until the peak stays below -1 dBFS" });
    for (const [s, e] of runs(mw.peak.length, (k) => mw.peak[k] > 0.891 && mw.peak[k] < 0.9886, 0, 0.1))
      findings.push({ type: "over", start: r3(s), end: r3(e), peak_dbfs: r1(db(Math.max(...mw.peak.subarray(Math.floor(s / WIN), Math.ceil(e / WIN))))),
        hint: "peaks above -1 dBFS may distort after lossy encoding; lower the volume there" });
    if (loud.true_peak_dbfs !== null && loud.true_peak_dbfs > -1)
      findings.push({ type: "true_peak", value_dbfs: loud.true_peak_dbfs, hint: "true peak above -1 dBTP; lower the loudest source" });

    // 2. long silences in the mix (dead air)
    const minSil = o.minSilence ?? 1;
    if (!o.source && !lanes.length) findings.push({ type: "no_audio", hint: "the project has no audible clip; add music or a voiceover" });
    else for (const [s, e] of runs(mw.rms.length, (k) => db(mw.rms[k]) < -50, minSil))
      findings.push({ type: "silence", start: r3(s), end: r3(Math.min(e, T)), hint: "dead air: add music/room tone, or cut the gap (remove_silence)" });

    // 3. audio that stops abruptly at a clip end (no fade, still loud)
    for (const L of lanes) for (const c of L.clips) {
      if (c.type === "compound") continue;
      const e = clipEnd(c), before = levelDb(L.rms, e - 0.05, e), after = levelDb(L.rms, e, e + 0.05);
      if (before > -30 && after < before - 15)
        findings.push({ type: "cut_off", t: r3(e), id: c.id, track: L.id, level_db: r1(before),
          hint: `audio stops abruptly at ${r3(e)}s: update_clip ${c.id} set fade_out=0.3 (or end it on a quieter moment)` });
    }

    // 4. music not ducked under voice. Speech windows = voice windows above a per-clip floor, max(-40 dBFS, that clip's p95 - 20 dB), so syllable gaps and pauses
    // do not drag the voice level down and a quiet clip is judged by its own level. Levels are power means (then dB) over speech windows only, never a mean of dB values,
    // taken locally (+-DUCK_NEIGHBOURHOOD_S) so a short loud stretch of music is not averaged away inside long narration. A run (>= 0.5 s, gaps <= 0.3 s) of speech windows whose
    // local music power is within 6 dB of the local voice power is a finding; its levels and hint come from the run's own speech windows.
    const voice = lanes.filter((l) => l.role === "voice" || l.role === "dialogue"), music = lanes.filter((l) => l.role === "music");
    if (voice.length && music.length) {
      const n = Math.min(...[...voice, ...music].map((l) => l.rms.length));
      const comb = (ls: Lane[]) => Float64Array.from({ length: n }, (_, k) => ls.reduce((s, l) => s + l.rms[k] ** 2, 0));
      const vp = comb(voice), mp = comb(music), vdb = Float64Array.from(vp, (x) => 10 * Math.log10(x + 1e-18));
      const floor = new Float64Array(n).fill(Infinity); // lowest floor of the voice clips covering each window; Infinity = no voice clip there
      for (const l of voice) for (const c of l.clips) {
        const a0 = Math.max(0, Math.floor(clipStart(c) / WIN)), a1 = Math.min(n, Math.ceil(clipEnd(c) / WIN));
        const loudDb = Array.from(vdb.subarray(a0, Math.max(a0, a1))).filter((x) => x > -40).sort((x, y) => x - y);
        if (!loudDb.length) continue;
        const f = Math.max(-40, loudDb[Math.floor(loudDb.length * 0.95)] - 20);
        for (let k = a0; k < a1; k++) floor[k] = Math.min(floor[k], f);
      }
      const speech = (k: number) => vdb[k] > floor[k];
      // prefix sums of voice power, music power and count over speech windows
      const cv = new Float64Array(n + 1), cm = new Float64Array(n + 1), cn = new Float64Array(n + 1);
      for (let k = 0; k < n; k++) { const sp = speech(k); cv[k + 1] = cv[k] + (sp ? vp[k] : 0); cm[k + 1] = cm[k] + (sp ? mp[k] : 0); cn[k + 1] = cn[k] + (sp ? 1 : 0); }
      const H = Math.round(DUCK_NEIGHBOURHOOD_S / WIN), gapDb = (a: number, b: number) => 10 * Math.log10((cv[b] - cv[a]) / (cm[b] - cm[a]) + 1e-18);
      const flagged = (k: number) => { if (!speech(k)) return false; const a = Math.max(0, k - H), b = Math.min(n, k + H + 1); return cm[b] - cm[a] > 0 && gapDb(a, b) < DUCK_MARGIN_DB; };
      for (const [s, e] of runs(n, flagged, 0.5, 0.3)) {
        const a = Math.floor(s / WIN), b = Math.min(n, Math.ceil(e / WIN));
        if (!(cn[b] - cn[a])) continue;
        const voiceDb = 10 * Math.log10((cv[b] - cv[a]) / (cn[b] - cn[a]) + 1e-18), musicDb = 10 * Math.log10((cm[b] - cm[a]) / (cn[b] - cn[a]) + 1e-18), gap = voiceDb - musicDb;
        if (gap >= DUCK_MARGIN_DB) continue;
        const lower = Math.max(0, HINT_GAP_DB - gap);
        const fix = music.map((l) => `update_track ${l.id} set duck=${-Math.ceil(-Number(tl!.tracks.find((t) => t.id === l.id)?.duck ?? 0) + lower)}`).join("; ");
        findings.push({ type: "music_not_ducked", start: r3(s), end: r3(e), music_db: r1(musicDb), voice_db: r1(voiceDb), tracks: music.map((l) => l.id),
          hint: `music is ${r1(Math.abs(gap))} dB ${gap < 0 ? "above" : "under"} the voice (want >= ${HINT_GAP_DB} under): duck harder (${fix})` });
      }
    }
    findings.sort((a, b) => (a.start ?? a.t ?? 0) - (b.start ?? b.t ?? 0));

    const spec = o.spectrogram ? join(tmp, "spec.png") : null;
    const t0 = Math.max(0, o.start ?? 0), t1 = Math.min(T, o.end ?? T);
    if (!(t1 > t0)) throw new EditError(`empty range ${t0}-${t1}`, "bad_range", `use start/end inside 0-${r3(T)}`);
    const img = await draw({ lanes, mix: mw, findings, markers, cuts, t0, t1, width: o.width ?? 1400, spec, mixPath, source: o.source, signal: o.signal });
    return {
      image: img, duration: r3(T), range: [r3(t0), r3(t1)],
      lanes: [...lanes.map((l) => ({ track: l.id, role: l.role, peak_dbfs: r1(db(Math.max(...l.peak))), rms_dbfs: r1(levelDb(l.rms, 0, l.dur)) })),
        { track: "mix", peak_dbfs: r1(db(Math.max(0, ...mw.peak))), rms_dbfs: r1(levelDb(mw.rms, 0, mw.dur)) }],
      loudness: { integrated_lufs: loud.integrated_lufs, range_lu: loud.range_lu, true_peak_dbfs: loud.true_peak_dbfs },
      findings,
    };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const COL: Record<string, string> = { voice: "#4fc3f7", dialogue: "#4fc3f7", music: "#ba68c8", sfx: "#ffb74d" };
const FIND: Record<string, string> = { clipping: "#ff1744", over: "#ff9100", silence: "#9e9e9e", cut_off: "#ff9100", music_not_ducked: "#e040fb" };

async function draw(a: { lanes: Lane[]; mix: Win; findings: Dict[]; markers: Dict[]; cuts: number[];
  t0: number; t1: number; width: number; spec: string | null; mixPath: string; source?: string; signal?: AbortSignal }): Promise<Buffer> {
  const G = 120, RH = 26, LH = 76, MH = 120, SH = 170, W = Math.max(400, Math.round(a.width)), PW = W - G - 8;
  const H = RH + a.lanes.length * (LH + 4) + MH + (a.spec ? SH + 4 : 0) + 6;
  const cv = createCanvas(W, H), ctx = cv.getContext("2d");
  const X = (t: number) => G + ((t - a.t0) / (a.t1 - a.t0)) * PW;
  ctx.fillStyle = "#151515"; ctx.fillRect(0, 0, W, H);
  ctx.font = "12px Menlo, Consolas, monospace";

  // ruler
  const step = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => (s / (a.t1 - a.t0)) * PW >= 70) ?? 600;
  ctx.strokeStyle = "#555"; ctx.fillStyle = "#ccc"; ctx.lineWidth = 1;
  for (let t = Math.ceil(a.t0 / step) * step; t <= a.t1 + 1e-9; t += step) {
    const x = Math.round(X(t)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, RH - 8); ctx.lineTo(x, H); ctx.strokeStyle = "#2a2a2a"; ctx.stroke();
    ctx.fillText(`${+t.toFixed(2)}s`, x + 3, 13);
  }
  const rows: { label: string; y: number; h: number; color: string; w: { rms: Float64Array; peak: Float64Array }; clips?: Clip[]; id?: string }[] = [];
  let y = RH;
  for (const L of a.lanes) { rows.push({ label: L.role ? `${L.id} (${L.role})` : L.id, y, h: LH, color: own(COL, L.role ?? "") ?? "#81c784", w: L, clips: L.clips, id: L.id }); y += LH + 4; }
  rows.push({ label: a.source ? "file" : "mix (rendered)", y, h: MH, color: "#e0e0e0", w: a.mix, id: "mix" }); y += MH + 4;

  for (const r of rows) {
    ctx.fillStyle = "#1d1d1d"; ctx.fillRect(G, r.y, PW, r.h);
    for (const c of r.clips ?? []) { // clip boxes + boundaries
      const x0 = Math.max(G, X(clipStart(c))), x1 = Math.min(G + PW, X(clipEnd(c)));
      if (x1 <= x0) continue;
      ctx.fillStyle = "rgba(255,255,255,0.05)"; ctx.fillRect(x0, r.y, x1 - x0, r.h);
      ctx.fillStyle = "#777"; ctx.fillRect(x0, r.y, 1, r.h); ctx.fillRect(x1 - 1, r.y, 1, r.h);
    }
    const mid = r.y + r.h / 2, amp = r.h / 2 - 2, n = r.w.rms.length;
    const hgt = (x: number) => Math.max(0, (db(x) + 60) / 60) * amp; // dB scale: -60 dBFS = centre line, 0 dBFS = lane edge
    for (const d of [-6, -20, -40]) { ctx.fillStyle = "#2c2c2c"; ctx.fillRect(G, Math.round(mid - hgt(10 ** (d / 20))), PW, 1); ctx.fillRect(G, Math.round(mid + hgt(10 ** (d / 20))), PW, 1); }
    for (let px = 0; px < PW; px++) { // waveform: sample peak (dim) + rms (bright)
      const ka = Math.floor((a.t0 + (px / PW) * (a.t1 - a.t0)) / WIN), kb = Math.max(ka + 1, Math.floor((a.t0 + ((px + 1) / PW) * (a.t1 - a.t0)) / WIN));
      let pk = 0, rs = 0;
      for (let k = ka; k < kb && k < n; k++) { if (r.w.peak[k] > pk) pk = r.w.peak[k]; if (r.w.rms[k] > rs) rs = r.w.rms[k]; }
      if (!pk) continue;
      ctx.globalAlpha = 0.45; ctx.fillStyle = r.color; ctx.fillRect(G + px, mid - hgt(pk), 1, Math.max(1, 2 * hgt(pk)));
      ctx.globalAlpha = 1; ctx.fillRect(G + px, mid - hgt(rs), 1, Math.max(1, 2 * hgt(rs)));
      if (pk >= 0.9886) { ctx.fillStyle = FIND.clipping; ctx.fillRect(G + px, r.y, 1, 4); ctx.fillRect(G + px, r.y + r.h - 4, 1, 4); }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#333"; ctx.fillRect(G, mid, PW, 1);
    ctx.fillStyle = r.color; ctx.fillText(r.label, 6, r.y + 16);
    ctx.fillStyle = "#888"; ctx.fillText(`pk ${r1(db(Math.max(0, ...r.w.peak)))} dB`, 6, r.y + 32);
    for (const c of r.clips ?? []) { const x0 = Math.max(G, X(clipStart(c))); if (x0 < Math.min(G + PW, X(clipEnd(c)))) { ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(x0 + 1, r.y + 1, ctx.measureText(c.id).width + 5, 14); ctx.fillStyle = "#ddd"; ctx.fillText(c.id, x0 + 3, r.y + 12); } }
    for (const f of a.findings) { // findings on the lane they belong to
      const on = f.track === r.id || (r.id === "mix" && ["clipping", "over", "silence"].includes(f.type)) || (f.tracks ?? []).includes(r.id);
      if (!on || !FIND[f.type]) continue;
      ctx.fillStyle = FIND[f.type];
      if (f.t !== undefined) { const x = X(f.t); ctx.beginPath(); ctx.moveTo(x, r.y + r.h); ctx.lineTo(x - 6, r.y + r.h - 12); ctx.lineTo(x, r.y + r.h - 12); ctx.fill(); }
      else { const x0 = Math.max(G, X(f.start)); ctx.globalAlpha = f.type === "silence" ? 0.5 : 0.85; ctx.fillRect(x0, r.y + r.h - 6, Math.max(2, Math.min(G + PW, X(f.end)) - x0), 6); ctx.globalAlpha = 1; }
    }
  }
  if (a.spec) {
    const ss = await run("ffmpeg", ["-v", "error", "-y", "-nostdin", "-ss", String(a.t0), "-t", String(a.t1 - a.t0), ...inp(a.mixPath),
      "-lavfi", `aformat=channel_layouts=mono,showspectrumpic=s=${PW}x${SH}:legend=0:fscale=log:color=intensity`, a.spec], { signal: a.signal });
    if (ss.status === 0) { ctx.drawImage(await loadImage(a.spec), G, y, PW, SH); ctx.fillStyle = "#ccc"; ctx.fillText("spectrogram", 6, y + 16); ctx.fillStyle = "#888"; ctx.fillText("(log freq)", 6, y + 32); }
    else { ctx.fillStyle = "#f55"; ctx.fillText(`spectrogram failed: ${ss.stderr.slice(-80)}`, G + 6, y + 20); }
  }
  // cuts on the main track (faint) + markers (yellow, labelled) across every lane
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  for (const t of a.cuts) if (t >= a.t0 && t <= a.t1) ctx.fillRect(Math.round(X(t)), RH, 1, H - RH);
  for (const m of a.markers) {
    const t = Number(m.t);
    if (!(t >= a.t0 && t <= a.t1)) continue;
    ctx.fillStyle = "rgba(255,214,0,0.7)"; ctx.fillRect(Math.round(X(t)), RH - 8, 1, H - RH + 8);
    if (m.label) { ctx.fillStyle = "#ffd600"; ctx.fillText(String(m.label).slice(0, 18), X(t) + 3, RH - 1); }
  }
  return cv.encodeSync("png");
}
