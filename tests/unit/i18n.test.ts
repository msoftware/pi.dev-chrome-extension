import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { STRINGS } from "../../extension/src/common/strings";
import { PERMISSION_TYPES } from "@pi-browser/shared";

function walk(dir: string, out: string[] = []): string[] {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f.name)) out.push(p);
  }
  return out;
}

describe("i18n (NFA-12)", () => {
  const src = walk(path.resolve(__dirname, "../../extension/src")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const keys = new Set<string>();
  for (const m of src.matchAll(/\bt\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) keys.add(m[1]);
  for (const m of src.matchAll(/getMessage\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) keys.add(m[1]);
  for (const p of PERMISSION_TYPES) keys.add(`perm_${p}`);

  it("every used key exists in English and German", () => {
    const missing = [...keys].filter((k) => !STRINGS[k] || !STRINGS[k].en || !STRINGS[k].de);
    expect(missing).toEqual([]);
  });
  it("German differs from English where text is real prose", () => {
    const same = Object.entries(STRINGS).filter(([, v]) => v.en === v.de && v.en.length > 25);
    expect(same.map(([k]) => k)).toEqual([]);
  });
  it("generated locale files are in sync", () => {
    for (const lang of ["en", "de"] as const) {
      const f = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../extension/public/_locales/${lang}/messages.json`), "utf8"));
      expect(Object.keys(f).sort()).toEqual(Object.keys(STRINGS).sort());
    }
  });
});
