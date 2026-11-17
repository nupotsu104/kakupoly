import { describe, it, expect } from 'vitest';
import { packDoc, unpackDoc, serialize } from '../src/io/project';
import { sampleDoc } from '../src/core/sample';

describe('端末内への保存の形', () => {
  it('圧縮して保存し、元に戻せる', async () => {
    const doc = sampleDoc();
    doc.objects[0].opacity = 0.5;
    const packed = await packDoc(doc);
    expect(packed.byteLength).toBeLessThan(serialize(doc).length / 2);
    const back = await unpackDoc(packed);
    expect(serialize(back)).toBe(serialize(doc));
  });

  it('古い形（.kpoly の文字列のまま）も読める', async () => {
    const doc = sampleDoc();
    const back = await unpackDoc(serialize(doc));
    expect(back.objects[0].verts.length).toBe(doc.objects[0].verts.length);
  });
});
