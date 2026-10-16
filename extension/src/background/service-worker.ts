/**
 * Service worker: the only component that talks to the bridge (architecture section 2).
 * Wires tab groups, panel hub, permission manager, executor, indicators, notifications and recovery together.
 */
import type { BridgeEvent, PromptBody, ToolRequest, ToolResult } from "@pi-browser/shared/protocol";
import { addAudit, purgeAudit, putShot } from "../common/idb";
import type { PanelMsg, StatusInfo, HistoryMessage } from "../common/messages";
import { log, setDebug } from "../common/log";
import { getAuth, getSettings, getShortcuts, saveSettings, type Shortcut } from "../common/storage";
import { BridgeClient, BridgeError } from "./bridge-client";
import { detachAll, forgetTab, installListeners, noteTabUrl, onDetached, onDialog, tabState } from "./cdp";
import { noteNewTab } from "./computer";
import { cancelAll, cancelRequest, ToolExecutor } from "./executor";
import { GifRecorder } from "./gif";
import { sendIndicator } from "./indicators";
import { PanelHub } from "./panel-hub";
import { PermissionManager } from "./permissions";
import { pickerInject } from "./picker";
import { newShotId } from "./screenshot";
import { expandPrompt, recorderInject, saveShortcut, scheduleAll, shortcutIdFromAlarm, stepsToPrompt, type RecStep } from "./shortcuts";
import * as groups from "./tab-groups";
import { targetSize } from "@pi-browser/shared/scaling";

const bridge = new BridgeClient();
const hub = new PanelHub();
const perms = new PermissionManager(hub);
const gif = new GifRecorder();

let running = false;
let activeGroupId: number | undefined;
let lastPrompt = "";
let piSessionId = "none";
const staticHidden = new Set<number>();

// ---- bridge helpers --------------------------------------------------------------------------------------------------

async function bridgeRequest<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  return bridge.request<T>(method, path, body);
}

const executor = new ToolExecutor({
  perms,
  sendProgress: (p) => void bridgeRequest("POST", "/v1/tool-progress", p).catch(() => {}),
  onLog: (entry) => hub.broadcast({ t: "tool_log", entry }),
  activeGroupId: () => activeGroupId,
  piSessionId: () => piSessionId,
  gif,
  runShortcut: (id) => runShortcut(id),
  bridgeFind: (query, tree, url) => bridgeRequest("POST", "/v1/find", { query, tree, url }),
  bridgeReview: (r) => bridgeRequest("POST", "/v1/review", r),
  lastUserPrompt: () => lastPrompt,
  ensureIndicators: async (tabId) => {
    if (running) await sendIndicator(tabId, { type: "SHOW_AGENT_INDICATORS" });
  },
});

// ---- status ------------------------------------------------------------------------------------------------------------------

async function statusInfo(): Promise<{ status: StatusInfo; paired: boolean }> {
  const s = await getSettings();
  const paired = !!(await getAuth());
  return {
    paired,
    status: {
      bridge: bridge.status,
      port: s.port,
      model: bridge.health.model ?? null,
      piVersion: bridge.health.piVersion,
      bridgeVersion: bridge.health.bridgeVersion,
      running,
      permissionMode: s.permissionMode,
      policyLocked: { permissionMode: !!s.policy.permissionMode, js: s.policy.javascriptToolEnabled === false },
      error: bridge.lastError,
    },
  };
}

async function broadcastStatus() {
  hub.broadcast({ t: "status", ...(await statusInfo()) });
}

async function refreshPanel(conn?: ReturnType<PanelHub["connections"]>[number]) {
  const send = (m: Parameters<PanelHub["broadcast"]>[0]) => (conn ? hub.send(conn, m) : hub.broadcast(m));
  send({ t: "status", ...(await statusInfo()) });
  if (bridge.status !== "connected") return;
  try {
    const models = await bridgeRequest("GET", "/v1/models");
    send({ t: "models", models });
    const list = await bridgeRequest("GET", "/v1/sessions");
    send({ t: "sessions", sessions: list.sessions ?? [], current: piSessionId });
  } catch (e) {
    if (e instanceof BridgeError && e.status !== 401) send({ t: "toast", message: e.message, level: "error" });
  }
}

bridge.onStatus(() => {
  void broadcastStatus();
  if (bridge.status === "connected") {
    void refreshPanel();
    void syncToolConfig();
  }
});

// ---- tool requests (with restart recovery, NFA-04) ---------------------------------------------------------------------

const inflight = new Map<string, ToolRequest>();
const results = new Map<string, ToolResult>();
const handled: string[] = [];

async function persistInflight() {
  await chrome.storage.session.set({ inflight: [...inflight.values()].map((r) => ({ requestId: r.requestId, tool: r.tool })) });
}

async function postResult(res: ToolResult) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await bridgeRequest("POST", "/v1/tool-results", res);
      return;
    } catch (e: any) {
      if (e instanceof BridgeError && (e.status === 404 || e.status === 400)) return; // cancelled or unknown: nothing to deliver
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
}

async function syncToolConfig() {
  // JS-05: tell the bridge when the JavaScript tool is forbidden so pi stops offering it to the model
  try {
    const s = await getSettings();
    setDebug(s.debug);
    await bridgeRequest("PUT", "/v1/config", { javascriptTool: s.jsToolEnabled });
  } catch (e) {
    log.debug("syncToolConfig failed", String(e));
  }
}

async function handleToolRequest(req: ToolRequest) {
  log.debug("tool_request", req.tool, req.requestId);
  const done = results.get(req.requestId);
  if (done) return void postResult(done); // duplicate after reconnect: resend the stored result
  if (inflight.has(req.requestId) || handled.includes(req.requestId)) return;
  inflight.set(req.requestId, req);
  await persistInflight();
  let res: ToolResult;
  try {
    res = await executor.execute(req);
  } catch (e: any) {
    res = { requestId: req.requestId, ok: false, content: [{ type: "text", text: String(e?.message ?? e) }] }; // NFA-06
  }
  results.set(req.requestId, res);
  log.debug("tool_result", req.tool, req.requestId, res.ok);
  await postResult(res);
  inflight.delete(req.requestId);
  handled.push(req.requestId);
  if (handled.length > 300) handled.shift();
  if (results.size > 30) results.delete(results.keys().next().value as string);
  await persistInflight();
}

/** After a service-worker restart, requests that were running are reported as failed instead of hanging. */
async function failOrphanedRequests() {
  const prev = (await chrome.storage.session.get("inflight")).inflight as { requestId: string; tool: string }[] | undefined;
  if (!prev?.length) return;
  await chrome.storage.session.set({ inflight: [] });
  for (const p of prev) {
    if (inflight.has(p.requestId) || results.has(p.requestId)) continue;
    await postResult({
      requestId: p.requestId,
      ok: false,
      content: [{ type: "text", text: `The browser extension restarted while ${p.tool} was running. Check the page state (screenshot) and retry if needed.` }],
    });
  }
}

// ---- run state, indicators -----------------------------------------------------------------------------------------------------

async function groupTabIds(groupId: number): Promise<number[]> {
  return (await groups.tabsOfGroup(groupId)).map((t) => t.id!).filter((x) => x !== undefined);
}

async function onRunStarted() {
  running = true;
  staticHidden.clear();
  void broadcastStatus();
  const gid = activeGroupId;
  if (gid === undefined) return;
  const s = await groups.sessionForGroup(gid);
  if (s?.owned) void groups.setGroupStatus(gid, "working");
  for (const id of await groupTabIds(gid)) {
    void sendIndicator(id, { type: "HIDE_STATIC_INDICATOR" });
    void sendIndicator(id, { type: "SHOW_AGENT_INDICATORS" });
  }
}

async function onSettled(aborted: boolean) {
  running = false;
  void broadcastStatus();
  await detachAll(); // INP-03
  for (const g of await groups.allSessions()) {
    for (const id of await groupTabIds(g.groupId)) {
      void sendIndicator(id, { type: "HIDE_AGENT_INDICATORS" });
      if (!staticHidden.has(g.groupId) && g.groupId === activeGroupId) void sendIndicator(id, { type: "SHOW_STATIC_INDICATOR" });
    }
    if (g.owned) void groups.setGroupStatus(g.groupId, g.groupId === activeGroupId && !aborted ? "done" : "idle");
  }
  if (activeGroupId !== undefined && !aborted) {
    const s = await groups.sessionForGroup(activeGroupId);
    if (s) void hub.notifyIfBackground(s.mainTabId, "done");
  }
}

/** SEC-13 */
async function stopAgent() {
  cancelAll();
  hub.denyAll();
  const abort = bridgeRequest("POST", "/v1/abort").catch(() => {});
  await detachAll();
  for (const g of await groups.allSessions()) {
    for (const id of await groupTabIds(g.groupId)) void sendIndicator(id, { type: "HIDE_AGENT_INDICATORS" });
  }
  await abort;
}

// ---- bridge events ------------------------------------------------------------------------------------------------------------------

bridge.onEvent((ev: BridgeEvent) => {
  switch (ev.type) {
    case "hello":
      piSessionId = ev.sessionId;
      // after a service-worker restart pi may be mid-run: restore (or drop) indicators accordingly
      if (ev.running === true && !running) void onRunStarted();
      else if (ev.running === false && running) void onSettled(false);
      void broadcastStatus();
      void refreshPanel();
      break;
    case "run_state":
      if (ev.state === "started") void onRunStarted();
      else if (ev.state === "settled") void onSettled(!!ev.aborted);
      hub.broadcast({ t: "event", event: ev });
      break;
    case "tool_request":
      void handleToolRequest(ev.request);
      break;
    case "tool_cancel":
      cancelRequest(ev.requestId);
      break;
    case "heartbeat":
      break;
    default:
      hub.broadcast({ t: "event", event: ev });
  }
});

// ---- panels ---------------------------------------------------------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "panel") hub.attach(port);
});

hub.onDisconnect(async (c) => {
  // SEC-13: closing the panel stops the run that belongs to it.
  if (c.tabId < 0) return;
  const g = await groups.sessionForMainTab(c.tabId);
  if (g && running && g.groupId === activeGroupId && !hub.panelOpenFor(c.tabId)) void stopAgent();
});

let recording: { tabId: number; steps: RecStep[] } | null = null;

hub.onMessage(async (m: PanelMsg, c) => {
  try {
    switch (m.t) {
      case "hello": {
        const g = await groups.sessionForMainTab(m.tabId);
        if (g) activeGroupId ??= g.groupId;
        await refreshPanel(c);
        hub.send(c, { t: "tabs", tabs: g ? await groups.tabContext(g.groupId) : [] });
        break;
      }
      case "ping":
        bridge.nudge();
        break;
      case "refresh":
        await refreshPanel(c);
        break;
      case "pair":
        await bridge.pair(m.code);
        await refreshPanel();
        break;
      case "unpair":
        await bridge.unpair();
        await broadcastStatus();
        break;
      case "prompt":
      case "steer": {
        const g = await groups.openForTab(c.tabId);
        activeGroupId = g.groupId;
        let text = m.text;
        const attachments: PromptBody["attachments"] = [];
        if (m.t === "prompt" && m.attachments?.length) {
          for (const a of m.attachments) {
            const id = newShotId();
            await putShot({ id, sessionId: piSessionId, tabId: c.tabId, ts: Date.now(), mime: a.mimeType, width: 0, height: 0, bytes: Math.floor((a.data.length * 3) / 4), data: a.data });
            text += `\n[Attached image ${a.name ?? ""} - image id ${id}]`;
            attachments.push(a);
          }
        }
        lastPrompt = m.text;
        await groups.takeChangeNote(g.groupId).catch(() => null); // set the baseline; the prompt carries the tab context itself
        const body: PromptBody = { text, attachments, tabContext: await groups.tabContext(g.groupId) };
        await bridgeRequest("POST", m.t === "steer" ? "/v1/steer" : "/v1/prompt", body);
        break;
      }
      case "abort":
        await stopAgent();
        break;
      case "setConfig": {
        if (m.permissionMode) {
          await saveSettings({ permissionMode: m.permissionMode });
          perms.invalidate();
        }
        await bridgeRequest("PUT", "/v1/config", { model: m.model, thinkingLevel: m.thinkingLevel, permissionMode: m.permissionMode });
        await refreshPanel();
        break;
      }
      case "newSession":
        await bridgeRequest("POST", "/v1/sessions");
        await refreshPanel();
        break;
      case "loadSession": {
        const r = await bridgeRequest("GET", `/v1/sessions/${encodeURIComponent(m.id)}/messages`);
        hub.send(c, { t: "history", sessionId: m.id, messages: (r.messages ?? []) as HistoryMessage[] });
        break;
      }
      case "pick":
        await pick(c, m.kind);
        break;
      case "captureTab": {
        const tab = await chrome.tabs.get(c.tabId);
        const data = await captureVisible(tab.windowId);
        hub.send(c, { t: "captured", mimeType: "image/jpeg", data });
        break;
      }
      case "runShortcut": {
        const msg = await runShortcut(m.id, m.params, c.tabId);
        hub.send(c, { t: "toast", message: msg });
        break;
      }
      case "dialogAnswer": {
        const st = tabState(m.tabId);
        if (st.dialog) {
          await chrome.debugger.sendCommand({ tabId: m.tabId }, "Page.handleJavaScriptDialog", { accept: m.accept, promptText: m.text ?? "" }).catch(() => {});
          st.dialog = null;
          hub.broadcast({ t: "dialog", tabId: m.tabId, info: null });
        }
        break;
      }
      case "recordWorkflow":
        await recordWorkflow(c, m);
        break;
    }
  } catch (e: any) {
    hub.send(c, { t: "toast", message: String(e?.message ?? e), level: "error" });
  }
});

onDialog((tabId, info) => hub.broadcast({ t: "dialog", tabId, info: { type: info.type, message: info.message, url: info.url } }));
onDetached(async (tabId, reason) => {
  // INP-03: the user closed the debugging bar etc.: a running job on that tab fails with a clear message.
  if (running && reason === "canceled_by_user") {
    cancelAll();
    hub.broadcast({ t: "toast", message: "The debugger was detached by the user. The running action was cancelled.", level: "error" });
  }
});

/** The extension CSP forbids fetch(data:), so decode data URLs by hand. */
function dataUrlToBlob(url: string): Blob {
  const [head, b64] = url.split(",");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: /data:([^;]+)/.exec(head)?.[1] ?? "image/jpeg" });
}

async function captureVisible(windowId: number): Promise<string> {
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 75 });
  const blob = dataUrlToBlob(url);
  const bmp = await createImageBitmap(blob);
  const t = targetSize(bmp.width, bmp.height);
  const cv = new OffscreenCanvas(t.width, t.height);
  cv.getContext("2d")!.drawImage(bmp, 0, 0, t.width, t.height);
  const out = await cv.convertToBlob({ type: "image/jpeg", quality: 0.75 });
  return blobToBase64(out);
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

async function pick(c: { tabId: number; port: chrome.runtime.Port }, kind: "area" | "element") {
  const [r] = await chrome.scripting.executeScript({ target: { tabId: c.tabId }, func: pickerInject, args: [kind] });
  const res = r?.result as any;
  if (!res) return hub.send(c, { t: "picked", result: { error: "cancelled" } });
  if (kind === "area") {
    const tab = await chrome.tabs.get(c.tabId);
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 80 });
    const bmp = await createImageBitmap(dataUrlToBlob(url));
    const sx = Math.round(res.x * res.dpr), sy = Math.round(res.y * res.dpr), sw = Math.max(1, Math.round(res.w * res.dpr)), sh = Math.max(1, Math.round(res.h * res.dpr));
    const t = targetSize(sw, sh);
    const cv = new OffscreenCanvas(t.width, t.height);
    cv.getContext("2d")!.drawImage(bmp, sx, sy, sw, sh, 0, 0, t.width, t.height);
    const data = await blobToBase64(await cv.convertToBlob({ type: "image/jpeg", quality: 0.8 }));
    hub.send(c, { t: "picked", result: { kind: "area", imageData: data, mime: "image/jpeg" } });
  } else {
    hub.send(c, { t: "picked", result: { kind: "element", selector: res.selector, text: res.text, a11y: res.outline ? `${res.ref}\n${res.outline}` : undefined } });
  }
}

// ---- shortcuts & workflow recording -------------------------------------------------------------------------------------------

async function runShortcut(id: string, params?: Record<string, string>, tabId?: number): Promise<string> {
  const s = (await getShortcuts()).find((x) => x.id === id);
  if (!s) throw new Error(`Unknown shortcut ${id}`);
  const missing = (s.params ?? []).filter((p) => !(params && p in params));
  if (missing.length && !running) throw new Error(`Shortcut needs parameters: ${missing.join(", ")}`);
  const text = expandPrompt(s.prompt, params);
  let gid = activeGroupId;
  if (tabId !== undefined) gid = (await groups.openForTab(tabId)).groupId;
  if (gid === undefined) {
    // scheduled run without a session: open a fresh tab as the agent's workspace
    const t = await chrome.tabs.create({ url: "about:blank", active: true });
    gid = (await groups.openForTab(t.id!)).groupId;
    try {
      await chrome.sidePanel.setOptions({ tabId: t.id!, path: `sidepanel.html?tabId=${t.id}`, enabled: true });
    } catch {
      /* panel opens on the next user click */
    }
  }
  activeGroupId = gid;
  lastPrompt = text;
  await bridgeRequest("POST", "/v1/prompt", { text, tabContext: await groups.tabContext(gid) });
  return `Started shortcut "${s.name}".`;
}

async function recordWorkflow(c: { tabId: number; port: chrome.runtime.Port }, m: Extract<PanelMsg, { t: "recordWorkflow" }>) {
  if (m.action === "start") {
    recording = { tabId: c.tabId, steps: [] };
    const tab = await chrome.tabs.get(c.tabId);
    recording.steps.push({ kind: "navigate", desc: "", url: tab.url });
    await chrome.scripting.executeScript({ target: { tabId: c.tabId, allFrames: true }, func: recorderInject });
    hub.send(c, { t: "recording", active: true, steps: 1 });
  } else if (recording) {
    const steps = recording.steps;
    recording = null;
    const prompt = stepsToPrompt(steps);
    const sc: Shortcut = { id: crypto.randomUUID(), name: m.name?.trim() || `Workflow ${new Date().toLocaleString()}`, prompt, schedule: null };
    await saveShortcut(sc);
    hub.send(c, { t: "recording", active: false, steps: steps.length });
    hub.send(c, { t: "toast", message: `Saved as shortcut "${sc.name}".` });
  }
}

// ---- runtime messages (content scripts, options page) --------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === "offscreen") return; // handled by the offscreen document
  switch (msg?.type) {
    case "FRAME_ID":
      sendResponse({ frameId: sender.frameId ?? 0 });
      return;
    case "STOP_AGENT":
      void stopAgent();
      sendResponse({ ok: true });
      return;
    case "SWITCH_TO_MAIN_TAB":
      void (async () => {
        const tabId = sender.tab?.id;
        if (tabId === undefined) return;
        const g = await groups.groupOfTab(tabId);
        if (g) {
          await chrome.tabs.update(g.mainTabId, { active: true });
          try {
            await chrome.sidePanel.open({ tabId: g.mainTabId });
          } catch {
            /* needs a user gesture */
          }
        }
      })();
      sendResponse({ ok: true });
      return;
    case "HIDE_STATIC_INDICATOR_REQUEST":
      void (async () => {
        const tabId = sender.tab?.id;
        const g = tabId !== undefined ? await groups.groupOfTab(tabId) : undefined;
        if (g) {
          staticHidden.add(g.groupId); // IND-03
          for (const id of await groupTabIds(g.groupId)) void sendIndicator(id, { type: "HIDE_STATIC_INDICATOR" });
        }
      })();
      sendResponse({ ok: true });
      return;
    case "INDICATOR_HEARTBEAT":
      // IND-02: restore state the page lost (reload, content script reset)
      void (async () => {
        const tabId = sender.tab?.id;
        const g = tabId !== undefined ? await groups.groupOfTab(tabId) : undefined;
        if (g && running && g.groupId === activeGroupId && !msg.active) sendResponse({ restore: "show" });
        else if (msg.active && (!running || !g)) sendResponse({ restore: "hide" });
        else sendResponse({});
      })();
      return true;
    case "REC_STEP":
      if (recording && sender.tab?.id === recording.tabId) {
        recording.steps.push(msg.step);
        hub.broadcast({ t: "recording", active: true, steps: recording.steps.length });
      }
      return;
    case "OPT_GRANTS_CHANGED":
      perms.invalidate();
      return;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.settings || changes.grants)) {
    perms.invalidate();
    void broadcastStatus();
    if (changes.settings) {
      void syncToolConfig();
      const o = changes.settings.oldValue?.port;
      const n = changes.settings.newValue?.port;
      if (o !== n) bridge.restart(); // only a changed port needs a new connection
    }
  }
  if (area === "managed") {
    perms.invalidate();
    void broadcastStatus();
  }
  if (area === "local" && changes.shortcuts) void scheduleAll();
});

// ---- opening the panel (UI-01..04) ---------------------------------------------------------------------------------------------------

function openPanel(tabId: number) {
  // UI-01: setOptions then open, with no await in front of open() so the user gesture is still valid.
  chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tabId=${tabId}`, enabled: true }).catch(() => {});
  chrome.sidePanel.open({ tabId }).catch((e) => console.warn("sidePanel.open failed", e));
  void groups
    .openForTab(tabId)
    .then((g) => {
      activeGroupId = g.groupId;
      bridge.nudge();
    })
    .catch((e) => console.warn("group setup failed", e));
}

function unsupported() {
  // UI-04
  void chrome.notifications.create("unsupported", {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: chrome.i18n.getMessage("extName") || "Browser Agent",
    message: chrome.i18n.getMessage("unsupportedBrowser") || "This browser does not support the side panel API. Use Chrome 116 or newer.",
  });
}

chrome.action.onClicked.addListener((tab) => {
  if (!chrome.sidePanel?.open) return unsupported();
  if (tab.id === undefined) return;
  openPanel(tab.id);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-side-panel") return;
  if (!chrome.sidePanel?.open) return unsupported();
  const tabId = tab?.id;
  if (tabId === undefined) return;
  // UI-03: if a panel is already open for this tab, ask it to close; otherwise open like the icon click.
  if (hub.panelOpenFor(tabId)) hub.sendToTab(tabId, { t: "close_side_panel" });
  else openPanel(tabId);
});

chrome.notifications.onClicked.addListener(async (id) => {
  // UI-19: a click focuses the tab that needs attention
  const m = /^(?:done|approval):(\d+)?/.exec(id);
  let tabId = m?.[1] ? Number(m[1]) : undefined;
  if (tabId === undefined && activeGroupId !== undefined) tabId = (await groups.sessionForGroup(activeGroupId))?.mainTabId;
  if (tabId === undefined) return;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* tab closed */
  }
  void chrome.notifications.clear(id);
});

// ---- tab / group bookkeeping -----------------------------------------------------------------------------------------------------------

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id === undefined) return;
  noteNewTab({ tabId: tab.id, openerTabId: tab.openerTabId, at: Date.now() });
  if (tab.openerTabId !== undefined) {
    const g = await groups.groupOfTab(tab.openerTabId);
    if (g) {
      try {
        await groups.addTabToGroup(tab.id, g.groupId);
        groups.markDirty(g.groupId);
      } catch {
        /* tab already gone */
      }
    }
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url) noteTabUrl(tabId, info.url);
  if (info.url || info.title || info.groupId !== undefined) {
    if (tab.groupId !== undefined && tab.groupId >= 0) groups.markDirty(tab.groupId);
  }
  if (info.status === "complete" && running) {
    const g = await groups.groupOfTab(tabId);
    if (g && g.groupId === activeGroupId) void sendIndicator(tabId, { type: "SHOW_AGENT_INDICATORS" });
  }
  if (info.groupId !== undefined) hub.sendToTab(tabId, { t: "tabs", tabs: [] }); // panel refetches on its own
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  forgetTab(tabId);
  const g = await groups.sessionForMainTab(tabId);
  if (g) {
    if (running && g.groupId === activeGroupId) void stopAgent();
    await groups.removeSession(g.groupId);
    if (activeGroupId === g.groupId) activeGroupId = undefined;
  }
});

chrome.tabGroups.onRemoved.addListener((g) => void groups.removeSession(g.id));
chrome.tabs.onAttached.addListener(() => undefined);

// Blocked domains: navigation inside an agent tab group is redirected to blocked.html (11.3).
chrome.webNavigation.onBeforeNavigate.addListener(async (d) => {
  if (d.frameId !== 0 || !/^https?:/i.test(d.url)) return;
  const g = await groups.groupOfTab(d.tabId);
  if (!g) return;
  const cat = await perms.categoryOf(d.url);
  if (cat.category === "blocked") {
    await addAudit({ ts: Date.now(), sessionId: piSessionId, tool: "navigation", action: "blocked", domain: cat.domain, decision: "blocked", result: "denied" });
    void chrome.tabs.update(d.tabId, { url: chrome.runtime.getURL(`blocked.html?domain=${encodeURIComponent(cat.domain)}&url=${encodeURIComponent(d.url)}`) });
  }
});

// ---- lifecycle ---------------------------------------------------------------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "keepalive") {
    // NFA-04: wakes the worker every 30 s; the SSE heartbeat (15 s) keeps it alive between alarms.
    bridge.nudge();
    return;
  }
  if (alarm.name === "purge") {
    await purgeAudit().catch(() => {});
    return;
  }
  const sid = shortcutIdFromAlarm(alarm.name);
  if (sid) {
    const s = (await getShortcuts()).find((x) => x.id === sid);
    try {
      if (s && !(s.params ?? []).length) await runShortcut(sid);
    } catch (e) {
      console.warn("scheduled shortcut failed", e);
    }
    await scheduleAll();
  }
});

async function init() {
  installListeners();
  setDebug((await getSettings()).debug);
  await groups.restore();
  void chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  void chrome.alarms.create("purge", { periodInMinutes: 60 * 12 });
  await scheduleAll();
  bridge.start();
  await failOrphanedRequests();
}

chrome.runtime.onInstalled.addListener(() => void init());
chrome.runtime.onStartup.addListener(() => void init());
void init();

export {};
