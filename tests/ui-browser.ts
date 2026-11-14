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
if (!CHROME) { console.log(`SKIPPED: ui-browser: Chrome not found (looked at $CHROME, ${MAC_CHROME}, and ${LINUX_CHROME.join(", ")} on PATH; set CHROME=/path/to/chrome)`); process.exit(0); }

let failures = 0;
const check = (name: string, cond: unknown, info?: unknown) => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}`, info !== undefined ? JSON.stringify(info).slice(0, 400) : ""); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(join(tmpdir(), "agentcut-uib-"));
process.env.AGENTCUT_HOME = join(tmp, "home");
process.env.AGENTCUT_CACHE = join(tmp, "cache"); // isolated cache root - set before importing the API
mkdirSync(join(tmp, "cache", "models", "u2netp"), { recursive: true }); writeFileSync(join(tmp, "cache", "models", "u2netp", "u2netp.onnx"), ""); // the default matte model is cached
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
console.log(`chrome pid ${chrome.pid}`);
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
  await api.apply(dir, [{ op: "update_clip", id: "vid1", set: { color: { exposure: 0.2, contrast: 0.1 } } }]);
  await click(`[data-id="vid1"]`);
  check("click selects the graded clip", await until("selection2", `$("selinfo").textContent.indexOf("vid1") === 0 && $("insp").value.indexOf('"contrast"') > 0`));
  await js(`(function(){var c=JSON.parse($("insp").value); delete c.color.contrast; $("insp").value=JSON.stringify(c,null,2); $("applyc").click();})()`);
  check("a key deleted inside a nested field is removed from project.json", await untilFile((tl) => { const g = clipOf(tl, "vid1")?.color; return g?.exposure === 0.2 && !("contrast" in g); }), clipOf(load(), "vid1")?.color);
  await click(`[data-id="txt1"]`);
  check("txt1 selected again", await until("reselect", `$("selinfo").textContent.indexOf("txt1") === 0 && $("kfadd") && !$("kfadd").disabled && S.revision === ${load().revision}`), await js(`$("selinfo").textContent`));

  console.log("viewer at the end of the timeline");
  await js(`$("vstat").textContent = ""; seek(total())`);
  check("the playhead at the duration shows the last frame, not an out-of-timeline error", await until("end frame", `$("vstat").textContent.indexOf("ms/frame") > 0`), await js(`$("vstat").textContent`));

  // a timeline with no duration has no frame: the viewer asks the server for none. One synchronous evaluation, so no page event runs in between: fetch and the page state
  // are swapped, pump() is called directly (no debounce) and both are put back; it runs only while the viewer is idle (an earlier request in flight would make pump return early)
  let none: any = null;
  for (let i = 0; i < 50 && !none?.ran; i++) {
    none = await js(`(function(){
      if (busy || want !== null) return { ran: false };
      var f = window.fetch, n = 0, s = S;
      window.fetch = function(){ n++; return f.apply(this, arguments); };
      try { S = Object.assign({}, S, { duration: 0 }); want = 0; pump(); return { ran: true, fetches: n, busy: busy, want: want }; }
      finally { window.fetch = f; S = s; }
    })()`);
    if (!none.ran) await sleep(80);
  }
  check("an empty timeline: the viewer sends no frame request", none?.ran === true && none.fetches === 0 && none.busy === false && none.want === null, none);

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
  await until("regroup", `!!document.querySelector('#regroups button[data-group="${cmpId}"]')`);
  await click(`[data-id="img1"]`);
  await js(`(function(){var c=JSON.parse($("insp").value); c.duration=1.2; $("insp").value=JSON.stringify(c); $("applyc").click();})()`);
  check("edit the expanded clip", await untilFile((tl) => clipOf(tl, "img1")?.duration === 1.2));
  await until("regroup after edit", `!!document.querySelector('#regroups button') && S.revision === ${load().revision}`);
  await js(`document.querySelector('#regroups button[data-group="${cmpId}"]').click()`);
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

  console.log("regroup buttons come from the project");
  const btns = `[].map.call(document.querySelectorAll("#regroups button"), function (b) { return b.dataset.group; }).sort().join()`;
  check("no button once everything is regrouped", await until("none", `${btns} === ""`), await js(btns));
  await api.apply(dir, [
    { op: "add_clip", track: "q", type: "color", color: "red", id: "qa", at: 0, duration: 1 },
    { op: "add_clip", track: "q", type: "color", color: "blue", id: "qb", at: 1, duration: 1 },
    { op: "add_clip", track: "q", type: "color", color: "green", id: "qc", at: 2, duration: 1 },
    { op: "make_compound", ids: ["qa", "qb"], id: "ga" },
    { op: "make_compound", ids: ["qc"], id: "gb", name: "solo" },
  ]);
  await until("compounds", `!!findIn(S.timeline.tracks, "ga") && !!findIn(S.timeline.tracks, "gb")`);
  await click(`[data-id="ga"]`);
  await until("expand ga", `$("expc").style.display === ""`);
  await js(`$("expc").click()`);
  await untilFile((tl) => !clipOf(tl, "ga") && clipOf(tl, "qa"));
  await until("one button", `${btns} === "ga" && S.revision === ${load().revision}`);
  // an expand made through the API (an agent, not the page) shows its button too
  await api.apply(dir, [{ op: "expand_compound", id: "gb" }]);
  check("two expands (page + agent) give two Regroup buttons", await until("two buttons", `${btns} === "ga,gb"`), await js(btns));
  await js(`location.reload()`);
  check("the buttons survive a page reload", await until("reloaded", `S && ${btns} === "ga,gb"`), await js(`S ? ${btns} : "no state"`));
  await api.apply(dir, [{ op: "split_clip", id: "qb", at: 1.5 }]);
  await until("split seen", `document.querySelectorAll('[data-id="qb"]').length === 1 && S.revision === ${load().revision}`);
  await js(`document.querySelector('#regroups button[data-group="ga"]').click()`);
  check("split, then Regroup takes both halves", await untilFile((tl) => {
    const c = clipOf(tl, "ga");
    return c?.type === "compound" && c.tracks.flatMap((t: any) => t.clips).length === 3 && !tl.tracks.flatMap((t: any) => t.clips).some((x: any) => x.group?.id === "ga");
  }), clipOf(load(), "ga"));
  check("the other group keeps its button", await until("gb only", `${btns} === "gb"`), await js(btns));
  await js(`document.querySelector('#regroups button[data-group="gb"]').click()`);
  check("Regroup keeps the compound's name", await untilFile((tl) => clipOf(tl, "gb")?.name === "solo"), clipOf(load(), "gb"));
  await until("regrouped all", `${btns} === "" && S.revision === ${load().revision}`);

  console.log("retimed compounds in the nested view");
  // expected placement = render's formula (render.ts subT): a nested time u plays at s + (u - in) / speed, level by level
  const place = (levels: { s: number; in: number; v: number }[], u: number) => levels.reduceRight((x, l) => l.s + (x - l.in) / l.v, u);
  const at = (levels: { s: number; in: number; v: number }[], u: number, du: number) => ({ left: place(levels, u), width: place(levels, u + du) - place(levels, u) });
  const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
  const boxOf = (id: string) => js(`(function(){var e=document.querySelector('[data-id="${id}"]');return {left:parseFloat(e.style.left)/pps,width:parseFloat(e.style.width)/pps,off:e.classList.contains("off")}})()`);
  const same = (b: any, w: { left: number; width: number }) => !!b && near(b.left, w.left) && near(b.width, w.width);
  await api.apply(dir, [
    { op: "add_clip", track: "n", type: "color", color: "red", id: "ra", at: 1, duration: 1 },
    { op: "add_clip", track: "n", type: "color", color: "blue", id: "rb", at: 2, duration: 2 },
    { op: "add_clip", track: "n", type: "color", color: "green", id: "rc", at: 5, duration: 1 },
    { op: "set_keyframes", id: "rb", prop: "opacity", keyframes: [[0, 1], [1, 0.5]] },
    { op: "make_compound", ids: ["ra", "rb", "rc"], id: "cs2" },
    { op: "update_clip", id: "cs2", set: { start: 2, in: 1, speed: 2, duration: 1.5 } },
  ]);
  await until("speed-2 compound", `!!findIn(S.timeline.tracks, "cs2")`);
  await click(`[data-id="cs2"]`, { count: 2 });
  await until("nested view", `V.nested && !!document.querySelector('[data-id="rb"]')`);
  const L1 = [{ s: 2, in: 1, v: 2 }];
  const [ba, bb, bc] = [await boxOf("ra"), await boxOf("rb"), await boxOf("rc")];
  check("speed-2 compound, in 1: nested clips sit where render plays them", same(ba, at(L1, 0, 1)) && same(bb, at(L1, 1, 2)) && same(bc, at(L1, 4, 1)), { ba, bb, bc, want: [at(L1, 0, 1), at(L1, 1, 2), at(L1, 4, 1)] });
  check("clips outside the visible window are dimmed, the one inside is not", ba.off && !bb.off && bc.off, { ba, bb, bc });
  await click(`[data-id="rb"] .kf[data-t="1"]`);
  const tk = await js(`t`);
  check("clicking a nested tick seeks to the timeline time render plays it at", near(tk, place(L1, 1 + 1)), { t: tk, want: place(L1, 2) });
  await js(`document.querySelector("#crumbs a").click()`);
  await until("top view", `!V.nested`);
  await api.apply(dir, [
    { op: "add_clip", track: "m", type: "color", color: "red", id: "x1", at: 1, duration: 2 },
    { op: "add_clip", track: "m", type: "color", color: "blue", id: "x2", at: 3, duration: 2 },
    { op: "make_compound", ids: ["x1", "x2"], id: "ci" },
    { op: "update_clip", id: "ci", set: { start: 2, in: 1, speed: 2, duration: 1.5 } },
    { op: "make_compound", ids: ["ci"], id: "co" },
    { op: "update_clip", id: "co", set: { start: 1, in: 0.25, speed: 0.5, duration: 3 } },
  ]);
  await until("two-level compound", `!!findIn(S.timeline.tracks, "co")`);
  await click(`[data-id="co"]`, { count: 2 });
  await until("outer open", `V.nested && !!document.querySelector('[data-id="ci"]')`);
  await click(`[data-id="ci"]`, { count: 2 });
  await until("inner open", `path.length === 2 && !!document.querySelector('[data-id="x2"]')`);
  const L2 = [{ s: 1, in: 0.25, v: 0.5 }, { s: 0, in: 1, v: 2 }];
  const [bx1, bx2] = [await boxOf("x1"), await boxOf("x2")];
  check("two levels (speed 0.5 outside, speed 2 inside): nested clips sit where render plays them", same(bx1, at(L2, 0, 2)) && same(bx2, at(L2, 2, 2)), { bx1, bx2, want: [at(L2, 0, 2), at(L2, 2, 2)] });
  await js(`document.querySelector("#crumbs a").click()`);
  await until("top view again", `!V.nested`);
  // a stamp whose compound id is a clip nested inside another compound: the server's make_compound from would answer "exists", so no button
  await api.apply(dir, [{ op: "add_clip", track: "q", type: "color", color: "red", id: "gz", at: 4, duration: 1, group: { id: "x1", track: "q" } }]);
  await until("stamped clip", `!!document.querySelector('[data-id="gz"]')`);
  check("no Regroup button for a group id that exists nested", await js(`${btns} === ""`), await js(btns));
  await api.apply(dir, [{ op: "remove_clip", id: "gz" }]);
  // a nested clip with a 0.5 s transition in a speed-2 compound: render plays the nested 0.5 s in 0.25 s
  await api.apply(dir, [
    { op: "add_clip", track: "w", type: "color", color: "red", id: "wa", at: 0, duration: 2 },
    { op: "add_clip", track: "w", type: "color", color: "blue", id: "wb", at: 1.5, duration: 2, transition: { type: "crossfade", duration: 0.5 } },
    { op: "make_compound", ids: ["wa", "wb"], id: "cw" },
    { op: "update_clip", id: "cw", set: { speed: 2, duration: 1.75 } },
  ]);
  await until("transition compound", `!!findIn(S.timeline.tracks, "cw")`);
  await click(`[data-id="cw"]`, { count: 2 });
  await until("transition nested view", `V.nested && !!document.querySelector('[data-id="wb"] .tr')`);
  const trw = await js(`parseFloat(document.querySelector('[data-id="wb"] .tr').style.width) / pps`);
  check("nested transition overlay is as wide as render plays it (0.5 s / speed 2)", near(trw, 0.5 / 2), trw);
  await js(`document.querySelector("#crumbs a").click()`);
  await until("top view after transition", `!V.nested`);

  console.log("previews/ui");
  await js(`$("sheet").click()`);
  check("contact sheet lands in previews/ui/", await until("sheet", `document.querySelector("#out img") && document.querySelector("#out img").src.indexOf("/files/previews/ui/") > 0`, 30_000));
  check("sheet image loads", await until("sheet img", `document.querySelector("#out img").naturalWidth > 0`));

  console.log("keyboard");
  await js(`document.activeElement.blur()`);
  check("Tab reaches Render, and Space on it starts a render, not play", await tabTo(`e.id === "render"`)
    && (await SPACE(), await until("render started", `renderJob !== null || !!document.querySelector("#out a")`)) && await js(`!playJob && $("video").style.display === "none"`),
    await js(`[document.activeElement.id, renderJob, playJob, $("play").textContent]`));
  check("  that render finishes", await until("render done", `!!document.querySelector("#out a") && !$("render").disabled`, 120_000), await js(`[$("msg").textContent, renderJob]`));
  await api.apply(dir, [{ op: "add_marker", t: 0.5 }]);
  await until("marker seen", `S.revision === ${load().revision} && !$("undo").disabled`);
  const rev0 = load().revision;
  await click("#undo");
  check("a mouse click on Undo undoes", await untilFile((tl) => tl.revision > rev0 && !(tl.markers ?? []).some((m: any) => m.t === 0.5)), load().markers);
  await until("undo seen", `S.revision === ${load().revision}`);
  await SPACE();
  check("after that click, Space plays", await until("play started", `playJob !== null || $("video").style.display !== "none"`), await js(`[document.activeElement.id, playJob, $("play").textContent]`));
  check("  the play draft starts the video", await until("playing", `$("play").textContent === "Stop"`, 120_000), await js(`[$("play").textContent, $("msg").textContent]`));
  await SPACE();
  check("  and Space stops it", await until("stopped", `$("video").style.display === "none" && $("play").textContent === "Play"`), await js(`[$("video").style.display, $("play").textContent]`));
  const errsPlay = consoleErrors.length;
  await js(`(function(){ var u = $("video").getAttribute("src"); playJob = "late"; onJob({ id: "late", status: "done", url: u }); $("video").pause(); })()`); // a stop right after the play started: play() is interrupted
  await sleep(300);
  check("a play interrupted by an immediate stop raises no page exception", consoleErrors.length === errsPlay, consoleErrors.slice(errsPlay));
  await js(`stopPlay()`);
  await js(`select(null); drawTimeline(); document.activeElement.blur()`);
  const byTime = `[].slice.call(document.querySelectorAll("#lanes .clip")).map(function (n, i) { return [parseFloat(n.style.left), i, n.dataset.id]; }).sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; }).map(function (x) { return x[2]; })`;
  const order = await js(byTime) as string[];
  check("exactly one clip is in the tab order, the others are -1, each is a button with a label naming its id and type", await js(`(function(){
    var n = [].slice.call(document.querySelectorAll("#lanes .clip"));
    return n.filter(function (x) { return x.tabIndex === 0; }).length === 1 && n.every(function (x) { return x.getAttribute("role") === "button" && x.getAttribute("aria-label").indexOf(x.dataset.id + ", " + S.timeline.tracks.flatMap(function (t) { return t.clips; }).filter(function (c) { return c.id === x.dataset.id; })[0].type + ", ") === 0; });
  })()`));
  check("Tab reaches the clips at the one tab stop", await tabTo(`e.classList.contains("clip")`) && await js(`document.activeElement.dataset.id`) === order[0], await js(`[document.activeElement.dataset.id, ${JSON.stringify(order)}]`));
  const t0 = await js(`t`);
  await press("ArrowRight", "ArrowRight", 39);
  check("Right moves the focus to the next clip in time order and does not move the playhead", await js(`document.activeElement.dataset.id`) === order[1] && await js(`t`) === t0 && await js(`document.activeElement.tabIndex`) === 0, await js(`[document.activeElement.dataset.id, t]`));
  await press("ArrowLeft", "ArrowLeft", 37);
  await press("ArrowRight", "ArrowRight", 39);
  await ENTER();
  check("Enter selects the focused clip and the inspector shows it", await until("keyboard selection", `sel === ${JSON.stringify(order[1])} && $("selinfo").textContent.indexOf(${JSON.stringify(order[1])}) === 0 && JSON.parse($("insp").value).id === ${JSON.stringify(order[1])}`), await js(`[sel, $("selinfo").textContent]`));
  await press("ArrowLeft", "ArrowLeft", 37);
  await SPACE();
  check("Space on a keyboard-focused clip selects it, as Enter does", await until("space selection", `sel === ${JSON.stringify(order[0])}`), await js(`[sel, document.activeElement.dataset.id]`));
  await press("ArrowRight", "ArrowRight", 39);
  await js(`window.oldClip = document.activeElement; $("scroll").scrollLeft = 0`);
  await api.apply(dir, [{ op: "add_marker", t: 0.7 }]);
  check("the focus stays on that clip, by id, after an apply rebuilds the timeline", await until("rebuilt", `S.revision === ${load().revision} && document.activeElement !== window.oldClip && document.activeElement.dataset.id === ${JSON.stringify(order[1])}`), await js(`[document.activeElement.className, document.activeElement.dataset && document.activeElement.dataset.id]`));
  await press("ArrowRight", "ArrowRight", 39);
  check("  and it is still keyboard focus: Right walks on to the next clip", await js(`document.activeElement.dataset.id`) === order[2], await js(`document.activeElement.dataset.id`));
  const tt = await js(`t`);
  await click(`[data-id="${order[0]}"]`);
  await press("ArrowRight", "ArrowRight", 39);
  check("after a mouse click on another top-level clip, Right steps the playhead instead of walking from the keyboard-focused clip", Math.abs(await js(`t`) - (tt + 1 / 30)) < 1e-6 && await js(`sel`) === order[0], await js(`[t, ${tt}, sel, document.activeElement.className]`));
  // a nested clip takes focus from a mouse click (its mousedown does not cancel the default): the page's keys keep working there
  await click(`[data-id="cs2"]`, { count: 2 });
  await until("nested view", `V.nested && !!document.querySelector('[data-id="rb"]')`);
  await click(`[data-id="rb"]`);
  const tm = await js(`t`);
  await press("ArrowRight", "ArrowRight", 39);
  check("after a mouse click on a clip that took focus, Right steps the playhead instead of walking the clips", Math.abs(await js(`t`) - (tm + 1 / 30)) < 1e-6 && await js(`document.activeElement.dataset.id`) === "rb", await js(`[t, document.activeElement.dataset.id, ${tm}]`));
  await js(`document.querySelector("#crumbs a").click()`);
  await until("top view", `!V.nested`);
  await js(`document.activeElement.blur()`);
  await js(`seek(1)`);
  await press("ArrowRight", "ArrowRight", 39);
  check("with no clip focused, Right still steps the playhead by a frame", Math.abs(await js(`t`) - (1 + 1 / 30)) < 1e-6, await js(`t`));
  const revZ = load().revision;
  check("Tab reaches Contact sheet", await tabTo(`e.id === "sheet"`), await js(`document.activeElement.id`));
  await press("z", "KeyZ", 90, undefined, 2);
  check("Ctrl+Z on a keyboard-focused button still undoes", await untilFile((tl) => tl.revision > revZ), { rev: load().revision, revZ });

  console.log("page width");
  await api.apply(dir, [{ op: "add_clip", track: "wide", type: "color", color: "gray", id: "wide1", at: 0, duration: 120 }]);
  await until("wide timeline", `!!document.querySelector('[data-id="wide1"]') && S.revision === ${load().revision}`);
  await js(`(function(){var n = document.querySelector('[data-id="cw"]'); n.tabIndex = 0; n.focus(); $("scroll").scrollLeft = 600; window.scrolled = $("scroll").scrollLeft;})()`);
  await api.apply(dir, [{ op: "add_marker", t: 0.9 }]);
  check("a rebuild with a clip focused leaves the timeline where it was scrolled", await until("rebuilt at scroll", `S.revision === ${load().revision} && document.activeElement.dataset.id === "cw"`) && await js(`window.scrolled > 0 && $("scroll").scrollLeft === window.scrolled`), await js(`[window.scrolled, $("scroll").scrollLeft]`));
  const errs0 = consoleErrors.length, weird = 'q"a\\b';
  await api.apply(dir, [{ op: "add_clip", track: "idt", type: "color", color: "red", id: weird, at: 0, duration: 1 }]);
  await until("odd id drawn", `!!clipNodes.get(${JSON.stringify(weird)})`);
  await js(`document.activeElement.blur(); select(${JSON.stringify(weird)})`);
  await api.apply(dir, [{ op: "add_marker", t: 0.95 }]);
  check("a clip id with a quote and a backslash is drawn, is the tab stop when selected, and breaks no redraw", await until("odd id redrawn", `S.revision === ${load().revision} && clipNodes.get(${JSON.stringify(weird)}).tabIndex === 0`)
    && await js(`document.querySelectorAll(".clip").length`) === await js(`clipNodes.size`) && consoleErrors.length === errs0, { errors: consoleErrors.slice(errs0) });
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
  await api.apply(dir, [{ op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 1, id: "rb1" }, { op: "remove_background", id: "rb1" }]);
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
    es.addEventListener("job", function (e) { var j = JSON.parse(e.data); if (j.kind === "prepare" && j.status !== "running") got = true; });
    window.fetch = function (u) {
      var r = f.apply(this, arguments);
      if (String(u) !== "/api/prepare") return r;
      return r.then(function (res) { return new Promise(function (ok) { var n = 0; (function w() { if (got || ++n > 100) { window.fetch = f; ok(res); } else setTimeout(w, 50); })(); }); });
    };
    $("prepare").style.display = "";
  })()`);
  await click("#prepare");
  check("Prepare with nothing to compute is not stuck when its job event beats the POST response",
    await until("prepare reset", `$("prepare").style.display === "none" && !$("prepare").disabled && $("prepare").textContent === "Prepare"`, 10_000),
    await js(`[$("prepare").style.display, $("prepare").disabled, $("prepare").textContent, $("msg").textContent]`));
  // a missing model is downloaded only after a click in the dialog: Escape and Cancel send nothing, Confirm sends one request with the flag
  console.log("download consent");
  await js(`(function(){
    var f = window.fetch; window.prepBodies = [];
    window.fetch = function (u, o) { if (String(u) === "/api/prepare") window.prepBodies.push(JSON.parse(o.body)); else window.otherUrls.push(String(u)); return f.apply(this, arguments); };
    window.otherUrls = [];
  })()`);
  await api.apply(dir, [{ op: "add_clip", track: "main", src: join(media, "a.mp4"), duration: 1, id: "rb2" }, { op: "remove_background", id: "rb2", model: "u2net_human_seg" }]);
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
  check("Escape closes the dialog and shows the normal failure", await until("escaped", `!$("consent").open && $("msg").textContent.indexOf("[model_not_cached]") === 0 && !$("prepare").disabled && $("prepare").textContent === "Prepare"`),
    await js(`[$("consent").open, $("msg").textContent, $("prepare").textContent]`));
  check("Cancel closes the dialog too", await ask() && (await click("#cno"), await until("cancelled", `!$("consent").open && !$("prepare").disabled`)));
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
      check("once the download has ended and the helper has not reported a frame, the button no longer reads Downloading", await until("download text gone", `$("prepare").textContent.indexOf("Downloading") !== 0 && $("prepare").disabled`), await js(`$("prepare").textContent`));
      rmSync(holdFile, { force: true });
      check("Confirm sends exactly one request with the flag, the model is fetched once from its pinned URL, and the prepare completes",
        await until("confirmed", `$("prepare").style.display === "none" && !$("consent").open`, 30_000) && JSON.stringify(await bodies()) === '[{},{},{},{"allow_download":true}]' && asked.join() === pinned.url, { bodies: await bodies(), asked });
    } finally { release(); rmSync(holdFile, { force: true }); globalThis.fetch = realFetch; Object.assign(pin, pinned); }
  }
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
console.log(failures ? `\n${failures} FAILED` : "\nall ui-browser checks passed");
process.exit(failures ? 1 : 0);
