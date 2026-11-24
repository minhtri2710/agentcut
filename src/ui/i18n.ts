// The page's words in English and Vietnamese. Ids, op names, field names and server messages are not translated.
// {0}, {1}... are filled in order by t().

const EN = {
  untitled: "untitled",
  rev: "rev {0} · {1}x{2} @{3}",
  issues: "{0} errors, {1} warnings",
  undo: "Undo", redo: "Redo", undoTitle: "undo: {0}", redoTitle: "redo: {0}",
  draft: "draft", render: "Render", sheet: "Contact sheet",
  play: "Play", stop: "Stop", preparing: "Preparing…", preparingPct: "Preparing {0}%",
  prepare: "Prepare", downloading: "Downloading {0} {1}/{2} MB",
  msPerFrame: "{0} ms/frame", frameFailed: "frame failed",
  selectClip: "Select a clip on the timeline.",
  selInfo: "{0} on {1} ({2})", insideCompound: " inside {0}: expand it to edit",
  applyClip: "Apply clip", deleteClip: "Delete clip", openCompound: "Open compound", expand: "Expand",
  group: "Group {0} clip(s)", regroup: "Regroup {0}",
  opsHint: "Ops batch (JSON list), applied atomically:", applyOps: "Apply ops",
  keyframes: "Keyframes", addKey: "+ key at playhead", clear: "clear", clearTitle: "remove all {0} keyframes",
  kfCols: "t (s) · value · easing into it", kfTime: "time from clip start", kfDelete: "delete this keyframe",
  applied: "applied (revision {0})", errorsRemain: ", {0} error(s) remain", nothingChanged: "nothing changed",
  undone: "undo done", redone: "redo done", prepared: "prepared",
  noState: "this page has not loaded the project yet",
  zoom: "zoom", timeline: "timeline", readOnly: " (read-only: expand to edit) ",
  tlHint: "drag = move, edges = trim, shift-click = multi-select, double-click compound = open, click ruler = seek",
  consentTitle: "Download a vision model?", consentNote: "Nothing is downloaded unless you confirm.",
  consentGo: "Download and prepare", cancel: "Cancel",
  output: "output: {0}", openFull: "open full size",
  clipLabel: "{0}, {1}, starts at {2} s", keyframeAt: "keyframe {0}s: {1}", transition: "transition {0}",
  language: "Language", clipJson: "clip JSON",
  media: "Media", search: "Search", importPath: "/path/to/file.mp4", importBtn: "Import",
  library: "Library", libHint: "Click an item to put it on the selected clip (an effect with nothing selected: the whole video), or drag it onto a clip; drag a text style onto a free lane for a new title.",
  transcript: "Transcript", txPick: "Select a video or audio clip that plays forward at one speed to see its words.", txGo: "Transcribe", txBusy: "Transcribing…",
  txHint: "Click a word to seek there, shift-click to pick a run of words; Cut (or Delete) removes their stretch from the clip.", txCut: "Cut words", txNone: "No words heard.",
  chat: "Chat", chatHint: "Ask the agent to edit this project (it uses Claude Code with AgentCut's tools only). Ctrl+Enter sends.", chatPlaceholder: "e.g. add a title HELLO for the first 2 seconds",
  chatSend: "Send", chatStop: "Stop", chatNew: "New chat", chatDone: "Done.", chatStopped: "Stopped.", chatMissing: "No agent CLI found: {0}",
  dashName: "new project folder", dashCreate: "Create", dashNone: "No projects in this folder yet.", dashOpen: "Open", dashDup: "Duplicate", dashDupGo: "Copy",
  lib_look: "Looks", lib_effect: "Effects", lib_transition: "Transitions", lib_text: "Text styles", lib_caption: "Caption styles",
  libNotFor: "{0} does not go on a {1} clip.", libPick: "Select a clip for {0} first.", libTitle: "Title",
  exportBtn: "Export…", exportTitle: "Export", format: "Format", codec: "Codec (mp4)", quality: "Quality", from: "From (s)", to: "To (s)",
  subtitles: "Subtitle track from the captions (mp4, mov, mkv, webm)", exportGo: "Export", qaOk: "QA: the written file matches the timeline", seekTo: "go to {0} s",
  formTab: "Form", jsonTab: "JSON", jsonOnly: "(JSON tab)", jsonEdit: "(custom value: JSON tab)",
  sec_clip: "Clip", sec_layer: "Layout and animation", sec_media: "Media", sec_audio: "Audio", sec_text: "Text", sec_captions: "Captions", sec_shape: "Shape",
  sec_color: "Colour", sec_lottie: "Lottie", sec_compound: "Compound",
  review: "Review", history: "History", runReview: "Run review", reviewing: "Reviewing…", clean: "No findings", findingsN: "{0} findings",
  forRevision: "revision {0}", staleReview: "the project changed since: run it again", undoTo: "undo this and every later edit", redoTo: "redo up to this edit",
  by: "by {0}", undoStack: "Edits (newest first): click to undo back to before one", redoStack: "Undone (click to redo up to one)",
  hide: "hide", mute: "mute", hideTrack: "hide track {0} (not drawn)", showTrack: "show track {0}", muteTrack: "mute track {0}", unmuteTrack: "unmute track {0}",
  dropHint: "Drop files here to copy them into media/; drag an item onto a track to add it.", uploading: "Uploading {0}…", noAssets: "No media yet.",
};
export type Key = keyof typeof EN;

const VI: Record<Key, string> = {
  untitled: "chưa đặt tên",
  rev: "rev {0} · {1}x{2} @{3}",
  issues: "{0} lỗi, {1} cảnh báo",
  undo: "Hoàn tác", redo: "Làm lại", undoTitle: "hoàn tác: {0}", redoTitle: "làm lại: {0}",
  draft: "nháp", render: "Xuất video", sheet: "Ảnh tổng quan",
  play: "Phát", stop: "Dừng", preparing: "Đang chuẩn bị…", preparingPct: "Đang chuẩn bị {0}%",
  prepare: "Chuẩn bị", downloading: "Đang tải {0} {1}/{2} MB",
  msPerFrame: "{0} ms/khung", frameFailed: "không lấy được khung hình",
  selectClip: "Chọn một clip trên timeline.",
  selInfo: "{0} trên {1} ({2})", insideCompound: " trong {0}: bung nó ra để sửa",
  applyClip: "Áp dụng clip", deleteClip: "Xóa clip", openCompound: "Mở compound", expand: "Bung ra",
  group: "Gộp {0} clip", regroup: "Gộp lại {0}",
  opsHint: "Lô op (danh sách JSON), áp dụng trọn gói:", applyOps: "Áp dụng op",
  keyframes: "Keyframe", addKey: "+ key tại đầu phát", clear: "xóa hết", clearTitle: "xóa mọi keyframe {0}",
  kfCols: "t (s) · giá trị · easing vào nó", kfTime: "thời điểm tính từ đầu clip", kfDelete: "xóa keyframe này",
  applied: "đã áp dụng (revision {0})", errorsRemain: ", còn {0} lỗi", nothingChanged: "không có gì thay đổi",
  undone: "đã hoàn tác", redone: "đã làm lại", prepared: "đã chuẩn bị xong",
  noState: "trang này chưa tải được project",
  zoom: "thu phóng", timeline: "dòng thời gian", readOnly: " (chỉ xem: bung ra để sửa) ",
  tlHint: "kéo = di chuyển, mép = cắt, shift-click = chọn nhiều, nhấp đúp compound = mở, bấm thước = tua",
  consentTitle: "Tải model thị giác?", consentNote: "Không tải gì nếu bạn chưa xác nhận.",
  consentGo: "Tải và chuẩn bị", cancel: "Hủy",
  output: "kết quả: {0}", openFull: "mở cỡ đầy đủ",
  clipLabel: "{0}, {1}, bắt đầu ở {2} s", keyframeAt: "keyframe {0}s: {1}", transition: "chuyển cảnh {0}",
  language: "Ngôn ngữ", clipJson: "JSON của clip",
  media: "Media", search: "Tìm", importPath: "/đường/dẫn/tệp.mp4", importBtn: "Nhập",
  library: "Thư viện", libHint: "Bấm một mục để áp lên clip đang chọn (hiệu ứng khi không chọn gì: cả video), hoặc kéo nó lên một clip; kéo kiểu chữ lên chỗ trống của track để thêm tiêu đề.",
  transcript: "Lời thoại", txPick: "Chọn một clip video hoặc âm thanh chạy xuôi ở một tốc độ để xem lời của nó.", txGo: "Nhận dạng lời", txBusy: "Đang nhận dạng…",
  txHint: "Bấm một từ để tua tới đó, shift-click để chọn một đoạn từ; Cắt (hoặc Delete) bỏ đoạn đó khỏi clip.", txCut: "Cắt các từ", txNone: "Không nghe thấy lời nào.",
  chat: "Trò chuyện", chatHint: "Nhờ agent sửa project này (dùng Claude Code, chỉ với các tool của AgentCut). Ctrl+Enter để gửi.", chatPlaceholder: "vd. thêm tiêu đề HELLO trong 2 giây đầu",
  chatSend: "Gửi", chatStop: "Dừng", chatNew: "Cuộc mới", chatDone: "Xong.", chatStopped: "Đã dừng.", chatMissing: "Không thấy CLI agent: {0}",
  dashName: "thư mục project mới", dashCreate: "Tạo", dashNone: "Thư mục này chưa có project.", dashOpen: "Mở", dashDup: "Nhân bản", dashDupGo: "Chép",
  lib_look: "Màu (look)", lib_effect: "Hiệu ứng", lib_transition: "Chuyển cảnh", lib_text: "Kiểu chữ", lib_caption: "Kiểu phụ đề",
  libNotFor: "{0} không dùng được cho clip {1}.", libPick: "Chọn một clip cho {0} trước.", libTitle: "Tiêu đề",
  exportBtn: "Xuất tệp…", exportTitle: "Xuất tệp", format: "Định dạng", codec: "Codec (mp4)", quality: "Chất lượng", from: "Từ (s)", to: "Đến (s)",
  subtitles: "Kèm phụ đề từ captions (mp4, mov, mkv, webm)", exportGo: "Xuất", qaOk: "QA: tệp đã ghi khớp với timeline", seekTo: "tới {0} s",
  formTab: "Biểu mẫu", jsonTab: "JSON", jsonOnly: "(tab JSON)", jsonEdit: "(giá trị riêng: tab JSON)",
  sec_clip: "Clip", sec_layer: "Bố cục và chuyển động", sec_media: "Media", sec_audio: "Âm thanh", sec_text: "Chữ", sec_captions: "Phụ đề", sec_shape: "Hình",
  sec_color: "Màu", sec_lottie: "Lottie", sec_compound: "Compound",
  review: "Kiểm tra", history: "Lịch sử", runReview: "Chạy kiểm tra", reviewing: "Đang kiểm tra…", clean: "Không có vấn đề", findingsN: "{0} vấn đề",
  forRevision: "revision {0}", staleReview: "project đã đổi từ lúc đó: chạy lại", undoTo: "hoàn tác bước này và mọi bước sau", redoTo: "làm lại tới bước này",
  by: "bởi {0}", undoStack: "Các bước sửa (mới nhất trước): bấm để hoàn tác về trước một bước", redoStack: "Đã hoàn tác (bấm để làm lại tới một bước)",
  hide: "ẩn", mute: "tắt", hideTrack: "ẩn track {0} (không vẽ)", showTrack: "hiện track {0}", muteTrack: "tắt tiếng track {0}", unmuteTrack: "bật tiếng track {0}",
  dropHint: "Thả tệp vào đây để chép vào media/; kéo một mục lên track để thêm.", uploading: "Đang tải lên {0}…", noAssets: "Chưa có media.",
};

export type Lang = "en" | "vi";
const TABLES: Record<Lang, Record<Key, string>> = { en: EN, vi: VI };
const STORE = "agentcut.lang";
// typed here: tests/ui.ts imports this module (through text.ts) under bun, where there is no DOM and no localStorage
const ls = (globalThis as { localStorage?: { getItem(k: string): string | null; setItem(k: string, v: string): void } }).localStorage;

let lang: Lang = (() => { try { return ls?.getItem(STORE) === "vi" ? "vi" : "en"; } catch { return "en"; } })();

export const getLang = (): Lang => lang;
/** switch the page's language; remembered by this browser */
export function setLang(l: Lang) {
  lang = l;
  try { ls?.setItem(STORE, l); } catch { /* the choice lasts for this page only */ }
}

/** the text of a key in the page's language, {n} filled from args */
export function t(k: Key, ...args: (string | number)[]): string {
  return TABLES[lang][k].replace(/\{(\d+)\}/g, (_, i: string) => String(args[+i] ?? ""));
}
