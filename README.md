# AgentCut

**Trình dựng video dành cho AI agent**, có các tính năng của CapCut và Final Cut. Agent điều khiển qua **CLI**
(`agentcut …`) hoặc **MCP** (`agentcut-mcp`), dựng video bằng timeline JSON, và *nhìn* được kết quả
(preview frame, contact sheet) trước khi xuất file.

Viết bằng **TypeScript**, chạy bằng Bun hoặc Node. Đồ hoạ dùng **Skia** (`@napi-rs/canvas`), video dùng **FFmpeg**.
Chạy trên **macOS, Windows và Linux**.

```
agent ──(MCP / CLI · JSON)──▶ ops / templates (add_clip, apply_template, add_captions, snap_to_beats…)
                               │ batch nguyên tử · validate kèm gợi ý sửa · undo/redo
                               ▼
                         project.json  (tracks → clips)
              ┌────────────────┼────────────────────┐
              ▼                ▼                    ▼
       preview_frame     contact_sheet         render (N process song song, nối không mất chất lượng)
        (JPEG ~0.1s)      (lưới frame)          mp4 · mov · webm · gif + contact sheet + LUFS
```

## Cài đặt

Cần **FFmpeg**. Sau đó chọn **một** trong ba cách dưới.

| Hệ điều hành | Cài FFmpeg |
|---|---|
| macOS | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` |
| Linux | `sudo apt install ffmpeg` (hoặc dnf/pacman) |

**Cách 1: dùng Node ≥ 20 (npm/npx)**
```bash
npm install -g /đường/dẫn/video-editor     # hoặc npm link trong thư mục repo
agentcut guide
```

**Cách 2: dùng file binary (không cần cài Node hay Bun)**
```bash
bun install && bun run build -- --compile  # tạo ra bin/agentcut
```
Muốn ra binary cho hệ điều hành khác thì build trên chính máy đó, vì Skia là thư viện native.

**Cách 3: dùng Bun (để phát triển)**
```bash
bun install
scripts/ac guide
```

Có thể cài thêm:
- **Giọng đọc (TTS):** macOS có sẵn `say` (giọng tiếng Việt `Linh`). Windows dùng SAPI có sẵn. Linux cần `espeak-ng`.
- **Phụ đề tự động:** cài `whisper-cli` (whisper.cpp, `brew install whisper-cpp`) và đặt biến `AGENTCUT_WHISPER_MODEL=/path/ggml-*.bin`. Hoặc cài `openai-whisper`.

## Kết nối agent

**Claude Code:**
```bash
claude mcp add agentcut -- agentcut-mcp
```
Khi mở repo này trong Claude Code thì file [.mcp.json](.mcp.json) và skill [.claude/skills/agentcut](.claude/skills/agentcut/SKILL.md) đã được cấu hình sẵn.

**Claude Desktop, Cursor, Windsurf và các MCP client khác:**
```json
{ "mcpServers": { "agentcut": { "command": "agentcut-mcp" } } }
```
Nếu dùng binary thì đổi thành `{ "command": "/path/bin/agentcut", "args": ["mcp"] }`.

**Agent chỉ có shell** (Codex CLI, Aider, script…): dùng thẳng CLI. Mỗi lệnh in ra đúng một object JSON. Bắt đầu bằng `agentcut guide`.

## Ví dụ: video promo 9:16 chỉ với một lệnh

```bash
agentcut init promo --preset reels && cd promo
agentcut op apply_template name=promo --json '{
  "media": ["/abs/hero.mp4", "/abs/detail.jpg", "/abs/usage.mp4"],
  "hook": "Ra mắt sản phẩm mới", "points": ["Nhẹ hơn 30%", "Pin 2 ngày"],
  "cta": "Mua ngay", "music": "/abs/song.mp3"}'
agentcut sheet --guides          # agent xem contact sheet
agentcut render --draft          # bản nháp nhanh
agentcut render -o final.mp4     # bản cuối, kèm contact sheet và số đo LUFS
```

Template sinh ra các clip bình thường, nên agent sửa tiếp được: đổi chữ, thay clip, thêm hiệu ứng, `undo`.

## Tính năng so với CapCut / Final Cut

| Nhóm | AgentCut |
|---|---|
| Dựng | magnetic timeline (Final Cut), **connected clips** (`attach_to`), gap, split, trim, freeze frame, reverse, speed, **speed ramp** (keyframe tốc độ), duplicate, nhiều track, undo/redo |
| Dựng chuyên nghiệp | **tách tiếng** (`detach_audio`), **J-cut / L-cut**, **slip / roll / slide**, **compound clip** (`make_compound` / `expand_compound`); split/trim giữ tiếng đã tách luôn khớp hình |
| Transition (22) | crossfade, dip đen/trắng, **flash, glitch, zoom blur, spin**, zoom, circle, blur, slide/push/wipe theo 4 hướng |
| Chữ | **10 mẫu chữ** (title_bold, subtitle_box, neon, gradient, lower_third, quote, typewriter, sticker, outline, cinematic), font hệ thống bất kỳ, tự lấy glyph từ font khác khi thiếu dấu tiếng Việt, emoji, stroke, glow, gradient, nền bo góc |
| Hiệu ứng vào/ra (19) | pop, bounce, flip, typewriter, hiện từng từ, slide, zoom, wipe, blur, drop, spin… |
| Phụ đề | 6 mẫu (tiktok, bold_pop, pill, clean, reveal, neon): karaoke, từng từ, hiện dần; nguồn: word timing, SRT/VTT, whisper |
| Hiệu ứng (16) | glitch, RGB split, flash, film grain, zoom blur, vignette, VHS, letterbox, strobe, blur, b&w, invert, hue, brightness, contrast, saturate; áp cho từng clip hoặc cả video |
| Màu | 10 look (cinematic, warm, cool, vintage, bw, vivid, fade, teal_orange, moody, pastel), eq, LUT .cube, chromakey, chống rung, khử nhiễu |
| Bố cục | **fit "blur"** (video ngang trong khung dọc, nền mờ), cover/contain, focus để reframe, **mask** (tròn, elip, tim, sao, linear, mirror; feather, invert), viền theo hình mask, đổ bóng, bo góc, 10 blend mode, keyframe đầy đủ |
| Đồ hoạ | shape (rect, circle, star, heart, arrow, triangle, line), nền màu hoặc gradient, **Lottie** |
| Âm thanh | trộn nhiều track, ducking theo role, fade, automation volume, speed giữ cao độ, đảo ngược, chuẩn loudness 2-pass về -14 LUFS, TTS |
| Tự động | 5 template (promo, slideshow, beat_montage, quote, listicle), `snap_to_beats`, `remove_silence`, `add_voiceover` kèm phụ đề, `until_end` |
| Phân tích | beat/tempo/bar (FFT viết bằng TS), cắt cảnh, khoảng lặng, loudness, transcript |
| Xuất file | mp4 H.264 / **HEVC**, mov ProRes 422 / **ProRes 4444 có alpha**, webm VP9 (có alpha), mkv, gif, **chỉ audio** (wav/mp3/m4a/aac/flac) · render một đoạn |
| Chuyển cho người dựng | **FCPXML 1.10** (Final Cut Pro, khớp DTD chính thức) và **OpenTimelineIO** (DaVinci Resolve, Premiere, Avid): cắt, in-point, crossfade, speed, volume, title, connected clip; phần không chuyển được liệt kê trong `skipped` |

Chưa có (cần model AI): xoá phông, tự bám theo khuôn mặt khi reframe.

## Vì sao thân thiện với agent

| Tính năng | Lợi ích |
|---|---|
| Mỗi lệnh in đúng 1 JSON, có exit code 0/1/2/3 | Agent parse được kết quả, không phải đoán |
| Lỗi có `code`, `path`, `hint` ("did you mean 'crossfade'?") | Agent tự sửa sau một lần đọc lỗi |
| Batch nguyên tử: batch gây lỗi validation bị từ chối toàn bộ | Project lúc nào cũng render được |
| Template + preset + giá trị mặc định hợp lý | Op ngắn, tốn ít token |
| Magnetic timeline + `attach_to` + `until_end` + `at:"end-2"` | Không phải tự tính thời gian; cắt lại theo beat thì chữ vẫn đi theo clip |
| `info --text` (timeline dạng chữ gọn) | Đọc toàn bộ project với ít token |
| MCP trả ảnh thật (preview, contact sheet); render chạy nền có `render_status` | Agent nhìn được kết quả; MCP không bị timeout |
| Render trả về contact sheet và LUFS | Có bằng chứng để kiểm tra, không chỉ dựa vào exit code |
| `guide` · `schema` · `ops` · `capabilities` · `fonts` · `voices` | Tự mô tả: agent không phải đoán tên field |

## Vòng phản hồi từ agent (tự cải thiện)

Agent là người dùng chính, nên app có sẵn hai kênh để biết cần cải thiện gì:

1. **Agent chủ động ghi chú**: MCP `report_feedback` hoặc CLI `agentcut feedback add`. Dùng khi gặp lỗi, thiếu tính năng, phải làm vòng, thấy chậm, tài liệu khó hiểu, hay kết quả trông sai. Guide và hướng dẫn MCP đều nhắc agent làm việc này. Ghi chú trùng ý được **gộp và đếm**, nên càng nhiều agent gặp thì việc đó càng được đẩy lên đầu.
2. **Tự động ghi nhận** mọi lời gọi CLI/MCP:
   - lỗi theo mã;
   - **tên agent đoán sai** (ví dụ `fade_in` trong khi đúng là `fade`), từ đó gợi ý nên thêm alias;
   - batch bị từ chối và lý do;
   - lệnh chậm (p50/p95);
   - tốc độ render;
   - lỗi nội bộ.

```bash
agentcut feedback summary            # JSON: backlog xếp hạng + số liệu
agentcut feedback summary --md > IMPROVEMENTS.md   # báo cáo markdown cho dev/agent
agentcut feedback list               # các ghi chú đang mở
agentcut feedback resolve fb003      # đánh dấu đã xử lý
```

Dữ liệu chỉ lưu trên máy, tại `~/.agentcut/feedback`. Có thể đổi chỗ lưu bằng `AGENTCUT_HOME`. Đặt `AGENTCUT_TELEMETRY=0` để tắt phần tự động ghi nhận (ghi chú do agent viết vẫn hoạt động). Đường dẫn trong home được rút gọn thành `~`.

## Hiệu năng

Đo trên Apple Silicon 10 core, video 1080×1920, 12s, 4 track, có transition, hiệu ứng, mask, chữ:

| | Bản Python (cũ) | Bản TypeScript |
|---|---|---|
| Lệnh edit (`apply`, `info`, `undo`) | ~400 ms | **~33 ms** |
| Ghép frame, 1 luồng | ~20 fps | **~63 fps** |
| Render cả video (song song) | 13.7 s | **5.8 s** (2× realtime) |

Video template 7s (chữ có đổ bóng, 5 transition): ghép frame 39 → **116 fps**, render 6.4 s → **2.7 s**.
Preview qua MCP: một frame **~75 ms** (trước ~400 ms), contact sheet 12 ô **~0.6 s** (trước 1.4 s), ảnh nhẹ hơn ~6 lần (JPEG).

Các tối ưu chính:
- Skia chỉ được nạp khi cần vẽ.
- Đọc frame từ FFmpeg có back-pressure và double-buffer, không copy thừa.
- Frame đục toàn màn hình đi đường tắt `putImageData`.
- Nền mờ dựng từ canvas tí hon. Grain và vignette được cache, không dùng blend mode chậm. Nội suy bilinear.
- Decode phần cứng VideoToolbox chỉ bật cho nguồn ≥ 1440p (tốn ít hơn 2.6× CPU với 4K HEVC).
- Render chia đoạn chạy song song nhiều process rồi nối bằng concat không mã hoá lại.
- Âm thanh được mix song song với hình.
- Bước kiểm tra sau render (contact sheet, LUFS) chạy song song.
- Đổ bóng: hình bóng mờ độ phân giải thấp được cache (Skia blur bóng toàn khung mỗi frame tốn ~50 ms), hộp đục dùng bóng giải tích.
- Ảnh tĩnh và freeze frame: decode và upload lên canvas một lần.
- Các layer video/ảnh decode song song; contact sheet dùng nhiều renderer cùng lúc; preview là JPEG; kiểm tra font được memo.

## Kiến trúc

```
src/
  model.ts      schema, parse, validate (path + hint), magnetic/attach/until_end resolve
  ops.ts        op chỉnh sửa (batch nguyên tử) · ops-edit.ts: tách tiếng, J/L-cut, slip/roll/slide · ops-compound.ts
  presets.ts    mẫu chữ, phụ đề, template · export.ts: FCPXML / OTIO
  project.ts    thư mục project, lưu atomic, undo/redo, tóm tắt timeline
  render.ts     compositor Skia · effects.ts: hiệu ứng + mask · text.ts: layout chữ · anim.ts: easing/keyframe/transition
  media.ts      ffprobe + đọc frame từ FFmpeg (seek, speed, reverse, freeze, fit, filter)
  encode.ts     encoder + render song song (segment-worker.ts) · audio.ts: mixer + loudness
  analyze.ts    beat (FFT + DP), scene, silence, loudness, TTS, whisper
  fonts.ts      phân giải font + kiểm tra glyph · canvas.ts: nạp Skia lazy
  api.ts        lớp dùng chung · cli.ts: `agentcut` · mcp.ts: `agentcut-mcp` (28 tool)
  feedback.ts   ghi chú của agent + tự động ghi nhận + backlog xếp hạng
```

## Kiểm thử

```bash
bun tests/smoke.ts     # tự tạo media, chạy qua mọi op, template và định dạng xuất
bun tests/mcp.ts       # MCP client thật qua stdio
bun run test           # tất cả: smoke, mcp, edit-ops, compound, codecs, export
# kiểm chứng file xuất bằng OpenTimelineIO + DTD FCPXML (tuỳ chọn):
AGENTCUT_OTIO_PY=/path/venv/bin/python AGENTCUT_FCPXML_DTD=/path/FCPXMLv1_10.dtd bun tests/export.ts
AGENTCUT_BIN=$PWD/dist/cli.js bun tests/smoke.ts    # test bản build cho Node
AGENTCUT_BIN=$PWD/bin/agentcut bun tests/smoke.ts   # test file binary
```

Bản Python đầu tiên vẫn được giữ trong `legacy/python/` để tham khảo.
