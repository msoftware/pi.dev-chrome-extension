import { addAudit } from "../common/idb";

/** SEC-14: every tool call is logged locally (time, session, tool, action, domain, decision, result). */
export async function audit(entry: {
  sessionId: string;
  tool: string;
  action: string;
  domain: string;
  decision: string;
  result: "ok" | "error" | "denied";
  note?: string;
}): Promise<void> {
  try {
    await addAudit({ ts: Date.now(), ...entry });
  } catch (e) {
    console.warn("audit failed", e);
  }
}
