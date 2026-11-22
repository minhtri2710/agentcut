// Leaf module (no imports): audiofx.ts must not import media.ts, because model.ts imports audiofx.ts.
/** Input arguments for ffmpeg and ffprobe: only local files and pipes are opened. */
export const inp = (path: string) => ["-protocol_whitelist", "file,pipe", "-i", path];
/** Decode the first non-cover-art video stream, matching probe's metadata selection. */
export const VIDEO_MAP = ["-map", "0:V:0"] as const;
