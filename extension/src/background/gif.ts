/** gif_creator (AUX-11, KANN): record a frame after every action, then encode in the offscreen worker. */
import { addFrame, clearFrames, putShot } from "../common/idb";
import { capture, newShotId } from "./screenshot";
import { encodeGif } from "./offscreen-client";
import { callPage } from "./page";
import { text, ToolError, type Out, type ToolEnv } from "./env";

interface Recording {
  id: string;
  active: boolean;
  frames: number;
  options: Record<string, unknown>;
}

export class GifRecorder {
  private recs = new Map<number, Recording>(); // groupId -> recording

  recording(groupId: number): boolean {
    return !!this.recs.get(groupId)?.active;
  }

  async frame(env: ToolEnv, tabId: number, action: Record<string, any>): Promise<void> {
    const rec = this.recs.get(env.group.groupId);
    if (!rec?.active) return;
    const shot = await capture(tabId, { sessionId: env.sessionId, guard: () => env.guard(tabId, "recording a frame") });
    const a = action;
    const label = a.action ? `${a.action}${a.ref ? ` ${a.ref}` : ""}${a.text ? `: ${String(a.text).slice(0, 30)}` : ""}` : "";
    await addFrame({
      recordingId: rec.id,
      ts: Date.now(),
      data: shot.base64,
      width: shot.width,
      height: shot.height,
      label,
      click: /click/.test(String(a.action)) && a.coordinate ? [a.coordinate[0], a.coordinate[1]] : undefined,
      drag: a.action === "left_click_drag" && a.start_coordinate && a.coordinate ? [a.start_coordinate[0], a.start_coordinate[1], a.coordinate[0], a.coordinate[1]] : undefined,
    });
    rec.frames++;
  }

  async handle(env: ToolEnv, tabId: number, a: { action: string; download?: boolean; coordinate?: [number, number]; options?: Record<string, unknown> }): Promise<Out> {
    const gid = env.group.groupId;
    const action = a.action === "start" ? "start_recording" : a.action === "stop" ? "stop_recording" : a.action; // short names are accepted too
    switch (action) {
      case "start_recording": {
        const old = this.recs.get(gid);
        if (old) await clearFrames(old.id);
        const rec: Recording = { id: crypto.randomUUID(), active: true, frames: 0, options: a.options ?? {} };
        this.recs.set(gid, rec);
        await env.authorize({ tool: "gif_creator", args: a, tabUrl: (await chrome.tabs.get(tabId)).url ?? "", preview: "Record the following actions as a GIF" });
        await this.frame(env, tabId, { action: "start" });
        return { content: [text("Recording started. Every action now adds a frame.")] };
      }
      case "stop_recording": {
        const rec = this.recs.get(gid);
        if (!rec) throw new ToolError("No recording in progress.");
        rec.active = false;
        return { content: [text(`Recording stopped with ${rec.frames} frames. Use export to get the GIF.`)] };
      }
      case "clear": {
        const rec = this.recs.get(gid);
        if (rec) await clearFrames(rec.id);
        this.recs.delete(gid);
        return { content: [text("Recording cleared.")] };
      }
      case "export": {
        const rec = this.recs.get(gid);
        if (!rec || !rec.frames) throw new ToolError("There is nothing to export. Start a recording and perform some actions first.");
        rec.active = false;
        const quality = (env.settings.gifQuality as number) ?? 10;
        const r = await encodeGif(rec.id, { quality, ...(rec.options ?? {}), ...(a.options ?? {}) });
        const id = newShotId();
        await putShot({ id, sessionId: env.sessionId, tabId, ts: Date.now(), mime: "image/gif", width: 0, height: 0, bytes: Math.floor((r.base64.length * 3) / 4), data: r.base64 });
        if (a.coordinate) {
          const { toViewport } = await import("./input");
          const [x, y] = toViewport(tabId, a.coordinate[0], a.coordinate[1]);
          const res = await callPage<{ text?: string; error?: string }>(tabId, "placeImage", [r.base64, "image/gif", "recording.gif", { x, y }]);
          if (res.error) throw new ToolError(res.error);
          return { content: [text(`${res.text} (${rec.frames} frames, image ${id}).`)] };
        }
        if (a.download !== false) {
          await chrome.downloads.download({ url: r.blobUrl, filename: `agent-recording-${Date.now()}.gif`, saveAs: false });
          return { content: [text(`Exported ${rec.frames} frames as a GIF download. It is also stored as image ${id} (usable with upload_image).`)], details: { screenshotId: id } };
        }
        return { content: [text(`Exported ${rec.frames} frames as image ${id} (usable with upload_image).`)], details: { screenshotId: id } };
      }
    }
    throw new ToolError(`Unknown gif_creator action ${a.action}`);
  }
}
