# Backlog

## In flight
- [x] vlab-map - MAP: adopt VidLab/OpenChatCut strengths (kind: scout) (done 2026-11-25)
  ## Destination
  agentcut gains what VidLab / OpenChatCut do better (research 2026-11-24, clones of 0xsline/OpenChatCut f96502a and mkh1148/vidlab 466c9f2): text-over-face review, render QA, speech-gated transcription, RNNoise, temporal person matte, voice/music separation, film looks, and a full editor UI with an agent chat panel. Ideas only: both repos are AGPL-3.0, agentcut is MIT, no code is copied.

  ## Notes
  - Branch research/vidlab-openchatcut, one commit per ticket, no push. Checks: bun run typecheck, bun run test (per-user TMPDIR).
  - Contract changes (new op args, new fields) go in model.ts / ops.ts / docs.ts + regenerate AGENTS.md.
  - Model downloads keep the consent rule (allow_download, pinned sha256 + size).
  - Loop decode fix (PR #33, a file with sound reads each pass as its own stream) measured 2026-11-25 on a 20 s loop of a 2 s 1080p mp4 with AAC: draft render 3.4-3.6 s new vs 3.2-3.9 s old, final 5.9-6.6 s new vs 6.6-8.9 s old: no measurable cost.

  ## Decisions so far
  - UI stack: Preact (vlab-uistack).
  - UI scope: base + media/library + inspector/export + transcript/review/history + dashboard, EN/VI switch (vlab-uiscope).
  - Chat panel: local agent CLI over agentcut MCP, no API keys (vlab-chat).

  ## Out of scope
  - Copying AGPL code from either repo (licence: agentcut is MIT).
  - Cloud generation (image/video/music), social publishing, stock search: OpenChatCut features unrelated to the agent-first editor.
  - Desktop packaging (Electron-like app) of the UI: human chose 2026-11-25 to keep `agentcut ui` in a local browser.
  All tickets shipped in PR #32 (merged 68b8ae3).

## Queued
- [x] ui-templates - UI: templates in the Library (kind: ship) (done 2026-11-25)
  Slice. The Library gains a Templates section: pick a template, fill its args (media from the media pool, text fields), apply = one apply_template batch with the revision rule.
  Acceptance: every template in capabilities.templates is listed with its args; applying adds its clips in one undoable step; a missing required arg shows the validation message; ui + ui-browser checks.
  Built: template args typed in presets.ts (kind, doc, required), one generic required check in apply_template (replaces the media-only and per-template checks), capabilities.templates and the page share that table; Library > Templates opens a form per template (media from the pool, music/background pickers, item rows). Found on the way: snap_to_beats and add_captions transcribe resolved a relative path against the working directory only (add_clip also tried the project folder); all three now use the same rule. edit-ops, ui-browser and the full suite pass.
- [x] chat-clis - UI chat: more local agent CLIs (kind: ship) (done 2026-11-27)
  Slice. The chat panel can drive the agent CLIs installed here besides claude: pi, omp. Each run keeps today's guarantees: the agentcut MCP server for the open project is the only tool set (no shell, no file edits), nothing in the user's own CLI config is changed, no model keys in agentcut, stop kills the run, replies and tool calls stream.
  Acceptance: per CLI, a real run on this machine makes an MCP call and streams its reply, or the CLI is left out with the reason it cannot meet the guarantees; the panel lets the human pick among the available ones.
  Built: src/chat.ts launches claude (stream-json), pi and omp (--mode json, MCP config written under .agentcut/chat/<cli>, their own tools off); the panel shows a CLI picker when more than one is installed. Real runs here (project_info call, then a resumed second turn): claude 9.6 s / 3.7 s, pi 19.0 s / 5.9 s, omp 7.1 s / 5.4 s.
  Left out 2026-11-27 by the owner's decision: devin and agy (never verified in a real run here: devin hit its account quota, agy's sign-in expired), with the ACP client they needed. Known gap, accepted: pi starts the user's global MCP servers too, but only codemode and mcp__agentcut* tools are callable.
- [x] vlab-rvm - remove_background: RVM temporal matte (kind: ship) (done 2026-11-25)
  Slice. remove_background gains a temporally stable video matte model: Robust Video Matting mobilenetv3 (15 MB ONNX, weights GPL-3.0, downloaded on consent, never bundled), recurrent state carried across frames, through the runtime chosen in "Inference runtime".
  Acceptance: flicker metric (mean abs alpha change between frames on a static subject) lower than u2net_human_seg on a fixture; cached and deterministic; capabilities.matte_models lists it with licence.
  653e930: built (model rvm_mobilenetv3, recurrent states carried across frames, capabilities lists the GPL-3.0 licence); cached and byte-identical on recompute (real row). Not verified: the flicker comparison, since no footage of a person is available here. Run AGENTCUT_TEST_VISION=1 AGENTCUT_TEST_VISION_PERSON=<clip of a person standing still> bun tests/vision.ts to measure it (downloads u2net_human_seg, 176 MB).
  Flicker measured 2026-11-25 on an 8 s CC0 clip (Wikimedia Commons "Entrevista Maricarmen Canales - TECMTY.webm" from 60 s, cropped 300x360 to the seated speaker, not committed): mean abs alpha change per frame RVM 0.00215 vs u2net_human_seg 0.00229 (240 frames, ~6 % lower); the real row passes. Both mattes checked by eye at 4 s: full person masks, RVM keeps more hair detail. The margin is small on a talking subject.
  Static subject 2026-11-25: public-domain NASA photo "Jessica Meir full length portrait (1).jpg" as an 8 s 30 fps clip (360x480) with temporal noise (noise=alls=8:allf=t), not committed: RVM 0.000352 vs u2net_human_seg 0.000432 (240 frames, ~19 % lower); mean alpha 0.169 vs 0.173 (both cover the person).
- [x] vlab-separate - audio: voice/music separation (kind: ship) (done 2026-11-25)
  Slice. A new op/analysis separates a clip's audio into voice and music stems (Spleeter 2stems ONNX, MIT weights, 2 x 39 MB, consent download), cached, usable as audio clips (e.g. duck or drop the music under captions).
  Acceptance: stems sum back to the source within a tolerance; op documented; prepare-style pending flow like vision ops.
  b46f523: field stem + op separate_audio, prepare computes both stems once per file (models pinned to the sherpa-onnx HF commit 7001ba3, sha256 checked). Music = source - voice, so the sum is exact by construction: helper max error 2.4e-7; mixed back through the renderer the residual is under -50 dB (real row). Separation on a TTS voice + synthetic bed: voice-only input keeps 99.98 % in the voice stem, music-only input leaves the voice stem at -63 dB; ~0.1 s per 1 s of audio on this Mac. vision suite (fake + AGENTCUT_TEST_VISION=1 real rows) passes except the KCF row, which fails identically on clean HEAD.
- [x] ui-chat - UI: agent chat panel (local CLI) blocked-by: ui-shell (kind: ship) (done 2026-11-25)
  Slice. Chat panel drives a locally installed agent CLI (claude or codex, found on PATH) in non-interactive mode with agentcut's MCP server configured for the open project, streams its messages and tool calls, can stop it. The page re-reads the project after each write.
  Acceptance: a message produces a streamed reply and tool calls; stop kills the child; with no CLI found the panel says how to install one; the server keeps loopback-only and the page token rule.
  Leaves out: API-key LLM providers (rejected by the human).
  cff8d70: claude -p stream-json, agentcut MCP only, events over SSE, stop/new chat; "page token rule" read as the existing host/origin/JSON guard (no token exists in the code). Codex not supported: not installed here, so unverified. ui + ui-browser pass; one real claude run checked by hand.
- [x] ui-dashboard - UI: project dashboard blocked-by: ui-shell (kind: ship) (done 2026-11-25)
  Slice. agentcut ui on a folder that is not a project lists the projects under it with thumbnails and dates; create, open, duplicate.
  Acceptance: opening switches the page to the editor of that project; creating runs create_project.
  2a9c384: dashboard on a folder with no project; create/duplicate/open (open = that project's editor server); ui + ui-browser pass.
- [x] ui-transcript - UI: transcript panel with text-based cuts blocked-by: ui-shell (kind: ship) (done 2026-11-25)
  Slice. Transcript tab shows the words of a clip's media (transcribe, cached), click seeks; selecting words and deleting them cuts that stretch (split + remove on the clip), one batch.
  Acceptance: deleting words removes exactly their media span from the timeline; undo restores it.
  2d7048a: Transcript tab (words cached in previews/ui/transcripts), click seeks, shift-click + Cut = one remove_range (new op, shares keepSegments with remove_silence); edit-ops, ui, ui-browser pass.
- [x] ui-library - UI: library with previews blocked-by: ui-shell blocked-by: ui-media (kind: ship) (done 2026-11-25)
  Slice. Left-panel Library tab: transitions, effects, looks, text presets, caption presets, templates, each with a preview agentcut renders (cached) from a reference frame; drag onto a clip or the timeline applies it.
  Acceptance: previews are deterministic and cached; applying is one op batch; ui-browser checks.
  5316b1a: looks, effects, transitions, text and caption presets with stills cached in previews/ui/library per version; click or drag = one op; text style on a free lane = new title; ui + ui-browser pass. Templates left out: they need the user's media.
- [x] ui-inspector - UI: form inspector blocked-by: ui-shell (kind: ship) (done 2026-11-25)
  Slice. Inspector form generated from the model field tables per clip type (with ranges and enums), colour grade and audio fx controls, the JSON tab kept.
  Acceptance: a form edit is the same op the JSON edit would be; invalid values show the validation message; ui-browser checks.
  2be163b: form + JSON tabs; out-of-range shows validation message; ui + ui-browser pass.
- [x] ui-review - UI: review and history panels blocked-by: ui-shell (kind: ship) (done 2026-11-25)
  Slice. Review panel runs review and lists findings (text_over_face included) with seek and select; history panel lists undo entries with authors, undo/redo to a point.
  Acceptance: clicking a finding seeks and selects its clip; ui-browser checks.
  2e80f77: review + history tabs, steps on undo/redo. ui + ui-browser pass.
- [x] ui-export - UI: export dialog with QA blocked-by: ui-shell blocked-by: vlab-renderqa (kind: ship) (done 2026-11-25)
  Slice. Export dialog: format/codec/quality/range/subtitles, progress, and the result's qa, loudness and contact sheet.
  Acceptance: renders through the existing job API; qa issues listed with seek links.
  e0118b8: export dialog + qa list with seek. ui + ui-browser pass.
- [x] ui-timeline - UI: timeline thumbnails, waveforms, track headers blocked-by: ui-shell (kind: ship) (done 2026-11-24)
  Slice. Video/image clips show a thumbnail strip, audio clips a waveform (server endpoints computing cached thumbnails and peaks), each track a header with hide/mute/lock (track fields in model.ts if missing), badges for transitions/effects, markers on the ruler.
  Acceptance: header toggles write ops with the revision rule; thumbnails and peaks are cached and capped like previews; ui-browser checks cover toggles.
  4b1fc76: strips, waveforms (/api/peaks), fx badge, hide/mute toggles; lock split out to track-lock (needs ops-level refusal). ui + ui-browser pass.
- [x] ui-media - UI: media pool blocked-by: ui-shell (kind: ship) (done 2026-11-24)
  Slice. Left-panel Media tab: project assets with thumbnail, duration, kind; search; import by path or file drop into media/; drag onto the timeline adds a clip (add_clip with at/track).
  Acceptance: import and drag land as ops with the revision rule; ui-browser checks for drop and drag.
  d54e573: media tab, /api/upload into media/, drop to lane. ui, ui-browser (5 new rows), jobs (sweep rows), writes, launchers pass.
- [x] ui-shell - UI: Preact shell, dark theme, 4-zone layout, EN/VI switch (kind: ship) (done 2026-11-24)
  Slice. Port the page to Preact with today's features intact (viewer, timeline drag/trim, inspector JSON, keyframes, compounds, prepare consent, render, undo/redo), in a dark 4-zone layout (left panel tabs, preview, inspector, timeline) with an English/Vietnamese string table and a switch (stored per browser).
  Acceptance: every ui and ui-browser check passes unchanged in meaning; bun run ui --check passes; no string literal in components outside the table.
  Leaves out: new panels (their own slices).
  c0db8d9: Preact page, all ui + ui-browser checks pass (one row now checks focus by clip id, not node replacement), EN/VI switch with 3 browser rows, ui --check passes, page.gen.ts identical under Bun 1.4.4 and 1.4.5. Layout stays header/viewer/side/timeline: the left panel arrives with ui-media (an empty column would be decoration). preact is a devDependency (bundled into the page).
- [x] vlab-looks - color: film-emulation looks (kind: ship) (done 2026-11-24)
  Slice. Film-emulation looks (kodak_gold, portra, velvia, cinestill, bleach_bypass, ...) as formulas in the colour grade, next to the existing look names, deterministic and render-tested.
  Acceptance: each new look renders and changes scopes stats in its expected direction; names listed in capabilities and GUIDE; no .cube files shipped.
  fa2b874: six film-stock looks as grade presets (no LUT files); tests check each one's direction on a desaturated pattern.
- [x] vlab-renderqa - render: QA of the written file (kind: ship) (done 2026-11-24)
  Slice. Every video render result carries a QA of the written file: probe the output and compare duration, size, fps, audio stream presence with the timeline; scan for frozen stretches (freezedetect) and black (blackdetect) in the output; findings in result.qa with times.
  Acceptance: a normal render reports qa ok; a forced mismatch (e.g. timeline with audio rendered by a path that drops it, or a still-frame stretch) is reported with times; draft renders included; cost bounded (one extra ffmpeg pass, measured).
  Leaves out: frame-sample evidence images; automatic retries.
  d5897c9: result.qa on every video render (probe compare + freezedetect frozen_picture with clip ids). blackdetect left out: review already reports black frames with text_ids on the timeline, a second detector on the output would repeat it. Cost ~10% of render (20 s 1080x1920: 0.26 s / 2.1 s draft, 0.5 s / 4.7 s final).
- [x] vlab-face - review: text covering a face (kind: ship) (done 2026-11-24)
  Slice. review reports text and captions that cover a face: for each text/captions clip window, intersect its drawn box with the face boxes of the picture below (analyze_subject results already cached in the project; a clip with no cached analysis is not analysed by review and is listed as unchecked).
  Acceptance: a title over a cached face is a finding with time range, text id and clip id; a title beside the face is not; no vision compute runs inside review; GUIDE/AGENTS.md updated.
  Leaves out: auto-moving the text (a later op), saliency-only subjects.
  review reports text_over_face from cached subject analyses (overlap >= 25% of the smaller box); clips without one are listed in checked.faces.unchecked; tests/vision.ts covers hit, miss, unchecked
- [x] vlab-chat - Chat panel backend (human decision) blocked-by: vlab-uiscope (kind: scout) (done 2026-11-24)
  Grilling (human). Question: what powers the UI's agent chat panel?
  Options seen in OpenChatCut: direct LLM APIs with user keys (AI SDK, many providers) | drive a local agent CLI (Claude Code / Codex / Copilot) as a subprocess against agentcut's own MCP server. Also: which tools the chat agent may call, approval of its edits (OpenChatCut: draft session + human approval), and where keys live.
  Human chose 2026-11-24: drive a locally installed agent CLI (Claude Code / Codex) connected to agentcut's MCP server; no LLM keys or SDK in agentcut; edits keep the revision rule.
