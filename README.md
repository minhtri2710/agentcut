# AgentCut

**Trình dựng video dành cho AI agent**, có các tính năng của CapCut và Final Cut nhưng không có GUI bắt buộc. Agent điều khiển qua **CLI**
(`agentcut …`) hoặc **MCP** (`agentcut-mcp`), dựng video bằng timeline JSON, *nhìn* được kết quả (preview frame, contact sheet,
scopes, waveform) trước khi xuất file, và có thể giao lại cho người dựng bằng FCPXML / OpenTimelineIO.

Viết bằng **TypeScript**, chạy bằng Bun hoặc Node ≥ 20. Đồ hoạ dùng **Skia** (`@napi-rs/canvas`), video dùng **FFmpeg**.
Chạy trên **macOS, Windows và Linux**. Phiên bản hiện tại: 0.3.0 (MIT).

```
agent ──(MCP / CLI · JSON)──▶ ops / templates (add_clip, apply_template, add_captions, snap_to_beats…)
                               │ batch nguyên tử · validate kèm gợi ý sửa · undo/redo · revision + author
                               ▼
                         project.json  (tracks → clips)  ◀── agentcut ui (người dùng sửa cùng lúc)
              ┌────────────────┼──────────────────┬───────────────────────┐
              ▼                ▼                  ▼                       ▼
       preview_frame     contact_sheet      review / audio_check     render (N process song song, nối không mất chất lượng)
        scopes (JPEG)     (lưới frame)       motion_strip             mp4 · mov · webm · mkv · gif · audio · png/webp + sheet + LUFS
                                                                     export_timeline → FCPXML / OTIO
```

Tài liệu đầy đủ cho agent nằm ở [AGENTS.md](AGENTS.md) (cũng in ra bằng `agentcut guide` hoặc tool MCP `guide`). README này là phần tổng quan cho người.

## Cài đặt

Cần **FFmpeg ≥ 5.1** (kèm `ffprobe` trên PATH). `-fps_mode` cần 5.1; các filter `asegment` và `huesaturation` có từ 5.0. Bản cũ hơn bị từ chối với lỗi `missing_dependency`.

| Hệ điều hành | Cài FFmpeg |
|---|---|
| macOS | `brew install ffmpeg` |
| Windows | `winget install Gyan.FFmpeg` |
| Linux | `sudo apt install ffmpeg` (hoặc dnf/pacman) |

Kiểm tra bằng `ffmpeg -version`. Nếu gói của bản phân phối quá cũ (ví dụ 4.4 trên Ubuntu 22.04), nâng cấp gói hoặc tải build mới tại https://ffmpeg.org/download.html và đặt `ffmpeg` / `ffprobe` mới lên đầu PATH. Các build git/không nhận diện được phiên bản được phép chạy nhưng không được đảm bảo tương thích.

Sau đó chọn **một** trong ba cách:

**Cách 1: Node ≥ 20 (npm)**
```bash
git clone https://github.com/minhtri2710/agentcut && cd agentcut
bun install && bun run build      # tạo dist/cli.js và dist/mcp.js
npm install -g .                  # hoặc: npm link
agentcut guide
```

**Cách 2: file binary (không cần cài Node hay Bun để chạy)**
```bash
bun install && bun run build -- --compile   # tạo bin/agentcut; MCP: bin/agentcut mcp
```
Muốn binary cho hệ điều hành khác thì build trên chính máy đó, vì Skia là thư viện native.

**Cách 3: Bun, chạy thẳng từ source (để phát triển)**
```bash
bun install
scripts/ac guide
```
`scripts/ac` (và lệnh trong [.mcp.json](.mcp.json)) chạy Bun với `--no-install --no-env-file --config=scripts/bunfig.empty.toml`, nên không đọc `bunfig.toml` / `.env` ở thư mục hiện tại và không tự cài package.

Thư mục project phải nằm trên volume có hard link (APFS, NTFS, ext4; không phải exFAT/FAT), nếu không sẽ lỗi `unsupported_fs`. File media thì để ở đâu cũng được.

### Thành phần tuỳ chọn

`agentcut capabilities` (mục `engines`) cho biết engine nào đang dùng được trên máy.

| Tính năng | Cần gì |
|---|---|
| Giọng đọc (TTS) — giọng hệ thống | macOS có sẵn `say` (giọng tiếng Việt `Linh`); Windows dùng SAPI có sẵn; Linux cần `espeak-ng` |
| TTS — piper (neural, chạy local) | `piper` trên PATH + `AGENTCUT_PIPER_MODEL=/path/voice.onnx` (hoặc `voice: "piper:/path/vi.onnx"`) |
| TTS — HTTP tương thích OpenAI | `AGENTCUT_TTS_URL` (ví dụ `http://localhost:8880/v1`) và/hoặc `AGENTCUT_TTS_KEY`; tuỳ chọn `AGENTCUT_TTS_MODEL` (mặc định `tts-1`), `AGENTCUT_TTS_VOICE` (mặc định `alloy`) |
| Phụ đề tự động (transcribe) | `whisper-cli` (whisper.cpp, `brew install whisper-cpp`) + `AGENTCUT_WHISPER_MODEL=/path/ggml-*.bin`, hoặc `pip install openai-whisper` |
| AI vision (xoá phông, reframe theo khuôn mặt, tracking) | [`uv`](https://docs.astral.sh/uv/) (hoặc `AGENTCUT_UV=/path/uv`). uv tự lấy Python 3.12/3.13 và các package khi chạy lần đầu; model chỉ tải khi có `--allow-download` (xem [AI vision](#ai-vision-tuỳ-chọn)) |

## Kết nối agent

**Claude Code:**
```bash
claude mcp add agentcut -- agentcut-mcp
```
Khi mở repo này trong Claude Code thì file [.mcp.json](.mcp.json) (chạy MCP từ source) và skill [.claude/skills/agentcut](.claude/skills/agentcut/SKILL.md) đã được cấu hình sẵn.

**Claude Desktop, Cursor, Windsurf và các MCP client khác:**
```json
{ "mcpServers": { "agentcut": { "command": "agentcut-mcp" } } }
```
Nếu dùng binary thì đổi thành `{ "command": "/path/bin/agentcut", "args": ["mcp"] }`.

**Agent chỉ có shell** (Codex CLI, Aider, script…): dùng thẳng CLI. Mỗi lệnh in ra đúng một object JSON. Bắt đầu bằng `agentcut guide`.

MCP server chạy qua stdio, có **38 tool** (bằng với CLI): `guide`, `capabilities`, `ops_reference`, `timeline_schema`, project (`create_project`, `open_project`, `project_info`, `apply_ops`, `validate`, `undo`, `redo`), xem và kiểm tra (`preview_frame`, `contact_sheet`, `scopes`, `review`, `audio_check`, `motion_strip`, `view_image`), xuất (`render`, `render_status`, `cancel_job`, `export_timeline`, `export_captions`), vision (`prepare`, `analyze_subject`, `cache`), phân tích (`probe_media`, `analyze_beats`, `analyze_scenes`, `analyze_silence`, `measure_loudness`, `transcribe`), giọng và font (`tts`, `list_voices`, `list_fonts`) và feedback (`report_feedback`, `feedback_summary`, `resolve_feedback`). Các tool preview trả về ảnh thật; `render` và `prepare` chạy nền, trả `job_id` để hỏi bằng `render_status`.

## Ví dụ: video promo 9:16 chỉ với một lệnh

```bash
agentcut init promo --preset reels && cd promo        # trả về "revision": 0
agentcut op apply_template name=promo --author my-agent --revision 0 --json '{
  "media": ["/abs/hero.mp4", "/abs/detail.jpg", "/abs/usage.mp4"],
  "hook": "Ra mắt sản phẩm mới", "points": ["Nhẹ hơn 30%", "Pin 2 ngày"],
  "cta": "Mua ngay", "music": "/abs/song.mp3"}'
agentcut info --text              # timeline dạng chữ gọn
agentcut sheet --guides           # agent xem contact sheet (có vùng an toàn 9:16)
agentcut review                   # lint: chữ ngoài vùng an toàn, shot quá ngắn, frame đen…
agentcut render --draft           # bản nháp nhanh (nửa độ phân giải)
agentcut render -o final.mp4      # bản cuối, kèm contact sheet và số đo LUFS
```

Template sinh ra các clip bình thường, nên agent sửa tiếp được: đổi chữ, thay clip, thêm hiệu ứng, `undo`. Có 5 template: `promo`, `slideshow`, `beat_montage`, `quote`, `listicle` (tham số: `agentcut capabilities`). Thêm ví dụ trong [examples/](examples/).

### Revision và author

Mọi lệnh ghi vào lịch sử (`apply`, `op`, `add`, `set`, `rm`, `undo`, `redo`, `beats --markers`; MCP: `apply_ops`, `undo`, `redo`) đều bắt buộc có `--revision N`: revision bạn đọc lần cuối, lấy từ `agentcut info` hoặc từ `revision` trong kết quả của lệnh trước (`init` trả về 0). Thiếu thì lệnh lỗi `missing_revision`; nếu project đã đổi, lệnh lỗi `conflict`, nêu ai đã đổi gì, và không sửa gì cả. Dry run, lệnh chỉ đọc và `prepare` không cần revision.

Trên CLI, các lệnh đó (và `prepare`) còn cần `--author NAME` hoặc biến `AGENTCUT_AUTHOR`; thiếu thì lỗi `missing_author`. Tên tác giả được ghi vào lịch sử (`agentcut history`), để người và agent biết ai đã sửa gì. Qua MCP, author là tên client khai báo khi kết nối.

## Tính năng so với CapCut / Final Cut

| Nhóm | AgentCut |
|---|---|
| Dựng | magnetic timeline (Final Cut), **connected clips** (`attach_to`), `match_duration`, `until_end`, gap, split, trim, freeze frame, reverse, loop, speed, **speed ramp** (keyframe tốc độ), duplicate, marker, nhiều track, undo/redo |
| Dựng chuyên nghiệp | **tách tiếng** (`detach_audio` / `attach_audio`), **J-cut / L-cut**, **slip / roll / slide**, **compound clip** (`make_compound` / `expand_compound`, regroup); split/trim giữ tiếng đã tách luôn khớp hình |
| Loại clip (10) | video, image, text, captions, shape, color (solid/gradient), lottie, audio, gap, compound |
| Transition (22) | crossfade, dip đen/trắng, **flash, glitch, zoom blur, spin**, zoom, circle, blur, slide/push/wipe theo 4 hướng |
| Chữ | **10 mẫu chữ** (title_bold, subtitle_box, neon, gradient, lower_third, quote, typewriter, sticker, outline, cinematic), font hệ thống bất kỳ, tự lấy glyph từ font khác khi thiếu dấu tiếng Việt, chữ CJK, emoji, stroke, glow, gradient, nền bo góc |
| Hiệu ứng vào/ra (19) | fade, pop, bounce, flip, typewriter, hiện từng từ, slide/wipe 4 hướng, zoom in/out, blur, drop, spin |
| Chuyển động (11) | ken_burns, ken_burns_out, zoom_slow, pan 4 hướng, pulse, float, sway, shake |
| Phụ đề | 6 mẫu (tiktok, bold_pop, pill, clean, reveal, neon), 4 kiểu (karaoke, word, reveal, line); nguồn: word timing, SRT/VTT, whisper (bám theo các clip đã cắt); xuất `.srt`/`.vtt` hoặc track phụ đề mềm trong video |
| Hiệu ứng (16) | glitch, RGB split, flash, film grain, zoom blur, vignette, VHS, letterbox, strobe, blur, b&w, invert, hue, brightness, contrast, saturate; áp cho từng clip hoặc cả video, có cửa sổ thời gian |
| Màu | 10 look (cinematic, warm, cool, vintage, bw, vivid, fade, teal_orange, moody, pastel), exposure, contrast, saturation, vibrance, temperature/tint, lift/gamma/gain, curves, HSL theo dải màu; filter: eq, LUT .cube, chromakey, chống rung, khử nhiễu, sharpen, lật; nguồn HDR (PQ/HLG) và BT.2020 được chuyển về BT.709; file xuất gắn tag BT.709 |
| Bố cục | **fit "blur"** (video ngang trong khung dọc, nền mờ), cover/contain/fill/none, focus để reframe, **mask** (rect, tròn, elip, tim, sao, linear, mirror; feather, invert), viền theo mask, đổ bóng, bo góc, 10 blend mode, keyframe đầy đủ (x, y, scale, rotation, opacity, blur, volume, speed, focus) |
| Đồ hoạ | 8 shape (rect, circle, ellipse, star, heart, arrow, triangle, line), nền màu hoặc gradient, **Lottie** |
| Âm thanh | trộn nhiều track, ducking theo role (nhạc -20 dB dưới giọng), fade, automation volume, speed giữ cao độ, đảo ngược, denoise, EQ (preset hoặc band), compressor, pan, pitch, normalize, `enhance_voice` một lệnh, track làm bus, chuẩn loudness 2-pass về -14 LUFS |
| Giọng đọc | `add_voiceover` (TTS từng câu, kèm phụ đề khớp thời gian thật), 3 provider: giọng hệ thống, piper, HTTP tương thích OpenAI |
| AI vision (tuỳ chọn) | **xoá phông** (`remove_background`, 5 model matte), **auto reframe** theo khuôn mặt (YuNet) hoặc vùng nổi bật, **track_to** (chữ/overlay bám theo vật thể) |
| Tự động | 5 template, `snap_to_beats`, `remove_silence`, `add_voiceover`, `add_sequence`, `until_end` |
| Phân tích | beat/tempo/bar (FFT viết bằng TS), cắt cảnh, khoảng lặng, loudness, transcript, chủ thể (`analyze_subject`) |
| Tự kiểm tra | contact sheet, preview frame (guides), **scopes** (waveform, vectorscope, histogram + số đo), **review** (lint biên tập có mốc thời gian), **audio_check** (ảnh waveform + mix + spectrogram, clipping, true peak, khoảng lặng, nhạc chưa duck), **motion_strip** (10 frame liên tiếp mỗi transition) |
| Xuất file | mp4 H.264 / **HEVC**, mov ProRes 422 / **ProRes 4444 có alpha**, webm VP9 (có alpha), mkv, gif, **chỉ audio** (wav/mp3/m4a/aac/flac), **một frame** png/webp (giữ alpha) · render một đoạn (`--start/--end`) |
| Chuyển cho người dựng | **FCPXML 1.10** (Final Cut Pro, khớp DTD chính thức) và **OpenTimelineIO** (DaVinci Resolve, Premiere, Avid): cắt, in-point, crossfade, speed, title, connected clip, volume (chỉ FCPXML); phần không chuyển được liệt kê trong `skipped` (không xuất) và `approximated` (xuất dưới dạng khác) |
| Làm việc cùng người | `agentcut ui`: web UI local (timeline, viewer, inspector, keyframe, compound, prepare, render); sửa trên UI và của agent cùng vào một `project.json`, có kiểm tra revision |

Danh sách đầy đủ, đúng tên field: `agentcut capabilities`, `agentcut schema`, `agentcut ops` (41 op).

## AI vision (tuỳ chọn)

`auto_reframe`, `remove_background` và `track_to` chỉ ghi lại yêu cầu (`pending`) nên chạy ngay. Phần tính toán chạy riêng:

```bash
agentcut op remove_background id=vid2 model=u2net_human_seg --author me --revision 3
agentcut prepare --status                         # model nào cần tải, dung lượng bao nhiêu
agentcut prepare --allow-download --author me     # tải model (kiểm tra sha256), tính matte/track, ghi keyframe
```

Cho tới khi `prepare` chạy xong, preview và render video lỗi ngay với mã `not_prepared` (render chỉ audio thì không). Helper Python chạy qua `uv run`, không bao giờ tự tải gì; AgentCut tự tải model và kiểm tra sha256 + kích thước đã ghim. Model nằm ở `~/.cache/agentcut/models` (đổi bằng `AGENTCUT_CACHE`), kết quả cache trong `.agentcut/cache` của project; dọn bằng `agentcut cache prune`. Không cài uv thì các op này lỗi `missing_dependency`.

## Vì sao thân thiện với agent

| Tính năng | Lợi ích |
|---|---|
| Mỗi lệnh in đúng 1 JSON, exit code 0 ok · 1 lỗi edit/validate · 2 sai cú pháp · 3 lỗi nội bộ | Agent parse được kết quả, không phải đoán |
| Lỗi có `code`, `path`, `hint` ("did you mean 'crossfade'?"); field lạ bị từ chối, không bị lờ đi | Agent tự sửa sau một lần đọc lỗi |
| Batch nguyên tử: batch gây lỗi validation bị từ chối toàn bộ | Project lúc nào cũng render được |
| Revision + author trên mọi lệnh ghi | Agent và người (hoặc nhiều agent) không ghi đè lên nhau; `conflict` nói rõ ai đã đổi gì |
| Template + preset + giá trị mặc định hợp lý | Op ngắn, tốn ít token |
| Magnetic timeline + `attach_to` + `match_duration` + `until_end` + `at:"end-2"` | Không phải tự tính thời gian; cắt lại theo beat thì chữ vẫn đi theo clip |
| `info --text` (timeline dạng chữ gọn) | Đọc toàn bộ project với ít token |
| MCP trả ảnh thật (preview, contact sheet, scopes, waveform); render/prepare chạy nền có `render_status` | Agent nhìn được kết quả; MCP không bị timeout |
| `review`, `audio_check`, `motion_strip` | Kiểm tra được những gì một frame tĩnh không cho thấy |
| Render trả về contact sheet và LUFS | Có bằng chứng để kiểm tra, không chỉ dựa vào exit code |
| `guide` · `schema` · `ops` · `capabilities` · `fonts` · `voices` | Tự mô tả: agent không phải đoán tên field |
| Ctrl-C / SIGTERM dừng lệnh, dọn file tạm và vẫn in một JSON (`aborted`) | Agent luôn biết lệnh đã dừng vì sao |

## Lệnh CLI

| Nhóm | Lệnh |
|---|---|
| Project | `init DIR [--preset reels\|youtube\|square\|portrait\|4k]` · `info [--text]` · `validate` · `undo [n]` · `redo [n]` · `history` |
| Sửa | `apply FILE\|- [--dry-run]` · `op NAME key=value…` · `add key=value…` · `set ID key=value…` · `rm ID [--ripple]` |
| Xem | `frame T [--guides]` · `sheet [--every 1\|--times a,b\|--count 12] [--guides]` · `scopes T` |
| Kiểm tra | `review [--beats music]` · `audio [--spectrogram]` · `motion [--start S --end S]` |
| Vision | `prepare [--status] [--allow-download]` · `subject F` · `cache [info\|prune]` |
| Xuất | `render [-o out.mp4…] [--draft] [--codec …] [--subtitles] [--start S --end S]` · `captions -o subs.srt` · `export -o edit.fcpxml\|edit.otio` |
| Phân tích | `probe F` · `beats F [--full] [--markers]` · `scenes F` · `silence F` · `loudness F` · `transcribe F [--language vi]` |
| Giọng / font | `tts "text" -o out.wav [--voice Linh]` · `voices [--lang vi]` · `fonts [query]` |
| Người dùng | `ui [DIR] [--port 4810]` |
| Tham chiếu | `guide` · `schema` · `ops` · `capabilities` · `mcp` |
| Feedback | `feedback add\|summary\|list\|resolve` |

Cờ chung: `-p/--project DIR` (hoặc `AGENTCUT_PROJECT`, hoặc thư mục gần nhất có `project.json`), `--pretty`. Chi tiết từng cờ: `agentcut help`.

## Làm việc cùng người: `agentcut ui`

```bash
agentcut ui promo --port 4810    # mở http://127.0.0.1:4810/
```

Web UI chỉ nghe trên `127.0.0.1`: timeline, viewer, inspector, trình sửa keyframe, mở/tách/gộp compound, prepare, render. Mọi thao tác trên UI đi qua cùng API với kiểm tra revision, nên trang cũ nhận `conflict` thay vì ghi đè việc của agent; thay đổi do CLI/MCP ghi được server phát hiện và đẩy lên trang qua Server-Sent Events. Mô hình bảo mật của UI và các ranh giới tin cậy khác: [SECURITY_MODEL.md](SECURITY_MODEL.md).

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

## Biến môi trường

| Biến | Ý nghĩa |
|---|---|
| `AGENTCUT_PROJECT` | Project mặc định khi không có `-p` |
| `AGENTCUT_AUTHOR` | Tên tác giả cho các lệnh CLI ghi lịch sử (thay cho `--author`) |
| `AGENTCUT_HOME` | Thư mục dữ liệu người dùng (mặc định `~/.agentcut`: feedback, cache font) |
| `AGENTCUT_TELEMETRY=0` | Tắt tự động ghi nhận lời gọi |
| `AGENTCUT_CACHE` | Thư mục cache model vision (mặc định `~/.cache/agentcut`) |
| `AGENTCUT_UV` | Đường dẫn tới `uv` |
| `AGENTCUT_PREVIEWS_MAX_MB` | Giới hạn thư mục `previews/` (mặc định 200; 0 = tắt) |
| `AGENTCUT_TTS_PROVIDER` | Provider TTS mặc định: `system`, `piper`, `openai` |
| `AGENTCUT_TTS_URL` / `AGENTCUT_TTS_KEY` / `AGENTCUT_TTS_MODEL` / `AGENTCUT_TTS_VOICE` | TTS HTTP tương thích OpenAI |
| `AGENTCUT_PIPER_MODEL` | Model `.onnx` cho piper |
| `AGENTCUT_WHISPER_MODEL` | Model `ggml-*.bin` cho whisper.cpp |
| `AGENTCUT_HWACCEL=0` | Tắt decode phần cứng VideoToolbox (macOS) |

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
- Skia chỉ được nạp khi cần vẽ (lệnh edit không bao giờ nạp).
- Đọc frame từ FFmpeg có back-pressure và double-buffer, không copy thừa.
- Frame đục toàn màn hình đi đường tắt `putImageData`.
- Nền mờ dựng từ canvas tí hon. Grain và vignette được cache, không dùng blend mode chậm. Nội suy bilinear.
- Decode phần cứng VideoToolbox (macOS) chỉ bật cho nguồn ≥ 1440p (tốn ít hơn 2.6× CPU với 4K HEVC).
- Render chia đoạn chạy song song nhiều process rồi nối bằng concat không mã hoá lại.
- Âm thanh được mix song song với hình.
- Bước kiểm tra sau render (contact sheet, LUFS) chạy song song.
- Đổ bóng: hình bóng mờ độ phân giải thấp được cache (Skia blur bóng toàn khung mỗi frame tốn ~50 ms), hộp đục dùng bóng giải tích.
- Ảnh tĩnh và freeze frame: decode và upload lên canvas một lần.
- Các layer video/ảnh decode song song; contact sheet dùng nhiều renderer cùng lúc; preview là JPEG; kiểm tra font được memo.

Công cụ đo: `bun scripts/profile-frames.ts <project>`, `bun scripts/profile-layers.ts <project>`, `bun scripts/bench-ops.ts`.

## Kiến trúc

Một project là một thư mục: `project.json` (timeline) + `media/`, `renders/`, `previews/`, `fonts/` và `.agentcut/` (lịch sử undo/redo, cache, file tạm).

```
src/
  model.ts       schema, parse, validate (path + hint), resolve magnetic / attach_to / until_end / match_duration
  ops.ts         op chỉnh sửa (batch nguyên tử) · ops-edit.ts: tách tiếng, J/L-cut, slip/roll/slide
                 ops-compound.ts: compound clip · ops-audio.ts: enhance_voice · ops-vision.ts: reframe, xoá phông, track_to
  presets.ts     mẫu chữ, phụ đề, template · captions.ts: word timing, SRT/VTT · subtitles.ts: xuất .srt/.vtt, track phụ đề mềm
  project.ts     thư mục project, lưu atomic, revision, undo/redo, tóm tắt timeline · safe-write.ts: mọi lệnh ghi file
  render.ts      compositor Skia · effects.ts: hiệu ứng + mask · text.ts: layout chữ · anim.ts: easing/keyframe/transition
  color.ts       grade màu -> filter FFmpeg · safe.ts: vùng an toàn cho chữ
  media.ts       ffprobe + đọc frame từ FFmpeg (seek, speed, reverse, freeze, fit, filter, quản lý màu) · ffinput.ts
  encode.ts      encoder + render song song (segment-worker.ts) · audio.ts: mixer + loudness · audiofx.ts: denoise/EQ/compressor/pan/pitch
  analyze.ts     beat (FFT + DP), scene, silence, loudness, TTS hệ thống, whisper · tts.ts: piper + HTTP OpenAI
  inspect.ts     review (lint) + motion strip · inspect-audio.ts: audio_check · scopes.ts: waveform/vectorscope/histogram
  vision.ts      AI vision qua `uv run` (vision-py.ts: helper Python), tải model có sha256 · prepare.ts · cache.ts
  export.ts      FCPXML / OTIO
  fonts.ts       phân giải font + kiểm tra glyph · canvas.ts: nạp Skia lazy
  api.ts         lớp dùng chung · cli.ts: `agentcut` · mcp.ts: `agentcut-mcp` (38 tool) · jobs.ts: job nền
  ui.ts          `agentcut ui` (server local) · ui/: trang web (build thành ui/page.gen.ts bằng `bun run ui`)
  feedback.ts    ghi chú của agent + tự động ghi nhận + backlog xếp hạng
  docs.ts        nội dung `agentcut guide`; AGENTS.md sinh từ đây bằng `bun run docs`
```

`api.ts` dùng chung cho CLI và MCP, nên tính năng mới chỉ cần thêm một lần. Hướng dẫn cho người phát triển (thêm op, quy tắc hiệu năng, hợp đồng của CLI): [CLAUDE.md](CLAUDE.md).

## Phát triển và kiểm thử

```bash
bun install
bun run typecheck          # tsc cho src/ và src/ui (trang web)
bun run test               # tất cả suite, lần lượt; suite lỗi không che các suite sau
bun --no-install tests/smoke.ts   # một suite: tự tạo media, chạy qua mọi op, template và định dạng xuất
bun run build              # dist/ cho Node ≥ 20 · bun run build -- --compile -> bin/agentcut
bun run ui                 # build lại src/ui/page.gen.ts (bun run ui --check: báo lỗi nếu file đã commit bị cũ)
bun run docs               # sinh lại AGENTS.md từ src/docs.ts
```

Các suite của `bun run test`: ffmpeg-version, smoke, mcp, edit-ops, compound, codecs, frames, export, ui, audio, color-tts, verify, writes, vision, review, jobs, ui-browser, realmedia, launchers.

- Cần `TMPDIR` riêng cho từng user (ví dụ `TMPDIR=$HOME/.tmp-agentcut bun run test`), vì helper vision từ chối cache trong thư mục tạm dùng chung.
- `ui-browser` cần macOS và `/usr/bin/sandbox-exec`; `realmedia` cần `say` của macOS. Trên Linux/Windows hai suite này lỗi.
- Test dùng `AGENTCUT_HOME` riêng, không đụng dữ liệu feedback thật.

```bash
# kiểm chứng file xuất bằng OpenTimelineIO + DTD FCPXML (tuỳ chọn):
AGENTCUT_OTIO_PY=/path/venv/bin/python AGENTCUT_FCPXML_DTD=/path/FCPXMLv1_10.dtd bun tests/export.ts
AGENTCUT_BIN=$PWD/dist/cli.js bun tests/smoke.ts    # test bản build cho Node
AGENTCUT_BIN=$PWD/bin/agentcut bun tests/smoke.ts   # test file binary
```

Bản Python đầu tiên vẫn được giữ trong `legacy/python/` để tham khảo; không sửa và không dùng.

## Giấy phép

MIT.
