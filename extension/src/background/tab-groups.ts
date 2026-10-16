/** Tab groups = the agent's workspace (requirements section 5). */
import type { TabContextEntry } from "@pi-browser/shared";
import { getSettings } from "../common/storage";

export interface GroupSession {
  groupId: number;
  mainTabId: number;
  windowId: number;
  /** true if we created the group, false if adopted (UI-02) */
  owned: boolean;
}

let groups = new Map<number, GroupSession>(); // groupId -> session
let loaded = false;
const snapshots = new Map<number, string>(); // groupId -> last sent tab-context snapshot (UI-08)
const dirty = new Set<number>();

async function load() {
  if (loaded) return;
  const r = (await chrome.storage.local.get("groupSessions")).groupSessions as GroupSession[] | undefined;
  groups = new Map((r ?? []).map((g) => [g.groupId, g]));
  loaded = true;
}
async function persist() {
  await chrome.storage.local.set({ groupSessions: [...groups.values()] });
}

/** UI-10: restore the session <-> group mapping after a worker restart; drop groups that no longer exist. */
export async function restore(): Promise<void> {
  await load();
  for (const g of [...groups.values()]) {
    try {
      await chrome.tabGroups.get(g.groupId);
    } catch {
      groups.delete(g.groupId);
    }
  }
  await persist();
}

export async function sessionForGroup(groupId: number): Promise<GroupSession | undefined> {
  await load();
  return groups.get(groupId);
}

export async function allSessions(): Promise<GroupSession[]> {
  await load();
  return [...groups.values()];
}

/** UI-02: ensure the tab belongs to a group of a session. */
export async function openForTab(tabId: number): Promise<GroupSession> {
  await load();
  const tab = await chrome.tabs.get(tabId);
  const s = await getSettings();
  if (tab.groupId !== undefined && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const existing = groups.get(tab.groupId);
    if (existing) return existing; // own group: nothing to do
    // foreign, unmanaged group: adopt it without touching title or colour
    const g: GroupSession = { groupId: tab.groupId, mainTabId: tabId, windowId: tab.windowId, owned: false };
    groups.set(g.groupId, g);
    await persist();
    return g;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title: s.groupTitle, color: s.groupColor });
  const g: GroupSession = { groupId, mainTabId: tabId, windowId: tab.windowId, owned: true };
  groups.set(groupId, g);
  await persist();
  return g;
}

export async function groupOfTab(tabId: number): Promise<GroupSession | undefined> {
  await load();
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId === undefined || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return undefined;
    return groups.get(tab.groupId);
  } catch {
    return undefined;
  }
}

export async function sessionForMainTab(tabId: number): Promise<GroupSession | undefined> {
  await load();
  return [...groups.values()].find((g) => g.mainTabId === tabId);
}

export async function tabsOfGroup(groupId: number): Promise<chrome.tabs.Tab[]> {
  return chrome.tabs.query({ groupId });
}

export async function tabContext(groupId: number): Promise<TabContextEntry[]> {
  const tabs = await tabsOfGroup(groupId);
  return tabs.filter((t) => t.id !== undefined).map((t) => ({ id: t.id!, title: t.title ?? "", url: t.url ?? t.pendingUrl ?? "" }));
}

/** UI-07 */
export async function assertInGroup(tabId: number, groupId: number): Promise<chrome.tabs.Tab> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} does not exist. Call tabs_context to list the tabs of this group.`);
  }
  if (tab.groupId !== groupId) {
    throw new Error(`Tab ${tabId} is not in this session's tab group. Call tabs_context to see the tabs you may use.`);
  }
  return tab;
}

export async function addTabToGroup(tabId: number, groupId: number): Promise<void> {
  await chrome.tabs.group({ tabIds: [tabId], groupId });
}

export function markDirty(groupId: number) {
  dirty.add(groupId);
}
export function isDirty(groupId: number) {
  return dirty.has(groupId);
}

/** UI-08: returns a context text when the group changed since it was last reported. */
export async function takeChangeNote(groupId: number): Promise<string | null> {
  const ctx = await tabContext(groupId);
  const snap = JSON.stringify(ctx);
  if (snapshots.get(groupId) === snap) {
    dirty.delete(groupId);
    return null;
  }
  const first = !snapshots.has(groupId);
  snapshots.set(groupId, snap);
  dirty.delete(groupId);
  if (first) return null;
  const lines = ctx.map((t) => `- tabId ${t.id}: "${t.title.slice(0, 100)}" ${t.url}`);
  return `Tab group changed. Current tabs:\n${lines.join("\n")}`;
}

export function resetSnapshot(groupId: number) {
  snapshots.delete(groupId);
}

export async function removeSession(groupId: number) {
  await load();
  groups.delete(groupId);
  snapshots.delete(groupId);
  await persist();
}

const frames = ["●", "●●", "●●●"];
const animations = new Map<number, ReturnType<typeof setInterval>>();

/** UI-09: animated dots in the group title while working, a tick after run_state settled. */
export async function setGroupStatus(groupId: number, state: "working" | "done" | "idle"): Promise<void> {
  const s = await getSettings();
  const stop = () => {
    const t = animations.get(groupId);
    if (t) clearInterval(t);
    animations.delete(groupId);
  };
  try {
    if (state === "working") {
      stop();
      let i = 0;
      const tick = () => void chrome.tabGroups.update(groupId, { title: `${s.groupTitle} ${frames[i++ % frames.length]}` }).catch(stop);
      tick();
      animations.set(groupId, setInterval(tick, 500));
    } else {
      stop();
      await chrome.tabGroups.update(groupId, { title: state === "done" ? `${s.groupTitle} ✓` : s.groupTitle });
    }
  } catch {
    stop();
  }
}
