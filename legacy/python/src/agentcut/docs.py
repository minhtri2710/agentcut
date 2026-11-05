GUIDE = r"""
# AgentCut — guide for AI agents

AgentCut is a video editor you drive with JSON. A project is a folder with `project.json`
(the timeline). You edit it with atomic **ops**, look at it with **preview frames / contact
sheets**, and export with **render**. Everything returns JSON. Nothing is interactive.

## Mental model (Final Cut / CapCut, simplified)
- **Canvas**: settings.width x height @ fps. Presets: reels/tiktok/shorts 1080x1920, youtube 1920x1080, square, portrait 1080x1350, 4k.
- **Tracks** are layers. `tracks[0]` is drawn first (bottom); later tracks draw ON TOP. Audio tracks are not drawn.
- Default tracks: `main` (magnetic, bottom) · `overlay` · `text` · `voice` (audio, role=voice) · `music` (audio, ducks -12 dB under voice).
- **Magnetic track** (like Final Cut's primary storyline): clips play back-to-back in list order; `start` is computed.
  A `transition` on a clip overlaps it with the previous one. Reorder with move_clip index. Use `gap` clips for black/pauses.
- **Other tracks**: clips have explicit `start` (`at` when adding). Overlaps are fine (later clip on top).
- **Clip types**: video · image · text · captions · shape · color (solid/gradient) · audio · gap.
- **Times** are seconds (2.5, "2.5s", "1500ms", "00:02.5"). **Lengths** are px or "10%". Colours: "#RRGGBB[AA]" or CSS names.

## Workflow that works
1. `create_project` (or CLI `agentcut init DIR --preset reels`).
2. `probe` / `analyze_beats` / `analyze_scenes` / `analyze_silence` your inputs - know durations before cutting.
3. Build with ONE `apply_ops` batch (atomic: all or nothing). Prefer `add_sequence` for montages.
4. Read `validate` output (errors have `path` + `hint`). Fix, repeat.
5. LOOK: `contact_sheet` (whole video) and `preview_frame` at key moments (hook, text, transitions).
   Judge the pixels, not your intentions: text readable? inside safe area (guides=true)? nothing cropped wrongly?
6. `render` with draft=true for a fast check, then the final render. The result includes a contact sheet + loudness.
7. Small fixes: `update_clip` / `trim_clip` / `undo`. Re-render only a section with start/end.

## Ops cheat-sheet (apply_ops takes a list of these)
{"op":"add_clip","track":"main","src":"/abs/clip.mp4","in":2,"duration":4,"transition":"crossfade"}
{"op":"add_clip","track":"main","src":"/abs/photo.jpg","duration":3,"motion":"ken_burns","transition":{"type":"slide_left","duration":0.4}}
{"op":"add_clip","track":"text","text":"HOOK LINE","at":0.3,"duration":2.5,"font":"Arial Black","font_size":110,
 "color":"white","stroke":{"color":"black","width":8},"position":"top","margin":"12%","enter":"pop","exit":"fade"}
{"op":"add_clip","track":"overlay","src":"/abs/logo.png","at":0,"duration":10,"size":["18%","18%"],"fit":"contain","position":"top_right"}
{"op":"add_clip","track":"overlay","src":"/abs/face.mp4","at":3,"duration":5,"size":[400,400],"radius":200,"position":"bottom_left","shadow":true}
{"op":"add_clip","track":"music","src":"/abs/song.mp3","at":0,"duration":15,"volume":0.8,"fade_out":2}
{"op":"add_sequence","track":"main","items":["/a.jpg","/b.jpg","/c.jpg"],"defaults":{"duration":2,"transition":"crossfade","motion":"ken_burns"}}
{"op":"add_captions","words":[{"text":"Hello","start":0,"end":0.4},...],"style":"karaoke","highlight_color":"#FFD60A"}
{"op":"add_captions","srt":"/abs/subs.srt","style":"word"}
{"op":"add_voiceover","text":"Xin chào các bạn","voice":"Linh","captions":true}
{"op":"snap_to_beats","track":"main","beats":"/abs/song.mp3","every":2}
{"op":"remove_silence","id":"vid1","noise_db":-35,"min_silence":0.4}
{"op":"update_clip","id":"txt1","set":{"color":"#FFD60A","enter":{"type":"slide_up","duration":0.6}}}
{"op":"set_keyframes","id":"img2","prop":"scale","keyframes":[[0,1],[3,1.2,"ease_in_out"]]}
{"op":"trim_clip","id":"vid1","trim_start":0.5}   {"op":"split_clip","id":"vid1","at":4.2}
{"op":"move_clip","id":"vid3","index":0}   {"op":"remove_clip","id":"img2"}   {"op":"add_transition","to":"vid2","type":"dip_black","duration":0.6}
{"op":"set_settings","preset":"reels","background":"#111111","loudness":-14}

## Look & motion vocabulary
- enter/exit: fade, slide_up/down/left/right, pop, zoom_in, zoom_out, wipe_*, blur, drop, spin, typewriter (text), words (text)
- transitions: crossfade, dip_black, dip_white, slide_*, push_*, wipe_*, zoom, circle, blur
- motion (whole clip): ken_burns, ken_burns_out, zoom_slow, pan_left/right/up/down, pulse, float, shake
- keyframes props: x, y, scale, scale_x, scale_y, rotation, opacity, blur, volume; easings: linear, ease_in, ease_out, ease_in_out, back_out, bounce_out, elastic_out, hold
- filters: {"type":"look","name":"cinematic|warm|cool|vintage|bw|vivid|fade|teal_orange"}, eq, lut (.cube), blur, sharpen, grayscale, vignette, chromakey, denoise, hflip, ffmpeg (raw)
- layout: position (center/top/bottom/left/right/top_left/...)+margin, or x/y (centre point). fit: cover|contain|fill|none, size [w,h], focus [fx,fy] for reframing, radius, shadow, blend, opacity
- text: font (see fonts), font_size, color, stroke{color,width}, shadow{color,x,y,blur}, background{color,padding,radius}, max_width, align, uppercase, line_height, letter_spacing
- captions: style karaoke (active word coloured) | word (one word at a time, pop) | reveal | line; max_words, highlight_color, highlight_bg

## Rules of thumb (good videos)
- Hook in the first 1-2 s. Cut on beats (`analyze_beats` -> `snap_to_beats`). Keep shots 1-3 s for social.
- Vertical (9:16): keep text out of the top 10% and bottom 20% (preview with guides=true). Text >= 64 px.
- Never invent logos/screens/metrics: use only the files you were given; a missing asset is a blocker - ask.
- Every claim of "done" needs evidence: a contact sheet or frame you actually looked at, and the render result JSON.

## Errors
Errors are JSON: {"ok":false,"error":{"code","message","hint","path"}}. Hints usually contain the fix
(e.g. "did you mean 'crossfade'?"). Batches are atomic, so a failed batch changed nothing.
"""
