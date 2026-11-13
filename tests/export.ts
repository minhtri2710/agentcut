// Interchange export test: builds a small edit through the API, exports FCPXML + OTIO and checks the structure.
// Run: bun tests/export.ts [--keep]          (needs ffmpeg on PATH)
// Optional real roundtrip: AGENTCUT_OTIO_PY=/path/to/python (with `pip install opentimelineio otio-fcpx-xml-adapter`)
// reads both files back with OpenTimelineIO and compares track counts, clip ranges and durations.
// Optional DTD check: AGENTCUT_FCPXML_DTD=/path/to/FCPXMLv1_10.dtd (uses xmllint).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-export-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("../src/api.ts");
const { resolve } = await import("../src/model.ts");
const { Project } = await import("../src/project.ts");
const { exportFcpxml, exportOtio, exportTimeline } = await import("../src/export.ts");

let failures = 0;
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 600) : ""); }
}
function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

const m = join(tmp, "media dir"); // space + unicode exercise file:// URL encoding
mkdirSync(m);
const A = join(m, "a clip.mp4"), B = join(m, "bé.mp4"), G = join(m, "green.mp4"), P = join(m, "p.png"), MU = join(m, "beat.wav");
ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-shortest", "-pix_fmt", "yuv420p", A);
ff("-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-shortest", "-pix_fmt", "yuv420p", B);
ff("-f", "lavfi", "-i", "color=c=0x00ff00:size=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", G);
ff("-f", "lavfi", "-i", "gradients=size=800x800:n=4", "-frames:v", "1", P);
ff("-f", "lavfi", "-i", "sine=f=60:d=12", "-ac", "2", MU);

const dir = join(tmp, "proj");
api.create(dir, { preset: "square", fps: 30 });
const r = await api.apply(dir, [
  { op: "add_clip", track: "main", src: A, in: 0.5, duration: 2.5 },                                    // vid1 0..75
  { op: "add_clip", track: "main", src: P, duration: 2, transition: "crossfade", fit: "contain" },        // img1 60..120 (15f overlap)
  { op: "add_clip", track: "main", src: B, duration: 2, speed: 2, transition: { type: "dip_black", duration: 0.4 } }, // vid2 108..168
  { op: "add_clip", track: "main", src: A, in: 1, duration: 1.5, muted: true, effects: [{ type: "grain" }] }, // vid3 168..213
  { op: "add_clip", track: "text", text: "Hello & <world>", attach_to: "main#0", offset: 0.5, duration: 1.5, font: "Arial Bold", font_size: 72, color: "#ffcc00" },
  { op: "add_clip", track: "overlay", src: G, at: 1, duration: 2 },
  { op: "add_clip", track: "overlay", src: G, at: 2, duration: 1.5 },                                    // overlaps -> second lane
  { op: "add_clip", track: "overlay", type: "shape", shape: "star", size: [100, 100], at: 0, duration: 1 }, // skipped
  { op: "add_clip", track: "music", src: MU, volume: 0.5, fade_in: 0.5, until_end: true },
  { op: "add_marker", t: 3, label: "check this" },
]);
check("project built", r.ok && r.errors === 0, r);
const ids = r.results.map((x: any) => x.id).filter(Boolean);
const [vid1, img1, vid2, vid3, txt1, ov1, ov2, shp1, mus1] = ids;

const p = new Project(dir);
const tl = p.absolutized(resolve(p.load()));

// ---------------------------------------------------------------- FCPXML
console.log("fcpxml");
const fx = exportFcpxml(tl);
const xml = fx.xml;
const tag = (name: string) => [...xml.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "g"))].map((x) => Object.fromEntries([...x[1].matchAll(/(\w[\w-]*)="([^"]*)"/g)].map((a) => [a[1], a[2]])));
const byName = (t: string, n: string) => tag(t).find((a) => a.name === n) ?? {};
check("fcpxml 1.10 header", xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.10">'));
check("sequence format 100/3000s 1080x1080", tag("format")[0]?.frameDuration === "100/3000s" && tag("format")[0]?.width === "1080");
check("sequence duration 213f", tag("sequence")[0]?.duration === "21300/3000s", tag("sequence")[0]);
check("file:// URLs are encoded", xml.includes("file://") && xml.includes("media%20dir/a%20clip.mp4") && xml.includes("b%C3%A9.mp4"));
const v1 = byName("asset-clip", vid1), v2 = byName("asset-clip", vid2), v3 = byName("asset-clip", vid3);
check("vid1 trimmed to the cut (67f), in 15f", v1.offset === "0s" && v1.duration === "6700/3000s" && v1.start === "1500/3000s", v1);
check("still as clip>video, 67..114", byName("clip", img1).offset === "6700/3000s" && byName("clip", img1).duration === "4700/3000s", byName("clip", img1));
check("vid2 head-trimmed by 6f at speed 2 (local start 6f)", v2.offset === "11400/3000s" && v2.duration === "5400/3000s" && v2.start === "600/3000s", v2);
check("speed 2 -> timeMap", /<timeMap>\s*<timept time="0s" value="0s" interp="linear"\/>\s*<timept time="2s" value="4s" interp="linear"\/>/.test(xml));
check("muted -> srcEnable=video", v3.srcEnable === "video" && v3.offset === "16800/3000s" && v3.start === "1s", v3);
const tr = tag("transition");
check("two transitions centred on the cuts", tr.length === 2 && tr[0].offset === "2s" && tr[0].duration === "1500/3000s" && tr[1].offset === "10800/3000s" && tr[1].duration === "1200/3000s", tr);
const t1 = byName("title", txt1);
check("title anchored to vid1 at local 30f, lane 3", t1.lane === "3" && t1.offset === "1s" && t1.duration === "4500/3000s", t1);
check("title text escaped + style", xml.includes("Hello &amp; &lt;world&gt;") && /font="Arial" fontSize="72" fontFace="Bold" fontColor="1 0.8 0 1"/.test(xml));
check("Basic Title effect", xml.includes('name="Basic Title"'));
const o1 = byName("asset-clip", ov1), o2 = byName("asset-clip", ov2);
check("overlapping overlays on lanes 1 and 2", o1.lane === "1" && o1.offset === "4500/3000s" && o2.lane === "2" && o2.offset === "7500/3000s", [o1, o2]);
const mu = byName("asset-clip", mus1);
check("music on lane -1, until_end 213f, music role", mu.lane === "-1" && mu.duration === "21300/3000s" && mu.audioRole === "music", mu);
check("volume 0.5 -> -6.02dB with fade-in", /<adjust-volume amount="-6.02dB">\s*<param name="amount">\s*<fadeIn type="easeIn" duration="1500\/3000s"\/>/.test(xml));
check("fit contain -> adjust-conform fit", /<clip [^>]*name="img1"[^>]*>\s*<adjust-conform type="fit"\/>/.test(xml));
check("marker on the covering clip", /<marker start="2300\/3000s" duration="100\/3000s" value="check this"\/>/.test(xml));
const sk = (id: string, type?: string) => fx.skipped.some((s) => s.id === id && (!type || s.type === type));
const ap = (r: { approximated?: { id: string; type: string }[] }, id: string, type: string) => (r.approximated ?? []).some((s) => s.id === id && s.type === type);
const unique = (r: { skipped: object[]; approximated?: object[] }) => [r.skipped, r.approximated ?? []].every((l) => new Set(l.map((e) => JSON.stringify(e))).size === l.length);
// a track setting is reported only where it changes the render: on a track that feeds the mix, and duck only under a voice clip, never on a voice track
const musicTr = tl.tracks.find((t) => t.id === "music")!;
const quiet = musicTr.clips.map((c) => ({ ...c, muted: true }));
const withEmpty = { ...tl, tracks: [...tl.tracks.map((t) => (t === musicTr ? { ...t, eq: "voice" } : t)),
  { id: "bed", kind: "audio", duck: -20, eq: "voice", clips: [] },
  { id: "off", kind: "audio", duck: -20, eq: "voice", muted: true, clips: musicTr.clips },
  { id: "quiet", kind: "audio", duck: -20, eq: "voice", clips: quiet },
  { id: "vo", kind: "audio", role: "voice", duck: -20, clips: musicTr.clips }] } as typeof tl;
const fxE = exportFcpxml(withEmpty).skipped;
const skE = (id: string, type?: string) => fxE.some((s) => s.id === id && (!type || s.type === type));
check("skipped: shape, effects, dip_black not skipped, no duck without a voice clip, duck + eq on the music track under a voice, nothing for an empty, muted or silent track or a ducked voice",
  sk(shp1, "shape") && sk(vid3, "fields") && !sk(vid2, "transition") && ap(fx, vid2, "transition") && !sk("music", "duck") && skE("music", "duck") && skE("music", "audio_fx") &&
  !skE("bed") && !skE("off") && !skE("quiet") && !skE("vo"), { skipped: fx.skipped, withEmpty: fxE });
const inherited = exportFcpxml({ ...tl, tracks: tl.tracks.map((t) => (t === musicTr ? { ...t, role: "toString" } : t)) }).xml;
check("a track role that only the prototype chain holds gives no audio role", !inherited.includes("native code") && !/<asset-clip[^>]*name="mus1"[^>]*audioRole/.test(inherited), inherited.match(/audioRole="[^"]*"/g));
check("clip count", fx.clips === 8, fx.clips);
const fcpOut = join(tmp, "out", "edit.fcpxml");
const res = exportTimeline(tl, "fcpxml", fcpOut);
check("exportTimeline writes fcpxml", res.output === fcpOut && readFileSync(fcpOut, "utf8") === xml && res.clips === 8);
const lint = spawnSync("xmllint", ["--noout", fcpOut], { encoding: "utf8" });
if (lint.error) console.log("  - xmllint not found, well-formedness check skipped");
else check("xmllint well-formed", lint.status === 0, lint.stderr);
if (process.env.AGENTCUT_FCPXML_DTD && !lint.error) {
  const v = spawnSync("xmllint", ["--noout", "--dtdvalid", process.env.AGENTCUT_FCPXML_DTD, fcpOut], { encoding: "utf8" });
  check("valid against FCPXML DTD", v.status === 0, v.stderr);
}

// ---------------------------------------------------------------- OTIO
console.log("otio");
const ot = exportOtio(tl);
const doc = JSON.parse(ot.json);
const tracks = doc.tracks.children;
const names = tracks.map((t: any) => `${t.kind}:${t.name}`);
check("tracks: main, overlay x2, text, main audio, music", JSON.stringify(names) === JSON.stringify(["Video:main", "Video:overlay", "Video:overlay 2", "Video:text", "Audio:main audio", "Audio:music"]), names);
const dur = (t: any) => t.children.reduce((n: number, c: any) => n + (c.OTIO_SCHEMA === "Transition.1" ? 0 : c.source_range.duration.value), 0);
check("main track 213f", dur(tracks[0]) === 213, dur(tracks[0]));
const mainKids = tracks[0].children.map((c: any) => c.OTIO_SCHEMA === "Transition.1" ? `T${c.in_offset.value}/${c.out_offset.value}` : `${c.name}@${c.source_range.start_time.value}+${c.source_range.duration.value}`);
check("main: clips cut at overlap midpoints, transitions borrow handles", JSON.stringify(mainKids) === JSON.stringify([`${vid1}@15+67`, "T7/8", `${img1}@0+47`, "T6/6", `${vid2}@12+54`, `${vid3}@30+45`]), mainKids);
const c2 = tracks[0].children.find((c: any) => c.name === vid2);
check("speed 2 -> LinearTimeWarp", c2.effects[0]?.OTIO_SCHEMA === "LinearTimeWarp.1" && c2.effects[0].time_scalar === 2);
check("ExternalReference file:// url", c2.media_references.DEFAULT_MEDIA.target_url.endsWith("/b%C3%A9.mp4") && c2.active_media_reference_key === "DEFAULT_MEDIA");
const aud = tracks[4].children.map((c: any) => `${c.OTIO_SCHEMA.split(".")[0]}${c.name ? ":" + c.name : ""}+${c.source_range?.duration.value}`);
check("main audio: vid1, gap (still), vid2, gap (muted vid3)", JSON.stringify(aud) === JSON.stringify([`Clip:${vid1}+67`, "Gap+47", `Clip:${vid2}+54`, "Gap+45"]), aud);
const ovl = tracks[2].children.map((c: any) => `${c.OTIO_SCHEMA.split(".")[0]}+${c.source_range.duration.value}`);
check("overlay lane 2 padded with a gap", JSON.stringify(ovl) === JSON.stringify(["Gap+60", "Clip+45"]), ovl);
const txt = tracks[3].children.find((c: any) => c.metadata?.agentcut?.text);
check("text -> named Gap with metadata", txt?.OTIO_SCHEMA === "Gap.1" && txt.metadata.agentcut.text === "Hello & <world>" && txt.source_range.duration.value === 45);
const music = tracks[5].children[0];
check("music clip with volume metadata", music.OTIO_SCHEMA === "Clip.2" && music.source_range.duration.value === 213 && music.metadata.agentcut.volume === 0.5);
check("stack marker", doc.tracks.markers[0]?.name === "check this" && doc.tracks.markers[0].marked_range.start_time.value === 90);
check("otio: text is approximated (a named Gap), the shape is skipped", ap(ot, txt1, "text") && !ot.skipped.some((s) => s.id === txt1) && ot.skipped.some((s) => s.id === shp1));
check("no two entries of a result are identical", unique(fx) && unique(ot), { fcpxml: fx, otio: { skipped: ot.skipped, approximated: ot.approximated } });
// each approximation lands in `approximated` and not in `skipped`
const mut = (f: (t: typeof tl) => void) => { const t = structuredClone(tl); f(t); return { f: exportFcpxml(t), o: exportOtio(t) }; };
const clipOf = (t: typeof tl, id: string) => t.tracks.flatMap((x) => x.clips).find((c) => c.id === id)!;
const blur = mut((t) => { Object.assign(clipOf(t, vid1), { fit: "blur", effects: [{ type: "grain" }] }); });
const fitsOf = (r: { approximated?: { id: string; type: string; reason: string }[] }) => (r.approximated ?? []).filter((e) => e.id === vid1 && e.type === "fit");
check("fit blur: one approximated entry per format that names the fit it was exported as, none in skipped",
  fitsOf(blur.f).length === 1 && /fit 'blur' exported as fit 'contain'/.test(fitsOf(blur.f)[0].reason) && fitsOf(blur.o).length === 1 && /fit 'blur' exported as the NLE's default fit/.test(fitsOf(blur.o)[0].reason) &&
  !blur.f.skipped.some((e) => /fit/.test(e.reason)) && !blur.o.skipped.some((e) => /fit/.test(e.reason)) && unique(blur.f) && unique(blur.o), { f: blur.f.approximated, o: blur.o.approximated, fs: blur.f.skipped, os: blur.o.skipped });
check("a clip with an approximation and a dropped field gets one entry in each list",
  blur.f.skipped.filter((e) => e.id === vid1 && e.type === "fields").length === 1 && blur.o.skipped.filter((e) => e.id === vid1 && e.type === "fields").length === 1);
const stretch = mut((t) => { Object.assign(clipOf(t, vid1), { fit: "fill" }); });
check("fit fill (stretch) in FCPXML is exported as fit 'cover'", /fit 'fill' exported as fit 'cover'/.test(fitsOf(stretch.f)[0]?.reason ?? "") && !stretch.f.skipped.some((e) => /fit/.test(e.reason)));
const ramp = mut((t) => { Object.assign(clipOf(t, vid1), { keyframes: { speed: [{ t: 0, v: 1 }, { t: 1, v: 2 }] } }); });
check("speed ramp: approximated as constant speed in both formats", ap(ramp.f, vid1, "speed_ramp") && ap(ramp.o, vid1, "speed_ramp") && !ramp.f.skipped.some((e) => e.type === "speed_ramp") && !ramp.o.skipped.some((e) => e.type === "speed_ramp"));
const kfOf = (r: { skipped: { id: string; reason: string }[] }) => r.skipped.filter((e) => e.id === vid1 && /keyframes/.test(e.reason));
const mixed = mut((t) => { Object.assign(clipOf(t, vid1), { keyframes: { speed: [{ t: 0, v: 1 }, { t: 1, v: 2 }], opacity: [{ t: 0, v: 1 }, { t: 1, v: 0 }] } }); });
check("a speed-only ramp is listed only in approximated; with another keyframed property 'keyframes' stays in skipped too",
  !kfOf(ramp.f).length && !kfOf(ramp.o).length && ap(ramp.f, vid1, "speed_ramp") && kfOf(mixed.f).length === 1 && kfOf(mixed.o).length === 1 && ap(mixed.f, vid1, "speed_ramp"), { ramp: ramp.f.skipped, mixed: mixed.f.skipped });
const audioOnly = mut((t) => { t.tracks[0].clips.push({ ...structuredClone(clipOf(t, mus1)), id: "aud1", start: 8, duration: 1 }); });
check("an audio-only clip on the primary storyline is approximated as a gap", ap(audioOnly.f, "aud1", "audio") && ap(audioOnly.o, "aud1", "audio") && !audioOnly.f.skipped.some((e) => e.id === "aud1"), { f: audioOnly.f, o: audioOnly.o.approximated });
const squeezed = mut((t) => { clipOf(t, vid2).start = 70 / 30; });
check("a transition shortened to fit its clips is approximated", ap(squeezed.f, vid2, "transition") && (squeezed.f.approximated ?? []).some((e) => /shortened/.test(e.reason)) && !squeezed.f.skipped.some((e) => /shortened/.test(e.reason)), squeezed.f.approximated);
// the lists of the two formats name the same things; they differ only where a format carries more
const fieldsOf = (r: { skipped: { id: string; type: string; reason: string }[] }, id: string) => r.skipped.filter((e) => e.id === id && e.type === "fields").map((e) => e.reason);
check("a title's fill colour is exported, so it is not listed as a dropped colour grade (either format)", !fieldsOf(fx, txt1).length && !fieldsOf(ot, txt1).length, { f: fx.skipped, o: ot.skipped });
const titled = mut((t) => { Object.assign(clipOf(t, txt1), { enter: "fade", exit: "fade", shadow: true, effects: [{ type: "grain" }] }); });
check("a title with an animation, a shadow and an effect gets the same 'not exported' entry in both formats",
  fieldsOf(titled.f, txt1).length === 1 && /enter animation, exit animation/.test(fieldsOf(titled.f, txt1)[0]) && JSON.stringify(fieldsOf(titled.f, txt1)) === JSON.stringify(fieldsOf(titled.o, txt1)), { f: titled.f.skipped, o: titled.o.skipped });
const volOf = (r: { approximated?: { id: string; type: string; reason: string }[] }, id: string) => (r.approximated ?? []).filter((e) => e.id === id && e.type === "volume");
check("the same volume: OTIO lists it as kept only in metadata, FCPXML writes it and lists nothing", volOf(ot, mus1).length === 1 && /0\.5\b.*metadata/.test(volOf(ot, mus1)[0].reason) && !volOf(fx, mus1).length && /<adjust-volume amount="-6.02dB"/.test(xml), { o: ot.approximated, f: fx.approximated });
check("a clip at full volume has no volume entry", !volOf(ot, vid1).length && !volOf(fx, vid1).length);
const longer = (d: number, extra: object = {}) => mut((t) => { Object.assign(clipOf(t, mus1), { duration: d, ...extra }); });
const srcOf = (r: { approximated?: { id: string; type: string; reason: string }[] }) => (r.approximated ?? []).filter((e) => e.id === mus1 && e.type === "source_length");
const over = longer(14), edge = longer(12.04), edge2 = longer(12.06), looped = longer(14, { loop: true });
check("a clip longer than its source is approximated in both formats, with its need and the source length",
  [over.f, over.o].every((r) => srcOf(r).length === 1 && srcOf(r)[0].reason === `clip ${mus1} needs 14 s, source has 12 s` && !r.skipped.some((e) => /source/.test(e.reason))) && !srcOf(fx).length && !srcOf(ot).length, { f: over.f.approximated, o: over.o.approximated });
check("the margin is validate's: 0.04 s over is not listed, 0.06 s over is", !srcOf(edge.f).length && !srcOf(edge.o).length && srcOf(edge2.f).length === 1 && srcOf(edge2.o).length === 1);
check("a loop clip is listed as well: neither format writes the loop, so its range runs past the source", srcOf(looped.f).length === 1 && srcOf(looped.o).length === 1 && fieldsOf(looped.f, mus1).some((x) => /loop/.test(x)) && fieldsOf(looped.o, mus1).some((x) => /loop/.test(x)), { f: looped.f, o: looped.o.approximated });
const otioOut = join(tmp, "out", "edit.otio");
if (typeof (api as any).exportTimeline === "function") { // wired through api.ts (CLI `export` / `render -o x.fcpxml`)
  const viaApi = await (api as any).exportTimeline(dir, { out: join(tmp, "out", "api.otio") });
  check("api.exportTimeline picks otio from the extension", viaApi.format === "otio" && viaApi.clips > 0, viaApi);
}
check("exportTimeline writes otio", exportTimeline(tl, "otio", otioOut).format === "otio");
let threw = false;
try { exportTimeline(tl, "edl", join(tmp, "x.edl")); } catch (e: any) { threw = e.code === "bad_format"; }
check("unknown format rejected", threw);
// unknown / future clip types never crash
const weird = structuredClone(tl);
weird.tracks[0].clips.splice(1, 0, { id: "cmp1", type: "compound", duration: 1, start: 2, tracks: [] } as any);
weird.tracks[1].clips.push({ id: "zz1", type: "hologram", duration: 1, start: 0 } as any);
const wf = exportFcpxml(weird), wo = exportOtio(weird);
check("unknown types skipped, not fatal", wf.skipped.some((s) => s.id === "cmp1") && wo.skipped.some((s) => s.id === "zz1"));

// ---------------------------------------------------------------- real roundtrip through OpenTimelineIO (optional)
const PY = process.env.AGENTCUT_OTIO_PY;
if (PY) {
  console.log("opentimelineio roundtrip");
  const script = join(tmp, "rt.py");
  writeFileSync(script, `
import json, sys
import opentimelineio as otio
def desc(tl):
    out = []
    for t in tl.tracks:
        items = []
        for c in t:
            if isinstance(c, otio.schema.Transition):
                items.append({"s": "T", "in": c.in_offset.value, "out": c.out_offset.value}); continue
            r = c.trimmed_range_in_parent()
            items.append({"s": c.schema_name(), "name": c.name, "start": c.source_range.start_time.value, "dur": c.source_range.duration.value, "at": r.start_time.value,
                          "url": getattr(c.media_reference, "target_url", None) if isinstance(c, otio.schema.Clip) else None})
        out.append({"name": t.name, "kind": t.kind, "dur": t.duration().value, "items": items})
    return {"dur": tl.duration().value, "rate": tl.duration().rate, "tracks": out}
o = otio.adapters.read_from_file(sys.argv[1])
x = otio.adapters.read_from_file(sys.argv[2], adapter_name="fcpx_xml")
tl = x if isinstance(x, otio.schema.Timeline) else next(iter(x.find_children(descended_from_type=otio.schema.Timeline)), None) or x[0]
def norm(v):
    if isinstance(v, dict): return {k: norm(x) for k, x in v.items()}
    if isinstance(v, list): return [norm(x) for x in v]
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else v
same = norm(json.loads(otio.adapters.write_to_string(o, "otio_json"))) == norm(json.loads(open(sys.argv[1]).read()))
print(json.dumps({"otio": desc(o), "fcpx": desc(tl), "reserialized": same}))
`);
  const py = spawnSync(PY, [script, otioOut, fcpOut], { encoding: "utf8" });
  if (py.status !== 0) check("python roundtrip ran", false, py.stderr.slice(-1500));
  else {
    const rt = JSON.parse(py.stdout.trim().split("\n").at(-1)!);
    const O = rt.otio, Fx = rt.fcpx;
    check("otio: loads, 6 tracks, 213f", O.tracks.length === 6 && O.dur === 213 && O.rate === 30, { n: O.tracks.length, d: O.dur });
    check("otio: every track ends <= 213f", O.tracks.every((t: any) => t.dur <= 213), O.tracks.map((t: any) => t.dur));
    const om = O.tracks[0].items.filter((i: any) => i.s === "Clip").map((i: any) => [i.name, i.at, i.start, i.dur]);
    check("otio: main clip ranges", JSON.stringify(om) === JSON.stringify([[vid1, 0, 15, 67], [img1, 67, 0, 47], [vid2, 114, 12, 54], [vid3, 168, 30, 45]]), om);
    check("otio: reserialises identically", rt.reserialized === true);
    // fcpx_xml adapter: lanes become tracks; titles/transitions are not modelled by that adapter
    const fl = (lane: string) => Fx.tracks.find((t: any) => t.name === lane);
    const f0 = fl("0")?.items.filter((i: any) => i.s === "Clip").map((i: any) => [i.at, i.start, i.dur]);
    check("fcpx: storyline clip ranges (start = local time)", JSON.stringify(f0) === JSON.stringify([[0, 15, 67], [67, 0, 47], [114, 6, 54], [168, 30, 45]]), f0);
    check("fcpx: overlay lanes at 30f / 60f", fl("1")?.items.find((i: any) => i.s === "Clip")?.at === 30 && fl("2")?.items.find((i: any) => i.s === "Clip")?.at === 60, [fl("1"), fl("2")]);
    check("fcpx: music lane -1 audio 0..213", fl("-1")?.kind === "Audio" && fl("-1").items[0].at === 0 && fl("-1").items[0].dur === 213, fl("-1"));
    check("fcpx: storyline 213f", fl("0")?.dur === 213, fl("0")?.dur);
  }
} else console.log("  - AGENTCUT_OTIO_PY not set: OpenTimelineIO roundtrip skipped");

console.log("caption sources and subtitle export");
{
  const { captionWords, parseSrt, phrasesToWords } = await import("../src/captions.ts");
  const { formatCues } = await import("../src/subtitles.ts");
  const code = (f: () => unknown) => { try { f(); return "ok"; } catch (e: any) { return e.code ?? e.message; } };
  const ws: any[] = captionWords({ words: [{ text: "a", start: "1.5s", end: "00:02.5" }, { text: "b", s: "500ms", e: 3 }] });
  check("caption word times written as strings are parsed", ws[0].start === 1.5 && ws[0].end === 2.5 && ws[1].start === 0.5 && ws[1].end === 3, ws);
  check("a caption word time that is not a time is refused as bad_time", code(() => captionWords({ words: [{ text: "a", start: "soon", end: 1 }] })) === "bad_time");
  const cue = [{ start: 0, end: 1, text: "a --> b <i>x</i> & c", clip: "c1" }];
  for (const fmt of ["srt", "vtt"] as const) {
    const body = formatCues(cue, fmt).split("\n").filter((l) => l.includes("-->"));
    check(`${fmt}: only the timing line holds the cue arrow`, body.length === 1 && /^\d\d:\d\d:\d\d[,.]\d{3} --> /.test(body[0]), body);
  }
  check("srt: cue text keeps its characters (no entity shows literally)", formatCues(cue, "srt").includes("<i>x</i> & c") && !formatCues(cue, "srt").includes("&gt;"), formatCues(cue, "srt"));
  check("vtt: cue text markup characters are escaped", formatCues(cue, "vtt").includes("a --&gt; b &lt;i&gt;x&lt;/i&gt; &amp; c"), formatCues(cue, "vtt"));
  const rt = join(tmp, "arrow.srt");
  writeFileSync(rt, formatCues([{ start: 0, end: 1, text: "a --> b", clip: "c1" }], "srt"));
  check("an exported srt reads back to the same words (the cue arrow in text included)", parseSrt(rt).map((w) => w.text).join("|") === "a --> b", parseSrt(rt));
  // a .vtt reads back to the characters it was written from: entities are decoded (after the tags are stripped), SubRip text is not, and comment, style and region blocks are no cues
  const vttPath = join(tmp, "round.vtt");
  writeFileSync(vttPath, formatCues([{ start: 0, end: 1, text: "a & <b> c &amp; --> d", clip: "c1" }], "vtt"));
  check("an exported vtt reads back to the same words (&, <, > and the cue arrow in text included)", parseSrt(vttPath).map((w) => w.text).join("|") === "a & <b> c &amp; --> d", parseSrt(vttPath));
  writeFileSync(vttPath, "WEBVTT\n\n00:00.000 --> 00:01.000\n<i>x</i> &lt;i&gt; &nbsp;&#65;&#x42;&#0;&#1114112;&lrm;\n");
  check("vtt: tags are stripped before character references are decoded (named and numeric; an invalid number stays)", JSON.stringify(parseSrt(vttPath).map((w) => w.text)) === JSON.stringify(["x <i> \u00a0AB&#0;&#1114112;\u200e"]), parseSrt(vttPath));
  writeFileSync(vttPath, "WEBVTT\n\nNOTE 00:00.000 --> 00:01.000 a comment\nmore comment\n\nSTYLE\n::cue { color: red }\n\nREGION\nid:r\n\nNOTE\nsee 1\n\n00:02.000 --> 00:03.000\nreal\n");
  check("vtt: NOTE, STYLE and REGION blocks are not cues", JSON.stringify(parseSrt(vttPath).map((w) => w.text)) === JSON.stringify(["real"]), parseSrt(vttPath));
  writeFileSync(vttPath, "WEBVTT\n\n00:00.000 --> 00:01.000\n&Lt; &NBSP; &lt; &nbsp; &#X41;\n");
  check("vtt: character reference names are case-sensitive (&Lt; and &NBSP; stay as written, &lt; and &nbsp; decode)", JSON.stringify(parseSrt(vttPath).map((w) => w.text)) === JSON.stringify(["&Lt; &NBSP; < \u00a0 A"]), parseSrt(vttPath));
  writeFileSync(vttPath, "WEBVTT\n\n00:00.000 --> 00:01.000\n10&nbsp;km now\n");
  check("vtt: a decoded no-break space does not split a caption word", JSON.stringify(phrasesToWords(parseSrt(vttPath)).map((w) => w.text)) === JSON.stringify(["10\u00a0km", "now"]), phrasesToWords(parseSrt(vttPath)));
  // the same cue gives the same words everywhere text is split: sentence and clause paging, and the reveal count of a text clip
  const { scriptToWords, splitSentences } = await import("../src/captions.ts");
  check("a no-break space joins one word in sentence and clause paging too", splitSentences("Wait.\u00a010\u00a0km now.").length === 1
    && JSON.stringify(scriptToWords("Wait,\u00a010\u00a0km now.", [[0, 1], [1, 2]]).map((w) => w.text)) === JSON.stringify(["Wait,\u00a010\u00a0km", "now."]), scriptToWords("Wait,\u00a010\u00a0km now.", [[0, 1], [1, 2]]));
  const named = captionWords({ words: [{ text: "New\tYork", start: 1, end: 2.2 }, { text: "is", start: 2.2, end: 3 }, { text: "big", start: 3, end: 4 }] });
  check("a caption entry holding several words becomes one entry per word, its time shared by length, contiguous", named.map((w) => w.text).join("|") === "New|York|is|big" && named[0].start === 1 && named[1].end === 2.2 && named[0].end === named[1].start
    && Math.abs(named[0].end - (1 + 1.2 * 3 / 7)) < 1e-9, named);
  const { layout, TextStyle } = await import("../src/text.ts");
  check("the words of a caption page and the layout words of its text agree, so the active word is the one meant", layout(named.map((w) => w.text).join(" "), new TextStyle({ font_size: 40, color: "#fff" }, 1, 360), 1e5).count === named.length);
  const nb = join(tmp, "nbsp-reveal");
  api.create(nb, { preset: "square", empty: true });
  await api.apply(nb, [{ op: "add_clip", track: "text", type: "text", text: "10\u00a0km now", duration: 3, enter: { type: "words", duration: 1 } }]);
  const half = readFileSync((await api.frame(nb, 0.5)).image), full = readFileSync((await api.frame(nb, 1.5)).image);
  check("a text clip of two words (one joined by a no-break space) shows one of them half way through a word reveal", !half.equals(full));
  const bomSrt = join(tmp, "bom.srt"); // the WEBVTT header marks WebVTT, not the .vtt extension
  writeFileSync(bomSrt, "\ufeffWEBVTT\n\n00:00.000 --> 00:01.000\na &lt;b&gt;\n");
  check("a body with a BOM and a WEBVTT header at a .srt path reads as WebVTT (decoded)", JSON.stringify(parseSrt(bomSrt).map((w) => w.text)) === JSON.stringify(["a <b>"]), parseSrt(bomSrt));
  const srtEnt = join(tmp, "ent.srt");
  writeFileSync(srtEnt, "1\n00:00:00,000 --> 00:00:01,000\na &amp; b &lt;\n");
  check("srt: character references stay literal text", parseSrt(srtEnt).map((w) => w.text).join("|") === "a &amp; b &lt;", parseSrt(srtEnt));
  // a soft subtitle stream keeps the caption's characters: webvtt stores entities (stream copy), mov_text and SubRip store plain text
  const { embedSubtitles } = await import("../src/subtitles.ts");
  const payload = (f: string) => spawnSync("ffmpeg", ["-v", "error", "-i", f, "-map", "0:s", "-c:s", "copy", "-f", "data", "-"], { encoding: "buffer" }).stdout;
  ff("-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=1", "-c:v", "libvpx-vp9", join(m, "sub.webm"));
  ff("-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(m, "sub.mp4"));
  ff("-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(m, "sub.mkv"));
  const raw = String.raw`a --> b {b} c \ d <i>x</i> & {\i1}e \N f {s:1} g`;
  await embedSubtitles(join(m, "sub.webm"), cue);
  await embedSubtitles(join(m, "sub.mp4"), [{ start: 0, end: 1, text: raw, clip: "c1" }]);
  await embedSubtitles(join(m, "sub.mkv"), [{ start: 0, end: 1, text: raw, clip: "c1" }]);
  check("webm: the cue text is stored escaped, so a player shows the literal characters", payload(join(m, "sub.webm")).toString("utf8") === "a --&gt; b &lt;i&gt;x&lt;/i&gt; &amp; c", payload(join(m, "sub.webm")).toString("utf8"));
  // the srt reader reads <tags>, {...} overrides and \N: each is stored with an invisible joiner after its first character, so no player acts on it
  const mp4 = payload(join(m, "sub.mp4")), mkv = payload(join(m, "sub.mkv")).toString("utf8");
  const live = (t: string) => /<(?!\u2060)|\{(?=\\)|\\(?=[Nn])/.test(t);
  const mp4Text = mp4.subarray(2, 2 + mp4.readUInt16BE(0)).toString("utf8");
  check("mp4: the cue text is stored as plain text with no style box, markup characters kept", mp4Text.replaceAll("\u2060", "") === raw && !live(mp4Text) && !mp4.includes("styl"), mp4.toString("utf8"));
  check("mkv: the SubRip packet holds the cue text with no live markup", mkv.replaceAll("\u2060", "") === raw && !live(mkv), mkv);
  const gone = join(tmp, "missing.srt");
  let err: any;
  try { parseSrt(gone); } catch (e) { err = e; }
  check("a missing srt is a named not_found error with the path in the hint", err?.code === "not_found" && err.hint?.includes(gone), { code: err?.code, hint: err?.hint });
  const asDir = join(tmp, "dir.srt");
  mkdirSync(asDir);
  let dirErr: any;
  try { parseSrt(asDir); } catch (e) { dirErr = e; }
  check("a directory given as the srt is a named error with the path in the hint, not an internal one", dirErr?.code === "bad_media" && dirErr.hint?.includes(asDir), { code: dirErr?.code, hint: dirErr?.hint });
  if (process.getuid?.() !== 0) {
    const locked = join(tmp, "locked.srt");
    writeFileSync(locked, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
    chmodSync(locked, 0);
    let lockErr: any;
    try { parseSrt(locked); } catch (e) { lockErr = e; }
    check("an unreadable srt is a named error with the path in the hint", lockErr?.code === "bad_media" && lockErr.hint?.includes(locked), { code: lockErr?.code, hint: lockErr?.hint });
  } else console.log("  - running as root: the unreadable-srt row is skipped");
}

console.log(`\n${failures ? `✗ ${failures} check(s) failed` : "OK - all export checks passed"}  (${tmp})`);
if (!process.argv.includes("--keep") && !failures) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
