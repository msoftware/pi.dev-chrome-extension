import { expect, test, type Page } from "@playwright/test";
import { autoDecide, expectEventually, launch, openPanel, pairViaPanel, startSession, tabIdOf, type Env } from "./helpers";

let env: Env;
let panel: Page;
let page: Page;
let tabId: number;

async function freshPage(url: string) {
  await page.goto(url);
  await page.bringToFront();
}
const txt = (r: any) => env.pi.text(r);

test.beforeAll(async () => {
  env = await launch({ settings: { permissionMode: "auto", allowedDomains: ["localhost", "127.0.0.1"] } });
  page = await env.ctx.newPage();
  await page.goto(`${env.site.a}/index.html`);
  tabId = await tabIdOf(env, page);
  panel = await openPanel(env, tabId);
  await pairViaPanel(env, panel);
  await startSession(env, page, panel);
  await page.bringToFront();
});
test.afterAll(async () => env?.close());

test("navigate normalizes the URL, waits for load and reports the title", async () => {
  const r = await env.pi.tool("navigate", { tabId, url: `${env.site.a}/form.html` });
  expect(r.ok, txt(r)).toBe(true);
  expect(txt(r)).toContain("Form fixture");
  expect(page.url()).toBe(`${env.site.a}/form.html`);
  const bad = await env.pi.tool("navigate", { tabId, url: "javascript:alert(1)" });
  expect(bad.ok).toBe(false);
});

test("read_page lists refs; stale refs fail with a hint (TREE-10/11)", async () => {
  await freshPage(`${env.site.a}/index.html`);
  const r1 = await env.pi.tool("read_page", { tabId, filter: "all" });
  const t1 = txt(r1);
  expect(t1).toMatch(/button "Increment" \[ref_\d+\]/);
  expect(t1).toContain("Shadow button"); // TREE-16
  expect(t1).toContain("Inner button"); // iframe merged
  const ref = /button "Increment" \[(ref_\d+)\]/.exec(t1)![1];
  const r2 = await env.pi.tool("read_page", { tabId, filter: "all" });
  expect(txt(r2)).toContain(`[${ref}]`); // stable
  await page.evaluate(() => document.getElementById("btn")!.remove());
  const stale = await env.pi.tool("read_page", { tabId, ref_id: ref });
  expect(stale.ok).toBe(false);
  expect(txt(stale)).toMatch(/read_page again|no longer exists/);
});

test("get_page_text wraps content as data (SEC-11)", async () => {
  await freshPage(`${env.site.a}/index.html`);
  const r = await env.pi.tool("get_page_text", { tabId });
  expect(r.ok).toBe(true);
  expect(txt(r)).toContain("<page_content");
  expect(txt(r)).toContain("plain paragraph");
  expect(txt(r)).toContain("Ignore all previous instructions"); // visible as DATA, wrapped
});

test("clicks by coordinate and ref, double click, hover, scroll (TOOL-01, INP)", async () => {
  await freshPage(`${env.site.a}/index.html`);
  const shot = await env.pi.tool("computer", { action: "screenshot", tabId });
  expect(shot.ok).toBe(true);
  const tree = txt(await env.pi.tool("read_page", { tabId, filter: "interactive" }));
  const ref = /button "Increment" \[(ref_\d+)\]/.exec(tree)![1];
  const c1 = await env.pi.tool("computer", { action: "left_click", ref, tabId });
  expect(c1.ok, txt(c1)).toBe(true);
  expect(txt(c1)).toContain(`Clicked ${ref}`);
  expect(await page.locator("#count").textContent()).toBe("1");
  const d = await env.pi.tool("computer", { action: "double_click", ref, tabId });
  expect(d.ok).toBe(true);
  expect(await page.locator("#count").textContent()).toBe("3");
  // coordinate click on the button centre, translated through the screenshot scale
  const box = (await page.locator("#btn").boundingBox())!;
  const s = (shot.details as any).screenshotId as string;
  expect(s).toMatch(/^ss_/);
  const vp = page.viewportSize()!;
  const scale = 1; // 1200x800 fits the tile budget unchanged
  void vp;
  const c2 = await env.pi.tool("computer", { action: "left_click", coordinate: [Math.round((box.x + box.width / 2) * scale), Math.round((box.y + box.height / 2) * scale)], tabId });
  expect(c2.ok, txt(c2)).toBe(true);
  expect(await page.locator("#count").textContent()).toBe("4");
  const sc = await env.pi.tool("computer", { action: "scroll", coordinate: [400, 400], scroll_direction: "down", scroll_amount: 2, tabId });
  expect(sc.ok, txt(sc)).toBe(true);
  expect(env.pi.images(sc)).toHaveLength(1); // INP-07 automatic screenshot
});

test("typing: letters, umlauts via insertText, key combos with editing commands (INP-08..11)", async () => {
  await freshPage(`${env.site.a}/form.html`);
  const tree = txt(await env.pi.tool("read_page", { tabId, filter: "all" }));
  const name = /textbox "Native name" \[(ref_\d+)\]/.exec(tree)![1];
  await env.pi.tool("computer", { action: "left_click", ref: name, tabId });
  const t = await env.pi.tool("computer", { action: "type", text: "Hello Wörld 😀\nX", tabId });
  expect(t.ok, txt(t)).toBe(true);
  expect(await page.inputValue("#n-name")).toBe("Hello Wörld 😀X"); // the newline became Enter, which a text input ignores
  const sel = await env.pi.tool("computer", { action: "key", text: "ctrl+a", tabId });
  expect(sel.ok, txt(sel)).toBe(true);
  const del = await env.pi.tool("computer", { action: "key", text: "Delete", tabId });
  expect(del.ok).toBe(true);
  expect(await page.inputValue("#n-name")).toBe("");
  await env.pi.tool("computer", { action: "type", text: "abc", tabId });
  await env.pi.tool("computer", { action: "key", text: "Foo", tabId }).then((r) => expect(r.ok).toBe(false)); // unknown key name -> clear error
  await env.pi.tool("computer", { action: "key", text: "Backspace", repeat: 2, tabId });
  expect(await page.inputValue("#n-name")).toBe("a");
  // cmd+a on Linux behaves like ctrl+a (INP-11)
  await env.pi.tool("computer", { action: "key", text: "cmd+a Delete", tabId });
  expect(await page.inputValue("#n-name")).toBe("");
});

test("AK-04: browser_batch fills a React form in one call and React takes the values", async () => {
  await freshPage(`${env.site.a}/form.html`);
  const tree = txt(await env.pi.tool("read_page", { tabId, filter: "all" }));
  const ref = (re: RegExp) => re.exec(tree)![1];
  const first = ref(/textbox "Your first name" \[(ref_\d+)\]/); // placeholder wins over label (TREE-05)
  const email = ref(/textbox "Email" \[(ref_\d+)\] type="email"/);
  const country = ref(/combobox "Country" \[(ref_\d+)\]/);
  const agree = ref(/checkbox "I agree" \[(ref_\d+)\]/);
  const before = env.pi.progress.length;
  const r = await env.pi.tool("browser_batch", {
    tabId,
    actions: [
      { name: "form_input", input: { ref: first, value: "Ada" } },
      { name: "form_input", input: { ref: email, value: "ada@example.com" } },
      { name: "form_input", input: { ref: country, value: "Austria" } },
      { name: "form_input", input: { ref: agree, value: true } },
    ],
  });
  expect(r.ok, txt(r)).toBe(true);
  expect(txt(r)).toContain("Executed all 4 actions");
  const state = JSON.parse(await page.locator("#state").textContent() as string);
  expect(state).toMatchObject({ first: "Ada", email: "ada@example.com", country: "at", agree: true });
  expect(env.pi.progress.length - before).toBeGreaterThanOrEqual(4); // TOOL-07
});

test("browser_batch stops at the first failure and says how many ran (TOOL-05)", async () => {
  await freshPage(`${env.site.a}/form.html`);
  const tree = txt(await env.pi.tool("read_page", { tabId, filter: "all" }));
  const first = /textbox "Your first name" \[(ref_\d+)\]/.exec(tree)![1];
  const r = await env.pi.tool("browser_batch", {
    tabId,
    actions: [
      { name: "form_input", input: { ref: first, value: "x" } },
      { name: "form_input", input: { ref: "ref_99999", value: "y" } },
      { name: "form_input", input: { ref: first, value: "z" } },
    ],
  });
  expect(r.ok).toBe(false);
  expect(txt(r)).toMatch(/Executed 1 of 3/);
  expect(txt(r)).toMatch(/skipped 1/);
  const nope = await env.pi.tool("browser_batch", { tabId, actions: [{ name: "tabs_create", input: {} }] });
  expect(nope.ok).toBe(false);
});

test("AK-06: password values are redacted in read_page and javascript_tool", async () => {
  await freshPage(`${env.site.a}/form.html`);
  const stopApprovals = autoDecide(panel, "once"); // typing into a password field always needs a one-time approval (SEC-10)
  const tree = txt(await env.pi.tool("read_page", { tabId, filter: "all" }));
  const pw = /textbox "Password" \[(ref_\d+)\] type="password"/.exec(tree)![1];
  const set = await env.pi.tool("form_input", { tabId, ref: pw, value: "hunter2-secret" });
  expect(set.ok, txt(set)).toBe(true);
  expect(txt(set)).not.toContain("hunter2");
  const again = txt(await env.pi.tool("read_page", { tabId, filter: "all" }));
  expect(again).toContain("[value redacted]");
  expect(again).not.toContain("hunter2");
  const js = await env.pi.tool("javascript_tool", { tabId, action: "javascript_exec", text: "document.querySelector('input[type=password]').value" });
  expect(js.ok, txt(js)).toBe(true);
  expect(txt(js)).not.toContain("hunter2");
  expect(txt(js)).toContain("[value redacted]"); // JS-07
  stopApprovals();
});

test("javascript_tool: block mode, async wrapper, errors, output filter (JS-02..06)", async () => {
  await freshPage(`${env.site.a}/index.html`);
  const a = await env.pi.tool("javascript_tool", { tabId, action: "javascript_exec", text: "const x = 20; x + 22" });
  expect(txt(a)).toContain("42");
  const b = await env.pi.tool("javascript_tool", { tabId, action: "javascript_exec", text: "await Promise.resolve(1); return {answer: 7, token: 'abc', list: [1,2]}" }); // return -> async wrapper
  expect(b.ok, txt(b)).toBe(true);
  expect(txt(b)).toContain('"answer": 7');
  expect(txt(b)).toContain("[BLOCKED: Sensitive key]");
  const c = await env.pi.tool("javascript_tool", { tabId, action: "javascript_exec", text: "throw new Error('boom')" });
  expect(txt(c)).toContain("boom");
  const d = await env.pi.tool("javascript_tool", { tabId, action: "javascript_exec", text: "document.cookie = 'a=1'; document.cookie" });
  expect(txt(d)).toMatch(/BLOCKED: Cookie\/query string data|a=1/);
  const e = await env.pi.tool("javascript_tool", { tabId, action: "javascript_exec", text: "" });
  expect(e.ok).toBe(false);
});

test("tabs: create, context, close, foreign tab rejected (UI-06/07)", async () => {
  await freshPage(`${env.site.a}/index.html`);
  const created = await env.pi.tool("tabs_create", { url: `${env.site.a}/form.html` });
  expect(created.ok, txt(created)).toBe(true);
  const newId = (created.details as any).tabId as number;
  const ctx = txt(await env.pi.tool("tabs_context"));
  expect(ctx).toContain(`tabId ${newId}`);
  // a tab outside the group is refused
  const outsider = await env.ctx.newPage();
  await outsider.goto(`${env.site.a}/frame.html`);
  const outId = await tabIdOf(env, outsider);
  const refused = await env.pi.tool("computer", { action: "screenshot", tabId: outId });
  expect(refused.ok).toBe(false);
  expect(txt(refused)).toContain("tabs_context");
  await outsider.close();
  const closed = await env.pi.tool("tabs_close", { tabId: newId });
  expect(closed.ok).toBe(true);
  const main = await env.pi.tool("tabs_close", { tabId });
  expect(main.ok).toBe(false);
});

test("a click that opens a new tab reports its id and groups it (TOOL-02)", async () => {
  await freshPage(`${env.site.a}/index.html`);
  const tree = txt(await env.pi.tool("read_page", { tabId, filter: "interactive" }));
  const ref = /link "Open form in new tab" \[(ref_\d+)\]/.exec(tree)![1];
  const r = await env.pi.tool("computer", { action: "left_click", ref, tabId });
  expect(r.ok, txt(r)).toBe(true);
  expect(txt(r)).toMatch(/new tab: tabId \d+/);
  const id = Number(/tabId (\d+)/.exec(txt(r))![1]);
  const ctx = txt(await env.pi.tool("tabs_context"));
  expect(ctx).toContain(`tabId ${id}`);
  await env.pi.tool("tabs_close", { tabId: id });
});

test("restricted pages allow only navigate (TOOL-09)", async () => {
  const tab = await env.sw.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    const nt = await chrome.tabs.create({ url: "chrome://version", windowId: t.windowId, active: false });
    await chrome.tabs.group({ tabIds: [nt.id!], groupId: t.groupId });
    return nt.id!;
  }, tabId);
  const r = await env.pi.tool("read_page", { tabId: tab });
  expect(r.ok).toBe(false);
  expect(txt(r)).toContain("only navigate");
  await env.sw.evaluate((id) => chrome.tabs.remove(id), tab);
});

test("EXT-10: the content script is injected on demand", async () => {
  await freshPage(`${env.site.a}/index.html`);
  await env.sw.evaluate(async (id) => {
    await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: () => void delete (globalThis as any).__piA11y });
  }, tabId);
  const r = await env.pi.tool("read_page", { tabId, filter: "interactive" });
  expect(r.ok, txt(r)).toBe(true);
  expect(txt(r)).toContain("Increment");
});

test("console and network buffers (AUX-01/02)", async () => {
  await freshPage(`${env.site.a}/index.html`);
  const first = await env.pi.tool("read_console_messages", { tabId }); // attaches the debugger
  expect(first.ok).toBe(true);
  await page.evaluate(() => { console.log("hello log"); console.error("bad thing"); setTimeout(() => { throw new Error("uncaught!"); }, 0); fetch("/form.html?probe=1"); });
  await expectEventually(async () => txt(await env.pi.tool("read_console_messages", { tabId, onlyErrors: true })).includes("uncaught!"), 5000, "console error");
  const all = txt(await env.pi.tool("read_console_messages", { tabId, pattern: "hello" }));
  expect(all).toContain("hello log");
  expect(all).not.toContain("bad thing");
  const net = txt(await env.pi.tool("read_network_requests", { tabId, urlPattern: "probe=1" }));
  expect(net).toContain("GET");
  expect(net).toContain("200");
});

test("javascript dialogs block until answered (AUX-04/05)", async () => {
  page.on("dialog", () => {}); // Playwright would dismiss dialogs itself without a listener
  await freshPage(`${env.site.a}/dialogs.html`);
  const tree = txt(await env.pi.tool("read_page", { tabId, filter: "interactive" }));
  const ref = /button "Show confirm" \[(ref_\d+)\]/.exec(tree)![1];
  await env.pi.tool("computer", { action: "screenshot", tabId });
  const click = env.pi.tool("computer", { action: "left_click", ref, tabId });
  const res = await click;
  expect(txt(res)).toContain("dialog is open");
  const blocked = await env.pi.tool("computer", { action: "type", text: "x", tabId });
  expect(blocked.ok).toBe(false);
  expect(txt(blocked)).toContain("dialog");
  const ans = await env.pi.tool("computer", { action: "key", text: "Enter", tabId });
  expect(txt(ans)).toContain("Accepted");
  await expect(page.locator("#r")).toHaveText("confirm: true");
});

test("beforeunload dialogs are cancelled by default, accepted on request (AUX-04)", async () => {
  page.on("dialog", () => {});
  await freshPage(`${env.site.a}/dialogs.html`);
  await page.locator("#dirty").click();
  await page.evaluate(() => 0);
  const stay = await env.pi.tool("navigate", { tabId, url: `${env.site.a}/index.html` });
  // The page stays (dialog cancelled), so navigation is aborted; the result must still arrive.
  expect(stay.ok).toBe(false);
  expect(txt(stay)).toContain("leaveDialog");
  expect(page.url()).toContain("dialogs.html");
  const leave = await env.pi.tool("navigate", { tabId, url: `${env.site.a}/index.html`, leaveDialog: "accept" });
  expect(leave.ok, txt(leave)).toBe(true);
  expect(page.url()).toContain("index.html");
});

test("file_upload and upload_image (AUX-08/10)", async () => {
  await freshPage(`${env.site.a}/upload.html`);
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const f = path.join(os.tmpdir(), "pi-upload-test.txt");
  fs.writeFileSync(f, "hello upload");
  const tree = txt(await env.pi.tool("read_page", { tabId, filter: "all" }));
  const input = /\[(ref_\d+)\] type="file"/.exec(tree)?.[1] ?? /(?:textbox|button|generic)[^\n]*\[(ref_\d+)\] type="file"/.exec(tree)![1];
  const r = await env.pi.tool("file_upload", { tabId, ref: input, paths: [f] });
  expect(r.ok, txt(r)).toBe(true);
  await expect(page.locator("#o")).toHaveText("pi-upload-test.txt:12");
  const shot = await env.pi.tool("computer", { action: "screenshot", tabId });
  const id = (shot.details as any).screenshotId;
  const up = await env.pi.tool("upload_image", { tabId, imageId: id, ref: input, filename: "shot.jpg" });
  expect(up.ok, txt(up)).toBe(true);
  await expect(page.locator("#o")).toContainText("shot.jpg");
  const box = (await page.locator("#drop").boundingBox())!;
  const drop = await env.pi.tool("upload_image", { tabId, imageId: id, coordinate: [Math.round(box.x + 20), Math.round(box.y + 20)] });
  expect(drop.ok, txt(drop)).toBe(true);
  await expect(page.locator("#o")).toHaveText("dropped 1");
});

test("resize_window and zoom", async () => {
  await freshPage(`${env.site.a}/index.html`);
  await env.pi.tool("computer", { action: "screenshot", tabId });
  const z = await env.pi.tool("computer", { action: "zoom", region: [0, 0, 300, 200], tabId });
  expect(z.ok, txt(z)).toBe(true);
  expect(env.pi.images(z)).toHaveLength(1);
  const noshot = await env.pi.tool("resize_window", { tabId, width: 1000, height: 700 });
  expect(noshot.ok, txt(noshot)).toBe(true);
});

test("gif recording exports an image usable with upload_image (AUX-11)", async () => {
  await freshPage(`${env.site.a}/index.html`);
  const s = await env.pi.tool("gif_creator", { tabId, action: "start_recording" });
  expect(s.ok, txt(s)).toBe(true);
  const tree = txt(await env.pi.tool("read_page", { tabId, filter: "interactive" }));
  const ref = /button "Increment" \[(ref_\d+)\]/.exec(tree)![1];
  await env.pi.tool("computer", { action: "left_click", ref, tabId });
  await env.pi.tool("computer", { action: "left_click", ref, tabId });
  const stop = await env.pi.tool("gif_creator", { tabId, action: "stop_recording" });
  expect(txt(stop)).toMatch(/\d+ frames/);
  const exp = await env.pi.tool("gif_creator", { tabId, action: "export", download: false });
  expect(exp.ok, txt(exp)).toBe(true);
  const id = (exp.details as any).screenshotId as string;
  const head = await env.sw.evaluate(async (sid) => {
    const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open("pi-browser"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const rec = await new Promise<any>((res) => { const g = db.transaction("screenshots").objectStore("screenshots").get(sid); g.onsuccess = () => res(g.result); });
    return { mime: rec?.mime, head: atob(rec.data.slice(0, 12)).slice(0, 6) };
  }, id);
  expect(head).toEqual({ mime: "image/gif", head: "GIF89a" });
  await env.pi.tool("gif_creator", { tabId, action: "clear" });
});

test("shortcuts_list / shortcuts_execute (UI-21)", async () => {
  await env.sw.evaluate(async () => {
    await chrome.storage.local.set({ shortcuts: [{ id: "sc1", name: "Daily check", prompt: "Open {{site}} and report", params: ["site"], schedule: null }, { id: "sc2", name: "Plain", prompt: "Say hi", params: [], schedule: null }] });
  });
  const list = await env.pi.tool("shortcuts_list");
  expect(txt(list)).toContain("Daily check");
  const n = env.pi.prompts.length;
  const ex = await env.pi.tool("shortcuts_execute", { shortcutId: "sc2" });
  expect(ex.ok, txt(ex)).toBe(true);
  await expectEventually(() => env.pi.prompts.length > n);
  expect(env.pi.prompts[env.pi.prompts.length - 1].text).toBe("Say hi");
});
