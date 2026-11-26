// Easing curves: a leaf module (only own.ts), so the page can sample a keyframe curve as the renderer does.
import { own } from "./own.ts";

const backOut = (t: number, s = 1.70158) => { t -= 1; return t * t * ((s + 1) * t + s) + 1; };
function bounceOut(t: number) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { t -= 1.5 / d; return n * t * t + 0.75; }
  if (t < 2.5 / d) { t -= 2.25 / d; return n * t * t + 0.9375; }
  t -= 2.625 / d; return n * t * t + 0.984375;
}
const elasticOut = (t: number) => (t === 0 || t === 1 ? t : 2 ** (-10 * t) * Math.sin(((t * 10 - 0.75) * 2 * Math.PI) / 3) + 1);

export const EASE: Record<string, (t: number) => number> = {
  linear: (t) => t,
  ease_in: (t) => t ** 3,
  ease_out: (t) => 1 - (1 - t) ** 3,
  ease_in_out: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  back_out: backOut, bounce_out: bounceOut, elastic_out: elasticOut,
  hold: (t) => (t < 1 ? 0 : 1),
};
export const ease = (name: string | undefined, t: number) => (own(EASE, name || "linear") ?? EASE.linear)(Math.min(1, Math.max(0, t)));
