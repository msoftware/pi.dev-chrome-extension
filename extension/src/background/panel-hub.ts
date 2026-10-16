/** Side-panel connections, approval dialogs and system notifications (UI-19, SEC-04). */
import type { ApprovalRequest, PanelMsg, SwMsg } from "../common/messages";
import { getSettings } from "../common/storage";
import type { AskUi, Decision } from "./permissions";
import { playSound } from "./offscreen-client";

interface Conn {
  port: chrome.runtime.Port;
  tabId: number;
}

interface Pending {
  req: ApprovalRequest;
  groupId: number;
  mainTabId: number;
  resolve(d: Decision): void;
}

export class PanelHub implements AskUi {
  private conns = new Set<Conn>();
  private pending = new Map<string, Pending>();
  private handlers: ((m: PanelMsg, c: Conn) => void)[] = [];
  private disconnectHandlers: ((c: Conn) => void)[] = [];

  onMessage(fn: (m: PanelMsg, c: Conn) => void) {
    this.handlers.push(fn);
  }
  onDisconnect(fn: (c: Conn) => void) {
    this.disconnectHandlers.push(fn);
  }

  attach(port: chrome.runtime.Port) {
    const conn: Conn = { port, tabId: -1 };
    this.conns.add(conn);
    port.onMessage.addListener((m: PanelMsg) => {
      if (m.t === "hello") {
        conn.tabId = m.tabId;
        // replay approvals that are still waiting (panel opened late or reloaded)
        for (const p of this.pending.values()) if (p.mainTabId === m.tabId || this.conns.size === 1) this.send(conn, { t: "approval_request", request: p.req });
      }
      if (m.t === "approval") {
        this.resolve(m.id, m.decision);
        return;
      }
      for (const h of this.handlers) h(m, conn);
    });
    port.onDisconnect.addListener(() => {
      this.conns.delete(conn);
      for (const h of this.disconnectHandlers) h(conn);
    });
  }

  panelOpenFor(tabId: number): boolean {
    for (const c of this.conns) if (c.tabId === tabId) return true;
    return false;
  }
  hasAnyPanel(): boolean {
    return this.conns.size > 0;
  }
  connections(): Conn[] {
    return [...this.conns];
  }

  send(c: Conn, m: SwMsg) {
    try {
      c.port.postMessage(m);
    } catch {
      /* port closed */
    }
  }
  broadcast(m: SwMsg) {
    for (const c of this.conns) this.send(c, m);
  }
  sendToTab(tabId: number, m: SwMsg) {
    for (const c of this.conns) if (c.tabId === tabId) this.send(c, m);
  }

  private resolve(id: string, d: Decision) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(d);
    this.broadcast({ t: "approval_done", id });
    void chrome.notifications.clear(`approval:${id}`);
  }

  /** Deny everything that is waiting, e.g. after Stop. */
  denyAll() {
    for (const id of [...this.pending.keys()]) this.resolve(id, "deny");
  }

  async ask(req: ApprovalRequest, ctx: { groupId: number; mainTabId: number }, signal?: AbortSignal): Promise<Decision> {
    return new Promise<Decision>((resolve) => {
      const p: Pending = { req, groupId: ctx.groupId, mainTabId: ctx.mainTabId, resolve };
      this.pending.set(req.id, p);
      signal?.addEventListener("abort", () => this.resolve(req.id, "deny"), { once: true });
      const target = [...this.conns].filter((c) => c.tabId === ctx.mainTabId);
      if (target.length) for (const c of target) this.send(c, { t: "approval_request", request: req });
      else this.broadcast({ t: "approval_request", request: req });
      void this.notifyIfBackground(ctx.mainTabId, "approval", req);
    });
  }

  /** UI-19: system notification and sound when the panel is not in the foreground. */
  async notifyIfBackground(mainTabId: number, kind: "approval" | "done", req?: ApprovalRequest) {
    const s = await getSettings();
    let foreground = false;
    try {
      const tab = await chrome.tabs.get(mainTabId);
      const win = await chrome.windows.get(tab.windowId);
      foreground = tab.active && win.focused && this.panelOpenFor(mainTabId);
    } catch {
      /* tab gone */
    }
    if (foreground) return;
    const title = kind === "approval" ? chrome.i18n.getMessage("notifApprovalTitle") || "Approval needed" : chrome.i18n.getMessage("notifDoneTitle") || "Task finished";
    const message = kind === "approval" ? `${req?.domain ?? ""}: ${req?.action ?? ""}`.slice(0, 200) : chrome.i18n.getMessage("notifDoneBody") || "The agent has finished its work.";
    try {
      await chrome.notifications.create(kind === "approval" ? `approval:${req!.id}` : `done:${mainTabId}:${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon-128.png",
        title,
        message,
        priority: 1,
        requireInteraction: kind === "approval",
      });
    } catch {
      /* notifications optional */
    }
    if (s.notifySound) void playSound(kind);
  }
}
