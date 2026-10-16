/** Wire protocol between the Chrome extension and pi-browser-bridge (HTTP + SSE). */

export const BRIDGE_VERSION = "0.1.0";
export const DEFAULT_PORT = 47823;
export const HEARTBEAT_MS = 15_000;
export const EVENT_BACKLOG_COUNT = 500;
export const EVENT_BACKLOG_MS = 5 * 60_000;
export const DEFAULT_TOOL_DEADLINE_MS = 120_000;
export const PAIRING_CODE_TTL_MS = 5 * 60_000;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export interface ToolRequest {
  requestId: string;
  toolCallId: string;
  tool: string;
  args: Record<string, unknown>;
  sessionId: string;
  deadlineMs: number;
}

export interface ToolResult {
  requestId: string;
  ok: boolean;
  content: ContentBlock[];
  details?: Record<string, unknown>;
  /** Usage reported by helper model calls (find). */
  usage?: unknown;
}

export interface ToolProgress {
  requestId: string;
  message: string;
  index?: number;
  total?: number;
}

export type RunState = "started" | "ended" | "settled";

export type BridgeEvent =
  | { type: "hello"; sessionId: string; model: string | null; bridgeVersion: string }
  | { type: "run_state"; state: RunState; aborted?: boolean }
  | { type: "assistant_delta"; text: string }
  | { type: "assistant_message"; text: string; thinking?: string }
  | { type: "user_message"; text: string; source: "terminal" | "panel" }
  | { type: "tool_request"; request: ToolRequest }
  | { type: "tool_cancel"; requestId: string }
  | { type: "tool_activity"; phase: "start" | "end"; toolCallId: string; toolName: string; summary: string; isError?: boolean }
  | { type: "error"; message: string }
  | { type: "heartbeat" };

export interface SequencedEvent {
  id: number;
  event: BridgeEvent;
}

export interface TabContextEntry {
  id: number;
  title: string;
  url: string;
}

export interface PromptBody {
  text: string;
  attachments?: { mimeType: string; data: string; name?: string }[];
  tabContext?: TabContextEntry[];
}

export interface HealthResponse {
  bridgeVersion: string;
  piVersion: string;
  paired: boolean;
  model: string | null;
  sessionId: string;
}

export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
  reasoning: boolean;
}

export interface ModelsResponse {
  models: ModelInfo[];
  thinkingLevels: string[];
  current: { model: string | null; thinkingLevel: string };
}

export interface ConfigBody {
  model?: string;
  thinkingLevel?: string;
  permissionMode?: PermissionMode;
}

export type PermissionMode = "ask" | "plan" | "auto";

export interface SessionSummary {
  id: string;
  name: string;
  updatedAt: number;
}

export interface BridgeFileConfig {
  port?: number;
  /** Provider/model id used for `find` and the auto-mode check; defaults to the cheapest available. */
  helperModel?: string;
  /** Tool names disabled by configuration. */
  disabledTools?: string[];
  /** Extra directories file_upload may read from. */
  uploadRoots?: string[];
  extensionId?: string;
  debug?: boolean;
}
