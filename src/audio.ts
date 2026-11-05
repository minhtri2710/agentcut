// Audio mix: one FFmpeg filter graph (trim, tempo, reverse, fades, automation, ducking) + 2-pass loudness.
import { spawnSync } from "node:child_process";
import { unlinkSync } from "node:fs";
import { parseKfs } from "./anim.ts";
import { needFfmpeg } from "./media.ts";
import { type Clip, EditError, parseTime, resolve, type Timeline, totalDuration, type Track } from "./model.ts";

function atempo(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) { out.push("atempo=2.0"); s /= 2; }
  while (s < 0.5) { out.push("atempo=0.5"); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-4) out.push(`atempo=${s.toFixed(5)}`);
  return out;
}

function kfExpr(kfs: any[], v = "t"): string {
  const pts = parseKfs(kfs);
  let e = `${pts[pts.length - 1][1]}`;
  for (let i = pts.length - 2; i >= 0; i--) {
    const [t0, v0] = pts[i], [t1, v1] = pts[i + 1];
    e = `if(lt(${v},${t1}),${v0}+(${v1}-${v0})*(${v}-${t0})/${Math.max(1e-6, t1 - t0)},${e})`;
  }
  return `if(lt(${v},${pts[0][0]}),${pts[0][1]},${e})`;
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
      if (c.muted || Math.abs((Number(c.speed ?? 1) || 1) - 1) > 1e-6 || !Array.isArray(c.tracks)) continue; // retimed compounds: no nested audio
      const w0 = parseTime(c.in ?? 0);
      yield* flatClips(c.tracks, { base: parseTime(c.start ?? 0), w0, w1: w0 + parseTime(c.duration), gain: gain * Number(c.volume ?? 1), track });
    }
  }
}

export function audioSources(tl: Timeline) {
  const out: { track: Track; clip: Clip; path: string; volume: number }[] = [];
  for (const { track, clip: c, gain } of flatClips(tl.tracks)) {
    if (c.muted || (c.type !== "video" && c.type !== "audio") || c.freeze || c.keyframes?.speed) continue;
    const a = tl.assets[c.asset];
    if (!a || (!a.has_audio && a.kind !== "audio")) continue;
    const vol = Number(c.volume ?? 1) * gain;
    if (vol > 0) out.push({ track, clip: c, path: a.path, volume: vol });
  }
  return out;
}

export function buildAudio(tl: Timeline, outWav: string, t0 = 0, t1?: number): string {
  needFfmpeg();
  resolve(tl);
  const T = Math.max(0.04, totalDuration(tl));
  t1 ??= T;
  const sr = Number(tl.settings.sample_rate ?? 48000);
  const srcs = audioSources(tl);
  // voice intervals for ducking
  const voice: [number, number][] = [];
  for (const { track: tr, clip: c } of flatClips(tl.tracks))
    if ((tr.role === "voice" || tr.role === "dialogue") && (c.type === "audio" || c.type === "video")) { const s = parseTime(c.start ?? 0); voice.push([s, s + parseTime(c.duration)]); }
  voice.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of voice) { const l = merged[merged.length - 1]; if (l && s - l[1] < 0.5) l[1] = Math.max(l[1], e); else merged.push([s, e]); }
  const args = ["-v", "error", "-y", "-nostdin"];
  const graph: string[] = [], labels: string[] = [];
  srcs.forEach((s, i) => {
    const c = s.clip;
    if (c.loop) args.push("-stream_loop", "-1");
    args.push("-i", s.path);
    const speed = Number(c.speed ?? 1) || 1, cin = parseTime(c.in ?? 0), dur = parseTime(c.duration), start = parseTime(c.start ?? 0);
    const ch = [`atrim=start=${cin}:duration=${dur * speed}`, "asetpts=PTS-STARTPTS"];
    if (c.reverse) ch.push("areverse");
    ch.push(...atempo(speed), `aresample=${sr}`, "aformat=sample_fmts=fltp:channel_layouts=stereo", `volume=${s.volume.toFixed(4)}`);
    if (c.keyframes?.volume) ch.push(`volume='${kfExpr(c.keyframes.volume)}':eval=frame`);
    if (c.fade_in) ch.push(`afade=t=in:st=0:d=${Number(c.fade_in)}`);
    if (c.fade_out) ch.push(`afade=t=out:st=${Math.max(0, dur - Number(c.fade_out))}:d=${Number(c.fade_out)}`);
    ch.push(`adelay=${Math.round(start * 1000)}:all=1`);
    if (s.track.duck && merged.length && s.track.role !== "voice" && s.track.role !== "dialogue") {
      const g = 10 ** (Number(s.track.duck) / 20), r = 0.25;
      const terms = merged.map(([a0, a1]) => `clip(min((t-${(a0 - r).toFixed(3)})/${r},(${(a1 + r).toFixed(3)}-t)/${r}),0,1)`);
      const e = terms.reduce((acc, x) => `max(${acc},${x})`);
      ch.push(`volume='1-${(1 - g).toFixed(4)}*${e}':eval=frame`);
    }
    graph.push(`[${i}:a]${ch.join(",")}[a${i}]`);
    labels.push(`[a${i}]`);
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
    const m = spawnSync("ffmpeg", ["-v", "info", "-nostdin", "-i", raw, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
    const js = (m.stderr || "").match(/\{[^{}]*\}/g);
    const meas = js ? JSON.parse(js[js.length - 1]) : null;
    if (meas && meas.input_i !== "-inf" && Number(meas.input_i) > -70)
      post.push(`loudnorm=${target}:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true,aresample=${sr}`);
  }
  post.push(`atrim=start=${t0}:end=${t1},asetpts=PTS-STARTPTS`);
  r = spawnSync("ffmpeg", ["-v", "error", "-y", "-nostdin", "-i", raw, "-af", post.join(","), "-ac", "2", "-ar", String(sr), "-c:a", "pcm_s16le", outWav], { encoding: "utf8" });
  try { unlinkSync(raw); } catch { /* ignore */ }
  if (r.status !== 0) throw new EditError(`audio loudness pass failed: ${(r.stderr || "").trim().slice(-600)}`, "audio_failed");
  return outWav;
}
