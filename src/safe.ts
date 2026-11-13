// Safe areas for text, in canvas px. Pure (no Skia), so the edit path (templates) and the renderer (guides, review) share one definition.

/** title = 5% inset rect; ui = social-app overlay zones on 9:16 (caption/buttons/top bar). */
export function safeZones(W: number, H: number) {
  const ui: [string, number, number, number, number][] = H > W
    ? [["top bar", 0, 0, W, H * 0.1], ["bottom caption/UI", 0, H * 0.8, W, H * 0.2], ["right-side buttons", W * 0.86, H * 0.45, W * 0.14, H * 0.35]] : [];
  return { title: [W * 0.05, H * 0.05, W * 0.9, H * 0.9] as [number, number, number, number], ui };
}

export type Edge = "top" | "bottom" | "left" | "right";

/** The edges a `position` name is anchored to ("bottom_left": bottom, left; "center": none). */
export const edgesOf = (position?: string): Edge[] => (["top", "bottom", "left", "right"] as const).filter((e) => position?.includes(e));

/** Distance in px from `edge` that keeps a box inside the title area and clear of the full-width UI bars. */
function inset(W: number, H: number, edge: Edge): number {
  const z = safeZones(W, H), [x, y, w, h] = z.title;
  let v = { top: y, bottom: H - (y + h), left: x, right: W - (x + w) }[edge];
  for (const [, ux, uy, uw, uh] of z.ui) {
    if (uw < W) continue; // a side zone does not limit a margin
    if (edge === "top" && ux === 0 && uy === 0) v = Math.max(v, uh);
    if (edge === "bottom" && uy + uh >= H) v = Math.max(v, H - uy);
  }
  return v;
}

/** A `margin` for a text placed against `edges`: at least `min` (a percent of the short side) and never inside the safe-area limits. One value for edges of one axis, "x y" (left/right, top/bottom) for both. */
export function safeMargin(W: number, H: number, edges: Edge[], min = 0): string {
  const pct = (es: Edge[]) => `${Math.ceil(Math.max(min, ...es.map((e) => (inset(W, H, e) / Math.min(W, H)) * 100)) * 100) / 100}%`;
  const xs = edges.filter((e) => e === "left" || e === "right"), ys = edges.filter((e) => e === "top" || e === "bottom");
  return xs.length && ys.length ? `${pct(xs)} ${pct(ys)}` : pct(edges);
}

/** `max_width` (a percent of the width, rounded down) of a text that starts `left` px from the left edge and whose box carries `ring` px around the wrapped text: its box ends before the title area and the side UI zones. */
export function safeWidth(W: number, H: number, left: number, ring: number): string {
  const z = safeZones(W, H), right = Math.min(z.title[0] + z.title[2], ...z.ui.filter(([, , , uw]) => uw < W).map(([, ux]) => ux));
  return `${Math.floor(((right - left - ring) / W) * 1e4) / 100}%`;
}
