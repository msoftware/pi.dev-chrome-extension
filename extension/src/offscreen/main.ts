/** Offscreen document: notification sounds and GIF encoding in a Web Worker (EXT permission "offscreen"). */
import { framesOf } from "../common/idb";

let ctx: AudioContext | null = null;

function beep(kind: "done" | "approval") {
  ctx ??= new AudioContext();
  const notes = kind === "done" ? [659, 880] : [784, 784];
  const t0 = ctx.currentTime;
  notes.forEach((f, i) => {
    const o = ctx!.createOscillator();
    const g = ctx!.createGain();
    o.type = "sine";
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t0 + i * 0.16);
    g.gain.exponentialRampToValueAtTime(0.18, t0 + i * 0.16 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.15);
    o.connect(g).connect(ctx!.destination);
    o.start(t0 + i * 0.16);
    o.stop(t0 + i * 0.16 + 0.16);
  });
}

async function encode(recordingId: string, options: unknown): Promise<{ base64: string; blobUrl: string; frames: number }> {
  const frames = await framesOf(recordingId);
  if (!frames.length) throw new Error("No frames recorded");
  const worker = new Worker(new URL("./gif-worker.ts", import.meta.url), { type: "module" });
  const gif = await new Promise<ArrayBuffer>((resolve, reject) => {
    worker.onmessage = (e) => (e.data.ok ? resolve(e.data.gif) : reject(new Error(e.data.error)));
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({ frames: frames.map((f) => ({ data: f.data, width: f.width, height: f.height, label: f.label, click: f.click, drag: f.drag })), options });
  }).finally(() => worker.terminate());
  const blob = new Blob([gif], { type: "image/gif" });
  const blobUrl = URL.createObjectURL(blob);
  const bytes = new Uint8Array(gif);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(s), blobUrl, frames: frames.length };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "PLAY_SOUND") {
    try {
      beep(msg.kind);
      sendResponse({ ok: true });
    } catch (e: any) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
    return;
  }
  if (msg.type === "ENCODE_GIF") {
    encode(msg.recordingId, msg.options).then(
      (r) => sendResponse({ ok: true, ...r }),
      (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }),
    );
    return true;
  }
});
