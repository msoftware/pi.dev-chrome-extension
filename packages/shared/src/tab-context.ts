import type { TabContextEntry } from "./protocol";

export function formatTabContext(tabs: TabContextEntry[]): string {
  if (!tabs.length) return "";
  const lines = tabs.map((t) => `- tabId ${t.id}: "${t.title.replace(/\s+/g, " ").slice(0, 120)}" ${t.url}`);
  return `<system-reminder>\nTabs available in this session's tab group:\n${lines.join("\n")}\n</system-reminder>`;
}

/** Wraps untrusted page text so the model can tell data from instructions (SEC-11). */
export function wrapPageContent(source: string, text: string): string {
  const safe = source.replace(/"/g, "%22");
  return `<page_content source="${safe}">\n${text.replace(/<\/page_content>/gi, "&lt;/page_content&gt;")}\n</page_content>`;
}
