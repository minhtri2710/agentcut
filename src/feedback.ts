// Agent feedback loop. Two inputs, one output:
//  1. notes   - agents call report_feedback when something is slow, confusing, missing or broken (deduplicated, counted)
//  2. events  - recorded automatically for every CLI/MCP call: errors, guessed names that don't exist, rejected
//               batches, slow commands, render speed, internal errors
//  -> summary - ranked improvement backlog (+ markdown report) for whoever improves AgentCut next.
// Everything stays on this machine (~/.agentcut/feedback). Disable auto events with AGENTCUT_TELEMETRY=0.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { EditError, similarity } from "./model.ts";
import { VERSION } from "./version.ts";

export const KINDS = ["bug", "missing_feature", "friction", "performance", "docs", "idea", "praise"] as const;
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const SEV_W: Record<string, number> = { low: 1, medium: 2, high: 4, critical: 8 };
const MAX_EVENTS_BYTES = 5 * 1024 * 1024;
// a command slower than this (ms) is flagged; render is judged by speed_x instead
const SLOW_MS: Record<string, number> = { apply: 1500, apply_ops: 1500, op: 1500, add: 1500, set: 1500, info: 500, project_info: 500,
  validate: 500, frame: 1500, preview_frame: 1500, sheet: 5000, contact_sheet: 5000, undo: 500, redo: 500, probe: 1500, probe_media: 1500 };

export const home = () => process.env.AGENTCUT_HOME ?? join(homedir(), ".agentcut");
const dir = () => { const d = join(home(), "feedback"); mkdirSync(d, { recursive: true }); return d; };
const notesFile = () => join(dir(), "notes.json");
const eventsFile = () => join(dir(), "events.jsonl");
const telemetryOn = () => process.env.AGENTCUT_TELEMETRY !== "0";

const HOME = homedir();
const scrub = (s: unknown, n = 240) => String(s ?? "").split(HOME).join("~").slice(0, n);

// ------------------------------------------------------------------ automatic events
export interface Miss { kind: string; guess: string; suggestion?: string }

/** Names the agent guessed that don't exist ("unknown transition 'fade_in'" + "did you mean 'crossfade'?"). */
export function extractMisses(err: any): Miss[] {
  const out: Miss[] = [];
  const scan = (msg?: string, hint?: string) => {
    const m = /unknown ([a-z_ ]+?) '([^']+)'/i.exec(msg ?? "") ?? /([a-z_ ]+) '([^']+)' not found/i.exec(msg ?? "");
    if (!m || /^clip|^track|^asset/.test(m[1])) return; // missing ids are state errors, not naming problems
    const s = /did you mean '([^']+)'/.exec(hint ?? "");
    out.push({ kind: m[1].trim(), guess: m[2], suggestion: s?.[1] });
  };
  scan(err?.message, err?.hint);
  for (const i of err?.issues ?? []) scan(i.message, i.hint);
  return out;
}

export function recordEvent(ev: Record<string, unknown>) {
  if (!telemetryOn()) return;
  try {
    const f = eventsFile();
    if (existsSync(f) && statSync(f).size > MAX_EVENTS_BYTES) { // keep the newest half
      const lines = readFileSync(f, "utf8").split("\n");
      writeFileSync(f + ".tmp", lines.slice(Math.floor(lines.length / 2)).join("\n"));
      renameSync(f + ".tmp", f);
    }
    appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), v: VERSION, ...ev }) + "\n");
  } catch { /* feedback must never break the tool */ }
}

/** Record one CLI/MCP call from its JSON response. */
export function recordCall(src: "cli" | "mcp", cmd: string, ms: number, res: any, extra: Record<string, unknown> = {}) {
  if (!cmd || cmd.startsWith("feedback") || cmd === "report_feedback") return;
  const ev: Record<string, unknown> = { type: "call", src, cmd, ms: Math.round(ms), ok: res?.ok !== false, ...extra };
  if (res?.ok === false && res.error) {
    ev.code = res.error.code;
    ev.msg = scrub(res.error.message);
    const misses = extractMisses(res.error);
    if (misses.length) ev.misses = misses;
    if (res.error.code === "validation_failed") ev.issues = (res.error.issues ?? []).slice(0, 5).map((i: any) => scrub(`${i.path.replace(/\[\d+\]/g, "[]")}: ${i.message}`, 160));
  }
  const thr = SLOW_MS[cmd];
  if (thr && ms > thr) ev.slow = true;
  recordEvent(ev);
}

// ------------------------------------------------------------------ notes (from agents)
export interface Note {
  id: string; kind: string; title: string; details?: string; area?: string; severity: string; suggestion?: string;
  count: number; first_seen: string; last_seen: string; status: "open" | "resolved" | "wontfix"; examples: string[];
  sources: string[]; versions: string[]; resolution?: string;
}

function loadNotes(): Note[] {
  try { return JSON.parse(readFileSync(notesFile(), "utf8")); } catch { return []; }
}
function saveNotes(n: Note[]) {
  const f = notesFile();
  writeFileSync(f + ".tmp", JSON.stringify(n, null, 1));
  renameSync(f + ".tmp", f);
}
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function addNote(input: { kind?: string; title: string; details?: string; area?: string; severity?: string; suggestion?: string; source?: string }) {
  const kind = input.kind ?? "friction";
  if (!(KINDS as readonly string[]).includes(kind)) throw new EditError(`unknown feedback kind '${kind}'`, "bad_kind", `kinds: ${KINDS.join(", ")}`);
  const severity = input.severity ?? (kind === "bug" ? "high" : "medium");
  if (!(SEVERITIES as readonly string[]).includes(severity)) throw new EditError(`unknown severity '${severity}'`, "bad_severity", `severities: ${SEVERITIES.join(", ")}`);
  if (!input.title?.trim()) throw new EditError("feedback needs a short title", "missing_arg", "e.g. title='no way to detach audio from a video clip'");
  const notes = loadNotes();
  const now = new Date().toISOString();
  const t = norm(input.title);
  // merge with an open note of the same kind (and area, if both have one) that says the same thing
  const dup = notes.find((n) => n.status === "open" && n.kind === kind && (!input.area || !n.area || n.area === input.area)
    && (norm(n.title) === t || similarity(norm(n.title), t) >= 0.72));
  const src = input.source ?? "agent";
  if (dup) {
    dup.count++; dup.last_seen = now;
    if (SEV_W[severity] > SEV_W[dup.severity]) dup.severity = severity;
    const ex = scrub(input.details || input.title, 400);
    if (!dup.examples.includes(ex) && dup.examples.length < 6) dup.examples.push(ex);
    if (input.suggestion && !dup.suggestion) dup.suggestion = scrub(input.suggestion, 400);
    if (!dup.sources.includes(src)) dup.sources.push(src);
    if (!dup.versions.includes(VERSION)) dup.versions.push(VERSION);
    saveNotes(notes);
    return { id: dup.id, merged: true, count: dup.count, message: "merged with an existing note (+1)" };
  }
  const id = `fb${(notes.length + 1).toString().padStart(3, "0")}`;
  notes.push({
    id, kind, title: scrub(input.title, 160), details: input.details ? scrub(input.details, 1200) : undefined, area: input.area,
    severity, suggestion: input.suggestion ? scrub(input.suggestion, 600) : undefined, count: 1, first_seen: now, last_seen: now,
    status: "open", examples: input.details ? [scrub(input.details, 400)] : [], sources: [src], versions: [VERSION],
  });
  saveNotes(notes);
  return { id, merged: false, count: 1, message: "recorded - thank you" };
}

export function listNotes(o: { status?: string; kind?: string } = {}) {
  return loadNotes().filter((n) => (!o.status || o.status === "all" || n.status === o.status) && (!o.kind || n.kind === o.kind))
    .sort((a, b) => score(b) - score(a));
}
const score = (n: Note) => n.count * SEV_W[n.severity] * (n.kind === "bug" ? 2 : 1);

export function resolveNote(id: string, status: "resolved" | "wontfix" | "open" = "resolved", resolution?: string) {
  const notes = loadNotes();
  const n = notes.find((x) => x.id === id);
  if (!n) throw new EditError(`feedback note '${id}' not found`, "not_found", "list notes with `agentcut feedback list`");
  n.status = status;
  if (resolution) n.resolution = resolution;
  saveNotes(notes);
  return { id, status };
}

// ------------------------------------------------------------------ summary
function readEvents(sinceDays?: number): any[] {
  try {
    const cut = sinceDays ? Date.now() - sinceDays * 86400e3 : 0;
    return readFileSync(eventsFile(), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && (!cut || Date.parse(e.t) >= cut));
  } catch { return []; }
}
const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export function summary(o: { sinceDays?: number; limit?: number } = {}) {
  const limit = o.limit ?? 10;
  const ev = readEvents(o.sinceDays);
  const calls = ev.filter((e) => e.type === "call");
  const renders = ev.filter((e) => e.type === "render");
  // naming misses -> alias candidates
  const missMap = new Map<string, { kind: string; guess: string; suggestion?: string; count: number }>();
  for (const e of calls) for (const m of e.misses ?? []) {
    const k = `${m.kind}|${m.guess}`;
    const cur = missMap.get(k) ?? { ...m, count: 0 };
    cur.count++; cur.suggestion ??= m.suggestion;
    missMap.set(k, cur);
  }
  const misses = [...missMap.values()].sort((a, b) => b.count - a.count).slice(0, limit);
  // errors by code
  const errMap = new Map<string, { code: string; count: number; example: string; cmds: Set<string> }>();
  for (const e of calls.filter((x) => !x.ok)) {
    const cur = errMap.get(e.code) ?? { code: e.code, count: 0, example: e.msg, cmds: new Set<string>() };
    cur.count++; cur.cmds.add(e.cmd);
    errMap.set(e.code, cur);
  }
  const errors = [...errMap.values()].sort((a, b) => b.count - a.count).slice(0, limit).map((x) => ({ ...x, cmds: [...x.cmds] }));
  const internal = errors.filter((x) => x.code === "internal");
  // rejected batches: which validation messages agents keep hitting
  const rejMap = new Map<string, number>();
  for (const e of calls) for (const i of e.issues ?? []) rejMap.set(i, (rejMap.get(i) ?? 0) + 1);
  const rejections = [...rejMap].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([issue, count]) => ({ issue, count }));
  // latency per command
  const byCmd = new Map<string, number[]>();
  for (const e of calls) { const a = byCmd.get(e.cmd) ?? []; a.push(e.ms); byCmd.set(e.cmd, a); }
  const latency = [...byCmd].map(([cmd, xs]) => ({ cmd, calls: xs.length, p50_ms: pct(xs, 0.5), p95_ms: pct(xs, 0.95), max_ms: Math.max(...xs), slow: calls.filter((e) => e.cmd === cmd && e.slow).length }))
    .sort((a, b) => b.calls - a.calls);
  const sx = renders.map((r) => Number(r.speed_x)).filter((x) => x > 0);
  const renderPerf = renders.length ? {
    renders: renders.length, speed_x_p50: +pct(sx, 0.5).toFixed(2), speed_x_min: +Math.min(...sx).toFixed(2),
    slow_renders: renders.filter((r) => r.speed_x < 0.5).length,
    slowest: [...renders].sort((a, b) => a.speed_x - b.speed_x).slice(0, 3).map((r) => ({ speed_x: r.speed_x, frames: r.frames, size: `${r.width}x${r.height}`, workers: r.workers, encoder: r.encoder, layers: r.layers })),
  } : null;
  const usage: Record<string, number> = {};
  for (const e of calls) for (const op of e.ops ?? []) usage[op] = (usage[op] ?? 0) + 1;
  const notes = listNotes({ status: "open" });
  // ranked recommendations
  const rec: { priority: number; text: string; evidence: string }[] = [];
  for (const x of internal) rec.push({ priority: 100 + x.count, text: `Fix internal error: ${x.example}`, evidence: `${x.count}x in ${x.cmds.join(", ")}` });
  for (const n of notes) rec.push({ priority: score(n) * 5, text: `[${n.kind}/${n.severity}] ${n.title}${n.suggestion ? ` - suggested: ${n.suggestion}` : ""}`, evidence: `${n.id}, reported ${n.count}x` });
  for (const m of misses) if (m.count >= 2) rec.push({ priority: 10 * m.count, text: `Agents guess ${m.kind} '${m.guess}'${m.suggestion ? ` (meant '${m.suggestion}')` : ""}: add it as an alias or rename`, evidence: `${m.count} failed calls` });
  for (const r of rejections) if (r.count >= 3) rec.push({ priority: 4 * r.count, text: `Frequent rejected batch: ${r.issue} - clarify docs/defaults or accept this input`, evidence: `${r.count}x` });
  for (const l of latency) if (l.slow >= 2 || (SLOW_MS[l.cmd] && l.p95_ms > SLOW_MS[l.cmd])) rec.push({ priority: 6 * l.slow + 5, text: `Speed up '${l.cmd}': p95 ${l.p95_ms} ms`, evidence: `${l.slow}/${l.calls} calls over ${SLOW_MS[l.cmd] ?? "?"} ms` });
  if (renderPerf?.slow_renders) rec.push({ priority: 8 * renderPerf.slow_renders, text: `Render slower than 0.5x realtime in ${renderPerf.slow_renders} job(s)`, evidence: JSON.stringify(renderPerf.slowest[0]) });
  rec.sort((a, b) => b.priority - a.priority);
  return {
    store: dir(), telemetry: telemetryOn(), events: ev.length, calls: calls.length,
    error_rate: calls.length ? +(calls.filter((e) => !e.ok).length / calls.length).toFixed(3) : 0,
    recommendations: rec.slice(0, limit * 2).map(({ text, evidence }) => ({ text, evidence })),
    open_notes: notes.slice(0, limit).map(({ id, kind, severity, title, count, area, suggestion }) => ({ id, kind, severity, title, count, area, suggestion })),
    naming_misses: misses, errors, rejections, latency: latency.slice(0, limit), render: renderPerf,
    op_usage: Object.fromEntries(Object.entries(usage).sort((a, b) => b[1] - a[1]).slice(0, 20)),
  };
}

export function summaryMarkdown(s: ReturnType<typeof summary>): string {
  const L = [`# AgentCut improvement backlog`, ``, `Generated ${new Date().toISOString()} by AgentCut ${VERSION} on ${platform()} from ${s.calls} recorded calls (error rate ${(s.error_rate * 100).toFixed(1)}%) and ${s.open_notes.length} open agent notes.`, ``, `## Do next (ranked)`];
  s.recommendations.forEach((r, i) => L.push(`${i + 1}. ${r.text}  _(${r.evidence})_`));
  if (!s.recommendations.length) L.push("_Nothing yet - keep using AgentCut and report friction with report_feedback._");
  if (s.open_notes.length) { L.push("", "## Open agent notes", "| id | kind | sev | count | title |", "|---|---|---|---|---|"); for (const n of s.open_notes) L.push(`| ${n.id} | ${n.kind} | ${n.severity} | ${n.count} | ${n.title} |`); }
  if (s.naming_misses.length) { L.push("", "## Names agents guessed", "| kind | guessed | meant | count |", "|---|---|---|---|"); for (const m of s.naming_misses) L.push(`| ${m.kind} | \`${m.guess}\` | ${m.suggestion ? `\`${m.suggestion}\`` : "?"} | ${m.count} |`); }
  if (s.errors.length) { L.push("", "## Errors by code", "| code | count | commands | example |", "|---|---|---|---|"); for (const e of s.errors) L.push(`| ${e.code} | ${e.count} | ${e.cmds.join(", ")} | ${e.example?.replace(/\|/g, "\\|")} |`); }
  if (s.latency.length) { L.push("", "## Latency", "| command | calls | p50 ms | p95 ms | max ms | slow |", "|---|---|---|---|---|---|"); for (const l of s.latency) L.push(`| ${l.cmd} | ${l.calls} | ${l.p50_ms} | ${l.p95_ms} | ${l.max_ms} | ${l.slow} |`); }
  if (s.render) L.push("", "## Render", `${s.render.renders} renders, speed p50 ${s.render.speed_x_p50}x realtime, min ${s.render.speed_x_min}x, ${s.render.slow_renders} under 0.5x.`);
  return L.join("\n") + "\n";
}

export const FEEDBACK_GUIDE = `Whenever AgentCut slows you down - a name you guessed that does not exist, a feature you had to work around,
something slow, unclear docs, an error you could not fix from its hint, or output that looked wrong - call
report_feedback once (CLI: agentcut feedback add kind=... title=...) with a short title, what you expected and, if you
have one, a suggestion. Duplicates are merged and counted, so reporting the same thing again is useful.
Errors, guessed names and slow calls are logged automatically; your note adds the WHY.`;
