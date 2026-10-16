import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { BridgeServer } from "../../packages/bridge/src/server";
import { TokenStore } from "../../packages/bridge/src/token-store";
import { Logger } from "../../packages/bridge/src/logger";
import { EXTENSION_ID } from "@pi-browser/shared";

let server: BridgeServer;
let tokens: TokenStore;
let tmp: string;
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

function req(method: string, p: string, opts: { headers?: Record<string, string>; body?: unknown; host?: string } = {}) {
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const r = http.request(
      { host: "127.0.0.1", port: server.port, path: p, method, headers: { ...(opts.host ? { Host: opts.host } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}), ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let body: any;
          try { body = JSON.parse(text); } catch { body = undefined; }
          resolve({ status: res.statusCode!, body, text });
        });
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function pair(): Promise<string> {
  const { code } = tokens.createPairingCode();
  const r = await req("POST", "/v1/pair", { headers: { Origin: ORIGIN }, body: { code, label: "t" } });
  expect(r.status).toBe(200);
  return r.body.token;
}

function openSse(token: string, lastId?: number) {
  const events: { id: number; event: string; data: any }[] = [];
  const r = http.request({ host: "127.0.0.1", port: server.port, path: "/v1/events", headers: { Authorization: `Bearer ${token}`, Origin: ORIGIN, ...(lastId !== undefined ? { "Last-Event-ID": String(lastId) } : {}) } });
  let buf = "";
  r.on("response", (res) => {
    res.setEncoding("utf8");
    res.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /id: (\d+)\nevent: (\S+)\ndata: (.*)/.exec(block);
        if (m) events.push({ id: +m[1], event: m[2], data: JSON.parse(m[3]) });
      }
    });
  });
  r.end();
  return { events, close: () => r.destroy() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 2000) {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout");
    await sleep(10);
  }
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-"));
  tokens = new TokenStore(path.join(tmp, "tokens.json"));
  server = new BridgeServer({
    port: 0,
    extensionId: EXTENSION_ID,
    tokens,
    log: new Logger(false),
    heartbeatMs: 50,
    handlers: {
      health: () => ({ bridgeVersion: "t", piVersion: "t", model: "m/x", sessionId: "s1" }),
      prompt: async () => {}, steer: async () => {}, abort: async () => {},
      listSessions: async () => [], newSession: async () => ({ id: "n" }), sessionMessages: async () => [],
      models: async () => ({ models: [], thinkingLevels: [], current: { model: null, thinkingLevel: "off" } }),
      setConfig: async () => {}, toolProgress: () => {}, onClientConnected: () => {},
    },
  });
  await server.start();
});
afterEach(async () => {
  await server.stop();
  await server.stop(); // idempotent (API-03)
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("bridge security (API-06..08)", () => {
  it("health needs no token", async () => {
    const r = await req("GET", "/v1/health", { headers: { Origin: ORIGIN } });
    expect(r.status).toBe(200);
    expect(r.body.paired).toBe(false);
  });
  it("401 without or with wrong token", async () => {
    expect((await req("GET", "/v1/models", { headers: { Origin: ORIGIN } })).status).toBe(401);
    expect((await req("GET", "/v1/models", { headers: { Origin: ORIGIN, Authorization: "Bearer nope" } })).status).toBe(401);
  });
  it("403 for foreign origin (AK-09) and no CORS headers", async () => {
    const r = await req("GET", "/v1/health", { headers: { Origin: "https://evil.example" } });
    expect(r.status).toBe(403);
  });
  it("403 for DNS-rebinding host", async () => {
    const r = await req("GET", "/v1/health", { host: `evil.example:${server.port}`, headers: { Origin: ORIGIN } });
    expect(r.status).toBe(403);
  });
  it("localhost host is accepted", async () => {
    const r = await req("GET", "/v1/health", { host: `localhost:${server.port}`, headers: { Origin: ORIGIN } });
    expect(r.status).toBe(200);
  });
  it("pairing needs origin; code is single-use; token works", async () => {
    const { code } = tokens.createPairingCode();
    expect((await req("POST", "/v1/pair", { body: { code } })).status).toBe(403);
    const ok = await req("POST", "/v1/pair", { headers: { Origin: ORIGIN }, body: { code, label: "x" } });
    expect(ok.status).toBe(200);
    expect(Buffer.from(ok.body.token, "base64url")).toHaveLength(32);
    expect((await req("POST", "/v1/pair", { headers: { Origin: ORIGIN }, body: { code } })).status).toBe(401);
    expect((await req("GET", "/v1/models", { headers: { Origin: ORIGIN, Authorization: `Bearer ${ok.body.token}` } })).status).toBe(200);
  });
  it("code burns after 5 wrong attempts", async () => {
    tokens.createPairingCode();
    for (let i = 0; i < 5; i++) await req("POST", "/v1/pair", { headers: { Origin: ORIGIN }, body: { code: "000000x" } });
    expect(tokens.activeCode()).toBeNull();
  });
  it("revoked token stops working (API-09)", async () => {
    const t = await pair();
    tokens.revoke();
    expect((await req("GET", "/v1/models", { headers: { Origin: ORIGIN, Authorization: `Bearer ${t}` } })).status).toBe(401);
  });
});

describe("events and tool round-trip (API-10/11)", () => {
  it("streams hello, requests, heartbeat; result resolves; duplicate ignored", async () => {
    const t = await pair();
    const sse = openSse(t);
    await until(() => sse.events.some((e) => e.event === "hello"));
    const p = server.requestTool({ requestId: "r1", toolCallId: "c1", tool: "computer", args: { action: "screenshot" }, sessionId: "s1", deadlineMs: 5000 });
    await until(() => sse.events.some((e) => e.event === "tool_request"));
    const auth = { Origin: ORIGIN, Authorization: `Bearer ${t}` };
    const post = await req("POST", "/v1/tool-results", { headers: auth, body: { requestId: "r1", ok: true, content: [{ type: "text", text: "hi" }] } });
    expect(post.status).toBe(200);
    expect((await p).content[0]).toEqual({ type: "text", text: "hi" });
    const dup = await req("POST", "/v1/tool-results", { headers: auth, body: { requestId: "r1", ok: true, content: [] } });
    expect(dup.body.duplicate).toBe(true);
    await until(() => sse.events.some((e) => e.event === "heartbeat"));
    const ids = sse.events.map((e) => e.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    sse.close();
  });
  it("replays missed events after reconnect with Last-Event-ID", async () => {
    const t = await pair();
    const a = openSse(t);
    await until(() => a.events.length > 0);
    const lastId = a.events[a.events.length - 1].id;
    a.close();
    await sleep(50);
    server.emit({ type: "assistant_delta", text: "missed" });
    const b = openSse(t, lastId);
    await until(() => b.events.some((e) => e.event === "assistant_delta"));
    expect(b.events.find((e) => e.event === "assistant_delta")!.data.text).toBe("missed");
    b.close();
  });
  it("times out and emits tool_cancel", async () => {
    const t = await pair();
    const sse = openSse(t);
    await until(() => sse.events.length > 0);
    await expect(server.requestTool({ requestId: "r2", toolCallId: "c", tool: "x", args: {}, sessionId: "s", deadlineMs: 50 })).rejects.toThrow(/did not answer/);
    await until(() => sse.events.some((e) => e.event === "tool_cancel"));
    sse.close();
  });
  it("abort signal cancels", async () => {
    const ac = new AbortController();
    const p = server.requestTool({ requestId: "r3", toolCallId: "c", tool: "x", args: {}, sessionId: "s", deadlineMs: 5000 }, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow("Aborted");
  });
});
