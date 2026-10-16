import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  BRIDGE_VERSION,
  EVENT_BACKLOG_COUNT,
  EVENT_BACKLOG_MS,
  HEARTBEAT_MS,
  type BridgeEvent,
  type ConfigBody,
  type HealthResponse,
  type ModelsResponse,
  type PromptBody,
  type SequencedEvent,
  type SessionSummary,
  type ToolProgress,
  type ToolResult,
} from "@pi-browser/shared";
import type { Logger } from "./logger";
import type { TokenStore } from "./token-store";

export interface BridgeHandlers {
  health(): Omit<HealthResponse, "paired">;
  prompt(body: PromptBody): Promise<void>;
  steer(body: PromptBody): Promise<void>;
  abort(): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  newSession(): Promise<{ id: string }>;
  sessionMessages(id: string): Promise<unknown[]>;
  models(): Promise<ModelsResponse>;
  setConfig(body: ConfigBody): Promise<void>;
  toolProgress(p: ToolProgress): void;
  /** Called when a client (re)connects to the event stream. */
  onClientConnected(): void;
}

export interface ServerOptions {
  port: number;
  extensionId: string;
  tokens: TokenStore;
  handlers: BridgeHandlers;
  log: Logger;
  heartbeatMs?: number;
}

interface Client {
  deviceId: string;
  res: http.ServerResponse;
}

interface Pending {
  resolve(r: ToolResult): void;
  reject(e: Error): void;
  done: boolean;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MAX_BODY = 40 * 1024 * 1024;

export class BridgeServer {
  private server: http.Server | null = null;
  private seq = 0;
  private backlog: { id: number; at: number; event: BridgeEvent }[] = [];
  private clients = new Map<string, Client>();
  private pending = new Map<string, Pending>();
  private finished = new Set<string>();
  private hb: NodeJS.Timeout | null = null;
  private _port: number;

  constructor(private opts: ServerOptions) {
    this._port = opts.port;
  }

  get port(): number {
    return this._port;
  }
  get connected(): boolean {
    return this.clients.size > 0;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        const status = e instanceof HttpError ? e.status : 500;
        this.opts.log.debug("request error", { url: req.url, status, msg: String(e?.message ?? e) });
        if (!res.headersSent) json(res, status, { error: String(e?.message ?? e) });
        else res.end();
      });
    });
    server.requestTimeout = 0;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this._port = (server.address() as AddressInfo).port;
    this.server = server;
    this.hb = setInterval(() => this.emit({ type: "heartbeat" }), this.opts.heartbeatMs ?? HEARTBEAT_MS);
    this.hb.unref();
  }

  /** Idempotent (API-03). */
  async stop(): Promise<void> {
    if (this.hb) clearInterval(this.hb);
    this.hb = null;
    for (const p of this.pending.values()) {
      if (!p.done) {
        p.done = true;
        p.reject(new Error("Bridge shut down"));
      }
    }
    this.pending.clear();
    for (const c of this.clients.values()) c.res.end();
    this.clients.clear();
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }

  /** Publishes an event to the stream and backlog. */
  emit(event: BridgeEvent): number {
    const id = ++this.seq;
    const now = Date.now();
    if (event.type !== "heartbeat") {
      this.backlog.push({ id, at: now, event });
      this.trim(now);
    }
    for (const c of this.clients.values()) writeEvent(c.res, id, event);
    return id;
  }

  private trim(now: number) {
    while (this.backlog.length > EVENT_BACKLOG_COUNT || (this.backlog[0] && now - this.backlog[0].at > EVENT_BACKLOG_MS)) {
      this.backlog.shift();
    }
  }

  /** Sends a tool request and waits for its result, a cancel, or the deadline (API-11). */
  requestTool(req: import("@pi-browser/shared").ToolRequest, signal?: AbortSignal): Promise<ToolResult> {
    return new Promise<ToolResult>((resolve, reject) => {
      const p: Pending = { resolve, reject, done: false };
      this.pending.set(req.requestId, p);
      let timer: NodeJS.Timeout | undefined;
      const finish = (fn: () => void) => {
        if (p.done) return;
        p.done = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(req.requestId);
        this.finished.add(req.requestId);
        if (this.finished.size > 2000) this.finished.delete(this.finished.values().next().value as string);
        fn();
      };
      const onAbort = () => {
        this.emit({ type: "tool_cancel", requestId: req.requestId });
        finish(() => reject(new Error("Aborted")));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        this.emit({ type: "tool_cancel", requestId: req.requestId });
        finish(() => reject(new Error(`Browser did not answer within ${Math.round(req.deadlineMs / 1000)} s (tool ${req.tool})`)));
      }, req.deadlineMs);
      p.resolve = (r) => finish(() => resolve(r));
      this.emit({ type: "tool_request", request: req });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    this.checkHostAndOrigin(req, path);
    if (req.method === "OPTIONS") throw new HttpError(403, "CORS is not allowed");

    if (path === "/v1/health" && req.method === "GET") {
      const h = this.opts.handlers.health();
      return json(res, 200, { ...h, paired: this.opts.tokens.paired } satisfies HealthResponse);
    }
    if (path === "/v1/pair" && req.method === "POST") {
      const body = (await readJson(req)) as { code?: string; label?: string };
      const r = this.opts.tokens.redeem(String(body.code ?? ""), String(body.label ?? "Browser"));
      if (!r) throw new HttpError(401, "Invalid or expired pairing code");
      return json(res, 200, r);
    }

    const auth = req.headers.authorization ?? "";
    const m = /^Bearer (.+)$/.exec(auth);
    const deviceId = m ? this.opts.tokens.verify(m[1]) : null;
    if (!deviceId) throw new HttpError(401, "Missing or invalid bearer token");

    const h = this.opts.handlers;
    if (path === "/v1/events" && req.method === "GET") return this.openStream(req, res, deviceId);
    if (path === "/v1/prompt" && req.method === "POST") {
      await h.prompt((await readJson(req)) as PromptBody);
      return json(res, 202, { ok: true });
    }
    if (path === "/v1/steer" && req.method === "POST") {
      await h.steer((await readJson(req)) as PromptBody);
      return json(res, 202, { ok: true });
    }
    if (path === "/v1/abort" && req.method === "POST") {
      await h.abort();
      for (const [id, p] of [...this.pending]) {
        this.emit({ type: "tool_cancel", requestId: id });
        if (!p.done) {
          p.done = true;
          p.reject(new Error("Aborted"));
          this.pending.delete(id);
        }
      }
      return json(res, 200, { ok: true });
    }
    if (path === "/v1/tool-results" && req.method === "POST") {
      const r = (await readJson(req)) as ToolResult;
      if (!r || typeof r.requestId !== "string") throw new HttpError(400, "requestId missing");
      const p = this.pending.get(r.requestId);
      if (!p || p.done) {
        if (this.finished.has(r.requestId)) return json(res, 200, { ok: true, duplicate: true });
        throw new HttpError(404, "Unknown requestId");
      }
      p.resolve(r);
      return json(res, 200, { ok: true });
    }
    if (path === "/v1/tool-progress" && req.method === "POST") {
      h.toolProgress((await readJson(req)) as ToolProgress);
      return json(res, 200, { ok: true });
    }
    if (path === "/v1/sessions" && req.method === "GET") return json(res, 200, { sessions: await h.listSessions() });
    if (path === "/v1/sessions" && req.method === "POST") return json(res, 201, await h.newSession());
    const sm = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(path);
    if (sm && req.method === "GET") return json(res, 200, { messages: await h.sessionMessages(decodeURIComponent(sm[1])) });
    if (path === "/v1/models" && req.method === "GET") return json(res, 200, await h.models());
    if (path === "/v1/config" && req.method === "PUT") {
      await h.setConfig((await readJson(req)) as ConfigBody);
      return json(res, 200, { ok: true });
    }
    throw new HttpError(404, "Not found");
  }

  /** API-08: Origin must be the fixed extension, Host must be loopback with our port. */
  private checkHostAndOrigin(req: http.IncomingMessage, path: string) {
    const host = (req.headers.host ?? "").toLowerCase();
    const ok = host === `127.0.0.1:${this._port}` || host === `localhost:${this._port}`;
    if (!ok) throw new HttpError(403, "Bad Host header");
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (origin !== `chrome-extension://${this.opts.extensionId}`) throw new HttpError(403, "Origin not allowed");
    } else if (path === "/v1/pair") {
      throw new HttpError(403, "Origin required");
    }
  }

  private openStream(req: http.IncomingMessage, res: http.ServerResponse, deviceId: string) {
    // Only one SSE connection per paired browser: a new one replaces the old one.
    const old = this.clients.get(deviceId);
    if (old) old.res.end();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const last = Number.parseInt(String(req.headers["last-event-id"] ?? ""), 10);
    const client: Client = { deviceId, res };
    this.clients.set(deviceId, client);
    req.on("close", () => {
      if (this.clients.get(deviceId) === client) this.clients.delete(deviceId);
    });
    const info = this.opts.handlers.health();
    const helloId = ++this.seq;
    writeEvent(res, helloId, { type: "hello", sessionId: info.sessionId, model: info.model, bridgeVersion: BRIDGE_VERSION });
    if (Number.isFinite(last)) {
      this.trim(Date.now());
      for (const b of this.backlog) {
        // Skip replayed tool requests whose answer already arrived.
        if (b.id > last && !(b.event.type === "tool_request" && this.finished.has(b.event.request.requestId))) writeEvent(res, b.id, b.event);
      }
    }
    this.opts.handlers.onClientConnected();
  }
}

function writeEvent(res: http.ServerResponse, id: number, event: BridgeEvent) {
  try {
    res.write(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  } catch {
    /* connection closing */
  }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s), "Cache-Control": "no-store" });
  res.end(s);
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}
