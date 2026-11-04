/**
 * Content script (top frame): glow frame, stop button, status bar and phantom cursor (requirements section 12 / 7.4).
 * Everything lives in a closed shadow root so page CSS can neither change nor be disturbed by it (IND-04).
 */
const t = (k: string, fallback: string) => {
  try {
    return chrome.i18n.getMessage(k) || fallback;
  } catch {
    return fallback;
  }
};

const INDICATOR_CSS = `
:host { all: initial; }
.glow { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity 300ms ease;
  box-shadow: inset 0 0 0 3px rgba(224,112,44,.85), inset 0 0 28px 6px rgba(224,112,44,.45); z-index: 2147483646; }
.glow.on { opacity: 1; }
.stop { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); pointer-events: auto; display: none;
  align-items: center; gap: 8px; padding: 9px 18px; border: 0; border-radius: 999px; background: #1f1b16; color: #fff;
  font: 600 13px/1 system-ui, sans-serif; cursor: pointer; box-shadow: 0 4px 18px rgba(0,0,0,.35); z-index: 2147483647; }
.stop.on { display: inline-flex; }
.stop:hover { background: #b3261e; }
.stop svg { width: 12px; height: 12px; }
.hint { position: fixed; left: 50%; bottom: 66px; transform: translateX(-50%); background: #fff; color: #1f1b16; padding: 8px 12px;
  border-radius: 8px; font: 13px/1.3 system-ui, sans-serif; box-shadow: 0 2px 12px rgba(0,0,0,.3); display: none; z-index: 2147483647; }
.hint.on { display: block; }
.bar { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); display: none; align-items: center; gap: 10px;
  padding: 7px 8px 7px 14px; border-radius: 999px; background: #1f1b16; color: #fff; font: 13px/1 system-ui, sans-serif;
  box-shadow: 0 4px 18px rgba(0,0,0,.3); pointer-events: auto; z-index: 2147483647; }
.bar.on { display: inline-flex; }
.bar button { border: 0; border-radius: 999px; padding: 6px 12px; font: 600 12px system-ui, sans-serif; cursor: pointer; background: #e0702c; color: #fff; }
.bar button.ghost { background: transparent; color: #ddd; }
.cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; opacity: 0; visibility: hidden;
  transition: opacity 200ms ease, visibility 0s linear 200ms; will-change: transform; z-index: 2147483647; }
.cursor.on { opacity: 1; visibility: visible; transition: opacity 200ms ease; }
.cursor svg { display: block; width: 22px; height: 22px; transform-origin: 3px 2px; transition: transform 110ms ease-out;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
.cursor.pressed svg { transform: scale(.8); }
.badge { position: absolute; left: 16px; top: 19px; display: none; gap: 3px; padding: 4px 6px; border-radius: 999px;
  background: #1f1b16; box-shadow: 0 2px 6px rgba(0,0,0,.35); }
.cursor.typing .badge { display: inline-flex; }
.badge span { width: 4px; height: 4px; border-radius: 50%; background: #fff; animation: pi-dot 900ms ease-in-out infinite; }
.badge span:nth-child(2) { animation-delay: 150ms; }
.badge span:nth-child(3) { animation-delay: 300ms; }
.ripple { position: fixed; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; box-sizing: border-box;
  border: 2px solid rgba(224,112,44,.95); background: rgba(224,112,44,.18); pointer-events: none; z-index: 2147483646;
  animation: pi-ripple 480ms ease-out forwards; }
.ripple.right { border-style: dashed; }
.ripple.hold { animation: pi-hold 260ms ease-out forwards; }
@keyframes pi-ripple { from { transform: scale(.25); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
@keyframes pi-hold { from { transform: scale(.25); opacity: 1; } to { transform: scale(.8); opacity: .55; } }
@keyframes pi-dot { 0%, 80%, 100% { opacity: .3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
.chrome-hidden .glow, .chrome-hidden .stop, .chrome-hidden .bar, .chrome-hidden .hint { visibility: hidden; }
@media (prefers-reduced-motion: reduce) { .glow, .cursor, .cursor svg { transition: none; } .badge span { animation: none; opacity: .8; } }
`;

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let glow: HTMLElement, stopBtn: HTMLElement, hint: HTMLElement, bar: HTMLElement, cursor: HTMLElement, wrap: HTMLElement;
let active = false;
let hintTimer: number | undefined;
let hb: number | undefined;

function build() {
  if (host) return;
  host = document.createElement("div");
  host.setAttribute("data-pi-agent-indicator", "");
  host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = INDICATOR_CSS;
  wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="glow"></div>
    <button class="stop" type="button"><svg viewBox="0 0 12 12"><rect width="12" height="12" rx="2" fill="currentColor"/></svg><span></span></button>
    <div class="hint" role="status"></div>
    <div class="bar" role="status"><span class="msg"></span><button class="open" type="button"></button><button class="ghost dismiss" type="button"></button></div>
    <div class="cursor" aria-hidden="true"><svg viewBox="0 0 22 22"><path d="M3 2 L3 17 L7.2 13.2 L10 19.5 L12.6 18.3 L9.9 12 L15.5 12 Z" fill="#e0702c" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><div class="badge"><span></span><span></span><span></span></div></div>`;
  root.append(style, wrap);
  glow = wrap.querySelector(".glow")!;
  stopBtn = wrap.querySelector(".stop")!;
  hint = wrap.querySelector(".hint")!;
  bar = wrap.querySelector(".bar")!;
  cursor = wrap.querySelector(".cursor")!;
  stopBtn.querySelector("span")!.textContent = t("indStop", "Stop agent");
  bar.querySelector(".msg")!.textContent = t("indStatic", "Agent active in this tab group");
  (bar.querySelector(".open") as HTMLElement).textContent = t("indOpenChat", "Open chat");
  (bar.querySelector(".dismiss") as HTMLElement).textContent = t("indHide", "Hide");
  stopBtn.addEventListener("click", onStop);
  bar.querySelector(".open")!.addEventListener("click", () => chrome.runtime.sendMessage({ type: "SWITCH_TO_MAIN_TAB" }));
  bar.querySelector(".dismiss")!.addEventListener("click", () => {
    bar.classList.remove("on");
    chrome.runtime.sendMessage({ type: "HIDE_STATIC_INDICATOR_REQUEST" });
  });
  (document.documentElement || document).appendChild(host);
}

function onStop() {
  let confirmed = false;
  try {
    chrome.runtime.sendMessage({ type: "STOP_AGENT" }, (r) => {
      if (!chrome.runtime.lastError && r?.ok) confirmed = true;
    });
  } catch {
    /* extension context gone */
  }
  window.setTimeout(() => {
    if (confirmed) return;
    hint.textContent = t("indStopFallback", "Could not reach the agent. Close the side panel to stop it.");
    hint.classList.add("on");
    window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => hint.classList.remove("on"), 6000);
  }, 1200);
}

function show() {
  build();
  active = true;
  glow.classList.add("on");
  stopBtn.classList.add("on");
  bar.classList.remove("on");
}
function hide() {
  if (!host) return;
  active = false;
  glow.classList.remove("on");
  stopBtn.classList.remove("on");
  cursor.classList.remove("on", "pressed", "typing");
}

// ---- Phantom cursor animation: the cursor flies to wherever the agent acts next. ----

interface Point {
  x: number;
  y: number;
}
/** Tip of the arrow inside the 22x22 SVG (path starts at M3 2). */
const TIP = { x: 3, y: 2 };
let pos: Point | null = null;
let flight: { stop: () => void } | null = null;
let typingTimer: number | undefined;
let releaseTimer: number | undefined;

const reducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clampToView = (p: Point): Point => ({ x: clamp(p.x, 0, Math.max(0, window.innerWidth - 1)), y: clamp(p.y, 0, Math.max(0, window.innerHeight - 1)) });
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function place(p: Point) {
  pos = p;
  cursor.style.transform = `translate(${(p.x - TIP.x).toFixed(1)}px, ${(p.y - TIP.y).toFixed(1)}px)`;
}

/** Animates the cursor along a gently curved path (like a hand moving a mouse) and resolves on arrival. */
function fly(target: Point, from: Point | null, duration?: number): Promise<void> {
  build();
  flight?.stop(); // a new target interrupts the running flight where it is
  window.clearTimeout(typingTimer);
  cursor.classList.remove("typing");
  const end = clampToView(target);
  cursor.classList.add("on");
  // After a page load the script lost its position: continue from where the service worker saw it last, else swoop in.
  const start = pos ?? (from ? clampToView(from) : clampToView({ x: end.x + 48, y: end.y + 64 }));
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);
  const ms = duration ?? clamp(220 + dist * 0.45, 220, 600);
  if (document.hidden || reducedMotion() || dist < 1 || ms <= 0) {
    place(end);
    return Promise.resolve();
  }
  // Quadratic Bézier with the control point pushed sideways: a slight arc instead of a robotic straight line.
  const bend = Math.min(dist * 0.18, 70) * (dx >= 0 ? -1 : 1);
  const cx = (start.x + end.x) / 2 + (-dy / dist) * bend;
  const cy = (start.y + end.y) / 2 + (dx / dist) * bend;
  return new Promise<void>((resolve) => {
    const t0 = performance.now();
    let raf = 0;
    let done = false;
    const finish = (arrive: boolean) => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(safety);
      if (arrive) place(end);
      if (flight === me) flight = null;
      resolve();
    };
    const me = { stop: () => finish(false) };
    const step = (now: number) => {
      const p = clamp((now - t0) / ms, 0, 1);
      const e = easeInOutCubic(p);
      const u = 1 - e;
      place({ x: u * u * start.x + 2 * u * e * cx + e * e * end.x, y: u * u * start.y + 2 * u * e * cy + e * e * end.y });
      if (p < 1) raf = requestAnimationFrame(step);
      else finish(true);
    };
    // rAF stops in background tabs: never let the caller wait longer than the flight itself.
    const safety = window.setTimeout(() => finish(true), ms + 80);
    flight = me;
    place(start);
    raf = requestAnimationFrame(step);
  });
}

function ripple(at: Point, variant = "") {
  if (reducedMotion()) return;
  const r = document.createElement("div");
  r.className = `ripple${variant ? ` ${variant}` : ""}`;
  r.style.left = `${at.x}px`;
  r.style.top = `${at.y}px`;
  wrap.appendChild(r);
  const remove = () => r.remove();
  r.addEventListener("animationend", () => {
    if (variant !== "hold") remove();
  });
  window.setTimeout(remove, variant === "hold" ? 5000 : 1000);
  return r;
}

let holdRipple: HTMLElement | undefined;

function effect(msg: { kind: string; button?: string; count?: number }) {
  if (!host || !pos) return;
  const at = { ...pos };
  switch (msg.kind) {
    case "click": {
      const n = clamp(Math.round(msg.count ?? 1), 1, 3);
      cursor.classList.add("pressed");
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(() => cursor.classList.remove("pressed"), 110 * n + 40);
      for (let i = 0; i < n; i++) window.setTimeout(() => ripple(at, msg.button === "right" ? "right" : ""), i * 110);
      break;
    }
    case "press":
      cursor.classList.add("pressed");
      holdRipple?.remove();
      holdRipple = ripple(at, "hold");
      break;
    case "release":
      cursor.classList.remove("pressed");
      holdRipple?.remove();
      holdRipple = undefined;
      ripple(at);
      break;
    case "type":
      cursor.classList.add("typing");
      window.clearTimeout(typingTimer);
      typingTimer = window.setTimeout(() => cursor.classList.remove("typing"), 1400);
      break;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case "SHOW_AGENT_INDICATORS":
      show();
      break;
    case "HIDE_AGENT_INDICATORS":
      hide();
      break;
    case "HIDE_FOR_TOOL_USE":
      if (host) {
        // cursor:false keeps the phantom cursor visible (click flow); screenshots hide everything.
        if (msg.cursor === false) wrap.classList.add("chrome-hidden");
        else host.style.visibility = "hidden";
      }
      break;
    case "SHOW_AFTER_TOOL_USE":
      if (host) {
        host.style.visibility = "";
        wrap.classList.remove("chrome-hidden");
      }
      break;
    case "SHOW_STATIC_INDICATOR":
      build();
      if (!active) bar.classList.add("on");
      break;
    case "HIDE_STATIC_INDICATOR":
      if (host) bar.classList.remove("on");
      break;
    case "UPDATE_PHANTOM_CURSOR": {
      const from = typeof msg.fromX === "number" && typeof msg.fromY === "number" ? { x: msg.fromX, y: msg.fromY } : null;
      const arrived = fly({ x: Number(msg.x) || 0, y: Number(msg.y) || 0 }, from, typeof msg.duration === "number" ? msg.duration : undefined);
      if (typeof msg.pressed === "boolean") cursor.classList.toggle("pressed", msg.pressed);
      // Answer on arrival so the service worker dispatches the real input only once the cursor is there.
      arrived.then(() => sendResponse({ ok: true }));
      return true;
    }
    case "PHANTOM_CURSOR_EFFECT":
      effect(msg);
      break;
    case "PING_INDICATOR":
      sendResponse({ active });
      return;
  }
  sendResponse({ ok: true });
});

// IND-02: heartbeat every 5 s; if the service worker lost the state it restores it after the next load.
function beat() {
  try {
    chrome.runtime.sendMessage({ type: "INDICATOR_HEARTBEAT", active }, (r) => {
      void chrome.runtime.lastError;
      if (r?.restore === "show" && !active) show();
      if (r?.restore === "hide" && active) hide();
    });
  } catch {
    window.clearInterval(hb);
  }
}
beat();
hb = window.setInterval(beat, 5000);
export {};
