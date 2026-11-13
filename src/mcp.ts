#!/usr/bin/env node
// AgentCut MCP server (stdio). Tools mirror the CLI; preview tools return real images so the agent can SEE.
// Claude Code: claude mcp add agentcut -- agentcut-mcp
import { existsSync, readFileSync, statSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as api from "./api.ts";
import { GUIDE } from "./docs.ts";
import { FEEDBACK_GUIDE, KINDS, recordCall, SEVERITIES } from "./feedback.ts";
import { EditError } from "./model.ts";
import { own } from "./own.ts";
import { VERSION } from "./version.ts";

const INSTRUCTIONS = `AgentCut: JSON-timeline video editor with CapCut/Final Cut features. Read \`guide\` once. Loop:
create_project -> probe_media/analyze_* -> apply_ops (atomic; or apply_template) -> contact_sheet/preview_frame (LOOK) ->
render (draft first) -> fix with apply_ops/undo -> final render. Times are seconds; tracks[0] is the bottom layer.
After create_project/open_project the server remembers the project, so 'project' args are optional.
Help improve AgentCut: when something is slow, confusing, missing or broken, call report_feedback (one short call).`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const state: { project?: string } = { project: process.env.AGENTCUT_PROJECT };
const jobs = new Map<string, any>();
/** tool calls the server has accepted and not yet finished; shutdown answers them before it exits */
const calls = new Set<Promise<unknown>>();
/** aborted by shutdown(): every tool call's signal follows it */
const stopCalls = new AbortController();
/** transport sends not yet taken by stdout */
const sends = new Set<Promise<void>>();

const text = (o: unknown): Content => ({ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) });
const ok = (o: object) => ({ content: [text({ ok: true, ...o })] });
function fail(e: any) {
  const error = e instanceof EditError ? e.toJSON() : { code: "internal", message: `${e?.name}: ${e?.message}`, hint: "this is an AgentCut bug: it was logged; please also call report_feedback(kind='bug') with what you were doing", ...(process.env.AGENTCUT_DEBUG ? { trace: e?.stack } : {}) };
  return { content: [text({ ok: false, error })], isError: true };
}
function proj(p?: string) {
  if (p) return p; // only create_project / open_project change the remembered project
  if (state.project) return state.project;
  throw new EditError("no project selected", "no_project", "call create_project or open_project first, or pass project=<folder>");
}
// the signal is the call's own (see registerTool in buildServer); `extra` is typed optional only because the SDK calls a tool without an inputSchema with one argument
const wrap = <A>(f: (a: A, signal: AbortSignal) => any) => async (a: A, extra?: { signal: AbortSignal }) => { try { return ok(await f(a, extra!.signal)); } catch (e) { return fail(e); } };
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const image = (path: string): Content => ({ type: "image", data: readFileSync(path).toString("base64"), mimeType: own(MIME, path.split(".").pop()!.toLowerCase()) ?? "image/png" });
/** view_image serves picture files only, not any readable file */
function viewable(path: string) {
  const ext = path.split(".").pop()!.toLowerCase();
  if (!own(MIME, ext)) throw new EditError(`not an image file: ${path}`, "bad_request", `view_image shows ${Object.keys(MIME).join(", ")} files`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new EditError(`no image file at ${path}`, "not_found", "pass the path of a file that exists, e.g. a render's contact_sheet");
  return path;
}
// tool-schema bounds for the arguments that size a render or a sheet (api.sheet itself caps `every` at 64 frames)
const SCALE = z.number().gt(0).max(4);
const TIME = z.number().finite().min(0);

export function buildServer() {
  const s = new McpServer({ name: "agentcut", version: VERSION }, { instructions: INSTRUCTIONS });
  // every tool call is timed and its outcome logged for the feedback summary (errors, guessed names, slow calls);
  // it is also tracked in `calls` until it settles, so shutdown can answer it before exiting;
  // each handler gets one signal (extra.signal, replaced) that aborts when the client cancels the call or the server shuts down
  const register = s.registerTool.bind(s);
  (s as any).registerTool = (name: string, cfg: any, handler: any) => (register as any)(name, cfg, (...args: any[]) => {
    const a = args[0], extra = args[args.length - 1]; // a tool without an inputSchema is called with (extra) alone
    const ctl = new AbortController();
    const relays: [AbortSignal, () => void][] = [
      [extra.signal, () => ctl.abort(new EditError("the call was cancelled", "aborted"))],
      [stopCalls.signal, () => ctl.abort(stopCalls.signal.reason)],
    ];
    for (const [sig, fn] of relays) sig.aborted ? fn() : sig.addEventListener("abort", fn, { once: true });
    const p = (async () => {
      const t0 = performance.now();
      let r;
      try { r = await handler(a, { ...extra, signal: ctl.signal }); } finally { for (const [sig, fn] of relays) sig.removeEventListener("abort", fn); }
      let res: any = r?.isError ? { ok: false, error: { code: "internal", message: "the tool replied with an error that is not JSON" } } : { ok: true };
      try { const t = r?.content?.find((c: any) => c.type === "text")?.text; if (t?.startsWith("{")) res = JSON.parse(t); } catch { /* not JSON */ }
      if (res?.job_id) res = { ok: true }; // a reply that describes a job is a read; the job's own failure is logged once, where the job ends (startJob)
      recordCall("mcp", name, performance.now() - t0, res, name === "apply_ops" ? { ops: (a?.ops ?? []).map((o: any) => o?.op) } : {});
      return r;
    })();
    calls.add(p);
    p.then(() => calls.delete(p), () => calls.delete(p));
    return p;
  });
  const P = z.string().optional().describe("project folder (optional after create/open)");
  const REV = z.number().int().optional().describe("revision you based this on (project_info); if a human/another agent saved since, fails with code 'conflict'");

  s.registerTool("guide", { description: "Read first: how AgentCut works (tracks, magnetic timeline, templates, ops cheat-sheet, vocabulary, rules)." },
    async () => ({ content: [text(GUIDE.trim())] }));
  s.registerTool("capabilities", { description: "Every clip type, transition, animation, motion, effect, filter/look, mask, text & caption preset, template, canvas preset and op name. `engines` says which transcription, TTS and vision engines are usable now." },
    wrap(() => api.capabilities()));
  s.registerTool("ops_reference", { description: "Every edit op accepted by apply_ops, with arguments." }, wrap(() => api.opsDoc()));
  s.registerTool("timeline_schema", { description: "The timeline JSON format (fields per clip type, units, enums)." }, wrap(() => api.schema()));

  s.registerTool("create_project", {
    description: "Create a project folder and make it current. preset: reels|tiktok|shorts (1080x1920), youtube (1920x1080), square, portrait, 4k, 720p.",
    inputSchema: { path: z.string(), preset: z.string().default("reels"), width: z.number().int().optional(), height: z.number().int().optional(), fps: z.number().default(30), name: z.string().optional() },
  }, wrap((a) => { const r = api.create(a.path, { preset: a.width || a.height ? undefined : a.preset, width: a.width, height: a.height, fps: a.fps, name: a.name }); state.project = r.project; return r; }));
  s.registerTool("open_project", { description: "Select an existing project folder and return its summary.", inputSchema: { path: z.string() } },
    wrap(async (a) => { const r = await api.info(a.path); state.project = r.project; return r; })); // a failed open keeps the remembered project
  s.registerTool("project_info", { description: "Compact text summary of the timeline (tracks bottom->top, clip ids/times) + validation counts. include_json returns the full JSON.", inputSchema: { project: P, include_json: z.boolean().default(false) } },
    wrap((a) => api.info(proj(a.project), a.include_json ? "both" : "summary")));
  s.registerTool("apply_ops", {
    description: `Apply a batch of edit ops atomically. Each op is {op, ...args}. Ops: ${api.capabilities().ops.join(", ")} (args: ops_reference). A batch that would add validation errors is rejected with issues+hints. Returns new clip ids and the project root it changed (project).`,
    inputSchema: { ops: z.array(z.record(z.string(), z.any())), project: P, dry_run: z.boolean().default(false), allow_invalid: z.boolean().default(false),
      revision: REV },
  }, wrap((a, signal) => api.apply(proj(a.project), a.ops, { dryRun: a.dry_run, allowInvalid: a.allow_invalid, revision: a.revision, signal })));
  s.registerTool("validate", { description: "Check the timeline: issues with level, JSON path, message, hint.", inputSchema: { project: P } }, wrap((a) => api.validate(proj(a.project))));
  s.registerTool("undo", { description: "Undo the last N edit batches (steps: a whole number >= 1; fewer are undone when the history holds fewer: result.requested and result.done say how many).", inputSchema: { steps: z.number().default(1), project: P, revision: REV } }, wrap((a) => api.undo(proj(a.project), a.steps, a.revision)));
  s.registerTool("redo", { description: "Redo N undone batches (steps: a whole number >= 1; fewer are redone when fewer are available: result.requested and result.done say how many).", inputSchema: { steps: z.number().default(1), project: P, revision: REV } }, wrap((a) => api.redo(proj(a.project), a.steps, a.revision)));

  s.registerTool("preview_frame", {
    description: "Render ONE frame at time t (seconds) and return it as an image. guides=true overlays safe areas (red = social UI zones on 9:16).",
    inputSchema: { t: z.number(), project: P, scale: SCALE.default(0.4), guides: z.boolean().default(false) },
  }, async (a) => { try { const r = await api.frame(proj(a.project), a.t, { scale: a.scale, guides: a.guides }); return { content: [image(r.image), text({ ok: true, ...r })] }; } catch (e) { return fail(e); } });
  s.registerTool("scopes", {
    description: "Colour scopes of the frame at t: image (frame | luma waveform / vectorscope | RGB histogram) + stats (luma 0..1 min/p10/avg/p90/max, saturation_avg, cast u/v: 0 = neutral, +u blue, +v red). Use to judge exposure and colour objectively before/after a color grade.",
    inputSchema: { t: z.number(), project: P },
  }, async (a, { signal }) => { try { const r = await api.scopes(proj(a.project), a.t, { signal }); return { content: [image(r.image), text({ ok: true, ...r })] }; } catch (e) { return fail(e); } });
  s.registerTool("contact_sheet", {
    description: "Grid of timestamped frames across the timeline (no full render). Default 12 evenly spaced; or times=[...] / every=1.",
    inputSchema: { project: P, times: z.array(TIME).max(64).optional(), every: z.number().gt(0).optional(), count: z.number().int().min(1).max(64).default(12), cols: z.number().int().default(4), guides: z.boolean().default(false) },
  }, async (a) => { try { const r = await api.sheet(proj(a.project), { times: a.times, every: a.every, count: a.count, cols: a.cols, guides: a.guides, tileWidth: 300 }); return { content: [image(r.image), text({ ok: true, ...r })] }; } catch (e) { return fail(e); } });
  s.registerTool("audio_check", {
    description: "SEE the sound: image of each audible track's waveform + the rendered mix (time ruler, clip boundaries, main-track cuts, markers; spectrogram=true adds one) and findings with times: clipping/overs, true peak, long silences, audio cut off at clip ends without a fade, music not ducked under voice. source=<file> inspects a media file instead.",
    inputSchema: { project: P, source: z.string().optional(), spectrogram: z.boolean().default(false), start: z.number().optional(), end: z.number().optional(), min_silence: z.number().default(1) },
  }, async (a, { signal }) => { try { const r = await api.audioCheck(a.source ? undefined : proj(a.project), { source: a.source, spectrogram: a.spectrogram, start: a.start, end: a.end, minSilence: a.min_silence, signal }); return { content: [image(r.image), text({ ok: true, ...r })] }; } catch (e) { return fail(e); } });
  s.registerTool("motion_strip", {
    description: "Judge transitions/animations: rows of `frames` consecutive timestamped frames. Default one row per transition (with pad s either side); start/end inspect any range instead (e.g. a text's enter animation).",
    inputSchema: { project: P, start: z.number().optional(), end: z.number().optional(), frames: z.number().int().default(10), pad: z.number().default(0.15) },
  }, async (a) => { try { const r = await api.motion(proj(a.project), { start: a.start, end: a.end, frames: a.frames, pad: a.pad }); return { content: [...r.images.map(image), text({ ok: true, ...r })] }; } catch (e) { return fail(e); } });
  s.registerTool("review", {
    description: "Editorial lint before rendering: findings with times for text outside the safe area / under 9:16 app UI, text too short to read (chars/s), shots too short/long, cuts off the beat (beats='music' analyses music tracks, or a list of seconds; default: markers named 'beat*'), black frames, plus validation warnings (e.g. clips past their media). Fix, then run again.",
    inputSchema: { project: P, beats: z.union([z.literal("music"), z.array(z.number())]).optional(), min_shot: z.number().default(0.4), max_shot: z.number().optional(), cps: z.number().default(15), black_frames: z.boolean().default(true) },
  }, wrap((a, signal) => api.review(proj(a.project), { beats: a.beats, minShot: a.min_shot, maxShot: a.max_shot, cps: a.cps, black: a.black_frames, signal })));

  const noJob = (id: string) => ({ content: [text({ ok: false, error: new EditError(`no job ${id}`, "not_found", "jobs live in the server process and are lost when it restarts; re-run prepare (cached, idempotent) or render").toJSON() })], isError: true });
  /** a job's state as the tool reply; `ok` is false for a job that failed or was cancelled unless the caller asked for the cancel */
  const jobReply = (j: any, ok = j.status === "done" || j.status === "running") => {
    const { promise, ctl, ...pub } = j;
    return { content: [text({ ok, ...pub, elapsed: +(((j.finished ?? Date.now()) - j.started) / 1000).toFixed(1), ...(j.status === "running" ? { hint: `still running; call render_status(job_id='${j.job_id}') or cancel_job` } : {}) })], ...(ok ? {} : { isError: true }) };
  };
  const cancelled = new WeakSet<object>(); // jobs stopped on purpose (cancel_job, the starting call); a shutdown abort is a failure with code aborted
  // once shutdown has begun it has aborted every job itself and they fail, whoever asks
  const cancel = (j: any, why: string) => { if (j.status === "running" && !stopCalls.signal.aborted) { cancelled.add(j); j.ctl.abort(new EditError(why, "aborted")); } };
  /** `callSignal`: the call that started the job; it stops the job only while this call waits, and a job that is still running when the wait ends runs on without it */
  const waitJob = async (id: string, secs: number, callSignal?: AbortSignal) => {
    const j = jobs.get(id);
    if (!j) return noJob(id);
    const stop = () => cancel(j, "the call that started the job was cancelled");
    if (callSignal?.aborted) stop(); else callSignal?.addEventListener("abort", stop, { once: true });
    try {
      const until = Date.now() + secs * 1000;
      while (j.status === "running" && Date.now() < until) await Promise.race([j.promise, new Promise((r) => setTimeout(r, 300))]); // wakes when the job settles
    } finally { callSignal?.removeEventListener("abort", stop); }
    return jobReply(j);
  };
  /** background job (render, prepare): progress 0..1, polled with render_status; `ctl` aborts it (cancel_job, shutdown) */
  const startJob = (kind: string, project: string, run: (progress: (d: number, n: number) => void, signal: AbortSignal) => Promise<unknown>) => {
    const id = Math.random().toString(36).slice(2, 10);
    const ctl = new AbortController();
    const job: any = { job_id: id, kind, status: "running", progress: 0, started: Date.now(), project, ctl };
    jobs.set(id, job);
    if (stopping) ctl.abort(new EditError("the server is shutting down", "aborted")); // requested inside the shutdown window: nothing may start
    job.promise = (async () => run((d, n) => { job.progress = +(d / n).toFixed(3); }, ctl.signal))() // a synchronous throw in `run` becomes a failed job, never a `running` one with no promise
      .then((r) => { job.status = "done"; job.progress = 1; job.result = r; }, (e) => {
        job.error = e instanceof EditError ? e.toJSON() : { code: "internal", message: String(e?.message ?? e) };
        job.status = cancelled.has(job) && job.error.code === "aborted" ? "cancelled" : "failed";
        if (job.status === "failed") recordCall("mcp", kind, Date.now() - job.started, { ok: false, error: job.error }, {}, "job");
      })
      .finally(() => { job.finished = Date.now(); });
    return id;
  };
  s.registerTool("render", {
    description: "Export by extension: .mp4 (H.264, codec=hevc for H.265), .mov (ProRes; codec=prores_4444 keeps alpha with a transparent background), .webm (VP9, alpha ok), .mkv, .gif, or audio only (.wav/.mp3/.m4a/.flac), or one still frame at start as .png/.webp (alpha kept with a transparent background; webp lossless at quality=high; no end, sheet or loudness). draft=true: half size + hardware encode (fast check). start/end render a section. Waits up to wait_seconds, else returns job_id for render_status. Result includes has_audio, contact_sheet (a file in previews/) + loudness - check them. A timeline with no audible clip gets no audio track: has_audio false, a warning, no loudness. For a Final Cut / Resolve project file use export_timeline. Keep wait_seconds below your client's request timeout: cancelling the call while it waits stops the render; once job_id is returned the render runs on, and cancel_job stops it.",
    inputSchema: { project: P, output: z.string().optional(), start: z.number().default(0), end: z.number().optional(), draft: z.boolean().default(false), quality: z.enum(["draft", "standard", "high"]).default("standard"), scale: SCALE.default(1), fast: z.boolean().optional().describe("hardware encode (default: on for draft, off otherwise)"), codec: z.enum(["auto", "h264", "hevc", "prores", "prores_4444", "vp9"]).default("auto"), alpha: z.boolean().optional().describe("keep transparency (default: on when background is transparent and the codec supports it)"), subtitles: z.boolean().default(false).describe("also embed the captions clips as a soft subtitle track (.mp4/.mov mov_text, .mkv srt, .webm webvtt)"), wait_seconds: z.number().default(55) },
  }, async (a, { signal }) => {
    let project: string;
    try { project = proj(a.project); } catch (e) { return fail(e); }
    const id = startJob("render", project, (progress, signal) => api.render(project, { out: a.output, start: a.start, end: a.end, draft: a.draft, quality: a.quality, scale: a.scale, fast: a.fast, codec: a.codec, alpha: a.alpha, subtitles: a.subtitles, progress, signal }));
    return waitJob(id, a.wait_seconds, signal);
  });
  s.registerTool("prepare", {
    description: "Compute what remove_background / auto_reframe / track_to need (alpha mattes, subject and object tracks; slow, seconds per clip) as a background job, then apply the pending vision requests. Those ops only record the request; preview and video render fail with code not_prepared until prepare is done (audio-only renders skip it). Waits up to wait_seconds (keep it below your client's request timeout: cancelling the call while it waits stops the job; once job_id is returned the job runs on, and cancel_job stops it), else returns job_id for render_status. status_only=true lists what is missing without computing (models_to_download: matte models and the face model, 0.23 MB, not cached yet). A model (sizes in capabilities.matte_models and engines.vision.face_model; some are unknown offline) is downloaded only with allow_download=true; without it an uncached model fails with code model_not_cached.",
    inputSchema: { project: P, status_only: z.boolean().default(false), allow_download: z.boolean().default(false), wait_seconds: z.number().default(30) },
  }, async (a, { signal }) => {
    let project: string;
    try { project = proj(a.project); if (a.status_only) return ok(api.prepareStatus(project)); } catch (e) { return fail(e); }
    return waitJob(startJob("prepare", project, (progress, signal) => api.prepare(project, { progress, signal, allowDownload: a.allow_download })), a.wait_seconds, signal);
  });
  s.registerTool("cache", {
    description: "Project cache (.agentcut/cache: vision analyses + mattes) and previews/ (frames, sheets, strips): action=info sizes; action=prune deletes unreferenced files first (max_mb: until the total fits, then referenced ones too - prepare rebuilds them; older_than: e.g. '7d'). previews/ is capped automatically (AGENTCUT_PREVIEWS_MAX_MB, default 200).",
    inputSchema: { project: P, action: z.enum(["info", "prune"]).default("info"), max_mb: z.number().optional(), older_than: z.string().optional() },
  }, wrap((a) => (a.action === "prune" ? api.cache.prune(proj(a.project), { maxMb: a.max_mb, olderThan: a.older_than }) : api.cache.info(proj(a.project)))));
  s.registerTool("export_timeline", {
    description: "Hand the edit to a human editor: write an FCPXML (Final Cut Pro) or OTIO (OpenTimelineIO: DaVinci Resolve, Premiere, Avid) project that references the original media. Two lists of {id, type, reason}: skipped (not exported) and approximated (exported in another form).",
    inputSchema: { project: P, format: z.enum(["fcpxml", "otio"]).optional().describe("default: from the output extension (.fcpxml, .otio); fcpxml when there is no output"), output: z.string().optional() },
  }, wrap((a) => api.exportTimeline(proj(a.project), { format: a.format, out: a.output })));
  s.registerTool("export_captions", {
    description: "Write the captions clips as a subtitle file (.srt or .vtt) in timeline time, same pages as the burned-in captions. For a soft subtitle track inside the video use render subtitles=true.",
    inputSchema: { project: P, output: z.string().optional().describe(".srt or .vtt path"), format: z.enum(["srt", "vtt"]).optional(), ids: z.array(z.string()).optional().describe("only these captions clips") },
  }, wrap((a) => api.exportCaptions(proj(a.project), { out: a.output, format: a.format, ids: a.ids })));
  s.registerTool("render_status", { description: "Status/result of a background job: render or prepare (waits up to wait_seconds; cancelling this call leaves the job running). status is running, done, failed or cancelled.", inputSchema: { job_id: z.string(), wait_seconds: z.number().default(30) } }, (a) => waitJob(a.job_id, a.wait_seconds));
  s.registerTool("cancel_job", {
    description: "Stop a running render or prepare job and wait until it has stopped: its part file, temp files and reserved output name are gone when this returns. A cancel takes effect until a render's output is written; after that the render is done (the output stays, the contact sheet and loudness are skipped and marked), except that a cancel which lands in the subtitle mux ends the job cancelled and leaves the output without its subtitle stream (error.hint names the file). Replies with the status the job reached: cancelled (error.code aborted), or done / failed if it finished first. A finished job is returned unchanged; an unknown job_id is not_found.",
    inputSchema: { job_id: z.string() },
  }, async (a) => {
    const j = jobs.get(a.job_id);
    if (!j) return noJob(a.job_id);
    cancel(j, "the job was cancelled");
    await j.promise;
    return jobReply(j, j.status !== "failed");
  });
  s.registerTool("view_image", { description: "Return a local PNG/JPG (e.g. a render's contact_sheet) as an image.", inputSchema: { path: z.string() } },
    async (a) => { try { return { content: [image(viewable(a.path))] }; } catch (e) { return fail(e); } });

  s.registerTool("probe_media", { description: "Duration, size, fps, audio, alpha of a media file (video/image/audio/Lottie).", inputSchema: { path: z.string() } }, wrap((a) => api.probe(a.path)));
  s.registerTool("analyze_beats", { description: "Tempo, beat times and bar starts of a music file (use with snap_to_beats).", inputSchema: { path: z.string(), max_beats: z.number().int().default(128) } },
    wrap(async (a, signal) => { const r: any = await api.analyze.beats(a.path, signal); if (r.beats.length > a.max_beats) { r.beats = r.beats.slice(0, a.max_beats); r.truncated = true; } return r; }));
  s.registerTool("analyze_scenes", { description: "Shot boundaries of a video: cut times + shot list.", inputSchema: { path: z.string(), threshold: z.number().default(0.3) } }, wrap((a, signal) => api.analyze.scenes(a.path, a.threshold, signal)));
  s.registerTool("analyze_silence", { description: "Silent and speech ranges (see op remove_silence).", inputSchema: { path: z.string(), noise_db: z.number().default(-35), min_silence: z.number().default(0.4) } }, wrap((a, signal) => api.analyze.silence(a.path, a.noise_db, a.min_silence, signal)));
  s.registerTool("measure_loudness", { description: "EBU R128 integrated loudness (LUFS), range and true peak.", inputSchema: { path: z.string() } }, wrap((a, signal) => api.analyze.loudness(a.path, signal)));
  s.registerTool("analyze_subject", { description: "Subject centre over time (a face found by YuNet, with a confidence score per sample, else the most salient region; x/y 0..1 of the frame). The result says what it followed: subject = face|saliency|mixed|none, plus warnings when it is unsure. Needs uv; cached. With a project open (project arg, or the one create_project / open_project remembered) the result is cached in that project, and auto_reframe on a clip covering the same range at the same fps reuses it; with none it is cached in the user cache. The 0.23 MB face model is downloaded only with allow_download=true; without it a missing model fails with code model_not_cached. Usually you want op auto_reframe / track_to instead.", inputSchema: { path: z.string(), fps: z.number().default(6), allow_download: z.boolean().default(false), project: z.string().optional() } }, wrap((a) => api.analyze.subject(a.path, a.fps, a.allow_download, a.project ? proj(a.project) : state.project)));
  s.registerTool("transcribe", { description: "Word-level transcript (needs whisper.cpp + AGENTCUT_WHISPER_MODEL, or openai-whisper). model: a ggml model file (whisper.cpp) or a model name (openai-whisper), instead of AGENTCUT_WHISPER_MODEL. start/end (seconds of the media; start defaults to 0, end to the media end) transcribe only that stretch: pass the speech only, since whisper may invent text over a long music-only stretch; word times stay in media seconds, within start/end. A silent start is skipped before whisper (skipped_leading = seconds skipped); a music lead-in is not silence and still needs start.",
    inputSchema: { path: z.string(), language: z.string().optional(), model: z.string().optional(), start: TIME.optional(), end: TIME.optional() } }, wrap((a, signal) => api.analyze.transcribe(a.path, a.language, a.model, a.start, a.end, signal)));
  s.registerTool("tts", { description: "Text-to-speech into an audio file (voice: OS voice e.g. 'Linh' via say/SAPI/espeak, 'piper[:model.onnx]', or 'openai:<voice>'; see list_voices). rate: words/min. The output may not replace the project's own files. Returns path, duration and each sentence's [start, end]. To put speech on the timeline use op add_voiceover.",
    inputSchema: { text: z.string(), output: z.string().describe("audio file to write, e.g. voice.wav"), voice: z.string().optional(), rate: z.number().optional(), project: P } }, wrap((a, signal) => api.analyze.tts(a.text, a.output, a.voice, a.rate, a.project ?? state.project, signal)));
  s.registerTool("list_fonts", { description: "Search installed fonts (use the name in a text clip's font).", inputSchema: { query: z.string().default("") } }, wrap((a) => api.fonts(a.query)));
  s.registerTool("list_voices", { description: "Installed text-to-speech voices (lang filter e.g. 'vi').", inputSchema: { lang: z.string().optional() } }, wrap((a) => api.voices(a.lang)));
  s.registerTool("report_feedback", {
    description: `Tell the AgentCut maintainers what to improve. ${FEEDBACK_GUIDE} Returns the note id (merged=true if someone reported it before).`,
    inputSchema: {
      kind: z.enum(KINDS).describe("bug | missing_feature | friction | performance | docs | idea | praise"),
      title: z.string().describe("one line, e.g. 'no op to detach audio from a video clip'"),
      details: z.string().optional().describe("what you tried, what happened, what you expected"),
      area: z.string().optional().describe("op/tool/feature involved, e.g. add_captions, render, fonts"),
      severity: z.enum(SEVERITIES).optional(),
      suggestion: z.string().optional().describe("how it could work instead"),
    },
  }, wrap((a) => api.feedback.add({ ...a, source: "mcp" })));
  s.registerTool("feedback_summary", {
    description: "Ranked improvement backlog built from agent notes + automatically logged errors, guessed names, rejected batches, slow calls and render speed. markdown=true returns a report.",
    inputSchema: { days: z.number().optional(), markdown: z.boolean().default(false) },
  }, async (a) => { try { return a.markdown ? { content: [text(api.feedback.report(undefined, a.days).markdown!)] } : ok(api.feedback.summary(a.days)); } catch (e) { return fail(e); } });
  s.registerTool("resolve_feedback", { description: "Mark a feedback note resolved/wontfix after improving AgentCut.", inputSchema: { id: z.string(), status: z.enum(["resolved", "wontfix", "open"]).default("resolved"), note: z.string().optional() } },
    wrap((a) => api.feedback.resolve(a.id, a.status, a.note)));
  return s;
}

// Inside the SDK client's close sequence (stdin end, 2 s, SIGTERM, 2 s, SIGKILL); children get 1.5 s of it (proc.ts stopOnAbort).
const SHUTDOWN_MS = 1900;
let stopping: Promise<void> | undefined;
/** Wait until no job is running, no accepted tool call is unanswered and every reply has left the process (jobs and calls that start
 *  meanwhile count: startJob aborts them at once). A reply counts as sent when the transport's send resolves, which is when stdout took
 *  all of it ('drain' if the pipe was full); an empty write is no barrier under bun. Not covered: a request read after this loop has
 *  exited gets no reply. The SDK's server.close() does neither: it drops in-flight handlers and writes nothing. */
async function drain() {
  while ([...jobs.values()].some((j) => j.status === "running") || calls.size || sends.size) {
    await Promise.allSettled([...[...jobs.values()].filter((j) => j.status === "running").map((j) => j.promise), ...calls, ...sends]);
    await new Promise((r) => setImmediate(r)); // the SDK sends a handler's reply in microtasks after it returns
  }
}
/** The one stop path (stdin EOF, SIGTERM, SIGINT, SIGHUP): abort every running job, wait a bounded time for their cleanup
 *  (children stopped, part files and render temp removed) and for every accepted call to be answered, then exit.
 *  Idempotent: a second signal during shutdown does nothing. */
export function shutdown(code: number) {
  stopping ??= (async () => {
    stopCalls.abort(new EditError("the server is shutting down", "aborted"));
    for (const j of jobs.values()) if (j.status === "running") j.ctl.abort(new EditError("the server is shutting down", "aborted"));
    await Promise.race([drain(), new Promise((r) => setTimeout(r, SHUTDOWN_MS))]);
    process.exit(code);
  })();
}

export async function startMcp() {
  const server = buildServer();
  for (const [sig, n] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]] as const) process.on(sig, () => shutdown(128 + n));
  process.stdin.on("end", () => shutdown(0)).on("close", () => shutdown(0));
  // a closed reader must not change the exit code: the reply is lost, the stop goes on (bounded by SHUTDOWN_MS)
  process.stdout.on("error", (e: NodeJS.ErrnoException) => { if (e.code !== "EPIPE" && e.code !== "ERR_STREAM_DESTROYED") throw e; });
  const transport = new StdioServerTransport();
  const send = transport.send.bind(transport);
  transport.send = (m) => { const p = send(m); sends.add(p); const del = () => sends.delete(p); p.then(del, del); return p; };
  await server.connect(transport);
}

const self = process.argv[1] ?? "";
if (/mcp\.(ts|js)$/.test(self) || /agentcut-mcp$/.test(self)) startMcp();
