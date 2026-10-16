import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [react(), crx({ manifest })],
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
