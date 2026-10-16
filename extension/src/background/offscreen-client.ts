/** Offscreen document management: sound and GIF encoding (permission "offscreen"). */
let creating: Promise<void> | null = null;

export async function ensureOffscreen(): Promise<void> {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType] });
  if (ctxs.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK" as chrome.offscreen.Reason, "WORKERS" as chrome.offscreen.Reason],
        justification: "Play notification sounds and encode recorded GIFs in a worker.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

export async function playSound(kind: "done" | "approval"): Promise<void> {
  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ target: "offscreen", type: "PLAY_SOUND", kind });
  } catch {
    /* sound is optional */
  }
}

export async function encodeGif(recordingId: string, options: unknown): Promise<{ base64: string; blobUrl: string; frames: number }> {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "ENCODE_GIF", recordingId, options });
  if (!r?.ok) throw new Error(r?.error ?? "GIF encoding failed");
  return r;
}
