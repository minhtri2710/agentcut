// Run: bun tests/ffmpeg-version.ts (no FFmpeg installation needed).
import { checkFfmpegVersion, MIN_FFMPEG_VERSION, parseFfmpegVersion } from "../src/media.ts";
import { EditError } from "../src/model.ts";
import { check, failures } from "./harness.ts";

for (const [input, expected] of [
  ["ffmpeg version 7.0.2-static https://example.com", [7, 0, 2]],
  ["ffmpeg version n8.1 Copyright", [8, 1, 0]],
  ["ffmpeg version 5.1.6-0ubuntu1 Copyright\nconfiguration: ...", [5, 1, 6]],
  ["  ffmpeg version 5.1 Copyright\r\n", [5, 1, 0]],
  ["ffmpeg version N-12345-gabc Copyright", null],
  ["ffmpeg version git-2024-01-01 Copyright", null],
  ["ffmpeg version unknown Copyright", null],
  ["ffmpeg version 5.1broken", null],
  ["", null],
] as const) check(`parse ${JSON.stringify(input)}`, JSON.stringify(parseFfmpegVersion(input)) === JSON.stringify(expected));

for (const version of ["4.4", "4.4.99", "5.0.12"]) {
  let error: unknown;
  try { checkFfmpegVersion(`ffmpeg version ${version} Copyright`); } catch (e) { error = e; }
  check(`reject ${version} with actionable error`, error instanceof EditError && error.code === "missing_dependency" &&
    error.message.includes(version) && error.message.includes(MIN_FFMPEG_VERSION) && error.hint?.includes("https://ffmpeg.org/download.html"));
}
for (const version of ["5.1", "5.1.0", "5.10", "6.0", "7.0.2-static", "n8.1", "N-12345-gabc", "unknown", ""]) {
  let allowed = true;
  try { checkFfmpegVersion(version ? `ffmpeg version ${version} Copyright` : ""); } catch { allowed = false; }
  check(`allow ${version || "empty output"}`, allowed);
}
console.log(`\nffmpeg-version: ${failures()} failures`);
process.exit(failures() ? 1 : 0);
