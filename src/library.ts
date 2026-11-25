// The UI's library: the named looks, effects, transitions and text/caption presets, each shown as a still rendered from a small scratch timeline.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as api from "./api.ts";
import { capPreviews } from "./cache.ts";
import { LOOKS } from "./color.ts";
import { type Dict, EditError, EFFECTS, TRANSITIONS } from "./model.ts";
import { CAPTION_PRESETS, TEXT_PRESETS } from "./presets.ts";
import { run } from "./proc.ts";
import type { Project } from "./project.ts";
import { ensureDir, writeFile } from "./safe-write.ts";
import { VERSION } from "./version.ts";

export const LIBRARY: Record<string, string[]> = {
  look: Object.keys(LOOKS), effect: Object.keys(EFFECTS), transition: [...TRANSITIONS], text: Object.keys(TEXT_PRESETS), caption: Object.keys(CAPTION_PRESETS),
};

/** the ops that show `name` and the time to look at: a test picture (two for a transition), or a gradient under text, two seconds each */
function scene(kind: string, name: string, a: string, b: string): { ops: Dict[]; t: number } {
  const pic = (src: string, more: Dict = {}) => ({ op: "add_clip", track: "main", src, duration: 2, ...more });
  if (kind === "look") return { ops: [pic(a, { color: { look: name } })], t: 1 };
  if (kind === "effect") return { ops: [pic(a), name === "flash" ? { op: "add_effect", type: name, at: 0.8, duration: 0.4 } : { op: "add_effect", type: name }], t: 1 };
  if (kind === "transition") return { ops: [pic(a), pic(b, { transition: { type: name, duration: 1 } })], t: 1.5 };
  const calm = { op: "add_clip", track: "main", type: "color", gradient: { colors: ["#0f2027", "#2c5364"], angle: 135 }, duration: 2 }; // text reads on it as on footage
  if (kind === "text") return { ops: [calm, { op: "add_clip", track: "text", text: "Title", at: 0, duration: 2, preset: name }], t: 1.5 };
  return { ops: [calm, { op: "add_captions", preset: name, words: ["One", "two", "three", "four"].map((text, i) => ({ text, start: i * 0.5, end: i * 0.5 + 0.45 })) }], t: 1.2 };
}

/** One JPEG of a library item, 320x180 (a 960x540 timeline at a quarter: presets are sized for HD canvases), made in a scratch project under `root`/.agentcut/tmp (a render- dir: cache prune sweeps one a dead process left). */
export async function libraryPreview(root: string, kind: string, name: string): Promise<Buffer> {
  const dir = mkdtempSync(join(ensureDir(root, join(root, ".agentcut", "tmp")), `render-${process.pid}-`));
  try {
    const a = join(dir, "a.png"), b = join(dir, "b.png");
    for (const [src, out] of [["testsrc2=s=960x540", a], ["smptehdbars=s=960x540", b]]) {
      const r = await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", src, "-frames:v", "1", "-y", out]);
      if (r.status !== 0) throw new Error("ffmpeg could not make the preview picture: " + r.stderr.trim());
    }
    const p = join(dir, "p"), s = scene(kind, name, a, b);
    api.create(p, { width: 960, height: 540, fps: 30 });
    await api.apply(p, s.ops, { revision: 0, author: "library", label: "preview" });
    return (await api.frameImage(p, s.t, { scale: 1 / 3, format: "jpeg" })).data;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const making = new Map<string, Promise<string>>();
/** The file of a library item's still in previews/ui/library, made once per AgentCut version (the renderer it shows); concurrent requests share one making. */
export function libraryStill(p: Project, kind: string, name: string): Promise<string> {
  if (!LIBRARY[kind]?.includes(name)) throw new EditError(`no library item ${kind}/${name}`, "not_found", "kinds: " + Object.keys(LIBRARY).join(", "));
  const file = join(p.root, "previews", "ui", "library", `${kind}-${name}-${VERSION}.jpg`);
  if (existsSync(file)) return Promise.resolve(file);
  if (!making.has(file)) making.set(file, libraryPreview(p.root, kind, name).then((jpg) => {
    ensureDir(p.root, join(p.root, "previews", "ui", "library"));
    writeFile(file, jpg, p.root);
    capPreviews(p, file);
    return file;
  }).finally(() => making.delete(file)));
  return making.get(file)!;
}
