// Colour grading (color field -> FFmpeg), scopes, and TTS provider selection / HTTP request building (local server, no network).
// Run: bun tests/color-tts.ts [--keep]          (needs ffmpeg + curl on PATH)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-colortts-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
for (const k of ["AGENTCUT_TTS_PROVIDER", "AGENTCUT_TTS_URL", "AGENTCUT_TTS_KEY", "AGENTCUT_TTS_MODEL", "AGENTCUT_TTS_VOICE", "AGENTCUT_PIPER_MODEL"]) delete process.env[k];
const api = await import("../src/api.ts");
const { gradeChain, gradeIssues, LOOKS } = await import("../src/color.ts");
const T = await import("../src/tts.ts");
const AN = await import("../src/analyze.ts");
const { filterChain } = await import("../src/media.ts");

let failures = 0;
function check(name: string, cond: unknown, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 500) : ""); }
}
function ff(...args: string[]) {
  const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}
const throwsCode = (f: () => unknown, code: string) => { try { f(); return false; } catch (e: any) { return e.code === code || e.message; } };
const rejectsCode = async (f: () => Promise<unknown>, code: string) => { try { await f(); return false; } catch (e: any) { return e.code === code || e.message; } };
/** mean R,G,B of a still (ffmpeg scales to 1x1). */
const meanRgb = (file: string) => [...(spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer)];

const m = join(tmp, "media");
mkdirSync(m);
ff("-f", "lavfi", "-i", "color=c=0x808080:size=320x180:rate=30:duration=2", "-pix_fmt", "yuv420p", join(m, "grey.mp4"));

console.log("grade -> ffmpeg");
check("every look builds a chain", Object.keys(LOOKS).every((k) => gradeChain({ look: k }).length > 0));
check("explicit field overrides the look", gradeChain({ look: "bw", saturation: 1 }).join().includes("contrast=1.15") && !gradeChain({ look: "bw", saturation: 1 }).join().includes("saturation"));
const full = { exposure: 0.5, temperature: 0.4, tint: 0.2, lift: [0.1, 0, -0.1], gain: [0, 0, 0.1], curves: { master: [[0, 0.05], [1, 1]], r: [[0, 0], [1, 0.9]] }, contrast: 1.1, saturation: 1.2, hsl: { reds: { hue: 10, saturation: 0.2, lightness: -0.1 } }, vibrance: 0.3 };
const chain = gradeChain(full);
check("filter order: exposure, temperature, balance, curves, eq, hsl, vibrance",
  JSON.stringify(chain.map((f) => f.split("=")[0])) === JSON.stringify(["exposure", "colortemperature", "colorbalance", "curves", "eq", "huesaturation", "vibrance"]), chain);
const run = spawnSync("ffmpeg", ["-v", "error", "-i", join(m, "grey.mp4"), "-frames:v", "1", "-vf", chain.join(","), "-f", "null", "-"], { encoding: "utf8" });
check("full chain is accepted by ffmpeg", run.status === 0, run.stderr);

const P = join(tmp, "proj");
api.create(P, { preset: "720p" });
await api.apply(P, [{ op: "add_clip", track: "main", src: join(m, "grey.mp4"), duration: 2 }]);
const base = meanRgb((await api.frame(P, 1, { out: join(tmp, "base.png") })).image);
await api.apply(P, [{ op: "update_clip", id: "vid1", set: { color: { temperature: 0.8 } } }]);
const warm = meanRgb((await api.frame(P, 1, { out: join(tmp, "warm.png") })).image);
check("temperature + makes grey warmer (R up, B down)", warm[0] > base[0] + 5 && warm[2] < base[2] - 5, { base, warm });
await api.apply(P, [{ op: "update_clip", id: "vid1", set: { color: { exposure: 1 } } }]);
const bright = meanRgb((await api.frame(P, 1, { out: join(tmp, "bright.png") })).image);
check("exposure +1 brightens", bright[1] > base[1] + 40, { base, bright });

const bad = await api.apply(P, [{ op: "update_clip", id: "vid1", set: { color: { look: "warmm", exposure: 9, lift: [1, 2], curves: { master: [[0.5, 0], [0.2, 1]] }, hsl: { pinks: {} }, bogus: 1 } } }]).catch((e) => e);
const issues = bad.details?.issues ?? [];
const paths = issues.map((i: any) => i.path.replace(/^.*\.color\./, ""));
check("bad grade rejected with one issue per problem", bad.code === "validation_failed" && ["look", "exposure", "lift", "curves.master", "hsl.pinks", "bogus"].every((k) => paths.includes(k)), paths);
check("look typo suggests the right name", issues.find((i: any) => i.path.endsWith(".look"))?.hint?.includes("'warm'"));
check("audio clips have no color field", !("color" in (api.schema() as any).clip_types.audio));

console.log("filters");
{
  const Q = join(tmp, "projq");
  api.create(Q, { preset: "720p" });
  await api.apply(Q, [{ op: "add_clip", track: "main", src: join(m, "grey.mp4"), duration: 2 }]);
  const unknown = await api.apply(Q, [{ op: "update_clip", id: "vid1", set: { filters: [{ type: "not_a_filter" }] } }]).catch((e) => e);
  check("an unknown filter type is rejected with the filter list", unknown.code === "validation_failed" && unknown.details?.issues?.some((i: any) => i.message.includes("unknown filter") && i.hint.includes("lut")), unknown.details);
  // every character that is special in a filtergraph, plus a space and "=" , in the directory and file name
  const dir = join(tmp, "lut q'x:y,z[w]v;u\\t= s");
  mkdirSync(dir);
  const cube = join(dir, "red a'b:c,d[e];f.cube");
  const all = (rgb: string) => ["LUT_3D_SIZE 2", ...Array(8).fill(rgb)].join("\n") + "\n";
  writeFileSync(cube, all("1 0 0"));
  const b0 = meanRgb((await api.frame(Q, 1, { out: join(tmp, "nolut.png") })).image);
  await api.apply(Q, [{ op: "update_clip", id: "vid1", set: { filters: [{ type: "lut", path: cube }] } }]);
  const b1 = await api.frame(Q, 1, { out: join(tmp, "lut.png") }).then((f) => meanRgb(f.image), () => [-1, -1, -1]);
  {
    // Windows drive letter: the platform is presented as win32 only while the chain is built
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try { check("lut path on a Windows drive: separators become /, the colon and the space are escaped at both levels", filterChain([{ type: "lut", path: "C:\\a b\\x,y.cube" }])[0] === "lut3d=file=C\\\\:/a\\\\\\ b/x\\,y.cube", filterChain([{ type: "lut", path: "C:\\a b\\x,y.cube" }])); }
    finally { Object.defineProperty(process, "platform", platform); }
  }
  check("lut at a path with filtergraph-special characters is applied", Math.abs(b0[0] - b0[1]) < 8 && b1[0] > 200 && b1[1] < 40 && b1[2] < 40, { b0, b1 });
  {
    // a file name that ends in a space: ffmpeg must be handed that exact name (the name is not a recognised LUT type, which is what the message shows)
    const sp = join(dir, "trail.cube ");
    writeFileSync(sp, all("1 0 0"));
    const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x808080:s=16x16:d=0.1", "-vf", filterChain([{ type: "lut", path: sp }])[0], "-frames:v", "1", "-f", "null", "-"], { encoding: "utf8" });
    check("lut path ending in a space names that exact file", /'\.cube ' file type/.test(r.stderr) && !/No such file/.test(r.stderr), r.stderr);
  }
  // filter parameter values are typed and validated before they enter a filter graph: numbers in range, colours as 0xRRGGBB
  const R = join(tmp, "projr");
  api.create(R, { preset: "720p" });
  ff("-f", "lavfi", "-i", "color=c=0x00ff00:size=320x180:rate=30:duration=2", "-pix_fmt", "yuv420p", join(m, "green.mp4"));
  ff("-f", "lavfi", "-i", "color=c=0xff0000:size=320x180:rate=30:duration=2", "-pix_fmt", "yuv420p", join(m, "red.mp4"));
  await api.apply(R, [{ op: "add_clip", track: "main", src: join(m, "grey.mp4"), duration: 2 }]);
  const rev = (await api.info(R, "json")).revision;
  const badValues = [
    ["a non-numeric eq value", { type: "eq", brightness: "0.1,more" }, "brightness"],
    ["an eq value out of range", { type: "eq", gamma: 99 }, "gamma"],
    ["a chromakey colour with extra characters", { type: "chromakey", color: "#00ff00,more" }, "color"],
    ["a chromakey similarity out of range", { type: "chromakey", similarity: 5 }, "similarity"],
    ["a blur radius that is a string", { type: "blur", radius: "5x" }, "radius"],
    ["an unknown filter parameter", { type: "denoise", power: 3 }, "power"],
  ] as const;
  for (const [what, f, key] of badValues) {
    const e = await api.apply(R, [{ op: "update_clip", id: "vid1", set: { filters: [f] } }]).catch((x) => x);
    check(`${what} is rejected by validate and the batch is not applied`, e.code === "validation_failed" && e.details?.issues?.some((i: any) => i.path.endsWith(`.filters[0].${key}`)) && (await api.info(R, "json")).revision === rev, e.details ?? e);
  }
  check("filterChain fails closed on a non-numeric value", throwsCode(() => filterChain([{ type: "eq", brightness: "0.1,more" }]), "bad_filter") === true);
  check("filterChain fails closed on a non-finite value", [Infinity, NaN].every((v) => throwsCode(() => filterChain([{ type: "blur", radius: v }]), "bad_filter") === true));
  check("filterChain fails closed on an out-of-range value", throwsCode(() => filterChain([{ type: "vignette", strength: 7 }]), "bad_filter") === true);
  check("filterChain fails closed on a chromakey colour with extra characters", throwsCode(() => filterChain([{ type: "chromakey", color: "#00ff00,more" }]), "bad_filter") === true);
  check("valid eq and chromakey build the same chains as before", JSON.stringify(filterChain([{ type: "eq", brightness: 0.2, contrast: 1.5 }, { type: "chromakey", color: "#00ff00", similarity: 0.2 }, "chromakey"]))
    === JSON.stringify(["eq=brightness=0.2:contrast=1.5", "format=rgba,chromakey=0x00ff00:0.2:0.05", "format=rgba,chromakey=0x00ff00:0.1:0.05"]), filterChain([{ type: "eq", brightness: 0.2, contrast: 1.5 }]));
  await api.apply(R, [{ op: "update_clip", id: "vid1", set: { filters: [{ type: "eq", brightness: 0.2, contrast: 1.5 }] } }]);
  const eqPix = meanRgb((await api.frame(R, 1, { out: join(tmp, "eq.png") })).image);
  ff("-i", join(m, "grey.mp4"), "-vf", "eq=brightness=0.2:contrast=1.5", "-frames:v", "1", join(tmp, "eq-ref.png"));
  const eqRef = meanRgb(join(tmp, "eq-ref.png"));
  check("a valid eq renders like the same filter run directly", eqPix.every((v, i) => Math.abs(v - eqRef[i]) < 6) && eqPix[0] !== 128, { eqPix, eqRef });
  let ki = 0;
  for (const [what, src, color, keyed] of [["default green", "green.mp4", undefined, true], ["explicit hex", "green.mp4", "#00ff00", true], ["a colour that is not in the clip", "green.mp4", "#ff0000", false], ["red", "red.mp4", "#ff0000", true]] as const) {
    const K = join(tmp, `projk${ki++}`);
    api.create(K, { preset: "720p" });
    await api.apply(K, [{ op: "add_clip", track: "main", src: join(m, src), duration: 2, filters: [color ? { type: "chromakey", color, similarity: 0.2 } : { type: "chromakey", similarity: 0.2 }] }]);
    const px = meanRgb((await api.frame(K, 1, { out: join(tmp, "key.png") })).image);
    check(`chromakey ${what}: ${keyed ? "keyed out" : "kept"}`, keyed ? Math.max(...px) < 40 : Math.max(...px) > 200, px);
  }
}

console.log("scopes");
await api.apply(P, [{ op: "update_clip", id: "vid1", set: { color: null } }]);
const sc = await api.scopes(P, 1, { out: join(tmp, "scopes.jpg") });
check("scopes image written", existsSync(sc.image) && readFileSync(sc.image).length > 5000);
check("mid-grey: luma ~0.5, no cast, no saturation", Math.abs(sc.stats.luma.avg - 0.5) < 0.05 && Math.abs(sc.stats.cast.u) < 0.02 && Math.abs(sc.stats.cast.v) < 0.02 && sc.stats.saturation_avg < 0.02, sc.stats);
await api.apply(P, [{ op: "update_clip", id: "vid1", set: { color: { temperature: 0.8 } } }]);
const sw = await api.scopes(P, 1, { out: join(tmp, "scopes-warm.jpg") });
check("warm grade shows as a red/yellow cast (u < 0, v > 0)", sw.stats.cast.u < -0.02 && sw.stats.cast.v > 0.01, sw.stats);

console.log("tts provider selection");
check("default is system", T.pickProvider(undefined, {}).provider === "system");
check("plain voice name stays system", JSON.stringify(T.pickProvider("Linh", {})) === JSON.stringify({ provider: "system", voice: "Linh" }));
check("openai:nova prefix", JSON.stringify(T.pickProvider("openai:nova", {})) === JSON.stringify({ provider: "openai", voice: "nova" }));
check("bare 'piper' uses the env model", JSON.stringify(T.pickProvider("piper", {})) === JSON.stringify({ provider: "piper" }));
check("env default provider applies to unprefixed voices", T.pickProvider("onyx", { AGENTCUT_TTS_PROVIDER: "openai" }).provider === "openai");
check("unknown env provider fails closed", throwsCode(() => T.pickProvider(undefined, { AGENTCUT_TTS_PROVIDER: "polly" }), "bad_voice") === true);
check("url: base, /v1 and full path all normalise",
  T.speechUrl({ AGENTCUT_TTS_URL: "http://h:1" }) === "http://h:1/v1/audio/speech" && T.speechUrl({ AGENTCUT_TTS_URL: "http://h:1/v1/" }) === "http://h:1/v1/audio/speech"
  && T.speechUrl({ AGENTCUT_TTS_URL: "http://h:1/x/audio/speech" }) === "http://h:1/x/audio/speech");
check("key alone means api.openai.com; nothing set means unconfigured", T.speechUrl({ AGENTCUT_TTS_KEY: "k" }) === "https://api.openai.com/v1/audio/speech" && T.speechUrl({}) === null);
const b = T.speechBody("hi", undefined, 350, { AGENTCUT_TTS_MODEL: "kokoro", AGENTCUT_TTS_VOICE: "af_bella" });
check("body: env model/voice, wav, rate -> speed", b.model === "kokoro" && b.voice === "af_bella" && b.response_format === "wav" && b.speed === 2 && b.input === "hi", b);
check("piper without a model is a missing_dependency", await rejectsCode(() => AN.tts("x", join(tmp, "p.wav"), "piper"), "missing_dependency") === true);
{
  // the espeak branch is the non-darwin, non-win32 one: present it as linux; no engine is installed here, so a valid voice ends at missing_dependency
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    const bv = async (v: string) => { try { await AN.tts("x", join(tmp, "v.wav"), v); return null; } catch (e: any) { return e; } };
    const e = await bv("-x");
    check("espeak voice that reads as an option is a bad_voice with a hint", e?.code === "bad_voice" && !!e.hint, e && { code: e.code, msg: e.message });
    check("espeak voice with a path separator is a bad_voice", (await bv("en/../x"))?.code === "bad_voice");
    check("espeak voice names like en-us and en+f3 pass the voice check", (await Promise.all(["en-us", "en+f3", "vi", "mb-en1"].map(bv))).every((r) => r?.code !== "bad_voice"));
  } finally { Object.defineProperty(process, "platform", platform); }
}
if (process.platform !== "win32") {
  // an espeak-ng stand-in (first on PATH, presented as linux): it lists two voices and fails for a voice it does not list
  const eDir = join(tmp, "fake-espeak");
  mkdirSync(eDir);
  ff("-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-ar", "22050", join(eDir, "ok.wav"));
  writeFileSync(join(eDir, "espeak-ng"), `#!/bin/sh
d=$(dirname "$0")
out=; voice=
while [ $# -gt 0 ]; do case "$1" in --voices) printf 'Pty Language       Age/Gender VoiceName          File                 Other Languages\\n 5  en-us          --/M      English_(America)  gmw/en-US            (en 3)\\n 5  vi             --/M      Vietnamese         aav/vi\\n 5  zh-cmn         --/M      Chinese_(Mandarin) sit/cmn              (zh-cmn 5)(zh 5)\\n'; exit 0;; --voices=mb) printf 'Pty Language       Age/Gender VoiceName          File                 Other Languages\\n 5  en             M         english-mb-en1     mb/mb-en1            (en 2)\\n'; exit 0;; -w) out=$2;; -v) voice=$2;; esac; shift; done
[ -f "$d/broken" ] && { echo "synthesis broke" >&2; exit 1; }
case "$voice" in ""|en-us|en-us+f3|vi) cp "$d/ok.wav" "$out";; *) echo "Failed to read voice $voice" >&2; exit 1;; esac
`);
  chmodSync(join(eDir, "espeak-ng"), 0o755);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!, pathWas = process.env.PATH;
  Object.defineProperty(process, "platform", { value: "linux" });
  process.env.PATH = `${eDir}:${pathWas}`;
  try {
    const speak = async (v: string) => { try { await AN.tts("x", join(tmp, "e.wav"), v); return null; } catch (e: any) { return e; } };
    const bad = await speak("zz-nope");
    check("espeak: a voice that is not installed is a bad_voice that names the voices listing", bad?.code === "bad_voice" && /list_voices/.test(bad.hint ?? "") && /agentcut voices/.test(bad.hint ?? "") && /espeak-ng --voices/.test(bad.hint ?? ""), bad && { code: bad.code, msg: bad.message, hint: bad.hint });
    check("espeak: the bad_voice message keeps what espeak printed", /Failed to read voice zz-nope/.test(bad?.message ?? ""), bad && bad.message);
    const second = await speak("zh"), mb = await speak("mb-en1");
    check("espeak: a failing synthesis with a voice from a later language group is a tts_failed, not a bad_voice", second?.code === "tts_failed", second && { code: second.code, msg: second.message });
    check("espeak: a failing synthesis with a voice only the mbrola listing shows is a tts_failed, not a bad_voice", mb?.code === "tts_failed", mb && { code: mb.code, msg: mb.message });
    check("espeak: an installed voice, with or without a variant, synthesizes", (await speak("vi")) === null && (await speak("en-us+f3")) === null);
    const plain = join(tmp, "fake-espeak-plain");
    mkdirSync(plain);
    copyFileSync(join(eDir, "espeak-ng"), join(plain, "espeak"));
    chmodSync(join(plain, "espeak"), 0o755);
    copyFileSync(join(eDir, "ok.wav"), join(plain, "ok.wav"));
    process.env.PATH = [plain, ...pathWas!.split(":").filter((d) => !existsSync(join(d, "espeak-ng")))].join(":"); // a real espeak-ng would be preferred over the stand-in espeak
    const badPlain = await speak("zz-nope");
    check("espeak: the hint names the binary that ran (espeak, not espeak-ng)", badPlain?.code === "bad_voice" && /espeak --voices/.test(badPlain.hint ?? "") && !/espeak-ng/.test(badPlain.hint ?? ""), badPlain && { code: badPlain.code, hint: badPlain.hint });
    process.env.PATH = `${eDir}:${pathWas}`;
    writeFileSync(join(eDir, "broken"), "");
    const broke = await speak("vi");
    check("espeak: a failure with an installed voice stays tts_failed", broke?.code === "tts_failed", broke && { code: broke.code, msg: broke.message });
  } finally { Object.defineProperty(process, "platform", platform); process.env.PATH = pathWas; }
}
if (process.platform !== "win32") {
  // the SAPI branch: the platform is presented as win32 and a fake `powershell` (in the test tmp, first on PATH) stands in for the real one.
  // The voice and the output path must reach it as the two named variables, never as script text.
  const fakeDir = join(tmp, "fake-ps");
  mkdirSync(fakeDir);
  ff("-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-ar", "22050", join(fakeDir, "ok.wav"));
  const fake = join(fakeDir, "powershell");
  writeFileSync(fake, `#!/bin/sh
d=$(dirname "$0")
cat > /dev/null
printf '%s\\0' "$@" > "$d/argv"
printf '%s' "$AGENTCUT_SAPI_VOICE" > "$d/voice"
printf '%s' "$AGENTCUT_SAPI_OUT" > "$d/out"
if [ -f "$d/unknown" ]; then printf 'Alpha Voice\\nBeta Voice\\n'; exit 3; fi
[ -n "$AGENTCUT_SAPI_OUT" ] && cp "$d/ok.wav" "$AGENTCUT_SAPI_OUT"
`);
  chmodSync(fake, 0o755);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const pathWas = process.env.PATH;
  const sapi = async (voice?: string, rate?: number) => {
    const out = join(tmp, "sapi.wav");
    rmSync(out, { force: true });
    for (const f of ["argv", "voice", "out"]) rmSync(join(fakeDir, f), { force: true });
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.PATH = `${fakeDir}:${pathWas}`;
    try { await AN.tts("hello", out, voice, rate); return { out, err: null as any }; }
    catch (err: any) { return { out, err }; }
    finally { Object.defineProperty(process, "platform", platform); process.env.PATH = pathWas; }
  };
  const seen = (f: string) => readFileSync(join(fakeDir, f), "utf8");
  const script = () => seen("argv").split("\0")[2] ?? "";
  try {
    const plain = await sapi();
    check("sapi: a normal run produces the output file", plain.err === null && existsSync(plain.out), plain.err && plain.err.message);
    check("sapi: the output path reaches powershell as the variable, not in the script text",
      seen("out").endsWith("tts.wav") && seen("out").includes("agentcut-tts-") && !script().includes("agentcut-tts-") && !script().includes(seen("out")), { out: seen("out"), script: script() });
    check("sapi: no voice leaves the voice variable empty", seen("voice") === "");
    await sapi(undefined, 225);
    check("sapi: rate stays an integer in the script", /\$s\.Rate=2;/.test(script()), script());
    const chars: [string, string][] = [["apostrophe", "'"], ["U+2018", "‘"], ["U+2019", "’"], ["U+201A", "‚"], ["U+201B", "‛"], ["dollar", "$"], ["backtick", "`"], ["semicolon", ";"], ["newline", "\n"]];
    const names: [string, string][] = [...chars.map(([n, c]): [string, string] => [n, `Zq${c}Marker${c}Zq`]), ["300 chars", `Marker${"x".repeat(294)}`]];
    for (const [label, voice] of names) {
      const r = await sapi(voice);
      check(`sapi: a voice name with ${label} stays out of the script text and arrives byte for byte`,
        r.err === null && !script().includes("Marker") && seen("voice") === voice && Buffer.from(seen("voice")).equals(Buffer.from(voice)), r.err ? r.err.message : { script: script(), voice: seen("voice") });
    }
    check("sapi: a voice name with a NUL is a bad_voice", (await sapi("Zq\0Zq")).err?.code === "bad_voice");
    writeFileSync(join(fakeDir, "unknown"), "");
    const bad = await sapi("Alpha Voic");
    check("sapi: the unknown-voice exit is a bad_voice that names the installed voices", bad.err?.code === "bad_voice" && /Alpha Voice/.test(bad.err.hint) && /Beta Voice/.test(bad.err.hint) && /installed voices:/.test(bad.err.hint), bad.err && { code: bad.err.code, msg: bad.err.message, hint: bad.err.hint });
    check("sapi: the unknown-voice error carries the voice and a suggestion", /Alpha Voic/.test(bad.err?.message ?? "") && /did you mean 'Alpha Voice'/.test(bad.err?.hint ?? ""), bad.err && { msg: bad.err.message, hint: bad.err.hint });
  } finally { Object.defineProperty(process, "platform", platform); process.env.PATH = pathWas; }
}
check("openai without config is a missing_dependency", await rejectsCode(() => AN.tts("x", join(tmp, "o.wav"), "openai:nova"), "missing_dependency") === true);

console.log("tts over http (local server)");
// the fake /v1/audio/speech server runs in its own process.
ff("-f", "lavfi", "-i", "sine=frequency=500:duration=0.7", "-ar", "24000", join(tmp, "reply.wav"));
const KEY = "sk-test-SECRET-123";
const serverJs = join(tmp, "server.mjs");
writeFileSync(serverJs, `import http from "node:http"; import fs from "node:fs";
const [log, wav] = process.argv.slice(2);
http.createServer((req, res) => { let b = ""; req.on("data", (d) => b += d); req.on("end", () => {
  fs.appendFileSync(log, JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, type: req.headers["content-type"], body: JSON.parse(b || "null") }) + "\\n");
  if (req.headers.authorization !== "Bearer ${KEY}") { res.writeHead(401); return res.end('{"error":"bad key"}'); }
  res.writeHead(200, { "content-type": "audio/wav" }); res.end(fs.readFileSync(wav)); }); }).listen(0, "127.0.0.1", function () { console.log(this.address().port); });`);
const reqLog = join(tmp, "req.log");
const srv = spawn(process.execPath, [serverJs, reqLog, join(tmp, "reply.wav")], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise<number>((res) => srv.stdout!.once("data", (d) => res(Number(String(d).trim()))));
try {
  Object.assign(process.env, { AGENTCUT_TTS_URL: `http://127.0.0.1:${port}/v1`, AGENTCUT_TTS_KEY: KEY, AGENTCUT_TTS_MODEL: "tts-test" });
  const out = join(tmp, "vo.wav");
  const r = await AN.tts("Xin chào", out, "openai:shimmer", 175);
  const req = JSON.parse(readFileSync(reqLog, "utf8").trim().split("\n").pop()!);
  check("POST /v1/audio/speech with bearer key + json", req.method === "POST" && req.url === "/v1/audio/speech" && req.auth === `Bearer ${KEY}` && req.type === "application/json", req);
  check("request body", JSON.stringify(req.body) === JSON.stringify({ model: "tts-test", input: "Xin chào", voice: "shimmer", response_format: "wav", speed: 1 }), req.body);
  check("reply converted to 48 kHz stereo", r.provider === "openai" && Math.abs(r.duration - 0.7) < 0.05 && /48000/.test(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", out], { encoding: "utf8" }).stdout), r);
  const lv = api.voices();
  check("voices lists openai as available with key status only", lv.providers.find((p: any) => p.name === "openai")?.available === true && lv.voices.some((v: any) => v.name === "openai:nova") && !JSON.stringify(lv).includes(KEY));
  await api.apply(P, [{ op: "add_voiceover", text: "hello", voice: "openai:alloy" }]);
  check("add_voiceover goes through the http provider", (await api.info(P, "json")).timeline.tracks.find((t: any) => t.id === "voice").clips.length === 1);
  { // bad input is refused before any engine request, and the batch saves nothing
    const sent = () => readFileSync(reqLog, "utf8").length, was = sent(), timeline = JSON.stringify((await api.info(P, "json")).timeline);
    const code = async (extra: any) => (await api.apply(P, [{ op: "add_voiceover", voice: "openai:alloy", text: "hello", ...extra }]).catch((x) => x)).code;
    check("add_voiceover: empty text is missing_input, a rate that is not positive is bad_value, no engine request, nothing saved",
      await code({ text: "  " }) === "missing_input" && await code({ rate: 0 }) === "bad_value" && await code({ rate: -3 }) === "bad_value" && await code({ rate: "175" }) === "bad_value" && sent() === was && JSON.stringify((await api.info(P, "json")).timeline) === timeline);
    await AN.tts("hello", join(tmp, "vo-null-rate.wav"), "openai:alloy", null);
    const last = JSON.parse(readFileSync(reqLog, "utf8").trim().split("\n").pop()!);
    check("tts: a null rate is the voice's default rate", sent() > was && !("speed" in last.body), last.body);
  }
  { // media/ as a link: add_voiceover is refused and the target is unchanged (content, entries, mtimes)
    const W = join(tmp, "vo-link"), t = join(tmp, "vo-link-target");
    api.create(W, { preset: "720p" });
    mkdirSync(t);
    writeFileSync(join(t, "keep.txt"), "keep");
    utimesSync(t, 1e9, 1e9);
    const snap = () => `${readdirSync(t).sort().join(",")}|${readFileSync(join(t, "keep.txt"), "utf8")}|${statSync(t).mtimeMs}`;
    const was = snap();
    rmSync(join(W, "media"), { recursive: true });
    symlinkSync(t, join(W, "media"));
    const e: any = await api.apply(W, [{ op: "add_voiceover", text: "hello", voice: "openai:alloy" }]).catch((x) => x);
    check("media/ as a link: add_voiceover -> unsafe_path, the target is unchanged", e.code === "unsafe_path" && snap() === was, { code: e.code, now: snap() });
  }

  { // one request per sentence, in order; a one-sentence script is one request
    const reqs = () => readFileSync(reqLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const n0 = reqs().length;
    const rs = await AN.tts("Một. Hai? Ba!", join(tmp, "vo3.wav"), "openai:shimmer");
    const got = reqs().slice(n0);
    check("http: three sentences make three requests, in order", JSON.stringify(got.map((q: any) => q.body.input)) === JSON.stringify(["Một.", "Hai?", "Ba!"]), got.map((q: any) => q.body.input));
    const ss = (rs as any).sentences ?? [];
    check("http: sentences are contiguous, start at 0 and end at the file duration",
      ss.length === 3 && ss[0].start === 0 && ss.every((s: any, i: number) => i === 0 || s.start === ss[i - 1].end) && Math.abs(ss[2].end - rs.duration) < 1 / 30 && ss.every((s: any) => Math.abs(s.end - s.start - 0.7) < 0.05), { ss, d: rs.duration });
    const n1 = reqs().length;
    const one = await AN.tts("Chỉ một câu", join(tmp, "vo1.wav"), "openai:shimmer");
    check("http: a one-sentence script makes one request and one sentence spanning the file", reqs().length === n1 + 1 && (one as any).sentences?.length === 1 && (one as any).sentences[0].text === "Chỉ một câu" && (one as any).sentences[0].start === 0 && Math.abs((one as any).sentences[0].end - one.duration) < 1 / 30, (one as any).sentences);
  }

  process.env.AGENTCUT_TTS_KEY = "sk-wrong-SECRET-456";
  let msg = "";
  try { await AN.tts("x", join(tmp, "e.wav"), "openai:nova"); } catch (e: any) { msg = `${e.code} ${e.message} ${e.hint}`; }
  check("http error surfaces status, never the key", msg.startsWith("tts_failed") && msg.includes("401") && !msg.includes("SECRET"), msg);

  // piper: fake binary on PATH records argv/stdin and writes a wav
  const bin = join(tmp, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "piper"), `#!/bin/sh\necho "$1" >> "${tmp}/piper.calls"\necho "$@" > "${tmp}/piper.args"\ncat > "${tmp}/piper.stdin"\nwhile [ $# -gt 0 ]; do [ "$1" = "--output_file" ] && cp "${tmp}/reply.wav" "$2"; shift; done\n`);
  chmodSync(join(bin, "piper"), 0o755);
  writeFileSync(join(tmp, "vi.onnx"), ""); writeFileSync(join(tmp, "vi.onnx.json"), JSON.stringify({ language: { code: "vi_VN" } }));
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, AGENTCUT_PIPER_MODEL: join(tmp, "vi.onnx"), AGENTCUT_TTS_PROVIDER: "piper" });
  const pr = await AN.tts("Chào bạn", join(tmp, "piper.wav"), undefined, 350);
  const args = readFileSync(join(tmp, "piper.args"), "utf8");
  check("piper via env default: model, length_scale, text on stdin", pr.provider === "piper" && args.includes(`--model ${join(tmp, "vi.onnx")}`) && args.includes("--length_scale 0.500") && readFileSync(join(tmp, "piper.stdin"), "utf8") === "Chào bạn", args);
  const piperCalls = () => readFileSync(join(tmp, "piper.calls"), "utf8").trim().split("\n");
  check("piper is found on PATH without being started: the one tts call is the only invocation", JSON.stringify(piperCalls()) === JSON.stringify(["--model"]), piperCalls());
  check("voices lists piper with its model language", api.voices("vi").voices.some((v: any) => v.provider === "piper" && v.lang === "vi_VN"));
  check("provider detection (voices) starts no piper", JSON.stringify(piperCalls()) === JSON.stringify(["--model"]) && api.voices().providers.find((p: any) => p.name === "piper")?.available === true, piperCalls());

  { // per-sentence synthesis: a fake piper that records each call and speaks 0.5 s per word without any pause (a sentence with a comma has a clause pause and a silent tail)
    const binS = join(tmp, "bin-sentences"); mkdirSync(binS);
    writeFileSync(join(binS, "piper"), `#!/bin/sh
n=$(cat "${tmp}/ps.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${tmp}/ps.n"
cat > "${tmp}/ps.in.$n"
printf '%s' "$ORT_DISABLE_TELEMETRY" > "${tmp}/ps.ort.$n"
[ "$(cat "${tmp}/ps.fail" 2>/dev/null)" = "$n" ] && { echo "boom" >&2; exit 1; }
while [ $# -gt 0 ]; do [ "$1" = "--output_file" ] && o="$2"; shift; done
w=$(wc -w < "${tmp}/ps.in.$n" | tr -d ' ')
if grep -q , "${tmp}/ps.in.$n"; then
  # a clause sentence: 1.2 s, a 0.5 s pause, 0.6 s, then a 0.5 s silent tail
  S="-f lavfi -t 0.5 -i anullsrc=r=22050:cl=mono"
  ffmpeg -v error -y -f lavfi -t 1.2 -i "sine=frequency=400:sample_rate=22050" $S -f lavfi -t 0.6 -i "sine=frequency=400:sample_rate=22050" $S -filter_complex "[0][1][2][3]concat=n=4:v=0:a=1" "$o"
else
  ffmpeg -v error -y -f lavfi -i "sine=frequency=400:duration=$(awk "BEGIN{print $w*0.5}")" -ar 22050 "$o"
fi
`);
    chmodSync(join(binS, "piper"), 0o755);
    const pathWas = process.env.PATH;
    const calls = () => Number(readFileSync(join(tmp, "ps.n"), "utf8").trim());
    const input = (i: number) => readFileSync(join(tmp, `ps.in.${i}`), "utf8");
    process.env.PATH = `${binS}:${pathWas}`;
    try {
      writeFileSync(join(tmp, "ps.n"), "0");
      const text = "Một hai ba. Bốn năm? Sáu bảy tám chín!";
      const r: any = await AN.tts(text, join(tmp, "ps.wav"));
      check("piper: three sentences make three invocations, one sentence on each stdin", calls() === 3 && [input(1), input(2), input(3)].join("|") === "Một hai ba.|Bốn năm?|Sáu bảy tám chín!", { calls: calls() });
      const ss = r.sentences ?? [];
      check("piper: sentences are contiguous, follow each part's length and sum to the file duration (1 frame)",
        ss.length === 3 && ss[0].start === 0 && ss.every((s: any, i: number) => i === 0 || s.start === ss[i - 1].end) && Math.abs(ss[2].end - r.duration) < 1 / 30
        && [1.5, 1, 2].every((d, i) => Math.abs(ss[i].end - ss[i].start - d) < 0.05) && ss.map((s: any) => s.text).join(" ") === text, { ss, d: r.duration });
      check("piper: the joined file is 48 kHz stereo", /48000,2/.test(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", join(tmp, "ps.wav")], { encoding: "utf8" }).stdout));

      const V = join(tmp, "vo-piper");
      api.create(V, { preset: "720p" });
      writeFileSync(join(tmp, "ps.n"), "0");
      await api.apply(V, [{ op: "add_voiceover", text, voice: "piper", captions: "clean" }]);
      const cap = (await api.info(V, "json")).timeline.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === "captions");
      const first = (k: number) => cap.words.filter((_: any, i: number) => i === 0 || /[.!?]$/.test(cap.words[i - 1].text))[k];
      check("add_voiceover: each sentence's first caption word starts at that sentence's start", [0, 1.5, 2.5].every((t, k) => first(k) && Math.abs(first(k).start - t) < 0.02), cap.words);
      check("add_voiceover: caption words keep the script", cap.words.map((w: any) => w.text).join(" ") === text);

      writeFileSync(join(tmp, "ps.n"), "0");
      const o1: any = await AN.tts("Chỉ một câu", join(tmp, "ps1.wav"));
      check("piper: a one-sentence script is one invocation and one sentence", calls() === 1 && o1.sentences?.length === 1 && o1.sentences[0].start === 0 && Math.abs(o1.sentences[0].end - o1.duration) < 1 / 30, { calls: calls(), s: o1.sentences });

      { // clause pause and silent tail inside one sentence: captions follow the detected speech, not a spread over the whole span
        const T2 = "Một hai ba. Bốn năm, sáu bảy. Chín mười.";
        const C = join(tmp, "vo-clause");
        api.create(C, { preset: "720p" });
        await api.apply(C, [{ op: "add_voiceover", text: T2, voice: "piper", captions: "clean" }]);
        const cw = (await api.info(C, "json")).timeline.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === "captions").words;
        const w = (txt: string) => cw.find((x: any) => x.text === txt);
        check("clause pause: the second clause starts at its detected speech (3.2 s), not at a spread time", w("sáu") && Math.abs(w("sáu").start - 3.2) < 0.05 && Math.abs(w("Bốn").start - 1.5) < 0.05, cw);
        check("silent tail: the sentence's last word ends before its tail (3.8 s, span ends 4.3 s)", w("bảy.") && Math.abs(w("bảy.").end - 3.8) < 0.05 && Math.abs(w("Chín").start - 4.3) < 0.05, cw);
      }
      { // the join step fails (an ffmpeg wrapper refuses the concat demuxer): tts_failed "join", no output
        const real = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim();
        const binJ = join(tmp, "bin-join"); mkdirSync(binJ);
        writeFileSync(join(binJ, "ffmpeg"), `#!/bin/sh\ncase " $* " in *" concat "*) echo "refused" >&2; exit 1;; esac\nexec "${real}" "$@"\n`);
        chmodSync(join(binJ, "ffmpeg"), 0o755);
        const joined = join(tmp, "ps-join.wav");
        process.env.PATH = `${binJ}:${process.env.PATH}`;
        let err: any;
        try { await AN.tts("Một hai. Ba bốn.", joined); } catch (e: any) { err = e; } finally { process.env.PATH = `${binS}:${pathWas}`; }
        check("a failing join is tts_failed 'tts join failed' and leaves no output", err?.code === "tts_failed" && err.message.startsWith("tts join failed") && !existsSync(joined) && readdirSync(tmp).every((f) => !f.startsWith("ps-join")), err && { code: err.code, msg: err.message });
      }

      // a failing second part: an error, no output file, nothing left beside it, an unchanged timeline
      const F = join(tmp, "vo-fail");
      api.create(F, { preset: "720p" });
      const media = () => readdirSync(join(F, "media")).sort().join(",");
      const tlJson = async () => JSON.stringify((await api.info(F, "json")).timeline);
      const wasMedia = media(), wasTl = (await tlJson());
      writeFileSync(join(tmp, "ps.n"), "0"); writeFileSync(join(tmp, "ps.fail"), "2");
      const e: any = await api.apply(F, [{ op: "add_voiceover", text, voice: "piper", captions: "clean" }]).catch((x) => x);
      check("a failing second part fails the op with tts_failed, writes no output and leaves the timeline unchanged", e.code === "tts_failed" && calls() === 2 && media() === wasMedia && (await tlJson()) === wasTl, { code: e.code, calls: calls(), media: media(), msg: e.message });
      writeFileSync(join(tmp, "ps.n"), "0");
      const direct = join(tmp, "ps-fail.wav");
      writeFileSync(join(tmp, "ps.fail"), "3");
      check("tts(): a failing last part throws and leaves no output file", await rejectsCode(() => AN.tts(text, direct), "tts_failed") === true && !existsSync(direct) && readdirSync(tmp).every((f) => !f.startsWith("ps-fail")));
      rmSync(join(tmp, "ps.fail"));

      // onnxruntime telemetry stays off for piper whatever the inherited value
      writeFileSync(join(tmp, "ps.n"), "0");
      process.env.ORT_DISABLE_TELEMETRY = "0";
      try { await AN.tts("Chào bạn", join(tmp, "ps-ort.wav")); } finally { delete process.env.ORT_DISABLE_TELEMETRY; }
      check("piper is spawned with ORT_DISABLE_TELEMETRY=1, whatever the inherited value", readFileSync(join(tmp, "ps.ort.1"), "utf8") === "1", readFileSync(join(tmp, "ps.ort.1"), "utf8"));
    } finally { process.env.PATH = pathWas; }
  }

  // transcribe contract (whisper.cpp): whole words (-sow), punctuation is never a word of its own - it joins the previous word
  // (a leading one joins the next) and stretches its end; `text` has no space before punctuation. Fake whisper-cli on PATH.
  const tok = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
  writeFileSync(join(tmp, "whisper.json"), JSON.stringify({ result: { language: "vi" }, transcription: [tok("“", 100, 200), tok(" Xin", 200, 500), tok(" chào", 500, 900), tok(" các", 900, 1100), tok(" bạn", 1100, 1400), tok(",", 1400, 1450),
    tok(" hôm", 1800, 2100), tok(" nay", 2100, 2400), tok("...", 2400, 2500), tok(" nhé", 3000, 3300), tok("!", 3300, 3350)] }));
  writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\necho "$1" >> "${tmp}/whisper.calls"\nprintf '%s\\n' "$@" > "${tmp}/whisper.args"\nwhile [ $# -gt 0 ]; do [ "$1" = "-of" ] && cp "${tmp}/whisper.json" "$2.json"; [ "$1" = "-f" ] && cp "$2" "${tmp}/whisper.wav"; shift; done\n`);
  chmodSync(join(bin, "whisper-cli"), 0o755);
  writeFileSync(join(tmp, "fake.bin"), ""); // the model file: the engine is a stand-in, but the path is checked
  const tr = await AN.transcribe(join(tmp, "reply.wav"), "vi", join(tmp, "fake.bin"));
  const wargs = readFileSync(join(tmp, "whisper.args"), "utf8").split("\n");
  check("transcribe asks whisper.cpp for whole words: -sow with -ml 1, the model and the language", wargs.includes("-sow") && wargs.includes("-ml") && wargs[wargs.indexOf("-m") + 1] === join(tmp, "fake.bin") && wargs[wargs.indexOf("-l") + 1] === "vi", wargs);
  check("transcribe: punctuation-only tokens join the previous word (a leading one the next)", JSON.stringify(tr.words.map((w: any) => w.text)) === JSON.stringify(["“Xin", "chào", "các", "bạn,", "hôm", "nay...", "nhé!"]), tr.words);
  check("transcribe: a word with punctuation ends where the punctuation ends, starts are untouched", JSON.stringify(tr.words.map((w: any) => [w.start, w.end])) === JSON.stringify([[0.2, 0.5], [0.5, 0.9], [0.9, 1.1], [1.1, 1.45], [1.8, 2.1], [2.1, 2.5], [3, 3.35]]), tr.words);
  check("transcribe: text has no space before punctuation", tr.text === "“Xin chào các bạn, hôm nay... nhé!" && tr.language === "vi", tr.text);
  check("transcribe starts whisper-cli once, for the transcription itself (no probe call)", readFileSync(join(tmp, "whisper.calls"), "utf8") === "-m\n", readFileSync(join(tmp, "whisper.calls"), "utf8"));

  // transcribe range: only [start, end] of the media goes to the engine, and the word times stay in media seconds
  {
    const src = join(tmp, "range.wav"), given = join(tmp, "whisper.wav"), fake = join(tmp, "fake.bin"), calls = () => readFileSync(join(tmp, "whisper.calls"), "utf8").split("\n").filter(Boolean).length;
    ff("-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono:d=2", "-f", "lavfi", "-i", "sine=frequency=300:duration=4:sample_rate=24000", "-filter_complex", "concat=n=2:v=0:a=1", src); // 2 s of silence, then 4 s of tone
    const dur = (f: string) => +spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout;
    /** peak level (dB) over the first 0.5 s of a wav: about -18 for the tone, -91 or lower for digital silence */
    const startDb = (f: string) => { const m = /max_volume: (\S+) dB/.exec(spawnSync("ffmpeg", ["-v", "info", "-nostdin", "-t", "0.5", "-i", f, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" }).stderr); return m ? (m[1] === "-inf" ? -Infinity : +m[1]) : NaN; };
    const engine = [[0.2, 0.5], [0.5, 0.9], [0.9, 1.1], [1.1, 1.45], [1.8, 2.1], [2.1, 2.5], [3, 3.35]], shifted = (by: number) => engine.map(([a, b]) => [+(a + by).toFixed(3), +(b + by).toFixed(3)]);
    const times = (ws: any[]) => JSON.stringify(ws.map((w) => [w.start, w.end]));
    // a leading silence is not sent: the engine gets the media from 0.1 s before the first sound, the word times are shifted by what was left out, and the result says how much
    const whole = await AN.transcribe(src, "vi", fake);
    check("no range: the engine gets the media from 0.1 s before the first sound (2 s of silence: 1.9 s left out), starting on the tone", Math.abs(dur(given) - 4.1) < 0.05 && startDb(given) > -30 && whole.skipped_leading === 1.9, { dur: dur(given), db: startDb(given), skipped: whole.skipped_leading });
    check("no range: every word start and end is the engine's time + what was left out", times(whole.words) === JSON.stringify(shifted(1.9)), times(whole.words));
    const inSilence = await AN.transcribe(src, "vi", fake, [1, 5.5]);
    check("a range that starts in silence is trimmed the same way (1 s of silence in the range: 0.9 s left out)", Math.abs(dur(given) - 3.6) < 0.05 && inSilence.skipped_leading === 0.9 && times(inSilence.words) === JSON.stringify(shifted(1.9)), { dur: dur(given), skipped: inSilence.skipped_leading, words: times(inSilence.words) });
    const ranged = await AN.transcribe(src, "vi", fake, [2, 5.5]);
    check("range [2, 5.5]: the engine gets end - start seconds, starting at start (not silent); no silence, nothing left out", Math.abs(dur(given) - 3.5) < 0.05 && startDb(given) > -30 && ranged.skipped_leading === 0, { dur: dur(given), db: startDb(given), skipped: ranged.skipped_leading });
    check("range [2, 5.5]: every word start and end is the engine's time + start", times(ranged.words) === JSON.stringify(shifted(2)), times(ranged.words));
    // the words stay inside the range: one starting at or after the end is dropped (with its punctuation), one crossing it ends at it, a zero-length one stays
    const fakeJson = readFileSync(join(tmp, "whisper.json"), "utf8");
    writeFileSync(join(tmp, "whisper.json"), JSON.stringify({ result: { language: "vi" }, transcription: [tok(" a", 100, 300), tok(" b", 1000, 1000), tok(" c", 2800, 3300), tok(".", 3300, 3350), tok(" d", 3300, 3600), tok("!", 3600, 3650)] }));
    const held = await AN.transcribe(src, "vi", fake, [2, 5]);
    writeFileSync(join(tmp, "whisper.json"), fakeJson);
    check("range words are clamped to the range: a word past the end is dropped, one crossing it ends there, a zero-length word stays", JSON.stringify(held.words.map((w: any) => [w.text, w.start, w.end])) === JSON.stringify([["a", 2.1, 2.3], ["b", 3, 3], ["c.", 4.8, 5]]), held.words);
    check("whisper.cpp: text is the kept words, not the dropped one", held.text === "a b c.", held.text);

    // python whisper takes the same rules: it names its output after the wav it is given (a stand-in that does the same), and its text is rebuilt from the kept words
    {
      const binPy = join(tmp, "bin-py-range"), pathNow = process.env.PATH!, modelNow = process.env.AGENTCUT_WHISPER_MODEL;
      mkdirSync(binPy);
      writeFileSync(join(binPy, "whisper"), `#!/bin/sh\ncp "$1" "${tmp}/py.wav"\nwav="$1"\nwhile [ $# -gt 0 ]; do [ "$1" = "--output_dir" ] && od="$2"; shift; done\nn=$(basename "$wav" .wav)\nprintf '%s' '{"language":"vi","text":" a b c d","segments":[{"words":[{"word":" a","start":0.1,"end":0.3},{"word":" b","start":1,"end":1},{"word":" c","start":2.8,"end":3.3},{"word":" d","start":3.3,"end":3.6}]}]}' > "$od/$n.json"\n`, { mode: 0o755 });
      process.env.PATH = `${binPy}:${pathNow}`; delete process.env.AGENTCUT_WHISPER_MODEL;
      try {
        const py = await AN.transcribe(src, "vi", undefined, [2, 5]);
        check("python whisper: words are clamped to the range, a word past the end is dropped from words and from text", JSON.stringify(py.words.map((w: any) => [w.text, w.start, w.end])) === JSON.stringify([["a", 2.1, 2.3], ["b", 3, 3], ["c", 4.8, 5]]) && py.text === "a b c" && py.skipped_leading === 0, { w: py.words, t: py.text });
        const lead = await AN.transcribe(src, "vi", undefined);
        check("python whisper: the engine gets the media from 0.1 s before the first sound, the times are shifted by it, and the result says so", Math.abs(dur(join(tmp, "py.wav")) - 4.1) < 0.05 && lead.skipped_leading === 1.9 && lead.words[0].start === 2 && lead.words[0].end === 2.2, { dur: dur(join(tmp, "py.wav")), skipped: lead.skipped_leading, w: lead.words[0] });
      } finally { process.env.PATH = pathNow; if (modelNow !== undefined) process.env.AGENTCUT_WHISPER_MODEL = modelNow; }
    }
    const before = calls();
    const bads: any[] = [[-1, 2], [2, 2], [3, 2], [NaN, 2], [0, Infinity], [0], [0, 1, 2], ["1", 2], "2-5", 3];
    const badRange = await Promise.all(bads.map((r) => rejectsCode(() => AN.transcribe(src, "vi", fake, r), "bad_value")));
    check("a bad range is bad_value and starts no engine", badRange.every((x) => x === true) && calls() === before, badRange);

    const was = process.env.AGENTCUT_WHISPER_MODEL;
    process.env.AGENTCUT_WHISPER_MODEL = fake;
    try {
      const Q = join(tmp, "cap-range");
      api.create(Q, { preset: "720p" });
      const caps = async () => (await api.info(Q, "json")).timeline.tracks.flatMap((t: any) => t.clips).filter((c: any) => c.type === "captions");
      await api.apply(Q, [{ op: "add_captions", transcribe: src, language: "vi", transcribe_range: [2, 5.5] }]);
      check("add_captions transcribe_range: the captions clip holds the shifted times and no range field", (await caps()).length === 1 && times((await caps())[0].words) === JSON.stringify(shifted(2)) && !("transcribe_range" in (await caps())[0]), (await caps())[0]?.words);
      const was2 = JSON.stringify((await api.info(Q, "json")).timeline);
      const e1: any = await api.apply(Q, [{ op: "add_captions", words: [{ text: "Hi", start: 0, end: 0.4 }], transcribe_range: [0, 2] }]).catch((x) => x);
      const e2: any = await api.apply(Q, [{ op: "add_captions", transcribe: src, transcribe_range: [3, 3] }]).catch((x) => x);
      check("add_captions: transcribe_range without transcribe, and a bad range, are bad_value and leave the timeline unchanged", e1.code === "bad_value" && e2.code === "bad_value" && JSON.stringify((await api.info(Q, "json")).timeline) === was2, { e1: e1.code, e2: e2.code });
    } finally { if (was === undefined) delete process.env.AGENTCUT_WHISPER_MODEL; else process.env.AGENTCUT_WHISPER_MODEL = was; }
  }

  // add_captions transcribe: where clips on the timeline play the media, the words follow them; the captions record the cut and validate warns when it changes
  {
    const talk = join(tmp, "talk.mp4"), fake = join(tmp, "fake.bin"), was = process.env.AGENTCUT_WHISPER_MODEL, saved = readFileSync(join(tmp, "whisper.json"), "utf8");
    ff("-f", "lavfi", "-i", "color=c=blue:size=160x90:rate=30:d=8", "-f", "lavfi", "-i", "sine=f=440:d=8,volume='not(between(t,2,5))':eval=frame", "-shortest", "-pix_fmt", "yuv420p", "-c:a", "aac", talk); // tone, 3 s of silence, tone
    const said = (ws: [string, number, number][]) => writeFileSync(join(tmp, "whisper.json"), JSON.stringify({ result: { language: "en" }, transcription: ws.map(([t, a, b]) => tok(" " + t, a * 1000, b * 1000)) }));
    said([["a", 0.5, 0.9], ["b", 2.2, 2.6], ["c", 3.2, 3.6], ["d", 5.5, 5.9], ["e", 6.5, 6.9], ["f", 7.8, 8]]);
    const asrCalls = () => (existsSync(join(tmp, "whisper.calls")) ? readFileSync(join(tmp, "whisper.calls"), "utf8").split("\n").filter(Boolean).length : 0);
    const tlOf = async (P: string) => (await api.info(P, "json")).timeline, capsOf = async (P: string) => (await tlOf(P)).tracks.flatMap((t: any) => t.clips).filter((c: any) => c.type === "captions");
    const tw = (c: any) => c.words.map((w: any) => [w.text, w.start, w.end]);
    const stale = async (P: string) => (await api.validate(P)).issues.filter((i: any) => /timed_for/.test(i.path));
    process.env.AGENTCUT_WHISPER_MODEL = fake;
    try {
      // a clip taken from second 2, and a clip at 5 s playing source 4..8 at speed 2: a word lands at start + (word - in) / speed
      const A = join(tmp, "cap-map");
      api.create(A, { preset: "720p" });
      await api.apply(A, [{ op: "add_clip", track: "overlay", src: talk, in: 2, duration: 3, at: 0 }, { op: "add_clip", track: "overlay", src: talk, in: 4, speed: 2, duration: 2, at: 5 }]);
      const made: any = await api.apply(A, [{ op: "add_captions", transcribe: "talk" }]);
      const [ca] = await capsOf(A);
      check("captions of media that clips play: words land at start + (word - in) / speed, and a word no clip plays is dropped",
        (await capsOf(A)).length === 1 && JSON.stringify(tw(ca)) === JSON.stringify([["b", 0.2, 0.6], ["c", 1.2, 1.6], ["d", 5.75, 5.95], ["e", 6.25, 6.45], ["f", 6.9, 7]]), tw(ca));
      check("the captions clip does not outlive the last clip that plays the media, and the timeline does not grow",
        ca.start === 0 && ca.duration === 7 && made.duration === 7, { start: ca.start, dur: ca.duration, total: made.duration });
      check("the captions record the asset and the cut they were timed for; validate has no warning for them", JSON.stringify(ca.timed_for) === JSON.stringify({ asset: "talk", cut: [[2, 5, 0, 1], [4, 8, 5, 2]] }) && (await stale(A)).length === 0, { t: ca.timed_for, issues: await stale(A) });
      const before = asrCalls(), refused: any = await api.apply(A, [{ op: "add_captions", transcribe: "talk", at: 1 }]).catch((e) => e);
      check("at is refused with bad_arg when the media plays on the timeline, before any engine runs", refused.code === "bad_arg" && /'at'/.test(refused.message) && asrCalls() === before && (await capsOf(A)).length === 1, { code: refused.code, msg: refused.message, calls: asrCalls() - before });
      // the cut changes: a trim, then a move, each warn (in review too); putting it back clears the warning
      const trimmed: any = await api.apply(A, [{ op: "trim_clip", id: "vid1", trim_start: 0.5 }]);
      check("trimming a clip that plays the media warns in the apply result and in validate, naming the captions clip", trimmed.issues.some((i: any) => i.level === "warning" && /timed_for/.test(i.path) && i.hint.includes(ca.id)) && (await stale(A)).length === 1, trimmed.issues);
      const rv: any = await api.review(A);
      check("review carries the same warning", JSON.stringify(rv).includes("timed_for"), Object.keys(rv));
      await api.apply(A, [{ op: "update_clip", id: "vid1", set: { start: 0, in: 2, duration: 3 } }]);
      check("restoring the clip clears the warning", (await stale(A)).length === 0, await stale(A));
      const moved: any = await api.apply(A, [{ op: "update_clip", id: "vid2", set: { start: 5.5 } }]);
      check("moving a clip that plays the media warns", moved.issues.some((i: any) => /timed_for/.test(i.path)) && (await stale(A)).length === 1, moved.issues);

      // remove_silence first (the video's detached audio is cut into the same segments), then one captions clip: the words follow the segments, those in the removed stretch are dropped
      const B = join(tmp, "cap-cut");
      api.create(B, { preset: "720p" });
      await api.apply(B, [{ op: "add_clip", track: "main", src: talk }, { op: "detach_audio", id: "vid1" }, { op: "remove_silence", id: "vid1" }]);
      const tB0 = await tlOf(B), pieces = tB0.tracks.flatMap((t: any) => t.clips).filter((c: any) => c.type === "audio"), second = pieces[pieces.length - 1];
      const cutB: any = await api.apply(B, [{ op: "add_captions", transcribe: "talk" }]);
      const [cb] = await capsOf(B), at = (src: number) => +(second.start + (src - second.in)).toFixed(3);
      check("after remove_silence the words follow the audio pieces and those cut away are dropped: one captions clip, one engine run",
        pieces.length === 2 && cb.words.map((w: any) => w.text).join("") === "adef" && cb.words[1].start === at(5.5) && cb.words[2].start === at(6.5) && (await capsOf(B)).length === 1, { pieces: pieces.map((c: any) => [c.in, c.start, c.duration]), words: tw(cb) });
      check("the captions clip ends with the cut, so the timeline keeps its length", cb.duration <= cutB.duration + 1e-6 && Math.abs(cutB.duration - pieces.reduce((e: number, c: any) => Math.max(e, c.start + c.duration), 0)) < 1e-3 && (await stale(B)).length === 0, { cap: cb.duration, total: cutB.duration });

      // splitting a clip that plays the media leaves the same sound: no warning
      const H = join(tmp, "cap-split-played");
      api.create(H, { preset: "720p" });
      await api.apply(H, [{ op: "add_clip", track: "overlay", src: talk, at: 0 }, { op: "add_captions", transcribe: "talk" }]);
      const splitH: any = await api.apply(H, [{ op: "split_clip", id: "vid1", at: 3 }]);
      check("splitting a clip that plays the media gives no warning, and a clip that continues the previous one is one row", splitH.issues.length === 0 && (await stale(H)).length === 0 && JSON.stringify((await capsOf(H))[0].timed_for.cut) === JSON.stringify([[0, 8, 0, 1]]), { issues: splitH.issues, cut: (await capsOf(H))[0].timed_for.cut });

      // the cut is relative to the captions clip: the captions moved alone warn; trimming or splitting the captions clip moves its words and the cut together
      const G = join(tmp, "cap-own-start");
      api.create(G, { preset: "720p" });
      await api.apply(G, [{ op: "add_clip", track: "overlay", src: talk, at: 0 }, { op: "add_captions", transcribe: "talk" }]);
      const wl = async () => (await stale(G)).length;
      await api.apply(G, [{ op: "update_clip", id: "cap1", set: { start: 1 } }]);
      const alone = await wl();
      await api.apply(G, [{ op: "update_clip", id: "cap1", set: { start: 0 } }]);
      check("the captions clip moved alone warns, and moved back it does not", alone === 1 && (await wl()) === 0, { alone, back: await wl() });
      await api.apply(G, [{ op: "trim_clip", id: "cap1", trim_start: 0.5 }]);
      const trimmedCaps = await wl();
      await api.apply(G, [{ op: "split_clip", id: "cap1", at: 3 }]);
      check("a head trim of the captions clip, then a split of it, leave no warning on either half (the recorded cut moves with the words)", trimmedCaps === 0 && (await capsOf(G)).length === 2 && (await wl()) === 0, { trim: trimmedCaps, halves: (await capsOf(G)).map((c: any) => c.timed_for), issues: await stale(G) });
      const magnetic: any = await api.apply(G, [{ op: "add_track", id: "mcap", kind: "video", magnetic: true }, { op: "add_captions", transcribe: "talk", track: "mcap" }]).catch((e) => e);
      check("a transcript's captions on a magnetic track are bad_arg", magnetic.code === "bad_arg" && /magnetic/.test(magnetic.message), { code: magnetic.code, msg: magnetic.message });

      // a speed ramp is not a linear map: the clip is named and its words are not mapped
      const C = join(tmp, "cap-ramp");
      api.create(C, { preset: "720p" });
      await api.apply(C, [{ op: "add_clip", track: "overlay", src: talk, duration: 3, at: 0 }, { op: "add_clip", track: "overlay", src: talk, in: 4, duration: 2, at: 5 }, { op: "set_keyframes", id: "vid2", prop: "speed", keyframes: [[0, 1], [1, 2]] }]);
      const ramp: any = await api.apply(C, [{ op: "add_captions", transcribe: "talk" }]);
      check("a speed-ramped clip is named in the result and its words are not mapped", JSON.stringify(ramp.results[0].unmapped) === JSON.stringify(["vid2"]) && (await capsOf(C))[0].words.map((w: any) => w.text).join("") === "ab", { r: ramp.results[0], w: tw((await capsOf(C))[0]) });

      // media no clip plays keeps its meaning: media seconds from at, ending at the media end
      const D = join(tmp, "cap-free");
      api.create(D, { preset: "720p" });
      await api.apply(D, [{ op: "add_captions", transcribe: talk, at: 2 }]);
      const [cd] = await capsOf(D);
      check("media that no clip plays: media seconds from at, no recorded cut, and the clip ends at the media end (8 s, not 8.3)", cd.start === 2 && cd.words[0].start === 0.5 && cd.words[5].end === 8 && cd.duration === 8 && !("timed_for" in cd), { start: cd.start, dur: cd.duration, w: tw(cd) });
      const E = join(tmp, "cap-limit");
      api.create(E, { preset: "720p" });
      await api.apply(E, [{ op: "add_captions", transcribe: talk, transcribe_range: [0, 6] }]);
      check("a transcribe range ends the captions clip at the range end", (await capsOf(E))[0].duration === 6 && (await capsOf(E))[0].words.map((w: any) => w.text).join("") === "abcd", (await capsOf(E))[0]);
    } finally { writeFileSync(join(tmp, "whisper.json"), saved); if (was === undefined) delete process.env.AGENTCUT_WHISPER_MODEL; else process.env.AGENTCUT_WHISPER_MODEL = was; }
  }

  // analyses inside apply_ops (transcribe, speech, silence) run async with the call's signal and are kept for the call: the batch is re-run once per analysis it asks for, plus the last
  {
    const { Project } = await import("../src/project.ts"), { OPS, applyOps } = await import("../src/ops.ts");
    const src = join(tmp, "reply.wav"), load = Project.prototype.load, realNow = Date.now;
    const was = process.env.AGENTCUT_WHISPER_MODEL, started = (f: string) => (existsSync(join(tmp, f)) ? readFileSync(join(tmp, f), "utf8").trim().split("\n").length : 0);
    const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith("agentcut-vo-"));
    process.env.AGENTCUT_WHISPER_MODEL = join(tmp, "fake.bin");
    let rounds = 0;
    Project.prototype.load = function (this: InstanceType<typeof Project>) { rounds++; return load.call(this); }; // api.apply loads once per round
    try {
      const Z = join(tmp, "rounds"), tmpWas = leftovers();
      api.create(Z, { preset: "720p" });
      const w0 = started("whisper.calls"), p0 = started("piper.calls"), rev0 = (await api.info(Z)).revision, undo0 = api.history(Z).undo.length;
      rounds = 0;
      const r: any = await api.apply(Z, [{ op: "add_captions", transcribe: src, language: "vi" }, { op: "add_voiceover", text: "Chào bạn", voice: "piper" }, { op: "add_marker", t: 1, label: "m" }]);
      const used = rounds;
      check("two analysis ops and an edit take 3 rounds, start each engine once, save once and keep the speech in media/ only",
        used === 3 && started("whisper.calls") === w0 + 1 && started("piper.calls") === p0 + 1 && r.revision === rev0 + 1 && api.history(Z).undo.length === undo0 + 1
        && /^media\/vo-\d+\.wav$/.test(r.results[1].path) && readdirSync(join(Z, "media")).join() === r.results[1].path.slice(6) && leftovers().every((f) => tmpWas.includes(f)),
        { used, whisper: started("whisper.calls") - w0, piper: started("piper.calls") - p0, rev: r.revision, results: r.results.map((x: any) => x.op), media: readdirSync(join(Z, "media")), left: leftovers() });
      check("the results are those of the batch: captions from the transcript, the voiceover clip, the marker",
        r.results.map((x: any) => x.op).join() === "add_captions,add_voiceover,add_marker" && (await api.info(Z, "json")).timeline.tracks.some((t: any) => t.clips.some((c: any) => c.type === "captions" && c.words.length)) && r.results[1].duration > 0.5, r.results);

      // a caller that is not api.apply (prepare, a test) gets an internal error, never a result without the analysis
      const pz = api.openProject(Z), direct = (() => { try { applyOps(pz, pz.load(), [{ op: "add_voiceover", text: "Chào bạn", voice: "piper" }]); return null; } catch (x: any) { return x; } })();
      check("applyOps without the api.apply runner fails closed on an analysis: an internal error, not an EditError, and no piper start", direct && !(direct instanceof Error && "code" in direct) && /^internal: /.test(direct.message) && started("piper.calls") === p0 + 1, direct && direct.message);

      // add_voiceover captions are timed for the voice clip: moving it warns, and the captions end with it
      {
        const V = join(tmp, "vo-captions");
        api.create(V, { preset: "720p" });
        const made: any = await api.apply(V, [{ op: "add_voiceover", text: "Chào bạn", voice: "piper", captions: true }]);
        const tV = async () => (await api.info(V, "json")).timeline, vc = (await tV()).tracks.flatMap((t: any) => t.clips), voice = vc.find((c: any) => c.type === "audio"), cap = vc.find((c: any) => c.type === "captions");
        const staleV = async () => (await api.validate(V)).issues.filter((i: any) => /timed_for/.test(i.path));
        check("voiceover captions record the voice clip's cut, end with the voice clip, and have no warning", JSON.stringify(cap.timed_for) === JSON.stringify({ asset: voice.asset, cut: [[0, voice.duration, 0, 1]] }) && cap.duration <= voice.duration + 1e-6 && made.duration === voice.duration && (await staleV()).length === 0,
          { t: cap.timed_for, cap: cap.duration, voice: voice.duration, total: made.duration });
        await api.apply(V, [{ op: "update_clip", id: voice.id, set: { start: 1 } }]);
        check("moving the voiceover clip warns that the captions no longer match", (await staleV()).length === 1, await staleV());
        await api.apply(V, [{ op: "update_clip", id: cap.id, set: { start: 1 } }]);
        check("moving the captions clip with it clears the warning", (await staleV()).length === 0, await staleV());
      }

      // two voiceovers in one batch, in the same millisecond: each gets its own file and keeps its own speech (a stand-in piper speaks 0.5 s per word)
      {
        const binV = join(tmp, "bin-vo"), pathNow = process.env.PATH;
        mkdirSync(binV);
        writeFileSync(join(binV, "piper"), `#!/bin/sh\ncat > "${tmp}/vo.in"\nwhile [ $# -gt 0 ]; do [ "$1" = "--output_file" ] && o="$2"; shift; done\nexec ffmpeg -v error -y -f lavfi -i "sine=frequency=400:duration=$(awk "BEGIN{print $(wc -w < "${tmp}/vo.in" | tr -d ' ')*0.5}")" -ar 22050 "$o"\n`);
        chmodSync(join(binV, "piper"), 0o755);
        const V2 = join(tmp, "two-vo");
        api.create(V2, { preset: "720p" });
        process.env.PATH = `${binV}:${pathNow}`;
        Date.now = () => 1_700_000_000_000;
        try { await api.apply(V2, [{ op: "add_voiceover", text: "Một hai.", voice: "piper" }, { op: "add_voiceover", text: "Ba bốn năm sáu.", voice: "piper" }]); }
        finally { Date.now = realNow; process.env.PATH = pathNow; }
        const t2 = (await api.info(V2, "json")).timeline, files = readdirSync(join(V2, "media")), clips = t2.tracks.find((t: any) => t.id === "voice").clips;
        const dur = (c: any) => +spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(V2, t2.assets[c.asset].path)], { encoding: "utf8" }).stdout;
        check("two add_voiceover ops in one millisecond write two files, each clip keeping its own speech", files.length === 2 && clips.length === 2 && clips[0].asset !== clips[1].asset
          && Math.abs(dur(clips[0]) - 1) < 0.1 && Math.abs(dur(clips[1]) - 2) < 0.1, { files, assets: clips.map((c: any) => c.asset), durs: clips.map(dur) });

        // a later op that analyses the voiceover's file: the file keeps its name from round to round, so the batch settles in 3 rounds and equals the two ops applied one after the other
        process.env.PATH = `${binV}:${pathNow}`;
        const ac = new AbortController(), stop = setTimeout(() => ac.abort(), 20_000); // bound: an endless re-run ends here
        const V3 = join(tmp, "vo-then-silence"), V4 = join(tmp, "vo-then-silence-2"), speak = { op: "add_voiceover", text: "Một hai. Ba bốn.", voice: "piper" }, cut = { op: "remove_silence", id: "aud1" };
        api.create(V3, { preset: "720p", name: "vo" }); api.create(V4, { preset: "720p", name: "vo" });
        let b: any, a1: any, a2: any, used = -1, undo3 = 0;
        try {
          rounds = 0;
          b = await api.apply(V3, [speak, cut], { signal: ac.signal }).catch((x) => x);
          used = rounds; undo3 = api.history(V3).undo.length;
          a1 = await api.apply(V4, [speak]); a2 = await api.apply(V4, [cut]);
        } finally { clearTimeout(stop); process.env.PATH = pathNow; }
        const same = (o: unknown) => JSON.stringify(o).replace(/vo[-_]\d+/g, "vo-N"), tlOf = async (P: string) => { const t = (await api.info(P, "json")).timeline; delete t.revision; return t; };
        check("add_voiceover then remove_silence of its clip in one batch: 3 rounds, saved once, one voiceover file, the results and timeline of the two ops applied separately",
          b?.ok === true && used === 3 && undo3 === 1 && b.revision === 1 && readdirSync(join(V3, "media")).length === 1 && same(b.results) === same([a1.results[0], a2.results[0]]) && same((await tlOf(V3))) === same((await tlOf(V4))),
          b?.ok ? { used, undo3, media: readdirSync(join(V3, "media")) } : { code: b?.code, msg: b?.message, used });
      }

      // snap_to_beats on an audio file is an analysis too: 2 rounds and one save; the same file named twice in a batch is decoded once, and a later call reuses the decoded beats (a stand-in ffmpeg counts the beat decodes)
      {
        const binB = join(tmp, "bin-beats"), log = join(tmp, "beats.decodes"), clicks = join(tmp, "clicks.wav"), pathNow = process.env.PATH!;
        const realFfmpeg = pathNow.split(":").map((d) => join(d, "ffmpeg")).find((f) => existsSync(f))!;
        mkdirSync(binB);
        writeFileSync(join(binB, "ffmpeg"), `#!/bin/sh\ncase "$*" in *"-f f32le"*) echo x >> '${log}';; esac\nexec '${realFfmpeg}' "$@"\n`, { mode: 0o755 });
        ff("-f", "lavfi", "-i", "sine=f=1000:d=14,volume='lt(mod(t,0.5),0.05)':eval=frame", "-ar", "22050", clicks);
        const decodes = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);
        const B = join(tmp, "beats-rounds"), cuts = [{ op: "add_clip", track: "main", src: join(m, "grey.mp4"), duration: 2 }, { op: "add_clip", track: "main", src: join(m, "grey.mp4"), duration: 2 }];
        api.create(B, { preset: "720p" });
        await api.apply(B, cuts);
        const undoB = api.history(B).undo.length;
        process.env.PATH = `${binB}:${pathNow}`;
        let b1: any, used = -1, n1 = -1, b2: any, n2 = -1;
        try {
          rounds = 0;
          b1 = await api.apply(B, [{ op: "snap_to_beats", track: "main", beats: clicks }, { op: "snap_to_beats", track: "main", beats: clicks, every: 2 }, { op: "add_marker", t: 1, label: "m" }]);
          used = rounds; n1 = decodes();
          b2 = await api.apply(B, [{ op: "snap_to_beats", track: "main", beats: clicks, every: 2 }]);
          n2 = decodes();
        } finally { process.env.PATH = pathNow; }
        check("snap_to_beats of an audio file twice and an edit: 2 rounds, one decode, one save; a later call decodes nothing",
          used === 2 && n1 === 1 && n2 === 1 && api.history(B).undo.length === undoB + 2, { used, n1, n2, undo: api.history(B).undo.length - undoB, r: b1.results });
        // a replaced file replaces its entry: the version it had before the last replacement is decoded again, not remembered
        const swap = join(tmp, "swap.wav"), other = join(tmp, "other.wav"), t1 = new Date(1_700_000_000_000), t2 = new Date(1_700_000_100_000);
        ff("-f", "lavfi", "-i", "sine=f=1000:d=12,volume='lt(mod(t,0.5),0.05)':eval=frame", "-ar", "22050", other);
        const place = (from: string, at: Date) => { copyFileSync(from, swap); utimesSync(swap, at, at); };
        const snap = () => api.apply(B, [{ op: "snap_to_beats", track: "main", beats: swap }]);
        process.env.PATH = `${binB}:${pathNow}`;
        const seen: number[] = [];
        try {
          const n0 = decodes();
          place(clicks, t1); await snap(); seen.push(decodes() - n0);
          place(other, t2); await snap(); seen.push(decodes() - n0);
          place(clicks, t1); await snap(); seen.push(decodes() - n0);
          await snap(); seen.push(decodes() - n0);
        } finally { process.env.PATH = pathNow; }
        check("a file replaced twice is decoded at each new version, and an unchanged one is not decoded again", seen.join() === "1,2,3,3", seen);
      }

      // a writer saves between the batch's last load and its save: the batch is re-applied from the memo (the engine does not start again) even though its analysis took longer than the 10 s deadline
      let bumped = false;
      OPS._other_writer = { doc: "test", args: {}, fn: (p: any) => { if (!bumped) { bumped = true; writeFileSync(p.file, readFileSync(p.file, "utf8").replace(/("revision": )(\d+)/, (_, k, n) => `${k}${Number(n) + 1}`)); } return {}; } };
      const D = join(tmp, "deadline"), w1 = started("whisper.calls");
      api.create(D, { preset: "720p" });
      Date.now = () => realNow() + (started("whisper.calls") > w1 ? 11_000 : 0); // the clock jumps 11 s once the engine has started
      const e: any = await api.apply(D, [{ op: "add_captions", transcribe: src, language: "vi" }, { op: "_other_writer" }]).catch((x) => x);
      Date.now = realNow;
      check("a conflict after a slow analysis is re-applied, not failed, and the engine started once", e.ok === true && e.revision === 2 && started("whisper.calls") === w1 + 1, e.code ? { code: e.code, msg: e.message } : { ok: e.ok, rev: e.revision, whisper: started("whisper.calls") - w1 });
    } finally { Project.prototype.load = load; Date.now = realNow; delete OPS._other_writer; if (was === undefined) delete process.env.AGENTCUT_WHISPER_MODEL; else process.env.AGENTCUT_WHISPER_MODEL = was; }
  }

  // transcribe errors: the media, the range and the engine are checked before anything runs, each error names its cause, and a failed engine
  // reports its own `error:` line, never its usage text. Stand-in engines and a recording ffmpeg on a PATH of their own (no real whisper).
  {
    const E = join(tmp, "asr-err"), tools = join(E, "tools"), ffLog = join(E, "ffmpeg.calls"), asrLog = join(E, "asr.calls"), ffFail = join(E, "ffmpeg.fail");
    mkdirSync(tools, { recursive: true });
    const realOf = (n: string) => (process.env.PATH ?? "").split(":").map((d) => join(d, n)).find((f) => existsSync(f))!;
    for (const n of ["ffmpeg", "ffprobe"]) symlinkSync(realOf(n), join(tools, n));
    const stubFf = join(E, "ff"); mkdirSync(stubFf);
    writeFileSync(join(stubFf, "ffmpeg"), `#!/bin/sh\n[ "$1" = "-version" ] && exec '${realOf("ffmpeg")}' "$@"\necho "$*" >> '${ffLog}'\nif [ -e '${ffFail}' ]; then case "$*" in *16000*) echo "boom: cannot open the input" >&2; exit 1;; esac; fi\nexec '${realOf("ffmpeg")}' "$@"\n`, { mode: 0o755 });
    const engine = (dir: string, name: string, body: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), `#!/bin/sh\necho "${name}" >> '${asrLog}'\n${body}`, { mode: 0o755 }); return dir; };
    // whisper.cpp's own output for a language it does not know (exit 0, no json), captured from whisper-cli 1.9.5
    const unknownLanguage = `printf '%s\\n' "whisper_lang_id: unknown language 'xx'" "error: unknown language 'xx'" "" "usage: whisper-cli [options] file0 file1 ..." "  -h,        --help                 [default] show this help message and exit" >&2\n`;
    const pathWas = process.env.PATH, modelWas = process.env.AGENTCUT_WHISPER_MODEL;
    const withPath = (...dirs: string[]) => { process.env.PATH = [...dirs, tools, "/usr/bin", "/bin"].join(":"); };
    const len = 7.5, src = join(E, "len.wav"), still = join(E, "still.png"), model = join(tmp, "fake.bin");
    ff("-f", "lavfi", "-i", `sine=frequency=300:duration=${len}`, src);
    ff("-f", "lavfi", "-i", "color=c=red:size=64x64", "-frames:v", "1", still);
    const err = async (f: () => Promise<unknown>) => { try { await f(); return {} as any; } catch (e: any) { return e; } };
    const started = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n") : []);
    try {
      process.env.AGENTCUT_WHISPER_MODEL = model;
      const cli = engine(join(E, "cli"), "whisper-cli", `exit 0\n`);
      withPath(cli, stubFf);
      let e = await err(() => AN.transcribe(join(E, "missing.wav"), "vi"));
      check("transcribe: a missing file is not_found and names the path", e.code === "not_found" && e.message.includes(join(E, "missing.wav")), e.message);
      e = await err(() => AN.transcribe(still, "vi"));
      check("transcribe: a still image is no_audio", e.code === "no_audio", e.code);
      e = await err(() => AN.transcribe(src, "vi", join(E, "no-such.bin")));
      check("transcribe: a whisper.cpp model path that does not exist is not_found and names the model file", e.code === "not_found" && e.message.includes(join(E, "no-such.bin")), { code: e.code, msg: e.message });
      for (const range of [[30, undefined], [30, 40]] as [number, number | undefined][]) {
        e = await err(() => AN.transcribe(src, "vi", model, range));
        check(`transcribe: a start past the media's end is bad_value and names its length (${range[1] === undefined ? "no end" : "with an end"})`, e.code === "bad_value" && e.message.includes(String(len)), { code: e.code, msg: e.message });
      }
      e = await err(() => AN.transcribe(src, "vi", model, [len, undefined]));
      check("transcribe: a start at the media's end is bad_value too", e.code === "bad_value" && e.message.includes(String(len)), { code: e.code, msg: e.message });
      check("none of these started an extraction or an engine", started(ffLog).length === 0 && started(asrLog).length === 0, { ff: started(ffLog), asr: started(asrLog) });
      writeFileSync(join(tmp, "whisper.json"), JSON.stringify({ result: { language: "vi" }, transcription: [tok(" a", 200, 500)] }));
      withPath(bin, stubFf); // the stand-in that writes whisper.json
      const open = await AN.transcribe(src, "vi", model, [1, undefined]);
      check("transcribe: a start with no end runs to the media's end, word times in media seconds", open.words[0].start === 1.2 && open.words[0].end === 1.5, open.words);

      // the extraction: ffmpeg's own message, and no engine start
      writeFileSync(ffFail, "");
      e = await err(() => AN.transcribe(src, "vi", model));
      rmSync(ffFail);
      check("transcribe: a failed extraction reports ffmpeg's message and starts no engine", e.code === "decode_failed" && e.message.includes("boom: cannot open the input") && started(asrLog).length === 0, { code: e.code, msg: e.message });

      // a failed engine: its first error line, or its exit status; usage text is not in the message
      const usage = `echo "usage: whisper-cli [options] file0 file1 ..." >&2\necho "  -h, --help   show this help message and exit" >&2\n`;
      for (const [label, body, want] of [["an error: line", `echo "whisper_init: loading failed" >&2\necho "error: failed to load the model" >&2\n${usage}exit 3\n`, "failed to load the model"], ["no error: line", `${usage}exit 3\n`, "3"]] as const) {
        withPath(engine(join(E, "cli-fail"), "whisper-cli", body), stubFf);
        e = await err(() => AN.transcribe(src, "vi", model));
        check(`transcribe: a whisper.cpp failure with ${label} is asr_failed with a hint, and the message has no usage text`, e.code === "asr_failed" && e.message.includes(want) && !/usage|--help/.test(e.message) && !!e.hint, { code: e.code, msg: e.message });
      }
      // exit 0 and no output file: a language the engine does not know is bad_value (the value quoted); any other missing output is asr_failed, never internal
      withPath(engine(join(E, "cli-lang"), "whisper-cli", `${unknownLanguage}exit 0\n`), stubFf);
      e = await err(() => AN.transcribe(src, "xx", model));
      check("transcribe: whisper.cpp exits 0 with no output for an unknown language: bad_value naming the language", e.code === "bad_value" && e.message.includes("xx") && !/usage/.test(e.message), { code: e.code, msg: e.message });
      withPath(engine(join(E, "cli-none"), "whisper-cli", `echo "error: failed to read the audio" >&2\nexit 0\n`), stubFf);
      e = await err(() => AN.transcribe(src, "xx", model));
      check("transcribe: whisper.cpp exits 0 with no output and no language line: asr_failed with its error line, not internal", e.code === "asr_failed" && e.message.includes("failed to read the audio"), { code: e.code, msg: e.message });
      // python whisper: the model is a name (not checked), a failure gets the same treatment
      delete process.env.AGENTCUT_WHISPER_MODEL;
      withPath(engine(join(E, "py"), "whisper", `echo "Traceback (most recent call last):" >&2\necho "ValueError: Unsupported language: xx" >&2\nexit 1\n`), stubFf);
      e = await err(() => AN.transcribe(src, "xx", "base"));
      check("transcribe: python whisper failing on a language is asr_failed with its exit status, and its model name is not checked as a path", e.code === "asr_failed" && e.message.includes("1") && !/Traceback/.test(e.message), { code: e.code, msg: e.message });
      withPath(engine(join(E, "py-none"), "whisper", `exit 0\n`), stubFf);
      e = await err(() => AN.transcribe(src, "vi"));
      check("transcribe: python whisper exiting 0 with no output is asr_failed", e.code === "asr_failed", { code: e.code, msg: e.message });

      // the same state for the error and for capabilities: whisper-cli found, no model -> both say to set the model, and nothing was extracted
      rmSync(ffLog, { force: true }); rmSync(asrLog, { force: true });
      withPath(cli, stubFf);
      e = await err(() => AN.transcribe(src, "vi"));
      const cap = (api.capabilities() as any).engines.transcribe;
      check("whisper-cli without a model: transcribe is missing_dependency and its hint is capabilities' hint, which says to set the model", e.code === "missing_dependency" && cap.available === false && e.hint === cap.hint && cap.hint.includes("AGENTCUT_WHISPER_MODEL") && !cap.hint.includes("brew install"), { code: e.code, hint: e.hint, cap });
      check("  and no extraction or engine ran before the dependency check", started(ffLog).length === 0 && started(asrLog).length === 0, { ff: started(ffLog), asr: started(asrLog) });
      withPath(stubFf);
      e = await err(() => AN.transcribe(src, "vi"));
      const none = (api.capabilities() as any).engines.transcribe;
      check("no engine at all: transcribe is missing_dependency and its hint is capabilities' hint, which says to install one", e.code === "missing_dependency" && none.available === false && e.hint === none.hint && none.hint.includes("install") && started(ffLog).length === 0, { code: e.code, hint: e.hint, none });

      // add_captions reaches the same errors without passing api.transcribe
      process.env.AGENTCUT_WHISPER_MODEL = model;
      withPath(engine(join(E, "cli-lang"), "whisper-cli", `${unknownLanguage}exit 0\n`), stubFf);
      const Q = join(E, "proj");
      api.create(Q, { preset: "720p" });
      const was = JSON.stringify((await api.info(Q, "json")).timeline);
      const a: any = await api.apply(Q, [{ op: "add_captions", transcribe: src, language: "xx" }]).catch((x) => x);
      check("add_captions transcribe with an unknown language is bad_value naming it, and the timeline is unchanged", a.code === "bad_value" && a.message.includes("xx") && JSON.stringify((await api.info(Q, "json")).timeline) === was, { code: a.code, msg: a.message });
    } finally { process.env.PATH = pathWas; if (modelWas === undefined) delete process.env.AGENTCUT_WHISPER_MODEL; else process.env.AGENTCUT_WHISPER_MODEL = modelWas; }
  }

  // capabilities.engines: found by a PATH / env / file lookup, never by starting the binary (fakes record every start)
  {
    const eng = join(tmp, "eng"), started = join(tmp, "eng.started");
    mkdirSync(eng);
    const fake = (dir: string, n: string, extra = "") => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, n), `#!/bin/sh\necho "${n} $*" >> "${started}"\n${extra}`); chmodSync(join(dir, n), 0o755); };
    for (const n of ["whisper-cli", "piper", "uv"]) fake(eng, n);
    const sysBin = process.platform === "darwin" ? "say" : "espeak-ng", engSys = join(tmp, "eng-sys"), engPy = join(tmp, "eng-py"); // separate dirs: PATH decides which of these exist
    fake(engSys, sysBin);
    fake(engPy, "whisper", `while [ $# -gt 0 ]; do [ "$1" = "--output_dir" ] && printf '%s' '{"language":"vi","text":"Xin chào","segments":[{"words":[{"word":" Xin","start":0.1,"end":0.4},{"word":" chào","start":0.4,"end":0.8}]}]}' > "$2/a.json"; shift; done\n`);
    writeFileSync(join(eng, "ggml.bin"), ""); writeFileSync(join(eng, "v.onnx"), "");
    const keys = ["PATH", "AGENTCUT_WHISPER_MODEL", "AGENTCUT_PIPER_MODEL", "AGENTCUT_UV", "AGENTCUT_TTS_PROVIDER"], was = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const setEnv = (o: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
    const engines = () => ({ transcribe: {}, tts: { providers: [] }, vision: { features: [] }, ...(api.capabilities() as any).engines }) as any; // an absent key fails its checks, not the run
    try {
      setEnv({ PATH: eng, AGENTCUT_WHISPER_MODEL: join(eng, "ggml.bin"), AGENTCUT_PIPER_MODEL: join(eng, "v.onnx"), AGENTCUT_UV: join(eng, "uv"), AGENTCUT_TTS_PROVIDER: undefined });
      let e = engines();
      check("engines.transcribe: whisper-cli on PATH + an existing model is available", e.transcribe.available === true && e.transcribe.engine === "whisper-cli" && e.transcribe.model === join(eng, "ggml.bin") && /auto/.test(e.transcribe.languages) && !e.transcribe.hint, e.transcribe);
      check("engines.tts: piper with a model is available, and the default provider are named",
        e.tts.default_provider === "system" && e.tts.providers.find((p: any) => p.name === "piper")?.available === true, e.tts);
      const system = () => engines().tts.providers.find((p: any) => p.name === "system")?.available;
      check("engines.tts: the system provider is not available without its engine on PATH", system() === false);
      setEnv({ PATH: `${eng}:${engSys}` });
      check("engines.tts: the system provider is available with its engine on PATH", system() === true);
      setEnv({ PATH: eng });
      check("engines.vision: AGENTCUT_UV pointing at a uv is available, with its ops and the matte_models pointer",
        e.vision.available === true && ["analyze_subject", "auto_reframe", "track_to", "remove_background"].every((o) => e.vision.features.join().includes(o)) && e.vision.matte_models === "see matte_models" && /allow_download/.test(e.vision.models_note), e.vision);
      check("engines.vision: analyze_subject is labelled as running on call, the other three as computed by prepare",
        /runs uv when called/.test(e.vision.features.find((f: string) => f.startsWith("analyze_subject"))) && ["auto_reframe", "track_to", "remove_background"].every((o) => new RegExp(`^${o} .*prepare`).test(e.vision.features.find((f: string) => f.startsWith(o)))), e.vision.features);
      setEnv({ AGENTCUT_UV: undefined });
      check("engines.vision: without AGENTCUT_UV, uv on PATH is used", engines().vision.available === true);
      setEnv({ AGENTCUT_UV: join(eng, "missing-uv") });
      check("engines.vision: AGENTCUT_UV pointing at a missing file is not available", engines().vision.available === false);
      setEnv({ AGENTCUT_WHISPER_MODEL: undefined, AGENTCUT_PIPER_MODEL: join(eng, "missing.onnx") });
      e = engines();
      check("engines.transcribe: a CLI without a model is not available, with a hint", e.transcribe.available === false && e.transcribe.model === null && /^whisper-cli found: set AGENTCUT_WHISPER_MODEL=/.test(e.transcribe.hint), e.transcribe);
      setEnv({ PATH: `${eng}:${engPy}` });
      check("engines.transcribe: python whisper on PATH without a model is available, with no model",
        engines().transcribe.available === true && engines().transcribe.engine === "whisper" && engines().transcribe.model === null && !engines().transcribe.hint, engines().transcribe);
      setEnv({ PATH: eng });
      check("engines.tts: piper without its model file is not available, with a hint", e.tts.providers.find((p: any) => p.name === "piper")?.available === false && !!e.tts.providers.find((p: any) => p.name === "piper")?.hint, e.tts);
      setEnv({ AGENTCUT_WHISPER_MODEL: join(eng, "missing.bin") });
      check("engines.transcribe: a model path that does not exist is not available", engines().transcribe.available === false && engines().transcribe.model === null);
      check("capabilities started no engine binary (whisper-cli, piper, uv, the system engine, whisper)", !existsSync(started), existsSync(started) && readFileSync(started, "utf8"));
      // transcribe(), python branch: the one start of `whisper` is the transcription itself
      setEnv({ PATH: `${eng}:${engPy}:${was.PATH}`, AGENTCUT_WHISPER_MODEL: undefined });
      const py = await AN.transcribe(join(tmp, "reply.wav"), "vi"), runs = existsSync(started) ? readFileSync(started, "utf8").trim().split("\n") : [];
      check("transcribe (python whisper): started once, for the transcription itself (no probe call)", runs.length === 1 && runs[0].startsWith("whisper ") && runs[0].includes("--word_timestamps") && !runs[0].includes("--help")
        && py.text === "Xin chào" && py.words.map((w: any) => w.text).join() === "Xin,chào", { runs, py });
    } finally { setEnv(was); }
  }
} finally { srv.kill(); }

{
  const { ease } = await import("../src/anim.ts");
  check("an hsl range that only the prototype chain holds is refused", gradeIssues({ hsl: { toString: { hue: 10 } } }).some(([k]) => k === "hsl.toString"));
  check("an easing name that only the prototype chain holds eases linearly", ease("constructor", 0.3) === 0.3, ease("constructor", 0.3));
}
if (process.argv.includes("--keep")) console.log("kept", tmp); else rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall color/tts checks passed");
process.exit(failures ? 1 : 0);
