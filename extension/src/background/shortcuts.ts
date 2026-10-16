/** Saved prompts with parameters and scheduled execution (UI-21, KANN) and workflow recording (UI-22, KANN). */
import { getShortcuts, setShortcuts, type Shortcut } from "../common/storage";

export function expandPrompt(prompt: string, params: Record<string, string> = {}): string {
  return prompt.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, k: string) => params[k] ?? `{{${k}}}`);
}

export function paramsOf(prompt: string): string[] {
  const out = new Set<string>();
  for (const m of prompt.matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) out.add(m[1]);
  return [...out];
}

/** Next local fire time (ms epoch) after `now`. */
export function nextRun(s: NonNullable<Shortcut["schedule"]>, now = new Date()): number {
  const [hh, mm] = s.time.split(":").map((x) => Number.parseInt(x, 10) || 0);
  const at = (d: Date) => {
    const x = new Date(d);
    x.setHours(hh, mm, 0, 0);
    return x;
  };
  let t = at(now);
  if (s.kind === "daily") {
    if (t <= now) t.setDate(t.getDate() + 1);
  } else if (s.kind === "weekly") {
    const wd = s.weekday ?? 1;
    while (t.getDay() !== wd || t <= now) t.setDate(t.getDate() + 1);
  } else {
    const day = Math.min(28, Math.max(1, s.day ?? 1));
    t.setDate(day);
    if (t <= now) {
      t = at(new Date(now.getFullYear(), now.getMonth() + 1, 1));
      t.setDate(day);
    }
  }
  return t.getTime();
}

const ALARM_PREFIX = "shortcut:";

/** (Re)creates one alarm per scheduled shortcut. */
export async function scheduleAll(): Promise<void> {
  const existing = await chrome.alarms.getAll();
  for (const a of existing) if (a.name.startsWith(ALARM_PREFIX)) await chrome.alarms.clear(a.name);
  for (const s of await getShortcuts()) {
    if (s.schedule) await chrome.alarms.create(ALARM_PREFIX + s.id, { when: nextRun(s.schedule) });
  }
}

export function shortcutIdFromAlarm(name: string): string | null {
  return name.startsWith(ALARM_PREFIX) ? name.slice(ALARM_PREFIX.length) : null;
}

export async function saveShortcut(s: Shortcut) {
  const list = await getShortcuts();
  const i = list.findIndex((x) => x.id === s.id);
  s.params = paramsOf(s.prompt);
  if (i >= 0) list[i] = s;
  else list.push(s);
  await setShortcuts(list);
  await scheduleAll();
}

export async function deleteShortcut(id: string) {
  await setShortcuts((await getShortcuts()).filter((s) => s.id !== id));
  await scheduleAll();
}

// ---- workflow recording ------------------------------------------------------------------------------------------

export interface RecStep {
  kind: "click" | "input" | "key" | "navigate";
  desc: string;
  value?: string;
  url?: string;
}

/** Injected into the page (self-contained, isolated world). Sends REC_STEP messages. */
export function recorderInject() {
  const w = window as any;
  if (w.__piRec) return;
  w.__piRec = true;
  const describe = (el: Element | null): string => {
    if (!el) return "element";
    const e = el as HTMLElement;
    const tag = e.tagName.toLowerCase();
    const label = e.getAttribute("aria-label") || e.getAttribute("placeholder") || (e as HTMLInputElement).name || (e.innerText || "").trim().replace(/\s+/g, " ").slice(0, 50) || e.getAttribute("title") || "";
    const type = e.getAttribute("type");
    return `${tag}${type ? `[${type}]` : ""}${label ? ` "${label}"` : ""}`;
  };
  const send = (step: unknown) => {
    try {
      chrome.runtime.sendMessage({ type: "REC_STEP", step });
    } catch {
      /* ignore */
    }
  };
  document.addEventListener("click", (e) => send({ kind: "click", desc: describe((e.target as Element).closest?.("a,button,input,select,textarea,[role]") ?? (e.target as Element)), url: location.href }), true);
  document.addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    const sensitive = el.type === "password" || /current-password|new-password|cc-|one-time/.test(el.autocomplete || "");
    send({ kind: "input", desc: describe(el), value: sensitive ? "{{secret}}" : String(el.value ?? "").slice(0, 80), url: location.href });
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "Escape" || e.key === "Tab") send({ kind: "key", desc: e.key, url: location.href });
  }, true);
}

export function stepsToPrompt(steps: RecStep[]): string {
  const lines: string[] = [];
  let last = "";
  for (const s of steps) {
    let l: string;
    if (s.kind === "navigate") l = `Go to ${s.url}`;
    else if (s.kind === "click") l = `Click the ${s.desc}`;
    else if (s.kind === "input") l = `Enter ${s.value === "{{secret}}" ? "the secret value (ask me for it)" : `"${s.value}"`} into the ${s.desc}`;
    else l = `Press ${s.desc}`;
    if (l !== last) lines.push(l);
    last = l;
  }
  return `Repeat this workflow in the browser, step by step:\n${lines.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
}
