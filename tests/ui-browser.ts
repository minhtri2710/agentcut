// Web UI in a real browser: headless Chrome driven over the DevTools Protocol (no npm deps). Loads the page, checks the
// timeline, edits a clip in the inspector, edits keyframes, opens / expands / regroups a compound, and checks that every
// edit landed in project.json. Fails (exit 1) when Chrome is not found: there is no skip, so a lane without Chrome is red.
// The page is a bundle with no globals: the rows read what a person sees (the DOM) and what is on disk, never the page's variables.
// Run: bun tests/ui-browser.ts [--keep]   (needs ffmpeg; CHROME=/path/to/chrome is the only binary tried when set)
// Chrome only ever starts through tests/chrome.ts, inside its sandbox-exec containment (no update helper, no network but loopback); on a host
// that cannot give that containment this suite fails rather than starting Chrome uncontained.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXEC_DENY, SANDBOX_EXEC, accountHome, bundledUpdaterHelpers, chromeHint, containOrExit, launchChrome, refusedAtOnce, resolveChrome } from "./chrome.ts";
import { applyLatest, check, failures, ff } from "./harness.ts";
import { resolve as resolved } from "../src/model.ts";

const CHROME = resolveChrome();
if (!CHROME || !existsSync(CHROME)) {
  console.error(`FAILED: ui-browser: Chrome not found (${chromeHint()})`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "agentcut-uib-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
mkdirSync(join(tmp, "cache", "models", "u2netp"), { recursive: true }); writeFileSync(join(tmp, "cache", "models", "u2netp", "u2netp.onnx"), ""); // the default matte model is cached
const api = await import("./author-api.ts");
// the page's own writes carry the revision it shows; the fixtures the rows set up from outside are not about concurrency: a write reads the project's revision (info) and applies at it
const { startUi } = await import("../src/ui.ts");
const dir = join(tmp, "proj"), media = join(tmp, "media");
mkdirSync(media);
ff("-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=3", "-pix_fmt", "yuv420p", join(media, "a.mp4"));
ff("-f", "lavfi", "-i", "mandelbrot=size=320x240", "-frames:v", "1", join(media, "p.jpg"));
api.create(dir, { preset: "square" });
await applyLatest(dir, [
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
const profile = containOrExit(tmp, "ui-browser");
console.log("containment profile");
{
  // Stand-ins are scripts, not copies of a system binary (one inside an app folder is killed by the code-signing check). Each path matches exactly one exec pattern.
  const root = join(tmp, "standin"), at = (p: string) => { const f = join(root, p); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, "#!/bin/sh\nexit 0\n"); chmodSync(f, 0o755); return f; };
  const updaters = ["GoogleUpdater.app/Contents/MacOS/GoogleUpdater", "Keystone/payload", "Helpers/ksadmin", "bin/launchctl"].map(at), plain = at("bin/probe");
  const free = (f: string) => spawnSync(f, { encoding: "utf8", timeout: 20_000 }), held = (f: string) => spawnSync(SANDBOX_EXEC, ["-f", profile, f], { encoding: "utf8", timeout: 20_000 });
  check("an executable that is not an update helper runs under the profile", held(plain).status === 0, held(plain));
  check("stand-ins for the update helper, the update service, its admin tool and launchctl run when no profile is applied (so the refusal below is the profile's)", updaters.every((f) => free(f).status === 0), updaters.map((f) => free(f).status));
  const refused = updaters.map(held);
  check("  and every one of them is refused under the profile", refused.every((r) => r.status !== 0 && /not permitted/i.test(r.stderr)), refused.map((r) => [r.status, r.stderr.slice(0, 120)]));
  const helpers = bundledUpdaterHelpers(CHROME);
  check("the update helper that ships inside this Chrome is found, and the profile's exec pattern matches its path",
    helpers.length > 0 && helpers.every((h) => EXEC_DENY.some((r) => new RegExp(r).test(h))), helpers.length ? helpers : "this Chrome has no bundled update helper: there is nothing for the pattern to be checked against, so the suite stays red instead of passing without that check");
  check("the browser's own executable is not matched by the exec pattern", !EXEC_DENY.some((r) => new RegExp(r).test(CHROME)), CHROME);
  // a child with HOME set at spawn (this suite itself may run under a fake HOME): the write denies still name the account's home
  const fakeHome = join(tmp, "not-the-home"), script = join(tmp, "profile-probe.ts"), real = accountHome();
  writeFileSync(script, `import { profileText } from ${JSON.stringify(resolve(import.meta.dir, "chrome.ts"))};\nprocess.stdout.write(profileText());\n`);
  const child = spawnSync(process.execPath, ["--no-install", script], { env: { ...process.env, HOME: fakeHome }, encoding: "utf8", timeout: 30_000 });
  check("the write denies name the account's home even when HOME is something else", child.status === 0 && fakeHome !== real && child.stdout.includes(`(subpath "${real}/Library/Google")`) && child.stdout.includes(`(subpath "${real}/Library/LaunchAgents")`) && !child.stdout.includes(fakeHome),
    { status: child.status, real, err: child.stderr.slice(0, 200) });
}
const chrome = launchChrome(CHROME, profile, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${join(tmp, "chrome")}`, "--no-first-run", "--use-mock-keychain", "--password-store=basic",
  "--no-default-browser-check", "--disable-gpu", "--window-size=1440,900", "about:blank"]);
const exited = new Promise<void>((ok) => chrome.once("close", () => ok()));
console.log(`chrome pid ${chrome.pid}`);
let ws: WebSocket | undefined, sessionId = "", seq = 0;
const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
const consoleErrors: string[] = [];
const netUrl = new Map<string, string>(), netError = new Map<string, string>(); // request id -> url, and url -> the network error the browser reported
const cdp = (method: string, params: object = {}, session?: string) => new Promise<any>((ok, fail) => {
  const id = ++seq, to = setTimeout(() => { pending.delete(id); fail(new Error(`${method}: no answer from Chrome in 60 s`)); }, 60_000); // a browser whose helpers died never answers
  pending.set(id, { ok: (v) => { clearTimeout(to); ok(v); }, fail: (e) => { clearTimeout(to); fail(e); } }); ws!.send(JSON.stringify({ id, method, params, sessionId: session }));
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
/** real mouse input at the centre of the element (or of a point inside it), scrolled into view first as a person would (focusable lane headers let Tab scroll the timeline) */
const click = async (sel: string, o: { dx?: number; shift?: boolean; count?: number } = {}) => {
  const b = await js(`(function(){var n=document.querySelector(${JSON.stringify(sel)}); n.scrollIntoView({block:"nearest"}); var r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  const x = b.x + (o.dx ?? 0), modifiers = o.shift ? 8 : 0;
  for (let n = 1; n <= (o.count ?? 1); n++) {
    await page("Input.dispatchMouseEvent", { type: "mousePressed", x, y: b.y, button: "left", clickCount: n, modifiers });
    await page("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: b.y, button: "left", clickCount: n, modifiers });
  }
};
/** one real key press (key events through the browser's input pipeline, so focus-visible and native activation behave as for a person) */
const press = async (key: string, code: string, vk: number, text?: string, modifiers = 0) => {
  await page("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}) });
  await page("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers });
};
const SPACE = () => press(" ", "Space", 32, " "), ENTER = () => press("Enter", "Enter", 13, "\r");
/** Tab until the focused element satisfies the page expression (a bounded number of presses) */
const tabTo = async (cond: string, max = 80) => {
  for (let i = 0; i < max; i++) { await press("Tab", "Tab", 9); if (await js(`(function(){var e=document.activeElement;return !!(${cond})})()`)) return true; }
  return false;
};
const viewport = (width: number) => page("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
// What the rows read of the page: its DOM. The header line "rev N · ..." is the revision it shows, the zoom slider the scale, the playhead's left edge the time,
// the breadcrumb "timeline" alone means no compound is opened. A clip is found by its data-id (ids are free text, so no CSS selector is built from one).
const shownRev = `+$("rev").textContent.split(" ")[1]`;
const atRev = (n: number) => `$("rev").textContent.indexOf("rev ${n} ") === 0`;
const node = (id: string) => `[].filter.call(document.querySelectorAll(".clip"), function (n) { return n.dataset.id === ${JSON.stringify(id)}; })[0]`;
const atTop = `$("crumbs").textContent === "timeline"`;
const zoomPps = `+$("zoom").getAttribute("aria-valuenow")`; // the pixels per second, except right after a Ctrl+wheel (the slider rounds to whole numbers)
// (the browser keeps style.left to about 1e-3 px, so this time is exact to about 1e-5 s: rows that compare it use a tolerance well under one frame)
const nowT = () => js(`(parseFloat($("ph").style.left) - parseFloat(getComputedStyle($("ruler")).marginLeft)) / ${zoomPps}`) as Promise<number>;
/** a real click on the ruler at this time: the page seeks there */
const seekTo = async (sec: number) => {
  const rb = await js(`(function(){var r=$("ruler").getBoundingClientRect();return {x:r.left,y:r.top+r.height/2,pps:${zoomPps}}})()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page("Input.dispatchMouseEvent", { type, x: rb.x + sec * rb.pps, y: rb.y, button: "left", clickCount: 1 });
};
/** a real click on the clip with this id (scrolled into view first: many lanes can push it out of the timeline's box) */
const clickClip = async (id: string) => {
  const b = await js(`(function(){var n=${node(id)}; n.scrollIntoView({block:"nearest"}); var r=n.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await page("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
  await page("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
};
/** open the list of a Selector (its combobox: a page expression) and pick the option with this text */
const pick = async (combo: string, label: string) => {
  await js(`(${combo}).click()`);
  const opt = `[].filter.call(document.querySelectorAll('[role="option"]'), function (o) { return o.getClientRects().length && o.textContent.trim() === ${JSON.stringify(label)}; })[0]`;
  if (!(await until(`option ${label}`, `!!${opt}`))) return false;
  await js(`${opt}.click()`);
  return true;
};
/** type a value into a text or number field (a page expression) and leave it: the field commits on blur */
const typeIn = (field: string, v: string) => js(`(function(){var i=${field}; i.focus(); __set(i, ${JSON.stringify(v)}); i.blur();})()`);
/** the zoom slider to this many px per second (a multiple of 10): Home is 10, each PageUp adds 10 */
const zoomTo = async (pps: number) => {
  await js(`$("zoom").focus()`);
  await press("Home", "Home", 36);
  for (let i = 10; i < pps; i += 10) await press("PageUp", "PageUp", 33);
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
    else if (msg.method === "Network.requestWillBeSent") netUrl.set(msg.params.requestId, msg.params.request.url);
    else if (msg.method === "Network.loadingFailed") netError.set(netUrl.get(msg.params.requestId) ?? "", msg.params.errorText);
  };
  const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
  sessionId = (await cdp("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  await page("Runtime.enable");
  await page("Page.enable");
  // Test-side hooks, installed before the page's own script runs, so the product carries none. The page keeps its state private; rows use a short `$`,
  // the page's EventSource (to stop it following the project, or to watch its job events), and a play() that is cut short the moment it starts.
  await page("Page.addScriptToEvaluateOnNewDocument", { source: `(function () {
    window.$ = function (id) { return document.getElementById(id); };
    // the design system's buttons stay focusable when disabled (aria-disabled); its inputs are React-controlled, so a value is typed through the native setter and an input event
    window.__off = function (id) { var n = document.getElementById(id); return !!n && (n.disabled === true || n.getAttribute("aria-disabled") === "true"); };
    window.__set = function (el, v) { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
    var ES = window.EventSource; window.__es = [];
    window.EventSource = function (u, o) { var e = new ES(u, o); window.__es.push(e); return e; };
    var play = HTMLMediaElement.prototype.play; window.__cutPlays = 0;
    HTMLMediaElement.prototype.play = function () { var p = play.apply(this, arguments); if (window.__pauseAfterPlay) { window.__cutPlays++; this.pause(); } return p; };
  })()` });
  await page("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  console.log("page");
  await page("Page.navigate", { url: ui.url });
  check("timeline renders every top-level clip", await until("clips", `document.querySelectorAll("#lanes .clip").length === 3`),
    await js(`document.querySelectorAll("#lanes .clip").length`).catch(() => null));
  const tks = load().tracks as any[];
  check("lanes follow the tracks as CapCut lays them out: picture tracks above, the top layer first, the audio tracks below", JSON.stringify(await js(`[].map.call(document.querySelectorAll(".lane"), function (l) { return l.dataset.track; })`)) ===
    JSON.stringify(tks.filter((t) => t.kind !== "audio").reverse().concat(tks.filter((t) => t.kind === "audio")).map((t) => t.id)));
  const stripTimes = await js(`(${node("vid1")}.style.backgroundImage.match(/\\?t=[0-9.]+/g) || []).join()`);
  check("a video clip shows a thumbnail strip: one frame per tile, at the source time each tile plays", stripTimes === "?t=0.50,?t=1.50,?t=2.00", stripTimes);
  check("viewer shows a rendered frame", await until("frame", `$("frame").src.indexOf("blob:") === 0 && $("frame").naturalWidth > 0`));
  const lang = (l: string) => js(`$("lang").querySelector('[data-value="${l}"]').click()`);
  const langNow = `$("lang").querySelector('[aria-checked="true"]').dataset.value`;
  await lang("vi");
  check("the language switch shows the page in Vietnamese", await until("vi", `$("play").textContent === "Phát" && $("selinfo").textContent === "Chọn một clip trên timeline." && document.documentElement.lang === "vi"`), await js(`[$("play").textContent, $("selinfo").textContent]`));
  await js(`location.reload()`);
  check("  the choice outlives a reload", await until("vi reloaded", `${atRev(load().revision)} && $("play").textContent === "Phát" && ${langNow} === "vi"`), await js(`[$("play").textContent, ${langNow}]`));
  await lang("en");
  check("  and switching back shows English again", await until("en", `$("play").textContent === "Play" && $("rev").textContent.indexOf("rev ") === 0`), await js(`$("play").textContent`));

  console.log("inspector");
  await click(`[data-id="txt1"]`);
  await until("inspector tabs", `!!$("itab-more")`);
  await click("#itab-more"); // every field, the JSON and the keyframe list: the tab the rows below use
  check("click selects the clip", await until("selection", `$("selinfo").textContent.indexOf("txt1") === 0 && $("insp").value.indexOf('"Hello"') > 0`));
  await js(`(function(){var c=JSON.parse($("insp").value); c.text="Edited in Chrome"; c.color="#ffcc00"; $("insp").value=JSON.stringify(c,null,2); $("applyc").click();})()`);
  check("inspector edit lands in project.json", await untilFile((tl) => clipOf(tl, "txt1")?.text === "Edited in Chrome" && clipOf(tl, "txt1")?.color === "#ffcc00"), clipOf(load(), "txt1"));
  check("page picks up the new revision", await until("revision", `${atRev(load().revision)} && document.querySelector('[data-id="txt1"]').textContent.indexOf("Edited") > 0`));
  await applyLatest(dir, [{ op: "update_clip", id: "vid1", set: { color: { exposure: 0.2, contrast: 0.1 } } }]);
  await click(`[data-id="vid1"]`);
  check("click selects the graded clip", await until("selection2", `$("selinfo").textContent.indexOf("vid1") === 0 && $("insp").value.indexOf('"contrast"') > 0`));
  await js(`(function(){var c=JSON.parse($("insp").value); delete c.color.contrast; $("insp").value=JSON.stringify(c,null,2); $("applyc").click();})()`);
  check("a key deleted inside a nested field is removed from project.json", await untilFile((tl) => { const g = clipOf(tl, "vid1")?.color; return g?.exposure === 0.2 && !("contrast" in g); }), clipOf(load(), "vid1")?.color);
  await click(`[data-id="txt1"]`);
  check("txt1 selected again", await until("reselect", `$("selinfo").textContent.indexOf("txt1") === 0 && $("kfadd") && !__off("kfadd") && ${atRev(load().revision)}`), await js(`$("selinfo").textContent`));

  console.log("viewer at the end of the timeline");
  await js(`$("vstat").textContent = ""`);
  await seekTo(parseFloat(await js(`$("dur").textContent`)) + 0.5); // a click past the end seeks to the end
  check("the playhead at the duration shows the last frame, not an out-of-timeline error", await until("end frame", `$("vstat").textContent.indexOf("ms/frame") > 0`), await js(`$("vstat").textContent`));

  console.log("keyframes");
  await seekTo(1);
  await pick(`$("kfprop")`, "opacity");
  await click("#kfadd");
  check("+ key at playhead -> set_keyframes", await untilFile((tl) => JSON.stringify(clipOf(tl, "txt1")?.keyframes?.opacity) === "[[0.8,1]]"), clipOf(load(), "txt1").keyframes);
  await until("kf row", `document.querySelectorAll("#kfbox .kfrow").length === 1`);
  await seekTo(0.2);
  await click("#kfadd");
  await untilFile((tl) => clipOf(tl, "txt1")?.keyframes?.opacity?.length === 2);
  await until("kf rows", `document.querySelectorAll("#kfbox .kfrow").length === 2`);
  await typeIn(`document.querySelectorAll("#kfbox .kfrow")[0].querySelector('[data-col="v"]')`, "0");
  await untilFile((tl) => clipOf(tl, "txt1")?.keyframes?.opacity?.[0]?.[1] === 0);
  await until("rerender", `${atRev(load().revision)} && document.querySelectorAll("#kfbox .kfrow")[0].querySelector('[data-col="v"]').value === "0"`);
  await pick(`document.querySelectorAll("#kfbox .kfrow")[1].querySelector('[data-col="ease"]')`, "ease_out");
  check("edit value + pick easing", await untilFile((tl) => JSON.stringify(clipOf(tl, "txt1")?.keyframes?.opacity) === `[[0,0],[0.8,1,"ease_out"]]`), clipOf(load(), "txt1").keyframes);
  {
    const before = JSON.stringify(clipOf(load(), "txt1").keyframes), f = `document.querySelectorAll("#kfbox .kfrow")[0].querySelector('[data-col="v"]')`;
    await js(`${f}.focus()`);
    const b = await js(`(function(){var r=${f}.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await page("Input.dispatchMouseEvent", { type: "mouseWheel", x: b.x, y: b.y, deltaX: 0, deltaY: 100 });
    await sleep(400);
    check("  the wheel over a focused keyframe value does not change it", JSON.stringify(clipOf(load(), "txt1").keyframes) === before, clipOf(load(), "txt1").keyframes);
    await js(`document.activeElement.blur()`);
  }
  check("keyframe ticks on the timeline clip", await until("ticks", `${atRev(load().revision)} && document.querySelectorAll('[data-id="txt1"] .kf').length === 2`));
  // drag the 0.8 s tick right by 0.4 s (pps 80 -> 32 px)
  const kb = await js(`(function(){var k=document.querySelectorAll('[data-id="txt1"] .kf')[1].getBoundingClientRect();return {x:k.left+k.width/2,y:k.top+k.height/2}})()`);
  await page("Input.dispatchMouseEvent", { type: "mousePressed", x: kb.x, y: kb.y, button: "left", clickCount: 1 });
  await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: kb.x + 16, y: kb.y, button: "left" });
  await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: kb.x + 32, y: kb.y, button: "left" });
  await page("Input.dispatchMouseEvent", { type: "mouseReleased", x: kb.x + 32, y: kb.y, button: "left", clickCount: 1 });
  check("drag a tick moves the keyframe", await untilFile((tl) => Math.abs(clipOf(tl, "txt1")?.keyframes?.opacity?.[1]?.[0] - 1.2) < 0.02), clipOf(load(), "txt1").keyframes);
  await until("rerender", `document.querySelectorAll("#kfbox .kfrow").length === 2 && ${atRev(load().revision)}`);
  await js(`document.querySelectorAll("#kfbox .kfrow")[0].querySelector('[data-col="del"]').click()`);
  check("delete a keyframe", await untilFile((tl) => clipOf(tl, "txt1")?.keyframes?.opacity?.length === 1), clipOf(load(), "txt1").keyframes);
  await shot("keyframes");

  console.log("timeline gestures");
  // two clips on a scratch track "g", removed with the track at the end of this section so the counts of the later rows are unchanged
  const tStart = await nowT();
  await applyLatest(dir, [
    { op: "add_clip", track: "g", type: "color", color: "red", id: "gm", at: 0.5, duration: 1 },
    { op: "add_clip", track: "g", type: "color", color: "green", id: "gt", at: 2, duration: 2 },
  ]);
  await until("gesture clips", `!!${node("gm")} && !!${node("gt")} && ${atRev(load().revision)}`);
  /** real mouse drag from the centre of the element, horizontally by dx px, in two moves */
  const dragBy = async (sel: string, dx: number) => {
    const b = await js(`(function(){var r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await page("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
    await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x + dx / 2, y: b.y, button: "left" });
    await page("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x + dx, y: b.y, button: "left" });
    await page("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x + dx, y: b.y, button: "left", clickCount: 1 });
  };
  const settled = () => until("redrawn", atRev(load().revision));
  // pps is 80 here: 40 px = 0.5 s
  await dragBy(`[data-id="gm"]`, 40);
  check("dragging a clip moves it by the dragged time and keeps its length", await untilFile((tl) => Math.abs(Number(clipOf(tl, "gm")?.start) - 1) < 0.02 && clipOf(tl, "gm")?.duration === 1), clipOf(load(), "gm"));
  await settled();
  await dragBy(`[data-id="gt"] .h.r`, 40);
  check("dragging a clip's right edge lengthens it and leaves its start", await untilFile((tl) => Math.abs(clipOf(tl, "gt")?.duration - 2.5) < 0.02 && Math.abs(Number(clipOf(tl, "gt")?.start) - 2) < 0.02), clipOf(load(), "gt"));
  await settled();
  await dragBy(`[data-id="gt"] .h.l`, 40);
  check("dragging a clip's left edge cuts its head: later start, shorter by the same time", await untilFile((tl) => Math.abs(Number(clipOf(tl, "gt")?.start) - 2.5) < 0.02 && Math.abs(clipOf(tl, "gt")?.duration - 2) < 0.02), clipOf(load(), "gt"));
  await settled();

  await click(`[data-id="gt"]`);
  await seekTo(3.5);
  await click("#tsplit");
  check("the toolbar's Split cuts the selected clip at the playhead", await untilFile((tl) => { const g = tl.tracks.find((t: any) => t.id === "g").clips; return g.length === 3 && g.some((c: any) => c.id === "gt" && Math.abs(c.duration - 1) < 0.02); }), load().tracks.find((t: any) => t.id === "g").clips);
  await settled();
  await click(`[data-id="gm"]`);
  await click("#itab-more"); // the Apply-ops box below is on the More tab once a clip is selected
  const revView = load().revision, leftOf = (id: string) => js(`parseFloat(${node(id)}.style.left)`) as Promise<number>;
  const gmStart = Number(clipOf(load(), "gm").start); // the clip's left edge is its start times the scale, so the scale after a wheel zoom is read from it
  await zoomTo(200);
  check("the zoom slider rescales the timeline: a clip is drawn at its start times the new scale", await leftOf("gm") === 200 * gmStart, await js(`${node("gm")}.style.left`));
  const sb = await js(`(function(){var r=$("scroll").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await page("Input.dispatchMouseEvent", { type: "mouseWheel", x: sb.x, y: sb.y, deltaX: 0, deltaY: -100, modifiers: 2 });
  check("Ctrl + wheel up zooms in, and the slider follows", await until("wheel zoom", `(function(){var p = parseFloat(${node("gm")}.style.left) / ${gmStart}; return p > 200 && Math.abs(${zoomPps} - p) < 1})()`), await js(`[${node("gm")}.style.left, $("zoom").value]`));
  await zoomTo(80);
  check("zooming changes the view only, not the project", await leftOf("gm") === 80 * gmStart && load().revision === revView, { rev: load().revision, revView });

  // seek: a click on the ruler puts the playhead at the clicked time; the playhead before is elsewhere
  await seekTo(0);
  await seekTo(2.5);
  // the playhead's edge is where the page puts the time; the "x.xx s" text is that time rounded
  check("clicking the ruler seeks the playhead to that time", Math.abs(await nowT() - 2.5) < 0.02 && Math.abs(parseFloat(await js(`$("time").textContent`)) - await nowT()) < 0.006, await js(`[$("time").textContent, $("ph").style.left]`));

  // the Apply-ops box: real clicks on the button, batches from the textarea
  const opsBox = async (text: string) => {
    await js(`(function(){$("msg").className = ""; $("msg").textContent = ""; $("ops").value = ${JSON.stringify(text)}; $("applyo").scrollIntoView({ block: "nearest" });})()`);
    await click("#applyo");
  };
  await opsBox(JSON.stringify([{ op: "add_marker", t: 2, label: "beat" }]));
  check("a marker added from the Apply-ops box lands in project.json", await untilFile((tl) => (tl.markers ?? []).length === 1 && tl.markers[0].t === 2 && tl.markers[0].label === "beat"), load().markers);
  check("  and the ruler shows it at its time", await until("marker shown", `${atRev(load().revision)} && document.querySelectorAll("#ruler .marker").length === 1 && parseFloat(document.querySelector("#ruler .marker").style.left) === 2 * ${zoomPps}`),
    await js(`[document.querySelectorAll("#ruler .marker").length, ${shownRev}]`));
  const revOk = load().revision;
  await opsBox(JSON.stringify([
    { op: "add_clip", track: "g", type: "color", color: "blue", id: "gv", at: 0, duration: 0.4 },
    { op: "update_clip", id: "gv", set: { opacity: 0.5 } },
  ]));
  check("a valid batch from the Apply-ops box lands whole", await untilFile((tl) => clipOf(tl, "gv")?.opacity === 0.5 && tl.revision > revOk), clipOf(load(), "gv"));
  await settled();
  const fileBefore = readFileSync(join(dir, "project.json"), "utf8"), revBefore = load().revision;
  await opsBox(JSON.stringify([
    { op: "add_clip", track: "g", type: "color", color: "green", id: "gx", at: 1, duration: 1 },
    { op: "remove_clip", id: "no-such-clip" },
  ]));
  check("an invalid batch shows an error and project.json is unchanged (the valid op before the bad one is not applied)", await until("batch error", `$("msg").className === "err"`)
    && readFileSync(join(dir, "project.json"), "utf8") === fileBefore && !clipOf(load(), "gx") && await js(shownRev) === revBefore, { msg: await js(`$("msg").textContent`), rev: load().revision, revBefore });
  await opsBox("[{");
  check("text that is not JSON shows an error and project.json is unchanged", await until("json error", `$("msg").className === "err"`) && readFileSync(join(dir, "project.json"), "utf8") === fileBefore, await js(`$("msg").textContent`));

  // conflict: the page stops following the project (its event stream is closed), another writer edits, then the page edits on its stale revision
  await js(`window.__es.forEach(function (e) { e.close(); })`);
  const revStale = load().revision;
  await applyLatest(dir, [{ op: "add_marker", t: 2.8, label: "outside" }]);
  await sleep(500); // the project file is polled every 150 ms: a live stream would have delivered the outside edit by now
  check("precondition: the page still shows the revision from before the outside edit", await js(shownRev) === revStale && load().revision === revStale + 1, { page: await js(shownRev), file: load().revision, revStale });
  await opsBox(JSON.stringify([{ op: "add_marker", t: 3.1, label: "from the page" }]));
  check("an edit from a stale page reports a conflict", await until("conflict", `$("msg").className === "err" && $("msg").textContent.indexOf("[conflict]") === 0`), await js(`$("msg").textContent`));
  check("  and project.json keeps the outside edit and has nothing from the page", load().revision === revStale + 1 && JSON.stringify((load().markers ?? []).map((m: any) => m.label)) === `["beat","outside"]`, { rev: load().revision, markers: load().markers });
  await js(`location.reload()`);
  check("a reloaded page shows the project as it is, outside edit included", await until("reloaded", `${atRev(load().revision)} && document.querySelectorAll("#ruler .marker").length === 2`), await js(`[$("rev").textContent, document.querySelectorAll("#ruler .marker").length]`));

  await applyLatest(dir, [{ op: "remove_track", id: "g" }, { op: "clear_markers" }]);
  await until("gesture clips gone", `!${node("gm")} && document.querySelectorAll("#ruler .marker").length === 0 && ${atRev(load().revision)}`);
  await seekTo(tStart);

  console.log("compound");
  await click(`[data-id="${cmpId}"]`, { count: 2 });
  check("double-click opens the compound", await until("nested view", `document.querySelectorAll("#lanes .clip").length === 2 && $("crumbs").textContent.indexOf("${cmpId}") > 0`),
    await js(`$("crumbs").textContent`));
  check("nested clips drawn at their timeline time", await js(`Math.abs(parseFloat(document.querySelector('[data-id="img1"]').style.left) - 2 * ${zoomPps}) < 1`),
    await js(`document.querySelector('[data-id="img1"]').style.left`));
  check("nested keyframes show as ticks", await js(`document.querySelectorAll('[data-id="img1"] .kf').length === 2`));
  await click(`[data-id="img1"]`);
  check("nested clip is read-only (expand to edit)", await until("ro", `$("selinfo").textContent.indexOf("expand") > 0 && __off("applyc") && $("insp").readOnly && __off("kfadd")`));
  await shot("compound-open");
  await js(`document.querySelector("#crumbs a").click()`);
  check("breadcrumb back to the timeline", await until("top view", `document.querySelectorAll("#lanes .clip").length === 3 && ${atTop}`));
  await click(`[data-id="${cmpId}"]`);
  await until("expand button", `$("expc").style.display === ""`);
  await js(`$("expc").click()`);
  check("Expand -> expand_compound", await untilFile((tl) => !clipOf(tl, cmpId) && clipOf(tl, "img1") && clipOf(tl, "vid2")));
  await until("regroup", `!!document.querySelector('#regroups button[data-group="${cmpId}"]')`);
  await click(`[data-id="img1"]`);
  await js(`(function(){var c=JSON.parse($("insp").value); c.duration=1.2; $("insp").value=JSON.stringify(c); $("applyc").click();})()`);
  check("edit the expanded clip", await untilFile((tl) => clipOf(tl, "img1")?.duration === 1.2));
  await until("regroup after edit", `!!document.querySelector('#regroups button') && ${atRev(load().revision)}`);
  await js(`document.querySelector('#regroups button[data-group="${cmpId}"]').click()`);
  check("Regroup -> make_compound with the same id + name", await untilFile((tl) => {
    const c = clipOf(tl, cmpId);
    return c?.type === "compound" && c.name === "tail" && c.tracks.flatMap((t: any) => t.clips).some((x: any) => x.id === "img1" && x.duration === 1.2);
  }), clipOf(load(), cmpId));
  await until("regrouped", atRev(load().revision));
  await click(`[data-id="vid1"]`);
  await click(`[data-id="txt1"]`, { shift: true });
  await until("group", `$("group").style.display === "" && $("group").textContent.indexOf("2") > 0`) || console.log(await js(`[$("selinfo").textContent, $("group").textContent]`));
  await js(`$("group").click()`);
  check("shift-select + Group -> make_compound", await untilFile((tl) => tl.tracks.find((t: any) => t.id === "main").clips.length === 2 && !clipOf(tl, "vid1")));

  console.log("regroup buttons come from the project");
  const btns = `[].map.call(document.querySelectorAll("#regroups button"), function (b) { return b.dataset.group; }).sort().join()`;
  check("no button once everything is regrouped", await until("none", `${btns} === ""`), await js(btns));
  await applyLatest(dir, [
    { op: "add_clip", track: "q", type: "color", color: "red", id: "qa", at: 0, duration: 1 },
    { op: "add_clip", track: "q", type: "color", color: "blue", id: "qb", at: 1, duration: 1 },
    { op: "add_clip", track: "q", type: "color", color: "green", id: "qc", at: 2, duration: 1 },
    { op: "make_compound", ids: ["qa", "qb"], id: "ga" },
    { op: "make_compound", ids: ["qc"], id: "gb", name: "solo" },
  ]);
  await until("compounds", `!!${node("ga")} && !!${node("gb")}`);
  await click(`[data-id="ga"]`);
  await until("expand ga", `$("expc").style.display === ""`);
  await js(`$("expc").click()`);
  await untilFile((tl) => !clipOf(tl, "ga") && clipOf(tl, "qa"));
  await until("one button", `${btns} === "ga" && ${atRev(load().revision)}`);
  // an expand made through the API (an agent, not the page) shows its button too
  await applyLatest(dir, [{ op: "expand_compound", id: "gb" }]);
  check("two expands (page + agent) give two Regroup buttons", await until("two buttons", `${btns} === "ga,gb"`), await js(btns));
  await js(`location.reload()`);
  check("the buttons survive a page reload", await until("reloaded", `$("rev").textContent !== "" && ${btns} === "ga,gb"`), await js(btns));
  await applyLatest(dir, [{ op: "split_clip", id: "qb", at: 1.5 }]);
  await until("split seen", `document.querySelectorAll('[data-id="qb"]').length === 1 && ${atRev(load().revision)}`);
  await js(`document.querySelector('#regroups button[data-group="ga"]').click()`);
  check("split, then Regroup takes both halves", await untilFile((tl) => {
    const c = clipOf(tl, "ga");
    return c?.type === "compound" && c.tracks.flatMap((t: any) => t.clips).length === 3 && !tl.tracks.flatMap((t: any) => t.clips).some((x: any) => x.group?.id === "ga");
  }), clipOf(load(), "ga"));
  check("the other group keeps its button", await until("gb only", `${btns} === "gb"`), await js(btns));
  await js(`document.querySelector('#regroups button[data-group="gb"]').click()`);
  check("Regroup keeps the compound's name", await untilFile((tl) => clipOf(tl, "gb")?.name === "solo"), clipOf(load(), "gb"));
  await until("regrouped all", `${btns} === "" && ${atRev(load().revision)}`);

  console.log("retimed compounds in the nested view");
  // expected placement = render's formula (render.ts subT): a nested time u plays at s + (u - in) / speed, level by level
  const place = (levels: { s: number; in: number; v: number }[], u: number) => levels.reduceRight((x, l) => l.s + (x - l.in) / l.v, u);
  const at = (levels: { s: number; in: number; v: number }[], u: number, du: number) => ({ left: place(levels, u), width: place(levels, u + du) - place(levels, u) });
  const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
  const boxOf = (id: string) => js(`(function(){var e=document.querySelector('[data-id="${id}"]');return {left:parseFloat(e.style.left)/${zoomPps},width:parseFloat(e.style.width)/${zoomPps},off:e.classList.contains("off")}})()`);
  const same = (b: any, w: { left: number; width: number }) => !!b && near(b.left, w.left) && near(b.width, w.width);
  await applyLatest(dir, [
    { op: "add_clip", track: "n", type: "color", color: "red", id: "ra", at: 1, duration: 1 },
    { op: "add_clip", track: "n", type: "color", color: "blue", id: "rb", at: 2, duration: 2 },
    { op: "add_clip", track: "n", type: "color", color: "green", id: "rc", at: 5, duration: 1 },
    { op: "set_keyframes", id: "rb", prop: "opacity", keyframes: [[0, 1], [1, 0.5]] },
    { op: "make_compound", ids: ["ra", "rb", "rc"], id: "cs2" },
    { op: "update_clip", id: "cs2", set: { start: 2, in: 1, speed: 2, duration: 1.5 } },
  ]);
  await until("speed-2 compound", `!!${node("cs2")}`);
  await click(`[data-id="cs2"]`, { count: 2 });
  await until("nested view", `!(${atTop}) && !!document.querySelector('[data-id="rb"]')`);
  const L1 = [{ s: 2, in: 1, v: 2 }];
  const [ba, bb, bc] = [await boxOf("ra"), await boxOf("rb"), await boxOf("rc")];
  check("speed-2 compound, in 1: nested clips sit where render plays them", same(ba, at(L1, 0, 1)) && same(bb, at(L1, 1, 2)) && same(bc, at(L1, 4, 1)), { ba, bb, bc, want: [at(L1, 0, 1), at(L1, 1, 2), at(L1, 4, 1)] });
  check("clips outside the visible window are dimmed, the one inside is not", ba.off && !bb.off && bc.off, { ba, bb, bc });
  await click(`[data-id="rb"] .kf[data-t="1"]`);
  const tk = await nowT();
  check("clicking a nested tick seeks to the timeline time render plays it at", near(tk, place(L1, 1 + 1)), { t: tk, want: place(L1, 2) });
  await js(`document.querySelector("#crumbs a").click()`);
  await until("top view", atTop);
  await applyLatest(dir, [
    { op: "add_clip", track: "m", type: "color", color: "red", id: "x1", at: 1, duration: 2 },
    { op: "add_clip", track: "m", type: "color", color: "blue", id: "x2", at: 3, duration: 2 },
    { op: "make_compound", ids: ["x1", "x2"], id: "ci" },
    { op: "update_clip", id: "ci", set: { start: 2, in: 1, speed: 2, duration: 1.5 } },
    { op: "make_compound", ids: ["ci"], id: "co" },
    { op: "update_clip", id: "co", set: { start: 1, in: 0.25, speed: 0.5, duration: 3 } },
  ]);
  await until("two-level compound", `!!${node("co")}`);
  await click(`[data-id="co"]`, { count: 2 });
  await until("outer open", `!(${atTop}) && !!document.querySelector('[data-id="ci"]')`);
  await click(`[data-id="ci"]`, { count: 2 });
  await until("inner open", `document.querySelectorAll("#crumbs a").length === 2 && !!document.querySelector('[data-id="x2"]')`);
  const L2 = [{ s: 1, in: 0.25, v: 0.5 }, { s: 0, in: 1, v: 2 }];
  const [bx1, bx2] = [await boxOf("x1"), await boxOf("x2")];
  check("two levels (speed 0.5 outside, speed 2 inside): nested clips sit where render plays them", same(bx1, at(L2, 0, 2)) && same(bx2, at(L2, 2, 2)), { bx1, bx2, want: [at(L2, 0, 2), at(L2, 2, 2)] });
  await js(`document.querySelector("#crumbs a").click()`);
  await until("top view again", atTop);
  // a stamp whose compound id is a clip nested inside another compound: the server's make_compound from would answer "exists", so no button
  await applyLatest(dir, [{ op: "add_clip", track: "q", type: "color", color: "red", id: "gz", at: 4, duration: 1, group: { id: "x1", track: "q" } }]);
  await until("stamped clip", `!!document.querySelector('[data-id="gz"]')`);
  check("no Regroup button for a group id that exists nested", await js(`${btns} === ""`), await js(btns));
  await applyLatest(dir, [{ op: "remove_clip", id: "gz" }]);
  // a nested clip with a 0.5 s transition in a speed-2 compound: render plays the nested 0.5 s in 0.25 s
  await applyLatest(dir, [
    { op: "add_clip", track: "w", type: "color", color: "red", id: "wa", at: 0, duration: 2 },
    { op: "add_clip", track: "w", type: "color", color: "blue", id: "wb", at: 1.5, duration: 2, transition: { type: "crossfade", duration: 0.5 } },
    { op: "make_compound", ids: ["wa", "wb"], id: "cw" },
    { op: "update_clip", id: "cw", set: { speed: 2, duration: 1.75 } },
  ]);
  await until("transition compound", `!!${node("cw")}`);
  await click(`[data-id="cw"]`, { count: 2 });
  await until("transition nested view", `!(${atTop}) && !!document.querySelector('[data-id="wb"] .tr')`);
  const trw = await js(`parseFloat(document.querySelector('[data-id="wb"] .tr').style.width) / ${zoomPps}`);
  check("nested transition overlay is as wide as render plays it (0.5 s / speed 2)", near(trw, 0.5 / 2), trw);
  await js(`document.querySelector("#crumbs a").click()`);
  await until("top view after transition", atTop);

  console.log("previews/ui");
  await js(`$("sheet").click()`);
  check("contact sheet lands in previews/ui/", await until("sheet", `document.querySelector("#out img") && document.querySelector("#out img").src.indexOf("/files/previews/ui/") > 0`, 30_000));
  check("sheet image loads", await until("sheet img", `document.querySelector("#out img").naturalWidth > 0`));

  console.log("keyboard");
  await js(`document.activeElement.blur()`);
  // a render is under way while the Render button is disabled; a play while the Play button no longer reads "Play"
  await js(`(function(){ var f = window.fetch; window.renderBodies = []; window.fetch = function (u, o) { if (String(u) === "/api/render") window.renderBodies.push(JSON.parse(o.body)); return f.apply(this, arguments); }; return true; })()`);
  check("Tab reaches Render, and Space on it starts a render, not play", await tabTo(`e.id === "render"`)
    && (await SPACE(), await until("render started", `__off("render") || !!document.querySelector("#out a")`)) && await js(`$("play").textContent === "Play" && $("video").style.display === "none"`),
    await js(`[document.activeElement.id, __off("render"), $("play").textContent]`));
  check("  it sends the Draft checkbox (ticked by default) as draft", await js(`window.renderBodies.length === 1 && window.renderBodies[0].draft === true && $("draft").checked`), await js(`window.renderBodies`));
  check("  that render finishes", await until("render done", `!!document.querySelector("#out a") && !__off("render")`, 120_000), await js(`[$("msg").textContent, __off("render")]`));
  await applyLatest(dir, [{ op: "add_marker", t: 0.5 }]);
  await until("marker seen", `${atRev(load().revision)} && !__off("undo")`);
  const rev0 = load().revision;
  await click("#undo");
  check("a mouse click on Undo undoes", await untilFile((tl) => tl.revision > rev0 && !(tl.markers ?? []).some((m: any) => m.t === 0.5)), load().markers);
  await until("undo seen", atRev(load().revision));
  await SPACE();
  check("after that click, Space plays", await until("play started", `$("play").textContent !== "Play" || $("video").style.display !== "none"`), await js(`[document.activeElement.id, $("play").textContent]`));
  check("  the play draft starts the video", await until("playing", `$("play").textContent === "Stop"`, 120_000), await js(`[$("play").textContent, $("msg").textContent]`));
  await SPACE();
  check("  and Space stops it", await until("stopped", `$("video").style.display === "none" && $("play").textContent === "Play"`), await js(`[$("video").style.display, $("play").textContent]`));
  // a stop right after the play started: play() is interrupted. The hook installed with the others pauses the video the moment play() is called (a real Play, a real draft).
  const errsPlay = consoleErrors.length;
  await js(`window.__pauseAfterPlay = true`);
  await click("#play");
  const cut = await until("an interrupted play", `$("play").textContent === "Stop" && window.__cutPlays > 0`, 120_000);
  await js(`window.__pauseAfterPlay = false`);
  await sleep(300);
  check("a play interrupted by an immediate stop raises no page exception", cut && consoleErrors.length === errsPlay, { cut, errors: consoleErrors.slice(errsPlay) });
  await click("#play");
  await until("stopped after the interrupted play", `$("video").style.display === "none" && $("play").textContent === "Play"`);
  // no clip selected, as after opening a compound and coming back: the tab stop is then the first clip in time order
  await click(`[data-id="cw"]`, { count: 2 });
  await until("nested view", `!(${atTop}) && !!document.querySelector('[data-id="wb"]')`);
  await js(`document.querySelector("#crumbs a").click()`);
  await until("top view", atTop);
  await js(`document.activeElement.blur()`);
  const byTime = `[].slice.call(document.querySelectorAll("#lanes .clip")).map(function (n, i) { return [parseFloat(n.style.left), i, n.dataset.id]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }).map(function (x) { return x[2]; })`;
  const order = await js(byTime) as string[];
  const typeOf = Object.fromEntries(load().tracks.flatMap((t: any) => t.clips).map((c: any) => [c.id, c.type]));
  const selected = (id: string) => `$("selinfo").textContent.indexOf(${JSON.stringify(id + " on ")}) === 0`; // the inspector's header names the selected clip
  check("exactly one clip is in the tab order, the others are -1, each is a button with a label naming its id and type", await js(`(function(){
    var n = [].slice.call(document.querySelectorAll("#lanes .clip")), type = ${JSON.stringify(typeOf)};
    return n.filter(function (x) { return x.tabIndex === 0; }).length === 1 && n.every(function (x) { return x.getAttribute("role") === "button" && x.getAttribute("aria-label").indexOf(x.dataset.id + ", " + type[x.dataset.id] + ", ") === 0; });
  })()`));
  check("Tab reaches the clips at the one tab stop", await tabTo(`e.classList.contains("clip")`) && await js(`document.activeElement.dataset.id`) === order[0], await js(`[document.activeElement.dataset.id, ${JSON.stringify(order)}]`));
  const t0 = await nowT();
  await press("ArrowRight", "ArrowRight", 39);
  check("Right moves the focus to the next clip in time order and does not move the playhead", await js(`document.activeElement.dataset.id`) === order[1] && await nowT() === t0 && await js(`document.activeElement.tabIndex`) === 0, await js(`[document.activeElement.dataset.id, $("time").textContent]`));
  await press("ArrowLeft", "ArrowLeft", 37);
  await press("ArrowRight", "ArrowRight", 39);
  await ENTER();
  check("Enter selects the focused clip and the inspector shows it", await until("keyboard selection", `${selected(order[1])} && JSON.parse($("insp").value).id === ${JSON.stringify(order[1])}`), await js(`$("selinfo").textContent`));
  await press("ArrowLeft", "ArrowLeft", 37);
  await SPACE();
  check("Space on a keyboard-focused clip selects it, as Enter does", await until("space selection", selected(order[0])), await js(`[$("selinfo").textContent, document.activeElement.dataset.id]`));
  await press("ArrowRight", "ArrowRight", 39);
  await js(`$("scroll").scrollLeft = 0`);
  await applyLatest(dir, [{ op: "add_marker", t: 0.7 }]);
  check("the focus stays on that clip, by id, after an apply redraws the timeline", await until("rebuilt", `${atRev(load().revision)} && document.activeElement.dataset.id === ${JSON.stringify(order[1])}`), await js(`[document.activeElement.className, document.activeElement.dataset && document.activeElement.dataset.id]`));
  await press("ArrowRight", "ArrowRight", 39);
  check("  and it is still keyboard focus: Right walks on to the next clip", await js(`document.activeElement.dataset.id`) === order[2], await js(`document.activeElement.dataset.id`));
  const tt = await nowT();
  await click(`[data-id="${order[0]}"]`);
  await press("ArrowRight", "ArrowRight", 39);
  check("after a mouse click on another top-level clip, Right steps the playhead instead of walking from the keyboard-focused clip", Math.abs(await nowT() - (tt + 1 / 30)) < 1e-3 && await js(selected(order[0])), await js(`[${tt}, $("time").textContent, $("selinfo").textContent, document.activeElement.className]`));
  // a nested clip takes focus from a mouse click (its mousedown does not cancel the default): the page's keys keep working there
  await click(`[data-id="cs2"]`, { count: 2 });
  await until("nested view", `!(${atTop}) && !!document.querySelector('[data-id="rb"]')`);
  await click(`[data-id="rb"]`);
  const tm = await nowT();
  await press("ArrowRight", "ArrowRight", 39);
  check("after a mouse click on a clip that took focus, Right steps the playhead instead of walking the clips", Math.abs(await nowT() - (tm + 1 / 30)) < 1e-3 && await js(`document.activeElement.dataset.id`) === "rb", await js(`[$("time").textContent, document.activeElement.dataset.id, ${tm}]`));
  await js(`document.querySelector("#crumbs a").click()`);
  await until("top view", atTop);
  await js(`document.activeElement.blur()`);
  await seekTo(1);
  await press("ArrowRight", "ArrowRight", 39);
  check("with no clip focused, Right still steps the playhead by a frame", Math.abs(await nowT() - (1 + 1 / 30)) < 1e-3, await js(`$("time").textContent`));
  const revZ = load().revision;
  check("Tab reaches Contact sheet", await tabTo(`e.id === "sheet"`), await js(`document.activeElement.id`));
  await press("z", "KeyZ", 90, undefined, 2);
  check("Ctrl+Z on a keyboard-focused button still undoes", await untilFile((tl) => tl.revision > revZ), { rev: load().revision, revZ });

  console.log("page width");
  await applyLatest(dir, [{ op: "add_clip", track: "wide", type: "color", color: "gray", id: "wide1", at: 0, duration: 120 }]);
  await until("wide timeline", `!!document.querySelector('[data-id="wide1"]') && ${atRev(load().revision)}`);
  await js(`(function(){var n = document.querySelector('[data-id="cw"]'); n.tabIndex = 0; n.focus(); $("scroll").scrollLeft = 600; window.scrolled = $("scroll").scrollLeft;})()`);
  await applyLatest(dir, [{ op: "add_marker", t: 0.9 }]);
  check("a rebuild with a clip focused leaves the timeline where it was scrolled", await until("rebuilt at scroll", `${atRev(load().revision)} && document.activeElement.dataset.id === "cw"`) && await js(`window.scrolled > 0 && $("scroll").scrollLeft === window.scrolled`), await js(`[window.scrolled, $("scroll").scrollLeft]`));
  const errs0 = consoleErrors.length, weird = 'q"a\\b';
  await applyLatest(dir, [{ op: "add_clip", track: "idt", type: "color", color: "red", id: weird, at: 0, duration: 1 }]);
  await until("odd id drawn", `!!${node(weird)}`);
  await js(`document.activeElement.blur()`);
  await clickClip(weird);
  await applyLatest(dir, [{ op: "add_marker", t: 0.95 }]);
  // every drawn clip has its own id (one node per id)
  check("a clip id with a quote and a backslash is drawn, is the tab stop when selected, and breaks no redraw", await until("odd id redrawn", `${atRev(load().revision)} && ${node(weird)}.tabIndex === 0`)
    && await js(`(function(){var ids = [].map.call(document.querySelectorAll(".clip"), function (n) { return n.dataset.id; }); return new Set(ids).size === ids.length;})()`) && consoleErrors.length === errs0, { errors: consoleErrors.slice(errs0) });
  for (const w of [1000, 1440]) {
    await viewport(w); await sleep(200);
    const f = await js(`(function(){var r=function(id){return $(id).getBoundingClientRect().right}; return {w: innerWidth, scrollW: document.documentElement.scrollWidth, render: r("render"), side: r("side"), inner: $("scroll").scrollWidth, shown: $("scroll").clientWidth}})()`);
    check(`${w} px: a timeline far wider than the window scrolls inside the timeline; the page, Render and the side panel stay inside the window`,
      f.w === w && f.inner > f.shown && f.scrollW <= f.w && f.render <= f.w && f.side <= f.w, f);
  }

  console.log("not_prepared");
  const fake = join(tmp, "fake-uv.mjs"), holdFile = join(tmp, "helper-hold");
  // the helper starts only once `holdFile` is gone (a row creates it to look at the page while the helper has not reported a frame)
  writeFileSync(fake, `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
while (existsSync(${JSON.stringify(holdFile)})) await new Promise((r) => setTimeout(r, 20));
const job = JSON.parse(process.argv.at(-1));
const vf = "scale=" + job.w + ":" + job.h + ",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lt(X,W/2),0,255)'";
const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", job.path, "-an", "-vf", vf, "-c:v", "prores_ks", "-profile:v", "4", "-pix_fmt", "yuva444p10le", "-f", "mov", job.out], { encoding: "utf8" });
if (r.status) { process.stderr.write(r.stderr); process.exit(1); }
process.stdout.write(JSON.stringify({ out: job.out, frames: 1 }));
`);
  chmodSync(fake, 0o755);
  process.env.AGENTCUT_UV = fake;
  await applyLatest(dir, [{ op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 1, id: "rb1" }, { op: "remove_background", id: "rb1" }]);
  check("viewer shows not_prepared with its hint and a Prepare action", await until("not_prepared", `$("vstat").textContent.indexOf("not prepared") >= 0 && $("vstat").textContent.indexOf("render_status") > 0 && $("prepare").style.display === ""`),
    await js(`[$("vstat").textContent, $("prepare") && $("prepare").style.display]`));
  await viewport(700); await js(`window.beforeReload = 1; location.reload()`);
  await until("not prepared after a reload", `window.beforeReload === undefined && $("vstat").textContent.indexOf("not prepared") >= 0 && $("prepare").style.display === ""`);
  const np = await js(`(function(){
    var shown = [].filter.call(document.querySelectorAll("#viewer img"), function (i) { return i.offsetWidth > 0; }), tm = $("time").getBoundingClientRect(), st = $("vstat").getBoundingClientRect(), v = $("viewer").getBoundingClientRect();
    return { imgs: shown.map(function (i) { return i.complete && i.naturalWidth > 0; }), timeH: tm.height, lineH: parseFloat(getComputedStyle($("time")).fontSize) * 1.35, statShown: st.height > 0 && st.left >= v.left && st.right <= v.right, text: $("vstat").textContent };
  })()`);
  check("a viewer with no frame (not prepared, page just loaded) shows no broken image, the state text inside the viewer, and the time on one line",
    np.imgs.every((ok: boolean) => ok) && np.statShown && np.text.includes("render_status") && np.timeH < np.lineH * 1.5, np);
  await viewport(1440);
  await click("#prepare");
  check("Prepare runs the job, the matte lands and the frame returns", await until("prepared", `$("prepare").style.display === "none" && $("vstat").textContent.indexOf("ms/frame") > 0`, 30_000),
    await js(`[$("vstat").textContent, $("msg").textContent]`));
  // a prepare with nothing left to compute settles before its POST response: hold the response until the SSE "job" event is in
  await js(`(function(){
    var f = window.fetch, got = false;
    window.__es[0].addEventListener("job", function (e) { var j = JSON.parse(e.data); if (j.kind === "prepare" && j.status !== "running") got = true; });
    window.fetch = function (u) {
      var r = f.apply(this, arguments);
      if (String(u) !== "/api/prepare") return r;
      return r.then(function (res) { return new Promise(function (ok) { var n = 0; (function w() { if (got || ++n > 100) { window.fetch = f; ok(res); } else setTimeout(w, 50); })(); }); });
    };
    $("prepare").style.display = "";
  })()`);
  await click("#prepare");
  check("Prepare with nothing to compute is not stuck when its job event beats the POST response",
    await until("prepare reset", `$("prepare").style.display === "none" && !__off("prepare") && $("prepare").textContent === "Prepare"`, 10_000),
    await js(`[$("prepare").style.display, __off("prepare"), $("prepare").textContent, $("msg").textContent]`));
  // a missing model is downloaded only after a click in the dialog: Escape and Cancel send nothing, Confirm sends one request with the flag
  console.log("download consent");
  await js(`(function(){
    var f = window.fetch; window.prepBodies = [];
    window.fetch = function (u, o) { if (String(u) === "/api/prepare") window.prepBodies.push(JSON.parse(o.body)); else window.otherUrls.push(String(u)); return f.apply(this, arguments); };
    window.otherUrls = [];
  })()`);
  await applyLatest(dir, [{ op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 1, id: "rb2" }, { op: "remove_background", id: "rb2", model: "u2net_human_seg" }]);
  const ask = async () => {
    // a click is by coordinates: when the page redraws after an edit (it notices a project change by polling, then refetches the frame) the button may not be
    // where it was read, and the click sends nothing. Such a click is repeated; one that sent a request and got no dialog still fails.
    const sent = (await js(`window.prepBodies.length`)) as number;
    for (let i = 0; i < 5; i++) {
      await js(`$("prepare").style.display = ""`);
      await click("#prepare");
      if (await until("a prepare request or the dialog", `$("consent").open || window.prepBodies.length > ${sent}`, 2000)) break;
    }
    return until("consent dialog", `$("consent").open`);
  };
  const bodies = () => js(`window.prepBodies`);
  check("Prepare with a missing model opens the dialog naming the model and its size, focus on the confirm button", await ask()
    && (await js(`$("clist").textContent`)).includes("u2net_human_seg (~176 MB)") && (await js(`document.activeElement.id`)) === "cgo", await js(`[$("consent") && $("consent").open, $("clist") && $("clist").textContent, document.activeElement.id]`));
  check("  the first request carried no flag", JSON.stringify(await bodies()) === "[{}]", await bodies());
  await page("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  check("Escape closes the dialog and shows the normal failure", await until("escaped", `!$("consent").open && $("msg").textContent.indexOf("[model_not_cached]") === 0 && !__off("prepare") && $("prepare").textContent === "Prepare"`),
    await js(`[$("consent").open, $("msg").textContent, $("prepare").textContent]`));
  check("Cancel closes the dialog too", await ask() && (await click("#cno"), await until("cancelled", `!$("consent").open && !__off("prepare")`)));
  await sleep(500);
  check("neither Escape nor Cancel sent a second request", JSON.stringify(await bodies()) === "[{},{}]", await bodies());
  check("a new dialog is not remembered: it opens again and the flag is still unset", await ask() && JSON.stringify(await bodies()) === "[{},{},{}]", await bodies());
  await js(`window.otherUrls = []; [{ key: "z", ctrlKey: true }, { key: "z", metaKey: true }, { key: " " }].forEach(function (k) { document.body.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ bubbles: true }, k))); })`);
  await sleep(300);
  check("while the dialog is open, the page's shortcuts (undo, play) do nothing", (await js(`window.otherUrls`)).length === 0 && await js(`$("consent").open`), await js(`window.otherUrls`));
  { // Confirm reaches the model download: stubbed (no network), a small body under a temporarily patched pin; its second chunk is held until the button shows the download
    const { MATTE_PINS } = await import("../src/model.ts"), { createHash } = await import("node:crypto");
    const pin = MATTE_PINS.u2net_human_seg, pinned = { ...pin }, body = Buffer.from("not a real model: a small body for the consent row");
    const realFetch = globalThis.fetch, asked: string[] = [];
    let release = () => {};
    const released = new Promise<void>((r) => { release = r; });
    Object.assign(pin, { sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length });
    globalThis.fetch = (async (u: any, init?: any) => {
      if (String(u) !== pinned.url) return realFetch(u, init);
      asked.push(String(u));
      return new Response(new ReadableStream({ async start(c) { c.enqueue(body.subarray(0, 20)); await released; c.enqueue(body.subarray(20)); c.close(); } }));
    }) as typeof fetch;
    writeFileSync(holdFile, "1"); // the helper waits, so the page is looked at between the end of the download and the helper's first frame
    try {
      await click("#cgo");
      check("while the model downloads, the Prepare button reads 'Downloading <model> <done>/<total> MB'", await until("download text", `/^Downloading u2net_human_seg [0-9.]+\\/[0-9.]+ MB$/.test($("prepare").textContent)`), await js(`$("prepare").textContent`));
      release();
      check("once the download has ended and the helper has not reported a frame, the button no longer reads Downloading", await until("download text gone", `$("prepare").textContent.indexOf("Downloading") !== 0 && __off("prepare")`), await js(`$("prepare").textContent`));
      rmSync(holdFile, { force: true });
      check("Confirm sends exactly one request with the flag, the model is fetched once from its pinned URL, and the prepare completes",
        await until("confirmed", `$("prepare").style.display === "none" && !$("consent").open`, 30_000) && JSON.stringify(await bodies()) === '[{},{},{},{"allow_download":true}]' && asked.join() === pinned.url, { bodies: await bodies(), asked });
    } finally { release(); rmSync(holdFile, { force: true }); globalThis.fetch = realFetch; Object.assign(pin, pinned); }
  }
  // a timeline with no duration has no frame: the viewer asks the server for none. A second page, on a project with no clips, counts the /api/frame requests it makes.
  // Once a clip exists the same page must ask, which shows the count works.
  console.log("viewer, empty project");
  {
    const emptyDir = join(tmp, "empty");
    api.create(emptyDir, { preset: "square" });
    const empty = await startUi(emptyDir, { port: 0 });
    const { targetId: other } = await cdp("Target.createTarget", { url: "about:blank" });
    const sid = (await cdp("Target.attachToTarget", { targetId: other, flatten: true })).sessionId;
    const on = async (expr: string) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid)).result?.value;
    const onUntil = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await on(expr).catch(() => false)) return true; await sleep(80); } return false; };
    try {
      await cdp("Runtime.enable", {}, sid);
      await cdp("Page.enable", {}, sid);
      await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(function () {
        window.frameRequests = []; var f = window.fetch;
        window.fetch = function (u) { if (String(u).indexOf("/api/frame") === 0) window.frameRequests.push(String(u)); return f.apply(this, arguments); };
      })()` }, sid);
      await cdp("Page.navigate", { url: empty.url }, sid);
      const loaded = await onUntil(`document.getElementById("rev").textContent.indexOf("rev ") === 0 && document.getElementById("dur").textContent === "0.00 s"`);
      await sleep(500); // the viewer waits 60 ms before it asks
      check("an empty timeline: the viewer sends no frame request", loaded && await on(`window.frameRequests.length`) === 0 && await on(`document.getElementById("vstat").textContent`) === "", { loaded, requests: await on(`window.frameRequests`) });
      await applyLatest(emptyDir, [{ op: "add_clip", track: "main", type: "color", color: "red", duration: 1 }]);
      check("  and once the project has a clip, the same page asks for a frame", await onUntil(`window.frameRequests.length > 0`), await on(`window.frameRequests`));
    } finally {
      await cdp("Target.closeTarget", { targetId: other }).catch(() => {});
      empty.server.closeAllConnections?.();
      await new Promise((ok) => empty.server.close(ok));
    }
  }
  // The media pool: the project's assets, an import by path, a file dropped from the desktop (uploaded into media/, then imported), an asset dragged onto a lane
  console.log("media pool");
  {
    const names = () => js(`[].map.call(document.querySelectorAll("#mlist .asset"), function (n) { return n.dataset.asset; }).sort().join()`);
    check("the Media tab lists every asset of the project", await until("assets", `${atRev(load().revision)} && document.querySelectorAll("#mlist .asset").length === ${Object.keys(load().assets).length}`)
      && await names() === Object.keys(load().assets).sort().join(), await names());
    const jpgId = Object.entries(load().assets).find(([, a]: any) => a.path.endsWith(".jpg"))![0];
    await js(`__set($("msearch"), ".JPG")`);
    check("  the search box keeps the assets whose id or file name has the text (any case)", await until("filtered", `document.querySelectorAll("#mlist .asset").length >= 1`) && (await names()).split(",").every((id: string) => (load().assets[id].path as string).toLowerCase().includes(".jpg")) && (await names()).includes(jpgId), await names());
    await js(`__set($("msearch"), "")`);
    const png = join(media, "imported.png");
    ff("-f", "lavfi", "-i", "color=c=orange:size=64x64", "-frames:v", "1", png);
    await js(`(function(){__set(document.querySelector("#mimport input"), ${JSON.stringify(png)}); document.querySelector("#mimport button").click();})()`);
    check("Import with a path -> import_media of that file", await untilFile((tl) => Object.values(tl.assets).some((a: any) => a.path.endsWith("imported.png"))), Object.values(load().assets).map((a: any) => a.path));
    await until("import seen", atRev(load().revision));
    const before = Object.keys(load().assets).length;
    await js(`(async function(){
      var b = await fetch("/media/" + encodeURIComponent(${JSON.stringify(jpgId)})).then(function (r) { return r.blob(); }), dt = new DataTransfer();
      dt.items.add(new File([b], "dropped.jpg", { type: "image/jpeg" }));
      var m = $("media"); m.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true })); m.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    })()`);
    check("a file dropped on the Media tab is copied into the project's media/ and imported", await untilFile((tl) => Object.keys(tl.assets).length === before + 1 && Object.values(tl.assets).some((a: any) => /media[\\/]dropped\.jpg$/.test(a.path)))
      && existsSync(join(dir, "media", "dropped.jpg")), { paths: Object.values(load().assets).map((a: any) => a.path), msg: await js(`$("msg").textContent`) });
    await until("dropped listed", `${atRev(load().revision)} && document.querySelectorAll("#mlist .asset").length === ${before + 1}`);
    await js(`(function(){
      var item = [].filter.call(document.querySelectorAll("#mlist .asset"), function (n) { return n.dataset.asset === ${JSON.stringify(jpgId)}; })[0], dt = new DataTransfer();
      item.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      var lane = [].filter.call(document.querySelectorAll(".lane"), function (l) { return l.dataset.track === "overlay"; })[0], r = lane.querySelector(".lclips").getBoundingClientRect(), x = r.left + 1.5 * ${zoomPps};
      lane.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, clientX: x, clientY: r.top + 5, bubbles: true, cancelable: true }));
      lane.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: r.top + 5, bubbles: true, cancelable: true }));
    })()`);
    const onOverlay = (tl: any) => tl.tracks.find((t: any) => t.id === "overlay").clips.find((c: any) => c.asset === jpgId);
    check("an asset dragged onto a lane is added to that track at the drop time", await untilFile((tl) => !!onOverlay(tl) && Math.abs(Number(onOverlay(tl).start) - 1.5) < 0.02), load().tracks.find((t: any) => t.id === "overlay").clips);
  }
  console.log("track headers and waveforms");
  {
    const tone = join(media, "tone.wav");
    ff("-f", "lavfi", "-i", "sine=frequency=440:duration=2", tone);
    await applyLatest(dir, [{ op: "add_clip", track: "music", src: tone, duration: 2, id: "tone1" }]);
    check("an audio clip shows its waveform: one bar per 2 px of the clip", await until("wave", `(function(){var n=${node("tone1")}, p=n && n.querySelector(".wave path"); return !!p && (p.getAttribute("d").match(/M/g) || []).length === Math.floor(parseFloat(n.style.width) / 2);})()`),
      await js(`(function(){var n=${node("tone1")}; return n && [n.style.width, n.querySelector(".wave path") && n.querySelector(".wave path").getAttribute("d").slice(0, 80)];})()`));
    const toggle = (track: string, f: string) => js(`[].filter.call(document.querySelectorAll(".lane"), function (l) { return l.dataset.track === ${JSON.stringify(track)}; })[0].querySelector('[data-toggle="${f}"]').click()`);
    const trackOf = (tl: any, id: string) => tl.tracks.find((t: any) => t.id === id);
    await until("tone seen", atRev(load().revision));
    await toggle("overlay", "hidden");
    check("the eye toggle in a track header hides the track (update_track)", await untilFile((tl) => trackOf(tl, "overlay").hidden === true), trackOf(load(), "overlay"));
    await until("hidden seen", `${atRev(load().revision)} && [].some.call(document.querySelectorAll('[data-toggle="hidden"][aria-pressed="true"]'), function (b) { return b.closest(".lane").dataset.track === "overlay"; })`);
    await toggle("overlay", "hidden");
    check("  and shows it again", await untilFile((tl) => trackOf(tl, "overlay").hidden === false), trackOf(load(), "overlay"));
    await until("shown seen", atRev(load().revision));
    await toggle("music", "muted");
    check("the mute toggle mutes the track; an audio track has no eye toggle", await untilFile((tl) => trackOf(tl, "music").muted === true)
      && await js(`![].filter.call(document.querySelectorAll(".lane"), function (l) { return l.dataset.track === "music"; })[0].querySelector('[data-toggle="hidden"]')`), trackOf(load(), "music"));
    await until("muted seen", atRev(load().revision));
    await toggle("overlay", "locked");
    check("the lock toggle locks the track and the lane shows it", await untilFile((tl) => trackOf(tl, "overlay").locked === true)
      && await until("locked lane", `[].some.call(document.querySelectorAll(".lane.locked"), function (l) { return l.dataset.track === "overlay"; })`), trackOf(load(), "overlay"));
    await until("lock seen", atRev(load().revision));
    const ovId = trackOf(load(), "overlay").clips[0].id, beforeLock = readFileSync(join(dir, "project.json"), "utf8");
    await clickClip(ovId);
    await js(`$("msg").className = ""; $("delc").click()`);
    check("  deleting a clip of the locked track is refused by name and changes nothing", await until("locked msg", `$("msg").className === "err" && $("msg").textContent.indexOf("locked") >= 0`)
      && readFileSync(join(dir, "project.json"), "utf8") === beforeLock, await js(`$("msg").textContent`));
    await toggle("overlay", "locked");
    check("  and the toggle unlocks it", await untilFile((tl) => trackOf(tl, "overlay").locked === false), trackOf(load(), "overlay"));
    await until("unlock seen", atRev(load().revision));
  }
  console.log("export dialog");
  {
    await lang("vi"); // the range fields read a dot decimal in every language (vi-VN reads "0.500" as 500 with its own number format)
    await until("vi", `$("play").textContent === "Phát"`);
    await click("#exportb");
    check("Export… opens the dialog", await until("export open", `$("export").open`));
    await pick(`$("eformat")`, "webm");
    await pick(`$("equality")`, "draft");
    await js(`$("eto").focus(); $("eto").select()`);
    await page("Input.insertText", { text: "1e" }); // Chrome takes this text in a number field but cannot read it (a second dot it refuses as typed)
    await click("#ego");
    await sleep(300);
    check("  an end the field cannot read blocks Export", await js(`$("export").open && $("eto").validity.badInput && !$("out").textContent`), await js(`[$("export").open, $("out").textContent]`));
    await typeIn(`$("eto")`, "5");
    await typeIn(`$("eto")`, "");
    check("  a cleared end field is empty again (the export runs to the end)", await js(`$("eto").value === ""`), await js(`$("eto").value`));
    await typeIn(`$("eto")`, "0.500");
    await click("#ego");
    check("the dialog's export writes the chosen format, an end of 0.500 read as half a second in Vietnamese too, and the result shows its QA",
      await until("exported", `!$("export").open && !!document.querySelector('#out a[href$=".webm"]') && !!$("qa")`, 120_000)
      && await js(`$("qa").className === "qaok"`) && Math.abs(parseFloat(await js(`$("out").querySelector(".mut").textContent`)) - 0.5) < 0.05,
      await js(`[$("msg").textContent, $("out").textContent.slice(0, 300)]`));
    await lang("en");
  }
  console.log("review and history panels");
  {
    await applyLatest(dir, [{ op: "add_clip", track: "text", text: "Blink", at: 0.3, duration: 0.2, id: "blink" }]);
    await until("blink seen", atRev(load().revision));
    await click("#tab-review");
    await click("#runreview");
    const short = `[].filter.call(document.querySelectorAll("#findings li"), function (l) { return l.dataset.type === "text_too_short" && l.textContent.indexOf("blink") >= 0; })[0]`;
    check("Run review lists the findings, a text too short to read among them", await until("findings", `!!${short}`, 60_000), await js(`$("review").textContent.slice(0, 300)`));
    await js(`${short}.click()`);
    check("  clicking a finding selects its clip and seeks to its time", await until("finding selected", `$("selinfo").textContent.indexOf("blink on ") === 0`) && Math.abs(await nowT() - 0.3) < 0.02, await js(`[$("selinfo").textContent, $("time").textContent]`));
    await applyLatest(dir, [{ op: "add_marker", t: 0.41, label: "p1" }]);
    await applyLatest(dir, [{ op: "add_marker", t: 0.42, label: "p2" }]);
    await until("markers seen", atRev(load().revision));
    await click("#tab-history");
    check("the History tab lists the edits newest first, with their authors", await until("history", `document.querySelectorAll("#hundo li").length >= 2 && document.querySelector("#hundo li button").textContent === "add_marker"`)
      && await js(`document.querySelector("#hundo li .mut").textContent`) === "by test", await js(`$("history").textContent.slice(0, 200)`));
    const revH = load().revision;
    await js(`document.querySelectorAll("#hundo li button")[1].click()`);
    check("  clicking the second newest undoes it and the newest in one step", await untilFile((tl) => tl.revision === revH + 2 && !(tl.markers ?? []).some((m: any) => m.label === "p1" || m.label === "p2")), load().markers);
    await until("redo listed", `${atRev(load().revision)} && document.querySelectorAll("#hredo li").length === 2`);
    await js(`document.querySelectorAll("#hredo li button")[1].click()`);
    check("  and the redo list brings both back", await untilFile((tl) => ["p1", "p2"].every((l) => (tl.markers ?? []).some((m: any) => m.label === l))), load().markers);
    await click("#tab-media");
  }
  // The dashboard (`agentcut ui` on a folder of projects): cards for the projects; a click opens that project's editor in the same tab
  console.log("dashboard");
  {
    const { startDashboard } = await import("../src/ui.ts");
    const home = join(tmp, "projects");
    api.create(join(home, "one"), { preset: "square" });
    api.create(join(home, "two"), { preset: "reels" });
    const db = await startDashboard(home, { port: 0 });
    const { targetId: other } = await cdp("Target.createTarget", { url: "about:blank" });
    const sid = (await cdp("Target.attachToTarget", { targetId: other, flatten: true })).sessionId;
    const on = async (expr: string) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid)).result?.value;
    const onUntil = async (expr: string, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await on(expr).catch(() => false)) return true; await sleep(80); } return false; };
    try {
      await cdp("Runtime.enable", {}, sid);
      await cdp("Page.navigate", { url: db.url }, sid);
      check("the dashboard page shows a card per project", await onUntil(`[].map.call(document.querySelectorAll(".pcard"), function (c) { return c.dataset.project; }).sort().join() === "one,two"`), await on(`document.body.textContent.slice(0, 200)`));
      await on(`[].filter.call(document.querySelectorAll(".pcard"), function (c) { return c.dataset.project === "two"; })[0].querySelector(".popen").click()`);
      check("  clicking a card goes to that project's editor", await onUntil(`location.port !== "${db.port}" && !!document.getElementById("rev") && document.getElementById("rev").textContent.indexOf("rev 0") === 0 && document.getElementById("name").textContent === "two"`, 15_000),
        await on(`[location.href, document.getElementById("rev") && document.getElementById("rev").textContent, document.getElementById("name") && document.getElementById("name").textContent]`));
    } finally {
      await cdp("Target.closeTarget", { targetId: other }).catch(() => {});
      db.server.closeAllConnections?.();
      await new Promise((ok) => db.server.close(ok));
    }
  }
  // The chat panel (a stand-in claude): a message shows as sent, then the agent's text and its tool calls as they stream in
  console.log("chat panel");
  if (process.platform !== "win32") {
    const bin = join(tmp, "chat-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho '{"type":"system","subtype":"init","session_id":"s1"}'\necho '{"type":"assistant","message":{"content":[{"type":"text","text":"Looking."},{"type":"tool_use","name":"mcp__agentcut__project_info","input":{}}]}}'\n`
      + `sleep 0.3\necho '{"type":"user","message":{"content":[{"type":"tool_result","content":"rev 1"}]}}'\necho '{"type":"assistant","message":{"content":[{"type":"text","text":"It is at rev 1."}]}}'\necho '{"type":"result","subtype":"success","session_id":"s1","result":"ok"}'\n`, { mode: 0o755 });
    const PATH = process.env.PATH;
    process.env.PATH = `${bin}:${PATH}`;
    try {
      await click("#tab-chat");
      await until("chat panel", `!!document.querySelector("#cform2 textarea")`);
      await js(`(function(){var f=$("cform2"); __set(f.elements.msg, "what revision?"); f.requestSubmit();})()`);
      const log = `[].map.call($("clog").children, function (n) { return n.className + ":" + n.textContent; }).join("|")`;
      check("a chat message shows as sent, then the agent's text, tool call and result, and the end; Send is back", await until("chat done", `${log}.indexOf("Done.") >= 0 && !__off("csend")`, 10_000)
        && /^cuser:what revision\?\|cbot:Looking\.\|ctool:→ project_info \{\}\|ctool:← rev 1\|cbot:It is at rev 1\.\|mut:Done\.$/.test(await js(log)), await js(`${log} + " / " + $("msg").textContent`));
    } finally { process.env.PATH = PATH; }
    await click("#tab-media");
  }
  console.log("form inspector");
  {
    await until("the page shows the project as it is", atRev(load().revision)); // the history rows' last redo: an edit sent before it arrives is a conflict
    const setF = (id: string, v: string) => typeIn(`$(${JSON.stringify(id)})`, v);
    await clickClip("blink");
    // CapCut's Basic tab: a labelled number per property and a keyframe diamond beside each animatable one
    await until("basic tab", `$("selinfo").textContent.indexOf("blink on ") === 0 && !!document.querySelector('#sidebody [data-prop="opacity"] .pnum')`);
    await typeIn(`document.querySelector('#sidebody [data-prop="opacity"] .pnum')`, "40");
    check("the Basic tab's Opacity number (in %) sets the clip's opacity", await untilFile((tl) => clipOf(tl, "blink")?.opacity === 0.4), clipOf(load(), "blink"));
    await until("opacity seen", atRev(load().revision));
    await seekTo(0.4);
    await js(`document.querySelector('#sidebody [data-prop="scale"] .kfd').click()`);
    check("  and the Scale diamond adds a scale keyframe at the playhead (clip time 0.1 s, the clip's own scale 1)", await untilFile((tl) => JSON.stringify(clipOf(tl, "blink")?.keyframes?.scale) === "[[0.1,1]]"), clipOf(load(), "blink")?.keyframes);
    await until("key seen", `${atRev(load().revision)} && document.querySelector('#sidebody [data-prop="scale"] .kfd').classList.contains("at")`);
    await js(`document.querySelector('#sidebody [data-prop="scale"] .kfd').click()`);
    check("  the same diamond on that key removes it", await untilFile((tl) => !clipOf(tl, "blink")?.keyframes?.scale), clipOf(load(), "blink")?.keyframes);
    await until("key gone", atRev(load().revision));
    await click("#itab-more");
    check("the More tab shows the clip's fields in the form", await until("form", `$("selinfo").textContent.indexOf("blink on ") === 0 && !!$("f-text") && $("f-text").value === "Blink"`), await js(`!!$("cform")`));
    await setF("f-text", "Blinked");
    check("a text field edit is update_clip of that field", await untilFile((tl) => clipOf(tl, "blink")?.text === "Blinked"), { clip: clipOf(load(), "blink"), msg: await js(`$("msg").textContent`) });
    await until("text seen", `${atRev(load().revision)} && $("f-text").value === "Blinked"`);
    const before = readFileSync(join(dir, "project.json"), "utf8");
    await js(`$("msg").className = ""`);
    await setF("f-opacity", "2");
    check("an out-of-range value shows the validation message and changes nothing", await until("range error", `$("msg").className === "err" && $("msg").textContent.indexOf("opacity") >= 0`)
      && readFileSync(join(dir, "project.json"), "utf8") === before, await js(`$("msg").textContent`));
    await js(`$("f-uppercase").click()`);
    check("a checkbox sets the boolean field", await untilFile((tl) => clipOf(tl, "blink")?.uppercase === true), clipOf(load(), "blink"));
    await until("upper seen", atRev(load().revision));
    check("enabled shows ticked when the field is absent", await js(`$("f-enabled").checked === true`));
    await js(`$("f-enabled").click()`);
    check("  unticking enabled disables the clip (enabled false)", await untilFile((tl) => clipOf(tl, "blink")?.enabled === false), clipOf(load(), "blink"));
    await until("disabled seen", `${atRev(load().revision)} && $("f-enabled").checked === false`);
    await js(`$("f-enabled").click()`);
    check("  ticking it again enables it (the field is dropped)", await untilFile((tl) => clipOf(tl, "blink") && clipOf(tl, "blink").enabled === undefined), clipOf(load(), "blink"));
    await until("enabled seen", atRev(load().revision));
    await clickClip("rb1");
    await until("rb1", `$("selinfo").textContent.indexOf("rb1 on ") === 0 && !!$("itab-more")`);
    await click("#itab-more");
    check("another clip's form shows its own values, not what was typed into the last one", await until("video form", `$("selinfo").textContent.indexOf("rb1 on ") === 0 && !!$("f-exposure") && $("f-opacity").value === ""`), await js(`$("f-opacity") && $("f-opacity").value`));
    await setF("f-exposure", "0.5");
    check("a grade field is merged into the clip's colour grade", await untilFile((tl) => clipOf(tl, "rb1")?.color?.exposure === 0.5), clipOf(load(), "rb1"));
    await until("grade seen", atRev(load().revision));
    await pick(`$("f-look")`, "portra");
    check("  and the look list sets the look beside it", await untilFile((tl) => clipOf(tl, "rb1")?.color?.look === "portra" && clipOf(tl, "rb1")?.color?.exposure === 0.5), clipOf(load(), "rb1")?.color);
  }
  // The library: every look, effect, transition and text style with a rendered still; a click puts it on the selected clip, a drag on the clip under the pointer, a text style on a free lane is a new title
  console.log("library");
  {
    const item = (k: string) => `document.querySelector('[data-lib="${k}"]')`;
    const libDrop = (k: string, target: string, sec: number) => js(`(function(){
      var dt = new DataTransfer(); ${item(k)}.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
      var t = ${target}, lane = t.closest(".lane"), r = lane.querySelector(".lclips").getBoundingClientRect(), x = r.left + ${sec} * ${zoomPps};
      t.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, clientX: x, clientY: r.top + 5, bubbles: true, cancelable: true }));
      t.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: r.top + 5, bubbles: true, cancelable: true }));
    })()`);
    await until("the page shows the project as it is", atRev(load().revision));
    await click("#tab-lib-look");
    check("the Filters tab shows each look with its still", await until("still", `!!${item("look/warm")} && ${item("look/warm")}.querySelector("img").complete && ${item("look/warm")}.querySelector("img").naturalWidth === 320`, 30_000)
      && await js(`document.querySelectorAll("#library .litem").length`) === 16, await js(`$("library") && $("library").textContent.slice(0, 120)`));
    await js(`${item("look/bw")}.click()`); // rb1 is still selected from the form rows
    check("clicking a look puts it on the selected clip's grade, keeping the rest of the grade", await untilFile((tl) => clipOf(tl, "rb1")?.color?.look === "bw" && clipOf(tl, "rb1")?.color?.exposure === 0.5), clipOf(load(), "rb1")?.color);
    await until("bw seen", atRev(load().revision));
    await click("#tab-lib-effect");
    await until("effects", `!!${item("effect/vhs")}`);
    await libDrop("effect/vhs", node("blink"), 0.4);
    check("an effect dragged onto a clip is added to that clip", await untilFile((tl) => (clipOf(tl, "blink")?.effects ?? []).some((e: any) => e.type === "vhs")), clipOf(load(), "blink"));
    await until("vhs seen", atRev(load().revision));
    const titles = (tl: any) => tl.tracks.find((t: any) => t.id === "text").clips.filter((c: any) => c.glow);
    await click("#tab-lib-text");
    await until("text styles", `!!${item("text/neon")}`);
    await libDrop("text/neon", `[].filter.call(document.querySelectorAll(".lane"), function (l) { return l.dataset.track === "text"; })[0]`, 2);
    check("a text style dragged onto a free lane adds a title in that style at the drop time", await untilFile((tl) => titles(tl).length === 1 && Math.abs(Number(titles(tl)[0].start) - 2) < 0.02), load().tracks.find((t: any) => t.id === "text").clips);
    await until("title seen", atRev(load().revision));
    const before = readFileSync(join(dir, "project.json"), "utf8");
    await clickClip("blink");
    await until("blink selected", `$("selinfo").textContent.indexOf("blink on ") === 0`);
    await click("#tab-lib-look");
    await until("looks", `!!${item("look/warm")}`);
    await js(`$("msg").className = ""; ${item("look/warm")}.click()`);
    check("  a look on a text clip is refused by name and changes nothing", await until("refused", `$("msg").className === "err" && $("msg").textContent.indexOf("warm") >= 0`)
      && readFileSync(join(dir, "project.json"), "utf8") === before, await js(`$("msg").textContent`));
    await click("#tab-media");
  }
  // Templates: each template's args as a form; Build is one apply_template (one undo step); a missing required arg is refused by name and the dialog stays open
  console.log("templates");
  {
    mkdirSync(join(dir, "media"), { recursive: true });
    ff("-f", "lavfi", "-i", "aevalsrc=if(lt(mod(t\\,0.5)\\,0.03)\\,sin(2*PI*1000*t)\\,0):s=22050:d=6", join(dir, "media", "tplbeat.wav"));
    await applyLatest(dir, [{ op: "import_media", path: join(dir, "media", "tplbeat.wav") }]);
    await until("beat seen", atRev(load().revision));
    const beatId = Object.keys(load().assets).find((k) => String(load().assets[k].path).endsWith("tplbeat.wav"))!;
    const mainOf = (tl: any) => tl.tracks.find((t: any) => t.id === "main").clips as any[];
    const ends = (tl: any) => mainOf(tl).reduce((e: number, c: any) => Math.max(e, c.start + c.duration), 0);
    await click("#tab-templates");
    await js(`document.querySelector('[data-template="quote"]').click()`);
    check("a template opens a dialog with its args", await until("quote dialog", `$("tpl").open && !!$("tpl").querySelector('[name="text"]') && !!$("tpl").querySelector('[data-arg="background"] [role="combobox"]')`));
    const revQ = load().revision;
    await click("#tgo");
    check("  Build without a required arg is refused by name inside the dialog, changes nothing and keeps it open", await until("refused", `!!$("terr") && $("tpl").contains($("terr")) && $("terr").textContent.indexOf("text") >= 0 && $("tpl").open`)
      && load().revision === revQ, await js(`$("terr") && $("terr").textContent`));
    await js(`__set($("tpl").querySelector('[name="text"]'), "Stay hungry")`);
    const endQ = ends(resolved(load())); // before Build: the end of main the section follows
    await click("#tgo");
    const quoted = (tl: any) => tl.tracks.flatMap((t: any) => t.clips).filter((c: any) => c.text === "\u201cStay hungry\u201d");
    check("  with it filled in, Build adds the template's clips in one step and closes the dialog", await untilFile((tl) => tl.revision === revQ + 1 && quoted(tl).length === 1)
      && await until("closed", `!$("tpl").open`), quoted(load()));
    check("  on a timeline with clips the quote is a section after main's end: its text starts 0.4 s into it", Math.abs(quoted(load())[0].start - (endQ + 0.4)) < 1e-6, { start: quoted(load())[0].start, endQ });
    await until("quote seen", atRev(load().revision));
    await click("#undo");
    check("  and one undo takes the whole template out", await untilFile((tl) => tl.revision === revQ + 2 && quoted(tl).length === 0), load().revision);
    await until("undo seen", atRev(load().revision));
    const pic = Object.keys(load().assets).find((k) => ["video", "image"].includes(load().assets[k].kind))!, nAssets = Object.keys(load().assets).length, revS = load().revision;
    const music = (tl: any) => tl.tracks.find((t: any) => t.id === "music")?.clips.filter((c: any) => c.asset === beatId) ?? [];
    const before = resolved(load()), lens = mainOf(before).map((c: any) => c.duration), endS = ends(before);
    await js(`document.querySelector('[data-template="slideshow"]').click()`);
    await until("slideshow dialog", `$("tpl").open && !!$("tpl").querySelector('input[data-asset="${pic}"]')`);
    await js(`$("tpl").querySelector('input[data-asset="${pic}"]').click()`);
    await pick(`$("tpl").querySelector('[data-arg="music"] [role="combobox"]')`, "tplbeat.wav");
    await typeIn(`$("tpl").querySelector('[data-arg="seconds"] input')`, "4");
    await typeIn(`$("tpl").querySelector('[data-arg="seconds"] input')`, ""); // cleared: the template's own 2.5 s
    await click("#tgo");
    check("  slideshow from a picked pool asset and pool music (by asset id): the music bed, no asset imported twice",
      await untilFile((tl) => tl.revision === revS + 1 && music(tl).length === 1) && Object.keys(load().assets).length === nAssets, { music: music(load()), assets: Object.keys(load().assets).length, nAssets });
    const after = resolved(load()), added = mainOf(after).slice(lens.length);
    check("  it is a section after main's end: the clips already there keep their lengths, the music and the new clip start where main ended, a cleared seconds field is the default 2.5 s",
      lens.every((d: number, i: number) => mainOf(after)[i].duration === d) && added.length === 1 && added[0].duration === 2.5 && Math.abs(added[0].start - endS) < 1e-6 && Math.abs(music(after)[0].start - endS) < 1e-6,
      { lens, now: mainOf(after).map((c: any) => c.duration), added, endS, music: music(after) });
    await until("slideshow seen", atRev(load().revision));
    await click("#tab-media");
  }
  // The transcript: a clip's words from the engine (a stand-in here); a click seeks, shift-click picks a run, Cut removes their stretch with one remove_range, undo puts it back
  console.log("transcript");
  if (process.platform !== "win32") {
    const bin = join(tmp, "asr-bin"), model = join(tmp, "asr.bin"), talk = join(media, "talk.mp4");
    mkdirSync(bin, { recursive: true }); writeFileSync(model, "");
    writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-of" ] && printf '%s' '{"transcription":[{"text":" one","offsets":{"from":200,"to":600}},{"text":" two","offsets":{"from":1000,"to":1400}},{"text":" three","offsets":{"from":2000,"to":2400}}]}' > "$2.json"; shift; done\n`, { mode: 0o755 });
    const env = { PATH: process.env.PATH, model: process.env.AGENTCUT_WHISPER_MODEL };
    process.env.PATH = `${bin}:${env.PATH}`; process.env.AGENTCUT_WHISPER_MODEL = model;
    try {
      ff("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=300:duration=3", "-shortest", "-pix_fmt", "yuv420p", talk);
      await applyLatest(dir, [{ op: "add_clip", track: "overlay", src: talk, id: "talk", at: 20, duration: 3 }]);
      await until("talk seen", atRev(load().revision));
      const talkAsset = clipOf(load(), "talk").asset;
      await clickClip("talk");
      await click("#tab-transcript");
      await click("#txgo");
      const words = `[].map.call(document.querySelectorAll("#words .word"), function (w) { return w.textContent; }).join()`;
      check("Transcribe shows the selected clip's words", await until("words", `${words} === "one,two,three"`, 30_000), await js(`$("transcript").textContent`));
      await js(`document.querySelectorAll("#words .word")[1].click()`);
      await until("seek", `$("time").textContent.indexOf("21.0") >= 0`);
      check("  clicking a word seeks to it on the timeline", Math.abs(await nowT() - 21) < 0.02, await nowT());
      await js(`document.querySelectorAll("#words .word")[2].dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }))`);
      const revCut = load().revision;
      await click("#txcut");
      const parts = (tl: any) => tl.tracks.find((t: any) => t.id === "overlay").clips.filter((c: any) => c.asset === talkAsset);
      check("  shift-click picks the run and Cut removes exactly its stretch: the clip plays 0..1 s and 2.4..3 s of its media, back to back", await untilFile((tl) => tl.revision === revCut + 1)
        && JSON.stringify(parts(load()).map((c: any) => [c.in ?? 0, c.duration, c.start])) === JSON.stringify([[0, 1, 20], [2.4, 0.6, 21]]), parts(load()));
      await until("cut seen", atRev(load().revision));
      await click("#undo");
      check("  and undo restores the whole clip", await untilFile((tl) => tl.revision === revCut + 2 && parts(tl).length === 1 && parts(tl)[0].duration === 3), parts(load()));
      await until("undo seen", atRev(load().revision));
      // the source is replaced in place (another recording, other words): a cut with the words loaded before is refused and the words are refreshed
      writeFileSync(join(bin, "whisper-cli"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-of" ] && printf '%s' '{"transcription":[{"text":" four","offsets":{"from":300,"to":700}},{"text":" five","offsets":{"from":1500,"to":1900}}]}' > "$2.json"; shift; done\n`, { mode: 0o755 });
      ff("-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=3", "-f", "lavfi", "-i", "sine=frequency=500:duration=3", "-shortest", "-pix_fmt", "yuv420p", talk);
      const revStale = load().revision;
      await js(`document.querySelectorAll("#words .word")[0].click()`);
      await click("#txcut");
      check("  after the source was replaced, Cut changes nothing: it says so and shows the new words", await until("stale", `${words} === "four,five" && $("msg").className === "err"`, 30_000)
        && load().revision === revStale, [await js(words), await js(`$("msg").textContent`), load().revision, revStale]);
    } finally { process.env.PATH = env.PATH; if (env.model === undefined) delete process.env.AGENTCUT_WHISPER_MODEL; else process.env.AGENTCUT_WHISPER_MODEL = env.model; }
    await click("#tab-media");
  }
  // The page over a history entry that cannot be read: the stream's error event reaches the message box (not a blank page), and once the entry is removed the page's own reconnect fills it in
  // and takes the no-state messages away. Before that state the page's writes, keys and zoom refuse by name instead of throwing.
  console.log("page, unreadable history entry");
  {
    const badDir = join(tmp, "unreadable-entry");
    api.create(badDir, { preset: "square" });
    await applyLatest(badDir, [{ op: "add_marker", t: 1 }]);
    await applyLatest(badDir, [{ op: "add_marker", t: 2 }]);
    const stack = join(badDir, ".agentcut", "history", "undo"), entryName = readdirSync(stack).sort().pop()!, entry = join(stack, entryName);
    const noRev = JSON.parse(readFileSync(entry, "utf8")); delete noRev.revision;
    writeFileSync(entry, JSON.stringify(noRev));
    const bad = await startUi(badDir, { port: 0 });
    // two tabs on the same stateless project: the first only watches, the second is handled (clicks, keys) before its state arrives
    const openTab = async () => {
      const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
      const sid = (await cdp("Target.attachToTarget", { targetId, flatten: true })).sessionId;
      const on = async (expr: string) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sid)).result?.value;
      const onUntil = async (expr: string, ms: number) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await on(expr).catch(() => false)) return true; await sleep(80); } return false; };
      await cdp("Runtime.enable", {}, sid);
      await cdp("Page.enable", {}, sid);
      await cdp("Page.navigate", { url: bad.url }, sid);
      return { targetId, on, onUntil };
    };
    const stateless = `document.getElementById("msg").className === "err" && document.getElementById("msg").textContent.indexOf("[bad_json]") >= 0 && document.getElementById("msg").textContent.indexOf(${JSON.stringify(entryName)}) >= 0 && document.getElementById("rev").textContent === ""`;
    const filled = `document.getElementById("rev").textContent.indexOf("rev ") === 0`;
    const tabs: { targetId: string }[] = [];
    try {
      const watch = await openTab(); tabs.push(watch);
      const hands = await openTab(); tabs.push(hands);
      check("over an unreadable history entry the page shows the named error and has no state", await watch.onUntil(stateless, 8000), await watch.on(`document.getElementById("msg").textContent`));
      // before any state the page has nothing to write against: each writer says so by name (a click that threw showed nothing), and the keys and the zoom do nothing
      await hands.onUntil(stateless, 8000);
      const errsBefore = consoleErrors.length;
      const refused = async (expr: string) => {
        for (let i = 0; i < 25; i++) { // the stream's own error comes back every few seconds: ask again until the refusal is what the box shows
          await hands.on(`document.getElementById("msg").className = ""; document.getElementById("msg").textContent = ""; ${expr}`);
          await sleep(100);
          if (await hands.on(`document.getElementById("msg").className === "err" && document.getElementById("msg").textContent.indexOf("[no_state]") === 0`)) return true;
        }
        return false;
      };
      const writers = {
        "Undo click": `document.getElementById("undo").click()`,
        "Redo click": `document.getElementById("redo").click()`,
        "Ctrl+Z": `document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }))`,
        "Apply ops": `document.getElementById("ops").value = "[]"; document.getElementById("applyo").click()`,
      };
      const said: Record<string, boolean> = {};
      for (const [what, expr] of Object.entries(writers)) said[what] = await refused(expr);
      await hands.on(`document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }))`);
      await hands.on(`(function(){var z=document.getElementById("zoom"); z.value="200"; z.dispatchEvent(new Event("input"));})()`);
      await hands.on(`document.getElementById("scroll").dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }))`);
      await sleep(300);
      check("with no state, Undo, Redo, Ctrl+Z and Apply ops each show the no-state refusal", Object.values(said).every(Boolean), said);
      check("  and those four, the arrow key, the zoom slider and the Ctrl+wheel throw no page exception", consoleErrors.length === errsBefore, consoleErrors.slice(errsBefore));
      // the second tab keeps asking for its refusal while it has no state (a click only then: once the state is there Undo would really undo), so the box holds the refusal when the state arrives.
      // The first ask is made while the entry is still there, so `before` is seeded from a page that surely has no state.
      let before = await hands.on(`(async function () { if (!document.getElementById("rev").textContent) document.getElementById("undo").click(); await null; await null; return document.getElementById("msg").textContent; })()`) as string;
      rmSync(entry);
      let after = { msg: "", cls: "", rev: "" };
      for (let t0 = Date.now(); !after.rev && Date.now() - t0 < 12000; await sleep(40)) {
        await hands.on(`if (!document.getElementById("rev").textContent) document.getElementById("undo").click()`);
        after = await hands.on(`({ msg: document.getElementById("msg").textContent, cls: document.getElementById("msg").className, rev: document.getElementById("rev").textContent })`);
        if (!after.rev) before = after.msg;
      }
      check("  and after the entry is removed the page's reconnect fills it in", await watch.onUntil(filled, 12000), await watch.on(`document.getElementById("rev").textContent`));
      check("  the stream's error is gone from the box once the state is there", await watch.onUntil(`document.getElementById("msg").textContent === "" && document.getElementById("msg").className === ""`, 3000), await watch.on(`document.getElementById("msg").textContent`));
      check("  and so is the no-state refusal of the tab that had asked for it", before.indexOf("[no_state]") === 0 && !!after.rev && after.msg === "" && after.cls === "", { before, after });
      // a message the user caused is not the page's lack of state: a state event that follows does not take it away
      await watch.on(`document.getElementById("ops").value = "not json"; document.getElementById("applyo").click()`);
      await applyLatest(badDir, [{ op: "add_marker", t: 3 }]);
      const revNow = (await api.info(badDir)).revision;
      check("  while an error the user caused stays when a later state arrives", await watch.onUntil(`document.getElementById("rev").textContent.indexOf("rev ${revNow} ") === 0 && document.getElementById("msg").className === "err" && document.getElementById("msg").textContent.indexOf(${JSON.stringify(entryName)}) < 0`, 8000), await watch.on(`[document.getElementById("rev").textContent, document.getElementById("msg").className, document.getElementById("msg").textContent]`));
    } finally {
      for (const t of tabs) await cdp("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      bad.server.closeAllConnections?.();
      await new Promise((ok) => bad.server.close(ok));
    }
  }
  // An HD h264 export played in the browser shows the colours the editor drew. Chrome reads an untagged HD h264 file as BT.709 and honours tags, so an export whose pixels
  // were made with another matrix, or one with no tags, shows saturated colours off by tens of levels. Flat patches are read well inside, after a frame was presented.
  // The same patches are read from a plain VP9 .webm export: Chrome does not guess a matrix for VP9, so that row is the one that shows whether the tag is honoured there.
  console.log("export in the browser");
  {
    // TOL: observed on the tagged export, the browser's own conversion is off by up to 12 levels on a saturated primary (green: B 11, blue: R 1, B 243) and by 3 or less elsewhere;
    // the same file untagged gave 39 on green (G 216), 24 on red, 14 on blue and 8 on the skin tone, so under 16 green and red separate the two (the export is read as BT.709 either way, so this row proves the pixels, and the tags rest on the ffprobe rows in codecs).
    const patches = ["#00ff00", "#ff0000", "#0000ff", "#c87850", "#808080"], per = 0.5, TOL = 16;
    const patchDir = join(tmp, "patches");
    api.create(patchDir, { width: 1280, height: 720, fps: 10 });
    await applyLatest(patchDir, patches.map((color) => ({ op: "add_clip", track: "main", type: "color", color, duration: per })));
    for (const file of ["patches.mp4", "patches.webm"]) await api.render(patchDir, { out: join(dir, "renders", file), workers: 1, sheet: false });
    const readPatches = (file: string) => js(`(async function () {
      var v = document.createElement("video"), cv = document.createElement("canvas"), out = [];
      v.muted = true; v.preload = "auto"; v.src = "/files/renders/${file}"; document.body.appendChild(v);
      await new Promise(function (ok, fail) { v.onloadeddata = ok; v.onerror = function () { fail(new Error("the export did not load")); }; });
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      var ctx = cv.getContext("2d", { willReadFrequently: true });
      for (var i = 0; i < ${patches.length}; i++) {
        // a frame counts once the browser presented one after the seek
        var shown = new Promise(function (ok) { v.requestVideoFrameCallback(function () { ok(); }); }), seeked = new Promise(function (ok) { v.onseeked = ok; });
        v.currentTime = (i + 0.5) * ${per};
        await Promise.race([Promise.all([seeked, shown]), new Promise(function (ok, fail) { setTimeout(function () { fail(new Error("no frame presented for patch " + i)); }, 8000); })]);
        ctx.drawImage(v, 0, 0);
        var d = ctx.getImageData(cv.width / 2 - 4, cv.height / 2 - 4, 9, 9).data, s = [0, 0, 0];
        for (var k = 0; k < d.length; k += 4) for (var c = 0; c < 3; c++) s[c] += d[k + c];
        out.push(s.map(function (x) { return Math.round(x / (d.length / 4)); }));
      }
      v.remove();
      return { size: [v.videoWidth, v.videoHeight], px: out };
    })()`).catch((e: Error) => ({ error: e.message }));
    const want = patches.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
    for (const [file, what] of [["patches.mp4", "h264"], ["patches.webm", "VP9 (.webm)"]] as const) {
      const got = await readPatches(file);
      const off = got.px ? got.px.map((p: number[], i: number) => Math.max(...p.map((x, c) => Math.abs(x - want[i][c])))) : null;
      console.log(`    ${what}: patches ${patches.join(" ")} read in the browser as ${JSON.stringify(got.px)}, largest difference per patch ${JSON.stringify(off)}`);
      check(`an HD ${what} export, played in the browser, shows every flat patch within the tolerance of the colour the editor drew`,
        got.size?.[0] === 1280 && got.px?.length === patches.length && off.every((x: number) => x <= TOL), { got, want, TOL });
    }
  }
  console.log("containment");
  // 192.0.2.1 is a documentation address: the contained browser must be refused at the network layer, before anything leaves the host
  await page("Network.enable");
  const probe = async (url: string) => {
    const r = await js(`(async function(){var t=performance.now();try{await fetch(${JSON.stringify(url)},{mode:"no-cors",cache:"no-store",signal:AbortSignal.timeout(3500)});return {outcome:"ok",ms:performance.now()-t}}catch(e){return {outcome:"failed",ms:performance.now()-t}}})()`);
    await sleep(100);
    return { ...r, errorText: netError.get(url) };
  };
  const reachable = await probe(ui.url), outside = await probe("http://192.0.2.1/");
  check("the browser reaches the suite's own loopback page, and the check does not call that refused", reachable.outcome === "ok" && !refusedAtOnce(reachable), reachable);
  check("a fetch to an address outside the host is refused at once by the network layer", refusedAtOnce(outside), outside);
  console.log(`    the browser reported ${outside.errorText} after ${Math.round(outside.ms)} ms`); // recorded, so a lane log shows which error the refusal is
  check("no page exceptions", consoleErrors.length === 0, consoleErrors);
  await shot("final");
} finally {
  ws?.close();
  chrome.kill();
  const gone = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  console.log(`chrome pid ${chrome.pid} ${gone ? "closed" : "did not close, SIGKILL"}`);
  if (!gone) { chrome.kill("SIGKILL"); await Promise.race([exited, sleep(5000)]); }
  ui.server.closeAllConnections?.();
  await new Promise((ok) => ui.server.close(ok));
  if (!process.argv.includes("--keep")) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failures() ? `\n${failures()} FAILED` : "\nall ui-browser checks passed");
process.exit(failures() ? 1 : 0);
