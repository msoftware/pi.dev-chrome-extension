import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentDir } from "./config";
import { PAIRING_CODE_TTL_MS } from "@pi-browser/shared";

interface DeviceRecord {
  id: string;
  label: string;
  hash: string;
  createdAt: number;
}

/** Bearer tokens (256 bit, API-06), stored only as SHA-256 hashes. Several browser profiles = several devices (API-09). */
export class TokenStore {
  private devices: DeviceRecord[] = [];
  private code: { value: string; expires: number; attempts: number } | null = null;
  private file: string;

  constructor(file?: string) {
    this.file = file ?? path.join(agentDir(), "browser-bridge-tokens.json");
    try {
      this.devices = JSON.parse(fs.readFileSync(this.file, "utf8")) as DeviceRecord[];
    } catch {
      this.devices = [];
    }
  }

  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
    } catch {
      /* keep in memory */
    }
  }

  get paired(): boolean {
    return this.devices.length > 0;
  }

  listDevices(): { id: string; label: string; createdAt: number }[] {
    return this.devices.map(({ id, label, createdAt }) => ({ id, label, createdAt }));
  }

  /** Creates a 6-digit code valid for 5 minutes. */
  createPairingCode(now = Date.now()): { code: string; expiresAt: number } {
    const value = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    this.code = { value, expires: now + PAIRING_CODE_TTL_MS, attempts: 0 };
    return { code: value, expiresAt: this.code.expires };
  }

  activeCode(now = Date.now()): { code: string; expiresAt: number } | null {
    if (!this.code || this.code.expires < now) return null;
    return { code: this.code.value, expiresAt: this.code.expires };
  }

  /** Exchanges a code for a token; wrong guesses burn the code after 5 attempts. */
  redeem(code: string, label: string, now = Date.now()): { token: string; deviceId: string } | null {
    const c = this.code;
    if (!c || c.expires < now) return null;
    c.attempts++;
    const a = Buffer.from(c.value);
    const b = Buffer.from(String(code));
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) {
      if (c.attempts >= 5) this.code = null;
      return null;
    }
    this.code = null;
    const token = crypto.randomBytes(32).toString("base64url");
    const rec: DeviceRecord = { id: crypto.randomBytes(6).toString("hex"), label: label.slice(0, 60) || "Browser", hash: hash(token), createdAt: now };
    this.devices.push(rec);
    this.persist();
    return { token, deviceId: rec.id };
  }

  /** Returns the device id for a valid token. */
  verify(token: string): string | null {
    const h = Buffer.from(hash(token));
    for (const d of this.devices) {
      const dh = Buffer.from(d.hash);
      if (dh.length === h.length && crypto.timingSafeEqual(dh, h)) return d.id;
    }
    return null;
  }

  revoke(deviceId?: string): number {
    const before = this.devices.length;
    this.devices = deviceId ? this.devices.filter((d) => d.id !== deviceId) : [];
    this.persist();
    return before - this.devices.length;
  }
}

function hash(t: string): string {
  return crypto.createHash("sha256").update(t).digest("hex");
}
