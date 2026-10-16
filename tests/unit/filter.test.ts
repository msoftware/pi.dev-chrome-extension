import { describe, expect, it } from "vitest";
import { filterValue, filterOutput, isSensitiveField, redactKnownValues } from "@pi-browser/shared";

describe("output filter (10.2)", () => {
  it("blocks sensitive keys", () => {
    expect(filterValue({ apiKey: "x", api_key: "y", user: "bob", sessionId: "1" })).toEqual({
      apiKey: "[BLOCKED: Sensitive key]", api_key: "[BLOCKED: Sensitive key]", user: "bob", sessionId: "[BLOCKED: Sensitive key]",
    });
  });
  it("blocks cookie keys and strings", () => {
    expect(filterValue({ cookies: "a=b" })).toEqual({ cookies: "[BLOCKED: Cookie access]" });
    expect(filterValue("a=1; b=2")).toBe("[BLOCKED: Cookie/query string data]");
    expect(filterValue("a=1&b=2")).toBe("[BLOCKED: Cookie/query string data]");
  });
  it("blocks JWT, base64, hex", () => {
    expect(filterValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toBe("[BLOCKED: JWT token]");
    expect(filterValue("QUJDREVGR0hJSktMTU5PUFFSU1RVVldY")).toBe("[BLOCKED: Base64 encoded data]");
    expect(filterValue("0123456789abcdef0123456789abcdef")).toBe("[BLOCKED: Hex credential]");
  });
  it("leaves normal strings alone", () => {
    expect(filterValue("Hello world")).toBe("Hello world");
    expect(filterValue("www.example.com")).toBe("www.example.com");
  });
  it("truncates long strings, arrays and total", () => {
    expect(String(filterValue("x ".repeat(2000)))).toContain("truncated");
    const arr = filterValue(Array.from({ length: 150 }, (_, i) => i)) as unknown[];
    expect(arr).toHaveLength(101);
    expect(filterOutput("a b ".repeat(30000)).length).toBeLessThan(51_300);
  });
  it("limits depth to 5", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    expect(JSON.stringify(filterValue(deep))).toContain("Max depth");
  });
  it("handles cycles", () => {
    const o: any = { name: "x" };
    o.self = o;
    expect((filterValue(o) as any).self).toBe("[Circular]");
  });
});

describe("sensitive fields (TREE-14)", () => {
  it("detects type and autocomplete", () => {
    expect(isSensitiveField({ type: "password" })).toBe(true);
    expect(isSensitiveField({ type: "text", autocomplete: "cc-number" })).toBe(true);
    expect(isSensitiveField({ type: "text", autocomplete: "section-x one-time-code" })).toBe(true);
    expect(isSensitiveField({ type: "email" })).toBe(false);
  });
  it("redacts known values (JS-07)", () => {
    expect(redactKnownValues("pw is hunter2!", ["hunter2!"], "[value redacted]")).toBe("pw is [value redacted]");
  });
});
