// End-to-end smoke test: generates synthetic media, exercises every op + template + export format through the CLI.
// Run: bun tests/smoke.ts [--keep]          (needs ffmpeg on PATH)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

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
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
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
  { op: "add_clip", track: "main", src: join(m, "a.mp4"), in: 0.5, duration: 2.5, color: { look: "cinematic" } },
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
// only a missing voice or engine (the host lacks 'Linh' / a TTS binary) skips; any other error is a failure
if (vo.ok) console.log("  ✓ voiceover (Linh)");
else if (["bad_voice", "missing_dependency"].includes(vo.error.code)) console.log(`SKIPPED: voiceover (${vo.error.code}): ${vo.error.message}`);
else check("voiceover fails only with a missing voice or engine", false, vo.error);
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

console.log("frame time and caption file format");
{
  const dur = cli(["info"], C).duration;
  const code = (args: (string | number)[]) => cli(args, { ok: false, cwd: P }).error?.code;
  check("frame and scopes at the duration or before 0 are bad_value; 0 works", code(["frame", dur]) === "bad_value" && code(["frame", "-0.1"]) === "bad_value" && code(["scopes", dur]) === "bad_value" && existsSync(cli(["frame", 0], C).image));
  const sh = cli(["sheet", "--times", `0,${dur}`, "--count", 2], { ok: false, cwd: P }).error;
  check("a sheet with a time at the duration is bad_value, naming the time and the duration, and the hint names the last frame", sh?.code === "bad_value" && sh.message.includes(`${dur}`) && /duration is/.test(sh.message) && /last frame starts at/.test(sh.hint), sh);
  check("a sheet at the last frame works", existsSync(cli(["sheet", "--times", `0,${(dur - 1 / 30).toFixed(3)}`], C).image));
  const E = join(tmp, "empty-sheet");
  const code2 = (args: (string | number)[], cwd: string) => cli(args, { ok: false, cwd }).error?.code;
  cli(["init", E, "--preset", "square"]);
  check("a frame or scopes of an empty timeline is `empty`, not a time outside it", code2(["frame", 0], E) === "empty" && code2(["scopes", 0], E) === "empty");
  check("a sheet of an empty timeline is a clean refusal whichever way the times are chosen", [["--every", "1"], ["--count", "3"], ["--times", "0"], []].every((a) => cli(["sheet", ...a], { ok: false, cwd: E }).error?.code === "empty"));
  check("captions to an unknown extension is bad_format and writes nothing; an explicit format names the content", code(["captions", "-o", "subs.txt"]) === "bad_format" && !existsSync(join(P, "subs.txt"))
    && cli(["captions", "-o", "subs.txt", "--format", "vtt"], C).format === "vtt" && readFileSync(join(P, "subs.txt"), "utf8").startsWith("WEBVTT"));
}

console.log("moved media: the hinted relink_asset repairs the project");
{
  const D = join(tmp, "moved"), old = join(m, "old-place.mp4"), moved = join(m, "new-place.mp4");
  cli(["init", D, "--preset", "square"]);
  copyFileSync(join(m, "green.mp4"), old);
  cli(["op", "add_clip", "track=main", `src=${old}`], { cwd: D });
  const aid = Object.keys(cli(["info", "--json"], { cwd: D }).timeline.assets)[0];
  renameSync(old, moved);
  const v = cli(["validate"], { ok: false, cwd: D });
  const hint: string = v.issues[0]?.hint ?? "";
  check("the hint names relink_asset with the asset id", hint.includes(`relink_asset id=${aid} path=`), hint);
  cli(["op", "relink_asset", `id=${aid}`, `path=${moved}`], { cwd: D });
  const after = cli(["validate"], { cwd: D });
  check("after the hinted op the project validates and renders a frame", after.valid === true && existsSync(cli(["frame", 0], { cwd: D }).image), after);
}

console.log("render");
const out = cli(["render", "-o", "renders/full.mp4", "--quiet"], C);
check("mp4 frames; has_audio; the contact sheet is in previews/ and none sits next to the output", out.frames > 0 && out.has_audio === true && existsSync(out.contact_sheet)
  && realpathSync(dirname(out.contact_sheet)) === realpathSync(join(P, "previews")) && readdirSync(join(P, "renders")).every((f) => !f.endsWith(".sheet.jpg")), out);
check("loudness ≈ -14 LUFS", out.loudness?.integrated_lufs != null && Math.abs(out.loudness.integrated_lufs + 14) < 2.5, out.loudness);
const part = cli(["render", "-o", "renders/part.webm", "--start", "1", "--end", "3", "--draft", "--no-sheet", "--quiet", "--workers", "1"], C);
check("section render 2s", Math.abs(part.duration - 2) < 0.05, part.duration);
cli(["render", "-o", "renders/clip.gif", "--end", "2", "--no-sheet", "--quiet"], C);
cli(["render", "-o", "renders/master.mov", "--end", "1", "--no-sheet", "--quiet", "--scale", "0.5"], C);
cli(["render", "-o", "renders/fast.mp4", "--end", "2", "--fast", "--no-sheet", "--quiet"], C);
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
for (const op of ["j_cut", "split_clip"]) cli(["op", op, "id=x", "wobble=1"], { cwd: q, ok: false });
cli(["op", "add_effect", "type=grain", "intesity=1"], { cwd: q, ok: false });
const fs = cli(["feedback", "summary"]);
check("auto-logged guessed names", ["fade_inn", "updat_clip"].every((g) => fs.naming_misses.some((m: any) => m.guess === g)), fs.naming_misses);
check("an unknown argument is logged as a naming miss under its op", [["j_cut argument", "wobble"], ["split_clip argument", "wobble"], ["add_effect grain parameter", "intesity"]].every(([k, g]) => fs.naming_misses.some((m: any) => m.kind === k && m.guess === g)), fs.naming_misses);
check("render speed logged", fs.render?.renders >= 1, fs.render);
check("a failed validate is not an error event: no error row for validate and no row without a code", !fs.errors.some((e: any) => e.cmds.includes("validate") || typeof e.code !== "string"), fs.errors);
{
  // planted render events in an empty store: a one-frame render at 0.05x is start-up cost, a 5 s render at 0.3x is slow
  const FB = await import("../src/feedback.ts");
  const real = process.env.AGENTCUT_HOME;
  process.env.AGENTCUT_HOME = join(tmp, "home-render");
  try {
    const plant = (speed_x: number, frames: number, seconds: number) => FB.recordEvent({ type: "render", speed_x, frames, width: 1080, height: 1080, seconds });
    plant(0.05, 1, 0.1);
    const one = FB.summary().render!;
    plant(0.3, 150, 5);
    const slow = FB.summary().render!;
    plant(0.05, 1, 0.1); plant(0.05, 1, 0.1); plant(2, 300, 10);
    const all = FB.summary();
    check("a one-frame render at 0.05x is not slow; a longer render at 0.3x is, and the evidence line shows it",
      one.slow_renders === 0 && one.speed_x_min === null && one.slowest.length === 0 &&
      slow.slow_renders === 1 && slow.slowest.length === 1 && slow.slowest[0].speed_x === 0.3 && slow.speed_x_min === 0.3, { one, slow });
    check("the render line's p50 and min come from the same renders: p50 is not below min", all.render!.renders === 5 && all.render!.speed_x_min === 0.3 && all.render!.speed_x_p50 === 2 && /p50 2x realtime, min 0.3x/.test(FB.summaryMarkdown(all)), all.render);
  } finally { process.env.AGENTCUT_HOME = real; }
}
check("bad feedback kind rejected", cli(["feedback", "add", "kind=rant", "title=x"], { ok: false }).error.code === "bad_kind");
check("resolve note", cli(["feedback", "resolve", n1.id]).status === "resolved");
{
  // two processes write the feedback store at the same time (released together once both have loaded the module): no note and no event is lost
  const fbDir = join(tmp, "home", "feedback");
  const worker = join(tmp, "fb-worker.ts");
  writeFileSync(worker, `import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const [mode, tag, n, dir] = process.argv.slice(2);
const F = await import(${JSON.stringify(resolve(import.meta.dir, "../src/feedback.ts"))});
writeFileSync(dir + "/ready-" + tag, "");
while (!existsSync(dir + "/go")) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
for (let i = 0; i < Number(n); i++) {
  if (mode === "notes") F.addNote({ kind: "idea", title: randomBytes(10).toString("hex") });
  else F.recordEvent({ type: "race", id: tag + "-" + i });
}
`);
  const race = async (mode: string, n: number) => {
    rmSync(join(tmp, "race"), { recursive: true, force: true });
    mkdirSync(join(tmp, "race"));
    const dir = join(tmp, "race");
    const kids = ["a", "b"].map((tag) => spawn(process.execPath, ["--no-install", worker, mode, tag, String(n), dir], { env: process.env, stdio: ["ignore", "ignore", "inherit"] }));
    const done = kids.map((k) => new Promise<number | null>((res) => k.on("exit", res)));
    for (let i = 0; i < 400 && !(existsSync(join(dir, "ready-a")) && existsSync(join(dir, "ready-b"))); i++) await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(dir, "go"), "");
    return Promise.all(done);
  };
  const readNotes = (): any[] => JSON.parse(readFileSync(join(fbDir, "notes.json"), "utf8"));
  const before = readNotes().length;
  const codes = await race("notes", 15);
  const notes = readNotes();
  check("two processes adding notes at once: every note is kept", codes.every((c) => c === 0) && notes.length === before + 30 && new Set(notes.map((x: any) => x.id)).size === notes.length, { codes, before, now: notes.length });
  // events.jsonl over the size limit (about 10 MB of short lines, so the trim takes long and the half kept is still under the limit): the first append trims it while the other process appends
  const evFile = join(fbDir, "events.jsonl");
  const seed = '{"cmd":"seed"}\n';
  writeFileSync(evFile, seed.repeat(Math.ceil(10_000_000 / seed.length)));
  const ecodes = await race("events", 400);
  const ids = new Set(readFileSync(evFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id).filter(Boolean));
  check("two processes appending events while one trims events.jsonl: no event is lost", ecodes.every((c) => c === 0) && ids.size === 800 && statSync(evFile).size < 5 * 1024 * 1024, { ecodes, kept: ids.size, size: statSync(evFile).size });
}

console.log("cli surface: --start/--end, transcribe, tts");
{
  const talk = join(m, "talk.wav"), model = join(tmp, "fake.bin"), tr = (...a: string[]) => cli(["transcribe", talk, ...a], { ok: false }).error.code;
  check("transcribe: end <= start, a negative start and a start past the media's end are bad_value", [tr("--start", "2", "--end", "1"), tr("--start", "-1", "--end", "1"), tr("--start", "999")].every((c) => c === "bad_value"));
  if (process.platform !== "win32") { // the fake engine is a shell script
  const bin = join(tmp, "asr-bin");
  mkdirSync(bin);
  writeFileSync(model, ""); // the engine is a stand-in, but the model path is checked
  writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-m" ] && echo "$2" > "${tmp}/asr.model"; [ "$1" = "-of" ] && printf '%s' '{"result":{"language":"vi"},"transcription":[{"text":" Hi","offsets":{"from":200,"to":500}}]}' > "$2.json"; shift; done\n`);
  chmodSync(join(bin, "whisper-cli"), 0o755);
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${PATH}`;
  let got: any;
  try { got = cli(["transcribe", talk, "--language", "vi", "--model", model, "--start", "1", "--end", "2"]); } finally { process.env.PATH = PATH; }
  check("transcribe: the model reaches the engine and the range shifts the word times (media seconds)", readFileSync(join(tmp, "asr.model"), "utf8").trim() === model && got.words[0].start === 1.2 && got.words[0].end === 1.5, got);
  // each error names its cause and is raised before an engine starts; a failed engine is reported by its own error line, not its usage text
  const asr = (body: string) => writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\n${body}`, { mode: 0o755 });
  const fail = (...a: string[]) => cli(["transcribe", ...a], { ok: false }).error;
  const length = String(cli(["probe", talk]).duration), usage = `echo "usage: whisper-cli [options] file0 file1 ..." >&2\necho "  -h, --help   show this help message and exit" >&2\n`;
  process.env.PATH = `${bin}${delimiter}${PATH}`;
  try {
    const missing = fail(join(tmp, "nope.wav")), still = fail(join(m, "p.png")), noModel = fail(talk, "--model", join(tmp, "no-such.bin"));
    check("transcribe: a missing file is not_found naming the path, a still image is no_audio, a missing model path is not_found naming the model file",
      missing.code === "not_found" && missing.message.includes(join(tmp, "nope.wav")) && still.code === "no_audio" && noModel.code === "not_found" && noModel.message.includes(join(tmp, "no-such.bin")), { missing, still, noModel });
    const past = [fail(talk, "--model", model, "--start", "999"), fail(talk, "--model", model, "--start", "999", "--end", "1000")];
    check("transcribe: a start past the media's end, with and without an end, is bad_value naming the media's length", past.every((x) => x.code === "bad_value" && x.message.includes(length)), past);
    asr(`printf '%s\\n' "whisper_lang_id: unknown language 'xx'" "error: unknown language 'xx'" "" "usage: whisper-cli [options] file0 file1 ..." >&2\nexit 0\n`);
    const lang = fail(talk, "--model", model, "--language", "xx");
    check("transcribe: the engine exits 0 with no output for an unknown language: bad_value naming it", lang.code === "bad_value" && lang.message.includes("xx") && !/usage/.test(lang.message), lang);
    asr(`echo "error: failed to read the audio" >&2\nexit 0\n`);
    const quiet = fail(talk, "--model", model, "--language", "xx");
    check("transcribe: the engine exits 0 with no output and no language line: asr_failed with its error line", quiet.code === "asr_failed" && quiet.message.includes("failed to read the audio"), quiet);
    asr(`${usage}exit 3\n`);
    const usageOnly = fail(talk, "--model", model);
    check("transcribe: an engine failure shows its exit status, never its usage text", usageOnly.code === "asr_failed" && usageOnly.message.includes("3") && !/usage|--help/.test(usageOnly.message), usageOnly);
  } finally { process.env.PATH = PATH; }
  }
  const S = join(tmp, "tts-proj");
  cli(["init", S, "--preset", "reels"]);
  const ts = (...a: string[]) => cli(["tts", ...a], { ok: false, cwd: S }).error.code;
  check("tts: a rate that is not a number is a usage error, 0 is bad_value, a missing text or output is missing_input, the project's own file is refused",
    ts("hi", "-o", "x.wav", "--rate", "abc") === "usage" && ts("hi", "-o", "x.wav", "--rate", "0") === "bad_value" && ts("-o", "x.wav") === "missing_input" && ts("hi") === "missing_input" && ts("hi", "-o", "project.json") === "output_is_source");
  for (const [label, flags, code] of [["--width abc", ["--width", "abc"], "usage"], ["--fps 0", ["--fps", "0"], "bad_value"]] as const) {
    const D = join(tmp, `init-${label.replace(/\W/g, "")}`), r = cli(["init", D, ...flags], { ok: false });
    check(`init ${label} fails with ${code} before writing anything`, r.ok === false && r.error?.code === code && !existsSync(D), r);
  }
  check("another numeric flag: sheet --count abc is a usage error", cli(["sheet", "--count", "abc"], { ok: false, cwd: S }).error?.code === "usage");
}

console.log("schema version");
{
  const V = JSON.parse(readFileSync(join(T, "project.json"), "utf8")).version;
  check("a new project carries the supported version (cli schema agrees)", Number.isInteger(V) && cli(["schema"]).timeline.version === V, [V, cli(["schema"]).timeline.version]);
  for (const [label, v] of [["version+1", V + 1], ["no version", undefined]] as const) {
    const d = join(tmp, `ver-${label.replace(/\W/g, "")}`);
    cli(["init", d, "--preset", "reels"]);
    const t = JSON.parse(readFileSync(join(d, "project.json"), "utf8"));
    if (v === undefined) delete t.version; else t.version = v;
    writeFileSync(join(d, "project.json"), JSON.stringify(t, null, 2));
    const before = readFileSync(join(d, "project.json"), "utf8");
    for (const args of [["validate"], ["info"], ["op", "add_marker", "t=1"], ["undo"]]) {
      const r = cli(args, { cwd: d, ok: false });
      check(`${label}: cli ${args[0]} -> bad_version, hint names both versions`, r.ok === false && r.error.code === "bad_version" && r.error.hint.includes(String(V)) && r.error.hint.includes(String(v ?? "missing")), r);
    }
    check(`${label}: project.json is byte-identical`, readFileSync(join(d, "project.json"), "utf8") === before, "rewritten");
  }
}

console.log(`\n${failures ? `✗ ${failures} check(s) failed` : "OK - all checks passed"} in ${((performance.now() - t0) / 1000).toFixed(1)}s  (${tmp})`);
if (!process.argv.includes("--keep") && !failures) rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
