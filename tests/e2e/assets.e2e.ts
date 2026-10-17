/**
 * Generates the store and gallery images in docs/images/ (run with MAKE_ASSETS=1 npx playwright test assets).
 * It drives the real extension against the demo page with a fake pi, and composes browser + side panel into one picture,
 * because the side panel itself cannot be captured together with the page in headless Chrome.
 */
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { autoDecide, launch, openPanel, pairViaPanel, ROOT, tabIdOf, type Env } from "./helpers";

test.skip(process.env.MAKE_ASSETS !== "1", "set MAKE_ASSETS=1 to regenerate docs/images");
const OUT = path.join(ROOT, "docs/images");

let env: Env;
let page: Page;
let panel: Page;
let tabId: number;
const txt = (r: any) => env.pi.text(r);

test.beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  env = await launch({ settings: { permissionMode: "ask", allowedDomains: ["localhost"] } });
  page = await env.ctx.newPage();
  await page.setViewportSize({ width: 880, height: 800 });
  await page.goto(`${env.site.a}/demo.html`);
  tabId = await tabIdOf(env, page);
  panel = await openPanel(env, tabId);
  await panel.setViewportSize({ width: 400, height: 800 });
  await pairViaPanel(env, panel);
  await panel.getByTestId("input").fill("Book a table for two on Friday at 19:00 under the name Ada Lovelace.");
  await panel.getByTestId("send").click();
  await page.bringToFront();
});
test.afterAll(async () => env?.close());

async function compose(name: string, size = { width: 1280, height: 800 }) {
  const left = (await page.screenshot()).toString("base64");
  const right = (await panel.screenshot()).toString("base64");
  const c = await env.ctx.newPage();
  await c.setViewportSize(size);
  await c.waitForTimeout(200);
  await c.setContent(`<body style="margin:0;display:flex;background:#222;width:${size.width}px;height:${size.height}px"><img style="width:880px;height:800px" src="data:image/png;base64,${left}"><div style="width:2px;background:#000"></div><img style="width:398px;height:800px" src="data:image/png;base64,${right}"></body>`);
  await c.waitForTimeout(400); // let the window settle after the viewport change
  await c.screenshot({ path: path.join(OUT, name) });
  await c.close();
  await page.bringToFront();
}

test("capture", async () => {
  env.pi.emit({ type: "run_state", state: "started" });
  const stop = autoDecide(panel, "always");
  let r = await env.pi.tool("read_page", { tabId, filter: "interactive" });
  const tree = txt(r);
  const ref = (re: RegExp) => re.exec(tree)![1];
  r = await env.pi.tool("browser_batch", {
    tabId,
    actions: [
      { name: "form_input", input: { ref: ref(/textbox "Your name" \[(ref_\d+)\]/), value: "Ada Lovelace" } },
      { name: "form_input", input: { ref: ref(/combobox "Time" \[(ref_\d+)\]/), value: "19:00" } },
      { name: "form_input", input: { ref: ref(/combobox "Guests" \[(ref_\d+)\]/), value: "2" } },
      { name: "form_input", input: { ref: ref(/textbox "you@example.com" \[(ref_\d+)\]/), value: "ada@example.com" } },
    ],
  });
  expect(r.ok, txt(r)).toBe(true);
  await env.pi.tool("computer", { action: "screenshot", tabId });
  stop();
  for (const part of ["I filled in the form: ", "**Ada Lovelace**, ", "two guests, **19:00**. ", "Shall I press *Reserve table*?"]) env.pi.emit({ type: "assistant_delta", text: part });
  env.pi.emit({ type: "assistant_message", text: "I filled in the form: **Ada Lovelace**, two guests, **19:00**.\n\nShall I press *Reserve table*? Reservations are binding, so I'm asking first." });
  await page.waitForTimeout(600);
  await compose("store-1-working.png");
  await compose("gallery.png");

  // 2: the approval dialog
  env.pi.emit({ type: "run_state", state: "settled" });
  await env.sw.evaluate(() => chrome.storage.local.set({ grants: [] }));
  const pending = env.pi.tool("computer", { action: "left_click", coordinate: [440, 560], tabId }, { deadlineMs: 20000 }).catch(() => null);
  await panel.getByTestId("approval").waitFor();
  await compose("store-2-approval.png");
  await panel.getByTestId("deny").click();
  await pending;

  // 3: settings
  const opt = await env.ctx.newPage();
  await opt.setViewportSize({ width: 1280, height: 800 });
  await opt.goto(`chrome-extension://${env.extId}/options.html`);
  await opt.waitForTimeout(500);
  await opt.screenshot({ path: path.join(OUT, "store-3-settings.png") });
  await opt.close();

  // small promo tile 440x280
  const p = await env.ctx.newPage();
  await p.setViewportSize({ width: 440, height: 280 });
  const icon = fs.readFileSync(path.join(ROOT, "extension/public/icons/icon-128.png")).toString("base64");
  await p.setContent(`<body style="margin:0;width:440px;height:280px;background:linear-gradient(135deg,#23463a,#16302a);color:#fff;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center"><img width="84" src="data:image/png;base64,${icon}"><div style="font-size:30px;font-weight:700">Browser Agent</div><div style="font-size:16px;opacity:.85;max-width:340px">Your local pi agent, working in your browser</div></body>`);
  await p.screenshot({ path: path.join(OUT, "store-promo-small.png") });
  await p.close();
  expect(fs.existsSync(path.join(OUT, "gallery.png"))).toBe(true);
});
