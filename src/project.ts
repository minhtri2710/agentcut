// Project folder: project.json + media/ renders/ previews/ fonts/ + .agentcut/history (undo/redo).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve as presolve } from "node:path";
import { fontCheck, registerFontDir } from "./fonts.ts";
import {
  clipDur, clipStart, clone, EditError, type Issue, newTimeline, normAnim, PRESETS, resolve, suggest, type Timeline,
  totalDuration, validate,
} from "./model.ts";

export const PROJECT_FILE = "project.json";
const MAX_HISTORY = 100;

export function findProject(start?: string): string {
  const env = process.env.AGENTCUT_PROJECT;
  let p = presolve(start ?? env ?? process.cwd());
  if (p.endsWith(".json") && existsSync(p)) return dirname(p);
  for (let cur = p; ; cur = dirname(cur)) {
    if (existsSync(join(cur, PROJECT_FILE))) return cur;
    if (dirname(cur) === cur) break;
  }
  throw new EditError(`no ${PROJECT_FILE} found in ${p} or its parents`, "no_project", "create one with `agentcut init <dir> --preset reels` (or pass -p <dir>)");
}

export class Project {
  root: string; file: string; hist: string;
  constructor(root: string) {
    this.root = presolve(root);
    this.file = join(this.root, PROJECT_FILE);
    if (!existsSync(this.file)) throw new EditError(`${this.file} does not exist`, "no_project", "run `agentcut init` first");
    this.hist = join(this.root, ".agentcut", "history");
    registerFontDir(join(this.root, "fonts"));
  }

  static create(root: string, o: { preset?: string; width?: number; height?: number; fps?: number; name?: string; empty?: boolean } = {}) {
    root = presolve(root);
    if (existsSync(join(root, PROJECT_FILE))) throw new EditError(`project already exists at ${root}`, "exists", "open it instead, or choose another folder");
    let w = o.width ?? 1920, h = o.height ?? 1080;
    if (o.preset) {
      if (!PRESETS[o.preset]) { const s = suggest(o.preset, Object.keys(PRESETS)); throw new EditError(`unknown preset '${o.preset}'`, "bad_preset", `${s ? `did you mean '${s}'? ` : ""}presets: ${Object.keys(PRESETS).join(", ")}`); }
      [w, h] = PRESETS[o.preset];
    }
    for (const d of ["media", "renders", "previews", "fonts", ".agentcut/history/undo", ".agentcut/history/redo"]) mkdirSync(join(root, d), { recursive: true });
    const tl = newTimeline(w, h, o.fps ?? 30, o.name ?? basename(root));
    if (o.empty) tl.tracks = [];
    writeFileSync(join(root, PROJECT_FILE), JSON.stringify(tl, null, 2));
    return new Project(root);
  }

  load(): Timeline {
    try { return JSON.parse(readFileSync(this.file, "utf8")); }
    catch (e: any) { throw new EditError(`project.json is not valid JSON: ${e.message}`, "bad_json", "fix the file or run `agentcut undo` to restore the last good version"); }
  }

  save(tl: Timeline, label = "edit", snapshot = true) {
    resolve(tl);
    if (snapshot) { this.push("undo", readFileSync(this.file, "utf8"), label); this.clear("redo"); }
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(tl, null, 2));
    renameSync(tmp, this.file);
  }

  // ---------------------------------------------------------------- history
  private stack(name: string) { const d = join(this.hist, name); mkdirSync(d, { recursive: true }); return d; }
  private entries(name: string) { const d = this.stack(name); return readdirSync(d).filter((f) => f.endsWith(".json")).sort().map((f) => join(d, f)); }
  private push(name: string, content: string, label: string) {
    const ts = `${Date.now()}${String(Math.floor(performance.now() * 1000) % 1e6).padStart(6, "0")}`;
    writeFileSync(join(this.stack(name), `${ts}.json`), JSON.stringify({ label, time: Date.now(), timeline: content }));
    const e = this.entries(name);
    for (const old of e.slice(0, Math.max(0, e.length - MAX_HISTORY))) unlinkSync(old);
  }
  private clear(name: string) { rmSync(this.stack(name), { recursive: true, force: true }); }
  private pop(name: string) {
    const e = this.entries(name);
    if (!e.length) return null;
    const d = JSON.parse(readFileSync(e[e.length - 1], "utf8"));
    unlinkSync(e[e.length - 1]);
    return d;
  }
  private step(from: string, to: string, steps: number) {
    const labels: string[] = [];
    for (let i = 0; i < steps; i++) {
      const d = this.pop(from);
      if (!d) break;
      this.push(to, readFileSync(this.file, "utf8"), d.label);
      writeFileSync(this.file, d.timeline);
      labels.push(d.label);
    }
    if (!labels.length) throw new EditError(`nothing to ${from}`, "empty_history");
    return labels;
  }
  undo(steps = 1) { return this.step("undo", "redo", steps); }
  redo(steps = 1) { return this.step("redo", "undo", steps); }
  history() {
    const lab = (n: string) => this.entries(n).slice(-20).map((p) => JSON.parse(readFileSync(p, "utf8")).label);
    return { undo: lab("undo"), redo: lab("redo") };
  }

  // ---------------------------------------------------------------- paths
  rel(p: string) { const a = presolve(p); const r = relative(this.root, a); return r.startsWith("..") || isAbsolute(r) ? a : r; }
  abs(p: string) { return isAbsolute(p) ? p : join(this.root, p); }
  absolutized(tl: Timeline): Timeline {
    const t = clone(tl);
    for (const a of Object.values(t.assets)) if (a.path) a.path = this.abs(a.path);
    return t;
  }
  validate(tl?: Timeline): Issue[] {
    const t = this.absolutized(resolve(clone(tl ?? this.load())));
    return validate(t, { exists: (p) => existsSync(p), fontCheck });
  }
  defaultOutput(ext = ".mp4", tag = "") {
    const name = this.load().name || "video";
    const d = new Date(), pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return join(this.root, "renders", `${name}${tag ? "-" + tag : ""}-${stamp}${ext}`);
  }
}

/** Token-cheap text view of a timeline. */
export function summarize(tl: Timeline): string {
  resolve(tl);
  const st = tl.settings;
  const L = [`${tl.name || "untitled"}: ${st.width}x${st.height} @${st.fps}fps, duration ${totalDuration(tl).toFixed(2)}s, bg ${st.background ?? "#000"}, loudness ${st.loudness}`];
  const assets = Object.entries(tl.assets);
  if (assets.length) {
    L.push("assets:");
    for (const [id, a] of assets) L.push(`  ${id}: ${a.kind}${a.width ? ` ${a.width}x${a.height}` : ""}${a.duration ? ` ${a.duration.toFixed(2)}s` : ""}${a.has_audio && a.kind === "video" ? " +audio" : ""}${a.alpha ? " alpha" : ""}  ${basename(a.path ?? "")}`);
  }
  L.push("tracks (bottom -> top):");
  tl.tracks.forEach((tr, i) => {
    const f = [tr.kind ?? "video", ...["magnetic", "muted", "hidden"].filter((k) => tr[k])];
    if (tr.role) f.push(`role=${tr.role}`);
    if (tr.duck) f.push(`duck=${tr.duck}dB`);
    L.push(`  [${i}] ${tr.id} (${f.join(", ")}) ${tr.clips.length} clips`);
    for (const c of tr.clips) {
      const s = clipStart(c), d = clipDur(c);
      let desc = c.type;
      if (c.asset) desc += ` ${c.asset}${c.in ? `@${Number(c.in).toFixed(2)}` : ""}`;
      if (c.text) { const t = String(c.text).replace(/\n/g, " / "); desc += ` "${t.slice(0, 40)}${t.length > 40 ? "…" : ""}"`; }
      if (c.type === "captions") desc += ` style=${c.style ?? "karaoke"} words=${(c.words || []).length}${c.srt ? " srt" : ""}`;
      if (c.type === "shape") desc += ` ${c.shape ?? "rect"}`;
      const x: string[] = [];
      for (const k of ["enter", "exit", "transition", "motion"]) { const v = k === "motion" ? c[k] : normAnim(c[k], 0.5); if (v) x.push(`${k}=${typeof v === "object" ? v.type : v}`); }
      if (c.keyframes) x.push(`kf=${Object.keys(c.keyframes).join(",")}`);
      if (c.filters?.length) x.push(`filters=${c.filters.map((f: any) => (typeof f === "string" ? f : f.type)).join(",")}`);
      if (c.effects?.length) x.push(`fx=${c.effects.map((f: any) => (typeof f === "string" ? f : f.type)).join(",")}`);
      if (c.mask) x.push(`mask=${typeof c.mask === "string" ? c.mask : c.mask.shape}`);
      for (const k of ["fit", "position", "blend"]) if (c[k] && c[k] !== "cover" && c[k] !== "normal") x.push(`${k}=${c[k]}`);
      if ((c.speed ?? 1) !== 1) x.push(`speed=${c.speed}`);
      if ((c.volume ?? 1) !== 1) x.push(`vol=${c.volume}`);
      for (const k of ["reverse", "freeze", "loop", "until_end"]) if (c[k]) x.push(k);
      if (c.attach_to) x.push(`attached→${c.attach_to}${c.offset ? `+${c.offset}` : ""}`);
      if (c.enabled === false) x.push("DISABLED");
      L.push(`      ${s.toFixed(2).padStart(7)}–${(s + d).toFixed(2).padStart(7)}  ${c.id.padEnd(8)} ${desc}${x.length ? `  [${x.join(" ")}]` : ""}`);
    }
  });
  if (tl.markers?.length) L.push("markers: " + tl.markers.slice(0, 40).map((m) => `${m.t}s ${m.label ?? ""}`.trim()).join(", "));
  return L.join("\n");
}

export const fileSize = (p: string) => statSync(p).size;
