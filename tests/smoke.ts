// End-to-end smoke test: generates synthetic media, exercises every op + template + export format through the CLI.
// Run: bun tests/smoke.ts [--keep]          (needs ffmpeg on PATH)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = process.env.AGENTCUT_BIN ? [process.env.AGENTCUT_BIN] : [process.execPath, resolve(import.meta.dir, "../src/cli.ts")];
let failures = 0;
const t0 = performance.now();

function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}
function cli(args: (string | number)[], o: { ok?: boolean; cwd?: string } = {}): any {
  const r = spawnSync(CLI[0], [...CLI.slice(1), ...args.map(String)], { encoding: "utf8", cwd: o.cwd, env: { ...process.env, AGENTCUT_DEBUG: "1" } });
  let out: any;
  try { out = JSON.parse(r.stdout); } catch { throw new Error(`non-JSON output for ${args.join(" ")}: ${r.stdout.slice(0, 300)} ${r.stderr.slice(-800)}`); }
  if ((o.ok ?? true) && !out.ok) throw new Error(`${args.join(" ")} failed: ${JSON.stringify(out).slice(0, 900)}`);
  return out;
}
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); }
}

const tmp = mkdtempSync(join(tmpdir(), "agentcut-smoke-"));
process.env.AGENTCUT_HOME = join(tmp, "home"); // isolated feedback store (inherited by every CLI call)
const m = join(tmp, "media");
mkdirSync(m);
console.log("media ->", tmp);
ff("-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=440:duration=6", "-shortest", "-pix_fmt", "yuv420p", join(m, "a.mp4"));
ff("-f", "lavfi", "-i", "color=c=0x00ff00:size=640x360:rate=30:duration=3", "-vf", "drawbox=x=200:y=100:w=240:h=160:color=red:t=fill", "-pix_fmt", "yuv420p", join(m, "green.mp4"));
ff("-f", "lavfi", "-i", "gradients=size=800x800:n=4", "-frames:v", "1", join(m, "p.png"));
ff("-f", "lavfi", "-i", "mandelbrot=size=900x600", "-frames:v", "1", join(m, "q.jpg"));
ff("-f", "lavfi", "-i", "aevalsrc='sin(2*PI*60*t)*exp(-25*mod(t,0.5))':s=44100:d=12", "-ac", "2", join(m, "beat.wav"));
ff("-f", "lavfi", "-i", "sine=f=300:d=1.5", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=1.2", "-f", "lavfi", "-i", "sine=f=300:d=1.5",
  "-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", join(m, "talk.wav"));
ff("-f", "lavfi", "-i", "testsrc=size=640x360:rate=30:duration=4.2", "-i", join(m, "talk.wav"), "-shortest", "-pix_fmt", "yuv420p", join(m, "talk.mp4"));
writeFileSync(join(m, "subs.srt"), "1\n00:00:00,200 --> 00:00:01,500\nXin chào thế giới\n\n2\n00:00:01,600 --> 00:00:03,000\nĐây là phụ đề\n");
writeFileSync(join(m, "spin.json"), JSON.stringify({
  v: "5.7.4", fr: 30, ip: 0, op: 60, w: 200, h: 200, layers: [{
    ty: 4, ip: 0, op: 60, st: 0, ks: { o: { a: 0, k: 100 }, r: { a: 1, k: [{ t: 0, s: [0], i: { x: [0.5], y: [0.5] }, o: { x: [0.5], y: [0.5] } }, { t: 60, s: [360] }] }, p: { a: 0, k: [100, 100] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] } },
    shapes: [{ ty: "rc", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [110, 110] }, r: { a: 0, k: 18 } }, { ty: "fl", c: { a: 0, k: [1, 0.2, 0.45, 1] }, o: { a: 0, k: 100 } }],
  }],
}));

const P = join(tmp, "proj");
console.log("project + analysis");
cli(["init", P, "--preset", "square"]);
const b = cli(["beats", join(m, "beat.wav")]);
check("beat tempo ≈ 120", Math.abs(b.tempo_bpm - 120) < 2, b.tempo_bpm);
check("probe lottie", cli(["probe", join(m, "spin.json")]).kind === "lottie");
check("scenes", Array.isArray(cli(["scenes", join(m, "a.mp4")]).shots));

console.log("edit ops");
const ops = [
  { op: "add_clip", track: "main", src: join(m, "a.mp4"), in: 0.5, duration: 2.5, filters: [{ type: "look", name: "cinematic" }] },
  { op: "add_clip", track: "main", src: join(m, "p.png"), duration: 2, transition: "dip_black", motion: "pan_right" },
  { op: "add_clip", track: "main", type: "color", gradient: { colors: ["#ff0080", "#00e0ff"], angle: 45 }, duration: 2, transition: "wipe_up" },
  { op: "add_clip", track: "main", src: join(m, "talk.mp4"), transition: { type: "zoom_blur", duration: 0.4 }, fit: "blur" },
  { op: "add_clip", track: "main", src: join(m, "a.mp4"), in: 2, duration: 2, reverse: true, transition: "glitch" },
  { op: "add_clip", track: "main", src: join(m, "q.jpg"), duration: 2, transition: "spin", effects: [{ type: "vhs", intensity: 0.8 }] },
  { op: "add_clip", track: "overlay", src: join(m, "green.mp4"), at: 1, duration: 2, size: ["40%", "40%"], fit: "contain", filters: [{ type: "chromakey", color: "#00ff00", similarity: 0.2 }], position: "bottom_left" },
  { op: "add_clip", track: "overlay", type: "shape", shape: "rect", size: ["80%", 12], fill: "#FFD60A", radius: 6, at: 0, until_end: true, y: "92%", keyframes: { scale_x: [[0, 0], [8, 1]] } },
  { op: "add_clip", track: "overlay", type: "shape", shape: "star", size: [200, 200], gradient: { colors: ["#fff", "#f0f"] }, blend: "screen", at: 2, duration: 2, x: "70%", y: "30%", keyframes: { rotation: [[0, 0], [2, 180, "ease_in_out"]] } },
  { op: "add_clip", track: "overlay", src: join(m, "a.mp4"), at: 3, duration: 3, size: [300, 300], mask: { shape: "circle", feather: 8 }, border: { color: "white", width: 6 }, position: "top_right", enter: "pop" },
  { op: "add_clip", track: "overlay", src: join(m, "spin.json"), at: 5, duration: 2, size: [240, 240], position: "bottom_right" },
  { op: "add_clip", track: "text", text: "Typewriter thử nghiệm", at: 0, duration: 3, enter: "typewriter", align: "left", position: "top_left", font_size: 60, letter_spacing: 2 },
  { op: "add_clip", track: "text", text: "words reveal 🔥", at: 3, duration: 2, preset: "neon", enter: "words", exit: "wipe_right" },
  { op: "add_clip", track: "text", text: "SALE", at: 6, duration: 2, preset: "sticker" },
  { op: "add_captions", srt: join(m, "subs.srt"), at: 5, preset: "bold_pop" },
  { op: "add_clip", track: "music", src: join(m, "beat.wav"), volume: 0.6, fade_in: 0.5, until_end: true, keyframes: { volume: [[0, 0.5], [4, 1]] } },
  { op: "add_effect", type: "letterbox", ratio: 1.6, start: 0, duration: 2 },
];
const r = cli(["apply", "--ops", JSON.stringify(ops)], { cwd: P });
const ids = new Set(r.results.map((x: any) => x.id));
check("batch created clips", ["vid1", "img1", "col1", "vid2", "vid3", "img2", "shp1", "cap1", "lot1"].every((i) => ids.has(i)), [...ids]);
const bad = cli(["apply", "--ops", JSON.stringify([{ op: "add_clip", track: "text", text: "x", enter: "fade_inn" }])], { ok: false, cwd: P });
check("invalid batch rejected with hint", bad.error.code === "validation_failed" && /fade/.test(bad.error.hint), bad.error);
check("typo op suggests fix", /update_clip/.test(cli(["op", "updat_clip", "id=vid1"], { ok: false, cwd: P }).error.hint));
const C = { cwd: P };
cli(["set", "img1", "motion=ken_burns", "fit=contain"], C);
const sp = cli(["op", "split_clip", "id=vid1", "at=1.2"], C).results[0];
cli(["op", "trim_clip", `id=${sp.right}`, "trim_start=0.2"], C);
cli(["op", "freeze_frame", "id=vid1", "at=0.6", "duration=0.8"], C);
cli(["op", "remove_silence", "id=vid2", "min_silence=0.5"], C);
cli(["op", "set_keyframes", "id=vid3", "prop=speed", 'keyframes=[[0,1],[1,0.3],[2,2]]'], C);
cli(["op", "snap_to_beats", "track=main", `beats=${join(m, "beat.wav")}`, "every=2"], C);
cli(["op", "move_clip", "id=col1", "index=0"], C);
cli(["op", "duplicate_clip", "id=txt1", "at=end-3"], C);
cli(["op", "add_effect", "id=img2", "type=rgb_split", "amount=10"], C);
cli(["op", "add_marker", "t=1.5", "label=check"], C);
const vo = cli(["op", "add_voiceover", "text=Xin chào, đây là AgentCut", "voice=Linh", "captions=tiktok", "at=0.5"], { ok: false, cwd: P });
console.log(vo.ok ? "  ✓ voiceover (Linh)" : `  - voiceover skipped: ${vo.error.message}`);
const info = cli(["info"], C);
console.log(info.summary.split("\n").map((l: string) => "    " + l).join("\n"));
check("timeline valid", info.errors === 0, info.issues);
const d0 = info.duration;
cli(["rm", "col1"], C); cli(["undo"], C);
check("undo restores", cli(["info"], C).duration === d0);
cli(["redo"], C); cli(["undo"], C);

console.log("look");
check("frame jpg", existsSync(cli(["frame", "1.5", "--guides"], C).image));
check("contact sheet", existsSync(cli(["sheet", "--every", "1"], C).image));

console.log("render");
const out = cli(["render", "-o", "renders/full.mp4", "--quiet"], C);
check("mp4 frames", out.frames > 0 && existsSync(out.contact_sheet), out);
check("loudness ≈ -14 LUFS", out.loudness?.integrated_lufs != null && Math.abs(out.loudness.integrated_lufs + 14) < 2.5, out.loudness);
const part = cli(["render", "-o", "renders/part.webm", "--from", "1", "--to", "3", "--draft", "--no-sheet", "--quiet", "--workers", "1"], C);
check("section render 2s", Math.abs(part.duration - 2) < 0.05, part.duration);
cli(["render", "-o", "renders/clip.gif", "--to", "2", "--no-sheet", "--quiet"], C);
cli(["render", "-o", "renders/master.mov", "--to", "1", "--no-sheet", "--quiet", "--scale", "0.5"], C);
cli(["render", "-o", "renders/fast.mp4", "--to", "2", "--fast", "--no-sheet", "--quiet"], C);
for (const f of ["full.mp4", "part.webm", "clip.gif", "master.mov", "fast.mp4"]) check(`export ${f}`, statSync(join(P, "renders", f)).size > 1000);
const pr = cli(["probe", "renders/full.mp4"], C);
check("output 1080x1080 with audio", pr.width === 1080 && pr.has_audio, pr);

console.log("templates");
const T = join(tmp, "tpl");
cli(["init", T, "--preset", "reels"]);
const tp = cli(["op", "apply_template", "name=promo", "--json", JSON.stringify({ media: [join(m, "a.mp4"), join(m, "p.png"), join(m, "q.jpg")], hook: "Ra mắt", points: ["Nhanh", "Đẹp"], cta: "Mua ngay", music: join(m, "beat.wav") })], { cwd: T });
check("promo template", tp.results[0].steps > 5 && tp.errors === 0, tp);
for (const name of ["slideshow", "beat_montage"]) {
  const d = join(tmp, name);
  cli(["init", d, "--preset", "youtube"]);
  const x = cli(["op", "apply_template", `name=${name}`, "--json", JSON.stringify({ media: [join(m, "p.png"), join(m, "q.jpg"), join(m, "a.mp4")], music: join(m, "beat.wav"), title: "Album" })], { cwd: d });
  check(`${name} template`, x.errors === 0, x.issues);
}
const q = join(tmp, "quote");
cli(["init", q, "--preset", "square"]);
check("quote template", cli(["op", "apply_template", "name=quote", "text=Stay hungry, stay foolish", "author=Steve Jobs"], { cwd: q }).errors === 0);
check("template renders", cli(["render", "--draft", "--quiet"], { cwd: T }).frames > 0);

console.log("feedback");
const n1 = cli(["feedback", "add", "kind=friction", "title=had to guess the fade animation name", "area=enter"]);
const n2 = cli(["feedback", "add", "kind=friction", "title=Had to guess the fade animation name!"]);
check("feedback note merged", n2.merged && n2.id === n1.id && n2.count === 2, n2);
const fs = cli(["feedback", "summary"]);
check("auto-logged guessed names", ["fade_inn", "updat_clip"].every((g) => fs.naming_misses.some((m: any) => m.guess === g)), fs.naming_misses);
check("render speed logged", fs.render?.renders >= 1, fs.render);
check("bad feedback kind rejected", cli(["feedback", "add", "kind=rant", "title=x"], { ok: false }).error.code === "bad_kind");
check("resolve note", cli(["feedback", "resolve", n1.id]).status === "resolved");

console.log(`\n${failures ? `✗ ${failures} check(s) failed` : "OK - all checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s  (${tmp})`);
if (!process.argv.includes("--keep") && !failures) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
