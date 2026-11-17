// 画像のリサイズ・減色（写真をPS1風の粗いテクスチャへ変換するため）

export interface Img {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

export function resizeNearest(src: Img, w: number, h: number): Img {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.h - 1, Math.floor(((y + 0.5) * src.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.w - 1, Math.floor(((x + 0.5) * src.w) / w));
      const si = (sy * src.w + sx) * 4,
        di = (y * w + x) * 4;
      out[di] = src.data[si];
      out[di + 1] = src.data[si + 1];
      out[di + 2] = src.data[si + 2];
      out[di + 3] = src.data[si + 3];
    }
  }
  return { w, h, data: out };
}

/** 面積平均による縮小（写真向け）。拡大時は最近傍にフォールバック */
export function resizeBox(src: Img, w: number, h: number): Img {
  if (w >= src.w || h >= src.h) return resizeNearest(src, w, h);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * src.h) / h),
      y1 = Math.max(y0 + 1, Math.floor(((y + 1) * src.h) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * src.w) / w),
        x1 = Math.max(x0 + 1, Math.floor(((x + 1) * src.w) / w));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const si = (yy * src.w + xx) * 4;
          const al = src.data[si + 3];
          r += src.data[si] * al;
          g += src.data[si + 1] * al;
          b += src.data[si + 2] * al;
          a += al;
          n++;
        }
      const di = (y * w + x) * 4;
      if (a > 0) {
        out[di] = r / a;
        out[di + 1] = g / a;
        out[di + 2] = b / a;
      }
      out[di + 3] = a / n >= 128 ? 255 : 0;
    }
  }
  return { w, h, data: out };
}

/** メディアンカットで最大 n 色のパレットを作る（透明ピクセルは除外） */
export function medianCut(data: Uint8ClampedArray, n: number): [number, number, number][] {
  const px: number[] = [];
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] >= 128) px.push(i);
  if (px.length === 0) return [[0, 0, 0]];
  type Box = { idx: number[] };
  const boxes: Box[] = [{ idx: px }];
  const range = (b: Box) => {
    const mn = [255, 255, 255],
      mx = [0, 0, 0];
    for (const i of b.idx)
      for (let c = 0; c < 3; c++) {
        const v = data[i + c];
        if (v < mn[c]) mn[c] = v;
        if (v > mx[c]) mx[c] = v;
      }
    const d = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const ch = d[0] >= d[1] && d[0] >= d[2] ? 0 : d[1] >= d[2] ? 1 : 2;
    return { ch, span: d[ch] };
  };
  while (boxes.length < n) {
    let bi = -1,
      best = 0,
      bch = 0;
    boxes.forEach((b, i) => {
      if (b.idx.length < 2) return;
      const r = range(b);
      const score = r.span * Math.sqrt(b.idx.length);
      if (r.span > 0 && score > best) {
        best = score;
        bi = i;
        bch = r.ch;
      }
    });
    if (bi < 0) break;
    const b = boxes[bi];
    b.idx.sort((x, y) => data[x + bch] - data[y + bch]);
    const mid = b.idx.length >> 1;
    boxes.splice(bi, 1, { idx: b.idx.slice(0, mid) }, { idx: b.idx.slice(mid) });
  }
  return boxes.map((b) => {
    let r = 0,
      g = 0,
      bl = 0;
    for (const i of b.idx) {
      r += data[i];
      g += data[i + 1];
      bl += data[i + 2];
    }
    const c = b.idx.length;
    return [Math.round(r / c), Math.round(g / c), Math.round(bl / c)] as [number, number, number];
  });
}

const nearest = (pal: [number, number, number][], r: number, g: number, b: number): number => {
  let best = 0,
    bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const dr = pal[i][0] - r,
      dg = pal[i][1] - g,
      db = pal[i][2] - b;
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
};

// PS1のGPUが使う 4x4 ディザ行列と同じ並び
const DITHER4 = [-4, 0, -3, 1, 2, -2, 3, -1, -3, 1, -4, 0, 3, -1, 2, -2];

/** パレットへ減色。dither=true で 4x4 の組織的ディザをかける */
export function applyPalette(img: Img, pal: [number, number, number][], dither: boolean): Img {
  const out = new Uint8ClampedArray(img.data.length);
  const amp = dither ? Math.max(4, 96 / Math.sqrt(pal.length)) / 4 : 0;
  for (let y = 0; y < img.h; y++)
    for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (img.data[i + 3] < 128) continue;
      const d = dither ? DITHER4[(y & 3) * 4 + (x & 3)] * amp : 0;
      const p = pal[nearest(pal, img.data[i] + d, img.data[i + 1] + d, img.data[i + 2] + d)];
      out[i] = p[0];
      out[i + 1] = p[1];
      out[i + 2] = p[2];
      out[i + 3] = 255;
    }
  return { w: img.w, h: img.h, data: out };
}

export function quantize(img: Img, colors: number, dither: boolean): { img: Img; palette: [number, number, number][] } {
  const palette = medianCut(img.data, colors);
  return { img: applyPalette(img, palette, dither), palette };
}

/** 15bitカラー（各色5bit）へ丸める */
export function to15bit(img: Img): Img {
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = out[i + c] >> 3;
      out[i + c] = (v << 3) | (v >> 2);
    }
    out[i + 3] = out[i + 3] >= 128 ? 255 : 0;
  }
  return { w: img.w, h: img.h, data: out };
}

/** 使われている色を多い順に最大 max 個 */
export function usedColors(img: Img, max = 64): string[] {
  const m = new Map<number, number>();
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 128) continue;
    const k = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k]) => '#' + k.toString(16).padStart(6, '0'));
}
