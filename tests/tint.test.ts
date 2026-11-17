import { describe, expect, it } from 'vitest';
import { newDoc, newMesh, makeFace, assignTexture, clearTint, uniformTint } from '../src/core/doc';

const quad = (col: [number, number, number][]) => {
  const doc = newDoc();
  const o = newMesh(doc, 'q');
  o.verts = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
  o.skin = o.verts.map(() => []);
  o.faces = [makeFace([0, 1, 2, 3], undefined, col)];
  return o;
};

describe('テクスチャの下地の色', () => {
  it('材質の色（一様な灰色）はテクスチャを初めて貼ると白に戻る', () => {
    const o = quad([[0.3, 0.3, 0.3], [0.3, 0.3, 0.3], [0.3, 0.3, 0.3], [0.3, 0.3, 0.3]]);
    expect(uniformTint(o)).toEqual([0.3, 0.3, 0.3]);
    expect(assignTexture(o, 0)).toBe(true);
    expect(o.tex).toBe(0);
    expect(o.faces[0].col.every((c) => c.every((x) => x === 1))).toBe(true);
  });
  it('頂点ごとに塗った色は残す', () => {
    const o = quad([[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]]);
    expect(assignTexture(o, 0)).toBe(false);
    expect(o.faces[0].col[0]).toEqual([1, 0, 0]);
  });
  it('すでにテクスチャのある部品の付け替えでは色を変えない', () => {
    const o = quad([[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]]);
    o.tex = 0;
    expect(assignTexture(o, 1)).toBe(false);
    expect(o.faces[0].col[0]).toEqual([0.5, 0.5, 0.5]);
    expect(clearTint(o)).toBe(true);
    expect(o.faces[0].col[0]).toEqual([1, 1, 1]);
  });
});
