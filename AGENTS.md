# AgentCut — guide for AI agents

AgentCut is a video editor you drive with JSON (CapCut/Final Cut feature set, no GUI). A project is a folder with
project.json (the timeline). Edit it with atomic **ops**, LOOK at it with **preview frames / contact sheets**, export with
**render**. Every CLI command prints exactly one JSON object; nothing is interactive.

## Mental model
- Canvas: settings.width x height @ fps. Presets: reels/tiktok/shorts 1080x1920, youtube 1920x1080, square, portrait 1080x1350, 4k.
- Tracks are layers: tracks[0] is drawn first (BOTTOM); later tracks draw ON TOP. Audio tracks are not drawn. A track with locked: true (a human locks it in the UI) refuses every op that would change, add or remove its clips (code locked); its computed starts and lengths still follow other edits. Leave it alone unless asked: update_track set={locked: false} unlocks it.
- Default tracks: main (magnetic) · overlay · text · voice (audio, role=voice) · music (audio, ducks -20 dB under voice).
- Magnetic track (Final Cut primary storyline): clips play back-to-back in list order, start is computed; a clip's
  transition overlaps it with the previous clip. Reorder with move_clip index. gap clips = pauses.
- Other tracks: explicit start ('at' when adding: seconds, "end", "end-2"). Overlaps are fine (later on top).
- Clip types: video · image · text · captions · shape · color (solid/gradient) · lottie · audio · gap · compound (nested tracks).
- Times: 2.5, "2.5s", "1500ms", "00:02.5". Lengths: px or "10%". Colours: "#RRGGBB[AA]", rgba(), basic names.
- until_end: true makes a clip last to the end of everything else (music bed, watermark) - it follows later edits; a clip whose length follows it (match_duration) counts only at its minimum length, and clips that move with it not at all; an explicit length edit of that clip (split, trim, roll, slide, duration) ends the stretch. end_at: "<clip id>" (not on a magnetic track) makes a clip end where that clip starts and follow it (a music bed handing over to the next section's song); the same edits end it; a clip whose length follows it must not be on a magnetic track.
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
Templates: slideshow, promo, beat_montage, quote, listicle (args: capabilities.templates). They expand into normal clips -> keep editing. On a timeline with clips a template adds a section after the end of main.
capabilities.engines says which transcription, TTS and vision engines are usable now.

## Workflow that works
1. create_project (CLI: agentcut init DIR --preset reels). The result's "revision" is 0: your first write passes it (--revision 0 / revision 0); every write returns the next one.
2. probe_media / analyze_beats / analyze_scenes / analyze_silence (/ analyze_subject) your inputs - know durations first.
3. Build in ONE apply_ops batch (atomic: a batch that would create validation errors is rejected, nothing changes).
4. LOOK (previews are JPEG, ~0.1 s per frame): contact_sheet (whole video) + preview_frame at the hook, every text, every transition (guides=true for 9:16).
   Judge pixels, not intentions: readable? inside safe area? cropped? on the beat?
   Colour: scopes t (CLI: agentcut scopes 2.5) = waveform + vectorscope + histogram + stats (luma avg ~0.4-0.6, p90 < 0.95 = no
   clipping; cast u/v ~0 = neutral) - grade until the numbers agree with your eyes.
   CHECK what stills can't show (CLI: agentcut review | audio | motion):
   review        editorial lint with times: text outside the safe area / under 9:16 app UI, text too short to read,
                 shots too short/long, cuts off the beat (beats='music' or a list), validation warnings,
                 black frames (judged on the picture below text and captions: footage that is black under them is reported, a title card on black too, with text_ids),
                 text or captions covering a face in the picture below (text_over_face; read only from a subject analysis already cached by
                 analyze_subject, auto_reframe or track_to: checked.faces.unchecked lists the clips without one, or with a moved/animated layout)
   audio_check   image of every track's waveform + the rendered mix (+ spectrogram) with clip boundaries and markers;
                 findings: clipping/overs, true peak, long silences, audio cut off without fade, music not ducked under voice
   motion_strip  10 consecutive frames per transition (or start/end for any animation) to judge motion
5. render draft=true first, then final. The result has has_audio, a contact sheet (previews/render-<name>-<time>.sheet.jpg) + loudness (~ -14 LUFS) + qa: the written file checked against what was asked (size, fps, length, sound: missing_audio, size_mismatch, fps_mismatch, duration_mismatch) and frozen_picture (the picture holds still 1 s or more while a video clip plays: still footage, or frames the decode repeated; ids name the clips). Not for .gif. A timeline with no audible clip renders without an audio track (has_audio false, a warning, no loudness). Re-render a section with start/end.
   Output by extension: .mp4 (codec h264|hevc), .mov (ProRes; transparent background "#00000000" -> ProRes 4444 with alpha),
   .webm (VP9, alpha ok), .gif, or audio only .wav/.mp3/.m4a/.flac,
   or one still frame at start as .png/.webp (alpha kept with a transparent background; webp lossless at quality=high; no end, sheet or loudness). Check result.warnings.
   Video outputs (not .gif, which has no colour tags) are tagged BT.709, limited range, and made with that matrix. A source video is read with the matrix its asset's color_space names: import_media records the file's own tag (a matrix name such as bt709, smpte170m, bt470bg, bt2020nc), or "unknown" when it has none; an untagged picture is read as bt2020nc when its primaries are converted from BT.2020 (see below), else as BT.709 when it is HD (short side >= 720 or long side >= 1280: AgentCut's own rule, a browser's guess goes by height alone) and as BT.601 below that. A name written into the asset by hand replaces the file's tag; validate lists the names it accepts. import_media also records the file's color_primaries and color_transfer ("unknown" when untagged). A PQ (smpte2084) or HLG (arib-std-b67) source (with no primaries tag it is read as BT.2020), and a source with BT.2020 primaries and an SDR curve, is converted to BT.709 before any clip filter, crop or grade, in renders, previews, inspect and the background-removal matte; highlights above SDR white (203 nit) clip. Thumbnails in the page and the subject, track and analyze_scenes analyses read pixels that are not converted. validate and the render result warn about a source whose colours stay wrong: a log, linear or smpte428 transfer, P3 or V-Gamut primaries, PQ or HLG read through a matrix other than bt2020nc, or BT.2020 signalled (primaries bt2020, or the bt2020nc matrix with no primaries tag) with a curve that has no conversion.
   The source-matrix rule above applies only to YUV pixel formats: RGB and palette video (including GIF) bypass matrix tagging, regardless of size or matrix name. import_media records pix_fmt; relink_asset an older asset to record it (without it, the legacy matrix rule remains). Video decoding selects the first non-cover-art video stream, matching the probe's metadata, even when another stream is marked default.
   Hand-off to a human editor: export_timeline (CLI: agentcut export -o edit.fcpxml | edit.otio). The output extension names the format; MCP format=fcpxml|otio or CLI --format fcpxml|otio sets it for any file name; with no output the file is FCPXML:
   cuts, in-points, crossfades,
   constant speed, titles and connected clips carry over, and volume in FCPXML only (OTIO has no gain: it is metadata, listed as approximated); media is linked by absolute path. The result has two lists of
   {id, type, reason}: skipped = not exported (effects, looks, keyframes, masks, captions, shapes, vision requests not yet prepared
   (type "pending"), or named fields of an exported clip, titles included); approximated = exported in another form (a speed ramp as constant speed,
   a transition as a cross dissolve, fit 'blur' as fit 'contain' in FCPXML, a title as a named Gap in OTIO, a volume kept only as OTIO metadata,
   a clip that needs more than its source has: "clip X needs N s, source has M s"). Tell the human what is left to finish.
6. Fix with update_clip / trim_clip / undo.
   A source file that moved or was replaced (validate: file not found): {"op":"relink_asset","id":"a1","path":"/abs/new.mp4"} points the asset at it and probes it again,
   same kind only (else bad_type: import_media it, then update_clip each clip). The clips are kept as they are; the result has changed (old/new per field) and recheck
   (clips whose auto_reframe focus or track_to x/y keyframes may come from the old picture: run those ops again). Captions made from a transcript of the old file keep their timings.
   A video asset imported by an older version lacks the probe fields: validate says so, and relink_asset with the file's own path records them.
   A clip's loop is refused on a file whose seek can land after the frame asked for (anything but mp4/mov, mkv/webm, flv, avi or gif; e.g. .ts, .m2ts, .mpg): remux it to mp4 or mkv first. A clip with both reverse and loop is refused (validate error): set one.

## Ops cheat-sheet
{"op":"add_clip","track":"main","src":"/abs/clip.mp4","in":2,"duration":4,"transition":"crossfade"}
{"op":"add_clip","track":"main","src":"/abs/wide.mp4","fit":"blur"}                      landscape in 9:16 with blurred background
{"op":"add_clip","track":"main","src":"/abs/photo.jpg","duration":3,"motion":"ken_burns","transition":{"type":"zoom_blur","duration":0.4}}
{"op":"add_clip","track":"text","text":"HOOK","at":0.3,"duration":2.5,"preset":"title_bold","position":"top","margin":"20%"}
{"op":"add_clip","track":"text","text":"Sale 30%","attach_to":"main#2","offset":0.2,"match_duration":true,"preset":"subtitle_box","y":"62%"}
{"op":"update_clip","id":"img2","match_duration":"voice#-1","end_offset":-0.3}                   img2 lasts as long as the last voice clip, plus 0.3 s
{"op":"add_clip","track":"text","text":"🔥 HOT","at":1,"duration":2,"preset":"sticker","position":"top_right"}      emoji ok
{"op":"add_clip","track":"overlay","src":"/abs/logo.png","until_end":true,"size":["18%","18%"],"fit":"contain","position":"top_right"}
{"op":"add_clip","track":"overlay","src":"/abs/face.mp4","at":3,"duration":5,"size":[420,420],"mask":{"shape":"circle","feather":6},"position":"bottom_left","shadow":true,"border":{"color":"white","width":6}}
{"op":"add_clip","track":"overlay","src":"/abs/anim.json","at":1,"duration":3,"size":["40%","40%"]}         Lottie
{"op":"add_clip","track":"music","src":"/abs/song.mp3","until_end":true,"fade_out":1.5}
{"op":"add_sequence","track":"main","items":["/a.jpg","/b.jpg"],"defaults":{"duration":2,"transition":"crossfade","motion":"ken_burns"}}
{"op":"add_captions","words":[{"text":"Hello","start":0,"end":0.4}],"preset":"tiktok"}       or "srt":"/abs/subs.srt" / "transcribe":"/abs/talk.mp4"
   transcribe of media that clips on the timeline play: each word lands where the clip that plays that moment puts it (start + (word - in) / speed), so
   in-points, trims, speed and remove_silence are followed, a word no clip plays is dropped, one captions clip covers the asset (cut first, caption once),
   and 'at' is refused. A clip with a speed ramp, reverse, freeze, loop or inside a compound is not mapped: its id is in the result's 'unmapped'.
   A video with detached audio is mapped through the audio pieces. Media no clip plays keeps media seconds from 'at'. The captions clip ends 0.3 s
   after the last word, never after the last clip that plays the media (unmapped: the media or range end; add_voiceover captions: the voice clip).
   The captions are not retimed after that: they record the cut they were timed for ('timed_for': each start is relative to the captions clip's start, so moving
   the captions with their clips is fine), and validate (so review and every apply result) warns when the captions clip moved alone or the clips that play the
   asset changed; move the captions clip back, or remove it and run add_captions again, which loses any hand-corrected words. A transcript's captions go on a
   track that is not magnetic.
   "transcribe_range":[start,end] (seconds of the media) transcribes only that stretch, and the words stay within it. Silences (0.4 s or more below
   -35 dB, analyze_silence's defaults, or 6 dB over a steady hiss or room tone above that) are left out before whisper (the result's 'skipped_leading' is the seconds
   left out at the start; whisper times words into a silence it hears, and a word it starts in the 0.25 s put between two speech pieces starts at the next one), but a
   steady tone or hum is never taken for the noise floor, and a music lead-in is not silence: pass the speech only, since whisper may invent text over a long music-only stretch and times words
   early after a music lead-in; analyze_silence or the voiceover's length gives the span
{"op":"add_voiceover","text":"Xin chào các bạn","voice":"Linh","captions":"tiktok"}
   voice picks the TTS provider: "Linh" (OS voice) | "piper" / "piper:/abs/vi.onnx" (env AGENTCUT_PIPER_MODEL) |
   "openai:nova" (OpenAI-compatible /v1/audio/speech: env AGENTCUT_TTS_URL, AGENTCUT_TTS_KEY, AGENTCUT_TTS_MODEL); default
   provider env AGENTCUT_TTS_PROVIDER. list_voices (CLI: agentcut voices) shows which providers are available. Each sentence is synthesized separately
   (openai: one request per sentence), so captions follow the real sentence timing.
   Outside the timeline: tts (CLI: agentcut tts "text" -o out.wav [--voice V] [--rate WPM]) writes the speech to a file; transcribe (CLI: agentcut transcribe F
   [--language L] [--model M] [--start S --end S]) returns word timings, of one stretch of the media when start or end is given (start defaults to 0, end to the media end);
   whisper's sound notes ([Music], (laughs), ♪) are left out of it and of transcribed captions, and so is speech it puts in brackets.
{"op":"update_clip","id":"vid1","set":{"color":{"look":"teal_orange","exposure":0.3,"temperature":-0.2,"vibrance":0.4}}}
{"op":"update_clip","id":"vid2","set":{"color":{"lift":[0,0,0.05],"gain":[0.05,0,-0.03],"curves":{"master":[[0,0.03],[0.5,0.55],[1,1]]},"hsl":{"blues":{"saturation":-0.3}}}}}
{"op":"snap_to_beats","track":"main","beats":"/abs/song.mp3","every":2}
{"op":"snap_to_beats","track":"main","beats":[0.47,0.98,1.47,1.98],"every":2}      a list of seconds, as analyze_beats gave it
   beats is an audio path or asset id (analysed inside the batch), a list of seconds, or a .json with a top-level "beats" list. CLI: every call analyses an audio path again (a dry run, the apply,
   a resend after a "conflict"), so analyse once: agentcut beats F --full > beats.json (without --full the list is cut at 64: beats_truncated:true; a file cut that way is refused), then beats=beats.json. MCP: the server keeps an
   audio path's beats, so the path is enough; a list from analyze_beats works too, with max_beats large enough (default 128; over it the list is cut: truncated:true). A typed list shorter than the track is not an error:
   it retimes only the first clips and leaves the rest as they were. A saved result that was cut (its count is above its list; the file `beats F` prints without --full) is refused as bad_beats: save it again with --full (MCP: a larger max_beats), or pass the audio path; if you shortened the list yourself, remove count.
   A typed list holds numbers only. Give one beat per clip after every and offset; the last clip keeps its length. every is a whole number, 1 or more; offset is a whole number, 0 or more (a number, not text: "every":2, not "every":"2"), else bad_value.
   The beats that every and offset pick must each be 0 s or more and later than the one before, else bad_beats. Each retimed clip (not a kept_computed one) must span more than 0.05 s between its two cuts (the first clip from 0 s), else bad_beats; for close beats, a larger every skips them, and in a typed list you can leave one out.
   Every clip the list reaches is named in retimed or kept_computed; a clip of the track named in neither was not reached (the list ran out, or it is the last clip).
{"op":"remove_silence","id":"vid1"}      {"op":"freeze_frame","id":"vid1","at":3.2,"duration":1.5}
{"op":"remove_range","id":"vid1","start":2.1,"end":3.4}      cut a stretch (timeline seconds, e.g. the words of a transcript) out of a video/audio clip; detached audio follows
{"op":"update_clip","id":"vid2","set":{"reverse":true}}     {"op":"update_clip","id":"vid2","set":{"speed":2}}   half as long, same source
{"op":"set_keyframes","id":"vid3","prop":"speed","keyframes":[[0,1],[1,0.25,"ease_in_out"],[2,3]]}   speed ramp
{"op":"set_keyframes","id":"img2","prop":"scale","keyframes":[[0,1],[3,1.2,"ease_in_out"]]}
{"op":"add_effect","id":"vid1","type":"glitch","start":0,"duration":0.5}    {"op":"add_effect","type":"letterbox"}  (no id = whole video)
{"op":"trim_clip","id":"vid1","trim_start":0.5}  {"op":"split_clip","id":"vid1","at":4.2}  {"op":"move_clip","id":"vid3","index":0}
   split_clip of a speed-ramped video: the right half starts at the source second the ramp reached and keeps the whole curve in its own time (keys before its head
   at negative times), so both halves play what the clip played; a freeze clip's halves hold its frame. freeze_frame holds the frame the clip shows at 'at' (reverse, ramp, freeze)
{"op":"add_transition","to":"vid2","type":"dip_black","duration":0.6}  {"op":"set_settings","preset":"reels"}

## Pro editing (Final Cut style)
{"op":"detach_audio","id":"vid2"}                  video audio -> its own clip on the 'dialogue' track, connected (stays in sync)
{"op":"attach_audio","id":"vid2"}                  the reverse: sound and its processing back on the video (refused with the field named if a J/L-cut or slip moved it)
{"op":"j_cut","id":"main#1","seconds":0.8}         B's audio starts 0.8 s before its picture (auto-detaches)
{"op":"l_cut","id":"main#0","seconds":1,"crossfade":0.3}   A's audio runs 1 s over B
  -> check result.under (clips still audible underneath) and fade/lower them. split_clip/trim_clip keep detached audio in sync.
  Splitting the detached audio clip leaves a video with several audio pieces: split_clip, duplicate_clip, slip_clip and enhance_voice on the video handle every piece; the other ops that follow the audio refuse it (audio_pieces), so edit a piece by its id.
{"op":"slip_clip","id":"vid2","by":0.5}            different part of the source, same place on the timeline
{"op":"roll_edit","id":"vid1","by":-0.3}           move the cut between vid1 and the next clip (total length unchanged)
{"op":"slide_clip","id":"vid2","by":0.4}           move a clip between its neighbours (they absorb it)
   roll_edit and slide_clip refuse a cut whose edited clips have keyframes.speed (unsupported): remove the speed ramp first; these edits do not rebase speed curves.
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
{"op":"enhance_voice","id":"main#0","strength":0.8}  one clip (a video with detached audio enhances its audio clip, or every piece of it)
{"op":"separate_audio","id":"vid1","stem":"voice"}   only the speech of a clip's sound (stem music: the rest); AI separation (Spleeter 2 stems) computed by prepare,
  cached, like remove_background (models 2 x 39 MB, allow_download); the stems add up to the source. Both parts: duplicate_clip the audio clip (detach_audio a video first),
  stem voice on one and music on the other, then lower or duck the music. A video with detached audio sets it on its audio clips; detach/attach move stem with the sound.
{"op":"update_track","id":"music","set":{"eq":"low_cut","compressor":"music","pan":-0.2}}   track = bus: eq/compressor/pan process the
  track mix once; denoise/normalize/pitch on a track apply to each of its clips that does not set its own.
Subtitles: export_captions (CLI: agentcut captions -o subs.srt | subs.vtt) writes the captions clips in timeline time;
  render subtitles=true (CLI --subtitles) adds a soft subtitle track to .mp4/.mov (mov_text), .mkv (srt), .webm (webvtt).

## AI vision (optional: needs uv, packages download on first use; results cached in .agentcut/cache)
{"op":"auto_reframe","id":"vid1","smooth":0.8}     16:9 shot in 9:16: smoothed keyframes.focus_x/focus_y (the source point kept at the view centre) follow the face (YuNet, with a confidence score), else the most salient region
{"op":"remove_background","id":"vid2","model":"u2net_human_seg"}   alpha matte (cached, deterministic); off=true removes it; model rvm_mobilenetv3 (15 MB, weights GPL-3.0,
  listed with its licence in capabilities.matte_models) keeps a person's matte steady from frame to frame in video
{"op":"track_to","id":"txt1","target":"vid1","box":[400,600,200,200],"at":2}   overlay follows the object in the box
  (canvas px at timeline time 'at'; read it off preview_frame); no box = follow the subject. Writes keyframes x/y + attach_to.
  -> targets must have a static layout (no position/rotation/motion/speed ramp); without uv you get code missing_dependency.
  -> a model (a matte model, 5-179 MB each, or the 0.23 MB face model that subject analysis, auto_reframe and track_to without box use) and a Python interpreter
     (3.12 or 3.13, which uv installs if none is found) are downloaded only on request: prepare fails with code model_not_cached until the model is
     in <user cache>/models (~/.cache/agentcut/models, or AGENTCUT_CACHE) or you run prepare with allow_download=true (CLI: prepare --allow-download;
     analyze_subject takes allow_download too, CLI: subject --allow-download). allow_download covers models and the interpreter; uv fetches the
     packages on a first run either way, so that run needs network access. Without allow_download and without a 3.12/3.13 Python the helper fails
     with a hint to run: uv python install 3.12;
     capabilities.matte_models, engines.vision.face_model and prepare --status (models_to_download) list the sizes and what is cached. AgentCut fetches each model and checks its pinned sha256 and size; the helper never downloads.
  -> analyze_subject with a project open (project arg, the one MCP remembered, or CLI -p / $AGENTCUT_PROJECT / the nearest project.json) caches its result in that project;
     auto_reframe on a clip covering the same range at the same fps reuses it (no pending, nothing to prepare). With no project it caches in the user cache. A named project that is not one fails with no_project (MCP: the project arg or the remembered project; CLI: -p / $AGENTCUT_PROJECT).
  -> auto_reframe, track_to without box and analyze_subject say what they followed: subject = face|saliency|mixed|none, and warnings when it may be wrong
     (no face found, low confidence, several faces); read them and check the framing with preview_frame.
  -> AgentCut runs onnxruntime children (the vision helper and piper) with ORT_DISABLE_TELEMETRY=1 (onnxruntime may otherwise send usage telemetry).
  uv runs with --no-config: set UV_* env vars (e.g. UV_INDEX_URL) for index settings.
These ops are instant: they record the request (clip.pending; result pending=true, prepare_needed=true). Then run
  prepare (CLI: agentcut prepare --author NAME, or agentcut prepare --status; MCP: prepare -> job_id, poll render_status for progress, cancel_job to stop it): it computes the mattes /
  tracks (seconds per clip; cached by file hash + params) and writes the keyframes. While a model downloads, the running job (MCP, UI) and the
  CLI's stderr progress lines (not with --quiet) carry download {model, bytes, total_bytes}; the field is gone once the job settles. Until then preview/video render fail fast with
  code not_prepared (details list what is missing; audio-only renders and audio_check need only separate_audio's stems) - they never compute. A repeated op on cached analysis applies at once.
Cache: agentcut cache [info] | cache prune [--max-mb N] [--older-than 7d] (MCP: cache) covers .agentcut/cache + previews/;
  prune deletes unreferenced files first (max_mb also referenced ones: prepare rebuilds them). previews/ is capped
  automatically at AGENTCUT_PREVIEWS_MAX_MB (200; 0 = off), oldest first. info also counts .agentcut/tmp (render scratch, listed as tmp and not in total);
  prune, render and prepare remove what a process that is gone left there.

## Vocabulary
- transitions: crossfade, dip_black, dip_white, flash, glitch, zoom, zoom_blur, spin, circle, blur, slide_*, push_*, wipe_*
- enter/exit: fade, pop, bounce, flip, slide_*, zoom_in, zoom_out, wipe_*, blur, drop, spin, typewriter (text), words (text)
- motion: ken_burns, ken_burns_out, zoom_slow, pan_left/right/up/down, pulse, float, sway, shake
- effects (clip or whole video, optional start/duration window; flash: at + duration): glitch, rgb_split, flash, grain, zoom_blur, vignette, vhs, letterbox, strobe, blur, bw, invert, hue, brightness, contrast, saturate
- color (grade, video/image): look (cinematic|warm|cool|vintage|bw|vivid|fade|teal_orange|moody|pastel; film stocks kodak_gold|portra|velvia|cinestill|bleach_bypass|kodachrome) as a base, exposure (stops),
  contrast, saturation, vibrance, temperature/tint (-1..1), lift/gamma/gain [r,g,b] -1..1, curves {master|r|g|b: [[x,y],..]},
  hsl {reds|yellows|greens|cyans|blues|magentas|all: {hue, saturation, lightness}}
- filters (decode-time, video/image, before color): eq, lut (.cube), chromakey, stabilize, denoise, sharpen, vignette, blur, grayscale, hflip, vflip
- masks: rect, circle, ellipse, heart, star, linear, mirror (+ feather, invert, x, y, width, height, angle)
- layout: position+margin ('8%', or 'x y' for the left/right and the top/bottom distance) or x/y (centre); fit cover|contain|fill|none|blur; size [w,h]; focus [fx,fy] (the source point, 0..1 after crop, kept at the centre of the view; clamped at the picture edges; [0.5,0.5] = centre); radius; border; shadow; blend; opacity
- text: preset, font (agentcut fonts), font_size, weight, italic, color, gradient, stroke, glow, shadow, background, max_width, align, uppercase, letter_spacing
- text presets: title_bold, subtitle_box, neon, gradient, lower_third, quote, typewriter, sticker, outline, cinematic
- caption presets: tiktok, bold_pop, pill, clean, reveal, neon (styles: karaoke | word | reveal | line)
- keyframes: x y scale scale_x scale_y rotation opacity blur volume speed (speed ramps only on video clips, whose sound follows the ramp and changes pitch with it; every speed value is 0.1..8, and back_out/elastic_out are refused on a speed ramp only where the curve leaves that range; a ramp sets the speed, so `speed` must be 1 or absent; a video with detached audio cannot ramp: attach_audio first; an audio, compound or lottie clip takes a constant `speed`) focus_x focus_y; easings linear ease_in ease_out ease_in_out back_out bounce_out elastic_out hold

## Rules of thumb
- Hook in the first 1-2 s. Cut on beats. Shots 1-3 s for social. One idea per text card, >= 64 px.
- 9:16: keep text out of the top 10% and bottom 20% (preview with guides). Use fit "blur" for landscape footage.
- Never invent logos/screens/metrics: only use files you were given; a missing asset is a blocker - ask.
- "Done" needs evidence: a contact sheet or frame you looked at + the render result JSON.
- The project folder must be on a volume with hard links (APFS, NTFS, ext4; not exFAT or FAT): project.json and the lock need them, and error unsupported_fs says so. Media files may stay on any volume. A folder you cannot write to (permissions, read-only volume) is error not_writable, and its hint names the folder.

## Working alongside a human (agentcut ui)
- `agentcut ui [DIR] [--port 4810]` (0..65535) serves a local web UI on 127.0.0.1 (on a folder with no project: a dashboard of the projects in its subfolders, to open, create or duplicate; timeline, viewer, inspector (a form of the clip's fields, or its JSON), keyframe
  editor, compound open/expand/regroup, prepare, render, an export dialog showing the render's qa, a media pool, a library of looks, effects, transitions and text styles with rendered previews (click or drag onto a clip), a transcript panel (click a word to seek, cut a run of words with remove_range), a library of templates (a form of each template's args builds it with apply_template), a chat panel (a run of a local agent CLI per message: Claude Code, pi, omp, Antigravity (agy) or Devin, picked in the panel when more than one is installed, with only the agentcut MCP tools of this project; its edits are authored by its MCP client name), review and undo-history panels, English or Vietnamese). Files the human drops on the media pool are
  copied into the project's media/ (never over a file there) and imported. The human's edits land in the same project.json, so re-read (info /
  project_info) before planning more edits. UI previews (sheets, play drafts) live in previews/ui/, capped (oldest dropped).
  The UI's Prepare downloads a missing vision model only after the human confirms it in a dialog.
- project.json has a "revision" that goes up by 1 on every save. Every call that writes history needs the revision you last read, so an edit never lands on a state you did not see
  (clip ids are reused: a deleted vid3 is the id of the next clip you add). CLI: --revision N on apply, op, add, set, rm, undo, redo and beats --markers. MCP: revision on apply_ops, undo and redo.
  Without it the call fails with missing_revision, before any work, and changes nothing. There is no "latest": get the revision from info / project_info, or from the "revision" of your previous result
  (apply, undo, redo and prepare return the new one; create_project and init return 0). One write at a time: a second write sent in parallel with the same revision conflicts.
  Not bound: dry runs, read-only commands, and prepare (it resolves the pending vision requests of whatever timeline is there and returns the revision it wrote; take the revision from its result).
  undo needs no revision only while project.json is damaged (info and apply then fail with bad_revision or bad_json whose hint says so): undo restores the last good version.
  If someone saved meanwhile you get code "conflict" and nothing changes. The message names who changed the project and what, for example
  project changed since revision 12 (now 14): "you" update_clip, "claude-code" add_captions; nothing was changed (details.changes lists {author, label}). Reload (info), judge whether your edit still makes sense, then resend it with the new revision.
  An analysis the batch needed (transcription, speech, silence scan) runs again on the resend. Beats: on the CLI pass the beats .json; over MCP the server keeps them (see snap_to_beats). The names are self-declared; the history holds 100 entries, and an undo that a later edit followed is not listed.
  replace_timeline replaces the whole timeline under the call's revision; a "revision" inside the timeline is ignored.
  Every apply result names the project root it applied to ("project"): the one a saved batch changed, or the one a dry run checked without saving.
- Every undo-history entry records its author, self-declared and not a security boundary: 1-64 characters (letters, accented ones too, digits, space . _ - : @ / +).
  CLI: declare your own name with --author NAME or $AGENTCUT_AUTHOR (the flag wins; set the variable once per session) on every command that writes history:
  apply, op, add, set, rm, undo, redo, prepare (not --status) and beats --markers, --dry-run too. With neither the command fails with missing_author and does nothing.
  MCP: the client name you declared when you connected (else "mcp"); the page: "you".
  "you" and "unknown" are reserved: a CLI --author or $AGENTCUT_AUTHOR of either is bad_author. history, undo and redo list {label, author}
  per entry; undo and redo also set movedBy (the author who undid or redid it), so you can see whose edit was undone and by whom.
  An entry written before authors were recorded shows author "unknown".

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
An argument or field the op does not know is refused (bad_arg, or an invalid_timeline issue), never ignored. A number outside its documented range (opacity 0..1, volume 0..4, scale > 0, fade_in/fade_out/radius >= 0) is a validate error, not clamped.
Ctrl-C or SIGTERM stops a CLI command: it prints one JSON (code aborted, "interrupted by SIGINT", unless the command had already finished: then its own result), removes its temporary files, then ends by that signal; a second signal prints the one JSON (code aborted, with one write) and exits at once, ending by the second signal, with no cleanup: what the command had made stays. A render's scratch in .agentcut/tmp is removed by the next render, prepare or cache prune; a reserved or partly written output file stays beside the output path (renders/ for the default name) until you delete it. Only while the result is being written does a second signal wait for the write, at most 0.5 s: the process then ends by the first signal when the write finishes, by the second when the 0.5 s runs out (a reader that has stopped reading still gets a cut object after that, and SIGKILL cannot be helped). Limits: a node or Python parent sees a signal death (code null, or a negative return code), not exit 130/143 (a shell still shows 130/143); a background job started from a non-interactive script is still stopped by Ctrl-C; a command still running after 4 s is reported aborted anyway, and its temporary files may remain, as after a second signal.
