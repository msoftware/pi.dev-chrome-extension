/** Keyboard input tables for CDP Input.dispatchKeyEvent (requirements section 7.3). */

export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export interface KeyDef {
  key: string;
  code: string;
  vk: number;
  /** Text inserted by the key without modifiers; undefined for non-printing keys. */
  text?: string;
}

const T = new Map<string, KeyDef>();
const SHIFTED = new Map<string, { base: string }>();

function add(name: string, def: KeyDef) {
  T.set(name, def);
}

for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  add(lower, { key: lower, code: `Key${lower.toUpperCase()}`, vk: 65 + i, text: lower });
  SHIFTED.set(lower.toUpperCase(), { base: lower });
}
for (let i = 0; i <= 9; i++) {
  add(String(i), { key: String(i), code: `Digit${i}`, vk: 48 + i, text: String(i) });
}
const digitShift = ")!@#$%^&*(";
for (let i = 0; i <= 9; i++) SHIFTED.set(digitShift[i], { base: String(i) });

const punct: [string, string, string, number][] = [
  [";", ":", "Semicolon", 186],
  ["=", "+", "Equal", 187],
  [",", "<", "Comma", 188],
  ["-", "_", "Minus", 189],
  [".", ">", "Period", 190],
  ["/", "?", "Slash", 191],
  ["`", "~", "Backquote", 192],
  ["[", "{", "BracketLeft", 219],
  ["\\", "|", "Backslash", 220],
  ["]", "}", "BracketRight", 221],
  ["'", '"', "Quote", 222],
];
for (const [base, shifted, code, vk] of punct) {
  add(base, { key: base, code, vk, text: base });
  SHIFTED.set(shifted, { base });
}
add(" ", { key: " ", code: "Space", vk: 32, text: " " });

const named: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  space: T.get(" ")!,
};
for (let i = 1; i <= 12; i++) named[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };
const aliases: Record<string, string> = {
  return: "enter", esc: "escape", del: "delete", left: "arrowleft", right: "arrowright", up: "arrowup", down: "arrowdown",
  pgup: "pageup", pgdn: "pagedown", ins: "insert",
};

export interface KeyEvent {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  modifiers: number;
}

/** Table entry for a single typed character, or null if it needs Input.insertText (umlauts, emoji, ...). */
export function charToKeyEvent(ch: string): KeyEvent | null {
  if (ch === "\n" || ch === "\r") {
    const e = named.enter;
    return { key: e.key, code: e.code, windowsVirtualKeyCode: e.vk, text: "\r", modifiers: 0 };
  }
  if (ch === "\t") {
    const e = named.tab;
    return { key: e.key, code: e.code, windowsVirtualKeyCode: e.vk, modifiers: 0 };
  }
  const direct = T.get(ch);
  if (direct) return { key: ch, code: direct.code, windowsVirtualKeyCode: direct.vk, text: ch, modifiers: 0 };
  const s = SHIFTED.get(ch);
  if (s) {
    const base = T.get(s.base)!;
    return { key: ch, code: base.code, windowsVirtualKeyCode: base.vk, text: ch, modifiers: MOD.shift };
  }
  return null;
}

export type Platform = "mac" | "win" | "linux";

export interface ParsedCombo {
  modifiers: number;
  /** The final, non-modifier key; null when the combo is only modifiers. */
  key: KeyEvent | null;
  /** CDP `commands` editing commands (e.g. selectAll) for combos that need them. */
  commands: string[];
  raw: string;
}

const MOD_NAMES: Record<string, number> = {
  alt: MOD.alt, option: MOD.alt, opt: MOD.alt,
  ctrl: MOD.ctrl, control: MOD.ctrl,
  meta: MOD.meta, cmd: MOD.meta, command: MOD.meta, win: MOD.meta, windows: MOD.meta, super: MOD.meta,
  shift: MOD.shift,
};

const EDIT_COMMANDS: Record<string, string> = {
  a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo", y: "redo",
};

function splitCombo(combo: string): string[] {
  if (combo === "+") return ["+"];
  if (combo.endsWith("++")) return [...combo.slice(0, -2).split("+"), "+"];
  return combo.split("+");
}

/** Parses one combination such as "ctrl+shift+a". cmd/ctrl are mapped to the platform's primary modifier (INP-11). */
export function parseCombo(combo: string, platform: Platform = "linux"): ParsedCombo {
  const parts = splitCombo(combo);
  let modifiers = 0;
  let keyPart = null as string | null;
  parts.forEach((p, i) => {
    const lower = p.toLowerCase();
    if (i < parts.length - 1 && lower in MOD_NAMES) modifiers |= MOD_NAMES[lower];
    else if (i === parts.length - 1 && lower in MOD_NAMES && parts.length === 1) modifiers |= MOD_NAMES[lower];
    else if (i === parts.length - 1) keyPart = p;
  });
  // Platform-aware primary modifier: models say cmd/meta on Linux, ctrl on macOS, etc.
  const sawMeta = parts.slice(0, -1).some((p) => ["cmd", "command", "meta", "win", "windows", "super"].includes(p.toLowerCase()));
  const sawCtrl = parts.slice(0, -1).some((p) => ["ctrl", "control"].includes(p.toLowerCase()));
  const kpLower = (keyPart as string | null)?.toLowerCase() ?? "";
  if (platform === "mac" && sawCtrl && !sawMeta && kpLower in EDIT_COMMANDS) {
    modifiers = (modifiers & ~MOD.ctrl) | MOD.meta;
  } else if (platform !== "mac" && sawMeta && !sawCtrl && kpLower in EDIT_COMMANDS) {
    modifiers = (modifiers & ~MOD.meta) | MOD.ctrl;
  }
  let key: KeyEvent | null = null;
  if (keyPart !== null) {
    const kp: string = keyPart;
    const lower = kp.toLowerCase();
    const named_ = named[aliases[lower] ?? lower];
    if (named_) key = { key: named_.key, code: named_.code, windowsVirtualKeyCode: named_.vk, text: named_.text, modifiers };
    else if (kp.length === 1) {
      const ev = charToKeyEvent(kp);
      if (ev) key = { ...ev, modifiers: modifiers | ev.modifiers };
      else key = { key: kp, code: "", windowsVirtualKeyCode: 0, text: kp, modifiers };
    } else throw new Error(`Unknown key "${kp}"`);
  }
  const commands: string[] = [];
  const primary = modifiers & (platform === "mac" ? MOD.meta : MOD.ctrl);
  if (key && primary && !(modifiers & (MOD.alt)) && key.key.length === 1) {
    const base = key.key.toLowerCase();
    if (base === "z" && modifiers & MOD.shift) commands.push("redo");
    else if (base in EDIT_COMMANDS && !(modifiers & MOD.shift)) commands.push(EDIT_COMMANDS[base]);
  }
  return { modifiers, key, commands, raw: combo };
}

/** Splits "ctrl+a Delete" into combos (space-separated sequence); a lone "+" or " " stays a key. */
export function parseKeySequence(text: string, platform: Platform = "linux"): ParsedCombo[] {
  const trimmed = text.trim();
  if (trimmed === "") return [parseCombo(" ", platform)];
  return trimmed.split(/\s+/).map((c) => parseCombo(c, platform));
}

/** True for keys that produce text and must be sent as keyDown+char; false for rawKeyDown keys. */
export function isPrintable(ev: KeyEvent): boolean {
  return !!ev.text && ev.text !== "\r" ? true : ev.key === "Enter";
}
