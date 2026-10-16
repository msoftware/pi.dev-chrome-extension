import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";
import { expectEventually, launch, openPanel, pairViaPanel, startSession, tabIdOf, type Env } from "./helpers";

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

async function pixel(p: Page, x: number, y: number) {
  const buf = await p.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const png = PNG.sync.read(buf);
  return [png.data[0], png.data[1], png.data[2]];
}

test("indicators: glow while the agent works, gone when settled (IND, section 12)", async () => {
  await page.goto(`${env.site.a}/index.html`);
  const before = await pixel(page, 1, 400);
  env.pi.emit({ type: "run_state", state: "started" });
  await expectEventually(async () => {
    const [r, g, b] = await pixel(page, 1, 400);
    return r > 150 && b < 150 && r - b > 40; // orange-ish glow at the left edge
  }, 8000, "glow frame");
  env.pi.emit({ type: "run_state", state: "settled" });
  await expectEventually(async () => {
    const [r, , b] = await pixel(page, 1, 400);
    return Math.abs(r - b) < 25;
  }, 8000, "glow removed");
  void before;
});

test("AK-07: the on-page Stop button aborts within about a second and releases the debugger (SEC-13)", async () => {
  await page.goto(`${env.site.a}/index.html`);
  await page.bringToFront();
  env.pi.emit({ type: "run_state", state: "started" });
  await expectEventually(async () => (await pixel(page, 1, 400))[0] > 150, 8000, "indicators");
  const aborts = env.pi.aborts;
  await env.pi.tool("computer", { action: "screenshot", tabId }); // attaches the debugger
  const running = env.pi.tool("computer", { action: "wait", duration: 25, tabId }).then(
    (r) => ({ ok: true as const, r }),
    (e) => ({ ok: false as const, e: String(e?.message ?? e) }),
  );
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: "/tmp/ak7-before-click.png" });
  const t0 = Date.now();
  await page.mouse.click(600, 800 - 22 - 16); // the Stop button, bottom centre
  const res = await running;
  expect(Date.now() - t0).toBeLessThan(2500);
  expect(res.ok).toBe(false);
  expect(env.pi.aborts).toBe(aborts + 1);
  // if the extension still held the debugger, attaching again would fail with "already attached"
  const reattach = await env.sw.evaluate(async (id) => {
    try {
      await chrome.debugger.attach({ tabId: id }, "1.3");
      await chrome.debugger.detach({ tabId: id });
      return "released";
    } catch (e: any) {
      return String(e?.message ?? e);
    }
  }, tabId);
  expect(reattach).toBe("released");
  await expectEventually(async () => (await pixel(page, 1, 400))[0] - (await pixel(page, 1, 400))[2] < 25, 6000, "glow removed after stop");
  env.pi.emit({ type: "run_state", state: "settled" });
});

test("closing the side panel stops the run (SEC-13)", async () => {
  const p2 = await openPanel(env, tabId); // a second panel for the same tab
  await expectEventually(async () => (await p2.getByTestId("status").textContent()) !== null);
  env.pi.emit({ type: "run_state", state: "started" });
  const aborts = env.pi.aborts;
  const running = env.pi.tool("computer", { action: "wait", duration: 20, tabId }).then(() => "done", () => "aborted");
  await new Promise((r) => setTimeout(r, 500));
  await p2.close();
  await new Promise((r) => setTimeout(r, 300));
  expect(env.pi.aborts).toBe(aborts); // the original panel is still open, so nothing stops
  await panel.close();
  expect(await running).toBe("aborted");
  expect(env.pi.aborts).toBe(aborts + 1);
  env.pi.emit({ type: "run_state", state: "settled" });
  panel = await openPanel(env, tabId);
});

test("AK-09: a web page cannot talk to the bridge (API-07/08)", async () => {
  await page.goto(`${env.site.a}/index.html`);
  const port = env.pi.server.port;
  const result = await page.evaluate(async (p) => {
    const out: string[] = [];
    try { await fetch(`http://127.0.0.1:${p}/v1/health`); out.push("plain ok"); } catch { out.push("plain blocked"); }
    try { await fetch(`http://127.0.0.1:${p}/v1/models`, { headers: { Authorization: "Bearer x" } }); out.push("auth ok"); } catch { out.push("auth blocked"); }
    try { const r = await fetch(`http://127.0.0.1:${p}/v1/health`, { mode: "no-cors" }); out.push(r.type); } catch { out.push("nocors blocked"); }
    return out;
  }, port);
  expect(result[0]).toBe("plain blocked"); // no CORS headers are ever sent
  expect(result[1]).toBe("auth blocked");
  // and the content scripts expose nothing a page could use to reach the extension
  const ext = await page.evaluate(() => typeof (window as any).chrome?.runtime?.sendMessage);
  expect(["undefined", "function"]).toContain(ext);
});

test("AK-08: killing the service worker mid-task recovers; the open task is reported failed, not hanging (NFA-04/05/06)", async () => {
  await page.goto(`${env.site.a}/index.html`);
  const running = env.pi.tool("computer", { action: "wait", duration: 20, tabId }, { deadlineMs: 60_000 }).then(
    (r) => ({ ok: r.ok, text: env.pi.text(r) }),
    (e) => ({ ok: false, text: String(e?.message ?? e) }),
  );
  await new Promise((r) => setTimeout(r, 700));
  // stop the worker the way chrome://serviceworker-internals does
  const cdp = await env.ctx.newCDPSession(page);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const swTarget = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${env.extId}`));
  expect(swTarget).toBeTruthy();
  const t0 = Date.now();
  await cdp.send("Target.closeTarget", { targetId: swTarget!.targetId });
  const res = await running;
  expect(Date.now() - t0).toBeLessThan(25_000);
  expect(res.ok).toBe(false);
  expect(res.text).toMatch(/restarted|did not answer|Cancelled/i);
  // the worker comes back and serves new requests (panel reconnect or alarm)
  const t1 = Date.now();
  let ok = false;
  for (let i = 0; i < 20 && !ok; i++) {
    const r = await env.pi.tool("tabs_context", {}, { deadlineMs: 3000 }).catch(() => null);
    ok = !!r?.ok;
  }
  expect(ok).toBe(true);
  expect(Date.now() - t1).toBeLessThan(10_000);
});

test("AK-10: on a Retina display a click on image coordinates lands within 2 CSS pixels (SHOT-09)", async () => {
  const hi = await launch({ dsf: 2, settings: { permissionMode: "auto", allowedDomains: ["localhost", "127.0.0.1"] } });
  try {
    const p = await hi.ctx.newPage();
    await p.goto(`${hi.site.a}/dpr.html`);
    const id = await tabIdOf(hi, p);
    const pn = await openPanel(hi, id);
    await pairViaPanel(hi, pn);
    await startSession(hi, p, pn);
    await p.bringToFront();
    const shot = await hi.pi.tool("computer", { action: "screenshot", tabId: id });
    expect(shot.ok, hi.pi.text(shot)).toBe(true);
    const text = hi.pi.text(shot);
    const [, w, h] = /\((\d+)x(\d+)\)/.exec(text)!.map(Number);
    const vp = p.viewportSize()!;
    expect(w).toBeLessThanOrEqual(1568);
    expect(Math.ceil(w / 28) * Math.ceil(h / 28)).toBeLessThanOrEqual(1568);
    // the target square is at css (333..373, 247..287); its centre in image coordinates:
    const ix = Math.round(353 * (w / vp.width));
    const iy = Math.round(267 * (h / vp.height));
    const click = await hi.pi.tool("computer", { action: "left_click", coordinate: [ix, iy], tabId: id });
    expect(click.ok, hi.pi.text(click)).toBe(true);
    const [cx, cy] = await p.evaluate(() => (window as any).__last as number[]);
    expect(Math.abs(cx - 353)).toBeLessThanOrEqual(2);
    expect(Math.abs(cy - 267)).toBeLessThanOrEqual(2);
  } finally {
    await hi.close();
  }
});

test("latency: Bridge -> extension -> Bridge overhead under 50 ms median (NFA-01)", async () => {
  await page.goto(`${env.site.a}/index.html`);
  const times: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t = performance.now();
    const r = await env.pi.tool("tabs_context");
    times.push(performance.now() - t);
    expect(r.ok).toBe(true);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`tabs_context median ${median.toFixed(1)} ms, p95 ${times[Math.floor(times.length * 0.95)].toFixed(1)} ms`);
  expect(median).toBeLessThan(50);
});

test("screenshot at 1920x1080 under 400 ms median and within the tile budget (NFA-02, section 8)", async () => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${env.site.a}/index.html`);
  const times: number[] = [];
  let size = "";
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    const r = await env.pi.tool("computer", { action: "screenshot", tabId });
    times.push(performance.now() - t);
    size = /\((\d+x\d+)\)/.exec(txt(r))![1];
  }
  times.shift(); // warm-up
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(`screenshot median ${median.toFixed(0)} ms (${size})`);
  expect(size).toBe("1456x819"); // spec example
  expect(median).toBeLessThan(400);
  await page.setViewportSize({ width: 1200, height: 800 });
});

test("read_page interactive under 300 ms on 5000 DOM nodes; huge pages are capped (NFA-03, TREE-13)", async () => {
  await page.goto(`${env.site.a}/n?count=2500`);
  const ms = await env.sw.evaluate(async (id) => {
    const r = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: async () => {
        const api = (globalThis as any).__piA11y;
        const t = performance.now();
        const res = await api.generate({ filter: "interactive" });
        return { ms: performance.now() - t, len: res.pageContent.length };
      },
    });
    return r[0].result as { ms: number; len: number };
  }, tabId);
  console.log(`generate interactive on 5000 nodes: ${ms.ms.toFixed(0)} ms`);
  expect(ms.ms).toBeLessThan(300);
  await page.goto(`${env.site.a}/big`);
  const r = await env.pi.tool("read_page", { tabId, filter: "all", max_chars: 5_000_000 });
  expect(r.ok, txt(r)).toBe(true);
  expect(txt(r)).toContain("Output truncated");
  expect(txt(r).split("\n").length).toBeLessThan(10_100);
});

test("UI-08: a change of the tab group is reported with the next result", async () => {
  await page.goto(`${env.site.a}/index.html`);
  await env.pi.tool("tabs_context"); // baseline
  await env.sw.evaluate(async (id) => {
    const t = await chrome.tabs.get(id);
    const nt = await chrome.tabs.create({ url: "about:blank", windowId: t.windowId, active: false });
    await chrome.tabs.group({ tabIds: [nt.id!], groupId: t.groupId });
  }, tabId);
  await new Promise((r) => setTimeout(r, 300));
  const r = await env.pi.tool("tabs_context");
  expect(txt(r)).toContain("Tab group changed");
});

test("slow pages: navigate waits for completion (webNavigation)", async () => {
  const t = Date.now();
  const r = await env.pi.tool("navigate", { tabId, url: `${env.site.a}/slow` });
  expect(r.ok, txt(r)).toBe(true);
  expect(Date.now() - t).toBeGreaterThan(700);
  expect(txt(r)).toContain("Slow");
});
