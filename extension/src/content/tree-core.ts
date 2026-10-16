/**
 * Accessibility-tree generator (requirements section 9). DOM-based, independent of the CDP accessibility API.
 * Pure with respect to `env`, so it can be unit-tested with jsdom snapshots.
 */
import { isSensitiveField, REDACTED } from "@pi-browser/shared/sensitive";

export interface TreeOptions {
  filter: string; // "all" | "interactive" | anything else (treated like interactive)
  depth: number;
  maxChars: number;
  refId?: string;
}

export interface TreeEnv {
  viewport: { width: number; height: number };
  rect(el: Element): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  style(el: Element): { display: string; visibility: string; opacity: string };
}

export interface TreeState {
  refs: Map<string, WeakRef<Element>>;
  ids: WeakMap<Element, string>;
  counter: number;
  /** Offset so refs of different frames never collide: frameId * 100000. */
  base: number;
}

export function newTreeState(base = 0): TreeState {
  return { refs: new Map(), ids: new WeakMap(), counter: 0, base };
}

export const MAX_ELEMENTS = 10_000;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "META", "LINK", "TITLE", "NOSCRIPT", "HEAD", "TEMPLATE"]);
const LANDMARK_ROLES = new Set(["nav", "main", "header", "footer", "section", "article", "aside", "form", "table", "list", "listitem", "label", "navigation", "banner", "contentinfo", "region", "complementary", "search"]);
const TAG_ROLES: Record<string, string> = {
  A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", IMG: "image",
  H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
  NAV: "nav", MAIN: "main", HEADER: "header", FOOTER: "footer", SECTION: "section", ARTICLE: "article", ASIDE: "aside",
  FORM: "form", TABLE: "table", UL: "list", OL: "list", LI: "listitem", LABEL: "label", IFRAME: "iframe",
};

export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.trim().split(/\s+/)[0];
  const tag = el.tagName;
  if (tag === "INPUT") {
    const t = ((el as HTMLInputElement).type || "text").toLowerCase();
    if (t === "checkbox") return "checkbox";
    if (t === "radio") return "radio";
    if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
    if (t === "hidden") return "generic";
    return "textbox";
  }
  return TAG_ROLES[tag] ?? "generic";
}

export function isInteractiveEl(el: Element, role: string): boolean {
  const tag = el.tagName;
  if (["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY"].includes(tag)) {
    if (tag === "INPUT" && (el as HTMLInputElement).type === "hidden") return false;
    return true;
  }
  if (el.hasAttribute("onclick") || el.hasAttribute("tabindex")) return true;
  if (el.getAttribute("contenteditable") === "true") return true;
  return role === "button" || role === "link";
}

function directText(el: Element): string {
  let s = "";
  for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.nodeValue ?? "";
  return s.replace(/\s+/g, " ").trim();
}

function clip(s: string, n = 100): string {
  return s.length > n ? s.slice(0, n) : s;
}

export function accessibleName(el: Element, role: string): string {
  const doc = el.ownerDocument;
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return clip(aria);
  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    const t = labelledby.split(/\s+/).map((id) => doc.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean).join(" ");
    if (t) return clip(t.replace(/\s+/g, " "));
  }
  const ph = el.getAttribute("placeholder")?.trim();
  if (ph) return clip(ph);
  const title = el.getAttribute("title")?.trim();
  if (title) return clip(title);
  const alt = el.getAttribute("alt")?.trim();
  if (alt) return clip(alt);
  const id = (el as HTMLElement).id;
  if (id) {
    const lab = Array.from(doc.getElementsByTagName("label")).find((l) => l.htmlFor === id);
    const t = lab?.textContent?.replace(/\s+/g, " ").trim();
    if (t) return clip(t);
  }
  const wrap = el.closest?.("label");
  if (wrap && el.tagName !== "LABEL") {
    const t = wrap.textContent?.replace(/\s+/g, " ").trim();
    if (t) return clip(t);
  }
  if (el.tagName === "INPUT") {
    const t = ((el as HTMLInputElement).type || "").toLowerCase();
    if (t === "submit" || t === "button" || t === "reset") {
      const v = (el as HTMLInputElement).value?.trim();
      if (v) return clip(v);
    }
  }
  if (el.tagName === "SELECT") {
    const sel = el as HTMLSelectElement;
    const opt = sel.options?.[sel.selectedIndex];
    const t = opt?.textContent?.trim();
    if (t) return clip(t);
  }
  if (role === "button" || role === "link" || el.tagName === "SUMMARY") {
    const t = directText(el) || el.textContent?.replace(/\s+/g, " ").trim() || "";
    if (t) return clip(t);
  }
  if (role === "heading") {
    const t = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (t) return clip(t);
  }
  const d = directText(el);
  if (d.length >= 3) return clip(d);
  return "";
}

function attr(name: string, v: string | null | undefined): string {
  return v ? ` ${name}="${v.replace(/"/g, "&quot;")}"` : "";
}

export function generateTree(root: Element | Document, state: TreeState, env: TreeEnv, opts: TreeOptions):
  | { pageContent: string; viewport: { width: number; height: number } }
  | { error: string } {
  const doc = root.nodeType === 9 ? (root as Document) : (root as Element).ownerDocument;
  const all = opts.filter === "all";
  const lines: string[] = [];
  let chars = 0;
  let count = 0;
  let truncated = false;

  // TREE-11: drop entries whose element is gone.
  for (const [id, w] of state.refs) {
    const el = w.deref();
    if (!el || !el.isConnected) state.refs.delete(id);
  }

  let start: Element | null = null;
  if (opts.refId) {
    const el = state.refs.get(opts.refId)?.deref();
    if (!el) return { error: `Element reference ${opts.refId} no longer exists. Call read_page again without ref_id to get fresh references.` };
    start = el;
  }

  const refFor = (el: Element): string => {
    let id = state.ids.get(el);
    if (!id) {
      id = `ref_${state.base + ++state.counter}`;
      state.ids.set(el, id);
    }
    state.refs.set(id, new WeakRef(el));
    return id;
  };

  const visible = (el: Element, needViewport: boolean): boolean => {
    const r = env.rect(el);
    if (!(r.width > 0 && r.height > 0)) return false;
    const s = env.style(el);
    if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
    if (el.closest?.('[aria-hidden="true"]')) return false;
    if (needViewport) {
      if (r.right <= 0 || r.bottom <= 0 || r.left >= env.viewport.width || r.top >= env.viewport.height) return false;
    }
    return true;
  };

  const push = (line: string): boolean => {
    if (count >= MAX_ELEMENTS || chars + line.length + 1 > opts.maxChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    chars += line.length + 1;
    count++;
    return true;
  };

  const walk = (el: Element, level: number, domDepth: number): boolean => {
    if (truncated) return false;
    if (SKIP_TAGS.has(el.tagName) || domDepth > 600) return true;
    if ((el as HTMLElement).hidden && !all) return true;
    const role = roleOf(el);
    const interactive = isInteractiveEl(el, role);
    const name = all || interactive ? accessibleName(el, role) : "";
    let include: boolean;
    if (all) include = interactive || LANDMARK_ROLES.has(role) || role === "heading" || !!name || (role !== "generic" && role !== "image");
    else include = interactive;
    if (include && !all) include = visible(el, !opts.refId);
    let childLevel = level;
    if (include && level <= opts.depth) {
      const ref = refFor(el);
      const indent = " ".repeat(Math.min(level, 60));
      let line = `${indent}${role}${name ? ` "${name.replace(/"/g, "'")}"` : ""} [${ref}]`;
      const href = el.tagName === "A" ? el.getAttribute("href") : null;
      line += attr("href", href ? clip(href, 200) : null);
      const type = el.tagName === "INPUT" || el.tagName === "BUTTON" ? el.getAttribute("type") : null;
      line += attr("type", type);
      line += attr("placeholder", el.getAttribute("placeholder"));
      const sensitive = isSensitiveField({ type: el.getAttribute("type"), autocomplete: el.getAttribute("autocomplete") });
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        const t = (el.getAttribute("type") || "text").toLowerCase();
        if (t !== "checkbox" && t !== "radio" && t !== "submit" && t !== "button" && t !== "reset" && t !== "image") {
          const v = (el as HTMLInputElement).value ?? "";
          if (sensitive && v) line += ` value="${REDACTED}"`;
          else if (v && v.length < 50) line += attr("value", v);
        }
        if ((t === "checkbox" || t === "radio") && (el as HTMLInputElement).checked) line += " (checked)";
      }
      if ((el as HTMLButtonElement).disabled) line += " (disabled)";
      if (!push(line)) return false;
      childLevel = level + 1;
      if (el.tagName === "SELECT" && !sensitive) {
        const sel = el as HTMLSelectElement;
        for (const o of Array.from(sel.options)) {
          const t = (o.textContent ?? "").replace(/\s+/g, " ").trim();
          const sline = `${" ".repeat(Math.min(childLevel, 60))}option "${clip(t)}"${o.selected ? " (selected)" : ""}${attr("value", o.value)}`;
          if (!push(sline)) return false;
        }
        return true;
      }
      if (el.tagName === "SELECT") return true;
    } else if (include) {
      // beyond depth: do not descend further
      return true;
    }
    const shadow = (el as HTMLElement).shadowRoot;
    if (el.tagName === "SLOT") {
      const assigned = (el as HTMLSlotElement).assignedNodes?.({ flatten: true }) ?? [];
      const nodes = assigned.length ? assigned : Array.from(el.childNodes);
      for (const n of nodes) if (n.nodeType === 1 && !walk(n as Element, childLevel, domDepth + 1)) return false;
      return true;
    }
    const kids = shadow ? Array.from(shadow.children) : Array.from(el.children);
    for (const k of kids) if (!walk(k, childLevel, domDepth + 1)) return false;
    return true;
  };

  if (start) walk(start, 0, 0);
  else for (const k of Array.from(doc.documentElement ? [doc.documentElement] : [])) walk(k, 0, 0);

  let out = lines.join("\n");
  if (truncated) {
    out += `\n[Output truncated after ${count} elements / ${chars} characters. Use a smaller depth, a ref_id, or a higher max_chars to see more.]`;
  }
  return { pageContent: out, viewport: { width: env.viewport.width, height: env.viewport.height } };
}

/** Main readable text (get_page_text). */
export function extractMainText(doc: Document, maxChars: number): { title: string; url: string; text: string; truncated: boolean } {
  const candidates = ["article", "main", '[role="main"]', "#content", "#main", ".post", ".article", ".content", "#article"];
  let el: Element | null = null;
  let best = 0;
  for (const sel of candidates) {
    const found = Array.from(doc.querySelectorAll(sel));
    for (const f of found) {
      const len = ((f as HTMLElement).innerText ?? f.textContent ?? "").trim().length;
      if (len > best) {
        best = len;
        el = f;
      }
    }
    if (el && best > 200) break;
  }
  if (!el || best < 100) el = doc.body;
  const raw = ((el as HTMLElement)?.innerText ?? el?.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
  const truncated = raw.length > maxChars;
  return { title: doc.title ?? "", url: doc.location?.href ?? "", text: truncated ? raw.slice(0, maxChars) : raw, truncated };
}
