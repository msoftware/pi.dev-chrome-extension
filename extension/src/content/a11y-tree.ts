/**
 * Content script: accessibility tree and element references (TREE-01..16), form helpers and small page utilities.
 * Runs in every frame at document_start in the isolated world; maps live only here (TREE-12).
 * Service-worker code calls these functions through chrome.scripting.executeScript.
 */
import { isSensitiveField } from "@pi-browser/shared/sensitive";
import { extractMainText, generateTree, newTreeState, type TreeEnv, type TreeOptions } from "./tree-core";

interface Rect { x: number; y: number; w: number; h: number }

const state = newTreeState(0);
let blankLinks: string[] = [];
let blankListener: ((e: MouseEvent) => void) | null = null;

const env: TreeEnv = {
  get viewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  },
  rect: (el) => el.getBoundingClientRect(),
  style: (el) => getComputedStyle(el),
};

/** Each frame gets its own ref range: frameId * 100000 (top frame: 0). */
const ready: Promise<void> =
  window === window.top
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: "FRAME_ID" }, (r) => {
            if (chrome.runtime.lastError) return resolve();
            if (r && typeof r.frameId === "number") state.base = r.frameId * 100_000;
            resolve();
          });
        } catch {
          resolve();
        }
      });

function lookup(ref: string): Element | null {
  const el = state.refs.get(ref)?.deref();
  return el && el.isConnected ? el : null;
}

function topRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  let x = r.left;
  let y = r.top;
  // Same-origin parents only; cross-origin frames cannot be traversed.
  let w: Window = window;
  while (w !== w.top) {
    try {
      const fe = w.frameElement;
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      x += fr.left;
      y += fr.top;
      w = w.parent;
    } catch {
      break;
    }
  }
  return { x, y, w: r.width, h: r.height };
}

function staleError(ref: string) {
  return { error: `Element reference ${ref} no longer exists. Call read_page again without ref_id to get fresh references.` };
}

const api = {
  ready,
  async generate(opts: Partial<TreeOptions>) {
    await ready;
    return generateTree(document, state, env, {
      filter: opts.filter ?? "all",
      depth: opts.depth ?? 15,
      maxChars: opts.maxChars ?? 50_000,
      refId: opts.refId || undefined,
    });
  },
  async extractText(maxChars: number) {
    await ready;
    return extractMainText(document, maxChars);
  },
  /** Used by the element picker: describe a chosen element with a stable ref and its subtree outline. */
  async describe(el: Element) {
    await ready;
    let id = state.ids.get(el);
    if (!id) {
      id = `ref_${state.base + ++state.counter}`;
      state.ids.set(el, id);
    }
    state.refs.set(id, new WeakRef(el));
    const r = generateTree(document, state, env, { filter: "all", depth: 4, maxChars: 3000, refId: id });
    return { ref: id, outline: "pageContent" in r ? r.pageContent : "" };
  },
  async ownsRef(ref: string) {
    await ready;
    return !!lookup(ref);
  },
  /** Scrolls the element into the centre of the viewport and returns its rect in top-viewport CSS pixels. */
  async rectOf(ref: string, scroll: boolean) {
    await ready;
    const el = lookup(ref);
    if (!el) return staleError(ref);
    if (scroll) (el as HTMLElement).scrollIntoView({ block: "center", inline: "center", behavior: "instant" as ScrollBehavior });
    return { rect: topRect(el) };
  },
  async rects(refs: string[]) {
    await ready;
    const out: Record<string, Rect | null> = {};
    for (const r of refs) {
      const el = lookup(r);
      out[r] = el ? topRect(el) : null;
    }
    return out;
  },
  async info(ref: string) {
    await ready;
    const el = lookup(ref);
    if (!el) return staleError(ref);
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    return {
      tag,
      type,
      sensitive: isSensitiveField({ type, autocomplete: el.getAttribute("autocomplete") }),
      fileInput: tag === "input" && type === "file",
      contentEditable: el.getAttribute("contenteditable") === "true" || (el as HTMLElement).isContentEditable === true,
    };
  },
  focusedInfo() {
    const el = document.activeElement;
    if (!el || el === document.body) return { sensitive: false, tag: "" };
    return {
      tag: el.tagName.toLowerCase(),
      sensitive: isSensitiveField({ type: el.getAttribute("type"), autocomplete: el.getAttribute("autocomplete") }),
    };
  },
  /** form_input: set a value the way a user would, so React/Vue pick it up. */
  async setValue(ref: string, value: string | number | boolean) {
    await ready;
    const el = lookup(ref) as HTMLElement | null;
    if (!el) return staleError(ref);
    el.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    const fire = (target: Element, types: string[]) => {
      for (const t of types) target.dispatchEvent(new Event(t, { bubbles: true, cancelable: t !== "input" }));
    };
    const tag = el.tagName;
    if (tag === "SELECT") {
      const sel = el as HTMLSelectElement;
      const want = String(value);
      const idx = Array.from(sel.options).findIndex((o) => o.value === want || o.textContent?.trim().toLowerCase() === want.trim().toLowerCase());
      if (idx < 0) return { error: `No option "${want}" in ${ref}. Options: ${Array.from(sel.options).map((o) => `"${o.textContent?.trim()}"`).join(", ")}` };
      sel.focus();
      sel.selectedIndex = idx;
      fire(sel, ["input", "change"]);
      return { text: `Selected "${sel.options[idx].textContent?.trim()}" in ${ref}` };
    }
    if (tag === "INPUT" || tag === "TEXTAREA") {
      const input = el as HTMLInputElement;
      const type = (input.type || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        const want = typeof value === "boolean" ? value : /^(true|1|yes|on|checked)$/i.test(String(value));
        if (input.checked !== want) input.click();
        return { text: `Set ${ref} to ${input.checked ? "checked" : "unchecked"}` };
      }
      if (type === "file") return { error: "Use file_upload for file inputs." };
      input.focus();
      const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const v = String(value);
      if (setter) setter.call(input, v);
      else input.value = v;
      fire(input, ["input", "change"]);
      const sensitive = isSensitiveField({ type: input.getAttribute("type"), autocomplete: input.getAttribute("autocomplete") });
      return { text: sensitive ? `Set ${ref} (value hidden)` : `Set ${ref} to "${v.length > 80 ? v.slice(0, 80) + "…" : v}"` };
    }
    if (el.isContentEditable) {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
      const ok = document.execCommand("insertText", false, String(value));
      if (!ok) {
        el.textContent = String(value);
        fire(el, ["input"]);
      }
      return { text: `Set ${ref} text` };
    }
    return { error: `Element ${ref} (${tag.toLowerCase()}) is not a form control.` };
  },
  /** Link target at a point or ref, for the DOMAIN_TRANSITION check (SEC-05). */
  linkOf(target: { ref?: string; x?: number; y?: number }) {
    let el: Element | null = null;
    if (target.ref) el = lookup(target.ref);
    else if (typeof target.x === "number" && typeof target.y === "number") el = document.elementFromPoint(target.x, target.y);
    const a = el?.closest?.("a[href]") as HTMLAnchorElement | null;
    return a ? { href: a.href, blank: a.target === "_blank" } : null;
  },
  /** Values of sensitive fields, to scrub them from javascript_tool output (JS-07). */
  sensitiveValues(): string[] {
    const out: string[] = [];
    const visit = (root: ParentNode) => {
      for (const el of Array.from(root.querySelectorAll("input,textarea,select"))) {
        if (isSensitiveField({ type: el.getAttribute("type"), autocomplete: el.getAttribute("autocomplete") })) {
          const v = (el as HTMLInputElement).value;
          if (v && v.length >= 3) out.push(v);
        }
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) visit(sr);
      }
      for (const el of Array.from(root.querySelectorAll("*"))) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) visit(sr);
      }
    };
    visit(document);
    return out;
  },
  tagForUpload(ref: string, token: string) {
    const el = lookup(ref);
    if (!el) return staleError(ref);
    if (el.tagName !== "INPUT" || (el as HTMLInputElement).type !== "file") return { error: `${ref} is not a file input. Find the <input type="file"> element (it may be visually hidden) and use its ref.` };
    el.setAttribute("data-pi-upload", token);
    return { ok: true };
  },
  untagUpload(token: string) {
    document.querySelector(`[data-pi-upload="${token}"]`)?.removeAttribute("data-pi-upload");
  },
  /** upload_image: build a File and put it into an input, or drop it on a point. */
  async placeImage(dataB64: string, mime: string, filename: string, target: { ref?: string; x?: number; y?: number }) {
    await ready;
    const bin = atob(dataB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    if (target.ref) {
      const el = lookup(target.ref);
      if (!el) return staleError(target.ref);
      if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "file") {
        (el as HTMLInputElement).files = dt.files;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return { text: `Attached ${filename} to ${target.ref}` };
      }
      const r = el.getBoundingClientRect();
      target = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    if (typeof target.x === "number" && typeof target.y === "number") {
      const el = document.elementFromPoint(target.x, target.y) ?? document.body;
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: target.x, clientY: target.y, dataTransfer: dt }));
      }
      return { text: `Dropped ${filename} at (${Math.round(target.x)}, ${Math.round(target.y)})` };
    }
    return { error: "Provide ref or coordinate" };
  },
  /** AUX-07: capture target=_blank link clicks while the window is minimised. */
  captureBlank(on: boolean) {
    if (on) {
      blankLinks = [];
      if (blankListener) return;
      blankListener = (e: MouseEvent) => {
        const a = (e.target as Element | null)?.closest?.("a[target=_blank][href]") as HTMLAnchorElement | null;
        if (a && blankLinks.length < 3) {
          blankLinks.push(a.href);
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      };
      document.addEventListener("click", blankListener, true);
    } else {
      if (blankListener) document.removeEventListener("click", blankListener, true);
      blankListener = null;
      const out = blankLinks;
      blankLinks = [];
      return out;
    }
    return [];
  },
  viewportInfo() {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
  },
};

(globalThis as unknown as { __piA11y: typeof api }).__piA11y = api;
