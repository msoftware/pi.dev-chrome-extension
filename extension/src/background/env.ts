import type { ContentBlock, ToolRequest } from "@pi-browser/shared";
import type { Resolved } from "../common/storage";
import type { GroupSession } from "./tab-groups";
import type { PermissionManager } from "./permissions";

export interface AuthExtras {
  tool?: string;
  args?: Record<string, unknown>;
  tabUrl: string;
  targetUrl?: string;
  linkTargetUrl?: string;
  sensitive?: boolean;
  preview: string;
}

export interface Out {
  content: ContentBlock[];
  details?: Record<string, unknown>;
}

export const text = (t: string): ContentBlock => ({ type: "text", text: t });
export const image = (data: string, mimeType = "image/jpeg"): ContentBlock => ({ type: "image", mimeType, data });

/** Everything a tool implementation needs, assembled per request by the executor. */
export interface ToolEnv {
  req: ToolRequest;
  /** In a batch: the id of the single sub-action, otherwise the request's toolCallId. */
  toolCallId: string;
  signal: AbortSignal;
  group: GroupSession;
  perms: PermissionManager;
  settings: Resolved;
  sessionId: string;
  progress(message: string, index?: number, total?: number): void;
  /** Runs the permission check (dialog if needed); throws ToolError when denied. */
  authorize(x: AuthExtras): Promise<void>;
  /** SEC-08 pre-check on the tab. */
  guard(tabId: number, what: string): Promise<void>;
  /** Collected screenshot ids for the panel's tool log. */
  shots: string[];
  /** Whether this call runs inside browser_batch (affects result shape only). */
  inBatch: boolean;
}

export class ToolError extends Error {}

export function throwIfAborted(env: ToolEnv) {
  if (env.signal.aborted) throw new ToolError("Cancelled");
}
