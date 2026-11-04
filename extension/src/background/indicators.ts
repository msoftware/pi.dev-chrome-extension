/** Messages from the service worker to the page indicator (IND-01). Failures are ignored: the tab may have no content script. */
export type CursorEffect =
  | { kind: "click"; button?: "left" | "right" | "middle"; count?: number }
  | { kind: "press" }
  | { kind: "release" }
  | { kind: "type" };

export type IndicatorMsg =
  | { type: "SHOW_AGENT_INDICATORS" }
  | { type: "HIDE_AGENT_INDICATORS" }
  | { type: "HIDE_FOR_TOOL_USE"; cursor?: boolean }
  | { type: "SHOW_AFTER_TOOL_USE" }
  | { type: "SHOW_STATIC_INDICATOR" }
  | { type: "HIDE_STATIC_INDICATOR" }
  /**
   * Animates the phantom cursor to (x, y) in top-viewport CSS pixels. The page answers once the cursor has arrived.
   * `fromX/fromY` is the last known position, used when the content script was reloaded (navigation) and lost its own.
   */
  | { type: "UPDATE_PHANTOM_CURSOR"; x: number; y: number; fromX?: number; fromY?: number; duration?: number; pressed?: boolean }
  | ({ type: "PHANTOM_CURSOR_EFFECT" } & CursorEffect);

/** Upper bound for a cursor flight; stays below the 700 ms answer timeout of sendIndicator. */
export const MAX_CURSOR_MS = 600;

/**
 * Failures are ignored, and so is a silent page: a page blocked by a modal dialog never answers, so the wait is bounded.
 */
export async function sendIndicator(tabId: number, msg: IndicatorMsg): Promise<void> {
  try {
    await Promise.race([chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }), new Promise((r) => setTimeout(r, 700))]);
  } catch {
    /* no receiver */
  }
}

/** Last phantom cursor position per tab, so the cursor keeps flying from where it was even after a page load. */
const lastCursor = new Map<number, { x: number; y: number }>();

export function forgetCursor(tabId: number) {
  lastCursor.delete(tabId);
}

export interface MoveOptions {
  /** Show the cursor in its "button held" state (drag). */
  pressed?: boolean;
  /** Fixed flight time in ms (drag syncs it with the dispatched mouse moves); otherwise derived from the distance. */
  duration?: number;
}

/** Moves the phantom cursor to where the next action happens; resolves when it has arrived (or after the timeout). */
export async function moveCursor(tabId: number, x: number, y: number, o: MoveOptions = {}): Promise<void> {
  const from = lastCursor.get(tabId);
  lastCursor.set(tabId, { x, y });
  await sendIndicator(tabId, {
    type: "UPDATE_PHANTOM_CURSOR",
    x,
    y,
    ...(from ? { fromX: from.x, fromY: from.y } : {}),
    ...(o.duration !== undefined ? { duration: Math.min(MAX_CURSOR_MS, Math.max(0, o.duration)) } : {}),
    ...(o.pressed !== undefined ? { pressed: o.pressed } : {}),
  });
}

export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Moves the cursor to the centre of a rect (top-viewport CSS pixels). */
export function moveCursorToRect(tabId: number, r: ViewRect | null | undefined, o?: MoveOptions): Promise<void> {
  if (!r) return Promise.resolve();
  return moveCursor(tabId, r.x + r.w / 2, r.y + r.h / 2, o);
}

/** Visual feedback at the current cursor position (ripple for clicks, pressed state for drags, typing badge). */
export async function cursorEffect(tabId: number, effect: CursorEffect): Promise<void> {
  if (!lastCursor.has(tabId)) return;
  await sendIndicator(tabId, { type: "PHANTOM_CURSOR_EFFECT", ...effect });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
