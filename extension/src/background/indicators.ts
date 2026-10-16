/** Messages from the service worker to the page indicator (IND-01). Failures are ignored: the tab may have no content script. */
export type IndicatorMsg =
  | { type: "SHOW_AGENT_INDICATORS" }
  | { type: "HIDE_AGENT_INDICATORS" }
  | { type: "HIDE_FOR_TOOL_USE"; cursor?: boolean }
  | { type: "SHOW_AFTER_TOOL_USE" }
  | { type: "SHOW_STATIC_INDICATOR" }
  | { type: "HIDE_STATIC_INDICATOR" }
  | { type: "UPDATE_PHANTOM_CURSOR"; x: number; y: number };

export async function sendIndicator(tabId: number, msg: IndicatorMsg): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch {
    /* no receiver */
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
