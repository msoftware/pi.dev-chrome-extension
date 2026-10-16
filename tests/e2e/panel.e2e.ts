import { expect, test, type Page } from "@playwright/test";
import { autoDecide, expectEventually, launch, openPanel, pairViaPanel, tabIdOf, type Env } from "./helpers";

let env: Env;
let panel: Page;
let page: Page;
let tabId: number;

test.beforeAll(async () => {
  env = await launch({ settings: { permissionMode: "ask" } });
  page = await env.ctx.newPage();
  await page.goto(`${env.site.a}/index.html`);
  tabId = await tabIdOf(env, page);
  panel = await openPanel(env, tabId);
});
test.afterAll(async () => env?.close());

test("not paired: shows the pairing form; a wrong code is rejected; the right one connects (UI-14, API-06)", async () => {
  await expect(panel.getByTestId("status")).toHaveText(/Pairing required|Kopplung nötig/);
  await panel.getByTestId("pair-input").fill("000000");
  await panel.getByRole("button", { name: /^(Pair|Koppeln)$/ }).click();
  env.pi.tokens.createPairingCode();
  await expect(panel.getByTestId("toast")).toBeVisible();
  await pairViaPanel(env, panel);
  await expect(panel.getByTestId("status")).toHaveText(/Connected|Verbunden/);
});

test("chat: Enter sends, Shift+Enter breaks the line, the message appears via the stream (UI-11)", async () => {
  const box = panel.getByTestId("input");
  await box.fill("line one");
  await box.press("Shift+Enter");
  await box.type("line two");
  expect(await box.inputValue()).toBe("line one\nline two");
  await box.press("Enter");
  await expectEventually(() => env.pi.prompts.length === 1);
  expect(env.pi.prompts[0].text).toBe("line one\nline two");
  expect(env.pi.prompts[0].tabContext.length).toBeGreaterThan(0); // API-14
  await expect(panel.getByTestId("msg-user").last()).toContainText("line one");
  expect(await box.inputValue()).toBe("");
});

test("streaming markdown with sanitising, tables, lazy code highlighting (UI-12/15)", async () => {
  env.pi.emit({ type: "run_state", state: "started" });
  for (const part of ["Hello **wor", "ld**.\n\n", "| a | b |\n|---|---|\n| 1 | 2 |\n\n", "```js\nconst x = 1;\n```\n\n", "<img src=x onerror=\"window.__xss=1\"><script>window.__xss=2</script>[link](https://example.com)"]) {
    env.pi.emit({ type: "assistant_delta", text: part });
  }
  await expect(panel.getByTestId("msg-assistant").last()).toContainText("Hello world");
  env.pi.emit({ type: "assistant_message", text: "Hello **world**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n\n<img src=x onerror=\"window.__xss=1\"><script>window.__xss=2</script>[link](https://example.com)" });
  env.pi.emit({ type: "run_state", state: "settled" });
  const msg = panel.getByTestId("msg-assistant").last();
  await expect(msg.locator("strong")).toHaveText("world");
  await expect(msg.locator("table td").first()).toHaveText("1");
  await expect(msg.locator(".code-hl pre")).toBeVisible({ timeout: 10_000 }); // shiki loaded on demand
  expect(await panel.evaluate(() => (window as any).__xss)).toBeUndefined();
  const a = msg.locator("a");
  await expect(a).toHaveAttribute("target", "_blank");
  await expect(a).toHaveAttribute("rel", /noopener/);
});

test("mermaid and math render on demand (UI-15)", async () => {
  env.pi.emit({ type: "assistant_message", text: "```mermaid\ngraph TD; A-->B;\n```\n\n$$E = mc^2$$" });
  const msg = panel.getByTestId("msg-assistant").last();
  await expect(msg.locator(".katex")).toBeVisible({ timeout: 15_000 });
  await expect(msg.locator(".diagram svg")).toBeVisible({ timeout: 20_000 });
});

test("tool calls show as collapsible rows with a screenshot preview (UI-12)", async () => {
  await page.bringToFront();
  // read access needs approval in ask mode
  const stop = autoDecide(panel, "once");
  const r = await env.pi.tool("computer", { action: "screenshot", tabId });
  stop();
  expect(r.ok).toBe(true);
  const row = panel.getByTestId("tool-row").last();
  await expect(row).toContainText("computer");
  await expect(row).toContainText("screenshot");
  await row.locator("summary").click();
  await expect(row.locator("img.shot")).toBeVisible();
});

test("model, thinking level and permission mode controls (UI-13)", async () => {
  const model = panel.getByTestId("model");
  await expect(model.locator("option")).toHaveCount(2);
  await model.selectOption("fake/two");
  await expectEventually(() => env.pi.config.some((c) => c.model === "fake/two"));
  await panel.getByTestId("thinking").selectOption("high");
  await expectEventually(() => env.pi.config.some((c) => c.thinkingLevel === "high"));
  await panel.getByTestId("mode").selectOption("plan");
  await expectEventually(async () => (await env.sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.permissionMode)) === "plan");
  await panel.getByTestId("mode").selectOption("auto");
  await expect(panel.locator(".warn")).toBeVisible();
  await panel.getByTestId("mode").selectOption("ask");
});

test("Stop button during a run calls /v1/abort; text sent while running steers (UI-11)", async () => {
  env.pi.emit({ type: "run_state", state: "started" });
  await expect(panel.getByTestId("stop")).toBeVisible();
  await panel.getByTestId("input").fill("also check the footer");
  await panel.getByTestId("send").click();
  await expectEventually(() => env.pi.steers.length === 1);
  const n = env.pi.aborts;
  await panel.getByTestId("stop").click();
  await expectEventually(() => env.pi.aborts === n + 1);
  env.pi.emit({ type: "run_state", state: "settled" });
  await expect(panel.getByTestId("stop")).toBeHidden();
});

test("terminal-led mode: prompts and tool calls from the terminal show up (UI-17, AK-11)", async () => {
  env.pi.emit({ type: "user_message", text: "run the build from the terminal", source: "terminal" });
  env.pi.emit({ type: "tool_activity", phase: "start", toolCallId: "t1", toolName: "bash", summary: "npm run build" });
  env.pi.emit({ type: "tool_activity", phase: "end", toolCallId: "t1", toolName: "bash", summary: "", isError: false });
  await expect(panel.getByText("run the build from the terminal")).toBeVisible();
  await expect(panel.getByText("from terminal")).toBeVisible();
  const row = panel.locator(".tool.activity").last();
  await expect(row).toContainText("bash");
  await expect(row).toContainText("npm run build");
});

test("history: earlier sessions can be reopened read-only (UI-18)", async () => {
  await panel.getByRole("button", { name: /Chat history|Verlauf/ }).click();
  await expect(panel.getByRole("menuitem", { name: /Earlier chat/ })).toBeVisible();
  await panel.getByRole("menuitem", { name: /Earlier chat/ }).click();
  await expect(panel.getByText("old question")).toBeVisible();
  await expect(panel.getByText("old answer")).toBeVisible();
  await expect(panel.getByTestId("send")).toBeDisabled();
  await panel.getByRole("button", { name: /Back to the current session|Zurück/ }).click();
  await expect(panel.getByTestId("send")).toBeEnabled();
});

test("approval dialog: Escape denies; keyboard reachable (SEC-04, NFA-13)", async () => {
  await page.bringToFront();
  const pending = env.pi.tool("computer", { action: "scroll_to", ref: "ref_1", tabId });
  const dlg = panel.getByTestId("approval");
  await expect(dlg).toBeVisible();
  await expect(panel.getByTestId("allow-once")).toBeFocused();
  await panel.keyboard.press("Escape");
  const r = await pending;
  expect(r.ok).toBe(false);
  await expect(dlg).toBeHidden();
});

test("every button has an accessible name (NFA-13)", async () => {
  const bad = await panel.evaluate(() =>
    Array.from(document.querySelectorAll("button")).filter((b) => !(b.getAttribute("aria-label") || b.textContent?.trim() || b.title)).map((b) => b.outerHTML.slice(0, 80)),
  );
  expect(bad).toEqual([]);
  const inputs = await panel.evaluate(() =>
    Array.from(document.querySelectorAll("input,select,textarea")).filter((el) => !(el.getAttribute("aria-label") || (el as HTMLInputElement).labels?.length || el.closest("label"))).map((e) => e.outerHTML.slice(0, 80)),
  );
  expect(inputs).toEqual([]);
});

test("privacy note is shown and can be dismissed (NFA-09)", async () => {
  await expect(panel.getByTestId("privacy")).toBeVisible();
  await panel.getByTestId("privacy").getByRole("button").click();
  await expect(panel.getByTestId("privacy")).toBeHidden();
});

test("bridge down: status and startup help, automatic reconnect with backoff (NFA-05)", async () => {
  const port = env.pi.server.port;
  await env.pi.server.stop();
  await expect(panel.getByTestId("status")).toHaveText(/Not connected|Getrennt/, { timeout: 15_000 });
  await expect(panel.getByTestId("startup-help")).toContainText("pi -e pi-browser-bridge");
  await expect(panel.getByTestId("startup-help")).toContainText(String(port));
  const back = new (await import("./helpers")).FakePi();
  await back.start(port);
  env.pi.server = back.server; // keep afterAll working
  env.pi.tokens = back.tokens;
  // the new bridge has no pairing for this browser: the panel must ask for it again
  await expect(panel.getByTestId("status")).toHaveText(/Pairing required|Kopplung nötig|Connected|Verbunden/, { timeout: 20_000 });
});
