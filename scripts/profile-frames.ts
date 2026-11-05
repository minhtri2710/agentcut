import { Project } from "../src/project.ts";
import { Renderer } from "../src/render.ts";
const p = new Project(process.argv[2]);
const r = new Renderer(p.absolutized(p.load()), p.root, Number(process.argv[3] ?? 1));
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
