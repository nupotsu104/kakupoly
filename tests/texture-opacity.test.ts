import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
// @ts-expect-error 型定義なし
import validator from 'gltf-validator';
import { newDoc, newMesh, emptySelection } from '../src/core/doc';
import * as ops from '../src/core/mesh-ops';
import { exportGLB } from '../src/io/gltf-export';
import { sceneToDoc, DEFAULT_IMPORT } from '../src/io/import';
import { sampleDoc } from '../src/core/sample';
import type { V2, V3 } from '../src/core/types';

const W: V3 = [1, 1, 1];

describe('UVの島で選ぶ', () => {
  it('3Dでつながっていても、UVが続いていない面は選ばない', () => {
    const doc = newDoc();
    const o = newMesh(doc, 'm');
    // 横に3枚並んだ板。1-2枚目はUVが続いている、3枚目は別の島
    o.verts = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [0, 1, 0], [1, 1, 0], [2, 1, 0], [3, 1, 0]];
    o.skin = o.verts.map(() => []);
    const uv = (x: number, y: number): V2 => [x, y];
    o.faces = [
      { v: [0, 1, 5, 4], uv: [uv(0, 1), uv(0.1, 1), uv(0.1, 0.9), uv(0, 0.9)], col: [W, W, W, W] },
      { v: [1, 2, 6, 5], uv: [uv(0.1, 1), uv(0.2, 1), uv(0.2, 0.9), uv(0.1, 0.9)], col: [W, W, W, W] },
      { v: [2, 3, 7, 6], uv: [uv(0.5, 0.5), uv(0.6, 0.5), uv(0.6, 0.4), uv(0.5, 0.4)], col: [W, W, W, W] },
    ];
    const sel = emptySelection('face');
    sel.faces.add(0);
    ops.selectLinkedUV(o, sel);
    expect([...sel.faces].sort()).toEqual([0, 1]);
    // 3Dのつながりなら全部
    const sel2 = emptySelection('face');
    sel2.faces.add(0);
    ops.selectLinked(o, sel2);
    expect(sel2.faces.size).toBe(3);
  });
});

describe('半透明', () => {
  it('不透明度を持つオブジェクトは BLEND の材質で書き出され、公式Validatorでエラーがない', async () => {
    const doc = sampleDoc();
    const shell = newMesh(doc, 'eye_shell');
    ops.addPrimitive(shell, emptySelection(), 'sphere', { size: 0.2, center: [0, 1.7, 0.2] });
    shell.tex = 0;
    shell.opacity = 0.5;
    const glb = await exportGLB(doc);
    const report = await validator.validateBytes(glb);
    if (report.issues.numErrors) console.log(JSON.stringify(report.issues.messages.filter((m: { severity: number }) => m.severity === 0).slice(0, 3)));
    expect(report.issues.numErrors).toBe(0);
    const dv = new DataView(glb.buffer, glb.byteOffset);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + dv.getUint32(12, true))));
    const blend = json.materials.filter((m: { alphaMode: string }) => m.alphaMode === 'BLEND');
    expect(blend.length).toBe(1);
    expect(blend[0].pbrMetallicRoughness.baseColorFactor[3]).toBe(0.5);
    expect(json.materials.some((m: { alphaMode: string }) => m.alphaMode === 'MASK')).toBe(true); // 不透明な方はそのまま
  });
});

describe('FBX・OBJ の UV の向き', () => {
  it('flipV を指定すると、テクスチャがなくても UV の上下を直す', async () => {
    const make = () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0.2, 1, 0.2, 0, 0.9], 2));
      const root = new THREE.Group();
      root.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial()));
      return root;
    };
    const asIs = await sceneToDoc(make(), [], { ...DEFAULT_IMPORT, quads: false, weld: false });
    const flipped = await sceneToDoc(make(), [], { ...DEFAULT_IMPORT, quads: false, weld: false }, true);
    expect(asIs.objects[0].faces[0].uv.map((p) => p[1])).toEqual([0.2, 0.2, 0.9].map((v) => Math.fround(v)));
    flipped.objects[0].faces[0].uv.forEach((p, i) => expect(p[1]).toBeCloseTo([0.8, 0.8, 0.1][i]));
  });
});
