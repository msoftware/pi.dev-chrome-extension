/** Screenshot pipeline (requirements section 8). */
import {
  DEFAULT_BUDGET,
  JPEG_MIN_QUALITY,
  JPEG_QUALITY_STEP,
  JPEG_START_QUALITY,
  MAX_BASE64_CHARS,
  jpegSize,
  targetSize,
} from "@pi-browser/shared/scaling";
import { ensureFocusEmulation, send, tabState } from "./cdp";
import { putShot, enforceShotBudget } from "../common/idb";
import { sendIndicator, sleep } from "./indicators";
import { callPage } from "./page";

export interface Shot {
  id: string;
  base64: string;
  width: number;
  height: number;
  mime: "image/jpeg";
}

interface Viewport {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

export function newShotId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "ss_";
  const rnd = crypto.getRandomValues(new Uint8Array(9));
  for (const b of rnd) s += chars[b % chars.length];
  return s;
}

async function viewport(tabId: number): Promise<Viewport> {
  try {
    return await callPage<Viewport>(tabId, "viewportInfo");
  } catch {
    const m = await send<any>(tabId, "Page.getLayoutMetrics");
    const v = m.cssVisualViewport ?? m.visualViewport;
    const dpr = (await send<any>(tabId, "Runtime.evaluate", { expression: "window.devicePixelRatio", returnByValue: true })).result?.value ?? 1;
    return { width: v.clientWidth, height: v.clientHeight, devicePixelRatio: dpr, scrollX: v.pageX ?? 0, scrollY: v.pageY ?? 0 };
  }
}

function b64Bytes(b64: string, n = 4096): Uint8Array {
  const slice = b64.slice(0, Math.ceil(n / 3) * 4);
  const bin = atob(slice);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function downscale(b64: string, width: number, height: number, quality: number): Promise<string> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  const c = new OffscreenCanvas(width, height);
  c.getContext("2d")!.drawImage(bmp, 0, 0, width, height);
  const blob = await c.convertToBlob({ type: "image/jpeg", quality });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** AUX-06: a hidden tab does not paint; force one frame at minimal quality before the real capture. */
async function prepareBackground(tabId: number): Promise<() => Promise<void>> {
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  const hidden = !tab.active || win.state === "minimized";
  if (!hidden) return async () => {};
  const wasMuted = tab.mutedInfo?.muted ?? false;
  if (!wasMuted) await chrome.tabs.update(tabId, { muted: true }).catch(() => {});
  await ensureFocusEmulation(tabId, true).catch(() => {});
  await send(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 1 }).catch(() => {});
  return async () => {
    if (!wasMuted) await chrome.tabs.update(tabId, { muted: false }).catch(() => {});
  };
}

export interface CaptureOptions {
  sessionId: string;
  /** zoom region in image coordinates of the last screenshot */
  region?: [number, number, number, number];
  /** Called after indicators are hidden and before the actual capture (SEC-08). */
  guard?: () => Promise<void>;
}

/** Captures the viewport (or a zoom region) with the tile budget applied. */
export async function capture(tabId: number, opts: CaptureOptions): Promise<Shot & { viewport: Viewport; zoom?: boolean }> {
  await sendIndicator(tabId, { type: "HIDE_FOR_TOOL_USE" }); // SHOT-07
  let restoreBg: (() => Promise<void>) | null = null;
  try {
    await opts.guard?.(); // SHOT-08
    restoreBg = await prepareBackground(tabId);
    await sleep(30);
    const vp = await viewport(tabId);
    const st = tabState(tabId);
    let clip: { x: number; y: number; width: number; height: number; scale: number };
    let expected: { width: number; height: number };
    if (opts.region) {
      if (!st.scale) throw new Error("Take a screenshot before using zoom (coordinates refer to the latest screenshot).");
      const [x0, y0, x1, y1] = opts.region;
      const sx = st.scale.viewportWidth / st.scale.imageWidth;
      const sy = st.scale.viewportHeight / st.scale.imageHeight;
      const cw = Math.max(1, (x1 - x0) * sx);
      const ch = Math.max(1, (y1 - y0) * sy);
      const phys = targetSize(cw * vp.devicePixelRatio, ch * vp.devicePixelRatio, DEFAULT_BUDGET);
      clip = { x: vp.scrollX + x0 * sx, y: vp.scrollY + y0 * sy, width: cw, height: ch, scale: phys.width / cw };
      expected = phys;
    } else {
      const phys = targetSize(vp.width * vp.devicePixelRatio, vp.height * vp.devicePixelRatio, DEFAULT_BUDGET); // SHOT-01..03
      clip = { x: vp.scrollX, y: vp.scrollY, width: vp.width, height: vp.height, scale: phys.width / vp.width };
      expected = phys;
    }
    let quality = JPEG_START_QUALITY;
    let data = "";
    for (;;) {
      const r = await send<{ data: string }>(tabId, "Page.captureScreenshot", {
        format: "jpeg",
        quality: Math.round(quality * 100),
        captureBeyondViewport: false,
        fromSurface: true,
        clip,
      });
      data = r.data;
      if (data.length <= MAX_BASE64_CHARS || quality - JPEG_QUALITY_STEP < JPEG_MIN_QUALITY - 1e-9) break;
      quality = Math.max(JPEG_MIN_QUALITY, quality - JPEG_QUALITY_STEP); // SHOT-05
    }
    // SHOT-06: verify the real pixel size; fall back to a full capture + OffscreenCanvas downscale.
    let size = jpegSize(b64Bytes(data));
    if (!size || Math.abs(size.width - expected.width) > 1 || Math.abs(size.height - expected.height) > 1) {
      const full = await send<{ data: string }>(tabId, "Page.captureScreenshot", { format: "jpeg", quality: Math.round(quality * 100), fromSurface: true });
      data = await downscale(full.data, expected.width, expected.height, quality);
      size = { width: expected.width, height: expected.height };
    }
    const id = newShotId();
    const bytes = Math.floor((data.length * 3) / 4);
    await putShot({ id, sessionId: opts.sessionId, tabId, ts: Date.now(), mime: "image/jpeg", width: size.width, height: size.height, bytes, data });
    void enforceShotBudget(opts.sessionId);
    if (!opts.region) {
      st.scale = { imageWidth: size.width, imageHeight: size.height, viewportWidth: vp.width, viewportHeight: vp.height, devicePixelRatio: vp.devicePixelRatio, screenshotId: id };
    }
    return { id, base64: data, width: size.width, height: size.height, mime: "image/jpeg", viewport: vp, zoom: !!opts.region };
  } finally {
    await restoreBg?.();
    await sendIndicator(tabId, { type: "SHOW_AFTER_TOOL_USE" });
  }
}
