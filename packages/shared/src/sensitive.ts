/** Sensitive input fields (requirements TREE-14). */

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
