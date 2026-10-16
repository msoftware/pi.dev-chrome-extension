// Generates the original extension icons (rounded square + pointer), pure Node, no dependencies.
import fs from "node:fs";
import zlib from "node:zlib";

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const SS = 4, N = size * SS;
  const px = Buffer.alloc(size * size * 4);
  const r = N * 0.22;
  const inRound = (x, y) => {
    const cx = Math.min(Math.max(x, r), N - r), cy = Math.min(Math.max(y, r), N - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  // pointer polygon in unit coords
  const poly = [[0.30, 0.20], [0.30, 0.74], [0.45, 0.60], [0.56, 0.83], [0.65, 0.79], [0.54, 0.57], [0.73, 0.57]].map(([a, b]) => [a * N, b * N]);
  const inPoly = (x, y) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 0, rr = 0, gg = 0, bb = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const X = x * SS + sx + 0.5, Y = y * SS + sy + 0.5;
      if (!inRound(X, Y)) continue;
      a++;
      const t = Y / N;
      let c = [217 + 20 * (1 - t), 105 + 40 * (1 - t), 40 + 20 * (1 - t)]; // orange gradient
      if (inPoly(X, Y)) c = [255, 255, 255];
      rr += c[0]; gg += c[1]; bb += c[2];
    }
    const i = (y * size + x) * 4, n = SS * SS;
    px[i] = a ? rr / a : 0; px[i + 1] = a ? gg / a : 0; px[i + 2] = a ? bb / a : 0; px[i + 3] = Math.round((a / n) * 255);
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
fs.mkdirSync("extension/public/icons", { recursive: true });
for (const s of [16, 32, 48, 128]) fs.writeFileSync(`extension/public/icons/icon-${s}.png`, png(s));
console.log("icons written");
