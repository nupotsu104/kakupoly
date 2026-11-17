// ボーン階層・ポーズ評価・アニメーションのサンプリング
import type { Bone, Clip, Doc, Key, Quat, Track, V3, MeshObj } from './types';
import { M4, mCompose, mDecompose, mIdent, mInvert, mMul, mPoint, qSlerp, lerp, mPos, dist, sub, dot, add, mul } from './vec';

export interface Pose {
  pos: V3;
  rot: Quat;
  scl: V3;
}

export const restPose = (bones: Bone[]): Pose[] =>
  bones.map((b) => ({ pos: [...b.pos] as V3, rot: [...b.rot] as Quat, scl: [...b.scl] as V3 }));

/** ローカルポーズ配列からワールド行列を計算（親の番号が子より後ろでも可） */
export function worldMatrices(bones: Bone[], pose: Pose[]): M4[] {
  const out: (M4 | null)[] = bones.map(() => null);
  const get = (i: number, depth = 0): M4 => {
    const cached = out[i];
    if (cached) return cached;
    const local = mCompose(pose[i].pos, pose[i].rot, pose[i].scl);
    const p = bones[i].parent;
    const w = p >= 0 && p < bones.length && depth < 256 ? mMul(get(p, depth + 1), local) : local;
    out[i] = w;
    return w;
  };
  for (let i = 0; i < bones.length; i++) get(i);
  return out as M4[];
}

export const restWorld = (bones: Bone[]): M4[] => worldMatrices(bones, restPose(bones));

/** キー配列を frame でサンプリング */
export function sampleTrack(keys: Key[], f: number, interp: 'linear' | 'step'): Pose | null {
  if (keys.length === 0) return null;
  if (f <= keys[0].f) return { pos: keys[0].pos, rot: keys[0].rot, scl: keys[0].scl };
  const last = keys[keys.length - 1];
  if (f >= last.f) return { pos: last.pos, rot: last.rot, scl: last.scl };
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].f <= f) i++;
  const a = keys[i],
    b = keys[i + 1];
  if (interp === 'step' || b.f === a.f) return { pos: a.pos, rot: a.rot, scl: a.scl };
  const t = (f - a.f) / (b.f - a.f);
  return { pos: lerp(a.pos, b.pos, t), rot: qSlerp(a.rot, b.rot, t), scl: lerp(a.scl, b.scl, t) };
}

/** クリップを frame で評価したポーズ（キーのないボーンはレスト） */
export function samplePose(doc: Doc, clip: Clip | null, f: number): Pose[] {
  const pose = restPose(doc.bones);
  if (!clip) return pose;
  for (const tr of clip.tracks) {
    if (tr.bone < 0 || tr.bone >= pose.length) continue;
    const p = sampleTrack(tr.keys, f, clip.interp);
    if (p) pose[tr.bone] = { pos: [...p.pos] as V3, rot: [...p.rot] as Quat, scl: [...p.scl] as V3 };
  }
  return pose;
}

export function getTrack(clip: Clip, bone: number, create = false): Track | null {
  let t = clip.tracks.find((x) => x.bone === bone) ?? null;
  if (!t && create) {
    t = { bone, keys: [] };
    clip.tracks.push(t);
  }
  return t;
}

export function setKey(clip: Clip, bone: number, f: number, p: Pose): void {
  const t = getTrack(clip, bone, true)!;
  const k: Key = { f, pos: [...p.pos] as V3, rot: [...p.rot] as Quat, scl: [...p.scl] as V3 };
  const i = t.keys.findIndex((x) => x.f === f);
  if (i >= 0) t.keys[i] = k;
  else {
    t.keys.push(k);
    t.keys.sort((a, b) => a.f - b.f);
  }
}

export function deleteKey(clip: Clip, bone: number, f: number): boolean {
  const t = getTrack(clip, bone);
  if (!t) return false;
  const i = t.keys.findIndex((x) => x.f === f);
  if (i < 0) return false;
  t.keys.splice(i, 1);
  if (t.keys.length === 0) clip.tracks.splice(clip.tracks.indexOf(t), 1);
  return true;
}

export function newClip(doc: Doc, name?: string): Clip {
  const c: Clip = { name: name ?? `アニメ${doc.clips.length + 1}`, fps: 15, length: 30, interp: 'linear', loop: true, tracks: [] };
  doc.clips.push(c);
  return c;
}

// ---- ボーン編集 ----

export function addBone(doc: Doc, parent: number, worldPos: V3, name?: string): number {
  const rw = restWorld(doc.bones);
  const local = parent >= 0 ? mPoint(mInvert(rw[parent]), worldPos) : worldPos;
  doc.bones.push({
    name: name ?? uniqueBoneName(doc, 'bone'),
    parent,
    pos: [...local] as V3,
    rot: [0, 0, 0, 1],
    scl: [1, 1, 1],
  });
  return doc.bones.length - 1;
}

export function uniqueBoneName(doc: Doc, base: string): string {
  const names = new Set(doc.bones.map((b) => b.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) {
    const n = `${base}.${String(i).padStart(2, '0')}`;
    if (!names.has(n)) return n;
  }
}

/** ジョイントをワールド座標 p に動かす。keepChildren なら子のワールド位置は維持 */
export function moveBoneRest(doc: Doc, i: number, p: V3, keepChildren: boolean): void {
  const rw = restWorld(doc.bones);
  const b = doc.bones[i];
  const parentW = b.parent >= 0 ? rw[b.parent] : mIdent();
  const childWorld: [number, M4][] = [];
  if (keepChildren) doc.bones.forEach((c, ci) => c.parent === i && childWorld.push([ci, rw[ci]]));
  b.pos = mPoint(mInvert(parentW), p);
  if (keepChildren) {
    const newW = mMul(parentW, mCompose(b.pos, b.rot, b.scl));
    const inv = mInvert(newW);
    for (const [ci, w] of childWorld) {
      const d = mDecompose(mMul(inv, w));
      doc.bones[ci].pos = d.pos;
      doc.bones[ci].rot = d.rot;
      doc.bones[ci].scl = d.scl;
    }
  }
}

/** 親を付け替える（ワールド姿勢は維持）。循環するなら false */
export function reparentBone(doc: Doc, i: number, parent: number): boolean {
  if (parent === i) return false;
  for (let p = parent, n = 0; p >= 0 && n < 1024; p = doc.bones[p].parent, n++) if (p === i) return false;
  const rw = restWorld(doc.bones);
  const local = parent >= 0 ? mMul(mInvert(rw[parent]), rw[i]) : rw[i];
  const d = mDecompose(local);
  const b = doc.bones[i];
  b.parent = parent;
  b.pos = d.pos;
  b.rot = d.rot;
  b.scl = d.scl;
  // アニメのキーはローカル値なので付け替え後は意味が変わる。壊れたキーを残さないよう該当トラックを消す
  for (const c of doc.clips) c.tracks = c.tracks.filter((t) => t.bone !== i);
  return true;
}

/** ボーン削除。子は親へ付け替え、ウェイトは親ボーンへ移す（ルートなら外す） */
export function deleteBone(doc: Doc, i: number): void {
  const rw = restWorld(doc.bones);
  const b = doc.bones[i];
  const parent = b.parent;
  doc.bones.forEach((c, ci) => {
    if (c.parent !== i) return;
    const local = parent >= 0 ? mMul(mInvert(rw[parent]), rw[ci]) : rw[ci];
    const d = mDecompose(local);
    c.parent = parent;
    c.pos = d.pos;
    c.rot = d.rot;
    c.scl = d.scl;
  });
  doc.bones.splice(i, 1);
  const remap = (x: number) => (x === i ? parent : x > i ? x - 1 : x);
  const parentNew = parent > i ? parent - 1 : parent;
  for (const c of doc.bones) if (c.parent > i) c.parent--;
  for (const o of doc.objects) {
    o.skin = o.skin.map((inf) => {
      const m = new Map<number, number>();
      for (const [bi, w] of inf) {
        const nb = bi === i ? parentNew : remap(bi);
        if (nb < 0) continue;
        m.set(nb, (m.get(nb) ?? 0) + w);
      }
      return normalizeInfluences([...m.entries()]);
    });
  }
  for (const c of doc.clips) {
    c.tracks = c.tracks.filter((t) => t.bone !== i);
    for (const t of c.tracks) if (t.bone > i) t.bone--;
  }
}

export function normalizeInfluences(inf: [number, number][]): [number, number][] {
  let a = inf.filter((x) => x[1] > 1e-5).sort((x, y) => y[1] - x[1]).slice(0, 4);
  const s = a.reduce((t, x) => t + x[1], 0);
  if (s <= 0) return [];
  a = a.map(([b, w]) => [b, w / s] as [number, number]);
  return a;
}

/** 頂点 vi にボーン bone を重み w で割り当て、残りを (1-w) に正規化 */
export function assignWeight(o: MeshObj, vi: number, bone: number, w: number): void {
  while (o.skin.length < o.verts.length) o.skin.push([]);
  const others = (o.skin[vi] ?? []).filter((x) => x[0] !== bone);
  const so = others.reduce((t, x) => t + x[1], 0);
  const out: [number, number][] = [[bone, w]];
  if (w < 1 && so > 0) for (const [b, ow] of others) out.push([b, (ow / so) * (1 - w)]);
  o.skin[vi] = normalizeInfluences(out);
}

/** 点 p からボーン（ジョイント→各子、子がなければ点）までの最短距離 */
function boneDistance(p: V3, i: number, bones: Bone[], rw: M4[]): number {
  const a = mPos(rw[i]);
  let best = Infinity;
  let hasChild = false;
  bones.forEach((c, ci) => {
    if (c.parent !== i) return;
    hasChild = true;
    const b = mPos(rw[ci]);
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
    best = Math.min(best, dist(p, add(a, mul(ab, t))));
  });
  if (!hasChild) best = dist(p, a);
  return best;
}

/** 最も近いボーンに100%で割り当てる（PS1風の剛体スキニング） */
export function autoWeightsRigid(doc: Doc, o: MeshObj, onlyVerts?: Iterable<number>): void {
  if (doc.bones.length === 0) return;
  const rw = restWorld(doc.bones);
  while (o.skin.length < o.verts.length) o.skin.push([]);
  const list = onlyVerts ? [...onlyVerts] : o.verts.map((_, i) => i);
  for (const vi of list) {
    let best = 0,
      bd = Infinity;
    for (let b = 0; b < doc.bones.length; b++) {
      const d = boneDistance(o.verts[vi], b, doc.bones, rw);
      if (d < bd - 1e-9) {
        bd = d;
        best = b;
      }
    }
    o.skin[vi] = [[best, 1]];
  }
}

/** スキニング後の頂点位置（CPU）。ピッキングやOBJ出力用 */
export function skinnedPositions(doc: Doc, o: MeshObj, pose: Pose[]): V3[] {
  if (doc.bones.length === 0) return o.verts;
  const rw = restWorld(doc.bones);
  const pw = worldMatrices(doc.bones, pose);
  const mats = pw.map((m, i) => mMul(m, mInvert(rw[i])));
  return o.verts.map((v, vi) => {
    const inf = o.skin[vi];
    if (!inf || inf.length === 0) return v;
    const out: V3 = [0, 0, 0];
    for (const [b, w] of inf) {
      if (b < 0 || b >= mats.length) continue;
      const p = mPoint(mats[b], v);
      out[0] += p[0] * w;
      out[1] += p[1] * w;
      out[2] += p[2] * w;
    }
    return out;
  });
}
