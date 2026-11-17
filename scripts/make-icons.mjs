// アプリアイコン（低解像度で描いて最近傍拡大＝ドット感を残す）を public/ に書き出す
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const N = 32;
const px = Buffer.alloc(N * N * 4);
const inside = (p, poly) => { let r = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [ax, ay] = poly[i], [bx, by] = poly[j]; if (ay > p[1] !== by > p[1] && p[0] < ((bx - ax) * (p[1] - ay)) / (by - ay) + ax) r = !r; } return r; };
const top = [[16, 5], [27, 10.5], [16, 16], [5, 10.5]], left = [[5, 10.5], [16, 16], [16, 28], [5, 22]], right = [[16, 16], [27, 10.5], [27, 22], [16, 28]];
const dither = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
  const p = [x + 0.5, y + 0.5];
  let c = [26, 28, 44];
  if (inside(p, top)) c = [255, 176, 40];
  else if (inside(p, left)) c = [232, 72, 40];
  else if (inside(p, right)) c = dither[y & 3][x & 3] > 7 ? [40, 96, 220] : [56, 120, 240];
  const i = (y * N + x) * 4; px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
}
for (const s of [180, 192, 512]) {
  const out = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) px.copy(out, (y * s + x) * 4, (Math.floor((y * N) / s) * N + Math.floor((x * N) / s)) * 4, (Math.floor((y * N) / s) * N + Math.floor((x * N) / s)) * 4 + 4);
  writeFileSync(new URL(`../public/icon-${s}.png`, import.meta.url), png(s, s, out));
}
console.log('icons written');
