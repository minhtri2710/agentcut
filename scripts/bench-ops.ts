import { createCanvas, ImageData } from "@napi-rs/canvas";
const W = 1080, H = 1920, N = 30;
const main = createCanvas(W, H), ctx = main.getContext("2d");
const src = createCanvas(W, H); src.getContext("2d").fillStyle = "#3a6"; src.getContext("2d").fillRect(0, 0, W, H);
const vid = createCanvas(1080, 608); const buf = new ImageData(new Uint8ClampedArray(1080 * 608 * 4).fill(120), 1080, 608);
const tile = createCanvas(256, 256); const pat = ctx.createPattern(tile, "repeat")!;
const tiny = createCanvas(68, 120);
function b(name: string, f: () => void) {
  ctx.fillRect(0, 0, 1, 1); ctx.getImageData(0, 0, 1, 1);
  const s = performance.now();
  for (let i = 0; i < N; i++) { f(); ctx.getImageData(0, 0, 1, 1); }
  console.log(name.padEnd(40), ((performance.now() - s) / N).toFixed(2), "ms");
}
b("baseline flush", () => {});
b("fillRect bg", () => { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); });
b("drawImage full identity", () => ctx.drawImage(src, 0, 0));
b("drawImage full scaled 1.07", () => ctx.drawImage(src, -40, -70, W * 1.075, H * 1.075));
b("drawImage full alpha .5", () => { ctx.globalAlpha = 0.5; ctx.drawImage(src, 0, 0); ctx.globalAlpha = 1; });
b("putImageData 1080x608 offscreen", () => vid.getContext("2d").putImageData(buf, 0, 0));
b("drawImage tiny->full smooth", () => ctx.drawImage(tiny, 0, 0, W, H));
b("grain overlay pattern", () => { ctx.save(); ctx.globalAlpha = .3; ctx.globalCompositeOperation = "overlay"; ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H); ctx.restore(); });
b("grain soft-light", () => { ctx.save(); ctx.globalAlpha = .3; ctx.globalCompositeOperation = "soft-light"; ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H); ctx.restore(); });
b("grain source-over", () => { ctx.save(); ctx.globalAlpha = .08; ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H); ctx.restore(); });
b("vignette radial source-atop", () => { const g = ctx.createRadialGradient(W/2,H/2,600,W/2,H/2,1100); g.addColorStop(0,"rgba(0,0,0,0)"); g.addColorStop(1,"rgba(0,0,0,.4)"); ctx.save(); ctx.globalCompositeOperation="source-atop"; ctx.fillStyle=g; ctx.fillRect(0,0,W,H); ctx.restore(); });
b("vignette radial source-over", () => { const g = ctx.createRadialGradient(W/2,H/2,600,W/2,H/2,1100); g.addColorStop(0,"rgba(0,0,0,0)"); g.addColorStop(1,"rgba(0,0,0,.4)"); ctx.fillStyle=g; ctx.fillRect(0,0,W,H); });
b("getImageData full", () => ctx.getImageData(0, 0, W, H));
for (const q of ["low", "medium", "high"]) {
  b(`scaled 1.07 quality=${q}`, () => { (ctx as any).imageSmoothingQuality = q; ctx.drawImage(src, -40, -70, W * 1.075, H * 1.075); });
  b(`tiny->full quality=${q}`, () => { (ctx as any).imageSmoothingQuality = q; ctx.drawImage(tiny, 0, 0, W, H); });
}
