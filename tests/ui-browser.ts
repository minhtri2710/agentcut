// Web UI in a real browser: headless Chrome driven over the DevTools Protocol (no npm deps). Loads the page, checks the
// timeline, edits a clip in the inspector, edits keyframes, opens / expands / regroups a compound, and checks that every
// edit landed in project.json. Skips (exit 0) when Chrome is not installed.
// Run: bun tests/ui-browser.ts [--keep]   (needs ffmpeg; CHROME=/path/to/chrome overrides the binary)
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const LINUX_CHROME = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
const CHROME = [process.env.CHROME, MAC_CHROME, ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).flatMap((d) => LINUX_CHROME.map((n) => join(d, n)))]
  .find((p) => p && existsSync(p));
if (!CHROME) { console.log(`skipped: Chrome not found (looked at $CHROME, ${MAC_CHROME}, and ${LINUX_CHROME.join(", ")} on PATH; set CHROME=/path/to/chrome)`); process.exit(0); }

let failures = 0;
const check = (name: string, cond: unknown, info?: unknown) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "agentcut-uib-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
const api = await import("../src/api.ts");
const { startUi } = await import("../src/ui.ts");
const dir = join(tmp, "proj"), media = join(tmp, "media");
mkdirSync(media);
const ff = (...a: string[]) => { const r = spawnSync("ffmpeg", ["-v", "error", "-y", ...a]); if (r.status) throw new Error(String(r.stderr)); };
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", join(media, "a.mp4"));
ff("-f", "lavfi", "-i", "mandelbrot=size=320x240", "-frames:v", "1", join(media, "p.jpg"));
api.create(dir, { preset: "square" });
await api.apply(dir, [
  { op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 2 },
  { op: "add_clip", track: "main", src: join(media, "p.jpg"), duration: 1.5 },
  { op: "add_clip", track: "main", src: join(media, "a.mp4"), in: 1, duration: 1.5 },
  { op: "add_clip", track: "text", text: "Hello", at: 0.2, duration: 1.5, preset: "title_bold" },
  { op: "set_keyframes", id: "img1", prop: "scale", keyframes: [[0, 1], [1.5, 1.3, "ease_out"]] },
  { op: "make_compound", ids: ["main#1", "main#2"], name: "tail" },
]);
const load = () => JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
const clipOf = (tl: any, id: string) => tl.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === id);
const cmpId = load().tracks.find((t: any) => t.id === "main").clips[1].id as string;

// ---------------------------------------------------------------- browser
const ui = await startUi(dir, { port: 0 });
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(tmp, "chrome")}`, "--no-first-run", "--use-mock-keychain", "--password-store=basic",
  "--no-default-browser-check", "--disable-gpu", "--window-size=1440,900", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const exited = new Promise<void>((ok) => chrome.once("close", () => ok()));
let ws: WebSocket | undefined, sessionId = "", seq = 0;
const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
const consoleErrors: string[] = [];
const cdp = (method: string, params: object = {}, session?: string) => new Promise<any>((ok, fail) => {
  const id = ++seq; pending.set(id, { ok, fail }); ws!.send(JSON.stringify({ id, method, params, sessionId: session }));
});
const page = (method: string, params: object = {}) => cdp(method, params, sessionId);
const js = async (expr: string) => {
  const r = await page("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const until = async (what: string, expr: string, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (await js(expr)) return true; } catch { /* page not ready */ } await sleep(80); }
  console.log(`    (timed out waiting for ${what})`);
  return false;
};
const untilFile = async (fn: (tl: any) => unknown, ms = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn(load())) return true; await sleep(80); }
  return false;
};
/** real mouse input at the centre of the element (or of a point inside it) */
const click = async (sel: string, o: { dx?: number; shift?: boolean; count?: number } = {}) => {
  const b = await js(`(function(){var r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  const x = b.x + (o.dx ?? 0), modifiers = o.shift ? 8 : 0;
  for (let n = 1; n <= (o.count ?? 1); n++) {
    await page("Input.dispatchMouseEvent", { type: "mousePressed", x, y: b.y, button: "left", clickCount: n, modifiers });
    await page("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: b.y, button: "left", clickCount: n, modifiers });
  }
};
const shot = async (name: string) => {
  const { data } = await page("Page.captureScreenshot", { format: "png" });
  const out = join(process.env.AGENTCUT_UI_SHOTS ?? tmp, `${name}.png`);
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`    screenshot: ${out}`);
};

try {
  const wsUrl = await new Promise<string>((ok, fail) => {
    let err = "";
    const to = setTimeout(() => fail(new Error(`Chrome did not start: ${err}`)), 20_000);
    chrome.once("error", (e) => { clearTimeout(to); fail(e); });
    chrome.stderr!.on("data", (c) => { err += c; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) { clearTimeout(to); ok(m[1]); } });
  });
  ws = new WebSocket(wsUrl);
  await new Promise((ok, fail) => { ws!.onopen = ok; ws!.onerror = fail; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id)!; pending.delete(msg.id); msg.error ? p.fail(new Error(JSON.stringify(msg.error))) : p.ok(msg.result); }
    else if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  };
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  sessionId = (await cdp("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  await page("Runtime.enable");
  await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log("page");
  await page("Page.navigate", { url: ui.url });
  check("timeline renders every top-level clip", await until("clips", `document.querySelectorAll("#lanes .clip").length === 3`),
    await js(`document.querySelectorAll("#lanes .clip").length`).catch(() => null));
  check("lanes follow the tracks (top track drawn first)", JSON.stringify(await js(`[].map.call(document.querySelectorAll(".lane"), function (l) { return l.dataset.track; })`)) ===
    JSON.stringify(load().tracks.map((t: any) => t.id).reverse()));
  check("viewer shows a rendered frame", await until("frame", `$("frame").src.indexOf("blob:") === 0 && $("frame").naturalWidth > 0`));

  console.log("inspector");
  await click(`[data-id="txt1"]`);
  check("click selects the clip", await until("selection", `$("selinfo").textContent.indexOf("txt1") === 0 && $("insp").value.indexOf('"Hello"') > 0`));
  await js(`(function(){var c=JSON.parse($("insp").value); c.text="Edited in Chrome"; c.color="#ffcc00"; $("insp").value=JSON.stringify(c,null,2); $("applyc").click();})()`);
  check("inspector edit lands in project.json", await untilFile((tl) => clipOf(tl, "txt1")?.text === "Edited in Chrome" && clipOf(tl, "txt1")?.color === "#ffcc00"), clipOf(load(), "txt1"));
  check("page picks up the new revision", await until("revision", `S.revision === ${load().revision} && document.querySelector('[data-id="txt1"]').textContent.indexOf("Edited") > 0`));

  console.log("keyframes");
  await js(`seek(1)`);
  await js(`(function(){var s=$("kfprop"); s.value="opacity"; s.dispatchEvent(new Event("change"));})()`);
  await click("#kfadd");
  check("+ key at playhead -> set_keyframes", await untilFile((tl) => JSON.stringify(clipOf(tl, "txt1")?.keyframes?.opacity) === "[[0.8,1]]"), clipOf(load(), "txt1").keyframes);
  await until("kf row", `document.querySelectorAll("#kfbox .kfrow").length === 1`);
  await js(`seek(0.2)`);
  await click("#kfadd");
  await untilFile((tl) => clipOf(tl, "txt1")?.keyframes?.opacity?.length === 2);
  await until("kf rows", `document.querySelectorAll("#kfbox .kfrow").length === 2`);
  await js(`(function(){var r=document.querySelectorAll("#kfbox .kfrow")[0].children; r[1].value="0"; r[1].dispatchEvent(new Event("change"));})()`);
  await untilFile((tl) => clipOf(tl, "txt1")?.keyframes?.opacity?.[0]?.[1] === 0);
  await until("rerender", `S.revision === ${load().revision} && document.querySelectorAll("#kfbox .kfrow")[0].children[1].value === "0"`);
  await js(`(function(){var s=document.querySelectorAll("#kfbox .kfrow")[1].children[2]; s.value="ease_out"; s.dispatchEvent(new Event("change"));})()`);
  check("edit value + pick easing", await untilFile((tl) => JSON.stringify(clipOf(tl, "txt1")?.keyframes?.opacity) === `[[0,0],[0.8,1,"ease_out"]]`), clipOf(load(), "txt1").keyframes);
  check("keyframe ticks on the timeline clip", await until("ticks", `S.revision === ${load().revision} && document.querySelectorAll('[data-id="txt1"] .kf').length === 2`));
  // drag the 0.8 s tick right by 0.4 s (pps 80 -> 32 px)
  const kb = await js(`(function(){var k=document.querySelectorAll('[data-id="txt1"] .kf')[1].getBoundingClientRect();return {x:k.left+k.width/2,y:k.top+k.height/2}})()`);
  await page("Input.dispatchMouseEvent", { type: "mousePressed", x: kb.x, y: kb.y, button: "left", clickCount: 1 });
  await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: kb.x + 16, y: kb.y, button: "left" });
  await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: kb.x + 32, y: kb.y, button: "left" });
  await page("Input.dispatchMouseEvent", { type: "mouseReleased", x: kb.x + 32, y: kb.y, button: "left", clickCount: 1 });
  check("drag a tick moves the keyframe", await untilFile((tl) => Math.abs(clipOf(tl, "txt1")?.keyframes?.opacity?.[1]?.[0] - 1.2) < 0.02), clipOf(load(), "txt1").keyframes);
  await until("rerender", `document.querySelectorAll("#kfbox .kfrow").length === 2 && S.revision === ${load().revision}`);
  await js(`document.querySelectorAll("#kfbox .kfrow")[0].children[3].click()`);
  check("delete a keyframe", await untilFile((tl) => clipOf(tl, "txt1")?.keyframes?.opacity?.length === 1), clipOf(load(), "txt1").keyframes);
  await shot("keyframes");

  console.log("compound");
  await click(`[data-id="${cmpId}"]`, { count: 2 });
  check("double-click opens the compound", await until("nested view", `document.querySelectorAll("#lanes .clip").length === 2 && $("crumbs").textContent.indexOf("${cmpId}") > 0`),
    await js(`$("crumbs").textContent`));
  check("nested clips drawn at their timeline time", await js(`Math.abs(parseFloat(document.querySelector('[data-id="img1"]').style.left) - 2 * pps) < 1`),
    await js(`document.querySelector('[data-id="img1"]').style.left`));
  check("nested keyframes show as ticks", await js(`document.querySelectorAll('[data-id="img1"] .kf').length === 2`));
  await click(`[data-id="img1"]`);
  check("nested clip is read-only (expand to edit)", await until("ro", `$("selinfo").textContent.indexOf("expand") > 0 && $("applyc").disabled && $("insp").readOnly && $("kfadd").disabled`));
  await shot("compound-open");
  await js(`document.querySelector("#crumbs a").click()`);
  check("breadcrumb back to the timeline", await until("top view", `document.querySelectorAll("#lanes .clip").length === 3 && !V.nested`));
  await click(`[data-id="${cmpId}"]`);
  await until("expand button", `$("expc").style.display === ""`);
  await js(`$("expc").click()`);
  check("Expand -> expand_compound", await untilFile((tl) => !clipOf(tl, cmpId) && clipOf(tl, "img1") && clipOf(tl, "vid2")));
  await until("regroup", `$("regroup").style.display === ""`);
  await click(`[data-id="img1"]`);
  await js(`(function(){var c=JSON.parse($("insp").value); c.duration=1.2; $("insp").value=JSON.stringify(c); $("applyc").click();})()`);
  check("edit the expanded clip", await untilFile((tl) => clipOf(tl, "img1")?.duration === 1.2));
  await until("regroup after edit", `$("regroup").style.display === "" && S.revision === ${load().revision}`);
  await js(`$("regroup").click()`);
  check("Regroup -> make_compound with the same id + name", await untilFile((tl) => {
    const c = clipOf(tl, cmpId);
    return c?.type === "compound" && c.name === "tail" && c.tracks.flatMap((t: any) => t.clips).some((x: any) => x.id === "img1" && x.duration === 1.2);
  }), clipOf(load(), cmpId));
  await until("regrouped", `S.revision === ${load().revision}`);
  await click(`[data-id="vid1"]`);
  await click(`[data-id="txt1"]`, { shift: true });
  await until("group", `$("group").style.display === "" && $("group").textContent.indexOf("2") > 0`) || console.log(await js(`[sel, picked.join(), $("group").textContent]`));
  await js(`$("group").click()`);
  check("shift-select + Group -> make_compound", await untilFile((tl) => tl.tracks.find((t: any) => t.id === "main").clips.length === 2 && !clipOf(tl, "vid1")));

  console.log("previews/ui");
  await js(`$("sheet").click()`);
  check("contact sheet lands in previews/ui/", await until("sheet", `document.querySelector("#out img") && document.querySelector("#out img").src.indexOf("/files/previews/ui/") > 0`, 30_000));
  check("sheet image loads", await until("sheet img", `document.querySelector("#out img").naturalWidth > 0`));

  console.log("not_prepared");
  const fake = join(tmp, "fake-uv.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const job = JSON.parse(process.argv.at(-1));
const vf = "scale=" + job.w + ":" + job.h + ",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,W/2),0,255)'";
const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", job.path, "-an", "-vf", vf, "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-f", "mov", job.out], { encoding: "utf8" });
if (r.status) { process.stderr.write(r.stderr); process.exit(1); }
process.stdout.write(JSON.stringify({ out: job.out, frames: 1 }));
`);
  chmodSync(fake, 0o755);
  process.env.AGENTCUT_UV = fake;
  await api.apply(dir, [{ op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 1, id: "rb1" }, { op: "remove_background", id: "rb1" }]);
  check("viewer shows not_prepared with its hint and a Prepare action", await until("not_prepared", `$("vstat").textContent.indexOf("not prepared") >= 0 && $("vstat").textContent.indexOf("render_status") > 0 && $("prepare").style.display === ""`),
    await js(`[$("vstat").textContent, $("prepare") && $("prepare").style.display]`));
  await click("#prepare");
  check("Prepare runs the job, the matte lands and the frame returns", await until("prepared", `$("prepare").style.display === "none" && $("vstat").textContent.indexOf("ms/frame") > 0`, 30_000),
    await js(`[$("vstat").textContent, $("msg").textContent]`));
  check("no page exceptions", consoleErrors.length === 0, consoleErrors);
  await shot("final");
} finally {
  ws?.close();
  chrome.kill();
  const gone = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!gone) { chrome.kill("SIGKILL"); await Promise.race([exited, sleep(5000)]); }
  ui.server.closeAllConnections?.();
  await new Promise((ok) => ui.server.close(ok));
  if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures ? `\n${failures} FAILED` : "\nall ui-browser checks passed");
process.exit(failures ? 1 : 0);
