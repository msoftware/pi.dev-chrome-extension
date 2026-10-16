/** The `computer` tool (requirements 6.2, section 7, TOOL-01..03). */
import { attach, send, tabState } from "./cdp";
import { capture } from "./screenshot";
import * as input from "./input";
import { callPage, frameOfRef } from "./page";
import { image, text, ToolError, throwIfAborted, type Out, type ToolEnv } from "./env";
import { sleep } from "./indicators";
import { addTabToGroup } from "./tab-groups";

export interface NewTabNote {
  tabId: number;
  openerTabId?: number;
  at: number;
}
/** Fed by the service worker's tabs.onCreated listener. */
export const recentTabs: NewTabNote[] = [];
export function noteNewTab(n: NewTabNote) {
  recentTabs.push(n);
  while (recentTabs.length > 50) recentTabs.shift();
}

interface Args {
  action: string;
  coordinate?: [number, number];
  start_coordinate?: [number, number];
  ref?: string;
  text?: string;
  scroll_direction?: string;
  scroll_amount?: number;
  duration?: number;
  repeat?: number;
  region?: [number, number, number, number];
  modifiers?: string;
}

interface Target {
  x: number;
  y: number;
  label: string;
  linkHref?: string;
}

async function resolveTarget(tabId: number, a: Args, which: "coordinate" | "start_coordinate" = "coordinate"): Promise<Target> {
  if (a.ref) {
    const r = await callPage<any>(tabId, "rectOf", [a.ref, true], frameOfRef(a.ref)); // TOOL-01: scroll into view first
    if (r.error) throw new ToolError(r.error);
    const { x, y, w, h } = r.rect;
    const cx = x + w / 2;
    const cy = y + h / 2;
    const link = await callPage<any>(tabId, "linkOf", [{ ref: a.ref }], frameOfRef(a.ref)).catch(() => null);
    return { x: cx, y: cy, label: a.ref, linkHref: link?.href };
  }
  const c = a[which];
  if (!c || c.length !== 2) throw new ToolError(`${which === "coordinate" ? "coordinate" : "start_coordinate"} or ref is required for this action`);
  const [x, y] = input.toViewport(tabId, c[0], c[1]);
  const link = await callPage<any>(tabId, "linkOf", [{ x, y }]).catch(() => null);
  return { x, y, label: `(${Math.round(c[0])}, ${Math.round(c[1])})`, linkHref: link?.href };
}

async function afterAction(env: ToolEnv, tabId: number, since: number, notes: string[]) {
  await sleep(120);
  const st = tabState(tabId);
  if (st.dialog) notes.push(`A JavaScript ${st.dialog.type} dialog is open: "${st.dialog.message.slice(0, 200)}". Answer it with computer action key (Enter = accept, Escape = dismiss${st.dialog.type === "prompt" ? "; use type first to enter text" : ""}).`);
  // TOOL-02: a click that opened a tab reports its id
  const opened = recentTabs.filter((t) => t.openerTabId === tabId && t.at >= since);
  for (const t of opened) {
    try {
      await addTabToGroup(t.tabId, env.group.groupId);
    } catch {
      /* already grouped */
    }
    notes.push(`This opened a new tab: tabId ${t.tabId}. Use that tab ID for further actions on it.`);
  }
}

async function isMinimized(tabId: number): Promise<boolean> {
  try {
    const t = await chrome.tabs.get(tabId);
    return (await chrome.windows.get(t.windowId)).state === "minimized";
  } catch {
    return false;
  }
}

async function takeShot(env: ToolEnv, tabId: number, region?: [number, number, number, number]) {
  const shot = await capture(tabId, { sessionId: env.sessionId, region, guard: () => env.guard(tabId, "taking the screenshot") });
  env.shots.push(shot.id);
  return shot;
}

const CLICKS: Record<string, { button: input.MouseButton; count: number; verb: string }> = {
  left_click: { button: "left", count: 1, verb: "Clicked" },
  right_click: { button: "right", count: 1, verb: "Right-clicked" },
  double_click: { button: "left", count: 2, verb: "Double-clicked" },
  triple_click: { button: "left", count: 3, verb: "Triple-clicked" },
};

export async function computer(env: ToolEnv, tabId: number, a: Args): Promise<Out> {
  const tab = await chrome.tabs.get(tabId);
  const url = tab.url ?? "";
  const act = a.action;
  const notes: string[] = [];
  const since = Date.now();
  const st = tabState(tabId);

  // Dialog handling (AUX-05): while a dialog is open the page ignores input; the model answers via key / type.
  if (st.dialog && act !== "screenshot" && act !== "wait") {
    if (act === "key") {
      const k = (a.text ?? "").trim().toLowerCase();
      if (k === "enter" || k === "escape" || k === "esc") {
        await env.authorize({ tool: "computer", args: { action: "key" }, tabUrl: url, preview: `Answer ${st.dialog.type} dialog: ${k === "enter" ? "accept" : "dismiss"}` });
        await send(tabId, "Page.handleJavaScriptDialog", { accept: k === "enter", ...(st.dialog.type === "prompt" ? { promptText: st.dialogNotes.find((n) => n.startsWith("prompt:"))?.slice(7) ?? st.dialog.defaultPrompt ?? "" } : {}) });
        st.dialog = null;
        st.dialogNotes = st.dialogNotes.filter((n) => !n.startsWith("prompt:"));
        return { content: [text(`${k === "enter" ? "Accepted" : "Dismissed"} the dialog.`)] };
      }
    }
    if (act === "type" && st.dialog.type === "prompt") {
      st.dialogNotes = st.dialogNotes.filter((n) => !n.startsWith("prompt:"));
      st.dialogNotes.push(`prompt:${a.text ?? ""}`);
      return { content: [text(`Prompt text set. Press Enter to accept the dialog or Escape to dismiss it.`)] };
    }
    throw new ToolError(`A JavaScript ${st.dialog.type} dialog is blocking the page: "${st.dialog.message.slice(0, 200)}". Answer it first with computer action key (Enter = accept, Escape = dismiss).`);
  }

  switch (act) {
    case "screenshot": {
      await env.authorize({ tool: "computer", args: { action: act }, tabUrl: url, preview: "Take a screenshot" });
      const s = await takeShot(env, tabId);
      return { content: [text(`Screenshot taken (${s.width}x${s.height}).`), image(s.base64)], details: { screenshotId: s.id, tabUrl: url } };
    }
    case "zoom": {
      if (!a.region || a.region.length !== 4) throw new ToolError("region [x0, y0, x1, y1] is required for zoom");
      await env.authorize({ tool: "computer", args: { action: act }, tabUrl: url, preview: `Zoom into region ${a.region.map(Math.round).join(", ")}` });
      const s = await takeShot(env, tabId, a.region);
      return { content: [text(`Zoomed region captured (${s.width}x${s.height}). Click coordinates still refer to the last full screenshot.`), image(s.base64)], details: { screenshotId: s.id, tabUrl: url } };
    }
    case "scroll": {
      await env.authorize({ tool: "computer", args: { action: act }, tabUrl: url, preview: `Scroll ${a.scroll_direction ?? "down"}` });
      const vp = await callPage<any>(tabId, "viewportInfo").catch(() => ({ width: 800, height: 600 }));
      const c = a.coordinate ? input.toViewport(tabId, a.coordinate[0], a.coordinate[1]) : ([vp.width / 2, vp.height / 2] as [number, number]);
      await attach(tabId);
      await input.scroll(tabId, c[0], c[1], a.scroll_direction ?? "down", Math.min(10, Math.max(1, a.scroll_amount ?? 3)));
      await sleep(350);
      const s = await takeShot(env, tabId);
      return { content: [text(`Scrolled ${a.scroll_direction ?? "down"} by ${a.scroll_amount ?? 3}.`), image(s.base64)], details: { screenshotId: s.id, tabUrl: url } };
    }
    case "scroll_to": {
      if (!a.ref) throw new ToolError("ref is required for scroll_to");
      await env.authorize({ tool: "computer", args: { action: act }, tabUrl: url, preview: `Scroll ${a.ref} into view` });
      const r = await callPage<any>(tabId, "rectOf", [a.ref, true], frameOfRef(a.ref));
      if (r.error) throw new ToolError(r.error);
      return { content: [text(`Scrolled ${a.ref} into view.`)] };
    }
    case "left_click":
    case "right_click":
    case "double_click":
    case "triple_click": {
      await attach(tabId);
      const spec = CLICKS[act];
      const t = await resolveTarget(tabId, a);
      await env.authorize({ tool: "computer", args: { action: act }, tabUrl: url, linkTargetUrl: t.linkHref, preview: `${spec.verb} ${t.label}${t.linkHref ? ` (link to ${t.linkHref})` : ""}` });
      const minimized = await isMinimized(tabId);
      if (minimized) await callPage(tabId, "captureBlank", [true]).catch(() => {});
      await input.click(tabId, t.x, t.y, {
        button: spec.button,
        count: spec.count,
        modifiers: input.parseModifiers(a.modifiers),
        beforePress: () => env.guard(tabId, "the click"),
      });
      if (minimized) {
        const links = ((await callPage<string[]>(tabId, "captureBlank", [false]).catch(() => [])) ?? []).slice(0, 3);
        for (const href of links) {
          const nt = await chrome.tabs.create({ url: href, windowId: env.group.windowId, active: false });
          if (nt.id) {
            await addTabToGroup(nt.id, env.group.groupId).catch(() => {});
            notes.push(`Opened link in new tab: tabId ${nt.id} (${href}).`);
          }
        }
      }
      await afterAction(env, tabId, since, notes);
      return { content: [text([`${spec.verb} ${t.label}`, ...notes].join(". ").replace(/\.\./g, "."))] };
    }
    case "hover": {
      await attach(tabId);
      const t = await resolveTarget(tabId, a);
      await env.authorize({ tool: "computer", args: { action: act }, tabUrl: url, preview: `Hover ${t.label}` });
      await env.guard(tabId, "the hover");
      await input.hover(tabId, t.x, t.y, input.parseModifiers(a.modifiers));
      return { content: [text(`Hovered ${t.label}`)] };
    }
    case "left_click_drag": {
      await attach(tabId);
      const from = await resolveTarget(tabId, a, "start_coordinate");
      if (!a.coordinate) throw new ToolError("coordinate (drag end) is required");
      const [x1, y1] = input.toViewport(tabId, a.coordinate[0], a.coordinate[1]);
      await env.authorize({ tool: "computer", args: { action: act }, tabUrl: url, preview: `Drag from ${from.label} to (${Math.round(a.coordinate[0])}, ${Math.round(a.coordinate[1])})` });
      await input.drag(tabId, from.x, from.y, x1, y1, () => env.guard(tabId, "the drag"));
      await afterAction(env, tabId, since, notes);
      return { content: [text([`Dragged from ${from.label} to (${Math.round(a.coordinate[0])}, ${Math.round(a.coordinate[1])})`, ...notes].join(". "))] };
    }
    case "type": {
      if (a.text === undefined) throw new ToolError("text is required for type");
      await attach(tabId);
      const f = await callPage<any>(tabId, "focusedInfo").catch(() => ({ sensitive: false }));
      await env.authorize({ tool: "computer", args: { action: act }, tabUrl: url, sensitive: !!f.sensitive, preview: f.sensitive ? "Type into a password/card field (text hidden)" : `Type: ${a.text.length > 300 ? a.text.slice(0, 300) + "…" : a.text}` });
      await env.guard(tabId, "typing");
      await input.typeText(tabId, a.text);
      await afterAction(env, tabId, since, notes);
      return { content: [text([f.sensitive ? "Typed text into a sensitive field" : `Typed ${a.text.length} character(s)`, ...notes].join(". "))] };
    }
    case "key": {
      if (!a.text) throw new ToolError("text (key or key combination) is required for key");
      await attach(tabId);
      const f = await callPage<any>(tabId, "focusedInfo").catch(() => ({ sensitive: false }));
      await env.authorize({ tool: "computer", args: { action: act }, tabUrl: url, sensitive: !!f.sensitive && /^[^+\s]$/.test(a.text), preview: `Press: ${a.text}${a.repeat && a.repeat > 1 ? ` x${a.repeat}` : ""}` });
      await env.guard(tabId, "the key press");
      try {
        await input.pressKeys(tabId, a.text, Math.min(100, Math.max(1, a.repeat ?? 1)));
      } catch (e: any) {
        throw new ToolError(String(e?.message ?? e));
      }
      await afterAction(env, tabId, since, notes);
      return { content: [text([`Pressed ${a.text}${a.repeat && a.repeat > 1 ? ` x${a.repeat}` : ""}`, ...notes].join(". "))] };
    }
    case "wait": {
      const d = Math.min(30, Math.max(0, a.duration ?? 1));
      const end = Date.now() + d * 1000;
      while (Date.now() < end) {
        throwIfAborted(env);
        await sleep(Math.min(250, end - Date.now()));
      }
      return { content: [text(`Waited ${d} second(s)`)] };
    }
    default:
      throw new ToolError(`Unknown computer action "${act}"`);
  }
}
