#!/usr/bin/env node
import path from "node:path";
import { startHost } from "./host";

function arg(name: string, short?: string): string | undefined {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === `--${name}` || (short && a[i] === `-${short}`)) return a[i + 1];
    if (a[i].startsWith(`--${name}=`)) return a[i].slice(name.length + 3);
  }
  return undefined;
}
function all(name: string, short: string): string[] {
  const a = process.argv.slice(2);
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) if ((a[i] === `--${name}` || a[i] === `-${short}`) && a[i + 1]) out.push(path.resolve(a[i + 1]));
  return out;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`pi-browser-host: run a pi session for the Browser Agent side panel (panel-led mode)

Usage: pi-browser-host [--cwd <dir>] [--browser-port <port>] [--provider <p> --model <m>] [-e <extension.ts>]... [--no-session]

The panel pairs with the 6-digit code printed at start. Stop with Ctrl+C.`);
  process.exit(0);
}

const host = await startHost({
  cwd: path.resolve(arg("cwd") ?? process.cwd()),
  port: arg("browser-port") ? Number(arg("browser-port")) : undefined,
  provider: arg("provider"),
  model: arg("model"),
  extensions: all("extension", "e"),
  persistSessions: !process.argv.includes("--no-session"),
});

const stop = async () => {
  await host.dispose().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
