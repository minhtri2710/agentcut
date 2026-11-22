export const TIME_RE = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/;

export function timeValue(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return NaN;
  const s = v.trim().toLowerCase();
  if (s.endsWith("ms")) return parseFloat(s) / 1000;
  if (s.endsWith("s")) return parseFloat(s);
  const m = TIME_RE.exec(s);
  return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] : Number(s);
}

export const kfPoint = (k: any, time: (v: unknown) => number): [number, number, string | undefined] =>
  Array.isArray(k) ? [time(k[0]), Number(k[1]), k[2]] : [time(k.t ?? 0), Number(k.v ?? k.value ?? 0), k.ease];
