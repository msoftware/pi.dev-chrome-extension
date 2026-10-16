// Bundles the bridge (and the shared tool catalog it imports) into one self-contained file, so it can be installed
// into pi without the monorepo: `pi -e packages/bridge/dist/index.js`.
import { build } from "esbuild";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
await build({
  entryPoints: [path.join(root, "packages/bridge/src/index.ts")],
  outfile: path.join(root, "packages/bridge/dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["@earendil-works/*", "node:*"],
  banner: { js: "// pi-browser-bridge (bundled). Source: packages/bridge, packages/shared. MIT." },
  logLevel: "info",
});
