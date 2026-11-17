// 左右対称モード（X=0 の面で鏡写し）の計算
import type { Doc, MeshObj, Selection, V3 } from './types';
import { edgeKey, parseEdge } from './types';
import { dist } from './vec';
import { mirrorBoneName } from './mesh-ops';

export const SYM_EPS = 1e-3;
export const mirrorV = (p: V3): V3 => [-p[0], p[1], p[2]];

/** from の各頂点について、pool の中から鏡写しの位置にある頂点を探す（X=0 上の頂点は自分自身） */
export function pairVerts(o: MeshObj, from: Iterable<number>, pool: Iterable<number>, eps = SYM_EPS): Map<number, number> {
  const cell = eps * 4;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  for (const i of pool) {
    const p = o.verts[i];
    const k = key(Math.round(p[0] / cell), Math.round(p[1] / cell), Math.round(p[2] / cell));
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
  }
  const out = new Map<number, number>();
  for (const v of from) {
    const q = mirrorV(o.verts[v]);
    const c = [Math.round(q[0] / cell), Math.round(q[1] / cell), Math.round(q[2] / cell)];
    let best = -1,
      bd = eps;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(key(c[0] + dx, c[1] + dy, c[2] + dz)) ?? []) {
            const d = dist(o.verts[j], q);
            // 同じ距離なら自分自身を優先（中心線上の頂点）
            if (d < bd || (d === bd && j === v)) {
              bd = d;
              best = j;
            }
          }
    if (best >= 0) out.set(v, best);
  }
  return out;
}

/** 頂点・辺・面の「反対側」を引く表 */
export function symmetryMap(o: MeshObj) {
  const all = o.verts.map((_, i) => i);
  const vp = pairVerts(o, all, all);
  const faceByVerts = new Map<string, number>();
  const fkey = (vs: number[]) => [...vs].sort((a, b) => a - b).join(',');
  o.faces.forEach((f, i) => faceByVerts.set(fkey(f.v), i));
  return {
    vert: (v: number): number | undefined => vp.get(v),
    edge: (k: string): string | undefined => {
      const [a, b] = parseEdge(k);
      const ma = vp.get(a),
        mb = vp.get(b);
      return ma !== undefined && mb !== undefined && ma !== mb ? edgeKey(ma, mb) : undefined;
    },
    face: (fi: number): number | undefined => {
      const f = o.faces[fi];
      if (!f) return undefined;
      const m = f.v.map((v) => vp.get(v));
      if (m.some((x) => x === undefined)) return undefined;
      return faceByVerts.get(fkey(m as number[]));
    },
  };
}

/** 選択に、その反対側を足す */
export function mirrorSelection(o: MeshObj, sel: Selection): void {
  const s = symmetryMap(o);
  if (sel.mode === 'vert') for (const v of [...sel.verts]) {
    const m = s.vert(v);
    if (m !== undefined) sel.verts.add(m);
  }
  else if (sel.mode === 'edge') for (const k of [...sel.edges]) {
    const m = s.edge(k);
    if (m) sel.edges.add(m);
  }
  else for (const fi of [...sel.faces]) {
    const m = s.face(fi);
    if (m !== undefined) sel.faces.add(m);
  }
}

/**
 * 対称に変形するための対応表。
 * - 選択した頂点どうしで対になるもの → 片方（代表）だけ計算し、もう片方は鏡写し
 * - 対が選択外にあるもの → 選択外の方を鏡写しで追従させる
 * - 中心線上の頂点 → X=0 に留める
 */
export function symmetricMover(o: MeshObj, selected: number[]) {
  const selSet = new Set(selected);
  const inSel = pairVerts(o, selected, selected);
  const lonely = selected.filter((v) => !inSel.has(v));
  const outside = pairVerts(
    o,
    lonely,
    o.verts.map((_, i) => i).filter((i) => !selSet.has(i)),
  );
  const orig = new Map<number, V3>(selected.map((v) => [v, [...o.verts[v]] as V3]));
  return (fn: (p: V3) => V3): void => {
    for (const v of selected) {
      const p0 = orig.get(v)!;
      const m = inSel.get(v);
      if (m === v) {
        const p = fn(p0);
        o.verts[v] = [0, p[1], p[2]];
      } else if (m !== undefined) {
        const q0 = orig.get(m)!;
        const rep = p0[0] > q0[0] || (p0[0] === q0[0] && v < m);
        if (!rep) continue;
        const p = fn(p0);
        o.verts[v] = p;
        o.verts[m] = mirrorV(p);
      } else {
        const p = fn(p0);
        o.verts[v] = p;
        const om = outside.get(v);
        if (om !== undefined) o.verts[om] = mirrorV(p);
      }
    }
  };
}

/** 反対側のボーン（.L ⇔ .R 等）。なければ -1 */
export function mirrorBone(doc: Doc, i: number): number {
  const b = doc.bones[i];
  if (!b) return -1;
  const n = mirrorBoneName(b.name);
  return n ? doc.bones.findIndex((x) => x.name === n) : -1;
}

/** 左右ペアのボーン名の土台（name.L と name.R の両方が空いているもの） */
export function pairBoneBase(doc: Doc, base = 'bone'): string {
  const names = new Set(doc.bones.map((b) => b.name));
  for (let i = 0; ; i++) {
    const n = i === 0 ? base : `${base}.${String(i).padStart(2, '0')}`;
    if (!names.has(`${n}.L`) && !names.has(`${n}.R`)) return n;
  }
}
