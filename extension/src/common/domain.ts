import { getDomain } from "tldts";

/** SEC-03: registrable domain according to the Public Suffix List, e.g. docs.google.com -> google.com. */
export function registrableDomain(urlOrHost: string): string {
  try {
    const host = urlOrHost.includes("://") ? new URL(urlOrHost).hostname : urlOrHost;
    const d = getDomain(host, { allowPrivateDomains: false });
    return (d ?? host).toLowerCase();
  } catch {
    return "";
  }
}

export function isHttpUrl(url: string | undefined | null): boolean {
  return !!url && /^https?:\/\//i.test(url);
}

const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const SPECIAL = /^(about|chrome|chrome-extension|chrome-untrusted|devtools|view-source|data|file|javascript|mailto|blob|edge|brave):/i;

/** navigate: complete a missing scheme with https:// (spec 6.1). */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (SCHEME.test(s) || SPECIAL.test(s)) return s;
  return `https://${s}`;
}

/** TOOL-09: pages where only navigate is available. */
export function isRestrictedPage(url: string | undefined | null): boolean {
  if (!url) return false;
  if (/^(chrome|chrome-extension|chrome-untrusted|devtools|edge|brave|about|view-source):/i.test(url)) return true;
  try {
    const u = new URL(url);
    if (u.hostname === "chromewebstore.google.com") return true;
    if (u.hostname === "chrome.google.com" && u.pathname.startsWith("/webstore")) return true;
  } catch {
    /* ignore */
  }
  return false;
}
