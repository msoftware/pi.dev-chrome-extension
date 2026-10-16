import { expect, test, type Page } from "@playwright/test";
import { launch, openPanel, pairViaPanel, tabIdOf, expectEventually, type Env } from "./helpers";

let env: Env;
let panel: Page;
let page: Page;

test.beforeAll(async () => {
  env = await launch({ settings: { permissionMode: "auto", allowedDomains: ["localhost"] } });
  page = await env.ctx.newPage();
  await page.goto(`${env.site.a}/index.html`);
  const tabId = await tabIdOf(env, page);
  panel = await openPanel(env, tabId);
  await pairViaPanel(env, panel);
});
test.afterAll(async () => env?.close());

test("UI-16: the element picker attaches selector, text and an outline to the next prompt", async () => {
  await page.bringToFront();
  await panel.getByRole("button", { name: /Pick an element|Element auf der Seite/ }).click();
  await expect(page.locator("div[style*='cursor: crosshair']")).toHaveCount(1); // overlay host
  const box = (await page.locator("#btn").boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.click(box.x + 5, box.y + 5);
  await expect(panel.locator(".chips li")).toContainText("#btn");
  await panel.getByTestId("input").fill("what does this do?");
  await panel.getByTestId("send").click();
  await expectEventually(() => env.pi.prompts.length > 0);
  const text = env.pi.prompts[0].text as string;
  expect(text).toContain("Selected element: #btn");
  expect(text).toContain("Increment");
  expect(text).toMatch(/button "Increment" \[ref_\d+\]/); // accessibility outline of the element
});

test("UI-16: the area picker attaches an image cut out of the page", async () => {
  await page.bringToFront();
  await panel.getByRole("button", { name: /Select an area|Bereich der Seite/ }).click();
  await page.mouse.move(20, 20);
  await page.mouse.down();
  await page.mouse.move(320, 170, { steps: 5 });
  await page.mouse.up();
  await expect(panel.locator(".chips li img")).toBeVisible({ timeout: 8000 });
  const n = env.pi.prompts.length;
  await panel.getByTestId("input").fill("describe this area");
  await panel.getByTestId("send").click();
  await expectEventually(() => env.pi.prompts.length > n);
  const sent = env.pi.prompts[n];
  expect(sent.attachments).toHaveLength(1);
  expect(sent.attachments[0].mimeType).toBe("image/jpeg");
  expect(sent.attachments[0].data.length).toBeGreaterThan(500);
  expect(sent.text).toMatch(/image id ss_[a-z0-9]{9}/); // the model can refer to it with upload_image
});

test("Escape cancels a picker without attaching anything", async () => {
  await page.bringToFront();
  await panel.getByRole("button", { name: /Select an area|Bereich der Seite/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator("div[style*='cursor: crosshair']")).toHaveCount(0);
});

test("status bar after a run; Hide keeps it away for the group until a new task starts (section 12, IND-03)", async () => {
  const { PNG } = await import("pngjs");
  const dark = async () => {
    const png = PNG.sync.read(await page.screenshot({ clip: { x: 432, y: 766, width: 1, height: 1 } }));
    return png.data[0] < 80; // the bar is near-black, the page white
  };
  await panel.getByTestId("input").fill("start the session group"); // the first prompt creates the tab group
  await panel.getByTestId("send").click();
  await page.bringToFront();
  env.pi.emit({ type: "run_state", state: "started" });
  await new Promise((r) => setTimeout(r, 400));
  env.pi.emit({ type: "run_state", state: "settled" });
  await expectEventually(dark, 6000, "status bar visible");
  await page.mouse.click(745, 766); // "Hide"
  await expectEventually(async () => !(await dark()), 4000, "status bar hidden");
  env.pi.emit({ type: "run_state", state: "started" }); // a new task: indicators come back, then the bar
  await new Promise((r) => setTimeout(r, 400));
  env.pi.emit({ type: "run_state", state: "settled" });
  await expectEventually(dark, 6000, "status bar visible again");
});
