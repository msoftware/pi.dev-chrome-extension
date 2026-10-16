import { DEFAULT_ALWAYS_ASK_DOMAINS, DEFAULT_PORT, type PermissionMode } from "@pi-browser/shared";

export interface Settings {
  port: number;
  permissionMode: PermissionMode;
  groupTitle: string;
  groupColor: chrome.tabGroups.ColorEnum;
  allowedDomains: string[];
  blockedDomains: string[];
  alwaysAskDomains: string[];
  jsToolEnabled: boolean;
  /** JS-02: javascript_tool timeout in seconds (default 30). */
  jsTimeoutSeconds: number;
  showThinking: boolean;
  notifySound: boolean;
  gifQuality: number;
  /** AUX-03: record request bodies (up to 64 KB) in read_network_requests. Off by default. */
  capturePostData: boolean;
  /** NFA-14: extension debug log in the service worker console. Off by default. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  port: DEFAULT_PORT,
  permissionMode: "ask",
  groupTitle: "Agent",
  groupColor: "orange",
  allowedDomains: [],
  blockedDomains: [],
  alwaysAskDomains: [...DEFAULT_ALWAYS_ASK_DOMAINS],
  jsToolEnabled: true,
  jsTimeoutSeconds: 30,
  showThinking: false,
  notifySound: true,
  gifQuality: 10,
  capturePostData: false,
  debug: false,
};

export interface ManagedPolicy {
  bridgePort?: number;
  blockedDomains?: string[];
  allowedDomains?: string[];
  alwaysAskDomains?: string[];
  permissionMode?: PermissionMode;
  javascriptToolEnabled?: boolean;
}

export interface Resolved extends Settings {
  policy: ManagedPolicy;
}

export async function getManaged(): Promise<ManagedPolicy> {
  try {
    return ((await chrome.storage.managed.get(null)) ?? {}) as ManagedPolicy;
  } catch {
    return {};
  }
}

/** EXT-05: enterprise policy beats user settings. */
export async function getSettings(): Promise<Resolved> {
  const stored = (await chrome.storage.local.get("settings")).settings as Partial<Settings> | undefined;
  const s: Settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  const p = await getManaged();
  if (p.bridgePort) s.port = p.bridgePort;
  if (p.permissionMode) s.permissionMode = p.permissionMode;
  if (p.javascriptToolEnabled === false) s.jsToolEnabled = false;
  return { ...s, policy: p };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const cur = ((await chrome.storage.local.get("settings")).settings ?? {}) as Partial<Settings>;
  await chrome.storage.local.set({ settings: { ...cur, ...patch } });
}

export interface BridgeAuth {
  token: string;
  deviceId: string;
}

export async function getAuth(): Promise<BridgeAuth | null> {
  return ((await chrome.storage.local.get("bridgeAuth")).bridgeAuth as BridgeAuth | undefined) ?? null;
}
export async function setAuth(a: BridgeAuth | null): Promise<void> {
  if (a) await chrome.storage.local.set({ bridgeAuth: a });
  else await chrome.storage.local.remove("bridgeAuth");
}

export interface Shortcut {
  id: string;
  name: string;
  prompt: string; // may contain {{param}} placeholders
  params?: string[];
  schedule?: { kind: "daily" | "weekly" | "monthly"; time: string; weekday?: number; day?: number } | null;
}

export async function getShortcuts(): Promise<Shortcut[]> {
  return ((await chrome.storage.local.get("shortcuts")).shortcuts as Shortcut[] | undefined) ?? [];
}
export async function setShortcuts(list: Shortcut[]): Promise<void> {
  await chrome.storage.local.set({ shortcuts: list });
}
