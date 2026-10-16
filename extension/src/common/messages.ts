import type { BridgeEvent, ModelsResponse, PermissionMode, PermissionType, SessionSummary, TabContextEntry } from "@pi-browser/shared";

export type BridgeStatus = "disconnected" | "connecting" | "connected" | "unpaired" | "unauthorized";

export interface StatusInfo {
  bridge: BridgeStatus;
  port: number;
  model: string | null;
  piVersion?: string;
  bridgeVersion?: string;
  running: boolean;
  permissionMode: PermissionMode;
  policyLocked: { permissionMode: boolean; js: boolean };
  error?: string;
}

export interface ApprovalRequest {
  id: string;
  type: PermissionType;
  domain: string;
  tool: string;
  action: string;
  preview: string;
  onceOnly: boolean;
  /** For update_plan: the plan itself. */
  plan?: { domains: string[]; approach: string[] };
  toolCallId: string;
}

export interface ToolLogEntry {
  toolCallId: string;
  tool: string;
  summary: string;
  ok?: boolean;
  text?: string;
  screenshotIds?: string[];
  progress?: { message: string; index?: number; total?: number }[];
  done: boolean;
}

export interface PickResult {
  kind: "area" | "element";
  imageData?: string;
  mime?: string;
  selector?: string;
  text?: string;
  a11y?: string;
}

/** Panel -> service worker (over a long-lived port). */
export type PanelMsg =
  | { t: "hello"; tabId: number }
  | { t: "ping" }
  | { t: "prompt"; text: string; attachments?: { mimeType: string; data: string; name?: string }[] }
  | { t: "steer"; text: string }
  | { t: "abort" }
  | { t: "pair"; code: string }
  | { t: "unpair" }
  | { t: "refresh" }
  | { t: "setConfig"; model?: string; thinkingLevel?: string; permissionMode?: PermissionMode }
  | { t: "newSession" }
  | { t: "loadSession"; id: string }
  | { t: "approval"; id: string; decision: "once" | "always" | "deny" }
  | { t: "pick"; kind: "area" | "element" }
  | { t: "captureTab" }
  | { t: "runShortcut"; id: string; params?: Record<string, string> }
  | { t: "dialogAnswer"; tabId: number; accept: boolean; text?: string }
  | { t: "recordWorkflow"; action: "start" | "stop"; name?: string };

/** Service worker -> panel. */
export type SwMsg =
  | { t: "status"; status: StatusInfo; paired: boolean }
  | { t: "event"; event: BridgeEvent }
  | { t: "models"; models: ModelsResponse }
  | { t: "sessions"; sessions: SessionSummary[]; current: string | null }
  | { t: "history"; sessionId: string; messages: HistoryMessage[] }
  | { t: "approval_request"; request: ApprovalRequest }
  | { t: "approval_done"; id: string }
  | { t: "tool_log"; entry: ToolLogEntry }
  | { t: "tabs"; tabs: TabContextEntry[] }
  | { t: "picked"; result: PickResult | { error: string } }
  | { t: "captured"; mimeType: string; data: string }
  | { t: "dialog"; tabId: number; info: { type: string; message: string; url: string } | null }
  | { t: "recording"; active: boolean; steps: number }
  | { t: "close_side_panel" }
  | { t: "toast"; message: string; level?: "info" | "error" };

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  text: string;
  tools?: { id: string; name: string; args: unknown }[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/** One-shot runtime messages (content script / panel / options -> service worker). */
export type RuntimeMsg =
  | { type: "FRAME_ID" }
  | { type: "STOP_AGENT" }
  | { type: "SWITCH_TO_MAIN_TAB" }
  | { type: "HIDE_STATIC_INDICATOR_REQUEST" }
  | { type: "INDICATOR_HEARTBEAT"; active: boolean }
  | { type: "OFFSCREEN_DONE"; id: string; result?: unknown; error?: string };
