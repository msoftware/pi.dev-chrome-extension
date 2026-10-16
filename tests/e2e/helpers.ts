import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeServer } from "../../packages/bridge/src/server";
import { TokenStore } from "../../packages/bridge/src/token-store";
import { Logger } from "../../packages/bridge/src/logger";
import { EXTENSION_ID, type BridgeEvent, type ToolResult } from "@pi-browser/shared";

export const ROOT = path.resolve(__dirname, "../..");
export const DIST = path.join(ROOT, "extension/dist");

// ---- fixture website ------------------------------------------------------------------------------------------------------

export interface Site {
  port: number;
  /** http://localhost:port */
  a: string;
  /** http://127.0.0.1:port: a different registrable domain */
  b: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".txt": "text/plain" };

export async function startSite(): Promise<Site> {
  const dir = path.join(__dirname, "fixtures");
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let file: string | null = null;
    if (url.pathname === "/vendor/react.js") file = path.join(ROOT, "node_modules/react/umd/react.development.js");
    else if (url.pathname === "/vendor/react-dom.js") file = path.join(ROOT, "node_modules/react-dom/umd/react-dom.development.js");
    else if (url.pathname === "/big") {
      res.writeHead(200, { "Content-Type": "text/html" });
      const items = Array.from({ length: 12000 }, (_, i) => `<li><a href="#i${i}">Item ${i}</a></li>`).join("");
      res.end(`<!doctype html><title>Big</title><h1>Big list</h1><ul>${items}</ul>`);
      return;
    } else if (url.pathname === "/n") {
      res.writeHead(200, { "Content-Type": "text/html" });
      const n = Number(url.searchParams.get("count") ?? "2500");
      const items = Array.from({ length: n }, (_, i) => `<li><a href="#i${i}">Item ${i}</a></li>`).join("");
      res.end(`<!doctype html><title>N</title><h1>N list</h1><ul>${items}</ul>`);
      return;
    } else if (url.pathname === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html><title>Slow</title><h1>Slow</h1>");
      }, 800);
      return;
    } else file = path.join(dir, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    if (!file.startsWith(dir) && !file.includes("node_modules")) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file!)] ?? "application/octet-stream" });
      res.end(data);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  return { port, a: `http://localhost:${port}`, b: `http://127.0.0.1:${port}`, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))) };
}

// ---- fake pi -----------------------------------------------------------------------------------------------------------------------

export class FakePi {
  server!: BridgeServer;
  tokens!: TokenStore;
  prompts: any[] = [];
  steers: any[] = [];
  aborts = 0;
  config: any[] = [];
  reviews: any[] = [];
  reviewVerdict: { allow: boolean; reason?: string } = { allow: true };
  progress: any[] = [];
  private tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fakepi-"));
  private n = 0;
  sessionId = "s_test";

  async start(port = 0) {
    this.tokens = new TokenStore(path.join(this.tmp, "tokens.json"));
    this.server = new BridgeServer({
      port,
      extensionId: EXTENSION_ID,
      tokens: this.tokens,
      log: new Logger(false),
      heartbeatMs: 1000,
      handlers: {
        health: () => ({ bridgeVersion: "test", piVersion: "test", model: "fake/model", sessionId: this.sessionId }),
        prompt: async (b) => void this.prompts.push(b),
        steer: async (b) => void this.steers.push(b),
        abort: async () => void this.aborts++,
        listSessions: async () => [{ id: this.sessionId, name: "Current", updatedAt: Date.now() }, { id: "old1", name: "Earlier chat", updatedAt: Date.now() - 1e6 }],
        newSession: async () => ({ id: "new" }),
        sessionMessages: async (id) => (id === "old1" ? [{ role: "user", text: "old question" }, { role: "assistant", text: "old answer", tools: [] }] : []),
        models: async () => ({ models: [{ id: "fake/model", provider: "fake", name: "Fake", reasoning: false }, { id: "fake/two", provider: "fake", name: "Two", reasoning: true }], thinkingLevels: ["off", "low", "high"], current: { model: "fake/model", thinkingLevel: "off" } }),
        setConfig: async (b) => void this.config.push(b),
        toolProgress: (p) => void this.progress.push(p),
        find: async () => ({ matches: [] }),
        review: async (r) => (this.reviews.push(r), this.reviewVerdict),
        onClientConnected: () => {},
      },
    });
    await this.server.start();
    return this.server.port;
  }

  async stop() {
    await this.server.stop();
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }

  emit(e: BridgeEvent) {
    this.server.emit(e);
  }

  /** Runs a tool like pi would and returns the extension's result. */
  async tool(tool: string, args: Record<string, unknown> = {}, opts: { deadlineMs?: number; signal?: AbortSignal } = {}): Promise<ToolResult> {
    const id = `req_${++this.n}`;
    return this.server.requestTool({ requestId: id, toolCallId: `call_${this.n}`, tool, args, sessionId: this.sessionId, deadlineMs: opts.deadlineMs ?? 30_000 }, opts.signal);
  }
  text(r: ToolResult): string {
    return r.content.filter((c) => c.type === "text").map((c) => (c as any).text).join("\n");
  }
  images(r: ToolResult) {
    return r.content.filter((c) => c.type === "image");
  }
}

// ---- browser with the extension ---------------------------------------------------------------------------------------------------

export interface Env {
  ctx: BrowserContext;
  sw: Worker;
  extId: string;
  site: Site;
  pi: FakePi;
  userDir: string;
  close(): Promise<void>;
}

export async function launch(opts: { dsf?: number; settings?: Record<string, unknown>; pair?: boolean } = {}): Promise<Env> {
  if (!fs.existsSync(path.join(DIST, "manifest.json"))) throw new Error("Build the extension first: npm run build");
  const site = await startSite();
  const pi = new FakePi();
  const port = await pi.start();
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-user-"));
  const ctx = await chromium.launchPersistentContext(userDir, {
    executablePath: process.env.CHROME_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined),
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, "--disable-features=DisableLoadExtensionCommandLineSwitch", "--headless=new", "--no-sandbox", "--force-device-scale-factor=" + (opts.dsf ?? 1), "--window-size=1280,900"],
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: opts.dsf ?? 1,
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const extId = new URL(sw.url()).host;
  // the worker object can appear a moment before the chrome.* APIs are bound
  for (let i = 0; i < 50; i++) {
    const ready = await sw.evaluate(() => typeof chrome !== "undefined" && !!chrome.storage?.local && !!chrome.tabs).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  // settings: port + test defaults
  await sw.evaluate(
    async ([p, s]) => {
      await chrome.storage.local.set({ settings: { port: p, ...(s as object) } });
    },
    [port, opts.settings ?? {}] as const,
  );
  const env: Env = {
    ctx,
    sw,
    extId,
    site,
    pi,
    userDir,
    close: async () => {
      await ctx.close().catch(() => {});
      await pi.stop();
      await site.close();
      fs.rmSync(userDir, { recursive: true, force: true });
    },
  };
  return env;
}

/** Opens the side panel page for a given tab (as a normal tab, which is enough for the port protocol). */
export async function openPanel(env: Env, tabId: number): Promise<Page> {
  const p = await env.ctx.newPage();
  await p.goto(`chrome-extension://${env.extId}/sidepanel.html?tabId=${tabId}`);
  return p;
}

export async function tabIdOf(env: Env, page: Page): Promise<number> {
  const url = page.url();
  return env.sw.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url === u);
    return t!.id!;
  }, url);
}

export async function pairViaPanel(env: Env, panel: Page) {
  const { code } = env.pi.tokens.createPairingCode();
  await panel.getByTestId("pair-input").fill(code);
  await panel.getByRole("button", { name: /^(Pair|Koppeln)$/ }).click();
  await panel.getByTestId("status").filter({ hasText: /Connected|Verbunden/ }).waitFor({ timeout: 15_000 });
}

/** Creates the agent group for a tab by sending a prompt from the panel; returns the group's tab id. */
export async function startSession(env: Env, page: Page, panel: Page, text = "hello") {
  await panel.getByTestId("input").fill(text);
  await panel.getByTestId("send").click();
  await expectEventually(() => env.pi.prompts.length > 0);
}

export async function expectEventually(fn: () => boolean | Promise<boolean>, ms = 10_000, label = "condition") {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** Clicks Allow/Deny in the panel whenever an approval dialog appears. */
export function autoDecide(panel: Page, decision: "once" | "always" | "deny", log: { domain: string; tool: string; preview: string }[] = []) {
  let stop = false;
  (async () => {
    while (!stop) {
      try {
        const d = panel.getByTestId("approval").first();
        if (await d.isVisible({ timeout: 200 }).catch(() => false)) {
          log.push({ domain: (await panel.getByTestId("approval-domain").first().textContent().catch(() => "")) ?? "", tool: (await d.textContent()) ?? "", preview: (await panel.getByTestId("approval-preview").first().textContent().catch(() => "")) ?? "" });
          await panel.getByTestId(decision === "once" ? "allow-once" : decision === "always" ? "allow-always" : "deny").first().click({ timeout: 2000 });
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
  return () => {
    stop = true;
  };
}
