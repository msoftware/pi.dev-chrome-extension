import { useCallback, useEffect, useReducer, useRef } from "react";
import type { BridgeEvent, ModelsResponse, SessionSummary } from "@pi-browser/shared/protocol";
import type { ApprovalRequest, HistoryMessage, PanelMsg, StatusInfo, SwMsg, ToolLogEntry } from "../common/messages";

export type ChatItem =
  | { kind: "user"; id: string; text: string; source: "terminal" | "panel" }
  | { kind: "assistant"; id: string; text: string; thinking?: string; streaming: boolean }
  | { kind: "tool"; id: string; entry: ToolLogEntry }
  | { kind: "activity"; id: string; toolName: string; summary: string; done: boolean; isError?: boolean }
  | { kind: "error"; id: string; text: string }
  | { kind: "notice"; id: string; text: string };

export interface PanelState {
  connected: boolean; // port to the service worker
  status: StatusInfo | null;
  paired: boolean;
  models: ModelsResponse | null;
  sessions: SessionSummary[];
  currentSession: string | null;
  viewing: string | null; // read-only history of another session
  items: ChatItem[];
  running: boolean;
  approvals: ApprovalRequest[];
  dialogs: Record<number, { type: string; message: string; url: string } | null>;
  toast: { message: string; level: "info" | "error"; n: number } | null;
  recording: { active: boolean; steps: number };
  picked: Extract<SwMsg, { t: "picked" }>["result"] | null;
  captured: { mimeType: string; data: string } | null;
}

const initial: PanelState = {
  connected: false,
  status: null,
  paired: false,
  models: null,
  sessions: [],
  currentSession: null,
  viewing: null,
  items: [],
  running: false,
  approvals: [],
  dialogs: {},
  toast: null,
  recording: { active: false, steps: 0 },
  picked: null,
  captured: null,
};

let seq = 0;
const nid = () => `i${++seq}`;

type Action = { type: "sw"; msg: SwMsg } | { type: "port"; connected: boolean } | { type: "clearPicked" } | { type: "clearCaptured" } | { type: "backToCurrent" } | { type: "resetChat" };

function historyToItems(messages: HistoryMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolIdx = new Map<string, number>();
  for (const m of messages) {
    if (m.role === "user") items.push({ kind: "user", id: nid(), text: m.text, source: "panel" });
    else if (m.role === "assistant") {
      if (m.text) items.push({ kind: "assistant", id: nid(), text: m.text, streaming: false });
      for (const t of m.tools ?? []) {
        toolIdx.set(t.id, items.length);
        items.push({ kind: "activity", id: nid(), toolName: t.name, summary: summarize(t.args), done: false });
      }
    } else if (m.role === "tool" && m.toolCallId) {
      const i = toolIdx.get(m.toolCallId);
      if (i !== undefined && items[i].kind === "activity") (items[i] as any).done = true, ((items[i] as any).isError = m.isError);
    }
  }
  return items;
}

function summarize(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 100 ? s.slice(0, 100) + "…" : s;
  } catch {
    return "";
  }
}

function applyEvent(state: PanelState, ev: BridgeEvent): PanelState {
  if (state.viewing) return state; // a past session is on screen; keep it stable
  const items = [...state.items];
  const last = items[items.length - 1];
  switch (ev.type) {
    case "run_state":
      if (ev.state === "started") return { ...state, running: true };
      if (ev.state === "settled") {
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (it.kind === "assistant" && it.streaming) items[i] = { ...it, streaming: false };
        }
        return { ...state, running: false, items };
      }
      return state;
    case "user_message":
      items.push({ kind: "user", id: nid(), text: ev.text, source: ev.source });
      return { ...state, items };
    case "assistant_delta":
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, text: last.text + ev.text };
      else items.push({ kind: "assistant", id: nid(), text: ev.text, streaming: true });
      return { ...state, items };
    case "assistant_message":
      if (last?.kind === "assistant" && last.streaming) items[items.length - 1] = { ...last, text: ev.text || last.text, thinking: ev.thinking, streaming: false };
      else if (ev.text || ev.thinking) items.push({ kind: "assistant", id: nid(), text: ev.text, thinking: ev.thinking, streaming: false });
      return { ...state, items };
    case "tool_activity": {
      if (ev.phase === "start") items.push({ kind: "activity", id: ev.toolCallId, toolName: ev.toolName, summary: ev.summary, done: false });
      else {
        const i = items.findIndex((x) => x.kind === "activity" && x.id === ev.toolCallId);
        if (i >= 0) items[i] = { ...(items[i] as any), done: true, isError: ev.isError };
      }
      return { ...state, items };
    }
    case "error":
      items.push({ kind: "error", id: nid(), text: ev.message });
      return { ...state, items };
    case "hello":
      return { ...state, currentSession: ev.sessionId };
    default:
      return state;
  }
}

function reducer(state: PanelState, a: Action): PanelState {
  if (a.type === "port") return { ...state, connected: a.connected };
  if (a.type === "clearPicked") return { ...state, picked: null };
  if (a.type === "clearCaptured") return { ...state, captured: null };
  if (a.type === "resetChat") return { ...state, items: [], viewing: null };
  if (a.type === "backToCurrent") return { ...state, viewing: null };
  const m = a.msg;
  switch (m.t) {
    case "status":
      return { ...state, status: m.status, paired: m.paired, running: m.status.running };
    case "models":
      return { ...state, models: m.models };
    case "sessions":
      return { ...state, sessions: m.sessions, currentSession: m.current };
    case "history":
      return { ...state, viewing: m.sessionId, items: historyToItems(m.messages) };
    case "event":
      return applyEvent(state, m.event);
    case "tool_log": {
      if (state.viewing) return state;
      const items = [...state.items];
      const i = items.findIndex((x) => x.kind === "tool" && x.entry.toolCallId === m.entry.toolCallId && x.entry.tool === m.entry.tool);
      if (i >= 0) items[i] = { kind: "tool", id: items[i].id, entry: m.entry };
      else items.push({ kind: "tool", id: nid(), entry: m.entry });
      return { ...state, items };
    }
    case "approval_request":
      return state.approvals.some((x) => x.id === m.request.id) ? state : { ...state, approvals: [...state.approvals, m.request] };
    case "approval_done":
      return { ...state, approvals: state.approvals.filter((x) => x.id !== m.id) };
    case "dialog":
      return { ...state, dialogs: { ...state.dialogs, [m.tabId]: m.info } };
    case "toast":
      return { ...state, toast: { message: m.message, level: m.level ?? "info", n: (state.toast?.n ?? 0) + 1 } };
    case "recording":
      return { ...state, recording: { active: m.active, steps: m.steps } };
    case "picked":
      return { ...state, picked: m.result };
    case "captured":
      return { ...state, captured: { mimeType: m.mimeType, data: m.data } };
    case "close_side_panel":
      window.close();
      return state;
    default:
      return state;
  }
}

/** Long-lived port to the service worker with automatic reconnect and keep-alive pings (NFA-04). */
export function usePanel(tabId: number) {
  const [state, dispatch] = useReducer(reducer, initial);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  const send = useCallback((m: PanelMsg) => {
    try {
      portRef.current?.postMessage(m);
    } catch {
      /* reconnects on its own */
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let ping: ReturnType<typeof setInterval> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (closed) return;
      const port = chrome.runtime.connect({ name: "panel" });
      portRef.current = port;
      dispatch({ type: "port", connected: true });
      port.onMessage.addListener((msg: SwMsg) => dispatch({ type: "sw", msg }));
      port.onDisconnect.addListener(() => {
        dispatch({ type: "port", connected: false });
        clearInterval(ping);
        if (!closed) retry = setTimeout(connect, 500);
      });
      port.postMessage({ t: "hello", tabId } satisfies PanelMsg);
      ping = setInterval(() => port.postMessage({ t: "ping" } satisfies PanelMsg), 20_000);
    };
    connect();
    return () => {
      closed = true;
      clearInterval(ping);
      clearTimeout(retry);
      portRef.current?.disconnect();
    };
  }, [tabId]);

  return { state, send, dispatch };
}
