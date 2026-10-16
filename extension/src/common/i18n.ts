/** NFA-12: German and English through chrome.i18n; falls back to the English table outside the extension. */
import { STRINGS } from "./strings";

export function t(key: string, subs?: string | string[]): string {
  try {
    const m = chrome.i18n?.getMessage(key, subs as any);
    if (m) return m;
  } catch {
    /* not in extension context */
  }
  const entry = STRINGS[key];
  let s = entry?.en ?? key;
  const arr = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
  arr.forEach((v, i) => (s = s.replace(new RegExp(`\\$${i + 1}`, "g"), v)));
  return s;
}
