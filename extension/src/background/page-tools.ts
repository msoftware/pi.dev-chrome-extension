/** read_page, get_page_text, form_input, javascript_tool and the internal __get_tree / __get_rects. */
import { filterOutput, redactKnownValues, REDACTED } from "@pi-browser/shared";
import { wrapPageContent } from "@pi-browser/shared/tab-context";
import { attach, send, sendRacingDialog, tabState } from "./cdp";
import { callAllFrames, callPage, frameOfRef } from "./page";
import { image, text, ToolError, type Out, type ToolEnv } from "./env";
import { preCheck } from "./security";
import { registrableDomain } from "../common/domain";

export interface TreeResult {
  pageContent?: string;
  viewport?: { width: number; height: number };
  error?: string;
}

export async function readPage(env: ToolEnv, tabId: number, a: { filter?: string; depth?: number; max_chars?: number; ref_id?: string }): Promise<Out> {
  const tab = await chrome.tabs.get(tabId);
  const maxChars = a.max_chars ?? 50_000;
  const opts = { filter: a.filter ?? "all", depth: a.depth ?? 15, maxChars, refId: a.ref_id };
  let body = "";
  let viewport = "";
  if (a.ref_id) {
    const r = await callPage<TreeResult>(tabId, "generate", [opts], frameOfRef(a.ref_id));
    if (r.error) throw new ToolError(r.error);
    body = r.pageContent ?? "";
    viewport = r.viewport ? `${r.viewport.width}x${r.viewport.height}` : "";
  } else {
    const frames = await callAllFrames<TreeResult>(tabId, "generate", [opts]);
    frames.sort((x, y) => x.frameId - y.frameId);
    const parts: string[] = [];
    let budget = maxChars;
    for (const f of frames) {
      if (f.result.error || !f.result.pageContent) continue;
      if (f.frameId === 0) viewport = f.result.viewport ? `${f.result.viewport.width}x${f.result.viewport.height}` : "";
      const chunk = f.frameId === 0 ? f.result.pageContent : `[iframe, frame ${f.frameId}]\n${f.result.pageContent}`;
      if (chunk.length > budget) {
        parts.push(chunk.slice(0, Math.max(0, budget)) + "\n[Output truncated: use a smaller depth, a ref_id, or a higher max_chars.]");
        break;
      }
      parts.push(chunk);
      budget -= chunk.length + 1;
    }
    body = parts.join("\n");
  }
  if (!body) body = "(no matching elements)";
  const head = `Page: ${tab.title ?? ""}\nURL: ${tab.url ?? ""}${viewport ? `\nViewport: ${viewport}` : ""}`;
  return { content: [text(`${head}\n\n${wrapPageContent(tab.url ?? "", body)}`)], details: { tabUrl: tab.url ?? "", tree: body } };
}

export async function getPageText(env: ToolEnv, tabId: number, a: { max_chars?: number }): Promise<Out> {
  const tab = await chrome.tabs.get(tabId);
  const r = await callPage<{ title: string; url: string; text: string; truncated: boolean }>(tabId, "extractText", [a.max_chars ?? 50_000]);
  const note = r.truncated ? "\n[Text truncated: use a higher max_chars.]" : "";
  return { content: [text(`Title: ${r.title}\nURL: ${r.url || tab.url}\n\n${wrapPageContent(r.url || tab.url || "", r.text || "(no text found)")}${note}`)], details: { tabUrl: tab.url ?? "" } };
}

export async function getRects(tabId: number, refs: string[]): Promise<Out> {
  const rects: Record<string, { x: number; y: number; w: number; h: number } | null> = {};
  const byFrame = new Map<number, string[]>();
  for (const r of refs) byFrame.set(frameOfRef(r), [...(byFrame.get(frameOfRef(r)) ?? []), r]);
  for (const [frame, list] of byFrame) {
    const res = await callPage<Record<string, any>>(tabId, "rects", [list], frame);
    Object.assign(rects, res);
  }
  // Convert viewport CSS pixels to screenshot coordinates of the last screenshot so the model can click them.
  const s = tabState(tabId).scale;
  if (s) {
    for (const k of Object.keys(rects)) {
      const r = rects[k];
      if (r) rects[k] = { x: (r.x * s.imageWidth) / s.viewportWidth, y: (r.y * s.imageHeight) / s.viewportHeight, w: (r.w * s.imageWidth) / s.viewportWidth, h: (r.h * s.imageHeight) / s.viewportHeight };
    }
  }
  return { content: [text("ok")], details: { rects } };
}

export async function formInput(env: ToolEnv, tabId: number, a: { ref: string; value: string | number | boolean }, authorizeSensitive: (sensitive: boolean) => Promise<void>): Promise<Out> {
  const frame = frameOfRef(a.ref);
  const info = await callPage<any>(tabId, "info", [a.ref], frame);
  if (info.error) throw new ToolError(info.error);
  await authorizeSensitive(!!info.sensitive);
  await preCheck(tabId, env.group.groupId, env.perms, "filling the field");
  const r = await callPage<{ text?: string; error?: string }>(tabId, "setValue", [a.ref, a.value], frame);
  if (r.error) throw new ToolError(r.error);
  return { content: [text(r.text ?? `Set ${a.ref}`)] };
}

const TIMEOUT_DEFAULT_MS = 30_000;

/** JS-02..04 */
export async function runJavaScript(env: ToolEnv, tabId: number, code: string, timeoutMs = TIMEOUT_DEFAULT_MS): Promise<Out> {
  await attach(tabId);
  // JS-07: collect values of sensitive fields first, so a directly read password cannot slip through the pattern filter.
  let secrets: string[] = [];
  try {
    secrets = (await callAllFrames<string[]>(tabId, "sensitiveValues")).flatMap((f) => f.result);
  } catch {
    /* content script unavailable */
  }
  const run = async (expression: string, replMode: boolean) => {
    const p = sendRacingDialog<any>(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      replMode,
      userGesture: true,
      timeout: timeoutMs,
      generatePreview: false,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const to = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new ToolError(`Execution aborted after ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs + 500);
    });
    try {
      return await Promise.race([p, to]);
    } catch (e) {
      if (e instanceof ToolError) await send(tabId, "Runtime.terminateExecution").catch(() => {});
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  let res = await run(`{\n${code}\n}`, true);
  if (res === undefined) return { content: [text(`The script opened a JavaScript ${tabState(tabId).dialog?.type ?? ""} dialog ("${(tabState(tabId).dialog?.message ?? "").slice(0, 100)}") and is waiting for it. Answer it with computer action key (Enter = accept, Escape = dismiss).`)] };
  const errText = (r: any) => String(r.exceptionDetails?.exception?.description ?? r.exceptionDetails?.text ?? "");
  if (res.exceptionDetails && /Illegal return statement/i.test(errText(res))) {
    res = await run(`(async () => {\n${code}\n})()`, false);
    if (res === undefined) return { content: [text("The script opened a JavaScript dialog and is waiting for it. Answer it with computer action key (Enter = accept, Escape = dismiss).")] };
  }
  let out: string;
  if (res.exceptionDetails) {
    out = `Error: ${errText(res).split("\n").slice(0, 6).join("\n")}`;
  } else {
    const r = res.result ?? {};
    const v = r.type === "undefined" ? undefined : "value" in r ? r.value : r.description ?? r.unserializableValue;
    out = filterOutput(v);
  }
  out = redactKnownValues(out, secrets, REDACTED);
  const tab = await chrome.tabs.get(tabId);
  return { content: [text(wrapPageContent(tab.url ?? "", out))], details: { tabUrl: tab.url ?? "", domain: registrableDomain(tab.url ?? "") } };
}

export { image };
