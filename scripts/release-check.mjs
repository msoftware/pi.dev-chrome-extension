// Checks everything that can be checked offline before publishing. Exit code 1 on any failure.
import { execSync } from "node:child_process";
import { unzipSync } from "fflate";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
let failed = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => (failed++, console.log(`  FAIL ${m}`));
const check = (c, m) => (c ? ok(m) : bad(m));

const version = read("package.json").version;
console.log(`Release check for version ${version}\n`);

console.log("Versions");
for (const f of ["extension/package.json", "packages/shared/package.json", "packages/bridge/package.json", "packages/host/package.json"]) check(read(f).version === version, `${f} is ${version}`);

console.log("\nChangelog and documents");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
check(new RegExp(`^## \\[?${version.replace(/\./g, "\\.")}\\]?`, "m").test(changelog), `CHANGELOG.md has a section for ${version}`);
for (const f of ["LICENSE", "README.md", "publish.md", "docs/PRIVACY.md", "docs/store-listing.md", "docs/images/gallery.png", "packages/bridge/README.md", "packages/host/README.md"]) check(fs.existsSync(path.join(root, f)), `${f} exists`);

console.log("\nExtension build");
const dist = path.join(root, "extension/dist/manifest.json");
if (!fs.existsSync(dist)) bad("extension/dist missing: run npm run build");
else {
  const m = JSON.parse(fs.readFileSync(dist, "utf8"));
  check(m.version === version, `built manifest version is ${version}`);
  check(m.manifest_version === 3, "manifest_version 3");
  check(!m.web_accessible_resources, "no web_accessible_resources");
  check(!m.permissions.includes("identity") && !m.permissions.includes("nativeMessaging"), "no identity / nativeMessaging permission");
  for (const s of ["16", "32", "48", "128"]) check(fs.existsSync(path.join(root, "extension/dist", m.icons[s])), `icon ${s}px present`);
  for (const l of ["en", "de"]) check(fs.existsSync(path.join(root, "extension/dist/_locales", l, "messages.json")), `locale ${l}`);
  check(fs.existsSync(path.join(root, "extension/dist/managed-schema.json")), "managed-schema.json shipped");
}
const zips = fs.existsSync(path.join(root, "release/extension")) ? fs.readdirSync(path.join(root, "release/extension")) : [];
check(zips.includes(`browser-agent-${version}-store.zip`), "store zip built (npm run pack:extension)");
if (zips.includes(`browser-agent-${version}-store.zip`)) {
  const z = unzipSync(new Uint8Array(fs.readFileSync(path.join(root, "release/extension", `browser-agent-${version}-store.zip`))));
  const sm = JSON.parse(new TextDecoder().decode(z["manifest.json"]));
  check(!("key" in sm), 'store zip: manifest has no "key" (the store assigns its own ID)');
  check(sm.version === version, "store zip: manifest version matches");
  check(!Object.keys(z).some((f) => f.endsWith(".map")), "store zip: no source maps");
}

console.log("\nnpm packages");
for (const n of ["pi-browser-bridge", "pi-browser-host"]) {
  const dir = path.join(root, "release/npm", n);
  if (!fs.existsSync(dir)) {
    bad(`${n}: run npm run build:npm`);
    continue;
  }
  const p = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  check(p.version === version, `${n} version ${p.version}`);
  check(!Object.keys(p.dependencies ?? {}).some((d) => d.startsWith("@pi-browser") || d === "pi-browser-bridge"), `${n}: no workspace dependencies`);
  check(!Object.keys(p.dependencies ?? {}).some((d) => d.startsWith("@earendil-works")), `${n}: pi packages are peer dependencies only`);
  if (n === "pi-browser-bridge") {
    check(p.keywords.includes("pi-package"), "keyword pi-package (pi.dev/packages)");
    check(fs.existsSync(path.join(dir, p.pi.extensions[0])), "pi.extensions entry exists");
  }
  try {
    const out = execSync("npm pack --dry-run --json", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString();
    const files = JSON.parse(out)[0].files.map((f) => f.path);
    check(files.every((f) => /^(dist\/|README\.md|LICENSE|package\.json)/.test(f)), `${n}: tarball contains only dist, README, LICENSE, package.json (${files.length} files)`);
  } catch (e) {
    bad(`${n}: npm pack failed`);
  }
}

console.log("\nGit");
try {
  const dirty = execSync("git status --porcelain", { cwd: root }).toString().trim();
  check(!dirty, "working tree is clean");
} catch {
  bad("git not available");
}

console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
process.exit(failed ? 1 : 0);
