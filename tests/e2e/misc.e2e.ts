import { chromium, expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIST, expectEventually, launch, openPanel, pairViaPanel, startSession, tabIdOf, type Env } from "./helpers";

let env: Env;
let panel: Page;
let page: Page;
let tabId: number;
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

test("AUX-06: a background tab can be screenshotted and operated; it stays in the background", async () => {
  const created = await env.pi.tool("tabs_create", { url: `${env.site.a}/index.html` });
  const bg = (created.details as any).tabId as number;
  await page.bringToFront();
  const active = await env.sw.evaluate(async (id) => (await chrome.tabs.get(id)).active, bg);
  expect(active).toBe(false);
  const shot = await env.pi.tool("computer", { action: "screenshot", tabId: bg });
  expect(shot.ok, txt(shot)).toBe(true);
  expect(env.pi.images(shot)).toHaveLength(1);
  const tree = txt(await env.pi.tool("read_page", { tabId: bg, filter: "interactive" }));
  const ref = /button "Increment" \[(ref_\d+)\]/.exec(tree)![1];
  const click = await env.pi.tool("computer", { action: "left_click", ref, tabId: bg });
  expect(click.ok, txt(click)).toBe(true);
  const count = await env.sw.evaluate(async (id) => (await chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.getElementById("count")!.textContent })) [0].result, bg);
  expect(count).toBe("1");
  const state = await env.sw.evaluate(async (id) => { const t = await chrome.tabs.get(id); return { active: t.active, muted: t.mutedInfo?.muted }; }, bg);
  expect(state).toEqual({ active: false, muted: false });
  await env.pi.tool("tabs_close", { tabId: bg });
});

test("UI-09: the group title shows progress while the agent works and a tick when settled", async () => {
  const title = () => env.sw.evaluate(async (id) => (await chrome.tabGroups.get((await chrome.tabs.get(id)).groupId)).title, tabId);
  env.pi.emit({ type: "run_state", state: "started" });
  await expectEventually(async () => /●/.test((await title()) ?? ""), 5000, "dot on");
  await expectEventually(async () => /○/.test((await title()) ?? ""), 5000, "dot off (it blinks)");
  expect(((await title()) ?? "").match(/[●○]/g)).toHaveLength(1); // always exactly one dot
  env.pi.emit({ type: "run_state", state: "settled" });
  await expectEventually(async () => /✓/.test((await title()) ?? ""), 5000, "tick");
});

test("UI-19: a notification appears when an approval is waiting and the panel is not open", async () => {
  await env.sw.evaluate(async () => {
    const cur = (await chrome.storage.local.get("settings")).settings;
    await chrome.storage.local.set({ settings: { ...cur, permissionMode: "ask", allowedDomains: [] } });
  });
  await env.sw.evaluate(() => chrome.storage.local.set({ grants: [] }));
  await panel.close();
  await new Promise((r) => setTimeout(r, 500));
  const pending = env.pi.tool("get_page_text", { tabId }, { deadlineMs: 4000 }).catch(() => null);
  await expectEventually(async () => (await env.sw.evaluate(() => new Promise<string[]>((res) => chrome.notifications.getAll((o) => res(Object.keys(o)))))).some((k) => k.startsWith("approval:")), 8000, "approval notification");
  await pending; // times out -> denied
  panel = await openPanel(env, tabId);
  await env.sw.evaluate(async () => {
    const cur = (await chrome.storage.local.get("settings")).settings;
    await chrome.storage.local.set({ settings: { ...cur, permissionMode: "auto", allowedDomains: ["localhost", "127.0.0.1"] } });
  });
});

test("UI-21: scheduled shortcuts create alarms and a firing alarm starts the prompt", async () => {
  await env.sw.evaluate(async () => {
    await chrome.storage.local.set({ shortcuts: [{ id: "daily1", name: "Morning", prompt: "Check the dashboard", params: [], schedule: { kind: "daily", time: "07:30" } }] });
  });
  await expectEventually(async () => (await env.sw.evaluate(() => new Promise<string[]>((res) => chrome.alarms.getAll((a) => res(a.map((x) => x.name)))))).includes("shortcut:daily1"), 5000, "alarm");
  const n = env.pi.prompts.length;
  await env.sw.evaluate(() => chrome.alarms.create("shortcut:daily1", { when: Date.now() + 300 }));
  await expectEventually(() => env.pi.prompts.length > n, 8000, "scheduled prompt");
  expect(env.pi.prompts[env.pi.prompts.length - 1].text).toBe("Check the dashboard");
});

test("UI-22: a recorded workflow becomes a reusable shortcut", async () => {
  await page.goto(`${env.site.a}/form.html`);
  await page.bringToFront();
  await panel.getByRole("button", { name: /Record a workflow|Workflow aufzeichnen/ }).click();
  await expect(panel.getByRole("button", { name: /Stop recording|Aufzeichnung beenden/ })).toBeVisible();
  await page.fill("#n-name", "Ada");
  await page.locator("#n-name").blur();
  await page.click("#n-submit");
  await new Promise((r) => setTimeout(r, 400));
  await panel.getByRole("button", { name: /Stop recording|Aufzeichnung beenden/ }).click();
  await expectEventually(async () => {
    const list = await env.sw.evaluate(async () => (await chrome.storage.local.get("shortcuts")).shortcuts ?? []);
    return list.some((s: any) => /Workflow/.test(s.name) && /Native submit/.test(s.prompt) && /"Ada"/.test(s.prompt));
  }, 8000, "saved workflow");
});

test("AUX-03: request bodies are recorded only when enabled; Authorization and Cookie never", async () => {
  await page.goto(`${env.site.a}/index.html`);
  await env.pi.tool("read_network_requests", { tabId, clear: true });
  await page.evaluate(() => fetch("/form.html?post=1", { method: "POST", headers: { Authorization: "Bearer topsecret", "X-Test": "1" }, body: JSON.stringify({ hello: "world" }) }));
  await new Promise((r) => setTimeout(r, 300));
  const off = txt(await env.pi.tool("read_network_requests", { tabId, urlPattern: "post=1" }));
  expect(off).toContain("POST");
  expect(off).not.toContain("hello");
  await env.sw.evaluate(async () => {
    const cur = (await chrome.storage.local.get("settings")).settings;
    await chrome.storage.local.set({ settings: { ...cur, capturePostData: true } });
  });
  await new Promise((r) => setTimeout(r, 300));
  env.pi.emit({ type: "run_state", state: "settled" }); // INP-03: all debuggers are released, the next attach reads the setting
  await new Promise((r) => setTimeout(r, 500));
  await page.goto(`${env.site.a}/index.html`);
  await env.pi.tool("read_network_requests", { tabId, clear: true });
  await page.evaluate(() => fetch("/form.html?post=2", { method: "POST", headers: { Authorization: "Bearer topsecret" }, body: JSON.stringify({ hello: "world" }) }));
  await new Promise((r) => setTimeout(r, 300));
  const on = txt(await env.pi.tool("read_network_requests", { tabId, urlPattern: "post=2" }));
  expect(on).toContain("hello");
  expect(on).not.toContain("topsecret");
  expect(on).not.toMatch(/authorization/i);
});

test("NFA-14: the extension debug log is off by default and on when enabled", async () => {
  const logs: string[] = [];
  env.sw.on("console", (m) => logs.push(m.text()));
  await env.pi.tool("tabs_context");
  expect(logs.filter((l) => l.includes("[browser-agent]"))).toEqual([]);
  await env.sw.evaluate(async () => {
    const cur = (await chrome.storage.local.get("settings")).settings;
    await chrome.storage.local.set({ settings: { ...cur, debug: true } });
  });
  await new Promise((r) => setTimeout(r, 300));
  await env.pi.tool("tabs_context");
  await expectEventually(() => logs.some((l) => l.includes("[browser-agent]") && l.includes("tool_request")), 4000, "debug output");
  expect(logs.join("\n")).not.toMatch(/Authorization|topsecret/);
  await env.sw.evaluate(async () => {
    const cur = (await chrome.storage.local.get("settings")).settings;
    await chrome.storage.local.set({ settings: { ...cur, debug: false } });
  });
});

test("NFA-12: the interface follows the browser language (German)", async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-de-"));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: process.env.CHROME_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
    headless: false,
    locale: "de-DE",
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--headless=new", "--no-sandbox", "--lang=de"],
    env: { ...process.env, LANGUAGE: "de", LC_ALL: "de_DE.UTF-8" },
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker");
    const extId = new URL(sw.url()).host;
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/sidepanel.html?tabId=1`);
    await expect(p.getByTestId("status")).toHaveText(/Getrennt|Kopplung nötig|Verbinde/, { timeout: 15_000 });
    expect(await p.locator("h1").textContent()).toBe("Browser-Agent");
    await expect(p.getByTestId("send")).toHaveText("Senden");
    const o = await ctx.newPage();
    await o.goto(`chrome-extension://${extId}/options.html`);
    await expect(o.getByRole("heading", { name: /Einstellungen/ })).toBeVisible();
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
