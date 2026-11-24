// What the page reads from /api/state, /api/ops and the job events. Imports nothing, so it typechecks in the page program (DOM, no node)
// and in the root program (node, no DOM).
export type Dict = Record<string, any>;
export type Op = Dict;
export type Clip = { id: string; type: string; [field: string]: any };
export type Track = { id: string; kind?: string; magnetic?: boolean; muted?: boolean; hidden?: boolean; locked?: boolean; clips: Clip[] };
export type Asset = { kind: string; path?: string; duration?: number };
export type Timeline = {
  name?: string;
  settings: { width: number; height: number; fps: number };
  tracks: Track[];
  assets: Record<string, Asset>;
  markers?: { t: number | string; label?: string }[];
};
export type HistoryEntry = { label?: string; author?: string };
export type State = {
  revision: number;
  duration: number;
  errors?: number;
  warnings?: number;
  timeline: Timeline;
  history: { undo: HistoryEntry[]; redo: HistoryEntry[] };
};
export type ApiError = {
  code?: string;
  message?: string;
  hint?: string;
  issues?: { path: string; message: string; hint?: string }[];
  models?: { model: string; approx_mb: number }[];
};
export type Download = { model: string; bytes: number; total_bytes: number };
export type Job = {
  id: string;
  kind?: string;
  status: string;
  progress: number;
  url?: string;
  sheet_url?: string;
  error?: ApiError;
  download?: Download;
  result?: Dict;
};
