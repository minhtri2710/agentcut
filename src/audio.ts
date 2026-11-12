// Audio mix: one FFmpeg filter graph (trim, tempo, reverse, processing, fades, automation, ducking) + 2-pass loudness.
import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { parseKfs } from "./anim.ts";
import * as FX from "./audiofx.ts";
import { inp } from "./ffinput.ts";
import { needFfmpeg } from "./media.ts";
import { type Clip, EditError, hasSound, isRetimed, parseTime, resolve, type Timeline, totalDuration, type Track } from "./model.ts";

const { atempo } = FX;

// volume='expr':eval=frame holds one gain per audio frame (decoder frames are 85-93 ms). The duck ramp is linear in amplitude, so its dB error is steep near the ramp's end:
// 256 samples (5.3 ms) keep the music within 0.25 dB of the ducked level in the first 30 ms of the voice (worst of 7 onset offsets; 128: 0.10, 480: 1.07, 1024: 4.0 dB)
// and a fast keyframe drop within 0.02 dB (1024: 9.4 dB). Cost, user CPU on 85 voice intervals x 4 music clips vs unframed: n=128 +15%, n=256 +7%, n=480 +4..11% (within noise). Only chains with such an expression use it.
const EVAL_FRAME = "asetnsamples=n=256:p=0", REFRAME = "asetnsamples=n=4096:p=0"; // REFRAME: back to decoder-sized frames so amix does not poll its inputs every 256 samples
export function kfExpr(kfs: any[], v = "t"): string {
  const pts = parseKfs(kfs), tail = `${pts[pts.length - 1][1]}`;
  // first segment i with v < t[i+1] (times are sorted, so that test is monotone in i): binary search keeps the nesting at ~log2(N), as ffmpeg rejects expressions nested ~100 deep
  const seg = (lo: number, hi: number): string => {
    if (lo === hi) return tail;
    if (hi - lo === 1) {
      const [t0, v0] = pts[lo], [t1, v1] = pts[lo + 1];
      return `if(lt(${v},${t1}),${v0}+(${v1}-${v0})*(${v}-${t0})/${Math.max(1e-6, t1 - t0)},${tail})`;
    }
    const mid = (lo + hi) >> 1;
    return `if(lt(${v},${pts[mid][0]}),${seg(lo, mid)},${seg(mid, hi)})`;
  };
  return `if(lt(${v},${pts[0][0]}),${pts[0][1]},${seg(0, pts.length - 1)})`;
}

interface Win { base: number; w0: number; w1: number; gain: number; track: Track }
/** clip c of a compound's nested timeline -> parent time, trimmed to the compound's visible window [w0, w1] */
function mapClip(c: Clip, w?: Win): Clip | null {
  if (!w) return c;
  const s = parseTime(c.start ?? 0), e = s + parseTime(c.duration), a = Math.max(s, w.w0), b = Math.min(e, w.w1);
  if (b - a < 1e-3) return null;
  const head = a - s, tail = e - b, speed = Number(c.speed ?? 1) || 1;
  const m: Clip = { ...c, start: w.base + a - w.w0, duration: b - a, in: parseTime(c.in ?? 0) + (c.reverse ? tail : head) * speed };
  if (head > 1e-6) {
    delete m.fade_in;
    if (c.keyframes?.volume) m.keyframes = { ...c.keyframes, volume: parseKfs(c.keyframes.volume).map(([t, v]) => [t - head, v]) };
  }
  if (tail > 1e-6) delete m.fade_out;
  return m;
}

/** Every enabled clip on an unmuted track, compound clips flattened into parent-time clips (audio needs speed 1). */
function* flatClips(tracks: Track[], w?: Win): Generator<{ track: Track; clip: Clip; gain: number }> {
  for (const t of tracks) {
    if (t.muted) continue;
    const track = w ? { ...w.track, ...t } : t, gain = (w?.gain ?? 1) * Number(t.volume ?? 1);
    for (const c0 of t.clips) {
      if (c0.enabled === false) continue;
      const c = mapClip(c0, w);
      if (!c) continue;
      if (c.type !== "compound") { yield { track, clip: c, gain }; continue; }
      if (c.muted || isRetimed(c) || !Array.isArray(c.tracks)) continue;
      const w0 = parseTime(c.in ?? 0);
      yield* flatClips(c.tracks, { base: parseTime(c.start ?? 0), w0, w1: w0 + parseTime(c.duration), gain: gain * Number(c.volume ?? 1), track });
    }
  }
}

export function audioSources(tl: Timeline) {
  const out: { track: Track; clip: Clip; path: string; volume: number }[] = [];
  for (const { track, clip: c, gain } of flatClips(tl.tracks)) {
    if (!hasSound(c, tl.assets)) continue;
    const a = tl.assets[c.asset], vol = Number(c.volume ?? 1) * gain;
    if (vol > 0) out.push({ track, clip: c, path: a.path, volume: vol });
  }
  return out;
}

/** The spans voice/dialogue clips cover: what ducking ducks against. */
export function voiceSpans(tl: Timeline): [number, number][] {
  const out: [number, number][] = [];
  for (const { track: tr, clip: c } of flatClips(tl.tracks))
    if ((tr.role === "voice" || tr.role === "dialogue") && (c.type === "audio" || c.type === "video")) { const s = parseTime(c.start ?? 0); out.push([s, s + parseTime(c.duration)]); }
  return out;
}

export function buildAudio(tl: Timeline, outWav: string, t0 = 0, t1?: number): string {
  needFfmpeg();
  resolve(tl);
  const T = Math.max(0.04, totalDuration(tl));
  t1 ??= T;
  const sr = Number(tl.settings.sample_rate ?? 48000);
  const srcs = audioSources(tl);
  const voice = voiceSpans(tl).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of voice) { const l = merged[merged.length - 1]; if (l && s - l[1] < 0.5) l[1] = Math.max(l[1], e); else merged.push([s, e]); }
  const args = ["-v", "error", "-y", "-nostdin"];
  const graph: string[] = [], labels: string[] = [];
  // gain 1 outside the voice intervals; only intervals within a ramp of [from, to] matter, so a clip is not charged for the whole project's intervals
  const duck = (track: Track, from = -Infinity, to = Infinity) => {
    const r = 0.25, near = merged.filter(([a0, a1]) => a1 + r > from && a0 - r < to);
    if (!track.duck || !near.length || track.role === "voice" || track.role === "dialogue") return [];
    const g = 10 ** (Number(track.duck) / 20);
    const terms = near.map(([a0, a1]) => `clip(min((t-${(a0 - r).toFixed(3)})/${r},(${(a1 + r).toFixed(3)}-t)/${r}),0,1)`);
    const maxOf = (xs: string[]): string => (xs.length === 1 ? xs[0] : `max(${maxOf(xs.slice(0, xs.length >> 1))},${maxOf(xs.slice(xs.length >> 1))})`); // balanced: ffmpeg rejects expressions nested ~100 deep
    return [EVAL_FRAME, `volume='1-${(1 - g).toFixed(4)}*${maxOf(terms)}':eval=frame`, REFRAME];
  };
  const bus = (track: Track) => [...FX.eqFilters(track.eq), ...FX.compressorFilter(track.compressor), ...FX.panFilter(track.pan)];
  const buses = new Map<Track, string[]>(); // tracks with bus processing -> their clip labels
  srcs.forEach((s, i) => {
    const c = s.clip, tr = s.track;
    const fx = (k: (typeof FX.PER_CLIP_KEYS)[number]) => c[k] ?? tr[k];
    const input = [...(c.loop ? ["-stream_loop", "-1"] : []), ...inp(s.path)];
    args.push(...input);
    const speed = Number(c.speed ?? 1) || 1, cin = parseTime(c.in ?? 0), dur = parseTime(c.duration), start = parseTime(c.start ?? 0);
    const ch = [`atrim=start=${cin}:duration=${dur * speed}`, "asetpts=PTS-STARTPTS"];
    if (c.reverse) ch.push("areverse");
    ch.push(...atempo(speed), `aresample=${sr}`, "aformat=sample_fmts=fltp:channel_layouts=stereo");
    if (fx("pitch")) ch.push("apad=pad_dur=0.1", ...FX.pitchFilters(fx("pitch"), sr), `atrim=duration=${dur}`); // padding lets atempo flush the clip's last samples
    const dn = FX.denoiseStrength(fx("denoise"));
    if (dn) {
      const floor = FX.noiseFloor(s.path, cin, dur * speed);
      if (floor !== null) ch.push(...FX.denoiseFilters(dn, floor, sr));
    }
    ch.push(...FX.eqFilters(c.eq), ...FX.compressorFilter(c.compressor), ...FX.panFilter(c.pan));
    const target = FX.normalizeTarget(fx("normalize"));
    if (target !== null) {
      const lufs = FX.loudness(input, ch.join(","));
      if (lufs !== null) ch.push(`volume=${(target - lufs).toFixed(2)}dB`);
    }
    ch.push(`volume=${s.volume.toFixed(4)}`);
    if (c.keyframes?.volume) ch.push(EVAL_FRAME, `volume='${kfExpr(c.keyframes.volume)}':eval=frame`, REFRAME);
    if (c.fade_in) ch.push(`afade=t=in:st=0:d=${Number(c.fade_in)}`);
    if (c.fade_out) ch.push(`afade=t=out:st=${Math.max(0, dur - Number(c.fade_out))}:d=${Number(c.fade_out)}`);
    ch.push(`adelay=${Math.round(start * 1000)}:all=1`);
    const onBus = bus(tr).length > 0;
    if (!onBus) ch.push(...duck(tr, start, start + dur));
    graph.push(`[${i}:a]${ch.join(",")}[a${i}]`);
    if (onBus) buses.set(tr, [...(buses.get(tr) ?? []), `[a${i}]`]);
    else labels.push(`[a${i}]`);
  });
  [...buses].forEach(([tr, ls], k) => {
    // ducking after the bus chain so a track compressor does not pull the ducked level back up
    const mine = srcs.filter((x) => x.track === tr), lo = Math.min(...mine.map((x) => parseTime(x.clip.start ?? 0))), hi = Math.max(...mine.map((x) => parseTime(x.clip.start ?? 0) + parseTime(x.clip.duration)));
    graph.push(`${ls.join("")}amix=inputs=${ls.length}:duration=longest:normalize=0,${[...bus(tr), ...duck(tr, lo, hi)].join(",")}[b${k}]`);
    labels.push(`[b${k}]`);
  });
  if (labels.length) graph.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,apad=whole_dur=${T},atrim=0:${T}[out]`);
  else { args.push("-f", "lavfi", "-i", `anullsrc=r=${sr}:cl=stereo`); graph.push(`[0:a]atrim=0:${T}[out]`); }
  const raw = outWav + ".raw.wav";
  let r = spawnSync("ffmpeg", [...args, "-filter_complex", graph.join(";"), "-map", "[out]", "-ac", "2", "-ar", String(sr), "-c:a", "pcm_f32le", raw], { encoding: "utf8" });
  if (r.status !== 0) throw new EditError(`audio mix failed: ${(r.stderr || "").trim().slice(-600)}`, "audio_failed");
  const post: string[] = [];
  const lufs = tl.settings.loudness === undefined ? -14 : tl.settings.loudness;
  if (lufs !== null && labels.length) {
    const target = `I=${Number(lufs)}:TP=-1.5:LRA=11`;
    const m = spawnSync("ffmpeg", ["-v", "info", "-nostdin", ...inp(raw), "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
    const js = (m.stderr || "").match(/\{[^{}]*\}/g);
    const meas = js ? JSON.parse(js[js.length - 1]) : null;
    if (meas && meas.input_i !== "-inf" && Number(meas.input_i) > -70)
      post.push(`loudnorm=${target}:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true,aresample=${sr}`);
  }
  post.push(`atrim=start=${t0}:end=${t1},asetpts=PTS-STARTPTS`);
  r = spawnSync("ffmpeg", ["-v", "error", "-y", "-nostdin", ...inp(raw), "-af", post.join(","), "-ac", "2", "-ar", String(sr), "-c:a", "pcm_s16le", outWav], { encoding: "utf8" });
  try { unlinkSync(raw); } catch { /* ignore */ }
  if (r.status !== 0) throw new EditError(`audio loudness pass failed: ${(r.stderr || "").trim().slice(-600)}`, "audio_failed");
  return outWav;
}
