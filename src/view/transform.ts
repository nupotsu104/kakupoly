// 変形セッション: 「いま選んでいるもの」（頂点 / レストのボーン / ポーズ中のボーン）に
// 移動・回転・拡縮を適用する共通の窓口。ギズモ操作とキー操作（TourBoxのダイヤル等）の両方から使う。
import type { Quat, V3 } from '../core/types';
import { state, activeObject, activeClip, currentPose, checkpoint, dropCheckpoint, notify } from '../state';
import { selVerts } from '../core/mesh-ops';
import { symmetricMover, mirrorBone, mirrorV, SYM_EPS } from '../core/symmetry';
import { moveBoneRest, restWorld, worldMatrices, setKey, newClip } from '../core/skeleton';
import { add, centroid, dot, mDecompose, mIdent, mInvert, mPoint, mPos, mul, qConj, qFromAxisAngle, qMul, qNorm, qRotate, sub, mDir, norm } from '../core/vec';

export type Axes = [V3, V3, V3];
const WORLD: Axes = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export interface Session {
  pivot: V3;
  axes: Axes;
  /** 使える操作 */
  can: { move: boolean; rotate: boolean; scale: boolean };
  translate(d: V3): void;
  rotate(axis: V3, angle: number): void;
  /** axes に沿った倍率 */
  scale(f: V3): void;
  /** 確定。ドキュメントが実際に変わったら true（呼び出し側が checkpoint を残すか決める） */
  end(changed: boolean): boolean;
}

const snapV = (d: V3): V3 => (state.snap ? (d.map((x) => Math.round(x / state.gridStep) * state.gridStep) as V3) : d);
const snapA = (a: number): number => (state.snap ? Math.round(a / (Math.PI / 12)) * (Math.PI / 12) : a);

/** 現在のモード・選択から変形対象を決める。対象がなければ null */
export function targetInfo(): { pivot: V3; axes: Axes; can: Session['can'] } | null {
  if (state.mode === 'model') {
    const o = activeObject();
    if (!o) return null;
    const vs = selVerts(o, state.sel);
    if (vs.size === 0) return null;
    return { pivot: centroid([...vs].map((v) => o.verts[v])), axes: WORLD, can: { move: true, rotate: true, scale: true } };
  }
  const bi = state.activeBone;
  if (bi < 0 || bi >= state.doc.bones.length) return null;
  if (state.mode === 'rig') {
    if (state.tool.rig === 'weights') return null;
    return { pivot: mPos(restWorld(state.doc.bones)[bi]), axes: WORLD, can: { move: true, rotate: false, scale: false } };
  }
  if (state.mode === 'anim') {
    const w = worldMatrices(state.doc.bones, currentPose())[bi];
    let axes = WORLD;
    if (state.localAxes) axes = [norm(mDir(w, [1, 0, 0])), norm(mDir(w, [0, 1, 0])), norm(mDir(w, [0, 0, 1]))];
    return { pivot: mPos(w), axes, can: { move: true, rotate: true, scale: true } };
  }
  return null;
}

export function beginSession(): Session | null {
  const info = targetInfo();
  if (!info) return null;
  if (state.mode === 'model') return meshSession(info);
  if (state.mode === 'rig') return rigSession(info);
  return poseSession(info);
}

function meshSession(info: { pivot: V3; axes: Axes; can: Session['can'] }): Session {
  const o = activeObject()!;
  const vs = [...selVerts(o, state.sel)];
  const orig = new Map<number, V3>(vs.map((v) => [v, [...o.verts[v]] as V3]));
  const mover = state.symmetryX ? symmetricMover(o, vs, state.doc.objects.filter((x) => x.visible && x !== o)) : null;
  const apply = (fn: (p: V3) => V3) => {
    if (mover) mover(fn);
    else for (const v of vs) o.verts[v] = fn(orig.get(v)!);
    notify('doc');
  };
  const { pivot, axes } = info;
  return {
    ...info,
    translate: (d) => {
      const dd = snapV(d);
      apply((p) => add(p, dd));
    },
    rotate: (axis, angle) => {
      const q = qFromAxisAngle(axis, snapA(angle));
      apply((p) => add(pivot, qRotate(q, sub(p, pivot))));
    },
    scale: (f) =>
      apply((p) => {
        const r = sub(p, pivot);
        let out = pivot;
        for (let k = 0; k < 3; k++) out = add(out, mul(axes[k], dot(r, axes[k]) * f[k]));
        return out;
      }),
    end: (changed) => {
      notify('doc', 'ui');
      return changed;
    },
  };
}

function rigSession(info: { pivot: V3; axes: Axes; can: Session['can'] }): Session {
  const bi = state.activeBone;
  const p0 = info.pivot;
  // ドラッグ中は毎回「開始時の骨格」から計算し直す
  const snapshot = structuredClone(state.doc.bones);
  // 左右対称: 反対側のボーンも鏡写しで動かす。中心のボーンは中心から離さない
  const partner = state.symmetryX ? mirrorBone(state.doc, bi) : -1;
  const centered = state.symmetryX && partner < 0 && Math.abs(p0[0]) < SYM_EPS * 10;
  return {
    ...info,
    translate: (d) => {
      state.doc.bones = structuredClone(snapshot);
      let p = add(p0, snapV(d));
      if (centered) p = [0, p[1], p[2]];
      moveBoneRest(state.doc, bi, p, state.keepChildren);
      if (partner >= 0 && partner !== bi) moveBoneRest(state.doc, partner, mirrorV(p), state.keepChildren);
      notify('doc');
    },
    rotate: () => {},
    scale: () => {},
    end: (changed) => {
      notify('doc', 'ui');
      return changed;
    },
  };
}

function poseSession(info: { pivot: V3; axes: Axes; can: Session['can'] }): Session {
  const bi = state.activeBone;
  const bones = state.doc.bones;
  const pose0 = currentPose().map((p) => ({ pos: [...p.pos] as V3, rot: [...p.rot] as Quat, scl: [...p.scl] as V3 }));
  const world0 = worldMatrices(bones, pose0);
  const parent = bones[bi].parent;
  const parentW = parent >= 0 ? world0[parent] : mIdent();
  const parentInv = mInvert(parentW);
  const parentRot = mDecompose(parentW).rot;
  const worldRot0 = qNorm(qMul(parentRot, pose0[bi].rot));
  const set = (fn: (p: (typeof pose0)[number]) => void) => {
    const pose = pose0.map((p) => ({ pos: [...p.pos] as V3, rot: [...p.rot] as Quat, scl: [...p.scl] as V3 }));
    fn(pose[bi]);
    state.poseOverride = pose;
    notify('pose');
  };
  return {
    ...info,
    translate: (d) => set((p) => (p.pos = mPoint(parentInv, add(info.pivot, snapV(d))))),
    rotate: (axis, angle) =>
      set((p) => {
        const q = qFromAxisAngle(axis, snapA(angle));
        p.rot = qNorm(qMul(qConj(parentRot), qMul(q, worldRot0)));
      }),
    scale: (f) => set((p) => (p.scl = [pose0[bi].scl[0] * f[0], pose0[bi].scl[1] * f[1], pose0[bi].scl[2] * f[2]])),
    end: (changed) => {
      if (!changed) return false;
      if (state.autoKey && state.poseOverride) {
        let clip = activeClip();
        if (!clip) {
          clip = newClip(state.doc);
          state.clip = state.doc.clips.length - 1;
        }
        setKey(clip, bi, Math.round(state.frame), state.poseOverride[bi]);
        state.poseOverride = null;
        notify('doc', 'pose', 'ui');
        return true;
      }
      notify('pose', 'ui');
      return false;
    },
  };
}

/** checkpoint → セッション開始。対象がなければ null */
export function beginUndoableSession(): Session | null {
  if (!targetInfo()) return null;
  checkpoint();
  const s = beginSession();
  if (!s) dropCheckpoint();
  return s;
}

/** セッションを閉じ、変更がなければ checkpoint を捨てる */
export function endUndoableSession(s: Session, changed: boolean): void {
  if (!s.end(changed)) dropCheckpoint();
}

let lastNudge = { time: 0, key: '' };

/** キー操作用: 現在のツールとアクティブ軸で1ステップ動かす。連続操作（ダイヤル回し）は1回の取り消しにまとめる */
export function nudge(dir: 1 | -1, fine = false): boolean {
  const tool = state.tool[state.mode];
  if (!targetInfo()) return false;
  const key = `${state.mode}/${tool}/${state.axis}/${state.activeObj}/${state.activeBone}/${state.frame}`;
  const now = performance.now();
  const coalesce = key === lastNudge.key && now - lastNudge.time < 800;
  if (!coalesce) checkpoint();
  const s = beginSession();
  if (!s) {
    if (!coalesce) dropCheckpoint();
    return false;
  }
  const ax = s.axes[state.axis];
  const saveSnap = state.snap;
  state.snap = false;
  let ok = true;
  if (tool === 'rotate' && s.can.rotate) s.rotate(ax, dir * (fine ? Math.PI / 180 : Math.PI / 36));
  else if (tool === 'scale' && s.can.scale) {
    const f: V3 = [1, 1, 1];
    f[state.axis] = dir > 0 ? (fine ? 1.01 : 1.05) : fine ? 1 / 1.01 : 1 / 1.05;
    s.scale(f);
  } else if (s.can.move) s.translate(mul(ax, dir * state.gridStep * (fine ? 0.2 : 1)));
  else ok = false;
  state.snap = saveSnap;
  const changed = s.end(ok);
  if (!changed && !coalesce) dropCheckpoint();
  lastNudge = changed ? { time: now, key } : { time: 0, key: '' };
  return ok;
}
