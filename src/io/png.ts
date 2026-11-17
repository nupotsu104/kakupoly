// 依存なしのPNGエンコーダ（ブラウザとNodeの両方で動く CompressionStream('deflate') を使う）

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePNG(w: number, h: number, rgba: Uint8ClampedArray | Uint8Array): Promise<Uint8Array> {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // フィルタなし
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const idat = await zlib(raw);
  const chunks: [string, Uint8Array][] = [
    ['IHDR', (() => {
      const b = new Uint8Array(13);
      const dv = new DataView(b.buffer);
      dv.setUint32(0, w);
      dv.setUint32(4, h);
      b[8] = 8; // ビット深度
      b[9] = 6; // RGBA
      return b;
    })()],
    ['IDAT', idat],
    ['IEND', new Uint8Array(0)],
  ];
  let size = 8;
  for (const [, d] of chunks) size += 12 + d.length;
  const out = new Uint8Array(size);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let o = 8;
  const dv = new DataView(out.buffer);
  for (const [type, d] of chunks) {
    dv.setUint32(o, d.length);
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    out.set(d, o + 8);
    dv.setUint32(o + 8 + d.length, crc32(out, o + 4, o + 8 + d.length));
    o += 12 + d.length;
  }
  return out;
}
