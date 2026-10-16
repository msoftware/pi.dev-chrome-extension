import { describe, expect, it } from "vitest";
import { requiredPermission, categorizeDomain, decide, isMutatingAction } from "@pi-browser/shared";

const base = { mode: "ask" as const, toolCallId: "c1", grants: [], planDomains: [] };

describe("permissions", () => {
  it("maps tools", () => {
    expect(requiredPermission("navigate")).toBe("NAVIGATE");
    expect(requiredPermission("computer", { action: "left_click" })).toBe("CLICK");
    expect(requiredPermission("computer", { action: "type" })).toBe("TYPE");
    expect(requiredPermission("computer", { action: "wait" })).toBeNull();
    expect(requiredPermission("javascript_tool")).toBe("EXECUTE_JS");
  });
  it("policy beats user lists", () => {
    const p = { blockedDomains: [], alwaysAskDomains: [], allowedDomains: ["a.com"], policyBlocked: ["a.com"] };
    expect(categorizeDomain("a.com", p)).toBe("blocked");
  });
  it("blocked denies", () => {
    expect(decide({ ...base, type: "READ_PAGE_CONTENT", domain: "a.com", category: "blocked" }).action).toBe("deny");
  });
  it("asks by default and allows with once-grant for this call only", () => {
    expect(decide({ ...base, type: "CLICK", domain: "a.com", category: "default" }).action).toBe("ask");
    const g = [{ domain: "a.com", type: "CLICK" as const, scope: "once" as const, toolCallId: "c1" }];
    expect(decide({ ...base, grants: g, type: "CLICK", domain: "a.com", category: "default" }).action).toBe("allow");
    expect(decide({ ...base, grants: g, toolCallId: "c2", type: "CLICK", domain: "a.com", category: "default" }).action).toBe("ask");
  });
  it("always grant persists", () => {
    const g = [{ domain: "a.com", type: "CLICK" as const, scope: "always" as const }];
    expect(decide({ ...base, grants: g, type: "CLICK", domain: "a.com", category: "default" }).action).toBe("allow");
  });
  it("always_ask only allows once", () => {
    const g = [{ domain: "bank.com", type: "READ_PAGE_CONTENT" as const, scope: "always" as const }];
    const d = decide({ ...base, grants: g, type: "READ_PAGE_CONTENT", domain: "bank.com", category: "always_ask" });
    expect(d).toEqual({ action: "ask", onceOnly: true });
  });
  it("auto mode allows but not always_ask", () => {
    expect(decide({ ...base, mode: "auto", type: "CLICK", domain: "a.com", category: "default" }).action).toBe("allow");
    expect(decide({ ...base, mode: "auto", type: "CLICK", domain: "bank.com", category: "always_ask" }).action).toBe("ask");
  });
  it("plan mode allows planned domains", () => {
    expect(decide({ ...base, mode: "plan", planDomains: ["a.com"], type: "CLICK", domain: "a.com", category: "default" }).action).toBe("allow");
    expect(decide({ ...base, mode: "plan", planDomains: ["a.com"], type: "CLICK", domain: "b.com", category: "default" }).action).toBe("ask");
  });
  it("mutating", () => {
    expect(isMutatingAction("computer", { action: "screenshot" })).toBe(false);
    expect(isMutatingAction("computer", { action: "left_click" })).toBe(true);
  });
});
