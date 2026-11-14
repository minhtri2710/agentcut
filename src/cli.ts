#!/usr/bin/env node
// `agentcut` CLI. Prints exactly one JSON object on stdout; progress goes to stderr.
// Exit codes: 0 ok · 1 edit/validation error · 2 usage error · 3 internal error.
import { existsSync, readFileSync, writeSync } from "node:fs";
import { recordCall } from "./feedback.ts";
import { EditError, setDotted } from "./model.ts";
import { VERSION } from "./version.ts";
const BOOL = new Set(["pretty", "json", "text", "dry-run", "allow-invalid", "guides", "draft", "no-sheet", "quiet", "markers", "full", "empty", "fast", "help", "version", "ripple", "alpha", "keep-attached", "subtitles", "spectrogram", "no-black", "allow-download"]);
// bare flag, or a value when the next argument is not a flag: `prepare --status` vs `feedback resolve ID --status wontfix`; `feedback summary --md [FILE]`
const OPT = new Set(["md", "status"]);
// value flags; any other --flag is a usage error (a dropped flag would silently change what runs)
const VALUE = new Set(["preset", "width", "height", "fps", "name", "ops", "revision", "scale", "times", "every", "count", "cols", "tile-width", "format", "ids", "beats", "min-shot", "max-shot", "cps", "source", "start", "end", "model", "frames", "pad", "quality", "workers", "codec", "threshold", "noise-db", "min-silence", "language", "port", "max-mb", "older-than", "voice", "rate", "lang", "days", "limit", "kind", "note", "title", "details", "area", "severity", "suggestion", "project", "output"]);

const HELP = `agentcut ${VERSION} - agent-first video editor (JSON timeline · CLI + MCP)

Start here:  agentcut guide
Project:     init DIR [--preset reels|youtube|square|portrait|4k] · info [--text|--json] · validate · undo [n] · redo [n] · history
Edit:        apply FILE|- [--ops JSON] [--dry-run] · op NAME key=value... · add key=value... · set ID key=value... · rm ID
             [--revision N] on any edit/undo/redo: fail with code "conflict" if the project moved past revision N
Look:        frame T [-o out.jpg|.png] [--scale 0.5] [--guides] · sheet [--every 1|--times a,b|--count 12] [--guides] · scopes T [-o out.jpg] (waveform/vectorscope/histogram + stats)
Check:       review [--beats music|a,b,..] [--min-shot 0.4] [--max-shot 6] [--cps 15] [--no-black] [--quiet]
             audio [--source F] [--spectrogram] [--start S --end S] [-o a.png] · motion [--start S --end S] [--frames 10] [-o m.jpg]
Prepare:     prepare [--status] [--quiet] [--allow-download]  (compute mattes / vision tracks that remove_background, auto_reframe, track_to need;
             preview and video render fail with code not_prepared until it ran)
             cache [info] · cache prune [--max-mb N] [--older-than 7d]  (.agentcut/cache + previews/; unreferenced files first)
Export:      render [-o out.mp4|.mov|.webm|.gif|.mp3|.wav|.png|.webp] [--start S --end S] [--draft] [--fast] [--quality draft|standard|high]
                    [--codec auto|h264|hevc|prores|prores_4444|vp9] [--alpha] [--subtitles] [--workers N] [--no-sheet]
             (the result has has_audio, contact_sheet in previews/ and loudness; a timeline with no audible clip gets no audio track)
             captions -o subs.srt|subs.vtt [--ids cap1,cap2]  (subtitle file from captions clips, timeline times)
             export -o edit.fcpxml|edit.otio  (hand off to Final Cut Pro / DaVinci Resolve / Premiere)
Analyze:     probe F · beats F [--markers] · scenes F · silence F · loudness F · transcribe F [--language vi] [--model M] [--start S --end S] · subject F [--fps 6] [--allow-download]
             (subject: a face found by YuNet, with a confidence score, else the most salient region; its 0.23 MB model is fetched only with --allow-download;
             cached in the project when one is found, so auto_reframe on a clip covering the same range at the same fps reuses it)
Voice/fonts: tts "text" -o out.wav [--voice Linh] · voices [--lang vi] · fonts [query]
Watch:       ui [DIR] [--port 4810]  (local web UI on 127.0.0.1: timeline, viewer, inspector, live sync with agent edits)
Reference:   guide · schema · ops · capabilities · mcp (start the MCP server on stdio)
Feedback:    feedback add kind=bug|missing_feature|friction|performance|docs|idea title="..." [details=... suggestion=... area=... severity=...]
             feedback summary [--md out.md] [--days N] · feedback list [--status open|all] · feedback resolve ID [--status wontfix] [--note ...]
Global:      -p/--project DIR (or $AGENTCUT_PROJECT, or nearest folder with project.json) · --pretty`;

function parseArgs(argv: string[]) {
  const flags: Record<string, any> = {}, pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") flags.output = argv[++i];
    else if (a === "-p") flags.project = argv[++i];
    else if (a === "-h") flags.help = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) flags[k] = (BOOL.has(k) || OPT.has(k)) && (v === "false" || v === "true") ? v === "true" : v;
      else if (BOOL.has(k) && !/^[[{]/.test(argv[i + 1] ?? "")) flags[k] = true;
      else if (OPT.has(k) && !(argv[i + 1] ?? "-").startsWith("-")) flags[k] = argv[++i];
      else if (OPT.has(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { flags, pos };
}

const val = (s: string) => { try { return JSON.parse(s); } catch { return s; } };
function kv(pairs: string[]) {
  const out: Record<string, any> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 0) throw new EditError(`expected key=value, got '${p}'`, "usage", "e.g. text='Hello' duration=3 stroke.width=6");
    setDotted(out, p.slice(0, i).trim(), val(p.slice(i + 1)));
  }
  return out;
}

let pretty = false;
const call = { cmd: "", t0: performance.now(), ops: undefined as string[] | undefined };
let printed = false;
// exits from the write callback: a pipe may take the bytes after write() returns, and process.exit() would cut them; callers `return emit(...)`.
// One object per run: the first emit wins (a signal's report and the command's own result can race).
// `second`: a second signal arrived before anything was printed: one synchronous write, then out at once by that signal.
function emit(obj: unknown, code = 0, second?: { sig: NodeJS.Signals; n: number }) {
  if (printed) return;
  printed = true;
  const text = JSON.stringify(obj, null, pretty ? 2 : undefined) + "\n";
  if (second) {
    try { writeSync(1, text); } catch { /* the reader is gone */ }
    try { recordCall("cli", call.cmd, performance.now() - call.t0, obj, call.ops ? { ops: call.ops } : {}); } catch { /* the report is out; leaving is what counts */ }
    return leave(128 + second.n, second.sig);
  }
  recordCall("cli", call.cmd, performance.now() - call.t0, obj, call.ops ? { ops: call.ops } : {});
  process.stdout.write(text, () => leave(signalled ? 128 + signalled.n : code, signalled?.sig));
}
// SIGHUP is left alone: a closed terminal ends the process as it always did, and `nohup agentcut render &` keeps working
const SIGNALS = [["SIGINT", 2], ["SIGTERM", 15]] as const;
/** the first signal that stopped the run, once one arrived: after it every result is reported as its `aborted` error, whatever failed */
let signalled: { sig: NodeJS.Signals; n: number; reason: EditError } | undefined;
/** The one way out. After a signal the process dies by that signal again (a shell loop or a parent sees a signal death, as before the handlers), the
 *  exit status 128 + n still reads the same; win32 has no signal to re-raise, so there the exit status alone carries it. `process.exit` also covers a
 *  runtime that survives the re-raise. */
function leave(code: number, sig?: NodeJS.Signals): never {
  if (sig && process.platform !== "win32") {
    for (const [s] of SIGNALS) process.removeAllListeners(s);
    process.kill(process.pid, sig);
  }
  return process.exit(code);
}
function fail(e: any) {
  if (signalled) return emit({ ok: false, error: (e instanceof EditError && e.code === "aborted" ? e : signalled.reason).toJSON() }, 128 + signalled.n); // an abort error may carry a hint of its own
  if (e instanceof EditError) return emit({ ok: false, error: e.toJSON() }, e.code === "usage" ? 2 : 1);
  if (e instanceof SyntaxError) return emit({ ok: false, error: { code: "bad_json", message: e.message, hint: "ops must be valid JSON" } }, 2);
  return emit({ ok: false, error: { code: "internal", message: `${e?.name}: ${e?.message}`, hint: "this is an AgentCut bug: it was logged; please also run `agentcut feedback add kind=bug title=...` with what you were doing", ...(process.env.AGENTCUT_DEBUG ? { trace: e?.stack } : {}) } }, 3);
}

async function readOps(file: string | undefined, inline: string | undefined) {
  let data: any;
  if (inline) data = JSON.parse(inline);
  else if (!file || file === "-") { const b: Buffer[] = []; for await (const c of process.stdin) b.push(c); data = JSON.parse(Buffer.concat(b).toString("utf8")); }
  else {
    if (!existsSync(file)) throw new EditError(`ops file not found: ${file}`, "not_found", "pass a JSON file, '-' for stdin, or --ops '[...]'");
    data = JSON.parse(readFileSync(file, "utf8"));
  }
  return Array.isArray(data) ? data : data.ops ?? [data];
}

/** The report of a stop that did not wait for the command to clean up (a second signal, or the grace time): its temporary files may remain. */
const leftovers = (reason: EditError) => new EditError(reason.message, "aborted", "the command was stopped before it finished, so what it had made may remain: a render's scratch in .agentcut/tmp is removed by the next render, prepare or `agentcut cache prune`; a reserved or partly written output file stays beside the output path until you delete it");
const SIGNAL_WRITE_MS = 500; // how long a second signal lets a result in flight finish
const SIGNAL_GRACE_MS = 4000; // render workers stop their children within 1.5 s (proc.ts); the run does not wait for more than this
/** The first SIGINT/SIGTERM aborts `stop`, which the long api calls take, so they stop their children and remove their temp files and reserved
 *  output. Whatever the command then does, the one JSON object is its `aborted` error (a command that finishes cleanly still prints its result), and
 *  the process ends by the signal (see leave). A command that has not ended after the grace time is reported the same way. A second signal prints an `aborted` object
 *  with one synchronous write and leaves at once, with no cleanup (the next render, prepare or `cache prune` removes only the scratch in .agentcut/tmp), except while the result is being written: then it waits for the write, at most SIGNAL_WRITE_MS. */
function onSignals() {
  const stop = new AbortController();
  for (const [sig, n] of SIGNALS) process.on(sig, () => {
    if (signalled) { // the result is already being written: leave when the write is done (emit's callback), or after SIGNAL_WRITE_MS; a reader that has stopped reading still gets a cut object then, and SIGKILL cannot be helped
      if (printed) return void setTimeout(() => leave(128 + n, sig), SIGNAL_WRITE_MS);
      return emit({ ok: false, error: leftovers(signalled.reason).toJSON() }, 128 + n, { sig, n });
    }
    const reason = new EditError(`interrupted by ${sig}`, "aborted", "the command was stopped; its temporary files were removed"); // said only by a command that ended and cleaned up
    signalled = { sig, n, reason };
    stop.abort(reason);
    setTimeout(() => fail(leftovers(reason)), SIGNAL_GRACE_MS);
  });
  process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code !== "EPIPE" && e.code !== "ERR_STREAM_DESTROYED") throw e; });
  return stop.signal;
}

/** A numeric flag or argument: a value that is not a number is a usage error (never NaN, which JSON writes as null). */
function num(v: any, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) throw new EditError(`${name} must be a number, got ${JSON.stringify(v)}`, "usage", "pass a plain number, e.g. 30 or 0.5");
  return n;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "__segment") { const { runSegmentMain } = await import("./segment-worker.ts"); await runSegmentMain(argv[1]); return; }
  const { flags: f, pos } = parseArgs(argv);
  pretty = !!f.pretty || !!process.stdout.isTTY;
  const cmd = pos.shift();
  call.cmd = cmd === "op" ? (pos[0] ?? "op") : cmd ?? "";
  if (f.version || cmd === "version") { console.log(VERSION); return; }
  if (!cmd || f.help || cmd === "help") { console.log(HELP); return; }
  if (cmd === "guide" || cmd === "docs") { const { GUIDE } = await import("./docs.ts"); console.log(GUIDE.trim()); return; }
  if (cmd === "mcp") { const { startMcp } = await import("./mcp.ts"); await startMcp(); return; }
  const bad = Object.keys(f).filter((k) => !BOOL.has(k) && !OPT.has(k) && !VALUE.has(k));
  if (bad.length) return emit({ ok: false, error: { code: "usage", message: `unknown flag${bad.length > 1 ? "s" : ""}: ${bad.map((k) => "--" + k).join(" ")}`, hint: "run `agentcut help` for the flags of each command" } }, 2);
  const api = await import("./api.ts");
  const P = f.project;
  const signal = cmd === "ui" ? undefined : onSignals(); // ui is a server: a signal ends it the default way
  let last = 0;
  const progress = f.quiet ? undefined : (d: number, n: number, download?: { model: string; bytes: number; total_bytes: number }) => { const now = Date.now(); if (now - last > 400 || d === n || (download && download.bytes === download.total_bytes)) { last = now; process.stderr.write(JSON.stringify({ progress: +(d / n).toFixed(3), frame: d, frames: n, ...(download && { download }) }) + "\n"); } }; // render, prepare, review: one line per 0.4 s on stderr
  let res: any;
  try {
    switch (cmd) {
      case "init": res = api.create(pos[0] ?? ".", { preset: f.preset, width: num(f.width, "--width"), height: num(f.height, "--height"), fps: num(f.fps, "--fps"), name: f.name, empty: f.empty }); break;
      case "info": case "show": case "status":
        res = await api.info(P, f.json ? "both" : "summary");
        if (f.text) { console.log(res.summary); return; }
        break;
      case "apply": res = await api.apply(P, await readOps(pos[0], f.ops).then((l) => { call.ops = l.map((o: any) => o?.op); return l; }), { dryRun: f["dry-run"], allowInvalid: f["allow-invalid"], revision: num(f.revision, "--revision"), signal }); break;
      case "op": res = await api.apply(P, [{ op: pos.shift(), ...(typeof f.json === "string" ? JSON.parse(f.json) : {}), ...kv(pos) }], { dryRun: f["dry-run"], revision: num(f.revision, "--revision"), signal }); break;
      case "add": res = await api.apply(P, [{ op: "add_clip", ...kv(pos) }], { revision: num(f.revision, "--revision"), signal }); break;
      case "set": res = await api.apply(P, [{ op: "update_clip", id: pos.shift(), set: kv(pos) }], { revision: num(f.revision, "--revision"), signal }); break;
      case "rm": res = await api.apply(P, [{ op: "remove_clip", id: pos[0], ripple: !!f.ripple, keep_attached: !!f["keep-attached"] }], { revision: num(f.revision, "--revision"), signal }); break;
      case "validate": { const v = await api.validate(P); return emit({ ok: v.valid, ...v }, v.valid ? 0 : 1); }
      case "frame": res = await api.frame(P, pos[0] ?? 0, { out: f.output, scale: num(f.scale, "--scale"), guides: f.guides }); break;
      case "scopes": res = await api.scopes(P, pos[0] ?? 0, { out: f.output, scale: num(f.scale, "--scale"), signal }); break;
      case "sheet": res = await api.sheet(P, { times: f.times, every: num(f.every, "--every"), count: num(f.count, "--count"), cols: num(f.cols, "--cols"), out: f.output, tileWidth: num(f["tile-width"], "--tile-width"), guides: f.guides }); break;
      case "captions": case "export-captions": res = api.exportCaptions(P, { out: f.output, format: f.format, ids: f.ids ? String(f.ids).split(",") : undefined }); break;
      case "review": res = await api.review(P, { beats: f.beats, minShot: num(f["min-shot"], "--min-shot"), maxShot: num(f["max-shot"], "--max-shot"), cps: num(f.cps, "--cps"), black: !f["no-black"], signal,
        progress }); break;
      case "audio": res = await api.audioCheck(P, { source: f.source ?? pos[0], spectrogram: f.spectrogram, start: f.start, end: f.end, width: num(f.width, "--width"), minSilence: num(f["min-silence"], "--min-silence"), out: f.output, signal }); break;
      case "motion": res = await api.motion(P, { start: f.start, end: f.end, frames: num(f.frames, "--frames"), pad: num(f.pad, "--pad"), out: f.output, tileWidth: num(f["tile-width"], "--tile-width") }); break;
      case "export-timeline": case "handoff": res = await api.exportTimeline(P, { format: f.format, out: f.output }); break;
      case "render": case "export": {
        if (f.format === "fcpxml" || f.format === "otio" || /\.(fcpxml|otio)$/i.test(f.output ?? "")) { res = await api.exportTimeline(P, { format: f.format, out: f.output }); break; }
        if (f.format === "srt" || f.format === "vtt") { res = api.exportCaptions(P, { format: f.format, out: f.output }); break; }
        res = await api.render(P, {
          out: f.output, start: f.start, end: f.end, scale: num(f.scale, "--scale"), quality: f.quality, draft: f.draft, sheet: !f["no-sheet"],
          workers: num(f.workers, "--workers"), fast: f.fast, codec: f.codec, alpha: f.alpha, subtitles: f.subtitles, signal,
          progress,
        });
        break;
      }
      case "undo": res = api.undo(P, num(pos[0], "steps") ?? 1, num(f.revision, "--revision")); break;
      case "redo": res = api.redo(P, num(pos[0], "steps") ?? 1, num(f.revision, "--revision")); break;
      case "ui": {
        const { startUi } = await import("./ui.ts");
        const { server: _, ...r } = await startUi(pos[0] ?? P, { port: num(f.port, "--port") });
        process.stdout.write(JSON.stringify({ ok: true, ...r }) + "\n"); // server keeps running; Ctrl-C to stop
        return;
      }
      case "history": res = api.history(P); break;
      case "probe": res = api.probe(pos[0]); break;
      case "beats": {
        res = await api.analyze.beats(pos[0], signal);
        if (f.markers) { await api.apply(P, res.beats.map((t: number, i: number) => ({ op: "add_marker", t, label: `beat ${i}` }))); res.markers_added = res.beats.length; }
        if (!f.full && res.beats.length > 64) { res.beats = res.beats.slice(0, 64); res.beats_truncated = true; }
        break;
      }
      case "scenes": res = await api.analyze.scenes(pos[0], num(f.threshold, "--threshold"), signal); break;
      case "silence": res = await api.analyze.silence(pos[0], num(f["noise-db"], "--noise-db"), num(f["min-silence"], "--min-silence"), signal); break;
      case "loudness": res = await api.analyze.loudness(pos[0], signal); break;
      case "transcribe": res = await api.analyze.transcribe(pos[0], f.language, f.model, f.start, f.end, signal); break;
      case "subject": { // cached in the project: -p / $AGENTCUT_PROJECT must name one (else no_project); with neither, the nearest project.json, else the user cache
        let root: string | undefined;
        try { root = api.openProject(P).root; } catch (e: any) { if (e.code !== "no_project" || P || process.env.AGENTCUT_PROJECT) throw e; }
        res = await api.analyze.subject(pos[0], num(f.fps, "--fps"), f["allow-download"], root); break;
      }
      case "prepare": {
        if (f.status) { res = api.prepareStatus(P); break; }
        res = await api.prepare(P, { allowDownload: f["allow-download"], signal, progress });
        break;
      }
      case "cache": {
        const sub = pos.shift() ?? "info";
        if (sub === "info") res = api.cache.info(P);
        else if (sub === "prune") res = api.cache.prune(P, { maxMb: num(f["max-mb"], "--max-mb"), olderThan: f["older-than"] });
        else return emit({ ok: false, error: { code: "usage", message: `unknown cache command '${sub}'`, hint: "cache info | cache prune [--max-mb N] [--older-than 7d]" } }, 2);
        break;
      }
      case "tts": res = await api.analyze.tts(pos[0], f.output, f.voice, num(f.rate, "--rate"), f.project, signal); break;
      case "voices": res = api.voices(f.lang); break;
      case "fonts": res = await api.fonts(pos[0] ?? ""); break;
      case "schema": res = api.schema(); break;
      case "ops": res = api.opsDoc(); break;
      case "capabilities": case "caps": res = api.capabilities(); break;
      case "feedback": {
        const sub = pos.shift() ?? "summary";
        if (sub === "add") res = api.feedback.add({ ...kv(pos), ...Object.fromEntries(["kind", "title", "details", "area", "severity", "suggestion"].filter((k) => f[k] !== undefined).map((k) => [k, f[k]])), source: "cli" });
        else if (sub === "list") res = api.feedback.list(f.status ?? "open", f.kind);
        else if (sub === "summary" || sub === "report") {
          if (f.md !== undefined || sub === "report") { const r = api.feedback.report(typeof f.md === "string" ? f.md : undefined, num(f.days, "--days")); if (r.markdown && !f.pretty) { console.log(r.markdown); return; } res = r; }
          else res = api.feedback.summary(num(f.days, "--days"), num(f.limit, "--limit"));
        } else if (sub === "resolve") res = api.feedback.resolve(pos[0], f.status, f.note);
        else return emit({ ok: false, error: { code: "usage", message: `unknown feedback command '${sub}'`, hint: "feedback add|list|summary|resolve" } }, 2);
        break;
      }
      default: return emit({ ok: false, error: { code: "usage", message: `unknown command '${cmd}'`, hint: "run `agentcut help`" } }, 2);
    }
    emit({ ok: true, ...res });
  } catch (e: any) {
    fail(e);
  }
}

const self = process.argv[1] ?? "";
if (/cli\.(ts|js)$/.test(self) || self.includes("$bunfs") || self.includes("~BUN") || /agentcut(\.exe)?$/.test(self)) main().catch(fail);
