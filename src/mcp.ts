#!/usr/bin/env node
// AgentCut MCP server (stdio). Tools mirror the CLI; preview tools return real images so the agent can SEE.
// Claude Code: claude mcp add agentcut -- agentcut-mcp
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as api from "./api.ts";
import { GUIDE } from "./docs.ts";
import { FEEDBACK_GUIDE, KINDS, recordCall, SEVERITIES } from "./feedback.ts";
import { EditError } from "./model.ts";
import { VERSION } from "./version.ts";

const INSTRUCTIONS = `AgentCut: JSON-timeline video editor with CapCut/Final Cut features. Read \`guide\` once. Loop:
create_project -> probe_media/analyze_* -> apply_ops (atomic; or apply_template) -> contact_sheet/preview_frame (LOOK) ->
render (draft first) -> fix with apply_ops/undo -> final render. Times are seconds; tracks[0] is the bottom layer.
After create_project/open_project the server remembers the project, so 'project' args are optional.
Help improve AgentCut: when something is slow, confusing, missing or broken, call report_feedback (one short call).`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const state: { project?: string } = { project: process.env.AGENTCUT_PROJECT };
const jobs = new Map<string, any>();

const text = (o: unknown): Content => ({ type: "text", text: typeof o === "string" ? o : JSON.stringify(o) });
const ok = (o: object) => ({ content: [text({ ok: true, ...o })] });
function fail(e: any) {
  const error = e instanceof EditError ? e.toJSON() : { code: "internal", message: `${e?.name}: ${e?.message}`, hint: "this is an AgentCut bug: it was logged; please also call report_feedback(kind='bug') with what you were doing", ...(process.env.AGENTCUT_DEBUG ? { trace: e?.stack } : {}) };
  return { content: [text({ ok: false, error })], isError: true };
}
function proj(p?: string) {
  if (p) { state.project = p; return p; }
  if (state.project) return state.project;
  throw new EditError("no project selected", "no_project", "call create_project or open_project first, or pass project=<folder>");
}
const wrap = <A>(f: (a: A) => any) => async (a: A) => { try { return ok(await f(a)); } catch (e) { return fail(e); } };
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const image = (path: string): Content => ({ type: "image", data: readFileSync(path).toString("base64"), mimeType: MIME[path.split(".").pop()!.toLowerCase()] ?? "image/png" });

export function buildServer() {
  const s = new McpServer({ name: "agentcut", version: VERSION }, { instructions: INSTRUCTIONS });
  // every tool call is timed and its outcome logged for the feedback summary (errors, guessed names, slow calls)
  const register = s.registerTool.bind(s);
  (s as any).registerTool = (name: string, cfg: any, handler: any) => (register as any)(name, cfg, async (a: any, extra: any) => {
    const t0 = performance.now();
    const r = await handler(a, extra);
    let res: any = { ok: !r?.isError };
    try { const t = r?.content?.find((c: any) => c.type === "text")?.text; if (t?.startsWith("{")) res = JSON.parse(t); } catch { /* not JSON */ }
    recordCall("mcp", name, performance.now() - t0, res, name === "apply_ops" ? { ops: (a?.ops ?? []).map((o: any) => o?.op) } : {});
    return r;
  });
  const P = z.string().optional().describe("project folder (optional after create/open)");

  s.registerTool("guide", { description: "Read first: how AgentCut works (tracks, magnetic timeline, templates, ops cheat-sheet, vocabulary, rules)." },
    async () => ({ content: [text(GUIDE.trim())] }));
  s.registerTool("capabilities", { description: "Every clip type, transition, animation, motion, effect, filter/look, mask, text & caption preset, template, canvas preset and op name." },
    wrap(() => api.capabilities()));
  s.registerTool("ops_reference", { description: "Every edit op accepted by apply_ops, with arguments." }, wrap(() => api.opsDoc()));
  s.registerTool("timeline_schema", { description: "The timeline JSON format (fields per clip type, units, enums)." }, wrap(() => api.schema()));

  s.registerTool("create_project", {
    description: "Create a project folder and make it current. preset: reels|tiktok|shorts (1080x1920), youtube (1920x1080), square, portrait, 4k, 720p.",
    inputSchema: { path: z.string(), preset: z.string().default("reels"), width: z.number().int().optional(), height: z.number().int().optional(), fps: z.number().default(30), name: z.string().optional() },
  }, wrap((a) => { const r = api.create(a.path, { preset: a.width ? undefined : a.preset, width: a.width, height: a.height, fps: a.fps, name: a.name }); state.project = r.project; return r; }));
  s.registerTool("open_project", { description: "Select an existing project folder and return its summary.", inputSchema: { path: z.string() } },
    wrap((a) => { state.project = a.path; return api.info(a.path); }));
  s.registerTool("project_info", { description: "Compact text summary of the timeline (tracks bottom->top, clip ids/times) + validation counts. include_json returns the full JSON.", inputSchema: { project: P, include_json: z.boolean().default(false) } },
    wrap((a) => api.info(proj(a.project), a.include_json ? "both" : "summary")));
  s.registerTool("apply_ops", {
    description: `Apply a batch of edit ops atomically. Each op is {op, ...args}. Ops: ${api.capabilities().ops.join(", ")} (args: ops_reference). A batch that would add validation errors is rejected with issues+hints. Returns new clip ids.`,
    inputSchema: { ops: z.array(z.record(z.string(), z.any())), project: P, dry_run: z.boolean().default(false), allow_invalid: z.boolean().default(false) },
  }, wrap((a) => api.apply(proj(a.project), a.ops, { dryRun: a.dry_run, allowInvalid: a.allow_invalid })));
  s.registerTool("validate", { description: "Check the timeline: issues with level, JSON path, message, hint.", inputSchema: { project: P } }, wrap((a) => api.validate(proj(a.project))));
  s.registerTool("undo", { description: "Undo the last N edit batches.", inputSchema: { steps: z.number().int().default(1), project: P } }, wrap((a) => api.undo(proj(a.project), a.steps)));
  s.registerTool("redo", { description: "Redo N undone batches.", inputSchema: { steps: z.number().int().default(1), project: P } }, wrap((a) => api.redo(proj(a.project), a.steps)));

  s.registerTool("preview_frame", {
    description: "Render ONE frame at time t (seconds) and return it as an image. guides=true overlays safe areas (red = social UI zones on 9:16).",
    inputSchema: { t: z.number(), project: P, scale: z.number().default(0.4), guides: z.boolean().default(false) },
  }, async (a) => { try { const r = await api.frame(proj(a.project), a.t, { scale: a.scale, guides: a.guides }); return { content: [image(r.image), text({ ok: true, ...r })] }; } catch (e) { return fail(e); } });
  s.registerTool("contact_sheet", {
    description: "Grid of timestamped frames across the timeline (no full render). Default 12 evenly spaced; or times=[...] / every=1.",
    inputSchema: { project: P, times: z.array(z.number()).optional(), every: z.number().optional(), count: z.number().int().default(12), cols: z.number().int().default(4), guides: z.boolean().default(false) },
  }, async (a) => { try { const r = await api.sheet(proj(a.project), { times: a.times, every: a.every, count: a.count, cols: a.cols, guides: a.guides, tileWidth: 300 }); return { content: [image(r.image), text({ ok: true, ...r })] }; } catch (e) { return fail(e); } });

  const waitJob = async (id: string, secs: number) => {
    const j = jobs.get(id);
    if (!j) return { content: [text({ ok: false, error: { code: "not_found", message: `no job ${id}` } })], isError: true };
    const until = Date.now() + secs * 1000;
    while (j.status === "running" && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
    const { promise, ...pub } = j;
    return { content: [text({ ok: j.status !== "failed", ...pub, elapsed: +(((j.finished ?? Date.now()) - j.started) / 1000).toFixed(1), ...(j.status === "running" ? { hint: `still rendering; call render_status(job_id='${id}')` } : {}) })] };
  };
  s.registerTool("render", {
    description: "Export by extension: .mp4 (H.264, codec=hevc for H.265), .mov (ProRes; codec=prores_4444 keeps alpha with a transparent background), .webm (VP9, alpha ok), .mkv, .gif, or audio only (.wav/.mp3/.m4a/.flac). draft=true: half size + hardware encode (fast check). start/end render a section. Waits up to wait_seconds, else returns job_id for render_status. Result includes contact_sheet + loudness - check them. For a Final Cut / Resolve project file use export_timeline.",
    inputSchema: { project: P, output: z.string().optional(), start: z.number().default(0), end: z.number().optional(), draft: z.boolean().default(false), quality: z.enum(["draft", "standard", "high"]).default("standard"), scale: z.number().default(1), fast: z.boolean().default(false), codec: z.enum(["auto", "h264", "hevc", "prores", "prores_4444", "vp9"]).default("auto"), alpha: z.boolean().optional().describe("keep transparency (default: on when background is transparent and the codec supports it)"), wait_seconds: z.number().default(55) },
  }, async (a) => {
    let project: string;
    try { project = proj(a.project); } catch (e) { return fail(e); }
    const id = Math.random().toString(36).slice(2, 10);
    const job: any = { job_id: id, status: "running", progress: 0, started: Date.now(), project };
    jobs.set(id, job);
    job.promise = api.render(project, { out: a.output, start: a.start, end: a.end, draft: a.draft, quality: a.quality, scale: a.scale, fast: a.fast, codec: a.codec, alpha: a.alpha, progress: (d, n) => { job.progress = +(d / n).toFixed(3); } })
      .then((r) => { job.status = "done"; job.result = r; }, (e) => { job.status = "failed"; job.error = e instanceof EditError ? e.toJSON() : { code: "internal", message: String(e?.message ?? e) }; })
      .finally(() => { job.finished = Date.now(); });
    return waitJob(id, a.wait_seconds);
  });
  s.registerTool("export_timeline", {
    description: "Hand the edit to a human editor: write an FCPXML (Final Cut Pro) or OTIO (OpenTimelineIO: DaVinci Resolve, Premiere, Avid) project that references the original media. Lists what could not be represented (skipped).",
    inputSchema: { project: P, format: z.enum(["fcpxml", "otio"]).default("fcpxml"), output: z.string().optional() },
  }, wrap((a) => api.exportTimeline(proj(a.project), { format: a.format, out: a.output })));
  s.registerTool("render_status", { description: "Status/result of a render job (waits up to wait_seconds).", inputSchema: { job_id: z.string(), wait_seconds: z.number().default(30) } }, (a) => waitJob(a.job_id, a.wait_seconds));
  s.registerTool("view_image", { description: "Return a local PNG/JPG (e.g. a render's contact_sheet) as an image.", inputSchema: { path: z.string() } },
    async (a) => { try { return { content: [image(a.path)] }; } catch (e) { return fail(e); } });

  s.registerTool("probe_media", { description: "Duration, size, fps, audio, alpha of a media file (video/image/audio/Lottie).", inputSchema: { path: z.string() } }, wrap((a) => api.probe(a.path)));
  s.registerTool("analyze_beats", { description: "Tempo, beat times and bar starts of a music file (use with snap_to_beats).", inputSchema: { path: z.string(), max_beats: z.number().int().default(128) } },
    wrap((a) => { const r: any = api.analyze.beats(a.path); if (r.beats.length > a.max_beats) { r.beats = r.beats.slice(0, a.max_beats); r.truncated = true; } return r; }));
  s.registerTool("analyze_scenes", { description: "Shot boundaries of a video: cut times + shot list.", inputSchema: { path: z.string(), threshold: z.number().default(0.3) } }, wrap((a) => api.analyze.scenes(a.path, a.threshold)));
  s.registerTool("analyze_silence", { description: "Silent and speech ranges (see op remove_silence).", inputSchema: { path: z.string(), noise_db: z.number().default(-35), min_silence: z.number().default(0.4) } }, wrap((a) => api.analyze.silence(a.path, a.noise_db, a.min_silence)));
  s.registerTool("measure_loudness", { description: "EBU R128 integrated loudness (LUFS), range and true peak.", inputSchema: { path: z.string() } }, wrap((a) => api.analyze.loudness(a.path)));
  s.registerTool("analyze_subject", { description: "Subject centre over time (largest face, else most salient region; x/y 0..1 of the frame). Needs uv; cached. Usually you want op auto_reframe / track_to instead.", inputSchema: { path: z.string(), fps: z.number().default(6) } }, wrap((a) => api.analyze.subject(a.path, a.fps)));
  s.registerTool("transcribe", { description: "Word-level transcript (needs whisper.cpp + AGENTCUT_WHISPER_MODEL, or openai-whisper).", inputSchema: { path: z.string(), language: z.string().optional() } }, wrap((a) => api.analyze.transcribe(a.path, a.language)));
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

export async function startMcp() {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}

const self = process.argv[1] ?? "";
if (/mcp\.(ts|js)$/.test(self) || /agentcut-mcp$/.test(self)) startMcp();
