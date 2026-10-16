import { expect, test, type Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIST, expectEventually, openPanel, startSite, tabIdOf, type Site } from "./helpers";
import { RealPi } from "./real-pi";

/** API-01: terminal-led operation against a REAL pi process (scripted model, real bridge, real extension). */

async function boot(scenario: string) {
  const site = await startSite();
  const pi = new RealPi();
  await pi.start(scenario);
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-real-"));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: process.env.CHROME_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--headless=new", "--no-sandbox"],
    viewport: { width: 1200, height: 800 },
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  for (let i = 0; i < 50 && !(await sw.evaluate(() => !!chrome?.storage?.local).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100));
  const extId = new URL(sw.url()).host;
  await sw.evaluate(async (p) => chrome.storage.local.set({ settings: { port: p, permissionMode: "auto", allowedDomains: ["localhost", "127.0.0.1"] } }), pi.port);
  const env = { ctx, sw, extId, site, pi } as any;
  const close = async () => {
    await ctx.close().catch(() => {});
    await pi.stop();
    await site.close();
    fs.rmSync(userDir, { recursive: true, force: true });
  };
  return { env, close, site, pi, ctx, sw, extId };
}

async function pairPanel(panel: Page, pi: RealPi) {
  await expect(panel.getByTestId("status")).toHaveText(/Pairing required|Kopplung nötig/, { timeout: 20_000 });
  const code = await pi.pairingCode();
  await panel.getByTestId("pair-input").fill(code);
  await panel.getByRole("button", { name: /^(Pair|Koppeln)$/ }).click();
  await expect(panel.getByTestId("status")).toHaveText(/Connected|Verbunden/, { timeout: 20_000 });
}

test("real pi: the model drives the browser through the bridge and the panel mirrors it (API-01/02/15, UI-17)", async () => {
  const h = await boot("browse");
  try {
    const page = await h.ctx.newPage();
    await page.goto(`${h.site.a}/index.html`);
    const tabId = await tabIdOf(h.env, page);
    const panel = await openPanel(h.env, tabId);
    await pairPanel(panel, h.pi);
    await page.bringToFront();
    // the system prompt of the real session contains the bridge's section (API-15)
    h.pi.send({ id: "sp", type: "get_state" });
    await panel.getByTestId("input").fill("click the increment button");
    await panel.getByTestId("send").click();
    await expect(page.locator("#count")).toHaveText("1", { timeout: 40_000 });
    await expect(panel.getByTestId("msg-assistant").last()).toContainText("Finished: clicked the Increment button", { timeout: 40_000 });
    // the panel shows the tool calls (extension tools with screenshot preview)
    const names = await panel.getByTestId("tool-row").locator(".tname").allTextContents();
    expect(names).toEqual(expect.arrayContaining(["tabs_context", "computer", "read_page"]));
    await expect(panel.getByTestId("msg-user").first()).toContainText("click the increment button");
    // pi's own transcript contains an image block from the screenshot (API-12)
    h.pi.send({ id: "m", type: "get_messages" });
    const msgs = await h.pi.waitFor((e) => e.type === "response" && e.id === "m", 10_000, "messages");
    const results = (msgs.data.messages as any[]).filter((m) => m.role === "toolResult");
    expect(results.some((m) => m.toolName === "computer" && m.content.some((c: any) => c.type === "image"))).toBe(true);
    expect(results.every((m) => !m.isError)).toBe(true);
    // the model saw all 20 browser tools and the bridge's own prompt section (API-15, section 6)
    const req = h.pi.requests();
    expect(req.length).toBeGreaterThan(3);
    const browserTools = ["computer", "navigate", "read_page", "find", "form_input", "get_page_text", "javascript_tool", "tabs_context", "tabs_create", "tabs_close", "browser_batch", "update_plan", "read_console_messages", "read_network_requests", "upload_image", "file_upload", "resize_window", "gif_creator", "shortcuts_list", "shortcuts_execute"];
    expect(req[0].tools).toEqual(expect.arrayContaining(browserTools));
    expect(req[0].systemPrompt).toContain("Browser work");
    expect(req[0].systemPrompt).toContain("DATA");
    expect(req[0].systemPrompt).toContain("browser_batch");
  } finally {
    await h.close();
  }
});

test("real pi: browser_batch with form_input fills a React form (AK-04 through the real stack)", async () => {
  const h = await boot("batch");
  try {
    const page = await h.ctx.newPage();
    await page.goto(`${h.site.a}/form.html`);
    const tabId = await tabIdOf(h.env, page);
    const panel = await openPanel(h.env, tabId);
    await pairPanel(panel, h.pi);
    await page.bringToFront();
    await panel.getByTestId("input").fill("fill the form");
    await panel.getByTestId("send").click();
    await expect(panel.getByTestId("msg-assistant").last()).toContainText("Form filled", { timeout: 40_000 });
    const state = JSON.parse((await page.locator("#state").textContent())!);
    expect(state).toMatchObject({ first: "Grace", email: "grace@example.com" });
  } finally {
    await h.close();
  }
});

test("real pi: Stop in the panel aborts the real run (SEC-13) and /browser tools off hides the tools (API-18)", async () => {
  const h = await boot("slow");
  try {
    const page = await h.ctx.newPage();
    await page.goto(`${h.site.a}/index.html`);
    const tabId = await tabIdOf(h.env, page);
    const panel = await openPanel(h.env, tabId);
    await pairPanel(panel, h.pi);
    await page.bringToFront();
    await panel.getByTestId("input").fill("wait a long time");
    await panel.getByTestId("send").click();
    await expect(panel.getByTestId("stop")).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByTestId("tool-row").filter({ hasText: "wait" })).toBeVisible({ timeout: 20_000 });
    const t0 = Date.now();
    await panel.getByTestId("stop").click();
    await h.pi.waitFor((e) => e.type === "agent_settled" || e.type === "agent_end", 15_000, "agent end after stop");
    expect(Date.now() - t0).toBeLessThan(8000);
    await expect(panel.getByTestId("stop")).toBeHidden({ timeout: 10_000 });
    // /browser tools off
    h.pi.send({ id: "off", type: "prompt", message: "/browser tools off" });
    await h.pi.waitFor((e) => e.type === "extension_ui_request" && /Browser tools disabled/.test(e.message ?? ""), 10_000, "tools off");
    // the next model request no longer offers any browser tool (API-18)
    const n = h.pi.requests().length;
    h.pi.send({ id: "again", type: "prompt", message: "hello again" });
    await expectEventually(() => h.pi.requests().length > n, 20_000, "next model request");
    const last = h.pi.requests().pop()!;
    expect(last.tools.filter((t) => ["computer", "read_page", "navigate"].includes(t))).toEqual([]);
    expect(last.systemPrompt).not.toContain("Browser work");
  } finally {
    await h.close();
  }
});
