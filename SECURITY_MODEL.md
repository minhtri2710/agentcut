# Security model — agentcut

Threat model used to judge security-scan findings. Facts marked *(user)* were confirmed by the maintainer; unmarked facts are inferred from the code. Keep it current when trust boundaries, roles or deployment change.

## Overview and trust boundaries
Agent-first video editor (TypeScript, Bun/Node, Skia, FFmpeg). Driven by a CLI (`src/cli.ts`) and an MCP server over **stdio** (`src/mcp.ts`), both on top of `src/api.ts`. Optional local web UI (`agentcut ui`, `src/ui.ts`) listening on `127.0.0.1:4810` with Host allowlist (127.0.0.1/localhost), Origin==Host + JSON content type on POST, `..`/NUL rejection, and `/files/` limited to `renders/` and `previews/` with realpath check.

Boundaries: AI agent / user → CLI/MCP (same OS user); browser on the same machine → UI server; project.json and imported media files → parsers (FFmpeg, Skia, Lottie JSON, SRT); app → external processes (`ffmpeg`, `say`/SAPI/espeak, `uv run` Python vision helper with model downloads gated by `allow_download`); app → HTTP TTS endpoint (`AGENTCUT_TTS_URL`/`AGENTCUT_TTS_KEY`).

## Components
| Component | Code |
|---|---|
| Edit Core | `src/api.ts`, `src/ops*.ts`, `src/model.ts`, `src/project.ts`, `src/safe-write.ts` |
| Media & Render | `src/media.ts`, `src/ffinput.ts`, `src/encode.ts`, `src/render.ts`, `src/segment-worker.ts`, `src/subtitles.ts`, `src/export.ts`, `src/captions.ts` |
| Local UI Server | `src/ui.ts`, `src/ui/**` |
| MCP & CLI | `src/mcp.ts`, `src/cli.ts`, `scripts/**` |
| External Helpers | `src/tts.ts`, `src/vision.ts`, `src/vision-py.ts`, `src/prepare.ts`, `src/feedback.ts` |

## Assets
User's local files (anything the OS user can read/write), the TTS API key, local machine integrity.

## Attackers that matter
- *(user)* AgentCut runs only on the user's own machine with the user's own projects and media; no project.json, media, SRT or Lottie file comes from an untrusted source, and the tool is not exposed to other users or the network. Attackers who supply crafted projects/media are **out of scope**.
1. A malicious web page in the user's browser attacking the local UI (DNS rebinding, CSRF, path traversal to read local files).
2. *(out of scope per user)* Untrusted inputs opened by the agent: a shared `project.json` or crafted media/SRT/Lottie — argument injection into ffmpeg, path traversal in asset paths, writes outside the project.
3. Prompt-injected agent calling ops — only relevant where an op does more than the user's own permissions already allow.
*(user)* Runs locally for one user; the MCP/CLI caller is trusted with the user's own permissions.

## Out of scope / accepted risk
- *(user)* Attackers who supply crafted projects or media (see above).

## Open questions
- Is the local UI (`agentcut ui`) ever opened while browsing untrusted sites? The malicious-web-page attacker stays in scope until answered.
