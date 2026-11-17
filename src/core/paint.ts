// テクスチャへのピクセル描画（ドット絵と同じ操作）
import type { Texture } from './types';

export type RGBA = [number, number, number, number];

export const hexToRGBA = (hex: string): RGBA => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
};

/** 描き始める前に呼ぶ。履歴と共有しているピクセル配列を複製して、以後はこちらに書く */
export function beginPaint(t: Texture): void {
  t.data = new Uint8ClampedArray(t.data);
}

const wrap = (v: number, n: number) => ((v % n) + n) % n;

/** UV(0..1, 画像座標) → ピクセル座標。UVのはみ出しはテクスチャの繰り返しとして扱う */
export function uvToPixel(t: Texture, u: number, v: number): [number, number] {
  return [wrap(Math.floor(u * t.w), t.w), wrap(Math.floor(v * t.h), t.h)];
}

export function setPixel(t: Texture, x: number, y: number, c: RGBA): void {
  if (x < 0 || y < 0 || x >= t.w || y >= t.h) return;
  const i = (y * t.w + x) * 4;
  t.data[i] = c[0];
  t.data[i + 1] = c[1];
  t.data[i + 2] = c[2];
  t.data[i + 3] = c[3];
}

export function getPixel(t: Texture, x: number, y: number): RGBA {
  const i = (y * t.w + x) * 4;
  return [t.data[i], t.data[i + 1], t.data[i + 2], t.data[i + 3]];
}

/** 正方形ブラシ（size=1 で1ピクセル） */
export function stamp(t: Texture, x: number, y: number, size: number, c: RGBA): void {
  const o = Math.floor((size - 1) / 2);
  for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) setPixel(t, x - o + dx, y - o + dy, c);
}

/** ブレゼンハムの直線 */
export function linePoints(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  const dx = Math.abs(x1 - x0),
    dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1,
    sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0,
    y = y0;
  for (let n = 0; n < 4096; n++) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

export function drawLine(t: Texture, x0: number, y0: number, x1: number, y1: number, size: number, c: RGBA): void {
  for (const [x, y] of linePoints(x0, y0, x1, y1)) stamp(t, x, y, size, c);
}

export function drawRect(t: Texture, x0: number, y0: number, x1: number, y1: number, c: RGBA, filled: boolean): void {
  const ax = Math.min(x0, x1),
    bx = Math.max(x0, x1),
    ay = Math.min(y0, y1),
    by = Math.max(y0, y1);
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) if (filled || x === ax || x === bx || y === ay || y === by) setPixel(t, x, y, c);
}

/** 4近傍の塗りつぶし。変わったピクセル数を返す */
export function floodFill(t: Texture, x: number, y: number, c: RGBA): number {
  if (x < 0 || y < 0 || x >= t.w || y >= t.h) return 0;
  const target = getPixel(t, x, y);
  if (target.every((v, i) => v === c[i])) return 0;
  const same = (i: number) => t.data[i] === target[0] && t.data[i + 1] === target[1] && t.data[i + 2] === target[2] && t.data[i + 3] === target[3];
  const stack = [x, y];
  let n = 0;
  while (stack.length) {
    const py = stack.pop()!,
      px = stack.pop()!;
    if (px < 0 || py < 0 || px >= t.w || py >= t.h) continue;
    const i = (py * t.w + px) * 4;
    if (!same(i)) continue;
    t.data[i] = c[0];
    t.data[i + 1] = c[1];
    t.data[i + 2] = c[2];
    t.data[i + 3] = c[3];
    n++;
    stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
  }
  return n;
}

export const rgbaToHex = (c: RGBA): string => '#' + [c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, '0')).join('');

/** テクスチャの大きさを変える（最近傍） */
export function resizeTexture(t: Texture, w: number, h: number): void {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(t.w - 1, Math.floor(((x + 0.5) * t.w) / w)),
        sy = Math.min(t.h - 1, Math.floor(((y + 0.5) * t.h) / h));
      out.set(t.data.subarray((sy * t.w + sx) * 4, (sy * t.w + sx) * 4 + 4), (y * w + x) * 4);
    }
  t.w = w;
  t.h = h;
  t.data = out;
}
