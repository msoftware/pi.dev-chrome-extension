/** NFA-14: debug output is off by default and never contains page content, only tool names and ids. */
let enabled = false;

export function setDebug(v: boolean) {
  enabled = v;
}

export const log = {
  debug(...args: unknown[]) {
    if (enabled) console.debug("[browser-agent]", ...args);
  },
  warn(...args: unknown[]) {
    console.warn("[browser-agent]", ...args);
  },
};
