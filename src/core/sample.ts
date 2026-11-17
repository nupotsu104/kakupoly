// 起動直後に触れるサンプル: 箱人間（ボーン・ウェイト・テクスチャ・歩行アニメ付き）
import type { Doc, V2, V3 } from './types';
import { newDoc, newMesh, newTexture } from './doc';
import { addBone, newClip, setKey, restPose } from './skeleton';
import { qFromAxisAngle } from './vec';

type Rect = [number, number, number, number]; // テクスチャ上の x, y, w, h (px)

export function sampleDoc(): Doc {
  const doc = newDoc('サンプル人型');
  const T = 64;
  const tex = newTexture(doc, 'body', T, T, [0, 0, 0, 255]);
  const px = (x: number, y: number, c: number[]) => {
    if (x < 0 || y < 0 || x >= T || y >= T) return;
    const i = (y * T + x) * 4;
    tex.data[i] = c[0];
    tex.data[i + 1] = c[1];
    tex.data[i + 2] = c[2];
    tex.data[i + 3] = 255;
  };
  const fill = (r: Rect, c: number[], c2?: number[]) => {
    for (let y = r[1]; y < r[1] + r[3]; y++)
      for (let x = r[0]; x < r[0] + r[2]; x++) px(x, y, c2 && ((x * 7 + y * 13) % 5 === 0) ? c2 : c);
  };
  const SKIN = [232, 168, 120], SKIN2 = [216, 150, 104];
  const HAIR = [200, 24, 16], HAIR2 = [240, 72, 24];
  const SHIRT = [224, 56, 24], SHIRT2 = [200, 40, 16];
  const PANTS = [24, 48, 168], PANTS2 = [16, 36, 136];
  const SHOE = [104, 64, 40], SHOE2 = [80, 48, 32];
  const R: Record<string, Rect> = {
    face: [0, 0, 24, 24], skin: [24, 0, 8, 8], hair: [32, 0, 16, 16], shirt: [0, 24, 24, 24],
    shirtSide: [24, 24, 8, 8], pants: [32, 16, 8, 8], shoe: [40, 16, 8, 8],
  };
  fill(R.face, SKIN, SKIN2);
  fill(R.skin, SKIN, SKIN2);
  fill(R.hair, HAIR, HAIR2);
  fill(R.shirt, SHIRT, SHIRT2);
  fill(R.shirtSide, SHIRT, SHIRT2);
  fill(R.pants, PANTS, PANTS2);
  fill(R.shoe, SHOE, SHOE2);
  // 顔: 前髪・目・口
  fill([0, 0, 24, 6], HAIR, HAIR2);
  for (const ex of [4, 14]) {
    fill([ex, 9, 6, 6], [255, 255, 255]);
    fill([ex + 2, 10, 3, 5], [24, 96, 200]);
    fill([ex + 3, 12, 2, 2], [8, 8, 24]);
    fill([ex, 8, 6, 1], [40, 16, 8]);
  }
  fill([9, 19, 6, 1], [136, 56, 40]);
  // シャツ: 白い前立て
  fill([10, 24, 4, 24], [240, 240, 240], [216, 216, 216]);

  const o = newMesh(doc, 'body');
  o.tex = 0;

  const bone = (name: string, parent: number, p: V3) => addBone(doc, parent, p, name);
  const hips = bone('hips', -1, [0, 0.9, 0]);
  const spine = bone('spine', hips, [0, 1.05, 0]);
  const head = bone('head', spine, [0, 1.48, 0]);
  const armL = bone('arm.L', spine, [0.27, 1.4, 0]);
  const foreL = bone('forearm.L', armL, [0.27, 1.12, 0]);
  const armR = bone('arm.R', spine, [-0.27, 1.4, 0]);
  const foreR = bone('forearm.R', armR, [-0.27, 1.12, 0]);
  const legL = bone('leg.L', hips, [0.1, 0.88, 0]);
  const shinL = bone('shin.L', legL, [0.1, 0.48, 0]);
  const legR = bone('leg.R', hips, [-0.1, 0.88, 0]);
  const shinR = bone('shin.R', legR, [-0.1, 0.48, 0]);

  const uvRect = (r: Rect): V2[] => {
    const e = 0.5; // にじみ防止に半ピクセル内側
    const x0 = (r[0] + e) / T, x1 = (r[0] + r[2] - e) / T, y0 = (r[1] + e) / T, y1 = (r[1] + r[3] - e) / T;
    return [[x0, y1], [x1, y1], [x1, y0], [x0, y0]];
  };
  /** 箱を追加。faces: 前, 後, 右(+x), 左(-x), 上, 下 の順のテクスチャ矩形 */
  const box = (mn: V3, mx: V3, b: number, rects: Rect[]) => {
    const base = o.verts.length;
    const [x0, y0, z0] = mn, [x1, y1, z1] = mx;
    o.verts.push([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    for (let i = 0; i < 8; i++) o.skin.push([[b, 1]]);
    const quads = [[4, 5, 6, 7], [1, 0, 3, 2], [5, 1, 2, 6], [0, 4, 7, 3], [7, 6, 2, 3], [0, 1, 5, 4]];
    quads.forEach((q, i) => {
      o.faces.push({ v: q.map((v) => v + base), uv: uvRect(rects[i] ?? rects[rects.length - 1]), col: q.map(() => [1, 1, 1] as V3) });
    });
  };
  const all = (r: Rect) => [r, r, r, r, r, r];
  box([-0.2, 0.9, -0.11], [0.2, 1.45, 0.11], spine, [R.shirt, R.shirtSide, R.shirtSide, R.shirtSide, R.shirtSide, R.pants]);
  box([-0.16, 1.48, -0.15], [0.16, 1.8, 0.15], head, [R.face, R.hair, R.skin, R.skin, R.hair, R.skin]);
  for (const s of [1, -1]) {
    const L = s > 0;
    const x0 = L ? 0.21 : -0.33, x1 = L ? 0.33 : -0.21;
    box([x0, 1.14, -0.06], [x1, 1.44, 0.06], L ? armL : armR, all(R.shirtSide));
    box([x0 + 0.01, 0.82, -0.05], [x1 - 0.01, 1.12, 0.05], L ? foreL : foreR, all(R.skin));
    const lx0 = L ? 0.02 : -0.19, lx1 = L ? 0.19 : -0.02;
    box([lx0, 0.5, -0.09], [lx1, 0.9, 0.09], L ? legL : legR, all(R.pants));
    box([lx0 + 0.01, 0.08, -0.08], [lx1 - 0.01, 0.48, 0.08], L ? shinL : shinR, all(R.pants));
    box([lx0, 0, -0.09], [lx1, 0.08, 0.2], L ? shinL : shinR, all(R.shoe));
  }
  // 髪のトゲ（PS1らしい三角ポリゴン）
  const spike = (p: V3[], tip: V3) => {
    const base = o.verts.length;
    for (const v of [...p, tip]) {
      o.verts.push(v);
      o.skin.push([[head, 1]]);
    }
    const uv = uvRect(R.hair);
    const n = p.length;
    for (let i = 0; i < n; i++)
      o.faces.push({ v: [base + i, base + ((i + 1) % n), base + n], uv: [uv[0], uv[1], uv[2]], col: [[1, 1, 1], [1, 1, 1], [1, 0.8, 0.3]] });
  };
  spike([[-0.16, 1.8, 0.15], [0.0, 1.8, 0.15], [0.0, 1.8, -0.0], [-0.16, 1.8, -0.0]], [-0.2, 2.02, 0.16]);
  spike([[0.0, 1.8, 0.15], [0.16, 1.8, 0.15], [0.16, 1.8, 0.0], [0.0, 1.8, 0.0]], [0.2, 2.02, 0.16]);
  spike([[-0.16, 1.8, 0.0], [0.16, 1.8, 0.0], [0.16, 1.8, -0.15], [-0.16, 1.8, -0.15]], [0.0, 2.08, -0.22]);

  // アニメーション
  const X: V3 = [1, 0, 0];
  const rest = restPose(doc.bones);
  const key = (clip: ReturnType<typeof newClip>, b: number, f: number, deg: number, dy = 0) => {
    const p = rest[b];
    setKey(clip, b, f, { pos: [p.pos[0], p.pos[1] + dy, p.pos[2]], rot: qFromAxisAngle(X, (deg * Math.PI) / 180), scl: p.scl });
  };
  const walk = newClip(doc, '歩き');
  walk.fps = 15;
  walk.length = 16;
  for (const [f, s] of [[0, 1], [4, 0], [8, -1], [12, 0], [16, 1]] as [number, number][]) {
    key(walk, legL, f, -32 * s);
    key(walk, legR, f, 32 * s);
    key(walk, shinL, f, s < 0 ? 40 : s === 0 ? 14 : 4);
    key(walk, shinR, f, s > 0 ? 40 : s === 0 ? 14 : 4);
    key(walk, armL, f, 28 * s);
    key(walk, armR, f, -28 * s);
    key(walk, foreL, f, -18);
    key(walk, foreR, f, -18);
    key(walk, hips, f, 0, s === 0 ? 0.03 : 0);
  }
  const idle = newClip(doc, '待機');
  idle.fps = 15;
  idle.length = 30;
  for (const [f, s] of [[0, 0], [15, 1], [30, 0]] as [number, number][]) {
    key(idle, spine, f, 2 * s, 0.012 * s);
    key(idle, head, f, -3 * s);
    key(idle, armL, f, 3 * s);
    key(idle, armR, f, 3 * s);
  }
  return doc;
}
