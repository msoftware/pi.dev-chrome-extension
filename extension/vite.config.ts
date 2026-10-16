import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

/** EXT-09: content scripts are plain bundles, so no page can detect the extension through web_accessible_resources. */
const stripWar = (): Plugin => ({
  name: "strip-web-accessible-resources",
  apply: "build",
  enforce: "post",
  closeBundle() {
    const file = path.resolve(__dirname, "dist/manifest.json");
    if (!fs.existsSync(file)) return;
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    delete m.web_accessible_resources;
    fs.writeFileSync(file, JSON.stringify(m, null, 2));
  },
});

export default defineConfig({
  plugins: [react(), crx({ manifest }), stripWar()],
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        sidepanel: "sidepanel.html",
        options: "options.html",
        blocked: "blocked.html",
        offscreen: "offscreen.html",
      },
    },
  },
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
});
