import { describe, it, expect } from 'vitest';
import { newDoc, newMesh, emptySelection } from '../src/core/doc';
import * as ops from '../src/core/mesh-ops';
import { mirrorSelection, symmetricMover, symmetryMap, mirrorBone, pairBoneBase, diagnoseSymmetry, centerX } from '../src/core/symmetry';
import { addBone } from '../src/core/skeleton';
import type { MeshObj } from '../src/core/types';

/** すべての頂点に、鏡写しの位置の頂点があるか */
function isSymmetric(o: MeshObj, eps = 1e-6): boolean {
  return o.verts.every((p) => o.verts.some((q) => Math.abs(q[0] + p[0]) < eps && Math.abs(q[1] - p[1]) < eps && Math.abs(q[2] - p[2]) < eps));
}

function cube() {
  const doc = newDoc();
  const o = newMesh(doc, 'c');
  const sel = emptySelection('face');
  ops.addPrimitive(o, sel, 'cube', { size: 1 });
  sel.faces.clear();
  return { doc, o, sel };
}

describe('左右対称モード', () => {
  it('片側の面を選ぶと反対側の面も選ばれる', () => {
    const { o, sel } = cube();
    const right = o.faces.findIndex((f) => f.v.every((v) => o.verts[v][0] > 0));
    const left = o.faces.findIndex((f) => f.v.every((v) => o.verts[v][0] < 0));
    sel.faces.add(right);
    mirrorSelection(o, sel);
    expect([...sel.faces].sort()).toEqual([right, left].sort());
    // 中心をまたぐ面（前面）は自分自身が鏡像
    const front = o.faces.findIndex((f) => f.v.every((v) => o.verts[v][2] > 0));
    expect(symmetryMap(o).face(front)).toBe(front);
  });

  it('両側を押し出して片側へ動かすと、反対側は逆向きに動く', () => {
    const { o, sel } = cube();
    sel.faces.add(o.faces.findIndex((f) => f.v.every((v) => o.verts[v][0] > 0)));
    mirrorSelection(o, sel);
    const moved = ops.extrudeFaces(o, sel);
    expect(moved.length).toBe(8);
    const mover = symmetricMover(o, moved);
    mover((p) => [p[0] + 0.5, p[1] + 0.1, p[2]]);
    const xs = moved.map((v) => o.verts[v][0]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-1);
    expect(xs[xs.length - 1]).toBeCloseTo(1);
    expect(isSymmetric(o)).toBe(true);
  });

  it('片側だけ選んで動かすと、選んでいない反対側が追従する', () => {
    const { o } = cube();
    const v = o.verts.findIndex((p) => p[0] > 0 && p[1] > 0 && p[2] > 0);
    symmetricMover(o, [v])((p) => [p[0] + 0.2, p[1], p[2] + 0.3]);
    expect(isSymmetric(o)).toBe(true);
  });

  it('中心線上の頂点は中心から離れない', () => {
    const { o, sel } = cube();
    // 前面の縦の辺でループカットして X=0 に頂点の輪を作る
    const f = o.faces.findIndex((x) => x.v.every((v) => o.verts[v][2] > 0));
    const face = o.faces[f];
    let edge = '';
    for (let i = 0; i < 4; i++) {
      const a = face.v[i],
        b = face.v[(i + 1) % 4];
      if (Math.abs(o.verts[a][1] - o.verts[b][1]) < 1e-9) edge = a < b ? `${a}_${b}` : `${b}_${a}`;
    }
    sel.mode = 'edge';
    sel.edges.add(edge);
    ops.loopCut(o, sel);
    const center = o.verts.map((p, i) => [p, i] as const).filter(([p]) => Math.abs(p[0]) < 1e-9).map(([, i]) => i);
    expect(center.length).toBe(4);
    symmetricMover(o, center)((p) => [p[0] + 0.4, p[1] + 0.2, p[2]]);
    for (const v of center) expect(o.verts[v][0]).toBe(0);
    expect(isSymmetric(o)).toBe(true);
  });

  it('ボーンの左右ペアの名前', () => {
    const doc = newDoc();
    expect(pairBoneBase(doc)).toBe('bone');
    const a = addBone(doc, -1, [0.3, 1, 0], 'bone.L');
    const b = addBone(doc, -1, [-0.3, 1, 0], 'bone.R');
    expect(mirrorBone(doc, a)).toBe(b);
    expect(mirrorBone(doc, b)).toBe(a);
    expect(pairBoneBase(doc)).toBe('bone.01');
  });

  it('左右の腕が別オブジェクトでも、動かすと反対側が追従する（AI製モデルの形）', () => {
    const doc = newDoc();
    const r = newMesh(doc, 'armR');
    const l = newMesh(doc, 'armL');
    ops.addPrimitive(r, emptySelection(), 'cube', { size: 0.2, center: [0.5, 1, 0] });
    ops.addPrimitive(l, emptySelection(), 'cube', { size: 0.2, center: [-0.5, 1, 0] });
    const d = diagnoseSymmetry(doc, 0);
    expect(d.same).toBe(0);
    expect(d.any).toBe(1);
    expect(d.message).toContain('別々のオブジェクト');
    symmetricMover(r, r.verts.map((_, i) => i), [l])((p) => [p[0] + 0.3, p[1] - 0.2, p[2]]);
    const lx = Math.min(...l.verts.map((p) => p[0]));
    expect(lx).toBeCloseTo(-0.9);
    expect(Math.max(...l.verts.map((p) => p[1]))).toBeCloseTo(0.9);
  });

  it('中心からずれたモデルは理由を返し、中心に移動すると効く', () => {
    const doc = newDoc();
    const o = newMesh(doc, 'body');
    ops.addPrimitive(o, emptySelection(), 'cube', { size: 1, center: [3, 0, 0] });
    expect(diagnoseSymmetry(doc, 0).message).toContain('ずれて');
    expect(centerX(doc)).toBeCloseTo(-3);
    expect(diagnoseSymmetry(doc, 0).message).toBeNull();
  });

  it('cm単位の大きなモデルでも、わずかな誤差なら対になる', () => {
    const doc = newDoc();
    const o = newMesh(doc, 'big');
    ops.addPrimitive(o, emptySelection(), 'cube', { size: 180 });
    o.verts.forEach((p) => (p[0] += p[0] > 0 ? 0.01 : 0)); // 0.01cm のずれ
    expect(diagnoseSymmetry(doc, 0).same).toBe(1);
  });
});
