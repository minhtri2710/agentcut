#!/usr/bin/env node
// `agentcut` CLI. Prints exactly one JSON object on stdout; progress goes to stderr.
// Exit codes: 0 ok · 1 edit/validation error · 2 usage error · 3 internal error.
import { existsSync, readFileSync } from "node:fs";
import { EditError, setDotted } from "./model.ts";

const VERSION = "0.2.0";
const BOOL = new Set(["pretty", "json", "text", "dry-run", "allow-invalid", "guides", "draft", "no-sheet", "quiet", "markers", "full", "empty", "fast", "help", "ripple", "copy"]);

const HELP = `agentcut ${VERSION} - agent-first video editor (JSON timeline · CLI + MCP)

Start here:  agentcut guide
Project:     init DIR [--preset reels|youtube|square|portrait|4k] · info [--text|--json] · validate · undo [n] · redo [n] · history
Edit:        apply FILE|- [--ops JSON] [--dry-run] · op NAME key=value... · add key=value... · set ID key=value... · rm ID
Look:        frame T [-o out.png] [--scale 0.5] [--guides] · sheet [--every 1|--times a,b|--count 12] [--guides]
Export:      render [-o out.mp4|.mov|.webm|.gif] [--from S --to S] [--draft] [--fast] [--quality draft|standard|high] [--workers N]
Analyze:     probe F · beats F [--markers] · scenes F · silence F · loudness F · transcribe F
Voice/fonts: tts "text" -o out.wav [--voice Linh] · voices [--lang vi] · fonts [query]
Reference:   guide · schema · ops · capabilities · mcp (start the MCP server on stdio)
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
      if (v !== undefined) flags[k] = v;
      else if (BOOL.has(k) && !/^[[{]/.test(argv[i + 1] ?? "")) flags[k] = true;
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
function emit(obj: unknown, code = 0): never {
  process.stdout.write(JSON.stringify(obj, null, pretty ? 2 : undefined) + "\n");
  process.exit(code);
}

async function readOps(file: string | undefined, inline: string | undefined) {
  let data: any;
  if (inline) data = JSON.parse(inline);
  else if (!file || file === "-") { let s = ""; for await (const c of process.stdin) s += c; data = JSON.parse(s); }
  else {
    if (!existsSync(file)) throw new EditError(`ops file not found: ${file}`, "not_found", "pass a JSON file, '-' for stdin, or --ops '[...]'");
    data = JSON.parse(readFileSync(file, "utf8"));
  }
  return Array.isArray(data) ? data : data.ops ?? [data];
}

const num = (v: any) => (v === undefined ? undefined : Number(v));

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "__segment") { const { runSegment } = await import("./segment-worker.ts"); await runSegment(argv[1]); return; }
  const { flags: f, pos } = parseArgs(argv);
  pretty = !!f.pretty || !!process.stdout.isTTY;
  const cmd = pos.shift();
  if (!cmd || f.help || cmd === "help") { console.log(HELP); return; }
  if (cmd === "--version" || cmd === "version") { console.log(VERSION); return; }
  if (cmd === "guide" || cmd === "docs") { const { GUIDE } = await import("./docs.ts"); console.log(GUIDE.trim()); return; }
  if (cmd === "mcp") { const { startMcp } = await import("./mcp.ts"); await startMcp(); return; }
  const api = await import("./api.ts");
  const P = f.project;
  let res: any;
  try {
    switch (cmd) {
      case "init": res = api.create(pos[0] ?? ".", { preset: f.preset, width: num(f.width), height: num(f.height), fps: num(f.fps), name: f.name, empty: f.empty }); break;
      case "info": case "show": case "status":
        res = api.info(P, f.json ? "both" : "summary");
        if (f.text) { console.log(res.summary); return; }
        break;
      case "apply": res = await api.apply(P, await readOps(pos[0], f.ops), { dryRun: f["dry-run"], allowInvalid: f["allow-invalid"] }); break;
      case "op": res = await api.apply(P, [{ op: pos.shift(), ...(typeof f.json === "string" ? JSON.parse(f.json) : {}), ...kv(pos) }], { dryRun: f["dry-run"] }); break;
      case "add": res = await api.apply(P, [{ op: "add_clip", ...kv(pos) }]); break;
      case "set": res = await api.apply(P, [{ op: "update_clip", id: pos.shift(), set: kv(pos) }]); break;
      case "rm": res = await api.apply(P, [{ op: "remove_clip", id: pos[0], ripple: !!f.ripple }]); break;
      case "validate": { const v = api.validate(P); emit({ ok: v.valid, ...v }, v.valid ? 0 : 1); }
      case "frame": res = await api.frame(P, pos[0] ?? 0, { out: f.output, scale: num(f.scale), guides: f.guides }); break;
      case "sheet": res = await api.sheet(P, { times: f.times, every: num(f.every), count: num(f.count), cols: num(f.cols), out: f.output, tileWidth: num(f["tile-width"]), guides: f.guides }); break;
      case "render": case "export": {
        let last = 0;
        res = await api.render(P, {
          out: f.output, start: f.from, end: f.to, scale: num(f.scale), quality: f.quality, draft: f.draft, sheet: !f["no-sheet"],
          workers: num(f.workers), fast: f.fast,
          progress: f.quiet ? undefined : (d, n) => { const now = Date.now(); if (now - last > 400 || d === n) { last = now; process.stderr.write(JSON.stringify({ progress: +(d / n).toFixed(3), frame: d, frames: n }) + "\n"); } },
        });
        break;
      }
      case "undo": res = api.undo(P, num(pos[0]) ?? 1); break;
      case "redo": res = api.redo(P, num(pos[0]) ?? 1); break;
      case "history": res = api.history(P); break;
      case "probe": res = api.probe(pos[0]); break;
      case "beats": {
        res = api.analyze.beats(pos[0]);
        if (f.markers) { await api.apply(P, res.beats.map((t: number, i: number) => ({ op: "add_marker", t, label: `beat ${i}` }))); res.markers_added = res.beats.length; }
        if (!f.full && res.beats.length > 64) { res.beats = res.beats.slice(0, 64); res.beats_truncated = true; }
        break;
      }
      case "scenes": res = api.analyze.scenes(pos[0], num(f.threshold)); break;
      case "silence": res = api.analyze.silence(pos[0], num(f["noise-db"]), num(f["min-silence"])); break;
      case "loudness": res = api.analyze.loudness(pos[0]); break;
      case "transcribe": res = api.analyze.transcribe(pos[0], f.language); break;
      case "tts": res = api.analyze.tts(pos[0], f.output, f.voice, num(f.rate)); break;
      case "voices": res = api.voices(f.lang); break;
      case "fonts": res = await api.fonts(pos[0] ?? ""); break;
      case "schema": res = api.schema(); break;
      case "ops": res = api.opsDoc(); break;
      case "capabilities": case "caps": res = api.capabilities(); break;
      default: emit({ ok: false, error: { code: "usage", message: `unknown command '${cmd}'`, hint: "run `agentcut help`" } }, 2);
    }
    emit({ ok: true, ...res });
  } catch (e: any) {
    if (e instanceof EditError) emit({ ok: false, error: e.toJSON() }, 1);
    if (e instanceof SyntaxError) emit({ ok: false, error: { code: "bad_json", message: e.message, hint: "ops must be valid JSON" } }, 2);
    emit({ ok: false, error: { code: "internal", message: `${e?.name}: ${e?.message}`, ...(process.env.AGENTCUT_DEBUG ? { trace: e?.stack } : { hint: "set AGENTCUT_DEBUG=1 for a stack trace" }) } }, 3);
  }
}

const self = process.argv[1] ?? "";
if (/cli\.(ts|js)$/.test(self) || self.includes("$bunfs") || self.includes("~BUN") || /agentcut(\.exe)?$/.test(self)) main();
