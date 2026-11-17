import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { newDoc, newMesh, emptySelection } from '../src/core/doc';
import * as ops from '../src/core/mesh-ops';
import { simplifyDoc, simplifyObject, triCount } from '../src/core/simplify';
import { sceneToDoc, DEFAULT_IMPORT } from '../src/io/import';
import { samplePose, skinnedPositions, setKey, newClip } from '../src/core/skeleton';

function denseSphere() {
  const doc = newDoc();
  const o = newMesh(doc, 'ball');
  const sel = emptySelection();
  ops.addPrimitive(o, sel, 'sphere', { size: 2, sides: 32, rings: 16 });
  o.skin = o.verts.map((p) => [[p[0] > 0 ? 1 : 0, 1]] as [number, number][]);
  return { doc, o };
}

describe('ポリゴン削減', () => {
  it('目標の三角形数くらいまで減り、ウェイトとUVが残る', async () => {
    const { o } = denseSphere();
    const before = triCount(o);
    expect(before).toBeGreaterThan(900);
    const after = await simplifyObject(o, 200);
    expect(after).toBeLessThanOrEqual(260);
    expect(after).toBeGreaterThan(100);
    // 残った頂点は元の頂点なので、ウェイトもそのまま（X>0 は 1番、それ以外は 0番）
    o.verts.forEach((p, i) => expect(o.skin[i][0][0]).toBe(p[0] > 0 ? 1 : 0));
    for (const f of o.faces) for (const [u, v] of f.uv) expect(u >= -1e-6 && u <= 1 + 1e-6 && v >= -1e-6 && v <= 1 + 1e-6).toBe(true);
    // 形がつぶれていない（半径1の球の外接箱）
    const xs = o.verts.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1.6);
  });

  it('全体の目標を、各オブジェクトの大きさに比例して配る', async () => {
    const { doc } = denseSphere();
    const small = newMesh(doc, 'small');
    ops.addPrimitive(small, emptySelection(), 'cube', { size: 0.1 });
    const r = await simplifyDoc(doc, 300);
    expect(r.after).toBeLessThanOrEqual(380);
    expect(triCount(small)).toBe(12); // 小さい部品は最低12三角形残す（立方体はそのまま）
  });

  it('目標より少なければ何もしない', async () => {
    const { o } = denseSphere();
    const before = triCount(o);
    expect(await simplifyObject(o, before + 10)).toBe(before);
  });
});

describe('骨にくっつけた部品の読み込み', () => {
  it('スキンなしでも親がボーンなら、そのボーンと一緒に動く', async () => {
    const root = new THREE.Group();
    const hip = new THREE.Bone();
    hip.name = 'hip';
    const head = new THREE.Bone();
    head.name = 'head';
    head.position.set(0, 1, 0);
    hip.add(head);
    root.add(hip);
    const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), new THREE.MeshBasicMaterial());
    tooth.name = 'tooth';
    tooth.position.set(0, 0.5, 0.3); // 頭から見た位置
    head.add(tooth);
    const doc = await sceneToDoc(root, [], { ...DEFAULT_IMPORT });
    const o = doc.objects.find((x) => x.name === 'tooth')!;
    const hi = doc.bones.findIndex((b) => b.name === 'head');
    expect(o.skin.every((s) => s.length === 1 && s[0][0] === hi && s[0][1] === 1)).toBe(true);
    // 置かれた位置（ワールド）
    const cy = o.verts.reduce((t, p) => t + p[1], 0) / o.verts.length;
    expect(cy).toBeCloseTo(1.5);
    // 頭を上に 1 動かすと歯も 1 上がる
    const clip = newClip(doc);
    setKey(clip, hi, 0, { pos: [0, 2, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] });
    const moved = skinnedPositions(doc, o, samplePose(doc, clip, 0));
    expect(moved.reduce((t, p) => t + p[1], 0) / moved.length).toBeCloseTo(2.5);
  });
});
