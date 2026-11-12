// Interchange export test: builds a small edit through the API, exports FCPXML + OTIO and checks the structure.
// Run: bun tests/export.ts [--keep]          (needs ffmpeg on PATH)
// Optional real roundtrip: AGENTCUT_OTIO_PY=/path/to/python (with `pip install opentimelineio otio-fcpx-xml-adapter`)
// reads both files back with OpenTimelineIO and compares track counts, clip ranges and durations.
// Optional DTD check: AGENTCUT_FCPXML_DTD=/path/to/FCPXMLv1_10.dtd (uses xmllint).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
check("skipped: shape, effects, dip_black approximated, no duck without a voice clip, duck + eq on the music track under a voice, nothing for an empty, muted or silent track or a ducked voice",
  sk(shp1, "shape") && sk(vid3, "fields") && sk(vid2, "transition") && !sk("music", "duck") && skE("music", "duck") && skE("music", "audio_fx") &&
  !skE("bed") && !skE("off") && !skE("quiet") && !skE("vo"), { skipped: fx.skipped, withEmpty: fxE });
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
check("otio skipped text + shape", ot.skipped.some((s) => s.id === txt1) && ot.skipped.some((s) => s.id === shp1));
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
  const { captionWords, parseSrt } = await import("../src/captions.ts");
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
  check("vtt: cue text markup characters are escaped", formatCues(cue, "vtt").includes("a --&gt; b &lt;i&gt;x&lt;/i&gt; &amp; c"), formatCues(cue, "vtt"));
  const gone = join(tmp, "missing.srt");
  let err: any;
  try { parseSrt(gone); } catch (e) { err = e; }
  check("a missing srt is a named not_found error with the path in the hint", err?.code === "not_found" && err.hint?.includes(gone), { code: err?.code, hint: err?.hint });
}

console.log(`\n${failures ? `✗ ${failures} check(s) failed` : "OK - all export checks passed"}  (${tmp})`);
if (!process.argv.includes("--keep") && !failures) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
