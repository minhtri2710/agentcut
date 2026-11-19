// usage: profile-frames.ts <project> [scale] [ext]; draws what a render to ext (default .mp4) draws, in one process: worker segments and ranges are not taken
import { drawable } from "../src/api.ts";
import { outputDraw } from "../src/encode.ts";
import { Project } from "../src/project.ts";
import { Renderer } from "../src/render.ts";
const p = new Project(process.argv[2]);
const tl = p.load();
p.requireValid(tl);
const out = outputDraw(drawable(p, tl), process.argv[4] ?? ".mp4", { scale: Number(process.argv[3] ?? 1) });
const r = new Renderer(out.tl, p.root, out.scale);
let tf = 0, tp = 0;
const n = Math.round(r.duration * r.fps);
const t0 = performance.now();
for (let i = 0; i < n; i++) {
  const a = performance.now(); await r.frame(i / r.fps); const b = performance.now(); r.pixels(); const c = performance.now();
  tf += b - a; tp += c - b;
}
const tot = performance.now() - t0;
console.log(`frames ${n}  total ${(tot / n).toFixed(1)} ms/f  frame() ${(tf / n).toFixed(1)}  pixels() ${(tp / n).toFixed(1)}  => ${(n / tot * 1000).toFixed(1)} fps`);
r.close();
