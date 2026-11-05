# AgentCut repo (TypeScript)

Agent-first video editor. Read [AGENTS.md](AGENTS.md) to *use* it; this file is for *developing* it.
`legacy/python/` is the first prototype - do not edit or use it.

- Setup: `bun install`. Run from source: `bun src/cli.ts …`, `bun src/mcp.ts` (or `scripts/ac …`).
- Check: `npx tsc --noEmit -p .` then `bun run test` (smoke, mcp, edit-ops, compound, codecs, export, ui, audio, color-tts, verify, vision, review, jobs, ui-browser, realmedia). Export roundtrip
  checks run when `AGENTCUT_OTIO_PY` (python with opentimelineio) / `AGENTCUT_FCPXML_DTD` are set.
- Build: `bun run build` -> `dist/` (Node >= 20 bundles); `bun run build -- --compile` -> `bin/agentcut` (single binary).
- Perf tools: `bun scripts/profile-frames.ts <project>`, `bun scripts/profile-layers.ts <project>`, `bun scripts/bench-ops.ts`.
- Deciding what to improve: start from `agentcut feedback summary --md` (ranked backlog from agent notes + auto-logged
  errors, guessed names, rejected batches, latency, render speed). Guessed names usually mean "add an alias" or "rename";
  mark notes done with `agentcut feedback resolve <id>`. Tests use an isolated AGENTCUT_HOME - keep it that way.
- `api.ts` is shared by `cli.ts` and `mcp.ts`: add features there once.
- New op: `op(...)` in `ops.ts` (doc + args are surfaced to agents automatically); add clip fields to the tables in
  `model.ts` (validation + schema come from them); mention it in `docs.ts` GUIDE and regenerate AGENTS.md (`bun run docs`). Pro ops live in `ops-edit.ts` / `ops-compound.ts`;
  ops that copy/split clips must keep detached audio (`linkedAudio`) and nested compound ids (`renameNested`) consistent.
- Contracts: CLI prints exactly one JSON object; errors are `EditError(message, code, hint)`; batches stay atomic and
  never save a timeline with new validation errors; renders are deterministic (effects are seeded by time).
- Performance rules: never import `@napi-rs/canvas` from the edit path (only render/text/effects; use `canvas.ts`);
  avoid Skia `imageSmoothingQuality` medium/high and `overlay`/`soft-light` full-frame blends (3-10x slower);
  cache static layers; reuse canvases (`scratch()`); keep FFmpeg doing decode/scale/filters.
- Cross-platform: node: APIs only (no Bun-only APIs in src/), pathlib-style joins, no shell strings.
