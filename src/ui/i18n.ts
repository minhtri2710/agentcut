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
