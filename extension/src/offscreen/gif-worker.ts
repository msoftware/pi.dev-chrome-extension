/// <reference lib="webworker" />
/** Runs in a Web Worker inside the offscreen document (AUX-11): decode frames, draw overlays, encode the GIF. */
import { encodeGif, quantize, type GifFrame } from "./gif-encoder";

interface InFrame {
  data: string;
  width: number;
  height: number;
  label: string;
  click?: [number, number];
  drag?: [number, number, number, number];
}
interface Opts {
  showClickIndicators?: boolean;
  showDragPaths?: boolean;
  showActionLabels?: boolean;
  showProgressBar?: boolean;
  quality?: number;
}

const MAX_W = 800;

function b64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: "image/jpeg" });
}

self.onmessage = async (e: MessageEvent<{ frames: InFrame[]; options: Opts }>) => {
  try {
    const { frames, options } = e.data;
    const first = frames[0];
    const scale = Math.min(1, MAX_W / first.width);
    const W = Math.max(1, Math.round(first.width * scale));
    const H = Math.max(1, Math.round(first.height * scale));
    const o = { showClickIndicators: true, showDragPaths: true, showActionLabels: true, showProgressBar: true, quality: 10, ...options };
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const out: GifFrame[] = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const bmp = await createImageBitmap(b64ToBlob(f.data));
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(bmp, 0, 0, W, H);
      const sx = W / f.width;
      const sy = H / f.height;
      if (o.showDragPaths && f.drag) {
        ctx.strokeStyle = "#e0702c";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(f.drag[0] * sx, f.drag[1] * sy);
        ctx.lineTo(f.drag[2] * sx, f.drag[3] * sy);
        ctx.stroke();
      }
      if (o.showClickIndicators && f.click) {
        ctx.strokeStyle = "#e0702c";
        ctx.fillStyle = "rgba(224,112,44,0.25)";
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(f.click[0] * sx, f.click[1] * sy, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      if (o.showActionLabels && f.label) {
        ctx.font = "600 14px sans-serif";
        const w = ctx.measureText(f.label).width + 16;
        ctx.fillStyle = "rgba(31,27,22,0.85)";
        ctx.fillRect(8, H - 38, Math.min(W - 16, w), 26);
        ctx.fillStyle = "#fff";
        ctx.fillText(f.label.slice(0, 80), 16, H - 20);
      }
      if (o.showProgressBar) {
        ctx.fillStyle = "#e0702c";
        ctx.fillRect(0, H - 4, (W * (i + 1)) / frames.length, 4);
      }
      const img = ctx.getImageData(0, 0, W, H);
      out.push({ indices: quantize(img.data, W, H, (o.quality ?? 10) <= 15), delayCs: i === frames.length - 1 ? 150 : 80 });
      bmp.close();
    }
    const gif = encodeGif(W, H, out);
    (self as unknown as Worker).postMessage({ ok: true, gif: gif.buffer }, [gif.buffer]);
  } catch (err: any) {
    (self as unknown as Worker).postMessage({ ok: false, error: String(err?.message ?? err) });
  }
};
