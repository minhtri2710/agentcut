// Colour grading (color field -> FFmpeg), scopes, and TTS provider selection / HTTP request building (local server, no network).
// Run: bun tests/color-tts.ts [--keep]          (needs ffmpeg + curl on PATH)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agentcut-colortts-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
for (const k of ["AGENTCUT_TTS_PROVIDER", "AGENTCUT_TTS_URL", "AGENTCUT_TTS_KEY", "AGENTCUT_TTS_MODEL", "AGENTCUT_TTS_VOICE", "AGENTCUT_PIPER_MODEL"]) delete process.env[k];
const api = await import("../src/api.ts");
const { gradeChain, LOOKS } = await import("../src/color.ts");
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
  const rev = api.info(R, "json").revision;
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
    check(`${what} is rejected by validate and the batch is not applied`, e.code === "validation_failed" && e.details?.issues?.some((i: any) => i.path.endsWith(`.filters[0].${key}`)) && api.info(R, "json").revision === rev, e.details ?? e);
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
check("piper without a model is a missing_dependency", throwsCode(() => AN.tts("x", join(tmp, "p.wav"), "piper"), "missing_dependency") === true);
{
  // the espeak branch is the non-darwin, non-win32 one: present it as linux; no engine is installed here, so a valid voice ends at missing_dependency
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    const bv = (v: string) => { try { AN.tts("x", join(tmp, "v.wav"), v); return null; } catch (e: any) { return e; } };
    const e = bv("-x");
    check("espeak voice that reads as an option is a bad_voice with a hint", e?.code === "bad_voice" && !!e.hint, e && { code: e.code, msg: e.message });
    check("espeak voice with a path separator is a bad_voice", bv("en/../x")?.code === "bad_voice");
    check("espeak voice names like en-us and en+f3 pass the voice check", ["en-us", "en+f3", "vi", "mb-en1"].every((v) => bv(v)?.code !== "bad_voice"));
  } finally { Object.defineProperty(process, "platform", platform); }
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
  const sapi = (voice?: string, rate?: number) => {
    const out = join(tmp, "sapi.wav");
    rmSync(out, { force: true });
    for (const f of ["argv", "voice", "out"]) rmSync(join(fakeDir, f), { force: true });
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.PATH = `${fakeDir}:${pathWas}`;
    try { AN.tts("hello", out, voice, rate); return { out, err: null as any }; }
    catch (err: any) { return { out, err }; }
    finally { Object.defineProperty(process, "platform", platform); process.env.PATH = pathWas; }
  };
  const seen = (f: string) => readFileSync(join(fakeDir, f), "utf8");
  const script = () => seen("argv").split("\0")[2] ?? "";
  try {
    const plain = sapi();
    check("sapi: a normal run produces the output file", plain.err === null && existsSync(plain.out), plain.err && plain.err.message);
    check("sapi: the output path reaches powershell as the variable, not in the script text",
      seen("out").endsWith("tts.wav") && seen("out").includes("agentcut-tts-") && !script().includes("agentcut-tts-") && !script().includes(seen("out")), { out: seen("out"), script: script() });
    check("sapi: no voice leaves the voice variable empty", seen("voice") === "");
    sapi(undefined, 225);
    check("sapi: rate stays an integer in the script", /\$s\.Rate=2;/.test(script()), script());
    const chars: [string, string][] = [["apostrophe", "'"], ["U+2018", "‘"], ["U+2019", "’"], ["U+201A", "‚"], ["U+201B", "‛"], ["dollar", "$"], ["backtick", "`"], ["semicolon", ";"], ["newline", "\n"]];
    const names: [string, string][] = [...chars.map(([n, c]): [string, string] => [n, `Zq${c}Marker${c}Zq`]), ["300 chars", `Marker${"x".repeat(294)}`]];
    for (const [label, voice] of names) {
      const r = sapi(voice);
      check(`sapi: a voice name with ${label} stays out of the script text and arrives byte for byte`,
        r.err === null && !script().includes("Marker") && seen("voice") === voice && Buffer.from(seen("voice")).equals(Buffer.from(voice)), r.err ? r.err.message : { script: script(), voice: seen("voice") });
    }
    check("sapi: a voice name with a NUL is a bad_voice", sapi("Zq\0Zq").err?.code === "bad_voice");
    writeFileSync(join(fakeDir, "unknown"), "");
    const bad = sapi("Alpha Voic");
    check("sapi: the unknown-voice exit is a bad_voice that names the installed voices", bad.err?.code === "bad_voice" && /Alpha Voice/.test(bad.err.hint) && /Beta Voice/.test(bad.err.hint) && /Alpha Voice/.test(bad.err.hint), bad.err && { code: bad.err.code, msg: bad.err.message, hint: bad.err.hint });
    check("sapi: the unknown-voice error carries the voice and a suggestion", /Alpha Voic/.test(bad.err?.message ?? "") && /did you mean 'Alpha Voice'/.test(bad.err?.hint ?? ""), bad.err && { msg: bad.err.message, hint: bad.err.hint });
  } finally { Object.defineProperty(process, "platform", platform); process.env.PATH = pathWas; }
}
check("openai without config is a missing_dependency", throwsCode(() => AN.tts("x", join(tmp, "o.wav"), "openai:nova"), "missing_dependency") === true);

console.log("tts over http (local server)");
// tts() is synchronous (curl), so the fake /v1/audio/speech server runs in its own process.
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
  const r = AN.tts("Xin chào", out, "openai:shimmer", 175);
  const req = JSON.parse(readFileSync(reqLog, "utf8").trim().split("\n").pop()!);
  check("POST /v1/audio/speech with bearer key + json", req.method === "POST" && req.url === "/v1/audio/speech" && req.auth === `Bearer ${KEY}` && req.type === "application/json", req);
  check("request body", JSON.stringify(req.body) === JSON.stringify({ model: "tts-test", input: "Xin chào", voice: "shimmer", response_format: "wav", speed: 1 }), req.body);
  check("reply converted to 48 kHz stereo", r.provider === "openai" && Math.abs(r.duration - 0.7) < 0.05 && /48000/.test(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", out], { encoding: "utf8" }).stdout), r);
  const lv = api.voices();
  check("voices lists openai as available with key status only", lv.providers.find((p: any) => p.name === "openai")?.available === true && lv.voices.some((v: any) => v.name === "openai:nova") && !JSON.stringify(lv).includes(KEY));
  await api.apply(P, [{ op: "add_voiceover", text: "hello", voice: "openai:alloy" }]);
  check("add_voiceover goes through the http provider", api.info(P, "json").timeline.tracks.find((t: any) => t.id === "voice").clips.length === 1);
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

  process.env.AGENTCUT_TTS_KEY = "sk-wrong-SECRET-456";
  let msg = "";
  try { AN.tts("x", join(tmp, "e.wav"), "openai:nova"); } catch (e: any) { msg = `${e.code} ${e.message} ${e.hint}`; }
  check("http error surfaces status, never the key", msg.startsWith("tts_failed") && msg.includes("401") && !msg.includes("SECRET"), msg);

  // piper: fake binary on PATH records argv/stdin and writes a wav
  const bin = join(tmp, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "piper"), `#!/bin/sh\n[ "$1" = "--version" ] && exit 0\necho "$@" > "${tmp}/piper.args"\ncat > "${tmp}/piper.stdin"\nwhile [ $# -gt 0 ]; do [ "$1" = "--output_file" ] && cp "${tmp}/reply.wav" "$2"; shift; done\n`);
  chmodSync(join(bin, "piper"), 0o755);
  writeFileSync(join(tmp, "vi.onnx"), ""); writeFileSync(join(tmp, "vi.onnx.json"), JSON.stringify({ language: { code: "vi_VN" } }));
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, AGENTCUT_PIPER_MODEL: join(tmp, "vi.onnx"), AGENTCUT_TTS_PROVIDER: "piper" });
  const pr = AN.tts("Chào bạn", join(tmp, "piper.wav"), undefined, 350);
  const args = readFileSync(join(tmp, "piper.args"), "utf8");
  check("piper via env default: model, length_scale, text on stdin", pr.provider === "piper" && args.includes(`--model ${join(tmp, "vi.onnx")}`) && args.includes("--length_scale 0.500") && readFileSync(join(tmp, "piper.stdin"), "utf8") === "Chào bạn", args);
  check("voices lists piper with its model language", api.voices("vi").voices.some((v: any) => v.provider === "piper" && v.lang === "vi_VN"));

  // transcribe contract (whisper.cpp): whole words (-sow), punctuation is never a word of its own - it joins the previous word
  // (a leading one joins the next) and stretches its end; `text` has no space before punctuation. Fake whisper-cli on PATH.
  const tok = (text: string, from: number, to: number) => ({ text, offsets: { from, to } });
  writeFileSync(join(tmp, "whisper.json"), JSON.stringify({ result: { language: "vi" }, transcription: [tok("“", 100, 200), tok(" Xin", 200, 500), tok(" chào", 500, 900), tok(" các", 900, 1100), tok(" bạn", 1100, 1400), tok(",", 1400, 1450),
    tok(" hôm", 1800, 2100), tok(" nay", 2100, 2400), tok("...", 2400, 2500), tok(" nhé", 3000, 3300), tok("!", 3300, 3350)] }));
  writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\n[ "$1" = "--help" ] && exit 0\nprintf '%s\\n' "$@" > "${tmp}/whisper.args"\nwhile [ $# -gt 0 ]; do [ "$1" = "-of" ] && cp "${tmp}/whisper.json" "$2.json"; shift; done\n`);
  chmodSync(join(bin, "whisper-cli"), 0o755);
  const tr = AN.transcribe(join(tmp, "reply.wav"), "vi", join(tmp, "fake.bin"));
  const wargs = readFileSync(join(tmp, "whisper.args"), "utf8").split("\n");
  check("transcribe asks whisper.cpp for whole words: -sow with -ml 1, the model and the language", wargs.includes("-sow") && wargs.includes("-ml") && wargs[wargs.indexOf("-m") + 1] === join(tmp, "fake.bin") && wargs[wargs.indexOf("-l") + 1] === "vi", wargs);
  check("transcribe: punctuation-only tokens join the previous word (a leading one the next)", JSON.stringify(tr.words.map((w: any) => w.text)) === JSON.stringify(["“Xin", "chào", "các", "bạn,", "hôm", "nay...", "nhé!"]), tr.words);
  check("transcribe: a word with punctuation ends where the punctuation ends, starts are untouched", JSON.stringify(tr.words.map((w: any) => [w.start, w.end])) === JSON.stringify([[0.2, 0.5], [0.5, 0.9], [0.9, 1.1], [1.1, 1.45], [1.8, 2.1], [2.1, 2.5], [3, 3.35]]), tr.words);
  check("transcribe: text has no space before punctuation", tr.text === "“Xin chào các bạn, hôm nay... nhé!" && tr.language === "vi", tr.text);
} finally { srv.kill(); }

if (process.argv.includes("--keep")) console.log("kept", tmp); else rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : "\nall color/tts checks passed");
process.exit(failures ? 1 : 0);
