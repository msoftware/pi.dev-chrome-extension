import { expect, test, type Page } from "@playwright/test";
import { autoDecide, expectEventually, launch, openPanel, pairViaPanel, startSession, tabIdOf, type Env } from "./helpers";

let env: Env;
let panel: Page;
let page: Page;
let tabId: number;
const txt = (r: any) => env.pi.text(r);

async function setSettings(patch: Record<string, unknown>) {
  await env.sw.evaluate(async (p) => {
    const cur = ((await chrome.storage.local.get("settings")).settings ?? {}) as object;
    await chrome.storage.local.set({ settings: { ...cur, ...p } });
  }, patch);
  await new Promise((r) => setTimeout(r, 200));
}
async function clearGrants() {
  await env.sw.evaluate(() => chrome.storage.local.set({ grants: [] }));
  await new Promise((r) => setTimeout(r, 200));
}

test.beforeAll(async () => {
  env = await launch({ settings: { permissionMode: "ask", allowedDomains: [], alwaysAskDomains: [], blockedDomains: [] } });
  page = await env.ctx.newPage();
  await page.goto(`${env.site.a}/index.html`);
  tabId = await tabIdOf(env, page);
  panel = await openPanel(env, tabId);
  await pairViaPanel(env, panel);
  await startSession(env, page, panel);
  await page.bringToFront();
});
test.afterAll(async () => env?.close());
test.beforeEach(async () => {
  await clearGrants();
  await setSettings({ permissionMode: "ask", allowedDomains: [], alwaysAskDomains: [], blockedDomains: [] });
  await page.goto(`${env.site.a}/index.html`);
});

test("ask mode: first action per permission type and domain asks, 'once' does not stick, 'always' does (SEC-01/02)", async () => {
  const seen: any[] = [];
  const stop = autoDecide(panel, "once", seen);
  const a = await env.pi.tool("read_page", { tabId });
  expect(a.ok, txt(a)).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0].domain).toBe("localhost");
  const b = await env.pi.tool("read_page", { tabId });
  expect(b.ok).toBe(true);
  expect(seen).toHaveLength(2); // once = bound to the tool call
  stop();
  const stop2 = autoDecide(panel, "always", seen);
  await env.pi.tool("read_page", { tabId });
  const n = seen.length;
  await env.pi.tool("read_page", { tabId });
  await env.pi.tool("get_page_text", { tabId });
  expect(seen.length).toBe(n); // READ is now always allowed on localhost
  stop2();
});

test("denying returns an error and does not act (SEC-02)", async () => {
  const stop = autoDecide(panel, "deny");
  const r = await env.pi.tool("computer", { action: "left_click", coordinate: [50, 50], tabId });
  stop();
  expect(r.ok).toBe(false);
  expect(txt(r)).toContain("Declined");
});

test("the approval dialog shows what will be typed / run (SEC-04) and typing into passwords asks even in auto mode (SEC-10)", async () => {
  await setSettings({ permissionMode: "auto", allowedDomains: ["localhost"] });
  await page.goto(`${env.site.a}/form.html`);
  const seen: any[] = [];
  const stop = autoDecide(panel, "once", seen);
  const tree = txt(await env.pi.tool("read_page", { tabId, filter: "all" }));
  const name = /textbox "Native name" \[(ref_\d+)\]/.exec(tree)![1];
  const pw = /textbox "Native password" \[(ref_\d+)\]/.exec(tree)![1];
  await env.pi.tool("computer", { action: "left_click", ref: name, tabId });
  const t = await env.pi.tool("computer", { action: "type", text: "visible text", tabId });
  expect(t.ok, txt(t)).toBe(true);
  expect(seen.length).toBe(0); // auto mode: plain text needs no approval
  await env.pi.tool("computer", { action: "left_click", ref: pw, tabId });
  const sensitive = await env.pi.tool("computer", { action: "type", text: "topsecret", tabId });
  expect(sensitive.ok, txt(sensitive)).toBe(true);
  expect(seen.length).toBe(1); // SEC-10
  expect(seen[0].preview).not.toContain("topsecret");
  const js = await env.pi.tool("javascript_tool", { tabId, action: "javascript_exec", text: "1+1 /*marker-code*/" });
  expect(js.ok).toBe(true);
  stop();
});

test("always-ask domains offer only a one-time approval (SEC-06)", async () => {
  await setSettings({ alwaysAskDomains: ["localhost"] });
  const seen: any[] = [];
  const stop = autoDecide(panel, "once", seen);
  await env.pi.tool("read_page", { tabId });
  stop();
  expect(seen).toHaveLength(1);
  expect(await panel.getByTestId("allow-always").count()).toBe(0);
  await expectEventually(async () => (await env.sw.evaluate(async () => ((await chrome.storage.local.get("grants")).grants ?? []).length)) === 0);
});

test("leaving the domain needs its own approval (SEC-05), AK-12 style injected target", async () => {
  await setSettings({ allowedDomains: ["localhost"] }); // reading/navigating on localhost is free
  const seen: any[] = [];
  const stop = autoDecide(panel, "deny", seen);
  const r = await env.pi.tool("navigate", { tabId, url: "http://evil.example/steal" });
  stop();
  expect(r.ok).toBe(false);
  expect(txt(r)).toContain("Declined");
  expect(seen.length).toBe(1);
  expect(seen[0].domain).toBe("evil.example");
  expect(page.url()).toContain("localhost");
  // allowed target domain: no question
  await setSettings({ allowedDomains: ["localhost", "127.0.0.1"] });
  const ok = await env.pi.tool("navigate", { tabId, url: `${env.site.b}/index.html` });
  expect(ok.ok, txt(ok)).toBe(true);
});

test("blocked domains: tools refuse and in-group navigation is redirected to blocked.html (11.3)", async () => {
  await setSettings({ blockedDomains: ["127.0.0.1"], allowedDomains: ["localhost"] });
  const r = await env.pi.tool("navigate", { tabId, url: `${env.site.b}/index.html` });
  expect(r.ok).toBe(false);
  expect(txt(r)).toMatch(/blocked/i);
  // the user (not the agent) navigates a tab of the group to the blocked domain
  await page.evaluate((u) => (location.href = u), `${env.site.b}/index.html`);
  await expectEventually(() => page.url().includes("blocked.html"), 8000, "blocked page");
  await expect(page.locator("h1")).toContainText(/blocked|gesperrt/i);
  await page.goto(`${env.site.a}/index.html`);
});

test("plan mode: update_plan asks once, the approved domains then need no further questions", async () => {
  await setSettings({ permissionMode: "plan" });
  const seen: any[] = [];
  const stop = autoDecide(panel, "once", seen);
  const plan = await env.pi.tool("update_plan", { domains: ["localhost"], approach: ["Open the page", "Read it", "Report back"] });
  expect(plan.ok, txt(plan)).toBe(true);
  expect(seen.length).toBe(1);
  await env.pi.tool("computer", { action: "screenshot", tabId });
  await env.pi.tool("computer", { action: "left_click", coordinate: [10, 10], tabId });
  expect(seen.length).toBe(1); // everything on localhost was covered by the plan
  const other = await env.pi.tool("navigate", { tabId, url: `${env.site.b}/index.html` });
  expect(other.ok, txt(other)).toBe(true);
  expect(seen.length).toBe(2); // the other domain is asked
  stop();
});

test("automatic mode: a deviating action is blocked by the second check unless the user approves (SEC-09)", async () => {
  await setSettings({ permissionMode: "auto", allowedDomains: ["localhost"] });
  env.pi.reviewVerdict = { allow: false, reason: "does not match the task" };
  const seen: any[] = [];
  const stop = autoDecide(panel, "deny", seen);
  const r = await env.pi.tool("computer", { action: "left_click", coordinate: [20, 20], tabId });
  stop();
  env.pi.reviewVerdict = { allow: true };
  expect(r.ok).toBe(false);
  expect(txt(r)).toContain("safety check");
  expect(env.pi.reviews.length).toBeGreaterThan(0);
  expect(env.pi.reviews[env.pi.reviews.length - 1].tool).toBe("computer");
});

test("AK-05: a redirect to another domain during the click aborts it with a safety-check error (SEC-08)", async () => {
  await setSettings({ permissionMode: "auto", allowedDomains: ["localhost"] });
  await page.goto(`${env.site.a}/trap.html`);
  const r = await env.pi.tool("computer", { action: "left_click", coordinate: [200, 130], tabId });
  expect(r.ok, txt(r)).toBe(false);
  expect(txt(r)).toMatch(/Safety check/i);
  await page.goto(`${env.site.a}/trap.html`);
  await expect(page.locator("#r")).toHaveText("not clicked");
});

test("every tool call is written to the audit log (SEC-14)", async () => {
  await setSettings({ permissionMode: "auto", allowedDomains: ["localhost"] });
  await env.pi.tool("read_page", { tabId });
  const rows = await env.sw.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open("pi-browser"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return await new Promise<any[]>((res) => { const g = db.transaction("audit").objectStore("audit").getAll(); g.onsuccess = () => res(g.result); });
  });
  expect(rows.length).toBeGreaterThan(3);
  const last = rows[rows.length - 1];
  expect(last).toMatchObject({ tool: "read_page", domain: "localhost", result: "ok" });
  expect(typeof last.ts).toBe("number");
});

test("the options page shows the log and 'delete all data' clears it (NFA-08)", async () => {
  const opt = await env.ctx.newPage();
  await opt.goto(`chrome-extension://${env.extId}/options.html`);
  await expect(opt.getByTestId("audit-table")).toBeVisible();
  await expect(opt.locator("tbody tr").first()).toBeVisible();
  opt.on("dialog", (d) => d.accept());
  await opt.getByTestId("delete-all").click();
  await expectEventually(async () => (await env.sw.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).length)) === 0, 8000, "storage cleared");
  await opt.close();
});
