// Builds the two publishable npm packages into release/npm/<name>/ (self-contained, no workspace dependencies):
//   pi-browser-bridge  a pi package (keyword "pi-package" => listed on https://pi.dev/packages)
//   pi-browser-host    headless host (panel-led mode) with the bridge bundled in
// Publish with:  npm publish release/npm/pi-browser-bridge   and   npm publish release/npm/pi-browser-host
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = rootPkg.version;
const out = path.join(root, "release", "npm");
const REPO = "https://github.com/msoftware/pi.dev-chrome-extension";
const IMAGE = `https://raw.githubusercontent.com/msoftware/pi.dev-chrome-extension/main/docs/images/gallery.png`;

// Packages that pi (or the host's node_modules) provides must never be bundled (docs/packages.md).
const external = ["@earendil-works/*", "typebox", "node:*"];

function common(name, description, extra) {
  return {
    name,
    version,
    description,
    license: "MIT",
    author: "Michael Jentsch",
    type: "module",
    homepage: `${REPO}#readme`,
    repository: { type: "git", url: `git+${REPO}.git`, directory: `packages/${name === "pi-browser-bridge" ? "bridge" : "host"}` },
    bugs: { url: `${REPO}/issues` },
    engines: { node: ">=20" },
    publishConfig: { access: "public" },
    ...extra,
  };
}

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(dir, "LICENSE"));
}

// ---- bridge ------------------------------------------------------------------------------------------------------
{
  const dir = path.join(out, "pi-browser-bridge");
  reset(dir);
  await build({
    entryPoints: [path.join(root, "packages/bridge/src/index.ts")],
    outfile: path.join(dir, "dist/index.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external,
    banner: { js: `// pi-browser-bridge ${version} (bundled). MIT. Source: ${REPO}` },
    legalComments: "none",
    logLevel: "warning",
  });
  fs.copyFileSync(path.join(root, "packages/bridge/README.md"), path.join(dir, "README.md"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      common("pi-browser-bridge", "pi extension that lets a local pi agent see and operate Chrome through the Browser Agent extension (HTTP/SSE bridge, 20 browser tools)", {
        keywords: ["pi-package", "pi-extension", "pi", "browser", "chrome", "browser-agent", "automation", "cdp"],
        files: ["dist", "README.md", "LICENSE"],
        main: "./dist/index.js",
        exports: { ".": "./dist/index.js" },
        pi: { extensions: ["./dist/index.js"], image: IMAGE },
        peerDependencies: { "@earendil-works/pi-coding-agent": "*", typebox: "*" },
      }),
      null,
      2,
    ) + "\n",
  );
}

// ---- host --------------------------------------------------------------------------------------------------------
{
  const dir = path.join(out, "pi-browser-host");
  reset(dir);
  await build({
    entryPoints: [path.join(root, "packages/host/src/cli.ts")],
    outfile: path.join(dir, "dist/cli.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external,
    banner: { js: `// pi-browser-host ${version} (bundled, includes pi-browser-bridge). MIT. Source: ${REPO}` },
    legalComments: "none",
    logLevel: "warning",
  });
  fs.chmodSync(path.join(dir, "dist/cli.js"), 0o755);
  fs.copyFileSync(path.join(root, "packages/host/README.md"), path.join(dir, "README.md"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      common("pi-browser-host", "Headless host for the Browser Agent: runs a pi session through the SDK with the browser bridge loaded, so the Chrome side panel is the only surface", {
        keywords: ["pi", "browser", "chrome", "browser-agent", "headless", "sdk"],
        files: ["dist", "README.md", "LICENSE"],
        bin: { "pi-browser-host": "./dist/cli.js" },
        dependencies: { typebox: "1.3.27" },
        peerDependencies: { "@earendil-works/pi-coding-agent": "*" },
      }),
      null,
      2,
    ) + "\n",
  );
}
console.log(`built release/npm/pi-browser-bridge@${version} and release/npm/pi-browser-host@${version}`);
