/** Helpers around chrome.scripting for the isolated-world page API (content/a11y-tree.ts). */

type Api = Record<string, (...args: any[]) => any>;

function runner(method: string, args: unknown[]) {
  const api = (globalThis as unknown as { __piA11y?: Api }).__piA11y;
  if (!api) return { __missing: true };
  return Promise.resolve(api[method](...args)).then((r) => ({ value: r }));
}

async function contentScriptFiles(): Promise<string[]> {
  const cs = chrome.runtime.getManifest().content_scripts ?? [];
  const entry = cs.find((c) => c.all_frames);
  return entry?.js ?? [];
}

export interface FrameResult<T> {
  frameId: number;
  result: T;
}

/** EXT-10: tabs that were open before installation have no content script yet; inject it instead of asking for a reload. */
export async function ensureContent(tabId: number): Promise<void> {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!(globalThis as any).__piA11y });
    if (r?.[0]?.result) return;
  } catch (e: any) {
    throw new Error(`Cannot access this page (${String(e?.message ?? e)}).`);
  }
  const files = await contentScriptFiles();
  if (!files.length) throw new Error("Content script file not found in manifest");
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
}

export async function callPage<T = any>(tabId: number, method: string, args: unknown[] = [], frameId = 0): Promise<T> {
  await ensureContent(tabId);
  const res = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func: runner, args: [method, args] });
  const out = res?.[0]?.result as { __missing?: boolean; value?: T } | undefined;
  if (!out || out.__missing) throw new Error("Page helper is not available in this frame");
  return out.value as T;
}

export async function callAllFrames<T = any>(tabId: number, method: string, args: unknown[] = []): Promise<FrameResult<T>[]> {
  await ensureContent(tabId);
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: runner, args: [method, args] });
  const out: FrameResult<T>[] = [];
  for (const r of res ?? []) {
    const v = r.result as { __missing?: boolean; value?: T } | undefined;
    if (v && !v.__missing) out.push({ frameId: r.frameId ?? 0, result: v.value as T });
  }
  return out;
}

/** Ref numbers carry their frame: frameId * 100000 + n (see content/a11y-tree.ts). */
export function frameOfRef(ref: string): number {
  const n = Number.parseInt(ref.replace(/^ref_/, ""), 10);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n / 100_000);
}
