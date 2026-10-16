import fs from "node:fs";
import path from "node:path";
import { agentDir } from "./config";

/** NFA-14: off by default; when on, writes to ~/.pi/agent/logs/browser-bridge.log (never to the terminal UI). */
export class Logger {
  private fd: number | null = null;
  constructor(private enabled: boolean) {}

  setEnabled(v: boolean) {
    this.enabled = v;
  }

  private open() {
    if (this.fd !== null) return;
    try {
      const dir = path.join(agentDir(), "logs");
      fs.mkdirSync(dir, { recursive: true });
      this.fd = fs.openSync(path.join(dir, "browser-bridge.log"), "a", 0o600);
    } catch {
      this.enabled = false;
    }
  }

  debug(msg: string, data?: unknown) {
    if (!this.enabled) return;
    this.open();
    if (this.fd === null) return;
    const line = `${new Date().toISOString()} ${msg}${data === undefined ? "" : " " + safeJson(data)}\n`;
    try {
      fs.writeSync(this.fd, line);
    } catch {
      /* ignore */
    }
  }

  close() {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
  }
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v, (_k, val) => (typeof val === "string" && val.length > 300 ? `${val.slice(0, 300)}…` : val));
    return s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  } catch {
    return String(v);
  }
}
