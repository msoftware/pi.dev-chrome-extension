import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT, EXTENSION_ID, type BridgeFileConfig } from "@pi-browser/shared";

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function configPath(): string {
  return path.join(agentDir(), "browser-bridge.json");
}

export function loadFileConfig(): BridgeFileConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as BridgeFileConfig;
  } catch {
    return {};
  }
}

export interface ResolvedConfig {
  port: number;
  extensionId: string;
  helperModel?: string;
  disabledTools: string[];
  uploadRoots: string[];
  debug: boolean;
}

/** Flag wins over file (API-04). */
export function resolveConfig(flagPort: string | boolean | undefined): ResolvedConfig {
  const f = loadFileConfig();
  const flag = typeof flagPort === "string" && flagPort ? Number.parseInt(flagPort, 10) : NaN;
  const port = Number.isInteger(flag) && flag > 0 && flag < 65536 ? flag : f.port && f.port > 0 ? f.port : DEFAULT_PORT;
  return {
    port,
    extensionId: f.extensionId || EXTENSION_ID,
    helperModel: f.helperModel,
    disabledTools: f.disabledTools ?? [],
    uploadRoots: f.uploadRoots ?? [],
    debug: !!f.debug || process.env.PI_BROWSER_DEBUG === "1",
  };
}
