import { defineManifest } from "@crxjs/vite-plugin";
import { EXTENSION_KEY } from "../packages/shared/src/extension-id";

export default defineManifest({
  manifest_version: 3,
  name: "__MSG_extName__",
  description: "__MSG_extDescription__",
  version: "0.1.0",
  default_locale: "en",
  minimum_chrome_version: "116",
  key: EXTENSION_KEY,
  icons: { "16": "icons/icon-16.png", "32": "icons/icon-32.png", "48": "icons/icon-48.png", "128": "icons/icon-128.png" },
  // EXT-02: no popup and no fixed side_panel.default_path; the panel is registered per tab in code.
  action: {
    default_title: "__MSG_actionTitle__",
    default_icon: { "16": "icons/icon-16.png", "32": "icons/icon-32.png" },
  },
  background: { service_worker: "src/background/service-worker.ts", type: "module" },
  commands: {
    "toggle-side-panel": {
      suggested_key: { default: "Ctrl+E", mac: "Command+E" },
      description: "__MSG_cmdToggle__",
    },
  },
  permissions: [
    "sidePanel", "tabs", "tabGroups", "activeTab", "debugger", "scripting", "webNavigation",
    "storage", "unlimitedStorage", "alarms", "notifications", "offscreen", "downloads",
  ],
  host_permissions: ["<all_urls>"],
  // EXT-06 / EXT-07 / EXT-08: no externally_connectable, no page<->extension messaging channel.
  content_scripts: [
    { matches: ["<all_urls>"], js: ["src/content/a11y-tree.ts"], all_frames: true, match_about_blank: true, run_at: "document_start" },
    { matches: ["<all_urls>"], js: ["src/content/indicator.ts"], run_at: "document_idle" },
  ],
  options_ui: { page: "options.html", open_in_tab: true },
  storage: { managed_schema: "managed-schema.json" },
  // EXT-11: no remote code, no telemetry; connections only to the local bridge.
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' http://127.0.0.1:* http://localhost:*",
  },
} as any);
