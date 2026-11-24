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
  - (none)

  ## Not yet specified
  - UI build slices: graduate once "UI stack", "UI feature scope" and "Chat panel backend" are decided.
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

- [ ] vlab-uistack - UI stack for the full editor (kind: scout) (since 2026-11-24)
  Research. Question: what does the full editor UI build on? Today src/ui is vanilla TS bundled into one string (page.gen.ts, bun run ui) served by src/ui.ts. A media pool, library, track headers, waveforms, form inspector and chat panel is ~10x that.
  Options: stay vanilla TS + small own component helpers | adopt a framework (Preact/React/Solid) as a dependency. Criteria: bundle stays one served string, ui-browser test lane keeps working, page typecheck (src/ui tsconfig), no Bun-only APIs, reviewable size.

- [ ] vlab-uiscope - UI feature scope (parity table) (kind: scout) (since 2026-11-24)
  Research then human approval. Question: which reference-UI features make the agentcut UI, in what order?
  Input: OpenChatCut screenshots (assets/readme-pic) and src/components: media pool (thumbnails, folders, search), library (effects/transitions/looks/text presets with previews, drag to timeline), transcript panel, timeline (thumbnails, waveforms, track headers eye/mute/lock, snapping, markers), properties form inspector, export dialog, safe-area overlay, dark theme, chat panel.
  Output: a parity table (have / build / skip, with why) approved by the human, which becomes the UI slices.

- [ ] vlab-chat - Chat panel backend (human decision) blocked-by: vlab-uiscope (kind: scout) (since 2026-11-24)
  Grilling (human). Question: what powers the UI's agent chat panel?
  Options seen in OpenChatCut: direct LLM APIs with user keys (AI SDK, many providers) | drive a local agent CLI (Claude Code / Codex / Copilot) as a subprocess against agentcut's own MCP server. Also: which tools the chat agent may call, approval of its edits (OpenChatCut: draft session + human approval), and where keys live.
- [ ] vlab-face - review: text covering a face (kind: ship) (since 2026-11-24)
  Slice. review reports text and captions that cover a face: for each text/captions clip window, intersect its drawn box with the face boxes of the picture below (analyze_subject results already cached in the project; a clip with no cached analysis is not analysed by review and is listed as unchecked).
  Acceptance: a title over a cached face is a finding with time range, text id and clip id; a title beside the face is not; no vision compute runs inside review; GUIDE/AGENTS.md updated.
  Leaves out: auto-moving the text (a later op), saliency-only subjects.

- [ ] vlab-renderqa - render: QA of the written file (kind: ship) (since 2026-11-24)
  Slice. Every video render result carries a QA of the written file: probe the output and compare duration, size, fps, audio stream presence with the timeline; scan for frozen stretches (freezedetect) and black (blackdetect) in the output; findings in result.qa with times.
  Acceptance: a normal render reports qa ok; a forced mismatch (e.g. timeline with audio rendered by a path that drops it, or a still-frame stretch) is reported with times; draft renders included; cost bounded (one extra ffmpeg pass, measured).
  Leaves out: frame-sample evidence images; automatic retries.

- [ ] vlab-speech - transcribe: keep words inside speech (kind: ship) (since 2026-11-24)
  Slice. Transcription keeps only words inside detected speech: words whisper times into a gap are dropped or clamped into the nearest speech region, and the silence threshold follows the measured noise floor instead of fixed -35 dB.
  Measure first at base: a generated clip with long silences and a music lead-in, count invented/misplaced words; ship only if the count drops and real words are kept.
  Acceptance: the measured fixture improves; existing transcribe tests pass; AGENTS.md text about words timed into silence updated.
  Leaves out: neural VAD (Silero) unless the runtime decision adds it.

- [ ] vlab-rnnoise - denoise: RNNoise option after A/B (kind: ship) (since 2026-11-24)
  Slice. denoise can use FFmpeg arnndn with a pinned RNNoise model (GregorR/rnnoise-models sh.rnnn, 297646 bytes, sha256 70bb6685...dec0, public-domain dedication), downloaded only with consent like matte models; output aligned to the source (arnndn delays 480 samples at 48 kHz, drops a partial last frame: pad + atrim, measured).
  A/B first against the current two-stage afftdn on speech + noise fixtures; if it does not win, close the ticket with the numbers and ship nothing.
  Acceptance: measured win, sample-exact alignment test, consent path tested, AGENTS.md updated.

- [ ] vlab-looks - color: film-emulation looks (kind: ship) (since 2026-11-24)
  Slice. Film-emulation looks (kodak_gold, portra, velvia, cinestill, bleach_bypass, ...) as formulas in the colour grade, next to the existing look names, deterministic and render-tested.
  Acceptance: each new look renders and changes scopes stats in its expected direction; names listed in capabilities and GUIDE; no .cube files shipped.

- [ ] vlab-rvm - remove_background: RVM temporal matte blocked-by: vlab-runtime (kind: ship) (since 2026-11-24)
  Slice. remove_background gains a temporally stable video matte model: Robust Video Matting mobilenetv3 (15 MB ONNX, weights GPL-3.0, downloaded on consent, never bundled), recurrent state carried across frames, through the runtime chosen in "Inference runtime".
  Acceptance: flicker metric (mean abs alpha change between frames on a static subject) lower than u2net_human_seg on a fixture; cached and deterministic; capabilities.matte_models lists it with licence.
- [ ] vlab-separate - audio: voice/music separation blocked-by: vlab-runtime (kind: ship) (since 2026-11-24)
  Slice. A new op/analysis separates a clip's audio into voice and music stems (Spleeter 2stems ONNX, MIT weights, 2 x 39 MB, consent download), cached, usable as audio clips (e.g. duck or drop the music under captions).
  Acceptance: stems sum back to the source within a tolerance; op documented; prepare-style pending flow like vision ops.
## Done
