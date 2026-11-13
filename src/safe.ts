// Safe areas for text, in canvas px. Pure (no Skia), so the edit path (templates) and the renderer (guides, review) share one definition.

/** title = 5% inset rect; ui = social-app overlay zones on 9:16 (caption/buttons/top bar). */
export function safeZones(W: number, H: number) {
  const ui: [string, number, number, number, number][] = H > W
    ? [["top bar", 0, 0, W, H * 0.1], ["bottom caption/UI", 0, H * 0.8, W, H * 0.2], ["right-side buttons", W * 0.86, H * 0.45, W * 0.14, H * 0.35]] : [];
  return { title: [W * 0.05, H * 0.05, W * 0.9, H * 0.9] as [number, number, number, number], ui };
}

/** A `margin` value (a percent of the short side, rounded up) that keeps a box placed against all the given edges inside the title area and clear of the full-width UI bars. */
export function safeMargin(W: number, H: number, ...edges: ("top" | "bottom" | "left" | "right")[]): string {
  const z = safeZones(W, H), [x, y, w, h] = z.title;
  const inset = { top: y, bottom: H - (y + h), left: x, right: W - (x + w) };
  for (const [, ux, uy, uw, uh] of z.ui) {
    if (uw < W) continue; // a side zone does not limit a margin
    if (ux === 0 && uy === 0) inset.top = Math.max(inset.top, uh);
    if (uy + uh >= H) inset.bottom = Math.max(inset.bottom, H - uy);
  }
  return `${Math.ceil((Math.max(...edges.map((e) => inset[e])) / Math.min(W, H)) * 1e4) / 100}%`;
}
