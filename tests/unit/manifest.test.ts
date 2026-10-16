import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import manifest from "../../extension/manifest.config";
import { EXTENSION_ID, EXTENSION_KEY } from "@pi-browser/shared";
import crypto from "node:crypto";

const m = manifest as any;

describe("manifest (section 4)", () => {
  it("EXT-01: MV3, Chrome 116", () => {
    expect(m.manifest_version).toBe(3);
    expect(m.minimum_chrome_version).toBe("116");
  });
  it("EXT-02: no popup, no fixed side panel path", () => {
    expect(m.action.default_popup).toBeUndefined();
    expect(m.side_panel).toBeUndefined();
  });
  it("EXT-03: toggle command with Ctrl+E / Command+E", () => {
    expect(m.commands["toggle-side-panel"].suggested_key).toEqual({ default: "Ctrl+E", mac: "Command+E" });
  });
  it("EXT-04: the fixed key yields the extension id the bridge checks", () => {
    const der = Buffer.from(EXTENSION_KEY, "base64");
    const id = [...crypto.createHash("sha256").update(der).digest().subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("").split("").map((h) => String.fromCharCode(97 + parseInt(h, 16))).join("");
    expect(id).toBe(EXTENSION_ID);
    expect(m.key).toBe(EXTENSION_KEY);
  });
  it("EXT-05: managed schema is declared, shipped and valid JSON", () => {
    expect(m.storage.managed_schema).toBe("managed-schema.json");
    const f = path.resolve(__dirname, "../../extension/public/managed-schema.json");
    const schema = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const k of ["bridgePort", "blockedDomains", "allowedDomains", "alwaysAskDomains", "permissionMode", "javascriptToolEnabled"]) expect(schema.properties[k]).toBeTruthy();
  });
  it("4.3: permissions exactly as required; nothing from the original that is not needed", () => {
    expect([...m.permissions].sort()).toEqual(["activeTab", "alarms", "debugger", "downloads", "notifications", "offscreen", "scripting", "sidePanel", "storage", "tabGroups", "tabs", "unlimitedStorage", "webNavigation"]);
    expect(m.host_permissions).toEqual(["<all_urls>"]);
    for (const banned of ["identity", "nativeMessaging", "declarativeNetRequestWithHostAccess"]) expect(m.permissions).not.toContain(banned);
  });
  it("EXT-06/07: content script timing and frames", () => {
    const [tree, indicator] = m.content_scripts;
    expect(tree).toMatchObject({ matches: ["<all_urls>"], all_frames: true, run_at: "document_start" });
    expect(indicator).toMatchObject({ matches: ["<all_urls>"], run_at: "document_idle" });
    expect(indicator.all_frames).toBeFalsy();
  });
  it("EXT-08: no external connections from web pages", () => {
    expect(m.externally_connectable).toBeUndefined();
  });
  it("EXT-11: CSP has no remote code and only local connections", () => {
    const csp = m.content_security_policy.extension_pages as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:* http://localhost:*");
    expect(csp).not.toMatch(/unsafe-eval|https?:\/\/(?!127|localhost)/);
  });
  it("UI-01/NFA-12: i18n names are used", () => {
    expect(m.name).toBe("__MSG_extName__");
    expect(m.default_locale).toBe("en");
  });
});

describe("built extension (when present)", () => {
  const dist = path.resolve(__dirname, "../../extension/dist/manifest.json");
  const built = fs.existsSync(dist) ? JSON.parse(fs.readFileSync(dist, "utf8")) : null;
  it.skipIf(!built)("EXT-09: no web_accessible_resources and content scripts are self-contained", () => {
    expect(built.web_accessible_resources).toBeUndefined();
    for (const cs of built.content_scripts) {
      for (const f of cs.js as string[]) {
        const src = fs.readFileSync(path.resolve(__dirname, "../../extension/dist", f), "utf8");
        expect(src).not.toMatch(/\bimport\s*\(|getURL|^import /m);
      }
    }
  });
  it.skipIf(!built)("EXT-11: no remote hosts in any shipped script", () => {
    const dir = path.resolve(__dirname, "../../extension/dist");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(html|js)$/.test(e.name)) {
          const t = fs.readFileSync(p, "utf8");
          // script/link/src references to remote origins would break script-src 'self'
          for (const mm of t.matchAll(/<script[^>]+src=["'](https?:\/\/[^"']+)/g)) hits.push(`${e.name}: ${mm[1]}`);
        }
      }
    };
    walk(dir);
    expect(hits).toEqual([]);
  });
  it.skipIf(!built)("telemetry hosts never appear (NFA-07)", () => {
    const dir = path.resolve(__dirname, "../../extension/dist/assets");
    const bad = /sentry\.io|datadoghq|segment\.io|google-analytics|api\.anthropic\.com|claude\.ai/i;
    const hits: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".js")) continue;
      // third-party libraries (mermaid docs strings etc.) may mention hosts in comments; check only our own entries
      if (!/^(service-worker|sidepanel|options|a11y-tree|indicator|offscreen|blocked)/.test(f)) continue;
      if (bad.test(fs.readFileSync(path.join(dir, f), "utf8"))) hits.push(f);
    }
    expect(hits).toEqual([]);
  });
});
