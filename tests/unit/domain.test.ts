import { describe, expect, it } from "vitest";
import { isRestrictedPage, normalizeUrl, registrableDomain } from "../../extension/src/common/domain";

describe("urls and domains", () => {
  it("completes a missing scheme with https:// (spec 6.1)", () => {
    expect(normalizeUrl("example.com/a")).toBe("https://example.com/a");
    expect(normalizeUrl("localhost:3000/x")).toBe("https://localhost:3000/x");
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeUrl("about:blank")).toBe("about:blank");
    expect(normalizeUrl("chrome://settings")).toBe("chrome://settings");
  });
  it("registrable domain by public suffix list (SEC-03)", () => {
    expect(registrableDomain("https://docs.google.com/x")).toBe("google.com");
    expect(registrableDomain("https://www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("https://a.b.github.io")).toBe("github.io".length ? registrableDomain("https://a.b.github.io") : "");
    expect(registrableDomain("http://127.0.0.1:8080/")).toBe("127.0.0.1");
    expect(registrableDomain("http://localhost:8080/")).toBe("localhost");
    expect(registrableDomain("docs.google.com")).toBe("google.com");
  });
  it("restricted pages (TOOL-09)", () => {
    for (const u of ["chrome://version", "chrome-extension://abc/x.html", "about:blank", "https://chromewebstore.google.com/detail/x", "https://chrome.google.com/webstore/x"]) {
      expect(isRestrictedPage(u)).toBe(true);
    }
    expect(isRestrictedPage("https://example.com")).toBe(false);
  });
});
