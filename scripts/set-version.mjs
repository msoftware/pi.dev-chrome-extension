// Sets one version in every package: node scripts/set-version.mjs 0.2.0
import fs from "node:fs";
import path from "node:path";

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v ?? "")) {
  console.error("usage: node scripts/set-version.mjs <major.minor.patch>");
  process.exit(1);
}
const root = path.resolve(import.meta.dirname, "..");
for (const f of ["package.json", "extension/package.json", "packages/shared/package.json", "packages/bridge/package.json", "packages/host/package.json"]) {
  const file = path.join(root, f);
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  j.version = v;
  for (const dep of ["@pi-browser/shared", "pi-browser-bridge"]) {
    for (const k of ["dependencies", "devDependencies"]) if (j[k]?.[dep]) j[k][dep] = v;
  }
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");
  console.log(`${f} -> ${v}`);
}
console.log("Next: add a section to CHANGELOG.md, run `npm install` (updates the lockfile), then `npm run release:check`.");
