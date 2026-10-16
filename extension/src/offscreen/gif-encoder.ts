/** Minimal animated GIF89a encoder (web-safe 216-colour palette + optional Floyd-Steinberg dithering). No dependencies. */

export function buildPalette(): Uint8Array {
  const p = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    p[i++] = r * 51;
    p[i++] = g * 51;
    p[i++] = b * 51;
  }
  // 40 extra grey levels for smoother gradients
  for (let k = 0; k < 40; k++) {
    const v = Math.round(((k + 0.5) * 255) / 40);
    p[i++] = v;
    p[i++] = v;
    p[i++] = v;
  }
  return p;
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** RGBA -> palette indices. */
export function quantize(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, dither: boolean): Uint8Array {
  const out = new Uint8Array(w * h);
  const pal = buildPalette();
  const err = dither ? new Float32Array(w * h * 3) : null;
  const nearest = (r: number, g: number, b: number): number => {
    const ri = Math.round(r / 51), gi = Math.round(g / 51), bi = Math.round(b / 51);
    let best = ri * 36 + gi * 6 + bi;
    let bd = (pal[best * 3] - r) ** 2 + (pal[best * 3 + 1] - g) ** 2 + (pal[best * 3 + 2] - b) ** 2;
    // try the grey ramp when the colour is (almost) grey
    if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) {
      const avg = (r + g + b) / 3;
      const k = Math.min(39, Math.max(0, Math.round((avg * 40) / 255 - 0.5)));
      const gi2 = 216 + k;
      const d = (pal[gi2 * 3] - r) ** 2 + (pal[gi2 * 3 + 1] - g) ** 2 + (pal[gi2 * 3 + 2] - b) ** 2;
      if (d < bd) {
        best = gi2;
        bd = d;
      }
    }
    return best;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      if (err) {
        r = clamp(r + err[i * 3]);
        g = clamp(g + err[i * 3 + 1]);
        b = clamp(b + err[i * 3 + 2]);
      }
      const idx = nearest(r, g, b);
      out[i] = idx;
      if (err) {
        const er = r - pal[idx * 3], eg = g - pal[idx * 3 + 1], eb = b - pal[idx * 3 + 2];
        const spread = (dx: number, dy: number, f: number) => {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || xx >= w || yy >= h) return;
          const j = (yy * w + xx) * 3;
          err[j] += er * f;
          err[j + 1] += eg * f;
          err[j + 2] += eb * f;
        };
        spread(1, 0, 7 / 16);
        spread(-1, 1, 3 / 16);
        spread(0, 1, 5 / 16);
        spread(1, 1, 1 / 16);
      }
    }
  }
  return out;
}

/** GIF LZW (variable code size, deferred clear), following the well-known omggif scheme. */
export function lzwEncode(indices: Uint8Array, minCodeSize = 8): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  const dict = new Map<number, number>();
  const out: number[] = [];
  let cur = 0;
  let bits = 0;
  const emit = (code: number) => {
    cur |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(cur & 255);
      cur >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1;
      codeSize = minCodeSize + 1;
      dict.clear();
    } else {
      if (next >= 1 << codeSize) codeSize++;
      dict.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}

export interface GifFrame {
  indices: Uint8Array;
  delayCs: number;
}

export function encodeGif(width: number, height: number, frames: GifFrame[]): Uint8Array {
  const bytes: number[] = [];
  const w16 = (v: number) => bytes.push(v & 255, (v >> 8) & 255);
  for (const c of "GIF89a") bytes.push(c.charCodeAt(0));
  w16(width);
  w16(height);
  bytes.push(0xf7, 0, 0); // global colour table, 256 colours
  for (const v of buildPalette()) bytes.push(v);
  // loop forever
  bytes.push(0x21, 0xff, 0x0b);
  for (const c of "NETSCAPE2.0") bytes.push(c.charCodeAt(0));
  bytes.push(3, 1, 0, 0, 0);
  for (const f of frames) {
    bytes.push(0x21, 0xf9, 4, 0x04, f.delayCs & 255, (f.delayCs >> 8) & 255, 0, 0); // GCE, disposal 1
    bytes.push(0x2c);
    w16(0);
    w16(0);
    w16(width);
    w16(height);
    bytes.push(0);
    bytes.push(8);
    const data = lzwEncode(f.indices, 8);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      bytes.push(n);
      for (let j = 0; j < n; j++) bytes.push(data[i + j]);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
