import { expect, test } from "@playwright/test";
import { EXTENSION_ID } from "@pi-browser/shared";
import { launch, openPanel, pairViaPanel, startSession, tabIdOf, type Env } from "./helpers";

let env: Env;
test.beforeAll(async () => {
  env = await launch({ settings: { permissionMode: "auto", allowedDomains: ["localhost", "127.0.0.1"] } });
});
test.afterAll(async () => env?.close());

test("fixed extension id, pairing, session group, basic tools", async () => {
  expect(env.extId).toBe(EXTENSION_ID); // EXT-04
  const page = await env.ctx.newPage();
  await page.goto(`${env.site.a}/index.html`);
  const tabId = await tabIdOf(env, page);
  const panel = await openPanel(env, tabId);
  await expect(panel.getByTestId("status")).toBeVisible();
  await pairViaPanel(env, panel);
  await startSession(env, page, panel);

  // AK-01: the tab is now in a group titled "Agent", orange
  const group = await env.sw.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    const g = await chrome.tabGroups.get(t.groupId);
    return { title: g.title, color: g.color };
  }, tabId);
  expect(group.color).toBe("orange");
  expect(group.title).toMatch(/^Agent/);

  const ctxRes = await env.pi.tool("tabs_context");
  expect(ctxRes.ok).toBe(true);
  expect(env.pi.text(ctxRes)).toContain(String(tabId));

  const shot = await env.pi.tool("computer", { action: "screenshot", tabId });
  expect(shot.ok, env.pi.text(shot)).toBe(true);
  expect(env.pi.images(shot)).toHaveLength(1);
  expect((shot.details as any).screenshotId).toMatch(/^ss_[a-z0-9]{9}$/);

  const tree = await env.pi.tool("read_page", { tabId, filter: "interactive" });
  expect(tree.ok, env.pi.text(tree)).toBe(true);
  expect(env.pi.text(tree)).toContain("<page_content");
  expect(env.pi.text(tree)).toContain('button "Increment"');
});
