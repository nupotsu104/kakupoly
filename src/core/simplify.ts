// ポリゴン削減（meshoptimizer の簡略化を使う）。
// 残る頂点は元の頂点の一部なので、ボーンの割り当て（ウェイト）はそのまま保たれる。
// UV と頂点カラーも「属性」として渡し、継ぎ目や色の境目がなるべく崩れないようにする。
import { MeshoptSimplifier } from 'three/addons/libs/meshopt_simplifier.module.js';
import type { Doc, MeshObj, V2, V3 } from './types';
import { removeOrphans } from './mesh-ops';
import { trisToQuads } from './cleanup';

export const triCount = (o: MeshObj): number => o.faces.reduce((t, f) => t + Math.max(0, f.v.length - 2), 0);

/** 1つのオブジェクトを targetTris 三角形くらいまで減らす。減らした後の三角形数を返す */
export async function simplifyObject(o: MeshObj, targetTris: number): Promise<number> {
  const before = triCount(o);
  if (before <= targetTris || before < 8) return before;
  await MeshoptSimplifier.ready;

  // 角（コーナー）ごとに「位置・UV・色」が同じものを1つの頂点にまとめる
  const key = new Map<string, number>();
  const splitVi: number[] = [];
  const pos: number[] = [];
  const attr: number[] = [];
  const uvs: V2[] = [];
  const cols: V3[] = [];
  const index: number[] = [];
  const corner = (vi: number, uv: V2, col: V3): number => {
    const k = `${vi}|${uv[0]},${uv[1]}|${col[0]},${col[1]},${col[2]}`;
    let id = key.get(k);
    if (id === undefined) {
      id = splitVi.length;
      key.set(k, id);
      splitVi.push(vi);
      const p = o.verts[vi];
      pos.push(p[0], p[1], p[2]);
      attr.push(uv[0], uv[1], col[0], col[1], col[2]);
      uvs.push([uv[0], uv[1]]);
      cols.push([col[0], col[1], col[2]]);
    }
    return id;
  };
  for (const f of o.faces)
    for (let k = 1; k < f.v.length - 1; k++) index.push(corner(f.v[0], f.uv[0], f.col[0]), corner(f.v[k], f.uv[k], f.col[k]), corner(f.v[k + 1], f.uv[k + 1], f.col[k + 1]));

  const positions = new Float32Array(pos);
  const attributes = new Float32Array(attr);
  const indices = new Uint32Array(index);
  const target = Math.max(3, Math.floor(targetTris) * 3);
  // 同じ位置で UV が違う頂点（継ぎ目）は、そのままだと動かせず削れないことがある。足りなければ継ぎ目も崩してよい設定でやり直す
  let [out] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes, 5, [0.5, 0.5, 0.2, 0.2, 0.2], null, target, 1, []);
  if (out.length > target * 1.3) [out] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attributes, 5, [0.5, 0.5, 0.2, 0.2, 0.2], null, target, 1, ['Permissive']);

  const faces: MeshObj['faces'] = [];
  for (let i = 0; i < out.length; i += 3) {
    const ids = [out[i], out[i + 1], out[i + 2]];
    const v = ids.map((id) => splitVi[id]);
    if (new Set(v).size < 3) continue;
    faces.push({ v, uv: ids.map((id) => [...uvs[id]] as V2), col: ids.map((id) => [...cols[id]] as V3) });
  }
  o.faces = faces;
  removeOrphans(o);
  trisToQuads(o, 8);
  return triCount(o);
}

/**
 * 作品全体を合計 targetTris 三角形くらいまで減らす。各オブジェクトの持ち分は今の三角形数に比例させる
 * （小さい部品が消えないよう最低 12 三角形は残す）。
 */
export async function simplifyDoc(doc: Doc, targetTris: number, only?: number[]): Promise<{ before: number; after: number }> {
  const list = (only ?? doc.objects.map((_, i) => i)).map((i) => doc.objects[i]).filter(Boolean);
  const before = list.reduce((t, o) => t + triCount(o), 0);
  if (before <= targetTris) return { before, after: before };
  let after = 0;
  for (const o of list) {
    const share = Math.max(12, Math.round((targetTris * triCount(o)) / before));
    after += await simplifyObject(o, share);
  }
  return { before, after };
}
