/**
 * Heuristic output filter for javascript_tool (requirements 10.2). It limits accidental credential leaks to the
 * model; it does NOT replace the permission check (JS-08).
 */

export const MAX_DEPTH = 5;
export const MAX_STRING = 1000;
export const MAX_ARRAY = 100;
export const MAX_OUTPUT = 51_200;

const SENSITIVE_KEY = /password|token|secret|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|bearer|oauth|session/i;
const COOKIE_KEY = /^(cookie|cookies)$/i;

export function filterString(s: string): string {
  if (s.includes("=") && (s.includes(";") || s.includes("&"))) return "[BLOCKED: Cookie/query string data]";
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(s)) return "[BLOCKED: JWT token]";
  if (/^[0-9a-fA-F]{32,}$/.test(s)) return "[BLOCKED: Hex credential]";
  if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(s)) return "[BLOCKED: Base64 encoded data]";
  if (s.length > MAX_STRING) return `${s.slice(0, MAX_STRING)}… [truncated, ${s.length} chars total]`;
  return s;
}

export function filterValue(v: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof v === "string") return filterString(v);
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v as object)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Max depth reached]";
  seen.add(v as object);
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ARRAY).map((x) => filterValue(x, depth + 1, seen));
    if (v.length > MAX_ARRAY) out.push(`… [${v.length - MAX_ARRAY} more items truncated]`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (COOKIE_KEY.test(k)) out[k] = "[BLOCKED: Cookie access]";
    else if (SENSITIVE_KEY.test(k)) out[k] = "[BLOCKED: Sensitive key]";
    else out[k] = filterValue(val, depth + 1, seen);
  }
  return out;
}

/** Filters a result value and serializes it for the model, capped at MAX_OUTPUT characters. */
export function filterOutput(v: unknown): string {
  const f = filterValue(v);
  let text: string;
  if (f === undefined) text = "undefined";
  else if (typeof f === "string") text = f;
  else {
    try {
      text = JSON.stringify(f, null, 2) ?? String(f);
    } catch {
      text = String(f);
    }
  }
  if (text.length > MAX_OUTPUT) text = `${text.slice(0, MAX_OUTPUT)}\n… [output truncated at ${MAX_OUTPUT} characters]`;
  return text;
}

/** Replaces known secret values (read from sensitive fields before execution, JS-07) in a text. */
export function redactKnownValues(text: string, secrets: string[], replacement: string): string {
  let out = text;
  for (const s of secrets) {
    if (s.length >= 1) out = out.split(s).join(replacement);
  }
  return out;
}
