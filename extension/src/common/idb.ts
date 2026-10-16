/** Small IndexedDB wrapper for screenshots (SHOT-10, UI-20), audit log (SEC-14) and GIF frames. */

export interface ShotRecord {
  id: string;
  sessionId: string;
  tabId: number;
  ts: number;
  mime: string;
  width: number;
  height: number;
  bytes: number;
  /** Base64 JPEG; null once replaced by a placeholder (UI-20). */
  data: string | null;
}

export interface AuditRecord {
  id?: number;
  ts: number;
  sessionId: string;
  tool: string;
  action: string;
  domain: string;
  decision: string;
  result: "ok" | "error" | "denied";
  note?: string;
}

export interface FrameRecord {
  id?: number;
  recordingId: string;
  ts: number;
  data: string; // base64 jpeg
  width: number;
  height: number;
  label: string;
  click?: [number, number];
  drag?: [number, number, number, number];
}

const DB = "pi-browser";
let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      const shots = db.createObjectStore("screenshots", { keyPath: "id" });
      shots.createIndex("sessionId", "sessionId");
      const audit = db.createObjectStore("audit", { keyPath: "id", autoIncrement: true });
      audit.createIndex("ts", "ts");
      const frames = db.createObjectStore("frames", { keyPath: "id", autoIncrement: true });
      frames.createIndex("recordingId", "recordingId");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(store: string, mode: IDBTransactionMode) {
  const db = await open();
  return db.transaction(store, mode).objectStore(store);
}

export async function putShot(s: ShotRecord): Promise<void> {
  await req((await tx("screenshots", "readwrite")).put(s));
}
export async function getShot(id: string): Promise<ShotRecord | undefined> {
  return req((await tx("screenshots", "readonly")).get(id));
}
export async function shotsOfSession(sessionId: string): Promise<ShotRecord[]> {
  return req((await tx("screenshots", "readonly")).index("sessionId").getAll(sessionId));
}

/** UI-20: keep a session's stored screenshots under `maxBytes` by replacing the oldest images with placeholders. */
export async function enforceShotBudget(sessionId: string, maxBytes = 25 * 1024 * 1024): Promise<number> {
  const all = (await shotsOfSession(sessionId)).sort((a, b) => a.ts - b.ts);
  let total = all.reduce((n, s) => n + (s.data ? s.bytes : 0), 0);
  let replaced = 0;
  const store = await tx("screenshots", "readwrite");
  for (const s of all) {
    if (total <= maxBytes) break;
    if (!s.data) continue;
    total -= s.bytes;
    s.data = null;
    await req(store.put(s));
    replaced++;
  }
  return replaced;
}

export async function addAudit(a: AuditRecord): Promise<void> {
  await req((await tx("audit", "readwrite")).add(a));
}
export async function listAudit(limit = 2000): Promise<AuditRecord[]> {
  const all = await req((await tx("audit", "readonly")).getAll());
  return all.sort((a, b) => b.ts - a.ts).slice(0, limit);
}
/** SEC-14: retention 30 days. */
export async function purgeAudit(olderThanMs = 30 * 24 * 3600 * 1000): Promise<void> {
  const store = await tx("audit", "readwrite");
  const range = IDBKeyRange.upperBound(Date.now() - olderThanMs);
  await new Promise<void>((resolve, reject) => {
    const c = store.index("ts").openCursor(range);
    c.onsuccess = () => {
      const cur = c.result;
      if (cur) {
        cur.delete();
        cur.continue();
      } else resolve();
    };
    c.onerror = () => reject(c.error);
  });
}

export async function clearAll(): Promise<void> {
  const db = await open();
  await Promise.all(
    ["screenshots", "audit", "frames"].map(
      (n) =>
        new Promise<void>((res, rej) => {
          const r = db.transaction(n, "readwrite").objectStore(n).clear();
          r.onsuccess = () => res();
          r.onerror = () => rej(r.error);
        }),
    ),
  );
}

export async function addFrame(f: FrameRecord): Promise<void> {
  await req((await tx("frames", "readwrite")).add(f));
}
export async function framesOf(recordingId: string): Promise<FrameRecord[]> {
  const all = await req((await tx("frames", "readonly")).index("recordingId").getAll(recordingId));
  return all.sort((a, b) => a.ts - b.ts);
}
export async function clearFrames(recordingId: string): Promise<void> {
  const store = await tx("frames", "readwrite");
  const keys = await req(store.index("recordingId").getAllKeys(recordingId));
  for (const k of keys) await req(store.delete(k));
}
