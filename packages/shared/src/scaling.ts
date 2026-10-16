/** Screenshot target size (requirements section 8.1). */

export interface ScreenshotBudget {
  tile: number;
  maxTiles: number;
  maxEdge: number;
}

export const DEFAULT_BUDGET: ScreenshotBudget = { tile: 28, maxTiles: 1568, maxEdge: 1568 };

export function fitsBudget(w: number, h: number, b: ScreenshotBudget = DEFAULT_BUDGET): boolean {
  if (w > b.maxEdge || h > b.maxEdge) return false;
  return Math.ceil(w / b.tile) * Math.ceil(h / b.tile) <= b.maxTiles;
}

/** Returns the unchanged size if it fits, otherwise the largest same-aspect size that does (binary search on the long edge). */
export function targetSize(w: number, h: number, b: ScreenshotBudget = DEFAULT_BUDGET): { width: number; height: number } {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (fitsBudget(w, h, b)) return { width: w, height: h };
  const landscape = w >= h;
  const long = landscape ? w : h;
  const short = landscape ? h : w;
  const ratio = short / long;
  const make = (l: number) => {
    const s = Math.max(1, Math.round(l * ratio));
    return landscape ? { width: l, height: s } : { width: s, height: l };
  };
  let lo = 1;
  let hi = long;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const c = make(mid);
    if (fitsBudget(c.width, c.height, b)) lo = mid;
    else hi = mid - 1;
  }
  return make(lo);
}

export interface ScaleContext {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
}

/** Converts model (image) coordinates to CSS pixels of the viewport (SHOT-09). */
export function imageToViewport(x: number, y: number, c: ScaleContext): [number, number] {
  return [(x * c.viewportWidth) / c.imageWidth, (y * c.viewportHeight) / c.imageHeight];
}

export const MAX_BASE64_CHARS = 1_398_100;
export const JPEG_START_QUALITY = 0.75;
export const JPEG_QUALITY_STEP = 0.05;
export const JPEG_MIN_QUALITY = 0.1;

/** Reads width/height from a JPEG's SOF marker; null if not found. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}
