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
.cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none; display: none; z-index: 2147483647;
  transition: transform 180ms cubic-bezier(0.2, 0, 0, 1); will-change: transform; filter: drop-shadow(0 1px 2px rgba(0,0,0,.45)); }
.cursor.on { display: block; }
.chrome-hidden .glow, .chrome-hidden .stop, .chrome-hidden .bar, .chrome-hidden .hint { visibility: hidden; }
@media (prefers-reduced-motion: reduce) { .glow, .cursor { transition: none; } }
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
    <svg class="cursor" viewBox="0 0 22 22" aria-hidden="true"><path d="M3 2 L3 17 L7.2 13.2 L10 19.5 L12.6 18.3 L9.9 12 L15.5 12 Z" fill="#e0702c" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  root.append(style, wrap);
  glow = wrap.querySelector(".glow")!;
  stopBtn = wrap.querySelector(".stop")!;
  hint = wrap.querySelector(".hint")!;
  bar = wrap.querySelector(".bar")!;
  cursor = wrap.querySelector(".cursor")! as unknown as HTMLElement;
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
  cursor.classList.remove("on");
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
    case "UPDATE_PHANTOM_CURSOR":
      build();
      cursor.classList.add("on");
      cursor.style.transform = `translate(${Math.round(msg.x)}px, ${Math.round(msg.y)}px)`;
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
