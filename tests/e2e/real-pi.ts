import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./helpers";

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** A real pi process in RPC mode with the bridge loaded and a scripted fake model. */
export class RealPi {
  proc!: ChildProcessWithoutNullStreams;
  events: any[] = [];
  port = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "realpi-"));
  private buf = "";
  private waiters: ((e: any) => void)[] = [];
  stderr = "";
  dump = path.join(this.dir, "requests.jsonl");

  requests(): { systemPrompt: string; tools: string[] }[] {
    try {
      return fs.readFileSync(this.dump, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  async start(scenario: string, cwd = ROOT, opts: { persist?: boolean } = {}) {
    this.port = await freePort();
    const bin = path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
    this.proc = spawn(process.execPath, [bin, "--mode", "rpc", ...(opts.persist ? [] : ["--no-session"]), "--provider", "fakellm", "--model", "script", "--browser-port", String(this.port), "-e", path.join(ROOT, "packages/bridge/src/index.ts"), "-e", path.join(ROOT, "tests/e2e/fixtures/fake-llm.ts")], {
      cwd,
      env: { ...process.env, FAKE_LLM_DUMP: this.dump, PI_CODING_AGENT_DIR: path.join(this.dir, "agent"), FAKE_LLM_SCENARIO: scenario, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          this.events.push(ev);
          for (const w of [...this.waiters]) w(ev);
        } catch {
          /* ignore */
        }
      }
    });
    this.proc.stderr.on("data", (d) => (this.stderr += String(d)));
    await this.waitFor((e) => e.type === "extension_ui_request" && e.statusKey === "browser", 30_000, "bridge status");
  }

  send(cmd: Record<string, unknown>) {
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  waitFor(pred: (e: any) => boolean, ms = 30_000, label = "event"): Promise<any> {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== h);
        reject(new Error(`pi: timed out waiting for ${label}. stderr: ${this.stderr.slice(-800)}`));
      }, ms);
      const h = (e: any) => {
        if (pred(e)) {
          clearTimeout(t);
          this.waiters = this.waiters.filter((w) => w !== h);
          resolve(e);
        }
      };
      this.waiters.push(h);
    });
  }

  /** Runs /browser pair and returns the 6-digit code from the notification. */
  async pairingCode(): Promise<string> {
    const before = this.events.length;
    this.send({ id: "pair", type: "prompt", message: "/browser pair" });
    const ev = await this.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /Pairing code/.test(e.message ?? "") && this.events.indexOf(e) >= before, 15_000, "pairing code");
    return /Pairing code: (\d{6})/.exec(ev.message)![1];
  }

  async stop() {
    this.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The headless host (API-02): pi through the SDK, no terminal. */
export class HostProcess {
  proc!: ChildProcessWithoutNullStreams;
  out = "";
  port = 0;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-"));
  dump = path.join(this.dir, "requests.jsonl");

  async start(scenario: string) {
    this.port = await freePort();
    const cli = path.join(ROOT, "packages/host/bin/pi-browser-host.mjs");
    this.proc = spawn(process.execPath, [cli, "--no-session", "--provider", "fakellm", "--model", "script", "--browser-port", String(this.port), "-e", path.join(ROOT, "tests/e2e/fixtures/fake-llm.ts")], {
      cwd: ROOT,
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(this.dir, "agent"), FAKE_LLM_SCENARIO: scenario, FAKE_LLM_DUMP: this.dump, PI_OFFLINE: "1" },
    });
    this.proc.stdout.on("data", (d) => (this.out += String(d)));
    this.proc.stderr.on("data", (d) => (this.out += String(d)));
    const t = Date.now();
    while (!/pi-browser-host ready/.test(this.out)) {
      if (Date.now() - t > 40_000) throw new Error(`host did not start:\n${this.out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  code(): string {
    const m = /Pairing code: (\d{6})/.exec(this.out);
    if (!m) throw new Error(`no pairing code in host output:\n${this.out}`);
    return m[1];
  }
  async stop() {
    this.proc.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
