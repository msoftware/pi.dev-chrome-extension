import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { addAudit, enforceShotBudget, getShot, listAudit, purgeAudit, putShot, shotsOfSession } from "../../extension/src/common/idb";

const MB = 1024 * 1024;
const shot = (id: string, session: string, ts: number, mb: number) => ({ id, sessionId: session, tabId: 1, ts, mime: "image/jpeg", width: 10, height: 10, bytes: mb * MB, data: "A".repeat(10) });

describe("local stores", () => {
  it("UI-20: images of older messages are replaced by placeholders above 25 MB", async () => {
    await putShot(shot("ss_old000001", "s1", 1, 10));
    await putShot(shot("ss_mid000002", "s1", 2, 10));
    await putShot(shot("ss_new000003", "s1", 3, 10));
    await putShot(shot("ss_other0004", "s2", 1, 20));
    const replaced = await enforceShotBudget("s1");
    expect(replaced).toBe(1);
    expect((await getShot("ss_old000001"))!.data).toBeNull();
    expect((await getShot("ss_mid000002"))!.data).not.toBeNull();
    expect((await getShot("ss_new000003"))!.data).not.toBeNull();
    expect((await getShot("ss_other0004"))!.data).not.toBeNull(); // another session is untouched
    expect((await shotsOfSession("s1")).length).toBe(3); // records stay, so the chat can show a placeholder
  });
  it("SEC-14: audit entries older than 30 days are purged", async () => {
    const day = 24 * 3600 * 1000;
    await addAudit({ ts: Date.now() - 31 * day, sessionId: "s", tool: "old", action: "a", domain: "d", decision: "auto", result: "ok" });
    await addAudit({ ts: Date.now() - 29 * day, sessionId: "s", tool: "recent", action: "a", domain: "d", decision: "auto", result: "ok" });
    await purgeAudit();
    const tools = (await listAudit()).map((a) => a.tool);
    expect(tools).toContain("recent");
    expect(tools).not.toContain("old");
  });
});
