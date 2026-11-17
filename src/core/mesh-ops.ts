// メッシュ編集オペレーション。すべて MeshObj / Selection を直接書き換える（呼び出し側が事前に履歴を積む）。
import type { Doc, Face, MeshObj, Selection, V2, V3, Influence } from './types';
import { edgeKey, parseEdge } from './types';
import { add, centroid, cross, lerp, mul, norm, sub, dist } from './vec';

const lerp2 = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const cloneFace = (f: Face): Face => ({
  v: [...f.v],
  uv: f.uv.map((p) => [p[0], p[1]] as V2),
  col: f.col.map((c) => [c[0], c[1], c[2]] as V3),
});
const cloneInf = (inf: Influence[] | undefined): Influence[] => (inf ? inf.map((x) => [x[0], x[1]] as Influence) : []);

function pushVert(o: MeshObj, p: V3, skinFrom?: number): number {
  while (o.skin.length < o.verts.length) o.skin.push([]);
  o.verts.push([p[0], p[1], p[2]]);
  o.skin.push(skinFrom !== undefined ? cloneInf(o.skin[skinFrom]) : []);
  return o.verts.length - 1;
}

// ---------- 参照系 ----------

/** 選択から「動かす対象の頂点集合」を得る */
export function selVerts(o: MeshObj, sel: Selection): Set<number> {
  const s = new Set<number>();
  if (sel.mode === 'vert') for (const v of sel.verts) v < o.verts.length && s.add(v);
  else if (sel.mode === 'edge')
    for (const k of sel.edges) {
      const [a, b] = parseEdge(k);
      if (a < o.verts.length && b < o.verts.length) {
        s.add(a);
        s.add(b);
      }
    }
  else for (const fi of sel.faces) o.faces[fi]?.v.forEach((v) => s.add(v));
  return s;
}

/** 選択に関係する面（面モード=選択面、頂点/辺モード=全頂点が選択された面） */
export function selFaces(o: MeshObj, sel: Selection): Set<number> {
  if (sel.mode === 'face') return new Set([...sel.faces].filter((i) => i < o.faces.length));
  const vs = selVerts(o, sel);
  const s = new Set<number>();
  o.faces.forEach((f, i) => f.v.every((v) => vs.has(v)) && s.add(i));
  return s;
}

export function faceNormal(o: MeshObj, f: Face, verts: V3[] = o.verts): V3 {
  // Newell法（多角形でも安定）
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < f.v.length; i++) {
    const a = verts[f.v[i]],
      b = verts[f.v[(i + 1) % f.v.length]];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return norm(n);
}

export const faceCenter = (o: MeshObj, f: Face): V3 => centroid(f.v.map((v) => o.verts[v]));

/** 辺 → その辺を含む面のリスト */
export function edgeFaces(o: MeshObj): Map<string, number[]> {
  const m = new Map<string, number[]>();
  o.faces.forEach((f, fi) => {
    for (let i = 0; i < f.v.length; i++) {
      const k = edgeKey(f.v[i], f.v[(i + 1) % f.v.length]);
      const l = m.get(k);
      if (l) l.push(fi);
      else m.set(k, [fi]);
    }
  });
  return m;
}

export function selectionCenter(o: MeshObj, sel: Selection): V3 | null {
  const vs = selVerts(o, sel);
  if (vs.size === 0) return null;
  return centroid([...vs].map((v) => o.verts[v]));
}

export function selectionNormal(o: MeshObj, sel: Selection): V3 {
  const n: V3 = [0, 0, 0];
  const fs = selFaces(o, sel);
  for (const fi of fs) {
    const fn = faceNormal(o, o.faces[fi]);
    n[0] += fn[0];
    n[1] += fn[1];
    n[2] += fn[2];
  }
  const r = norm(n);
  return r[0] === 0 && r[1] === 0 && r[2] === 0 ? [0, 1, 0] : r;
}

// ---------- 頂点の整理 ----------

/** map[old] = new（-1 は削除）。面・スキンを付け替え、潰れた面を除去。面の旧→新対応を返す */
export function remapVerts(o: MeshObj, map: number[], newVerts: V3[], newSkin: Influence[][]): number[] {
  const faceMap: number[] = [];
  const faces: Face[] = [];
  o.faces.forEach((f) => {
    const nf: Face = { v: [], uv: [], col: [] };
    let dead = false;
    for (let i = 0; i < f.v.length; i++) {
      const nv = map[f.v[i]];
      if (nv < 0) {
        dead = true;
        break;
      }
      if (nf.v.length > 0 && nf.v[nf.v.length - 1] === nv) continue;
      nf.v.push(nv);
      nf.uv.push(f.uv[i]);
      nf.col.push(f.col[i]);
    }
    if (!dead && nf.v.length > 1 && nf.v[0] === nf.v[nf.v.length - 1]) {
      nf.v.pop();
      nf.uv.pop();
      nf.col.pop();
    }
    if (dead || new Set(nf.v).size < 3 || new Set(nf.v).size !== nf.v.length) {
      faceMap.push(-1);
      return;
    }
    faceMap.push(faces.length);
    faces.push(nf);
  });
  o.faces = faces;
  o.verts = newVerts;
  o.skin = newSkin;
  return faceMap;
}

/** どの面にも使われていない頂点を取り除く。旧→新の頂点対応を返す */
export function removeOrphans(o: MeshObj, keep?: Set<number>): number[] {
  const used = new Set<number>(keep);
  for (const f of o.faces) for (const v of f.v) used.add(v);
  const map: number[] = [];
  const nv: V3[] = [];
  const ns: Influence[][] = [];
  o.verts.forEach((p, i) => {
    if (used.has(i)) {
      map.push(nv.length);
      nv.push(p);
      ns.push(o.skin[i] ?? []);
    } else map.push(-1);
  });
  remapVerts(o, map, nv, ns);
  return map;
}

function clearSel(sel: Selection): void {
  sel.verts.clear();
  sel.edges.clear();
  sel.faces.clear();
}

// ---------- プリミティブ ----------

export type PrimKind = 'cube' | 'plane' | 'cylinder' | 'cone' | 'sphere';
export interface PrimOpts {
  size?: number;
  sides?: number;
  rings?: number;
  center?: V3;
  color?: V3;
}

const QUV: V2[] = [
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
];

export function addPrimitive(o: MeshObj, sel: Selection, kind: PrimKind, opts: PrimOpts = {}): void {
  const s = (opts.size ?? 1) / 2;
  const c = opts.center ?? [0, 0, 0];
  const col = opts.color ?? [1, 1, 1];
  const n = Math.max(3, opts.sides ?? 8);
  const base = o.verts.length;
  const vs: V3[] = [];
  const fs: { v: number[]; uv: V2[] }[] = [];
  if (kind === 'cube') {
    vs.push([-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s], [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s]);
    for (const q of [
      [4, 5, 6, 7],
      [1, 0, 3, 2],
      [5, 1, 2, 6],
      [0, 4, 7, 3],
      [7, 6, 2, 3],
      [0, 1, 5, 4],
    ])
      fs.push({ v: q, uv: QUV });
  } else if (kind === 'plane') {
    vs.push([-s, 0, s], [s, 0, s], [s, 0, -s], [-s, 0, -s]);
    fs.push({ v: [0, 1, 2, 3], uv: QUV });
  } else if (kind === 'cylinder' || kind === 'cone') {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      vs.push([Math.cos(a) * s, -s, Math.sin(a) * s]);
    }
    const capUv = (i: number): V2 => {
      const a = (i / n) * Math.PI * 2;
      return [0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5];
    };
    if (kind === 'cylinder') {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        vs.push([Math.cos(a) * s, s, Math.sin(a) * s]);
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const u0 = 1 - i / n,
          u1 = 1 - (i + 1) / n;
        fs.push({
          v: [j, i, n + i, n + j],
          uv: [
            [u1, 1],
            [u0, 1],
            [u0, 0],
            [u1, 0],
          ],
        });
      }
      const top = [];
      for (let i = n - 1; i >= 0; i--) top.push(n + i);
      fs.push({ v: top, uv: top.map((v) => capUv(v - n)) });
    } else {
      vs.push([0, s, 0]);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        fs.push({
          v: [j, i, n],
          uv: [
            [1 - (i + 1) / n, 1],
            [1 - i / n, 1],
            [1 - (i + 0.5) / n, 0],
          ],
        });
      }
    }
    const bottom = [];
    for (let i = 0; i < n; i++) bottom.push(i);
    fs.push({ v: bottom, uv: bottom.map((v) => capUv(v)) });
  } else {
    // UV球: 極は三角形、それ以外は四角形
    const rings = Math.max(2, opts.rings ?? Math.max(2, Math.round(n / 2)));
    vs.push([0, -s, 0]);
    for (let r = 1; r < rings; r++) {
      const ph = (r / rings) * Math.PI - Math.PI / 2;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        vs.push([Math.cos(a) * Math.cos(ph) * s, Math.sin(ph) * s, Math.sin(a) * Math.cos(ph) * s]);
      }
    }
    vs.push([0, s, 0]);
    const top = vs.length - 1;
    const ring = (r: number, i: number) => 1 + (r - 1) * n + (i % n);
    const uvAt = (r: number, i: number): V2 => [1 - i / n, 1 - r / rings];
    for (let i = 0; i < n; i++) {
      fs.push({ v: [0, ring(1, i), ring(1, i + 1)], uv: [uvAt(0, i + 0.5), uvAt(1, i), uvAt(1, i + 1)] });
      for (let r = 1; r < rings - 1; r++)
        fs.push({
          v: [ring(r, i + 1), ring(r, i), ring(r + 1, i), ring(r + 1, i + 1)],
          uv: [uvAt(r, i + 1), uvAt(r, i), uvAt(r + 1, i), uvAt(r + 1, i + 1)],
        });
      fs.push({
        v: [ring(rings - 1, i + 1), ring(rings - 1, i), top],
        uv: [uvAt(rings - 1, i + 1), uvAt(rings - 1, i), uvAt(rings, i + 0.5)],
      });
    }
  }
  for (const p of vs) pushVert(o, add(p, c));
  clearSel(sel);
  sel.mode = 'face';
  for (const f of fs) {
    o.faces.push({ v: f.v.map((v) => v + base), uv: f.uv.map((p) => [p[0], p[1]] as V2), col: f.v.map(() => [...col] as V3) });
    sel.faces.add(o.faces.length - 1);
  }
}

// ---------- 削除・結合 ----------

export function deleteSelection(o: MeshObj, sel: Selection): void {
  if (sel.mode === 'vert') {
    const map: number[] = [];
    const nv: V3[] = [],
      ns: Influence[][] = [];
    o.verts.forEach((p, i) => {
      if (sel.verts.has(i)) map.push(-1);
      else {
        map.push(nv.length);
        nv.push(p);
        ns.push(o.skin[i] ?? []);
      }
    });
    remapVerts(o, map, nv, ns);
  } else {
    let kill: Set<number>;
    if (sel.mode === 'face') kill = new Set(sel.faces);
    else {
      kill = new Set();
      const ef = edgeFaces(o);
      for (const k of sel.edges) for (const fi of ef.get(k) ?? []) kill.add(fi);
    }
    o.faces = o.faces.filter((_, i) => !kill.has(i));
  }
  removeOrphans(o);
  clearSel(sel);
}

/** 選択頂点を重心に結合 */
export function mergeAtCenter(o: MeshObj, sel: Selection): void {
  const vs = [...selVerts(o, sel)];
  if (vs.length < 2) return;
  const c = centroid(vs.map((v) => o.verts[v]));
  const target = vs[0];
  o.verts[target] = c;
  const set = new Set(vs);
  const map: number[] = [];
  const nv: V3[] = [],
    ns: Influence[][] = [];
  let targetNew = -1;
  o.verts.forEach((p, i) => {
    if (set.has(i) && i !== target) map.push(-2);
    else {
      if (i === target) targetNew = nv.length;
      map.push(nv.length);
      nv.push(p);
      ns.push(o.skin[i] ?? []);
    }
  });
  for (let i = 0; i < map.length; i++) if (map[i] === -2) map[i] = targetNew;
  remapVerts(o, map, nv, ns);
  clearSel(sel);
  sel.mode = 'vert';
  sel.verts.add(targetNew);
}

const sameSkin = (a: Influence[] | undefined, b: Influence[] | undefined): boolean => {
  const x = a ?? [],
    y = b ?? [];
  if (x.length !== y.length) return false;
  const m = new Map(x.map(([bn, w]) => [bn, w]));
  return y.every(([bn, w]) => m.has(bn) && Math.abs(m.get(bn)! - w) < 1e-3);
};

/** 距離 eps 以内の頂点を溶接。対象は only（省略時は全頂点）。keepSkin なら割り当てボーンが同じ頂点どうしだけ。溶接した数を返す */
export function weldByDistance(o: MeshObj, eps: number, only?: Set<number>, keepSkin = false): number {
  const list = only ? [...only] : o.verts.map((_, i) => i);
  const rep = o.verts.map((_, i) => i);
  let merged = 0;
  // 空間ハッシュで近傍探索
  const cell = Math.max(eps, 1e-6);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (const i of list) {
    const p = o.verts[i];
    const cx = Math.floor(p[0] / cell),
      cy = Math.floor(p[1] / cell),
      cz = Math.floor(p[2] / cell);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const l = grid.get(key(cx + dx, cy + dy, cz + dz));
          if (!l) continue;
          for (const j of l)
            if (dist(o.verts[j], p) <= eps && (!keepSkin || sameSkin(o.skin[i], o.skin[j]))) {
              found = j;
              break;
            }
        }
    if (found >= 0) {
      rep[i] = found;
      merged++;
    } else {
      const k = key(cx, cy, cz);
      const l = grid.get(k);
      if (l) l.push(i);
      else grid.set(k, [i]);
    }
  }
  if (merged === 0) return 0;
  const map: number[] = [];
  const nv: V3[] = [],
    ns: Influence[][] = [];
  o.verts.forEach((p, i) => {
    if (rep[i] === i) {
      map.push(nv.length);
      nv.push(p);
      ns.push(o.skin[i] ?? []);
    } else map.push(-2);
  });
  for (let i = 0; i < map.length; i++) if (map[i] === -2) map[i] = map[rep[i]];
  remapVerts(o, map, nv, ns);
  return merged;
}

// ---------- 押し出し・インセット ----------

/** 面の押し出し（領域）。選択面はそのまま（番号不変）で新しい頂点に乗り、側面が張られる。動かすべき頂点を返す */
export function extrudeFaces(o: MeshObj, sel: Selection): number[] {
  const fs = selFaces(o, sel);
  if (fs.size === 0) return [];
  const edgeCount = new Map<string, number>();
  const directed: [number, number, number, number][] = []; // a, b, face, corner
  for (const fi of fs) {
    const f = o.faces[fi];
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i],
        b = f.v[(i + 1) % f.v.length];
      const k = edgeKey(a, b);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
      directed.push([a, b, fi, i]);
    }
  }
  const needDup = new Set<number>();
  for (const [a, b] of directed)
    if (edgeCount.get(edgeKey(a, b)) === 1) {
      needDup.add(a);
      needDup.add(b);
    }
  o.faces.forEach((f, fi) => {
    if (!fs.has(fi)) for (const v of f.v) needDup.add(v);
  });
  const region = new Set<number>();
  for (const fi of fs) for (const v of o.faces[fi].v) region.add(v);
  const dup = new Map<number, number>();
  for (const v of region) if (needDup.has(v)) dup.set(v, pushVert(o, o.verts[v], v));
  // 側面
  for (const [a, b, fi, i] of directed) {
    if (edgeCount.get(edgeKey(a, b)) !== 1) continue;
    const f = o.faces[fi];
    const j = (i + 1) % f.v.length;
    o.faces.push({
      v: [a, b, dup.get(b)!, dup.get(a)!],
      uv: [f.uv[i], f.uv[j], f.uv[j], f.uv[i]].map((p) => [p[0], p[1]] as V2),
      col: [f.col[i], f.col[j], f.col[j], f.col[i]].map((c) => [...c] as V3),
    });
  }
  for (const fi of fs) {
    const f = o.faces[fi];
    f.v = f.v.map((v) => dup.get(v) ?? v);
  }
  const moved = new Set<number>();
  for (const fi of fs) for (const v of o.faces[fi].v) moved.add(v);
  if (sel.mode !== 'face') {
    clearSel(sel);
    sel.mode = 'face';
    for (const fi of fs) sel.faces.add(fi);
  }
  return [...moved];
}

/** 辺の押し出し（板から面を伸ばす用）。新しい辺が選択される */
export function extrudeEdges(o: MeshObj, sel: Selection): number[] {
  if (sel.mode !== 'edge' || sel.edges.size === 0) return [];
  const ef = edgeFaces(o);
  const dup = new Map<number, number>();
  const d = (v: number) => {
    let n = dup.get(v);
    if (n === undefined) {
      n = pushVert(o, o.verts[v], v);
      dup.set(v, n);
    }
    return n;
  };
  const newEdges: string[] = [];
  for (const k of sel.edges) {
    let [a, b] = parseEdge(k);
    let uvA: V2 = [0, 0],
      uvB: V2 = [0, 0],
      cA: V3 = [1, 1, 1],
      cB: V3 = [1, 1, 1];
    const fi = ef.get(k)?.[0];
    if (fi !== undefined) {
      const f = o.faces[fi];
      const ia = f.v.indexOf(a),
        ib = f.v.indexOf(b);
      // 隣の面が a→b の向きなら、新しい面は b→a の向きで張る
      if (f.v[(ia + 1) % f.v.length] === b) {
        [a, b] = [b, a];
        uvA = f.uv[ib];
        uvB = f.uv[ia];
        cA = f.col[ib];
        cB = f.col[ia];
      } else {
        uvA = f.uv[ia];
        uvB = f.uv[ib];
        cA = f.col[ia];
        cB = f.col[ib];
      }
    }
    // ここで隣の面は b→a の向き。新しい面は a→b で張る
    o.faces.push({
      v: [a, b, d(b), d(a)],
      uv: [uvA, uvB, uvB, uvA].map((p) => [p[0], p[1]] as V2),
      col: [cA, cB, cB, cA].map((c) => [...c] as V3),
    });
    newEdges.push(edgeKey(d(a), d(b)));
  }
  clearSel(sel);
  sel.mode = 'edge';
  for (const k of newEdges) sel.edges.add(k);
  return [...dup.values()];
}

/** 面ごとのインセット。t は中心への寄せ率(0..1) */
export function insetFaces(o: MeshObj, sel: Selection, t = 0.25): void {
  if (sel.mode !== 'face') return;
  for (const fi of [...sel.faces]) {
    const f = o.faces[fi];
    if (!f) continue;
    const n = f.v.length;
    const c = centroid(f.v.map((v) => o.verts[v]));
    const cuv: V2 = [f.uv.reduce((s, p) => s + p[0], 0) / n, f.uv.reduce((s, p) => s + p[1], 0) / n];
    const inner = f.v.map((v) => pushVert(o, lerp(o.verts[v], c, t), v));
    const iuv = f.uv.map((p) => lerp2(p, cuv, t));
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      o.faces.push({
        v: [f.v[i], f.v[j], inner[j], inner[i]],
        uv: [f.uv[i], f.uv[j], iuv[j], iuv[i]].map((p) => [p[0], p[1]] as V2),
        col: [f.col[i], f.col[j], f.col[j], f.col[i]].map((x) => [...x] as V3),
      });
    }
    f.v = inner;
    f.uv = iuv;
  }
}

// ---------- 分割 ----------

/** 辺 (a,b) の中間（比率t）に頂点を挿入し、その辺を含む全ての面のループに差し込む */
function splitEdgeRaw(o: MeshObj, a: number, b: number, t: number, faces?: Iterable<number>): number {
  const m = pushVert(o, lerp(o.verts[a], o.verts[b], t), a);
  // スキンは両端のブレンド
  const sa = o.skin[a] ?? [],
    sb = o.skin[b] ?? [];
  const mix = new Map<number, number>();
  for (const [bn, w] of sa) mix.set(bn, (mix.get(bn) ?? 0) + w * (1 - t));
  for (const [bn, w] of sb) mix.set(bn, (mix.get(bn) ?? 0) + w * t);
  o.skin[m] = [...mix.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, 4)
    .map(([bn, w]) => [bn, w] as Influence);
  const list = faces ? [...faces] : o.faces.map((_, i) => i);
  for (const fi of list) {
    const f = o.faces[fi];
    for (let i = 0; i < f.v.length; i++) {
      const j = (i + 1) % f.v.length;
      const x = f.v[i],
        y = f.v[j];
      if ((x === a && y === b) || (x === b && y === a)) {
        const tt = x === a ? t : 1 - t;
        f.v.splice(i + 1, 0, m);
        f.uv.splice(i + 1, 0, lerp2(f.uv[i], f.uv[j === 0 ? 0 : j], tt));
        const ci = f.col[i],
          cj = f.col[j === 0 ? 0 : j];
        f.col.splice(i + 1, 0, lerp(ci, cj, tt));
        break;
      }
    }
  }
  return m;
}

/** 選択辺を中点で分割 */
export function splitEdges(o: MeshObj, sel: Selection): void {
  if (sel.mode !== 'edge') return;
  const nv: number[] = [];
  for (const k of [...sel.edges]) {
    const [a, b] = parseEdge(k);
    nv.push(splitEdgeRaw(o, a, b, 0.5));
  }
  clearSel(sel);
  sel.mode = 'vert';
  for (const v of nv) sel.verts.add(v);
}

/** 同じ面上の2頂点を結んで面を2つに割る。成功したら true */
export function connectVerts(o: MeshObj, sel: Selection): boolean {
  if (sel.mode !== 'vert' || sel.verts.size !== 2) return false;
  const [a, b] = [...sel.verts];
  let done = false;
  const count = o.faces.length;
  for (let fi = 0; fi < count; fi++) {
    const f = o.faces[fi];
    const ia = f.v.indexOf(a),
      ib = f.v.indexOf(b);
    if (ia < 0 || ib < 0) continue;
    const n = f.v.length;
    if ((ia + 1) % n === ib || (ib + 1) % n === ia) continue; // 既に辺
    const take = (from: number, to: number): Face => {
      const nf: Face = { v: [], uv: [], col: [] };
      for (let i = from; ; i = (i + 1) % n) {
        nf.v.push(f.v[i]);
        nf.uv.push([...f.uv[i]] as V2);
        nf.col.push([...f.col[i]] as V3);
        if (i === to) break;
      }
      return nf;
    };
    const f1 = take(ia, ib),
      f2 = take(ib, ia);
    o.faces[fi] = f1;
    o.faces.push(f2);
    done = true;
  }
  if (done) {
    clearSel(sel);
    sel.mode = 'edge';
    sel.edges.add(edgeKey(a, b));
  }
  return done;
}

/** ループカット: 選択辺から四角形の帯をたどり、帯の中央に辺ループを入れる */
export function loopCut(o: MeshObj, sel: Selection, t = 0.5): boolean {
  if (sel.mode !== 'edge' || sel.edges.size === 0) return false;
  const ef = edgeFaces(o);
  const ring = new Set<string>();
  const quads = new Map<number, number>(); // 面 → 帯の辺の開始コーナー i（もう一方は i+2）
  const stack: string[] = [...sel.edges];
  for (const k of stack) ring.add(k);
  while (stack.length) {
    const k = stack.pop()!;
    const [a, b] = parseEdge(k);
    for (const fi of ef.get(k) ?? []) {
      if (quads.has(fi)) continue;
      const f = o.faces[fi];
      if (f.v.length !== 4) continue;
      let i = -1;
      for (let c = 0; c < 4; c++) {
        const x = f.v[c],
          y = f.v[(c + 1) % 4];
        if ((x === a && y === b) || (x === b && y === a)) i = c;
      }
      if (i < 0) continue;
      quads.set(fi, i);
      const opp = edgeKey(f.v[(i + 2) % 4], f.v[(i + 3) % 4]);
      if (!ring.has(opp)) {
        ring.add(opp);
        stack.push(opp);
      }
    }
  }
  if (quads.size === 0) return false;
  // 帯の向きをそろえるため、各辺の分割比は「a<b の小さい番号側から t」ではなく、面ごとに対辺と対応づける。
  // 単純化: 中点以外の t は面内で a→b と d→c が対応するよう、辺ごとに「基準端点」を伝播させる。
  const base = new Map<string, number>(); // 辺 → t の起点となる頂点
  const first = [...sel.edges][0];
  base.set(first, parseEdge(first)[0]);
  const queue = [first];
  while (queue.length) {
    const k = queue.shift()!;
    const origin = base.get(k)!;
    for (const fi of ef.get(k) ?? []) {
      const i = quads.get(fi);
      if (i === undefined) continue;
      const f = o.faces[fi];
      const e1 = edgeKey(f.v[i], f.v[(i + 1) % 4]);
      const e2 = edgeKey(f.v[(i + 2) % 4], f.v[(i + 3) % 4]);
      const other = e1 === k ? e2 : e2 === k ? e1 : null;
      if (!other || base.has(other)) continue;
      // 対辺で origin と辺でつながっている頂点が対応する起点
      const idx = f.v.indexOf(origin);
      const prev = f.v[(idx + 3) % 4],
        next = f.v[(idx + 1) % 4];
      const [oa, ob] = parseEdge(other);
      base.set(other, prev === oa || prev === ob ? prev : next);
      queue.push(other);
    }
  }
  const mid = new Map<string, number>();
  for (const k of ring) {
    const [a, b] = parseEdge(k);
    const origin = base.get(k) ?? a;
    const tt = origin === a ? t : 1 - t;
    // 帯に含まれない面（三角形や多角形）にはループ挿入で頂点を差し込む
    const others = (ef.get(k) ?? []).filter((fi) => !quads.has(fi));
    mid.set(k, splitEdgeRaw(o, a, b, tt, others));
  }
  const newEdges: string[] = [];
  for (const [fi, i] of quads) {
    const f = o.faces[fi];
    const id = [i, (i + 1) % 4, (i + 2) % 4, (i + 3) % 4];
    const [a, b, c, d] = id.map((x) => f.v[x]);
    const m1 = mid.get(edgeKey(a, b))!,
      m2 = mid.get(edgeKey(c, d))!;
    const t1 = dist(o.verts[a], o.verts[b]) > 1e-12 ? dist(o.verts[a], o.verts[m1]) / dist(o.verts[a], o.verts[b]) : 0.5;
    const t2 = dist(o.verts[d], o.verts[c]) > 1e-12 ? dist(o.verts[d], o.verts[m2]) / dist(o.verts[d], o.verts[c]) : 0.5;
    const uv = id.map((x) => f.uv[x]);
    const col = id.map((x) => f.col[x]);
    const uvm1 = lerp2(uv[0], uv[1], t1),
      uvm2 = lerp2(uv[3], uv[2], t2);
    const cm1 = lerp(col[0], col[1], t1),
      cm2 = lerp(col[3], col[2], t2);
    o.faces[fi] = { v: [a, m1, m2, d], uv: [uv[0], uvm1, uvm2, uv[3]], col: [col[0], cm1, cm2, col[3]] };
    o.faces.push({
      v: [m1, b, c, m2],
      uv: [[...uvm1] as V2, uv[1], uv[2], [...uvm2] as V2],
      col: [[...cm1] as V3, col[1], col[2], [...cm2] as V3],
    });
    newEdges.push(edgeKey(m1, m2));
  }
  clearSel(sel);
  sel.mode = 'edge';
  for (const k of newEdges) sel.edges.add(k);
  return true;
}

/** 面の細分化（四角形→4、三角形→4、多角形→中心から四角形） */
export function subdivideFaces(o: MeshObj, sel: Selection): void {
  const fs = selFaces(o, sel);
  if (fs.size === 0) return;
  const mid = new Map<string, number>();
  const notSel = o.faces.map((_, i) => i).filter((i) => !fs.has(i));
  // 先に元のコーナー情報を控える（辺の分割で面のループが変わるため）
  const orig = new Map<number, Face>();
  for (const fi of fs) orig.set(fi, cloneFace(o.faces[fi]));
  for (const f of orig.values())
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i],
        b = f.v[(i + 1) % f.v.length];
      const k = edgeKey(a, b);
      if (!mid.has(k)) mid.set(k, splitEdgeRaw(o, a, b, 0.5, notSel));
    }
  const out: number[] = [];
  for (const [fi, f] of orig) {
    const n = f.v.length;
    const m = f.v.map((v, i) => mid.get(edgeKey(v, f.v[(i + 1) % n]))!);
    const muv = f.uv.map((p, i) => lerp2(p, f.uv[(i + 1) % n], 0.5));
    const mcol = f.col.map((c, i) => lerp(c, f.col[(i + 1) % n], 0.5));
    const nf: Face[] = [];
    if (n === 3) {
      nf.push({ v: [f.v[0], m[0], m[2]], uv: [f.uv[0], muv[0], muv[2]], col: [f.col[0], mcol[0], mcol[2]] });
      nf.push({ v: [m[0], f.v[1], m[1]], uv: [muv[0], f.uv[1], muv[1]], col: [mcol[0], f.col[1], mcol[1]] });
      nf.push({ v: [m[2], m[1], f.v[2]], uv: [muv[2], muv[1], f.uv[2]], col: [mcol[2], mcol[1], f.col[2]] });
      nf.push({ v: [m[0], m[1], m[2]], uv: [muv[0], muv[1], muv[2]], col: [mcol[0], mcol[1], mcol[2]] });
    } else {
      const c = pushVert(o, centroid(f.v.map((v) => o.verts[v])), f.v[0]);
      const cuv: V2 = [f.uv.reduce((s, p) => s + p[0], 0) / n, f.uv.reduce((s, p) => s + p[1], 0) / n];
      const ccol: V3 = [0, 1, 2].map((k) => f.col.reduce((s, p) => s + p[k], 0) / n) as V3;
      for (let i = 0; i < n; i++) {
        const p = (i + n - 1) % n;
        nf.push({ v: [f.v[i], m[i], c, m[p]], uv: [f.uv[i], muv[i], cuv, muv[p]], col: [f.col[i], mcol[i], ccol, mcol[p]] });
      }
    }
    const fixed = nf.map(cloneFace);
    o.faces[fi] = fixed[0];
    out.push(fi);
    for (let i = 1; i < fixed.length; i++) {
      o.faces.push(fixed[i]);
      out.push(o.faces.length - 1);
    }
  }
  clearSel(sel);
  sel.mode = 'face';
  for (const fi of out) sel.faces.add(fi);
}

export function triangulate(o: MeshObj, sel: Selection): void {
  const fs = selFaces(o, sel);
  const out: number[] = [];
  for (const fi of fs) {
    const f = o.faces[fi];
    if (f.v.length === 3) {
      out.push(fi);
      continue;
    }
    const tris: Face[] = [];
    for (let i = 1; i < f.v.length - 1; i++)
      tris.push(
        cloneFace({ v: [f.v[0], f.v[i], f.v[i + 1]], uv: [f.uv[0], f.uv[i], f.uv[i + 1]], col: [f.col[0], f.col[i], f.col[i + 1]] }),
      );
    o.faces[fi] = tris[0];
    out.push(fi);
    for (let i = 1; i < tris.length; i++) {
      o.faces.push(tris[i]);
      out.push(o.faces.length - 1);
    }
  }
  clearSel(sel);
  sel.mode = 'face';
  for (const fi of out) sel.faces.add(fi);
}

/** 選択辺を溶解して両側の面を1つにする（三角形2枚→四角形など） */
export function dissolveEdges(o: MeshObj, sel: Selection): number {
  if (sel.mode !== 'edge') return 0;
  let n = 0;
  for (const k of [...sel.edges]) {
    const [a, b] = parseEdge(k);
    const fl = edgeFaces(o).get(k);
    if (!fl || fl.length !== 2) continue;
    const [f1i, f2i] = fl;
    const f1 = o.faces[f1i],
      f2 = o.faces[f2i];
    // f1 を「辺の終点から始まり始点で終わる」並びに回す
    const rot = (f: Face, start: number): Face => {
      const m = f.v.length;
      const r: Face = { v: [], uv: [], col: [] };
      for (let i = 0; i < m; i++) {
        const j = (start + i) % m;
        r.v.push(f.v[j]);
        r.uv.push(f.uv[j]);
        r.col.push(f.col[j]);
      }
      return r;
    };
    const dirEdgeStart = (f: Face): number => {
      for (let i = 0; i < f.v.length; i++) {
        const x = f.v[i],
          y = f.v[(i + 1) % f.v.length];
        if ((x === a && y === b) || (x === b && y === a)) return i;
      }
      return -1;
    };
    const s1 = dirEdgeStart(f1),
      s2 = dirEdgeStart(f2);
    if (s1 < 0 || s2 < 0) continue;
    const r1 = rot(f1, (s1 + 1) % f1.v.length); // [y ... x]
    const r2 = rot(f2, (s2 + 1) % f2.v.length); // [x' ... y'] 向きが整合していれば x'=x の相方
    if (r1.v[0] !== r2.v[r2.v.length - 1]) continue; // 面の向きが不整合
    const merged: Face = {
      v: [...r1.v, ...r2.v.slice(1, -1)],
      uv: [...r1.uv, ...r2.uv.slice(1, -1)],
      col: [...r1.col, ...r2.col.slice(1, -1)],
    };
    if (new Set(merged.v).size !== merged.v.length) continue;
    o.faces[f1i] = cloneFace(merged);
    o.faces.splice(f2i, 1);
    n++;
  }
  removeOrphans(o);
  clearSel(sel);
  return n;
}

// ---------- 反転・複製・ミラー ----------

export function flipFaces(o: MeshObj, sel: Selection): void {
  for (const fi of selFaces(o, sel)) {
    const f = o.faces[fi];
    f.v.reverse();
    f.uv.reverse();
    f.col.reverse();
  }
}

/** 選択面を複製（複製側が選択される）。動かすべき頂点を返す */
export function duplicateFaces(o: MeshObj, sel: Selection): number[] {
  const fs = selFaces(o, sel);
  if (fs.size === 0) return [];
  const dup = new Map<number, number>();
  const out: number[] = [];
  for (const fi of fs) {
    const f = cloneFace(o.faces[fi]);
    f.v = f.v.map((v) => {
      let n = dup.get(v);
      if (n === undefined) {
        n = pushVert(o, o.verts[v], v);
        dup.set(v, n);
      }
      return n;
    });
    o.faces.push(f);
    out.push(o.faces.length - 1);
  }
  clearSel(sel);
  sel.mode = 'face';
  for (const fi of out) sel.faces.add(fi);
  return [...dup.values()];
}

const MIRROR_NAME_PAIRS: [RegExp, string][] = [
  [/\.L$/, '.R'], [/\.R$/, '.L'], [/_L$/, '_R'], [/_R$/, '_L'], [/\.l$/, '.r'], [/\.r$/, '.l'], [/_l$/, '_r'], [/_r$/, '_l'],
  [/Left/, 'Right'], [/Right/, 'Left'], [/left/, 'right'], [/right/, 'left'], [/左/, '右'], [/右/, '左'],
];

export function mirrorBoneName(name: string): string | null {
  for (const [re, rep] of MIRROR_NAME_PAIRS) if (re.test(name)) return name.replace(re, rep);
  return null;
}

/** 選択面（なければ全体）をX軸で鏡像コピー。x≈0 の頂点は共有する */
export function mirrorX(doc: Doc, o: MeshObj, sel: Selection, eps = 1e-4): void {
  let fs = selFaces(o, sel);
  if (fs.size === 0) fs = new Set(o.faces.map((_, i) => i));
  const boneMap = doc.bones.map((b, i) => {
    const mn = mirrorBoneName(b.name);
    const j = mn ? doc.bones.findIndex((x) => x.name === mn) : -1;
    return j >= 0 ? j : i;
  });
  const dup = new Map<number, number>();
  const out: number[] = [];
  for (const fi of fs) {
    const f = cloneFace(o.faces[fi]);
    f.v = f.v.map((v) => {
      const p = o.verts[v];
      if (Math.abs(p[0]) <= eps) return v;
      let n = dup.get(v);
      if (n === undefined) {
        n = pushVert(o, [-p[0], p[1], p[2]], v);
        o.skin[n] = (o.skin[n] ?? []).map(([b, w]) => [boneMap[b] ?? b, w] as Influence);
        dup.set(v, n);
      }
      return n;
    });
    f.v.reverse();
    f.uv.reverse();
    f.col.reverse();
    if (new Set(f.v).size < 3) continue;
    o.faces.push(f);
    out.push(o.faces.length - 1);
  }
  clearSel(sel);
  sel.mode = 'face';
  for (const fi of out) sel.faces.add(fi);
}

/** X対称編集用: 頂点 → 鏡像位置にある頂点 */
export function mirrorPartners(o: MeshObj, eps = 1e-3): Map<number, number> {
  const grid = new Map<string, number[]>();
  const key = (p: V3) => `${Math.round(p[0] / eps / 4)},${Math.round(p[1] / eps / 4)},${Math.round(p[2] / eps / 4)}`;
  o.verts.forEach((p, i) => {
    const k = key(p);
    const l = grid.get(k);
    if (l) l.push(i);
    else grid.set(k, [i]);
  });
  const m = new Map<number, number>();
  o.verts.forEach((p, i) => {
    const q: V3 = [-p[0], p[1], p[2]];
    const c = [Math.round(q[0] / eps / 4), Math.round(q[1] / eps / 4), Math.round(q[2] / eps / 4)];
    let best = -1,
      bd = eps;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) {
            const d = dist(o.verts[j], q);
            if (d <= bd) {
              bd = d;
              best = j;
            }
          }
    if (best >= 0) m.set(i, best);
  });
  return m;
}

// ---------- 面を張る ----------

/** 並び順の決まった頂点列から面を作る */
export function createFace(o: MeshObj, sel: Selection, ordered: number[], col: V3 = [1, 1, 1]): void {
  if (ordered.length < 3) return;
  const n = ordered.length;
  const uv: V2[] =
    n === 4
      ? QUV.map((p) => [p[0], p[1]] as V2)
      : ordered.map((_, i) => [0.5 + Math.cos((i / n) * Math.PI * 2) * 0.5, 0.5 + Math.sin((i / n) * Math.PI * 2) * 0.5] as V2);
  o.faces.push({ v: [...ordered], uv, col: ordered.map(() => [...col] as V3) });
  clearSel(sel);
  sel.mode = 'face';
  sel.faces.add(o.faces.length - 1);
}

// ---------- 色 ----------

export function paintSelection(o: MeshObj, sel: Selection, col: V3): void {
  if (sel.mode === 'face') {
    for (const fi of sel.faces) {
      const f = o.faces[fi];
      if (f) f.col = f.v.map(() => [...col] as V3);
    }
  } else {
    const vs = selVerts(o, sel);
    for (const f of o.faces) f.v.forEach((v, i) => vs.has(v) && (f.col[i] = [...col] as V3));
  }
}

// ---------- 選択操作 ----------

export function selectAll(o: MeshObj, sel: Selection): void {
  clearSel(sel);
  if (sel.mode === 'vert') o.verts.forEach((_, i) => sel.verts.add(i));
  else if (sel.mode === 'edge') for (const k of edgeFaces(o).keys()) sel.edges.add(k);
  else o.faces.forEach((_, i) => sel.faces.add(i));
}

export function invertSelection(o: MeshObj, sel: Selection): void {
  if (sel.mode === 'vert') {
    const n = new Set<number>();
    o.verts.forEach((_, i) => !sel.verts.has(i) && n.add(i));
    sel.verts = n;
  } else if (sel.mode === 'edge') {
    const n = new Set<string>();
    for (const k of edgeFaces(o).keys()) !sel.edges.has(k) && n.add(k);
    sel.edges = n;
  } else {
    const n = new Set<number>();
    o.faces.forEach((_, i) => !sel.faces.has(i) && n.add(i));
    sel.faces = n;
  }
}

/** つながっている部分をすべて選択 */
export function selectLinked(o: MeshObj, sel: Selection): void {
  const seed = selVerts(o, sel);
  if (seed.size === 0) return;
  const adj = new Map<number, number[]>();
  for (const f of o.faces)
    for (const v of f.v) {
      const l = adj.get(v);
      if (l) l.push(...f.v);
      else adj.set(v, [...f.v]);
    }
  const seen = new Set(seed);
  const stack = [...seed];
  while (stack.length) {
    const v = stack.pop()!;
    for (const w of adj.get(v) ?? [])
      if (!seen.has(w)) {
        seen.add(w);
        stack.push(w);
      }
  }
  setSelectionFromVerts(o, sel, seen);
}

export function setSelectionFromVerts(o: MeshObj, sel: Selection, vs: Set<number>): void {
  clearSel(sel);
  if (sel.mode === 'vert') for (const v of vs) sel.verts.add(v);
  else if (sel.mode === 'edge') {
    for (const k of edgeFaces(o).keys()) {
      const [a, b] = parseEdge(k);
      if (vs.has(a) && vs.has(b)) sel.edges.add(k);
    }
  } else o.faces.forEach((f, i) => f.v.every((v) => vs.has(v)) && sel.faces.add(i));
}

/** 選択モードを切り替え、選択内容を引き継ぐ */
export function convertSelection(o: MeshObj, sel: Selection, mode: Selection['mode']): void {
  if (sel.mode === mode) return;
  const vs = selVerts(o, sel);
  sel.mode = mode;
  setSelectionFromVerts(o, sel, vs);
}

// ---------- オブジェクト単位 ----------

/** src を dst に統合する */
export function joinObjects(dst: MeshObj, src: MeshObj): void {
  while (dst.skin.length < dst.verts.length) dst.skin.push([]);
  const base = dst.verts.length;
  src.verts.forEach((p, i) => {
    dst.verts.push([...p] as V3);
    dst.skin.push(cloneInf(src.skin[i]));
  });
  for (const f of src.faces) {
    const nf = cloneFace(f);
    nf.v = nf.v.map((v) => v + base);
    dst.faces.push(nf);
  }
}

/** 選択面を新しいオブジェクトへ切り離す */
export function separateSelection(doc: Doc, o: MeshObj, sel: Selection): MeshObj | null {
  const fs = selFaces(o, sel);
  if (fs.size === 0 || fs.size === o.faces.length) return null;
  const n: MeshObj = {
    id: doc.nextId++,
    name: `${o.name}.分離`,
    verts: o.verts.map((p) => [...p] as V3),
    faces: [...fs].map((fi) => cloneFace(o.faces[fi])),
    skin: o.verts.map((_, i) => cloneInf(o.skin[i])),
    tex: o.tex,
    visible: true,
    doubleSided: o.doubleSided,
  };
  removeOrphans(n);
  o.faces = o.faces.filter((_, i) => !fs.has(i));
  removeOrphans(o);
  clearSel(sel);
  doc.objects.splice(doc.objects.indexOf(o) + 1, 0, n);
  return n;
}

export function translateVerts(o: MeshObj, vs: Iterable<number>, d: V3): void {
  for (const v of vs) o.verts[v] = add(o.verts[v], d);
}

export function snapVertsToGrid(o: MeshObj, vs: Iterable<number>, step: number): void {
  for (const v of vs) o.verts[v] = o.verts[v].map((x) => Math.round(x / step) * step) as V3;
}

// ---------- UV ----------

export type UvProjection = 'view' | 'x' | 'y' | 'z' | 'box' | 'reset';

/** 選択面のUVを投影で作り直す。right/up は 'view' のときの画面軸 */
export function projectUV(o: MeshObj, faces: Iterable<number>, kind: UvProjection, right: V3 = [1, 0, 0], up: V3 = [0, 1, 0]): void {
  const fl = [...faces].filter((i) => o.faces[i]);
  if (fl.length === 0) return;
  if (kind === 'reset') {
    for (const fi of fl) {
      const f = o.faces[fi];
      const n = f.v.length;
      f.uv = n === 4 ? QUV.map((p) => [p[0], p[1]] as V2) : n === 3 ? [[0, 1], [1, 1], [0.5, 0]] : f.v.map((_, i) => [0.5 + Math.cos((i / n) * Math.PI * 2) * 0.5, 0.5 - Math.sin((i / n) * Math.PI * 2) * 0.5] as V2);
    }
    return;
  }
  const axesFor = (fi: number): [V3, V3] => {
    if (kind === 'view') return [right, up];
    let k = kind;
    if (k === 'box') {
      const n = faceNormal(o, o.faces[fi]);
      const ax = Math.abs(n[0]),
        ay = Math.abs(n[1]),
        az = Math.abs(n[2]);
      k = ax >= ay && ax >= az ? 'x' : ay >= az ? 'y' : 'z';
      const s = k === 'x' ? Math.sign(n[0]) : k === 'y' ? Math.sign(n[1]) : Math.sign(n[2]);
      if (k === 'x') return [[0, 0, -s || -1], [0, 1, 0]];
      if (k === 'y') return [[1, 0, 0], [0, 0, -s || -1]];
      return [[s || 1, 0, 0], [0, 1, 0]];
    }
    if (k === 'x') return [[0, 0, -1], [0, 1, 0]];
    if (k === 'y') return [[1, 0, 0], [0, 0, -1]];
    return [[1, 0, 0], [0, 1, 0]];
  };
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  const raw: V2[][] = [];
  for (const fi of fl) {
    const [r, u] = axesFor(fi);
    const f = o.faces[fi];
    const uv = f.v.map((v) => {
      const p = o.verts[v];
      const x = p[0] * r[0] + p[1] * r[1] + p[2] * r[2];
      const y = p[0] * u[0] + p[1] * u[1] + p[2] * u[2];
      minU = Math.min(minU, x);
      maxU = Math.max(maxU, x);
      minV = Math.min(minV, y);
      maxV = Math.max(maxV, y);
      return [x, y] as V2;
    });
    raw.push(uv);
  }
  // 縦横比を保って 0..1 に収める
  const span = Math.max(maxU - minU, maxV - minV, 1e-9);
  const offU = (1 - (maxU - minU) / span) / 2,
    offV = (1 - (maxV - minV) / span) / 2;
  fl.forEach((fi, i) => {
    o.faces[fi].uv = raw[i].map(([x, y]) => [offU + (x - minU) / span, 1 - (offV + (y - minV) / span)] as V2);
  });
}

/** UVを変換する（選択面の全コーナー） */
export function transformUV(o: MeshObj, faces: Iterable<number>, fn: (p: V2) => V2): void {
  for (const fi of faces) {
    const f = o.faces[fi];
    if (f) f.uv = f.uv.map(fn);
  }
}

export function uvBounds(o: MeshObj, faces: Iterable<number>): { min: V2; max: V2 } | null {
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (const fi of faces) {
    const f = o.faces[fi];
    if (!f) continue;
    for (const p of f.uv) {
      minU = Math.min(minU, p[0]);
      maxU = Math.max(maxU, p[0]);
      minV = Math.min(minV, p[1]);
      maxV = Math.max(maxV, p[1]);
    }
  }
  if (!isFinite(minU)) return null;
  return { min: [minU, minV], max: [maxU, maxV] };
}

export { cloneFace, cross, mul, sub };
