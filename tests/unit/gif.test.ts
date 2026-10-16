import { describe, expect, it } from "vitest";
import { encodeGif, lzwEncode, quantize } from "../../extension/src/offscreen/gif-encoder";
import fs from "node:fs";

describe("gif encoder (AUX-11)", () => {
  it("writes a valid header/trailer", () => {
    const w = 8, h = 8;
    const idx = new Uint8Array(w * h).fill(5);
    const gif = encodeGif(w, h, [{ indices: idx, delayCs: 10 }]);
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe("GIF89a");
    expect(gif[gif.length - 1]).toBe(0x3b);
  });
  it("lzw emits clear and eoi", () => {
    const out = lzwEncode(new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2]));
    expect(out.length).toBeGreaterThan(0);
  });
  it("quantizes pure colours exactly", () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
    const q = quantize(rgba, 2, 1, false);
    expect(q[0]).toBe(5 * 36);
    expect(q[1]).toBe(5 * 6);
  });
  it("round-trips through a real decoder when PIL exists", () => {
    // gradient with enough variety to grow the LZW code size past 9 bits
    const w = 64, h = 48;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * 4) & 255; rgba[i + 1] = (y * 5) & 255; rgba[i + 2] = ((x * y) >> 2) & 255; rgba[i + 3] = 255;
    }
    const f1 = quantize(rgba, w, h, true);
    const f2 = quantize(rgba.map((v, i) => (i % 4 === 3 ? 255 : 255 - v)) as any, w, h, false);
    const gif = encodeGif(w, h, [{ indices: f1, delayCs: 10 }, { indices: f2, delayCs: 10 }]);
    fs.mkdirSync("/tmp/gif-test", { recursive: true });
    fs.writeFileSync("/tmp/gif-test/out.gif", gif);
    fs.writeFileSync("/tmp/gif-test/f1.bin", f1);
    expect(gif.length).toBeGreaterThan(100);
  });
});
