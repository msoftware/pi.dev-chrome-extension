/**
 * HTTP + SSE client for pi-browser-bridge. The service worker owns the only connection (architecture section 2).
 * Reconnects with exponential backoff 1 s .. 30 s (NFA-05) and resumes with Last-Event-ID (API-10).
 */
import type { BridgeEvent } from "@pi-browser/shared";
import { getAuth, getSettings, setAuth } from "../common/storage";
import type { BridgeStatus } from "../common/messages";

export class BridgeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

type Listener = (ev: BridgeEvent, id: number) => void;

export class BridgeClient {
  status: BridgeStatus = "disconnected";
  lastError: string | undefined;
  private abort: AbortController | null = null;
  private running = false;
  private backoff = 1000;
  private lastEventId = 0;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<() => void>();
  private loopToken = 0;
  health: { piVersion?: string; bridgeVersion?: string; model?: string | null } = {};

  onEvent(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onStatus(fn: () => void) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }
  private setStatus(s: BridgeStatus, err?: string) {
    this.status = s;
    this.lastError = err;
    for (const f of this.statusListeners) f();
  }

  async baseUrl(): Promise<string> {
    const s = await getSettings();
    return `http://127.0.0.1:${s.port}`;
  }

  async request<T = any>(method: string, path: string, body?: unknown, opts: { auth?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.auth !== false) {
      const a = await getAuth();
      if (!a) throw new BridgeError(401, "Not paired");
      headers.Authorization = `Bearer ${a.token}`;
    }
    const res = await fetch(`${await this.baseUrl()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
      cache: "no-store",
    });
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      if (res.status === 401 && opts.auth !== false) this.setStatus("unauthorized", "Token rejected");
      throw new BridgeError(res.status, data?.error ?? `HTTP ${res.status}`);
    }
    return data as T;
  }

  async pair(code: string, label = "Chrome"): Promise<void> {
    const r = await this.request<{ token: string; deviceId: string }>("POST", "/v1/pair", { code, label }, { auth: false });
    await setAuth({ token: r.token, deviceId: r.deviceId });
    this.lastEventId = 0;
    this.restart();
  }

  async unpair() {
    await setAuth(null);
    this.stop();
    this.setStatus("unpaired");
  }

  /** (Re)start the event loop. Idempotent. */
  start() {
    if (this.running) return;
    this.running = true;
    const token = ++this.loopToken;
    void this.loop(token);
  }
  stop() {
    this.running = false;
    this.loopToken++;
    this.abort?.abort();
    this.abort = null;
    if (this.status === "connected" || this.status === "connecting") this.setStatus("disconnected");
  }
  restart() {
    this.stop();
    this.backoff = 1000;
    this.start();
  }
  /** Called by the alarm and by panel pings; reconnects at once if the loop is waiting in backoff. */
  nudge() {
    if (this.status === "connected" || this.status === "connecting") return;
    this.backoff = 1000;
    this.restart();
  }

  private async loop(token: number) {
    while (this.running && token === this.loopToken) {
      try {
        const auth = await getAuth();
        this.setStatus("connecting");
        // Health tells us whether the bridge exists and whether any browser is paired.
        const h = await this.request<any>("GET", "/v1/health", undefined, { auth: false });
        this.health = { piVersion: h.piVersion, bridgeVersion: h.bridgeVersion, model: h.model };
        if (!auth) {
          this.setStatus("unpaired");
          await this.sleep(3000, token);
          continue;
        }
        await this.stream(token, auth.token);
      } catch (e: any) {
        if (!this.running || token !== this.loopToken) return;
        if (e instanceof BridgeError && e.status === 401) {
          this.setStatus("unauthorized", e.message);
          await this.sleep(5000, token);
          continue;
        }
        this.setStatus("disconnected", e?.message ?? String(e));
      }
      if (!this.running || token !== this.loopToken) return;
      await this.sleep(this.backoff, token);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    }
  }

  private sleep(ms: number, token: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      const check = setInterval(() => {
        if (token !== this.loopToken) {
          clearTimeout(t);
          clearInterval(check);
          resolve();
        }
      }, 250);
      setTimeout(() => clearInterval(check), ms + 50);
    });
  }

  private async stream(token: number, bearer: string) {
    const ac = new AbortController();
    this.abort = ac;
    const stored = (await chrome.storage.session.get("lastEventId")).lastEventId as number | undefined;
    if (stored && !this.lastEventId) this.lastEventId = stored;
    const headers: Record<string, string> = { Authorization: `Bearer ${bearer}`, Accept: "text/event-stream" };
    if (this.lastEventId) headers["Last-Event-ID"] = String(this.lastEventId);
    const res = await fetch(`${await this.baseUrl()}/v1/events`, { headers, signal: ac.signal, cache: "no-store" });
    if (!res.ok || !res.body) throw new BridgeError(res.status, `Event stream failed (HTTP ${res.status})`);
    this.setStatus("connected");
    this.backoff = 1000;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    // Treat a silent stream (no heartbeat for 40 s) as dead.
    let watchdog = setTimeout(() => ac.abort(), 40_000);
    try {
      while (token === this.loopToken) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => ac.abort(), 40_000);
        buf += value;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          this.dispatch(block);
        }
      }
    } finally {
      clearTimeout(watchdog);
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    if (token === this.loopToken) throw new Error("Event stream closed");
  }

  private dispatch(block: string) {
    let id = 0;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) id = Number.parseInt(line.slice(3).trim(), 10);
      else if (line.startsWith("data:")) data += line.slice(5).trimStart();
    }
    if (!data) return;
    let ev: BridgeEvent;
    try {
      ev = JSON.parse(data) as BridgeEvent;
    } catch {
      return;
    }
    if (ev.type === "hello" && id > 0 && id < this.lastEventId) this.lastEventId = 0; // bridge restarted: its counter began again
    if (id > 0 && id <= this.lastEventId) return; // duplicate after a reconnect
    if (Number.isFinite(id) && id > 0) {
      this.lastEventId = id;
      void chrome.storage.session.set({ lastEventId: id });
    }
    if (ev.type === "hello") this.health = { ...this.health, model: ev.model, bridgeVersion: ev.bridgeVersion };
    for (const l of this.listeners) {
      try {
        l(ev, id);
      } catch (e) {
        console.error("listener failed", e);
      }
    }
  }
}
