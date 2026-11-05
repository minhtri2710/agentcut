---
name: agentcut
description: Make or edit videos (reels/shorts/youtube, slideshows, promos, captions, voiceover, beat-synced montages) with the AgentCut editor via its MCP tools or the `agentcut` CLI. Use whenever the user wants a video produced, cut, captioned or exported.
---

# Making videos with AgentCut

1. Prefer the `agentcut` MCP tools if connected (they return preview images). Otherwise use the CLI
   (`agentcut ...`, JSON output). Run `agentcut guide` (or MCP `guide`) once per session.
2. Inventory inputs first: `probe_media` every file, `analyze_beats` for music, `analyze_scenes`/`analyze_silence` for footage.
   Never invent assets (logos, screens, numbers) - ask if something is missing.
3. Create the project with the right preset (reels 9:16, youtube 16:9, square, portrait).
4. Fastest start: `apply_template` (promo, slideshow, beat_montage, quote, listicle). Otherwise build in one `apply_ops`
   batch (add_sequence for montages, text with `preset` + `attach_to` the shot it belongs to, captions via add_captions,
   music on `music` with until_end). If the batch is rejected, read `error.issues[].hint`, fix, resend the whole batch.
5. LOOK before rendering: `contact_sheet` for the whole piece, `preview_frame` (guides=true for 9:16) at the hook,
   every text moment and every transition. Fix what you see (readability, safe area, cropping, timing).
6. `render` with draft=true, check the returned contact sheet + loudness (about -14 LUFS), then the final render.
7. Report the output path and what you verified; list anything a human should still review.
8. Before finishing, if anything was slow, confusing, missing or broken, send one `report_feedback` note per issue
   (CLI: `agentcut feedback add kind=... title=...`). Duplicates are merged; it is how AgentCut improves.
