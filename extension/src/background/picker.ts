/** Area and element pickers for chat attachments (UI-16). Run in the page; results go back to the panel. */

export interface AreaPick { x: number; y: number; w: number; h: number; dpr: number }
export interface ElementPick { selector: string; text: string; ref?: string; outline?: string }

/** Self-contained (serialised into the page). */
export function pickerInject(kind: "area" | "element"): Promise<AreaPick | ElementPick | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;cursor:crosshair;";
    const root = host.attachShadow({ mode: "closed" });
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;border:2px solid #e0702c;background:rgba(224,112,44,.15);pointer-events:none;display:none;";
    const tip = document.createElement("div");
    tip.style.cssText = "position:fixed;left:50%;top:12px;transform:translateX(-50%);background:#1f1b16;color:#fff;font:13px system-ui;padding:6px 12px;border-radius:999px;pointer-events:none;";
    tip.textContent = kind === "area" ? "Drag to select an area · Esc to cancel" : "Click an element · Esc to cancel";
    root.append(box, tip);
    document.documentElement.appendChild(host);
    const done = (v: AreaPick | ElementPick | null) => {
      host.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        done(null);
      }
    };
    document.addEventListener("keydown", onKey, true);
    const under = (x: number, y: number): Element | null => {
      host.style.pointerEvents = "none";
      const el = document.elementFromPoint(x, y);
      host.style.pointerEvents = "";
      return el;
    };
    const cssPath = (el: Element): string => {
      if ((el as HTMLElement).id) return `#${CSS.escape((el as HTMLElement).id)}`;
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur && cur.nodeType === 1 && parts.length < 5 && cur !== document.body) {
        let p = cur.tagName.toLowerCase();
        const parent: Element | null = cur.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
          if (same.length > 1) p += `:nth-of-type(${same.indexOf(cur) + 1})`;
        }
        parts.unshift(p);
        cur = parent;
      }
      return parts.join(" > ");
    };
    if (kind === "area") {
      let sx = 0, sy = 0, drag = false;
      host.addEventListener("mousedown", (e) => {
        drag = true;
        sx = e.clientX;
        sy = e.clientY;
        box.style.display = "block";
        e.preventDefault();
      });
      host.addEventListener("mousemove", (e) => {
        if (!drag) return;
        box.style.left = Math.min(sx, e.clientX) + "px";
        box.style.top = Math.min(sy, e.clientY) + "px";
        box.style.width = Math.abs(e.clientX - sx) + "px";
        box.style.height = Math.abs(e.clientY - sy) + "px";
      });
      host.addEventListener("mouseup", (e) => {
        if (!drag) return;
        drag = false;
        const x = Math.min(sx, e.clientX), y = Math.min(sy, e.clientY);
        const w = Math.abs(e.clientX - sx), h = Math.abs(e.clientY - sy);
        host.remove();
        document.removeEventListener("keydown", onKey, true);
        // let the page repaint without the overlay before the service worker captures
        setTimeout(() => resolve(w < 4 || h < 4 ? null : { x, y, w, h, dpr: window.devicePixelRatio }), 80);
      });
    } else {
      host.addEventListener("mousemove", (e) => {
        const el = under(e.clientX, e.clientY);
        if (!el) return;
        const r = el.getBoundingClientRect();
        box.style.display = "block";
        box.style.left = r.left + "px";
        box.style.top = r.top + "px";
        box.style.width = r.width + "px";
        box.style.height = r.height + "px";
      });
      host.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = under(e.clientX, e.clientY);
        if (!el) return done(null);
        const api = (globalThis as any).__piA11y;
        let d: { ref?: string; outline?: string } = {};
        try {
          if (api) d = await api.describe(el);
        } catch {
          /* optional */
        }
        const text = ((el as HTMLElement).innerText ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 500);
        done({ selector: cssPath(el), text, ref: d.ref, outline: d.outline });
      });
    }
  });
}
