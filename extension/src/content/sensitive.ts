/**
 * Copy of packages/shared/src/sensitive.ts. Content scripts must not share chunks with the service worker
 * (that would make the bundler emit a loader and require web_accessible_resources, EXT-09), so the tiny
 * definition is duplicated here; tests/unit/sensitive-sync.test.ts keeps both in sync.
 */
export const SENSITIVE_AUTOCOMPLETE = [
  "current-password", "new-password", "one-time-code", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year",
];
export const SENSITIVE_TYPES = ["password", "hidden"];

export function isSensitiveField(attrs: { type?: string | null; autocomplete?: string | null }): boolean {
  const type = (attrs.type ?? "").toLowerCase();
  if (SENSITIVE_TYPES.includes(type)) return true;
  const ac = (attrs.autocomplete ?? "").toLowerCase().split(/\s+/);
  return ac.some((t) => SENSITIVE_AUTOCOMPLETE.includes(t));
}

export const REDACTED = "[value redacted]";
