import { describe, expect, it } from "vitest";
import { targetSize, fitsBudget, jpegSize, imageToViewport } from "@pi-browser/shared";

describe("targetSize (SHOT-02/03)", () => {
  it("keeps 1366x768 unchanged", () => {
    expect(targetSize(1366, 768)).toEqual({ width: 1366, height: 768 });
  });
  it("scales 1920x1080 to 1456x819", () => {
    expect(targetSize(1920, 1080)).toEqual({ width: 1456, height: 819 });
  });
  it("scales retina 1280x720@2 to 1456x819", () => {
    expect(targetSize(1280 * 2, 720 * 2)).toEqual({ width: 1456, height: 819 });
  });
  it("handles portrait", () => {
    const t = targetSize(1080, 1920);
    expect(t).toEqual({ width: 819, height: 1456 });
    expect(fitsBudget(t.width, t.height)).toBe(true);
  });
  it("always fits", () => {
    for (const [w, h] of [[3840, 2160], [5000, 400], [100, 4000], [1569, 10]]) {
      const t = targetSize(w, h);
      expect(fitsBudget(t.width, t.height)).toBe(true);
    }
  });
});

describe("coordinates (SHOT-09)", () => {
  it("maps image to viewport css pixels", () => {
    expect(imageToViewport(728, 409.5, { imageWidth: 1456, imageHeight: 819, viewportWidth: 1920, viewportHeight: 1080, devicePixelRatio: 1 })).toEqual([960, 540]);
  });
});

describe("jpegSize (SHOT-06)", () => {
  it("reads SOF0", () => {
    const b = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0x03, 0x20, 0x02, 0x58, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    expect(jpegSize(b)).toEqual({ width: 0x0258, height: 0x0320 });
  });
});
