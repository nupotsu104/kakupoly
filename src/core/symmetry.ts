// 左右対称モード（X=0 の面で鏡写し）の計算
import type { Doc, MeshObj, Selection, V3 } from './types';
import { edgeKey, parseEdge } from './types';
import { dist } from './vec';
import { mirrorBoneName } from './mesh-ops';

export const SYM_EPS = 1e-3;

/** 対の判定に使う許容誤差。大きいモデル（cm単位など）でも効くよう、大きさに比例させる */
export function symEps(o: MeshObj): number {
  let mn = [Infinity, Infinity, Infinity],
    mx = [-Infinity, -Infinity, -Infinity];
  for (const p of o.verts)
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], p[k]);
      mx[k] = Math.max(mx[k], p[k]);
    }
  if (!isFinite(mn[0])) return SYM_EPS;
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
  return Math.max(SYM_EPS, diag * 5e-4);
}
export const mirrorV = (p: V3): V3 => [-p[0], p[1], p[2]];

/** from の各頂点について、pool の中から鏡写しの位置にある頂点を探す（X=0 上の頂点は自分自身） */
export function pairVerts(o: MeshObj, from: Iterable<number>, pool: Iterable<number>, eps = symEps(o), poolObj: MeshObj = o): Map<number, number> {
  const cell = eps * 4;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  for (const i of pool) {
    const p = poolObj.verts[i];
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
            const d = dist(poolObj.verts[j], q);
            // 同じ距離なら自分自身を優先（中心線上の頂点）
            if (d < bd || (d === bd && j === v && poolObj === o)) {
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
export function symmetricMover(o: MeshObj, selected: number[], others: MeshObj[] = []) {
  const selSet = new Set(selected);
  const inSel = pairVerts(o, selected, selected);
  const lonely = selected.filter((v) => !inSel.has(v));
  const outside = pairVerts(
    o,
    lonely,
    o.verts.map((_, i) => i).filter((i) => !selSet.has(i)),
  );
  // 左右のパーツが別オブジェクトの場合（AIが作ったモデルに多い）は、そちらの頂点を追従させる
  const cross = new Map<number, [MeshObj, number]>();
  const stillLonely = lonely.filter((v) => !outside.has(v) && Math.abs(o.verts[v][0]) > symEps(o));
  for (const other of others) {
    if (other === o || stillLonely.length === 0) continue;
    const m = pairVerts(o, stillLonely.filter((v) => !cross.has(v)), other.verts.map((_, i) => i), symEps(o), other);
    for (const [v, j] of m) cross.set(v, [other, j]);
  }
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
        const cm = cross.get(v);
        if (cm) cm[0].verts[cm[1]] = mirrorV(p);
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

export interface SymDiagnosis {
  /** 同じオブジェクト内に反対側の頂点がある割合 */
  same: number;
  /** どれかのオブジェクトに反対側の頂点がある割合 */
  any: number;
  /** モデル全体の中心のずれ（幅に対する割合） */
  offset: number;
  message: string | null;
}

/** 左右対称が効くモデルかを調べ、効かない理由を返す */
export function diagnoseSymmetry(doc: Doc, oi: number): SymDiagnosis {
  const o = doc.objects[oi];
  if (!o || o.verts.length === 0) return { same: 1, any: 1, offset: 0, message: null };
  const all = o.verts.map((_, i) => i);
  const eps = symEps(o);
  const same = pairVerts(o, all, all, eps);
  const found = new Set(same.keys());
  for (const other of doc.objects) {
    if (other === o || !other.visible) continue;
    for (const v of pairVerts(o, all.filter((v) => !found.has(v)), other.verts.map((_, i) => i), eps, other).keys()) found.add(v);
  }
  let mn = Infinity,
    mx = -Infinity;
  for (const ob of doc.objects) if (ob.visible) for (const p of ob.verts) (mn = Math.min(mn, p[0])), (mx = Math.max(mx, p[0]));
  const width = Math.max(1e-9, mx - mn);
  const offset = Math.abs((mn + mx) / 2) / width;
  const n = o.verts.length;
  const r = { same: same.size / n, any: found.size / n, offset };
  let message: string | null = null;
  if (r.same >= 0.8) message = null;
  else if (r.any >= 0.8) message = '左右のパーツが別々のオブジェクトになっています。移動・回転は反対側も追従しますが、押し出し等は片側だけです。右パネル下の「全部を1つに結合」でまとめると全部の操作が両側に効きます。';
  else if (offset > 0.05) message = 'モデルが中心（X=0）からずれているため、反対側が見つかりません。右パネル下の「中心に移動」で直せます。';
  else message = 'このオブジェクトは左右対称になっていません（反対側の同じ位置に頂点が見つかりません）。横向きのモデルなら回転させてから使ってください。';
  return { ...r, message };
}

/** 全体を X 方向に動かして、中心を X=0 に合わせる。動かした量を返す */
export function centerX(doc: Doc): number {
  let mn = Infinity,
    mx = -Infinity;
  for (const o of doc.objects) for (const p of o.verts) (mn = Math.min(mn, p[0])), (mx = Math.max(mx, p[0]));
  if (!isFinite(mn)) return 0;
  const dx = -(mn + mx) / 2;
  for (const o of doc.objects) for (const p of o.verts) p[0] += dx;
  // ルートボーン（とそのアニメの位置キー）も同じだけずらす
  doc.bones.forEach((b, i) => {
    if (b.parent >= 0) return;
    b.pos[0] += dx;
    for (const c of doc.clips) for (const t of c.tracks) if (t.bone === i) for (const k of t.keys) k.pos[0] += dx;
  });
  return dx;
}
