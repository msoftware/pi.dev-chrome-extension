import { describe, expect, it } from "vitest";
import { expandPrompt, nextRun, paramsOf, stepsToPrompt } from "../../extension/src/background/shortcuts";

describe("shortcuts (UI-21/22)", () => {
  it("expands and lists parameters", () => {
    expect(paramsOf("Open {{site}} and search {{ term }} on {{site}}")).toEqual(["site", "term"]);
    expect(expandPrompt("Open {{site}} for {{who}}", { site: "example.com" })).toBe("Open example.com for {{who}}");
  });
  it("computes the next run", () => {
    const now = new Date(2026, 9, 16, 10, 30); // Fri 16 Oct 2026 10:30
    expect(new Date(nextRun({ kind: "daily", time: "09:00" }, now)).getDate()).toBe(17);
    expect(new Date(nextRun({ kind: "daily", time: "11:00" }, now)).getDate()).toBe(16);
    const weekly = new Date(nextRun({ kind: "weekly", time: "08:00", weekday: 1 }, now)); // next Monday
    expect(weekly.getDay()).toBe(1);
    expect(weekly.getDate()).toBe(19);
    const monthly = new Date(nextRun({ kind: "monthly", time: "08:00", day: 5 }, now));
    expect(monthly.getMonth()).toBe(10);
    expect(monthly.getDate()).toBe(5);
  });
  it("turns recorded steps into a reusable prompt", () => {
    const p = stepsToPrompt([
      { kind: "navigate", desc: "", url: "https://example.com/login" },
      { kind: "input", desc: 'input[email] "Email"', value: "a@b.c" },
      { kind: "input", desc: 'input[password] "Password"', value: "{{secret}}" },
      { kind: "click", desc: 'button "Sign in"' },
      { kind: "click", desc: 'button "Sign in"' },
    ]);
    expect(p).toContain("1. Go to https://example.com/login");
    expect(p).toContain('Enter "a@b.c" into the input[email] "Email"');
    expect(p).toContain("ask me for it");
    expect(p.match(/Sign in/g)).toHaveLength(1); // consecutive duplicates collapse
  });
});
