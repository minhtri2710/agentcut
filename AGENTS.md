# AgentCut — guide for AI agents

AgentCut is a video editor you drive with JSON (CapCut/Final Cut feature set, no GUI). A project is a folder with
project.json (the timeline). Edit it with atomic **ops**, LOOK at it with **preview frames / contact sheets**, export with
**render**. Every CLI command prints exactly one JSON object; nothing is interactive.

## Mental model
- Canvas: settings.width x height @ fps. Presets: reels/tiktok/shorts 1080x1920, youtube 1920x1080, square, portrait 1080x1350, 4k.
- Tracks are layers: tracks[0] is drawn first (BOTTOM); later tracks draw ON TOP. Audio tracks are not drawn.
- Default tracks: main (magnetic) · overlay · text · voice (audio, role=voice) · music (audio, ducks -20 dB under voice).
- Magnetic track (Final Cut primary storyline): clips play back-to-back in list order, start is computed; a clip's
  transition overlaps it with the previous clip. Reorder with move_clip index. gap clips = pauses.
- Other tracks: explicit start ('at' when adding: seconds, "end", "end-2"). Overlaps are fine (later on top).
- Clip types: video · image · text · captions · shape · color (solid/gradient) · lottie · audio · gap · compound (nested tracks).
- Times: 2.5, "2.5s", "1500ms", "00:02.5". Lengths: px or "10%". Colours: "#RRGGBB[AA]", rgba(), basic names.
- until_end: true makes a clip last to the end of everything else (music bed, watermark) - it follows later edits; a clip whose length follows it (match_duration) counts only at its minimum length, and clips that move with it not at all; an explicit length edit of that clip (split, trim, roll, slide, duration) ends the stretch.
- Connected clips (Final Cut): attach_to "vid3" (or "main#2" = 3rd clip of main, "main#-1" = last) + offset (+ match_duration,
  end_offset) pins a title/overlay to a clip: retiming (snap_to_beats, trims, reorders) keeps it in sync; removing the
  clip removes what is attached. PREFER this over absolute 'at' for anything that belongs to a specific shot.
  Ops that place an attached clip (move_clip, trim_clip trim_start, update_clip start, add_transition) change its offset, so it lands
  where asked and stays attached; a magnetic track refuses an attached clip (attached_magnetic): update_clip attach_to=null first.
  A clip cannot attach to itself or into a cycle (validation error).
- Length that follows a clip: match_duration "voice#-1" (a clip id or track#n) sets duration = that clip's duration - end_offset
  (negative holds longer), keeps the start (so it works on the magnetic main track) and follows later changes to that clip.
  Removing the followed clip keeps the length as a plain number; splitting a follower keeps both halves' lengths. A clip whose length
  is computed (match_duration a clip, or true with attach_to) refuses duration edits (code computed_duration): change end_offset,
  or set match_duration null first.

## Fastest path: templates
{"op":"apply_template","name":"promo","media":["/abs/a.mp4","/abs/b.jpg","/abs/c.mp4"],"hook":"Ra mắt sản phẩm","points":["Nhẹ hơn 30%","Pin 2 ngày"],"cta":"Mua ngay","music":"/abs/song.mp3"}
Templates: slideshow, promo, beat_montage, quote, listicle (args: capabilities.templates). They expand into normal clips -> keep editing.
capabilities.engines says which transcription, TTS and vision engines are usable now.

## Workflow that works
1. create_project (CLI: agentcut init DIR --preset reels).
2. probe_media / analyze_beats / analyze_scenes / analyze_silence (/ analyze_subject) your inputs - know durations first.
3. Build in ONE apply_ops batch (atomic: a batch that would create validation errors is rejected, nothing changes).
4. LOOK (previews are JPEG, ~0.1 s per frame): contact_sheet (whole video) + preview_frame at the hook, every text, every transition (guides=true for 9:16).
   Judge pixels, not intentions: readable? inside safe area? cropped? on the beat?
   Colour: scopes t (CLI: agentcut scopes 2.5) = waveform + vectorscope + histogram + stats (luma avg ~0.4-0.6, p90 < 0.95 = no
   clipping; cast u/v ~0 = neutral) - grade until the numbers agree with your eyes.
   CHECK what stills can't show (CLI: agentcut review | audio | motion):
   review        editorial lint with times: text outside the safe area / under 9:16 app UI, text too short to read,
                 shots too short/long, cuts off the beat (beats='music' or a list), black frames, validation warnings
   audio_check   image of every track's waveform + the rendered mix (+ spectrogram) with clip boundaries and markers;
                 findings: clipping/overs, true peak, long silences, audio cut off without fade, music not ducked under voice
   motion_strip  10 consecutive frames per transition (or start/end for any animation) to judge motion
5. render draft=true first, then final. The result has has_audio, a contact sheet (previews/render-<name>-<time>.sheet.jpg) + loudness (~ -14 LUFS). A timeline with no audible clip renders without an audio track (has_audio false, a warning, no loudness). Re-render a section with start/end.
   Output by extension: .mp4 (codec h264|hevc), .mov (ProRes; transparent background "#00000000" -> ProRes 4444 with alpha),
   .webm (VP9, alpha ok), .gif, or audio only .wav/.mp3/.m4a/.flac,
   or one still frame at start as .png/.webp (alpha kept with a transparent background; webp lossless at quality=high; no end, sheet or loudness). Check result.warnings.
   Hand-off to a human editor: export_timeline (CLI: agentcut export -o edit.fcpxml | edit.otio):
   cuts, in-points, crossfades,
   constant speed, volume, titles and connected clips carry over (media linked by absolute path); effects, looks, keyframes,
   masks, captions, shapes, and vision requests not yet prepared (type "pending") are listed in result.skipped - tell the human
   what is left to finish.
6. Fix with update_clip / trim_clip / undo.

## Ops cheat-sheet
{"op":"add_clip","track":"main","src":"/abs/clip.mp4","in":2,"duration":4,"transition":"crossfade"}
{"op":"add_clip","track":"main","src":"/abs/wide.mp4","fit":"blur"}                      landscape in 9:16 with blurred background
{"op":"add_clip","track":"main","src":"/abs/photo.jpg","duration":3,"motion":"ken_burns","transition":{"type":"zoom_blur","duration":0.4}}
{"op":"add_clip","track":"text","text":"HOOK","at":0.3,"duration":2.5,"preset":"title_bold","position":"top","margin":"14%"}
{"op":"add_clip","track":"text","text":"Sale 30%","attach_to":"main#2","offset":0.2,"match_duration":true,"preset":"subtitle_box","y":"62%"}
{"op":"update_clip","id":"img2","match_duration":"voice#-1","end_offset":-0.3}                   img2 lasts as long as the last voice clip, plus 0.3 s
{"op":"add_clip","track":"text","text":"🔥 HOT","at":1,"duration":2,"preset":"sticker","position":"top_right"}      emoji ok
{"op":"add_clip","track":"overlay","src":"/abs/logo.png","until_end":true,"size":["18%","18%"],"fit":"contain","position":"top_right"}
{"op":"add_clip","track":"overlay","src":"/abs/face.mp4","at":3,"duration":5,"size":[420,420],"mask":{"shape":"circle","feather":6},"position":"bottom_left","shadow":true,"border":{"color":"white","width":6}}
{"op":"add_clip","track":"overlay","src":"/abs/anim.json","at":1,"duration":3,"size":["40%","40%"]}         Lottie
{"op":"add_clip","track":"music","src":"/abs/song.mp3","until_end":true,"fade_out":1.5}
{"op":"add_sequence","track":"main","items":["/a.jpg","/b.jpg"],"defaults":{"duration":2,"transition":"crossfade","motion":"ken_burns"}}
{"op":"add_captions","words":[{"text":"Hello","start":0,"end":0.4}],"preset":"tiktok"}       or "srt":"/abs/subs.srt" / "transcribe":"/abs/talk.mp4"
   "transcribe_range":[start,end] (seconds of the media) transcribes only that stretch: pass the speech only, since whisper may invent text
   over a long music-only stretch and times words early after a music lead-in; analyze_silence or the voiceover's length gives the span
{"op":"add_voiceover","text":"Xin chào các bạn","voice":"Linh","captions":"tiktok"}
   voice picks the TTS provider: "Linh" (OS voice) | "piper" / "piper:/abs/vi.onnx" (env AGENTCUT_PIPER_MODEL) |
   "openai:nova" (OpenAI-compatible /v1/audio/speech: env AGENTCUT_TTS_URL, AGENTCUT_TTS_KEY, AGENTCUT_TTS_MODEL); default
   provider env AGENTCUT_TTS_PROVIDER. list_voices shows which providers are available. Each sentence is synthesized separately
   (openai: one request per sentence), so captions follow the real sentence timing.
   Outside the timeline: tts (CLI: agentcut tts "text" -o out.wav [--voice V] [--rate WPM]) writes the speech to a file; transcribe (CLI: agentcut transcribe F
   [--language L] [--model M] [--start S --end S]) returns word timings, of one stretch of the media when start or end is given (start defaults to 0, end to the media end).
{"op":"update_clip","id":"vid1","set":{"color":{"look":"teal_orange","exposure":0.3,"temperature":-0.2,"vibrance":0.4}}}
{"op":"update_clip","id":"vid2","set":{"color":{"lift":[0,0,0.05],"gain":[0.05,0,-0.03],"curves":{"master":[[0,0.03],[0.5,0.55],[1,1]]},"hsl":{"blues":{"saturation":-0.3}}}}}
{"op":"snap_to_beats","track":"main","beats":"/abs/song.mp3","every":2}
{"op":"remove_silence","id":"vid1"}      {"op":"freeze_frame","id":"vid1","at":3.2,"duration":1.5}
{"op":"update_clip","id":"vid2","set":{"reverse":true}}     {"op":"update_clip","id":"vid2","set":{"speed":2}}
{"op":"set_keyframes","id":"vid3","prop":"speed","keyframes":[[0,1],[1,0.25,"ease_in_out"],[2,3]]}   speed ramp
{"op":"set_keyframes","id":"img2","prop":"scale","keyframes":[[0,1],[3,1.2,"ease_in_out"]]}
{"op":"add_effect","id":"vid1","type":"glitch","start":0,"duration":0.5}    {"op":"add_effect","type":"letterbox"}  (no id = whole video)
{"op":"trim_clip","id":"vid1","trim_start":0.5}  {"op":"split_clip","id":"vid1","at":4.2}  {"op":"move_clip","id":"vid3","index":0}
{"op":"add_transition","to":"vid2","type":"dip_black","duration":0.6}  {"op":"set_settings","preset":"reels"}

## Pro editing (Final Cut style)
{"op":"detach_audio","id":"vid2"}                  video audio -> its own clip on the 'dialogue' track, connected (stays in sync)
{"op":"attach_audio","id":"vid2"}                  the reverse: sound and its processing back on the video (refused with the field named if a J/L-cut or slip moved it)
{"op":"j_cut","id":"main#1","seconds":0.8}         B's audio starts 0.8 s before its picture (auto-detaches)
{"op":"l_cut","id":"main#0","seconds":1,"crossfade":0.3}   A's audio runs 1 s over B
  -> check result.under (clips still audible underneath) and fade/lower them. split_clip/trim_clip keep detached audio in sync.
  Splitting the detached audio clip leaves a video with several audio pieces: split_clip and duplicate_clip on the video handle every piece; the other ops that follow the audio refuse it (audio_pieces), so edit a piece by its id.
{"op":"slip_clip","id":"vid2","by":0.5}            different part of the source, same place on the timeline
{"op":"roll_edit","id":"vid1","by":-0.3}           move the cut between vid1 and the next clip (total length unchanged)
{"op":"slide_clip","id":"vid2","by":0.4}           move a clip between its neighbours (they absorb it)
{"op":"make_compound","ids":["main#1","main#2","txt1"],"name":"intro"}   group clips into ONE compound clip (move/trim/fade/mask/effects as a unit)
{"op":"expand_compound","id":"cmp1"}                put the clips back (each placed clip/gap gets group {id:"cmp1",name,track}); the compound's volume/muted/enabled go to its clips; effects, opacity and other layer fields (also until_end, pending, a transition off a storyline or with nothing back on it) are refused (layer_properties: clear them first)
{"op":"make_compound","from":"cmp1"}                regroup: takes every clip/gap stamped group.id "cmp1" (also after split_clip), same id + name, clears the stamps; rebuild inner groups before outer ones (inner_expanded); a rebuilt inner compound rejoins its outer group (group.parent)
  -> magnetic-track clips must be contiguous; the first id picks the track. Nested clips can't be edited by id: expand, edit,
     regroup (from, not ids; duplicate_clip drops the stamp). Nested audio is mixed (compound volume/muted apply) at compound speed 1.
     Nested captions are exported as subtitles (export_captions, render subtitles=true) at compound speed 1 only; validate warns on a retimed compound that holds audio or captions.

## Audio (pro)
Clip fields (video/audio): denoise true|0..1 · eq "voice_clarity"|"low_cut"|"de_ess" or bands [{type:"high_pass",f:80},{type:"peak",f:3000,gain:3,q:1},
low_pass, low_shelf, high_shelf, de_ess] · compressor "voice"|"music"|"gentle" or {type,threshold,ratio,attack,release,makeup,knee}
· pan -1..1 · pitch semitones -12..12 (duration unchanged; formants shift with it: large shifts sound chipmunk/giant) · normalize true (-16 LUFS) | LUFS. The final mix is still loudness-normalised
(settings.loudness, -14) after all of this.
{"op":"enhance_voice","track":"voice"}             denoise + high-pass + voice EQ + de-ess + compressor + normalize for every clip on the track
{"op":"enhance_voice","id":"main#0","strength":0.8}  one clip (a video with detached audio enhances its audio clip)
{"op":"update_track","id":"music","set":{"eq":"low_cut","compressor":"music","pan":-0.2}}   track = bus: eq/compressor/pan process the
  track mix once; denoise/normalize/pitch on a track apply to each of its clips that does not set its own.
Subtitles: export_captions (CLI: agentcut captions -o subs.srt | subs.vtt) writes the captions clips in timeline time;
  render subtitles=true (CLI --subtitles) adds a soft subtitle track to .mp4/.mov (mov_text), .mkv (srt), .webm (webvtt).

## AI vision (optional: needs uv, packages download on first use; results cached in .agentcut/cache)
{"op":"auto_reframe","id":"vid1","smooth":0.8}     16:9 shot in 9:16: smoothed keyframes.focus_x/focus_y (the source point kept at the view centre) follow the face (YuNet, with a confidence score), else the most salient region
{"op":"remove_background","id":"vid2","model":"u2net_human_seg"}   alpha matte (cached, deterministic); off=true removes it
{"op":"track_to","id":"txt1","target":"vid1","box":[400,600,200,200],"at":2}   overlay follows the object in the box
  (canvas px at timeline time 'at'; read it off preview_frame); no box = follow the subject. Writes keyframes x/y + attach_to.
  -> targets must have a static layout (no position/rotation/motion/speed ramp); without uv you get code missing_dependency.
  -> a model (a matte model, or the 0.23 MB face model that subject analysis, auto_reframe and track_to without box use) is downloaded only on
     request: prepare fails with code model_not_cached until the model is in <user cache>/models (~/.cache/agentcut/models, or AGENTCUT_CACHE)
     or you run prepare with allow_download=true (CLI: prepare --allow-download; analyze_subject takes allow_download too, CLI: subject --allow-download);
     capabilities.matte_models, engines.vision.face_model and prepare --status (models_to_download) list the sizes (null = not known offline) and what is cached.
  -> analyze_subject with a project open (project arg, the one MCP remembered, or CLI -p / $AGENTCUT_PROJECT / the nearest project.json) caches its result in that project;
     auto_reframe on a clip covering the same range at the same fps reuses it (no pending, nothing to prepare). With no project it caches in the user cache. A named project that is not one fails with no_project (MCP: the project arg or the remembered project; CLI: -p / $AGENTCUT_PROJECT).
  -> auto_reframe, track_to without box and analyze_subject say what they followed: subject = face|saliency|mixed|none, and warnings when it may be wrong
     (no face found, low confidence, several faces); read them and check the framing with preview_frame.
  -> AgentCut runs onnxruntime children (the vision helper and piper) with ORT_DISABLE_TELEMETRY=1 (onnxruntime may otherwise send usage telemetry).
  uv runs with --no-config: set UV_* env vars (e.g. UV_INDEX_URL) for index settings.
These ops are instant: they record the request (clip.pending; result pending=true, prepare_needed=true). Then run
  prepare (CLI: agentcut prepare [--status]; MCP: prepare -> job_id, poll render_status for progress): it computes the mattes /
  tracks (seconds per clip; cached by file hash + params) and writes the keyframes. Until then preview/video render fail fast with
  code not_prepared (details list what is missing; audio-only renders skip it) - they never compute. A repeated op on cached analysis applies at once.
Cache: agentcut cache [info] | cache prune [--max-mb N] [--older-than 7d] (MCP: cache) covers .agentcut/cache + previews/;
  prune deletes unreferenced files first (max_mb also referenced ones: prepare rebuilds them). previews/ is capped
  automatically at AGENTCUT_PREVIEWS_MAX_MB (200; 0 = off), oldest first.

## Vocabulary
- transitions: crossfade, dip_black, dip_white, flash, glitch, zoom, zoom_blur, spin, circle, blur, slide_*, push_*, wipe_*
- enter/exit: fade, pop, bounce, flip, slide_*, zoom_in, zoom_out, wipe_*, blur, drop, spin, typewriter (text), words (text)
- motion: ken_burns, ken_burns_out, zoom_slow, pan_left/right/up/down, pulse, float, sway, shake
- effects (clip or whole video, optional start/duration window; flash: at + duration): glitch, rgb_split, flash, grain, zoom_blur, vignette, vhs, letterbox, strobe, blur, bw, invert, hue, brightness, contrast, saturate
- color (grade, video/image): look (cinematic|warm|cool|vintage|bw|vivid|fade|teal_orange|moody|pastel) as a base, exposure (stops),
  contrast, saturation, vibrance, temperature/tint (-1..1), lift/gamma/gain [r,g,b] -1..1, curves {master|r|g|b: [[x,y],..]},
  hsl {reds|yellows|greens|cyans|blues|magentas|all: {hue, saturation, lightness}}
- filters (decode-time, video/image, before color): eq, lut (.cube), chromakey, stabilize, denoise, sharpen, vignette, blur, grayscale, hflip, vflip
- masks: rect, circle, ellipse, heart, star, linear, mirror (+ feather, invert, x, y, width, height, angle)
- layout: position+margin or x/y (centre); fit cover|contain|fill|none|blur; size [w,h]; focus [fx,fy] (the source point, 0..1 after crop, kept at the centre of the view; clamped at the picture edges; [0.5,0.5] = centre); radius; border; shadow; blend; opacity
- text: preset, font (agentcut fonts), font_size, weight, italic, color, gradient, stroke, glow, shadow, background, max_width, align, uppercase, letter_spacing
- text presets: title_bold, subtitle_box, neon, gradient, lower_third, quote, typewriter, sticker, outline, cinematic
- caption presets: tiktok, bold_pop, pill, clean, reveal, neon (styles: karaoke | word | reveal | line)
- keyframes: x y scale scale_x scale_y rotation opacity blur volume speed (speed ramps only on video clips, whose sound follows the ramp and changes pitch with it; every speed value is 0.1..8, and back_out/elastic_out are refused on a speed ramp only where the curve leaves that range; a ramp sets the speed, so `speed` must be 1 or absent; a video with detached audio cannot ramp: attach_audio first; an audio, compound or lottie clip takes a constant `speed`) focus_x focus_y; easings linear ease_in ease_out ease_in_out back_out bounce_out elastic_out hold

## Rules of thumb
- Hook in the first 1-2 s. Cut on beats. Shots 1-3 s for social. One idea per text card, >= 64 px.
- 9:16: keep text out of the top 10% and bottom 20% (preview with guides). Use fit "blur" for landscape footage.
- Never invent logos/screens/metrics: only use files you were given; a missing asset is a blocker - ask.
- "Done" needs evidence: a contact sheet or frame you looked at + the render result JSON.
- The project folder must be on a volume with hard links (APFS, NTFS, ext4; not exFAT or FAT): project.json and the lock need them, and error unsupported_fs says so. Media files may stay on any volume.

## Working alongside a human (agentcut ui)
- `agentcut ui [DIR] [--port 4810]` serves a local web UI on 127.0.0.1 (timeline, viewer, inspector, keyframe
  editor, compound open/expand/regroup, prepare, render). The human's edits land in the same project.json, so re-read (info /
  project_info) before planning more edits. UI previews (sheets, play drafts) live in previews/ui/, capped (oldest dropped).
  The UI's Prepare downloads a missing vision model only after the human confirms it in a dialog.
- project.json has a "revision" that goes up by 1 on every save. Pass the revision you read: --revision N (CLI) or revision (MCP
  apply_ops/undo/redo). If someone saved meanwhile you get code "conflict" and nothing changes: reload, then redo your edit.
  Without a revision the batch is applied to the latest state. A replace_timeline whose timeline carries a "revision" other than the project's is refused the same way.

## Help improve AgentCut (please do this)
Whenever AgentCut slows you down - a name you guessed that does not exist, a feature you had to work around, something
slow, unclear docs, an error whose hint did not help, or output that looked wrong - send ONE short note:
  MCP: report_feedback {kind, title, details?, area?, severity?, suggestion?}
  CLI: agentcut feedback add kind=missing_feature title="no op to detach audio" suggestion="detach_audio op"
kinds: bug, missing_feature, friction, performance, docs, idea, praise. Duplicates are merged and counted.
Errors, guessed names, rejected batches and slow calls are logged automatically (locally, ~/.agentcut/feedback);
your note adds the WHY. Maintainers read the ranked backlog with feedback_summary / agentcut feedback summary --md.

## Errors
{"ok":false,"error":{"code","message","hint","path","issues?"}} - hints usually contain the fix ("did you mean 'crossfade'?").
