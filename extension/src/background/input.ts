/** Input engine over CDP (requirements section 7). Real mouse and keyboard are never touched. */
import { charToKeyEvent, parseKeySequence, parseModifierString, MOD, type Platform } from "@pi-browser/shared/keys";
import { send, sendRacingDialog, tabState } from "./cdp";
import { sendIndicator, sleep } from "./indicators";

export function platform(): Platform {
  const p = ((navigator as any).userAgentData?.platform ?? navigator.platform ?? "").toLowerCase();
  if (p.includes("mac")) return "mac";
  if (p.includes("win")) return "win";
  return "linux";
}

const BUTTON = { left: { name: "left", mask: 1 }, right: { name: "right", mask: 2 }, middle: { name: "middle", mask: 4 } } as const;
export type MouseButton = keyof typeof BUTTON;

async function tabIsVisible(tabId: number): Promise<boolean> {
  try {
    const t = await chrome.tabs.get(tabId);
    if (!t.active) return false;
    const w = await chrome.windows.get(t.windowId);
    return w.state !== "minimized";
  } catch {
    return false;
  }
}

export const parseModifiers = parseModifierString;

/** Image coordinates -> CSS pixels of the viewport (SHOT-09). Without a screenshot they are taken as CSS pixels. */
export function toViewport(tabId: number, x: number, y: number): [number, number] {
  const s = tabState(tabId).scale;
  if (!s) return [x, y];
  return [(x * s.viewportWidth) / s.imageWidth, (y * s.viewportHeight) / s.imageHeight];
}

export interface ClickOptions {
  button: MouseButton;
  count: number;
  modifiers: number;
  /** SEC-08 pre-check, run right before the press (step 4). */
  beforePress: () => Promise<void>;
}

/** 7.2 click sequence. */
export async function click(tabId: number, x: number, y: number, o: ClickOptions): Promise<void> {
  const visible = await tabIsVisible(tabId);
  await sendIndicator(tabId, { type: "HIDE_FOR_TOOL_USE", cursor: false });
  try {
    await sleep(50);
    await sendIndicator(tabId, { type: "UPDATE_PHANTOM_CURSOR", x, y });
    if (visible) await sleep(250);
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, modifiers: o.modifiers });
    if (visible) await sleep(300);
    await o.beforePress();
    const b = BUTTON[o.button];
    for (let i = 1; i <= o.count; i++) {
      await sendRacingDialog(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: b.name, buttons: b.mask, clickCount: i, modifiers: o.modifiers });
      await sleep(12);
      await sendRacingDialog(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: b.name, buttons: 0, clickCount: i, modifiers: o.modifiers });
      if (i < o.count) await sleep(100);
    }
  } finally {
    await sendIndicator(tabId, { type: "SHOW_AFTER_TOOL_USE" });
  }
}

/** INP-06: hover only moves. */
export async function hover(tabId: number, x: number, y: number, modifiers: number): Promise<void> {
  await sendIndicator(tabId, { type: "UPDATE_PHANTOM_CURSOR", x, y });
  if (await tabIsVisible(tabId)) await sleep(250);
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0, modifiers });
  if (await tabIsVisible(tabId)) await sleep(300);
}

export async function drag(tabId: number, x0: number, y0: number, x1: number, y1: number, beforePress: () => Promise<void>): Promise<void> {
  await sendIndicator(tabId, { type: "UPDATE_PHANTOM_CURSOR", x: x0, y: y0 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: x0, y: y0, button: "none", buttons: 0 });
  await beforePress();
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1 });
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    if (i === 1) await sendIndicator(tabId, { type: "UPDATE_PHANTOM_CURSOR", x: x1, y: y1 });
    await sleep(15);
  }
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1 });
}

/** INP-07 */
export async function scroll(tabId: number, x: number, y: number, direction: string, amount: number): Promise<void> {
  const px = amount * 100;
  const deltaX = direction === "left" ? -px : direction === "right" ? px : 0;
  const deltaY = direction === "up" ? -px : direction === "down" ? px : 0;
  await sendIndicator(tabId, { type: "UPDATE_PHANTOM_CURSOR", x, y });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX, deltaY });
}

/** INP-08/09 */
export async function typeText(tabId: number, text: string): Promise<void> {
  let pendingInsert = "";
  const flush = async () => {
    if (pendingInsert) {
      await send(tabId, "Input.insertText", { text: pendingInsert });
      pendingInsert = "";
    }
  };
  for (const ch of Array.from(text)) {
    const ev = charToKeyEvent(ch);
    if (!ev) {
      pendingInsert += ch;
      continue;
    }
    await flush();
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.windowsVirtualKeyCode, text: ev.text, unmodifiedText: ev.text, modifiers: ev.modifiers });
    await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ev.key, code: ev.code, windowsVirtualKeyCode: ev.windowsVirtualKeyCode, modifiers: ev.modifiers });
  }
  await flush();
}

/** INP-10/11 */
export async function pressKeys(tabId: number, text: string, repeat = 1): Promise<void> {
  const combos = parseKeySequence(text, platform());
  for (let r = 0; r < repeat; r++) {
    for (const c of combos) {
      if (!c.key) continue;
      const k = c.key;
      const hasCmd = (c.modifiers & (MOD.ctrl | MOD.alt | MOD.meta)) !== 0;
      const printable = !!k.text && !hasCmd;
      const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, modifiers: c.modifiers };
      if (printable) {
        await sendRacingDialog(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...base, text: k.text, unmodifiedText: k.text });
      } else {
        await sendRacingDialog(tabId, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, ...(c.commands.length ? { commands: c.commands } : {}) });
      }
      await sendRacingDialog(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
    }
  }
}
