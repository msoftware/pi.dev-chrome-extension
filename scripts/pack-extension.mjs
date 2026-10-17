// Packs the built extension (extension/dist) into release/extension/:
//   browser-agent-<v>-store.zip     for the Chrome Web Store (manifest WITHOUT "key": the store assigns its own ID)
//   browser-agent-<v>-unpacked.zip  for sideloading / GitHub releases (manifest WITH the fixed "key" => stable dev ID)
import { zipSync } from "fflate";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "extension/dist");
if (!fs.existsSync(path.join(dist, "manifest.json"))) {
  console.error("extension/dist/manifest.json not found. Run `npm run build` first.");
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const manifest = JSON.parse(fs.readFileSync(path.join(dist, "manifest.json"), "utf8"));
if (manifest.version !== version) {
  console.error(`manifest version ${manifest.version} != package version ${version}. Run \`npm run build\` again.`);
  process.exit(1);
}

function collect(dir, base = "") {
  const files = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(files, collect(path.join(dir, e.name), rel));
    else if (!e.name.endsWith(".map")) files[rel] = new Uint8Array(fs.readFileSync(path.join(dir, e.name)));
  }
  return files;
}

const files = collect(dist);
const out = path.join(root, "release", "extension");
fs.mkdirSync(out, { recursive: true });

const unpacked = { ...files };
const store = { ...files };
const m = { ...manifest };
delete m.key;
store["manifest.json"] = new TextEncoder().encode(JSON.stringify(m, null, 2));

const write = (name, f) => {
  const file = path.join(out, name);
  fs.writeFileSync(file, zipSync(f, { level: 9 }));
  console.log(`${path.relative(root, file)}  ${(fs.statSync(file).size / 1024).toFixed(0)} KB, ${Object.keys(f).length} files`);
};
write(`browser-agent-${version}-store.zip`, store);
write(`browser-agent-${version}-unpacked.zip`, unpacked);
