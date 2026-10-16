import { describe, expect, it } from "vitest";
import { charToKeyEvent, parseCombo, parseKeySequence, MOD } from "@pi-browser/shared";

describe("key table (INP-08/09)", () => {
  it("maps letters", () => {
    expect(charToKeyEvent("a")).toMatchObject({ key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 0 });
  });
  it("uppercase adds shift", () => {
    expect(charToKeyEvent("A")).toMatchObject({ key: "A", code: "KeyA", modifiers: MOD.shift });
  });
  it("shifted symbols", () => {
    expect(charToKeyEvent("!")).toMatchObject({ code: "Digit1", modifiers: MOD.shift });
  });
  it("newline -> Enter", () => {
    expect(charToKeyEvent("\n")).toMatchObject({ key: "Enter", windowsVirtualKeyCode: 13 });
  });
  it("umlauts and emoji need insertText", () => {
    expect(charToKeyEvent("ä")).toBeNull();
    expect(charToKeyEvent("😀")).toBeNull();
  });
});

describe("modifiers (INP-05/10/11)", () => {
  it("bitmask alt=1 ctrl=2 meta=4 shift=8", () => {
    expect(parseCombo("ctrl+shift+a").modifiers).toBe(MOD.ctrl | MOD.shift);
    expect(parseCombo("alt+Tab").modifiers).toBe(1);
    expect(parseCombo("meta+x", "mac").modifiers).toBe(4);
  });
  it("sequence", () => {
    const seq = parseKeySequence("ctrl+a Delete");
    expect(seq).toHaveLength(2);
    expect(seq[0].commands).toEqual(["selectAll"]);
    expect(seq[1].key?.key).toBe("Delete");
  });
  it("cmd on linux -> ctrl for editing commands", () => {
    const c = parseCombo("cmd+a", "linux");
    expect(c.modifiers).toBe(MOD.ctrl);
    expect(c.commands).toEqual(["selectAll"]);
  });
  it("ctrl on mac -> meta", () => {
    expect(parseCombo("ctrl+a", "mac").modifiers).toBe(MOD.meta);
  });
  it("plus key and repeat-free", () => {
    expect(parseCombo("ctrl++").key?.key).toBe("+");
    expect(parseCombo("+").key?.key).toBe("+");
  });
  it("rejects unknown names", () => {
    expect(() => parseCombo("ctrl+Foo")).toThrow();
  });
});
