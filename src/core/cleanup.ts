// 読み込んだ三角形メッシュを、編集しやすい四角形主体に整える
import type { MeshObj, V3 } from './types';
import { edgeKey } from './types';
import { cross, dot, norm, sub } from './vec';
import { faceNormal } from './mesh-ops';

const same2 = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
const same3 = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4 && Math.abs(a[2] - b[2]) < 1e-4;

function isConvex(P: V3[], n: V3): boolean {
  for (let i = 0; i < P.length; i++) {
    const a = P[i],
      b = P[(i + 1) % P.length],
      c = P[(i + 2) % P.length];
    if (dot(cross(sub(b, a), sub(c, b)), n) <= 1e-12) return false;
  }
  return true;
}

/** 四角形らしさ（各角の90°からのずれの最大値。小さいほど良い） */
function squareness(P: V3[]): number {
  let worst = 0;
  for (let i = 0; i < 4; i++) {
    const a = norm(sub(P[(i + 3) % 4], P[i])),
      b = norm(sub(P[(i + 1) % 4], P[i]));
    worst = Math.max(worst, Math.abs(Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) - Math.PI / 2));
  }
  return worst;
}

/** 同一平面・UV と色が連続している三角形の組を四角形にまとめる。まとめた数を返す */
export function trisToQuads(o: MeshObj, maxAngleDeg = 3): number {
  const cosMax = Math.cos((maxAngleDeg * Math.PI) / 180);
  const tri = o.faces.map((f) => f.v.length === 3);
  const normals = o.faces.map((f) => faceNormal(o, f));
  const edgeMap = new Map<string, number[]>();
  o.faces.forEach((f, fi) => {
    if (!tri[fi]) return;
    for (let i = 0; i < 3; i++) {
      const k = edgeKey(f.v[i], f.v[(i + 1) % 3]);
      const l = edgeMap.get(k);
      if (l) l.push(fi);
      else edgeMap.set(k, [fi]);
    }
  });
  const cands: { a: number; b: number; quad: number[]; corners: [number, number][]; score: number }[] = [];
  for (const [, l] of edgeMap) {
    if (l.length !== 2) continue;
    const [ai, bi] = l;
    const A = o.faces[ai],
      B = o.faces[bi];
    if (dot(normals[ai], normals[bi]) < cosMax) continue;
    // A の中で共有辺 x→y を探す
    let ia = -1;
    for (let i = 0; i < 3; i++) if (B.v.includes(A.v[i]) && B.v.includes(A.v[(i + 1) % 3])) ia = i;
    if (ia < 0) continue;
    const x = A.v[ia],
      y = A.v[(ia + 1) % 3],
      p = A.v[(ia + 2) % 3];
    const ib = B.v.indexOf(y);
    if (B.v[(ib + 1) % 3] !== x) continue; // 向きが逆の面同士はまとめない
    const q = B.v[(ib + 2) % 3];
    // 共有する2頂点でUVと色が一致しているか
    const bx = B.v.indexOf(x),
      by = ib;
    if (!same2(A.uv[ia], B.uv[bx]) || !same2(A.uv[(ia + 1) % 3], B.uv[by])) continue;
    if (!same3(A.col[ia], B.col[bx]) || !same3(A.col[(ia + 1) % 3], B.col[by])) continue;
    const quad = [x, q, y, p];
    const P = quad.map((v) => o.verts[v]);
    if (!isConvex(P, normals[ai])) continue;
    // [面番号, コーナー番号] の並び
    const corners: [number, number][] = [
      [ai, ia],
      [bi, (ib + 2) % 3],
      [ai, (ia + 1) % 3],
      [ai, (ia + 2) % 3],
    ];
    cands.push({ a: ai, b: bi, quad, corners, score: squareness(P) });
  }
  cands.sort((s, t) => s.score - t.score);
  const used = new Set<number>();
  const remove = new Set<number>();
  let n = 0;
  for (const c of cands) {
    if (used.has(c.a) || used.has(c.b)) continue;
    used.add(c.a);
    used.add(c.b);
    const uv = c.corners.map(([fi, ci]) => [...o.faces[fi].uv[ci]] as [number, number]);
    const col = c.corners.map(([fi, ci]) => [...o.faces[fi].col[ci]] as V3);
    o.faces[c.a] = { v: c.quad, uv, col };
    remove.add(c.b);
    n++;
  }
  if (remove.size) o.faces = o.faces.filter((_, i) => !remove.has(i));
  return n;
}
