import { describe, it, expect } from 'vitest';
// @ts-expect-error 型定義なし
import validator from 'gltf-validator';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportGLB } from '../src/io/gltf-export';
import { sceneToDoc, restoreGltfNames } from '../src/io/import';
import { encodePNG } from '../src/io/png';
import { sampleDoc } from '../src/core/sample';
import { samplePose, skinnedPositions } from '../src/core/skeleton';
import { inflateSync } from 'node:zlib';

describe('PNG', () => {
  it('正しいPNGを作る', async () => {
    const rgba = new Uint8ClampedArray(3 * 2 * 4).map((_, i) => (i * 37) & 255);
    const png = await encodePNG(3, 2, rgba);
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // IDAT を展開して元の画素に戻ることを確認
    const dv = new DataView(png.buffer);
    let o = 8;
    let idat: Uint8Array | null = null;
    while (o < png.length) {
      const len = dv.getUint32(o);
      const type = String.fromCharCode(...png.slice(o + 4, o + 8));
      if (type === 'IDAT') idat = png.slice(o + 8, o + 8 + len);
      o += 12 + len;
    }
    const raw = inflateSync(idat!);
    expect(raw.length).toBe((3 * 4 + 1) * 2);
    expect([...raw.subarray(1, 13)]).toEqual([...rgba.subarray(0, 12)]);
  });
});

describe('GLB 書き出し', () => {
  it('Khronos glTF Validator でエラーがない', async () => {
    const doc = sampleDoc();
    const glb = await exportGLB(doc);
    const report = await validator.validateBytes(glb);
    const errors = report.issues.messages.filter((m: { severity: number }) => m.severity === 0);
    if (errors.length) console.log(errors);
    expect(report.issues.numErrors).toBe(0);
    expect(report.info.animationCount).toBe(2);
    expect(report.info.hasSkins).toBe(true);
    expect(report.info.hasTextures).toBe(true);
  });

  it('書き出して読み戻すと形・骨格・アニメが保たれる', async () => {
    const doc = sampleDoc();
    doc.textures = []; // Node ではテクスチャ画像を読めないので形と骨格だけ確かめる
    for (const o of doc.objects) o.tex = -1;
    const glb = await exportGLB(doc);
    const g = await new GLTFLoader().parseAsync(glb.buffer as ArrayBuffer, '');
    restoreGltfNames(g as never);
    const back = await sceneToDoc(g.scene, g.animations, { quads: true, weld: true, maxTex: 0, fps: 15, targetTris: 0 });
    expect(back.bones.map((b) => b.name)).toEqual(doc.bones.map((b) => b.name));
    // 髪のトゲの根元は頭の上面と同じ位置・同じボーンなので、読み込み時の溶接で8頂点まとまる
    expect(back.objects[0].verts.length).toBe(doc.objects[0].verts.length - 8);
    expect(back.objects[0].faces.length).toBe(doc.objects[0].faces.length);
    expect(back.clips.map((c) => c.name)).toEqual(['歩き', '待機']);
    // 歩きアニメの途中のポーズで、頂点位置が一致するか（頂点の並びは変わるので外接箱で比べる）
    const bbox = (ps: number[][]) => [0, 1, 2].flatMap((k) => [Math.min(...ps.map((p) => p[k])), Math.max(...ps.map((p) => p[k]))]);
    const a = bbox(skinnedPositions(doc, doc.objects[0], samplePose(doc, doc.clips[0], 4)));
    const b = bbox(skinnedPositions(back, back.objects[0], samplePose(back, back.clips[0], 4)));
    a.forEach((x, i) => expect(b[i]).toBeCloseTo(x, 3));
  });
});
