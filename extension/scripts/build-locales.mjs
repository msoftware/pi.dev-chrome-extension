// Generates public/_locales/{en,de}/messages.json from src/common/strings.ts (chrome.i18n format).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STRINGS } from "../src/common/strings.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
for (const lang of ["en", "de"]) {
  const out = {};
  for (const [key, v] of Object.entries(STRINGS)) {
    const text = v[lang];
    const entry = { message: text };
    const subs = [...text.matchAll(/\$(\d)/g)].map((m) => m[1]);
    if (subs.length) {
      const placeholders = {};
      entry.message = text.replace(/\$(\d)/g, (_m, n) => `$P${n}$`);
      for (const n of new Set(subs)) placeholders[`P${n}`] = { content: `$${n}` };
      entry.placeholders = placeholders;
    }
    out[key] = entry;
  }
  const dir = path.join(root, "..", "public", "_locales", lang);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "messages.json"), JSON.stringify(out, null, 2) + "\n");
}
console.log("locales written");
