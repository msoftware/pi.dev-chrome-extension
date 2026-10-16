/** Console, network, uploads, window resizing (section 13). */
import { attach, send, tabState } from "./cdp";
import { callPage, frameOfRef } from "./page";
import { getShot } from "../common/idb";
import { registrableDomain } from "../common/domain";
import { text, ToolError, type Out, type ToolEnv } from "./env";
import { wrapPageContent } from "@pi-browser/shared/tab-context";

const hhmmss = (ts: number) => new Date(ts).toTimeString().slice(0, 8);

/** AUX-01: only the current domain's messages are returned. */
export async function readConsole(env: ToolEnv, tabId: number, a: { onlyErrors?: boolean; pattern?: string; limit?: number; clear?: boolean }): Promise<Out> {
  await attach(tabId);
  const tab = await chrome.tabs.get(tabId);
  const st = tabState(tabId);
  let re: RegExp | null = null;
  if (a.pattern) {
    try {
      re = new RegExp(a.pattern, "i");
    } catch {
      throw new ToolError(`Invalid regular expression: ${a.pattern}`);
    }
  }
  const cur = registrableDomain(tab.url ?? "");
  let list = st.console.filter((e) => !e.host || registrableDomain(e.host) === cur);
  if (a.onlyErrors) list = list.filter((e) => e.level === "error" || e.level === "assert");
  if (re) list = list.filter((e) => re!.test(e.text));
  list = list.slice(-(a.limit ?? 100));
  if (a.clear) st.console = [];
  const body = list.length
    ? list.map((e) => `[${hhmmss(e.ts)}] [${e.level}] ${e.text.slice(0, 500)}`).join("\n")
    : "No console messages. (Capture starts when the debugger first attaches to the tab; reload the page to capture its startup messages.)";
  return { content: [text(wrapPageContent(tab.url ?? "", body))], details: { count: list.length } };
}

export async function readNetwork(env: ToolEnv, tabId: number, a: { urlPattern?: string; limit?: number; clear?: boolean }): Promise<Out> {
  await attach(tabId);
  const tab = await chrome.tabs.get(tabId);
  const st = tabState(tabId);
  let list = st.netOrder.map((id) => st.net.get(id)!).filter(Boolean);
  if (a.urlPattern) {
    const p = a.urlPattern.toLowerCase();
    list = list.filter((e) => e.url.toLowerCase().includes(p));
  }
  list = list.slice(-(a.limit ?? 100));
  if (a.clear) {
    st.net.clear();
    st.netOrder = [];
  }
  const fmt = (e: (typeof list)[number]) => {
    // AUX-03: headers (Authorization, Cookie, Set-Cookie) are never recorded; URLs are shown without credentials.
    let u = e.url;
    try {
      const x = new URL(e.url);
      x.username = "";
      x.password = "";
      u = x.toString();
    } catch {
      /* keep */
    }
    const size = e.size !== undefined ? ` ${e.size > 1024 ? `${(e.size / 1024).toFixed(1)} KB` : `${e.size} B`}` : "";
    return `${e.method} ${u.slice(0, 300)} -> ${e.failed ? `FAILED (${e.failed})` : (e.status ?? "pending")} ${e.type ?? ""}${e.durationMs !== undefined ? ` ${e.durationMs} ms` : ""}${size}${e.postData ? `\n  body: ${e.postData.slice(0, 500)}` : ""}`;
  };
  const body = list.length ? list.map(fmt).join("\n") : "No network requests recorded for this tab yet (capture starts when the debugger attaches).";
  return { content: [text(wrapPageContent(tab.url ?? "", body))], details: { count: list.length } };
}

/** upload_image (AUX-10) */
export async function uploadImage(env: ToolEnv, tabId: number, a: { imageId: string; ref?: string; coordinate?: [number, number]; filename?: string }): Promise<Out> {
  const shot = await getShot(a.imageId);
  if (!shot) throw new ToolError(`Unknown image ${a.imageId}. Use the screenshotId returned by a screenshot.`);
  if (!shot.data) throw new ToolError(`Image ${a.imageId} was removed to save space (session image limit). Take a new screenshot.`);
  const name = a.filename || `${a.imageId}.${shot.mime === "image/gif" ? "gif" : "jpg"}`;
  const tab = await chrome.tabs.get(tabId);
  await env.authorize({ tool: "upload_image", args: a as any, tabUrl: tab.url ?? "", preview: `Attach image ${name}${a.ref ? ` to ${a.ref}` : ""}` });
  await env.guard(tabId, "the upload");
  let target: { ref?: string; x?: number; y?: number };
  let frame = 0;
  if (a.ref) {
    target = { ref: a.ref };
    frame = frameOfRef(a.ref);
  } else if (a.coordinate) {
    const { toViewport } = await import("./input");
    const [x, y] = toViewport(tabId, a.coordinate[0], a.coordinate[1]);
    target = { x, y };
  } else throw new ToolError("ref or coordinate is required");
  const r = await callPage<{ text?: string; error?: string }>(tabId, "placeImage", [shot.data, shot.mime, name, target], frame);
  if (r.error) throw new ToolError(r.error);
  return { content: [text(r.text ?? "Image placed.")] };
}

/** file_upload (AUX-08). Paths were validated by the bridge (AUX-09). */
export async function fileUpload(env: ToolEnv, tabId: number, a: { paths: string[]; ref: string }): Promise<Out> {
  const tab = await chrome.tabs.get(tabId);
  await env.authorize({ tool: "file_upload", args: a as any, tabUrl: tab.url ?? "", preview: `Attach ${a.paths.map((p) => p.split(/[\\/]/).pop()).join(", ")} to ${a.ref}` });
  await env.guard(tabId, "the file upload");
  await attach(tabId);
  const token = crypto.randomUUID().replace(/-/g, "");
  const frame = frameOfRef(a.ref);
  const tagged = await callPage<{ ok?: boolean; error?: string }>(tabId, "tagForUpload", [a.ref, token], frame);
  if (tagged.error) throw new ToolError(tagged.error);
  try {
    const doc = await send<any>(tabId, "DOM.getDocument", { depth: 0 });
    const q = await send<any>(tabId, "DOM.querySelector", { nodeId: doc.root.nodeId, selector: `[data-pi-upload="${token}"]` });
    if (!q.nodeId) throw new ToolError("Could not locate the file input in the page (inputs inside shadow roots or cross-origin frames are not supported).");
    await send(tabId, "DOM.setFileInputFiles", { files: a.paths, nodeId: q.nodeId });
  } finally {
    await callPage(tabId, "untagUpload", [token], frame).catch(() => {});
  }
  return { content: [text(`Attached ${a.paths.length} file(s) to ${a.ref}.`)] };
}

export async function resizeWindow(env: ToolEnv, tabId: number, a: { width: number; height: number }): Promise<Out> {
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { width: Math.round(a.width), height: Math.round(a.height), state: "normal" });
  return { content: [text(`Resized the window to ${a.width}x${a.height}.`)] };
}
