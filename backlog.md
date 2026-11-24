# Backlog

## In flight
- [ ] vlab-map - MAP: adopt VidLab/OpenChatCut strengths (kind: scout) (since 2026-11-24)
  ## Destination
  agentcut gains what VidLab / OpenChatCut do better (research 2026-11-24, clones of 0xsline/OpenChatCut f96502a and mkh1148/vidlab 466c9f2): text-over-face review, render QA, speech-gated transcription, RNNoise, temporal person matte, voice/music separation, film looks, and a full editor UI with an agent chat panel. Ideas only: both repos are AGPL-3.0, agentcut is MIT, no code is copied.

  ## Notes
  - Branch research/vidlab-openchatcut, one commit per ticket, no push. Checks: bun run typecheck, bun run test (per-user TMPDIR).
  - Contract changes (new op args, new fields) go in model.ts / ops.ts / docs.ts + regenerate AGENTS.md.
  - Model downloads keep the consent rule (allow_download, pinned sha256 + size).

  ## Decisions so far
  - UI stack: Preact (vlab-uistack).
  - UI scope: base + media/library + inspector/export + transcript/review/history + dashboard, EN/VI switch (vlab-uiscope).
  - Chat panel: local agent CLI over agentcut MCP, no API keys (vlab-chat).

  ## Not yet specified
  - Desktop packaging (Electron-like app) of the UI: unclear whether wanted.

  ## Out of scope
  - Copying AGPL code from either repo (licence: agentcut is MIT).
  - Cloud generation (image/video/music), social publishing, stock search: OpenChatCut features unrelated to the agent-first editor.

## Queued
- [ ] vlab-runtime - Inference runtime: Python/uv vs onnxruntime-node vs wasm (kind: scout) (since 2026-11-24)
  Research. Question: which runtime runs agentcut's ONNX models long-term (YuNet face, saliency, tracker, u2net mattes, and new RVM + Spleeter)?
  Options: keep the uv/Python helper (vision-py.ts) | onnxruntime-node native addon (VidLab) | onnxruntime-web wasm in Node.
  Criteria: single binary (bun build --compile) and npm dist (Node >= 22), install size, macOS/Linux/Windows, speed per frame, first-run network needs, the CSRT tracker (no ONNX form; OpenCV TrackerNano/TrackerVit use ONNX models), determinism of cached results, one implementation path (no dual runtime).
  Output: a decision with measurements, plus the migration slices if it changes.

- [ ] vlab-speech - transcribe: keep words inside speech (kind: ship) (since 2026-11-24)
  Slice. Transcription keeps only words inside detected speech: words whisper times into a gap are dropped or clamped into the nearest speech region, and the silence threshold follows the measured noise floor instead of fixed -35 dB.
  Measure first at base: a generated clip with long silences and a music lead-in, count invented/misplaced words; ship only if the count drops and real words are kept.
  Acceptance: the measured fixture improves; existing transcribe tests pass; AGENTS.md text about words timed into silence updated.
  Leaves out: neural VAD (Silero) unless the runtime decision adds it.

- [ ] vlab-rnnoise - denoise: RNNoise option after A/B (kind: ship) (since 2026-11-24)
  Slice. denoise can use FFmpeg arnndn with a pinned RNNoise model (GregorR/rnnoise-models sh.rnnn, 297646 bytes, sha256 70bb6685...dec0, public-domain dedication), downloaded only with consent like matte models; output aligned to the source (arnndn delays 480 samples at 48 kHz, drops a partial last frame: pad + atrim, measured).
  A/B first against the current two-stage afftdn on speech + noise fixtures; if it does not win, close the ticket with the numbers and ship nothing.
  Acceptance: measured win, sample-exact alignment test, consent path tested, AGENTS.md updated.

- [ ] vlab-rvm - remove_background: RVM temporal matte blocked-by: vlab-runtime (kind: ship) (since 2026-11-24)
  Slice. remove_background gains a temporally stable video matte model: Robust Video Matting mobilenetv3 (15 MB ONNX, weights GPL-3.0, downloaded on consent, never bundled), recurrent state carried across frames, through the runtime chosen in "Inference runtime".
  Acceptance: flicker metric (mean abs alpha change between frames on a static subject) lower than u2net_human_seg on a fixture; cached and deterministic; capabilities.matte_models lists it with licence.
- [ ] vlab-separate - audio: voice/music separation blocked-by: vlab-runtime (kind: ship) (since 2026-11-24)
  Slice. A new op/analysis separates a clip's audio into voice and music stems (Spleeter 2stems ONNX, MIT weights, 2 x 39 MB, consent download), cached, usable as audio clips (e.g. duck or drop the music under captions).
  Acceptance: stems sum back to the source within a tolerance; op documented; prepare-style pending flow like vision ops.
- [ ] ui-library - UI: library with previews blocked-by: ui-shell blocked-by: ui-media (kind: ship) (since 2026-11-24)
  Slice. Left-panel Library tab: transitions, effects, looks, text presets, caption presets, templates, each with a preview agentcut renders (cached) from a reference frame; drag onto a clip or the timeline applies it.
  Acceptance: previews are deterministic and cached; applying is one op batch; ui-browser checks.
- [ ] ui-transcript - UI: transcript panel with text-based cuts blocked-by: ui-shell (kind: ship) (since 2026-11-24)
  Slice. Transcript tab shows the words of a clip's media (transcribe, cached), click seeks; selecting words and deleting them cuts that stretch (split + remove on the clip), one batch.
  Acceptance: deleting words removes exactly their media span from the timeline; undo restores it.
- [ ] ui-dashboard - UI: project dashboard blocked-by: ui-shell (kind: ship) (since 2026-11-24)
  Slice. agentcut ui on a folder that is not a project lists the projects under it with thumbnails and dates; create, open, duplicate.
  Acceptance: opening switches the page to the editor of that project; creating runs create_project.
- [ ] ui-chat - UI: agent chat panel (local CLI) blocked-by: ui-shell (kind: ship) (since 2026-11-24)
  Slice. Chat panel drives a locally installed agent CLI (claude or codex, found on PATH) in non-interactive mode with agentcut's MCP server configured for the open project, streams its messages and tool calls, can stop it. The page re-reads the project after each write.
  Acceptance: a message produces a streamed reply and tool calls; stop kills the child; with no CLI found the panel says how to install one; the server keeps loopback-only and the page token rule.
  Leaves out: API-key LLM providers (rejected by the human).
- [ ] track-lock - Track lock that ops respect (kind: ship) (since 2026-11-24)
  Split out of ui-timeline. A track lock only the page honours would be a fake lock: agents edit the same project. Slice: a 'locked' track field (model.ts TRACK_FIELDS); every op that changes a clip on a locked track (or moves one onto it) refuses with code 'locked' naming the track and update_track locked=false as the fix; update_track/remove_track stay allowed. The page shows a lock toggle in the track header and greys locked lanes. Acceptance: edit-ops rows for refusal per op family; ui-browser row for the toggle; GUIDE + AGENTS.md.
## Done
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
