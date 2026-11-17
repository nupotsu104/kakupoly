import { describe, it, expect } from 'vitest';
import { newDoc, newMesh, emptySelection } from '../src/core/doc';
import * as ops from '../src/core/mesh-ops';
import { trisToQuads } from '../src/core/cleanup';
import { addBone, autoWeightsRigid, deleteBone, newClip, reduceKeys, restWorld, samplePose, setKey, skinnedPositions, worldMatrices, reparentBone } from '../src/core/skeleton';
import { mDecompose, mCompose, mMul, mInvert, qFromAxisAngle, mPos } from '../src/core/vec';
import { floodFill, drawLine, linePoints } from '../src/core/paint';
import { medianCut, applyPalette } from '../src/core/quantize';
import { sampleDoc } from '../src/core/sample';
import type { MeshObj, V3 } from '../src/core/types';

/** 閉じた多面体なら、すべての辺がちょうど2つの面に使われ、向きが逆になっている */
function isClosedManifold(o: MeshObj): boolean {
  const dir = new Map<string, number>();
  for (const f of o.faces)
    for (let i = 0; i < f.v.length; i++) {
      const k = `${f.v[i]}>${f.v[(i + 1) % f.v.length]}`;
      dir.set(k, (dir.get(k) ?? 0) + 1);
    }
  for (const [k, n] of dir) {
    if (n !== 1) return false;
    const [a, b] = k.split('>');
    if (dir.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

/** 全ての面の法線が外向き（重心から離れる向き）か */
function outward(o: MeshObj): boolean {
  const c = o.verts.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]] as V3, [0, 0, 0] as V3).map((x) => x / o.verts.length) as V3;
  return o.faces.every((f) => {
    const n = ops.faceNormal(o, f);
    const fc = ops.faceCenter(o, f);
    return n[0] * (fc[0] - c[0]) + n[1] * (fc[1] - c[1]) + n[2] * (fc[2] - c[2]) > 0;
  });
}

const cube = () => {
  const doc = newDoc();
  const o = newMesh(doc, 'c');
  const sel = emptySelection('face');
  ops.addPrimitive(o, sel, 'cube', { size: 1 });
  return { doc, o, sel };
};

describe('プリミティブ', () => {
  for (const k of ['cube', 'cylinder', 'cone', 'sphere'] as const)
    it(`${k} は閉じていて外向き`, () => {
      const doc = newDoc();
      const o = newMesh(doc, k);
      ops.addPrimitive(o, emptySelection(), k, { size: 1, sides: 8 });
      expect(isClosedManifold(o)).toBe(true);
      expect(outward(o)).toBe(true);
    });
});

describe('メッシュ編集', () => {
  it('面の押し出しで閉じた形が保たれる', () => {
    const { o, sel } = cube();
    sel.faces.clear();
    sel.faces.add(0);
    const moved = ops.extrudeFaces(o, sel);
    expect(moved.length).toBe(4);
    ops.translateVerts(o, moved, [0, 0, 0.5]);
    expect(o.faces.length).toBe(10);
    expect(o.verts.length).toBe(12);
    expect(isClosedManifold(o)).toBe(true);
    expect(outward(o)).toBe(true);
  });

  it('隣り合う2面の押し出しは間に壁を作らない', () => {
    const { o, sel } = cube();
    sel.faces.clear();
    sel.faces.add(0); // 前
    sel.faces.add(2); // 右
    ops.extrudeFaces(o, sel);
    expect(isClosedManifold(o)).toBe(true);
    expect(o.faces.length).toBe(6 + 6); // 境界の辺は6本
  });

  it('インセットは面を5つにして閉じた形を保つ', () => {
    const { o, sel } = cube();
    sel.faces.clear();
    sel.faces.add(0);
    ops.insetFaces(o, sel, 0.3);
    expect(o.faces.length).toBe(10);
    expect(isClosedManifold(o)).toBe(true);
  });

  it('ループカットで箱の周りに一周辺が入る', () => {
    const { o, sel } = cube();
    // 前面(0)の縦の辺を1本選ぶ
    const f = o.faces[0];
    sel.mode = 'edge';
    sel.faces.clear();
    sel.edges.add(`${Math.min(f.v[1], f.v[2])}_${Math.max(f.v[1], f.v[2])}`);
    expect(ops.loopCut(o, sel)).toBe(true);
    expect(o.faces.length).toBe(10);
    expect(o.verts.length).toBe(12);
    expect(sel.edges.size).toBe(4);
    expect(isClosedManifold(o)).toBe(true);
    expect(outward(o)).toBe(true);
    // 新しい頂点はすべて中間（y=0 の高さ）
    for (const p of o.verts.slice(8)) expect(Math.abs(p[1])).toBeLessThan(1e-9);
  });

  it('細分化は閉じた形を保つ', () => {
    const { o, sel } = cube();
    ops.selectAll(o, sel);
    ops.subdivideFaces(o, sel);
    expect(o.faces.length).toBe(24);
    expect(isClosedManifold(o)).toBe(true);
    expect(outward(o)).toBe(true);
  });

  it('三角形化→辺の溶解で元の面数に戻せる', () => {
    const { o, sel } = cube();
    ops.selectAll(o, sel);
    ops.triangulate(o, sel);
    expect(o.faces.length).toBe(12);
    expect(trisToQuads(o)).toBe(6);
    expect(o.faces.every((f) => f.v.length === 4)).toBe(true);
    expect(isClosedManifold(o)).toBe(true);
  });

  it('Xミラーで中心の頂点は共有される', () => {
    const doc = newDoc();
    const o = newMesh(doc, 'half');
    // x=0 から x=1 の半分の箱
    const sel = emptySelection();
    ops.addPrimitive(o, sel, 'cube', { size: 1, center: [0.5, 0, 0] });
    // x=0 の面を消す
    const left = o.faces.findIndex((f) => f.v.every((v) => Math.abs(o.verts[v][0]) < 1e-9));
    o.faces.splice(left, 1);
    ops.mirrorX(doc, o, emptySelection());
    expect(o.verts.length).toBe(12);
    expect(o.faces.length).toBe(10);
    expect(isClosedManifold(o)).toBe(true);
    expect(outward(o)).toBe(true);
  });

  it('頂点の結合と溶接', () => {
    const { o, sel } = cube();
    sel.mode = 'vert';
    sel.faces.clear();
    const f = o.faces[0];
    sel.verts.add(f.v[0]);
    sel.verts.add(f.v[1]);
    ops.mergeAtCenter(o, sel);
    expect(o.verts.length).toBe(7);
    // 潰れた面は三角形になる
    expect(o.faces.filter((x) => x.v.length === 3).length).toBe(2);
    const { o: o2 } = cube();
    const extra = ops.duplicateFaces(o2, { mode: 'face', verts: new Set(), edges: new Set(), faces: new Set([0]) });
    expect(extra.length).toBe(4);
    expect(ops.weldByDistance(o2, 1e-6)).toBe(4);
    // ボーン割り当てが違う頂点は keepSkin で溶接しない
    const { o: o3 } = cube();
    const d3 = ops.duplicateFaces(o3, { mode: 'face', verts: new Set(), edges: new Set(), faces: new Set([0]) });
    for (const v of d3) o3.skin[v] = [[1, 1]];
    expect(ops.weldByDistance(o3, 1e-6, undefined, true)).toBe(0);
  });

  it('2頂点を結んで面を割る', () => {
    const { o, sel } = cube();
    const f = o.faces[0];
    sel.mode = 'vert';
    sel.faces.clear();
    sel.verts.add(f.v[0]);
    sel.verts.add(f.v[2]);
    expect(ops.connectVerts(o, sel)).toBe(true);
    expect(o.faces.length).toBe(7);
    expect(isClosedManifold(o)).toBe(true);
  });

  it('UVの箱型展開は 0..1 に収まる', () => {
    const { o } = cube();
    ops.projectUV(o, o.faces.map((_, i) => i), 'box');
    for (const f of o.faces) for (const [u, v] of f.uv) {
      expect(u).toBeGreaterThanOrEqual(-1e-9);
      expect(u).toBeLessThanOrEqual(1 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe('骨格・アニメ', () => {
  it('行列の合成と分解が往復する', () => {
    const q = qFromAxisAngle([0.3, 1, 0.2], 1.1);
    const m = mCompose([1, 2, 3], q, [2, 2, 2]);
    const d = mDecompose(m);
    expect(d.pos).toEqual([1, 2, 3]);
    d.scl.forEach((s) => expect(s).toBeCloseTo(2));
    const m2 = mCompose(d.pos, d.rot, d.scl);
    m2.forEach((x, i) => expect(x).toBeCloseTo(m[i]));
    mMul(m, mInvert(m)).forEach((x, i) => expect(x).toBeCloseTo([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1][i]));
  });

  it('ボーンは指定したワールド位置に置かれる', () => {
    const doc = newDoc();
    const a = addBone(doc, -1, [0, 1, 0]);
    const b = addBone(doc, a, [0, 2, 0.5]);
    const rw = restWorld(doc.bones);
    expect(mPos(rw[b])).toEqual([0, 2, 0.5]);
    expect(doc.bones[b].pos).toEqual([0, 1, 0.5]);
  });

  it('親の付け替えでワールド位置は変わらない', () => {
    const doc = sampleDoc();
    const before = restWorld(doc.bones).map(mPos);
    const head = doc.bones.findIndex((b) => b.name === 'head');
    expect(reparentBone(doc, head, 0)).toBe(true);
    const after = restWorld(doc.bones).map(mPos);
    after.forEach((p, i) => p.forEach((x, k) => expect(x).toBeCloseTo(before[i][k])));
    // 循環は拒否
    expect(reparentBone(doc, 0, head)).toBe(false);
  });

  it('レスト姿勢ではスキニング後も頂点は動かない', () => {
    const doc = sampleDoc();
    const o = doc.objects[0];
    const pose = samplePose(doc, null, 0);
    const p = skinnedPositions(doc, o, pose);
    p.forEach((v, i) => v.forEach((x, k) => expect(x).toBeCloseTo(o.verts[i][k])));
  });

  it('ボーンを回すと割り当てた頂点がついてくる', () => {
    const doc = newDoc();
    const o = newMesh(doc, 'arm');
    ops.addPrimitive(o, emptySelection(), 'cube', { size: 0.2, center: [1, 0, 0] });
    const root = addBone(doc, -1, [0, 0, 0]);
    addBone(doc, root, [1, 0, 0]);
    autoWeightsRigid(doc, o);
    expect(o.skin.every((s) => s[0][0] === 0)).toBe(true); // 根元のボーン（root→子 の線分に近い）
    const clip = newClip(doc);
    setKey(clip, root, 10, { pos: [0, 0, 0], rot: qFromAxisAngle([0, 0, 1], Math.PI / 2), scl: [1, 1, 1] });
    const pose = samplePose(doc, clip, 10);
    const p = skinnedPositions(doc, o, pose);
    const c = p.reduce((s, v) => [s[0] + v[0] / p.length, s[1] + v[1] / p.length, s[2] + v[2] / p.length], [0, 0, 0]);
    expect(c[0]).toBeCloseTo(0);
    expect(c[1]).toBeCloseTo(1);
    // ワールド行列の確認
    expect(mPos(worldMatrices(doc.bones, pose)[1])[1]).toBeCloseTo(1);
  });

  it('ボーン削除でウェイトは親へ移る', () => {
    const doc = sampleDoc();
    const o = doc.objects[0];
    const fore = doc.bones.findIndex((b) => b.name === 'forearm.L');
    const arm = doc.bones.findIndex((b) => b.name === 'arm.L');
    const n = o.skin.filter((s) => s[0]?.[0] === fore).length;
    expect(n).toBeGreaterThan(0);
    const before = o.skin.filter((s) => s[0]?.[0] === arm).length;
    deleteBone(doc, fore);
    const armAfter = doc.bones.findIndex((b) => b.name === 'arm.L');
    expect(o.skin.filter((s) => s[0]?.[0] === armAfter).length).toBe(before + n);
  });

  it('直線上のキーは間引かれる', () => {
    const keys = [0, 1, 2, 3, 4].map((f) => ({ f, pos: [f, 0, 0] as V3, rot: [0, 0, 0, 1] as [number, number, number, number], scl: [1, 1, 1] as V3 }));
    expect(reduceKeys(keys).map((k) => k.f)).toEqual([0, 4]);
  });
});

describe('ドット描画・減色', () => {
  it('塗りつぶしは同じ色の領域だけ', () => {
    const t = { id: 1, name: 't', w: 4, h: 4, data: new Uint8ClampedArray(64) };
    drawLine(t, 0, 2, 3, 2, 1, [255, 0, 0, 255]);
    expect(floodFill(t, 0, 0, [0, 255, 0, 255])).toBe(8);
  });
  it('ブレゼンハムは端点を含む', () => {
    const p = linePoints(0, 0, 5, 2);
    expect(p[0]).toEqual([0, 0]);
    expect(p[p.length - 1]).toEqual([5, 2]);
    expect(p.length).toBe(6);
  });
  it('メディアンカットは指定色数以下', () => {
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 0; i < 256; i++) data.set([i, (i * 7) % 256, (i * 13) % 256, 255], i * 4);
    const pal = medianCut(data, 16);
    expect(pal.length).toBeLessThanOrEqual(16);
    const out = applyPalette({ w: 16, h: 16, data }, pal, true);
    const colors = new Set<string>();
    for (let i = 0; i < out.data.length; i += 4) colors.add(`${out.data[i]},${out.data[i + 1]},${out.data[i + 2]}`);
    expect(colors.size).toBeLessThanOrEqual(16);
  });
});
