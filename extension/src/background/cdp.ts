/**
 * Debugger (CDP) manager: attach with timeout and de-duplication (INP-01..04), event routing, console and
 * network buffers (AUX-01..03), dialogs (AUX-04/05) and navigation tracking.
 */
import type { ScaleContext } from "@pi-browser/shared/scaling";
import { getSettings } from "../common/storage";

export interface ConsoleEntry {
  ts: number;
  level: string;
  text: string;
  host: string;
}
export interface NetEntry {
  id: string;
  method: string;
  url: string;
  status?: number;
  type?: string;
  startedAt: number;
  durationMs?: number;
  size?: number;
  failed?: string;
  postData?: string;
}
export interface DialogInfo {
  type: string;
  message: string;
  url: string;
  defaultPrompt?: string;
  hasBrowserHandler: boolean;
}

export interface TabState {
  console: ConsoleEntry[];
  net: Map<string, NetEntry>;
  netOrder: string[];
  dialog: DialogInfo | null;
  dialogNotes: string[];
  acceptBeforeUnload: boolean;
  scale: (ScaleContext & { screenshotId?: string }) | null;
  navigating: boolean;
  postData: boolean;
  focusEmulation: boolean;
  /** Last time a "leave page?" dialog was cancelled for this tab (navigation then never completes). */
  leaveCancelledAt: number;
}

const states = new Map<number, TabState>();
const attached = new Set<number>();
const attaching = new Map<number, Promise<void>>();
let detachListeners: ((tabId: number, reason: string) => void)[] = [];
let dialogListeners: ((tabId: number, d: DialogInfo) => void)[] = [];

export const CONSOLE_MAX = 1000;
export const NET_MAX = 500;

export function tabState(tabId: number): TabState {
  let s = states.get(tabId);
  if (!s) {
    s = { console: [], net: new Map(), netOrder: [], dialog: null, dialogNotes: [], acceptBeforeUnload: false, scale: null, navigating: false, postData: false, focusEmulation: false, leaveCancelledAt: 0 };
    states.set(tabId, s);
  }
  return s;
}

/**
 * Sends a CDP command that may open a modal dialog (alert/confirm/prompt). Chrome does not answer such commands until the
 * dialog is closed, so the call is raced against the dialog opening; the late answer is ignored.
 */
export function sendRacingDialog<T = any>(tabId: number, method: string, params?: object): Promise<T | undefined> {
  const st = tabState(tabId);
  return new Promise<T | undefined>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      dialogWaiters.get(tabId)?.delete(wake);
      fn();
    };
    const wake = () => finish(() => resolve(undefined));
    if (!dialogWaiters.has(tabId)) dialogWaiters.set(tabId, new Set());
    dialogWaiters.get(tabId)!.add(wake);
    if (st.dialog) return wake();
    send<T>(tabId, method, params).then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}
const dialogWaiters = new Map<number, Set<() => void>>();

export function onDetached(fn: (tabId: number, reason: string) => void) {
  detachListeners.push(fn);
}
export function onDialog(fn: (tabId: number, d: DialogInfo) => void) {
  dialogListeners.push(fn);
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** INP-01/02: attach with 5 s timeout; concurrent attempts for one tab share a promise. */
export function attach(tabId: number): Promise<void> {
  if (attached.has(tabId)) return Promise.resolve();
  const running = attaching.get(tabId);
  if (running) return running;
  const p = (async () => {
    try {
      await withTimeout(chrome.debugger.attach({ tabId }, "1.3"), 5000, "attach timeout");
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/already attached/i.test(msg)) {
        // Another debugger client (DevTools) holds the tab.
        throw new Error("Could not attach to the tab: another debugger (DevTools?) is already attached. Close DevTools for this tab and try again.");
      }
      if (/timeout/i.test(msg)) throw new Error("Could not attach to the tab within 5 s. The page may be unresponsive (renderer hung) or DevTools may be open on it.");
      if (/cannot access|not allowed|extensions gallery/i.test(msg)) throw new Error(`Cannot control this page: ${msg}`);
      throw new Error(`Could not attach to the tab (${msg}). Likely causes: DevTools open on this tab, or the renderer is hung.`);
    }
    attached.add(tabId);
    const st = tabState(tabId);
    st.postData = (await getSettings()).capturePostData;
    try {
      await send(tabId, "Runtime.enable");
      await send(tabId, "Network.enable", { maxPostDataSize: 65536 });
      await send(tabId, "Page.enable");
    } catch {
      /* some pages refuse domains; tools will report their own errors */
    }
    st.navigating = false;
  })().finally(() => attaching.delete(tabId));
  attaching.set(tabId, p);
  return p;
}

export async function send<T = any>(tabId: number, method: string, params?: object): Promise<T> {
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params as any)) as T;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/not attached|detached/i.test(msg)) attached.delete(tabId);
    throw new Error(`${method} failed: ${msg}`);
  }
}

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  const st = states.get(tabId);
  if (st?.focusEmulation) {
    try {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false });
    } catch {
      /* ignore */
    }
    st.focusEmulation = false;
  }
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already gone */
  }
}

/** INP-03: after agent_settled or end of session. */
export async function detachAll(): Promise<void> {
  await Promise.all([...attached].map((t) => detach(t)));
}

export function forgetTab(tabId: number) {
  attached.delete(tabId);
  states.delete(tabId);
}

export function attachedTabs(): number[] {
  return [...attached];
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const tabUrls = new Map<number, string>();
export function noteTabUrl(tabId: number, url: string) {
  tabUrls.set(tabId, url);
}

// INP-04: one central handler for all CDP events.
export function installListeners() {
  chrome.debugger.onDetach.addListener((src, reason) => {
    if (src.tabId === undefined) return;
    attached.delete(src.tabId);
    for (const l of detachListeners) l(src.tabId, reason);
  });
  chrome.debugger.onEvent.addListener((src, method, params: any) => {
    const tabId = src.tabId;
    if (tabId === undefined) return;
    const st = tabState(tabId);
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const text = (params.args ?? []).map((a: any) => a.value ?? a.description ?? a.unserializableValue ?? `[${a.type}]`).map(String).join(" ");
        pushConsole(st, { ts: Date.now(), level: String(params.type), text, host: hostOf(tabUrls.get(tabId) ?? "") });
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails ?? {};
        const text = d.exception?.description ?? d.text ?? "Uncaught exception";
        pushConsole(st, { ts: Date.now(), level: "error", text: `${text}${d.url ? ` (${d.url}:${d.lineNumber ?? 0})` : ""}`, host: hostOf(tabUrls.get(tabId) ?? "") });
        break;
      }
      case "Network.requestWillBeSent": {
        const e: NetEntry = { id: params.requestId, method: params.request?.method ?? "GET", url: params.request?.url ?? "", type: params.type, startedAt: Date.now() };
        if (st.postData && params.request?.postData) e.postData = String(params.request.postData).slice(0, 65536);
        if (!st.net.has(e.id)) st.netOrder.push(e.id);
        st.net.set(e.id, e);
        while (st.netOrder.length > NET_MAX) st.net.delete(st.netOrder.shift()!);
        break;
      }
      case "Network.responseReceived": {
        const e = st.net.get(params.requestId);
        if (e) {
          e.status = params.response?.status;
          e.type = params.type ?? e.type;
        }
        break;
      }
      case "Network.loadingFinished": {
        const e = st.net.get(params.requestId);
        if (e) {
          e.durationMs = Date.now() - e.startedAt;
          e.size = params.encodedDataLength;
        }
        break;
      }
      case "Network.loadingFailed": {
        const e = st.net.get(params.requestId);
        if (e) {
          e.failed = params.errorText;
          e.durationMs = Date.now() - e.startedAt;
        }
        break;
      }
      case "Page.javascriptDialogOpening": {
        const info: DialogInfo = { type: params.type, message: params.message ?? "", url: params.url ?? "", defaultPrompt: params.defaultPrompt, hasBrowserHandler: !!params.hasBrowserHandler };
        if (params.type === "beforeunload") {
          // AUX-04: answer automatically; default is "cancel" (stay on page).
          void send(tabId, "Page.handleJavaScriptDialog", { accept: st.acceptBeforeUnload }).catch(() => {});
          st.dialogNotes.push(`A "leave page?" dialog appeared and was ${st.acceptBeforeUnload ? "accepted" : "cancelled"}.`);
          if (!st.acceptBeforeUnload) st.leaveCancelledAt = Date.now();
        } else {
          // AUX-05: block until the model has decided (answered via the dialog tool path / user approval).
          st.dialog = info;
          for (const w of [...(dialogWaiters.get(tabId) ?? [])]) w();
          for (const l of dialogListeners) l(tabId, info);
        }
        break;
      }
      case "Page.javascriptDialogClosed":
        st.dialog = null;
        break;
      case "Page.frameStartedNavigating":
      case "Page.frameRequestedNavigation":
        if (!params.frameId || true) st.navigating = true;
        break;
      case "Page.frameNavigated":
      case "Page.loadEventFired":
      case "Page.frameStoppedLoading":
        st.navigating = false;
        break;
    }
  });
}

function pushConsole(st: TabState, e: ConsoleEntry) {
  st.console.push(e);
  if (st.console.length > CONSOLE_MAX) st.console.splice(0, st.console.length - CONSOLE_MAX);
}

/** AUX-06: keep pages in the background alive and rendering. */
export async function ensureFocusEmulation(tabId: number, on: boolean) {
  const st = tabState(tabId);
  if (st.focusEmulation === on) return;
  await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: on });
  st.focusEmulation = on;
}

export function setPostData(tabId: number, on: boolean) {
  tabState(tabId).postData = on;
}
