// 操作の登録簿。ボタン・キーボード・TourBox・Apple Pencil のダブルタップ等はすべてここの id を呼ぶ。
import { state, notify, checkpoint, dropCheckpoint, undo, redo, activeObject, activeClip, currentPose, type Mode } from './state';
import * as ops from './core/mesh-ops';
import { hexToRgb, newMesh, newTexture } from './core/doc';
import { autoWeightsRigid, deleteBone, addBone, setKey, deleteKey, newClip, assignWeight, uniqueBoneName, restWorld } from './core/skeleton';
import { mirrorBoneName } from './core/mesh-ops';
import { nudge } from './view/transform';
import { mPos } from './core/vec';
import { mirrorBone, SYM_EPS, diagnoseSymmetry, centerX } from './core/symmetry';
import { joinObjects } from './core/mesh-ops';
import type { V3 } from './core/types';
import { toast } from './ui/dom';
import type { Viewport } from './view/viewport';

export interface Action {
  id: string;
  label: string;
  group: string;
  run: () => void;
  /** 押しっぱなしで効く操作（離したときに呼ぶ） */
  release?: () => void;
  /** キーリピートを許すか（ダイヤル回しで連続送信されるもの） */
  repeat?: boolean;
}

export const actions = new Map<string, Action>();
export const ctx = { vp: null as Viewport | null, held: new Set<string>(), lastTool: {} as Record<Mode, string> };

function def(id: string, group: string, label: string, run: () => void, extra: Partial<Action> = {}): void {
  actions.set(id, { id, group, label, run, ...extra });
}

export function runAction(id: string): void {
  const a = actions.get(id);
  if (!a) return;
  a.run();
}

/** メッシュ編集: 履歴を積んでから実行し、何も変わらなければ履歴を捨てる */
function meshOp(fn: (o: NonNullable<ReturnType<typeof activeObject>>) => boolean | void, needSel = true): void {
  if (state.mode !== 'model') setMode('model');
  const o = activeObject();
  if (!o) return toast('オブジェクトがありません');
  if (needSel && ops.selVerts(o, state.sel).size === 0) return toast('先に選択してください');
  checkpoint();
  const before = JSON.stringify([o.verts.length, o.faces.length]);
  const r = fn(o);
  if (r === false) {
    dropCheckpoint();
    return;
  }
  void before;
  notify('doc', 'sel', 'ui');
}

/** 押し出し等の後は、そのまま移動ツールに切り替えて引っぱれるようにする */
function thenMove(): void {
  setTool('move');
}

export function setMode(m: Mode): void {
  if (state.mode === m) return;
  if (state.mode === 'anim') state.poseOverride = null;
  state.mode = m;
  state.playing = false;
  if (m === 'rig' && state.activeBone < 0 && state.doc.bones.length) state.activeBone = 0;
  notify('mode', 'ui', 'pose');
}

export function setTool(t: string): void {
  const cur = state.tool[state.mode];
  if (cur !== t) ctx.lastTool[state.mode] = cur;
  state.tool[state.mode] = t;
  notify('ui', 'view');
}

function setSelMode(m: 'vert' | 'edge' | 'face'): void {
  const o = activeObject();
  if (o) ops.convertSelection(o, state.sel, m);
  else state.sel.mode = m;
  notify('sel', 'ui');
}

function cycle<T>(list: T[], cur: T, dir: number): T {
  const i = list.indexOf(cur);
  return list[(i + dir + list.length) % list.length];
}

export const TOOLS: Record<Mode, [string, string, string][]> = {
  // id, 表示名, 説明
  model: [
    ['select', '選択', 'タップで選択／ドラッグで範囲選択'],
    ['move', '移動', '矢印をドラッグ（中央の円は画面に平行に移動）'],
    ['rotate', '回転', 'リングをドラッグ'],
    ['scale', '拡縮', '四角をドラッグ（中央で全体）'],
    ['vpaint', '色塗り', '面（頂点モードでは頂点）に色を塗る'],
  ],
  texture: [
    ['pencil', 'ペン', '1ピクセル単位で描く（3Dモデル上にも直接描ける）'],
    ['eraser', '消しゴム', '透明にする'],
    ['fill', '塗りつぶし', '同じ色の領域を塗る'],
    ['picker', 'スポイト', '色を拾う'],
    ['line', '直線', 'ドラッグで直線'],
    ['rect', '矩形', 'ドラッグで四角'],
    ['uv', 'UV', 'テクスチャ画面で選択面のUVを動かす'],
  ],
  rig: [
    ['bone-add', 'ボーン追加', 'モデルをタップ→アクティブボーンの子としてジョイントを置く'],
    ['bone-move', 'ジョイント移動', 'ジョイントをタップで選択・ドラッグで移動'],
    ['weights', 'ウェイト', '頂点を選んで「割り当て」'],
  ],
  anim: [
    ['rotate', '回転', 'ボーンを選んでリングをドラッグ'],
    ['move', '移動', 'ボーンを選んで矢印をドラッグ'],
    ['scale', '拡縮', 'ボーンを選んで四角をドラッグ'],
  ],
};

const MODES: Mode[] = ['model', 'texture', 'rig', 'anim'];

// ---------------- 共通 ----------------
def('undo', '共通', '取り消し', () => (undo() ? notify('ui') : toast('これ以上取り消せません')), { repeat: true });
def('redo', '共通', 'やり直し', () => (redo() ? notify('ui') : toast('これ以上やり直せません')), { repeat: true });
for (const [i, m] of MODES.entries()) def(`mode-${m}`, '共通', ['モデリング', 'テクスチャ', 'リグ', 'アニメ'][i] + 'モード', () => setMode(m));
def('mode-next', '共通', '次のモード', () => setMode(cycle(MODES, state.mode, 1)));
def('tool-next', '共通', '次のツール', () => setTool(cycle(TOOLS[state.mode].map((t) => t[0]), state.tool[state.mode], 1)));
def('tool-prev', '共通', '前のツール', () => setTool(cycle(TOOLS[state.mode].map((t) => t[0]), state.tool[state.mode], -1)));
def('tool-last', '共通', '直前のツールに戻す', () => {
  const t = ctx.lastTool[state.mode];
  if (t) setTool(t);
});
def('tool-move', '共通', '移動ツール', () => setTool(state.mode === 'texture' ? 'uv' : 'move'));
def('tool-rotate', '共通', '回転ツール', () => setTool('rotate'));
def('tool-scale', '共通', '拡縮ツール', () => setTool('scale'));
def('tool-select', '共通', '選択ツール', () => setTool(state.mode === 'rig' ? 'bone-move' : 'select'));
for (const m of MODES) for (const [id, label] of TOOLS[m]) def(`tool-${m}-${id}`, 'ツール', `${label}（${{ model: 'モデル', texture: 'テクスチャ', rig: 'リグ', anim: 'アニメ' }[m]}）`, () => (setMode(m), setTool(id)));

// 軸と微調整（TourBoxのノブ・ダイヤル向け）
def('axis-x', '変形', 'X軸を使う', () => ((state.axis = 0), notify('ui', 'view')));
def('axis-y', '変形', 'Y軸を使う', () => ((state.axis = 1), notify('ui', 'view')));
def('axis-z', '変形', 'Z軸を使う', () => ((state.axis = 2), notify('ui', 'view')));
def('axis-next', '変形', '軸を切り替え X→Y→Z', () => ((state.axis = ((state.axis + 1) % 3) as 0 | 1 | 2), notify('ui', 'view')));
def('nudge-plus', '変形', '少し動かす ＋（ツールと軸に従う）', () => void nudge(1), { repeat: true });
def('nudge-minus', '変形', '少し動かす −', () => void nudge(-1), { repeat: true });
def('nudge-plus-fine', '変形', 'ごく少し動かす ＋', () => void nudge(1, true), { repeat: true });
def('nudge-minus-fine', '変形', 'ごく少し動かす −', () => void nudge(-1, true), { repeat: true });
def('snap-toggle', '変形', 'グリッド吸着 切替', () => {
  state.snap = !state.snap;
  toast(`グリッド吸着: ${state.snap ? 'オン' : 'オフ'}`);
  notify('ui');
});
def('symmetry-toggle', '変形', '左右対称モード 切替', () => {
  state.symmetryX = !state.symmetryX;
  symWarned.clear();
  toast(`左右対称モード: ${state.symmetryX ? 'オン' : 'オフ'}`);
  if (state.symmetryX && state.mode !== 'anim') setTimeout(() => warnSymmetry(true), 1200);
  notify('ui', 'view');
});

const symWarned = new Set<number>();
/** 左右対称が効かないモデルなら理由を知らせる（オブジェクトごとに1回） */
export function warnSymmetry(force = false): void {
  const o = activeObject();
  if (!o || !state.symmetryX || (!force && symWarned.has(o.id))) return;
  symWarned.add(o.id);
  const d = diagnoseSymmetry(state.doc, state.activeObj);
  if (d.message) toast(d.message, 7000);
}

def('join-all', 'モデリング', '全部を1つのオブジェクトに結合', () => {
  const objs = state.doc.objects;
  if (objs.length < 2) return toast('オブジェクトは1つだけです');
  const texs = new Set(objs.map((o) => o.tex));
  if (texs.size > 1 && !confirm('違うテクスチャを使うオブジェクトがあります。結合すると1つ目のテクスチャに統一されます。続けますか？')) return;
  checkpoint();
  const [first, ...rest] = objs;
  for (const o of rest) joinObjects(first, o);
  state.doc.objects = [first];
  state.activeObj = 0;
  state.sel.verts.clear();
  state.sel.edges.clear();
  state.sel.faces.clear();
  symWarned.clear();
  toast(`${rest.length + 1}個を1つにまとめました`);
  notify('doc', 'ui', 'sel');
});
def('center-x', 'モデリング', '全体を中心（X=0）に移動', () => {
  checkpoint();
  const dx = centerX(state.doc);
  if (Math.abs(dx) < 1e-9) {
    dropCheckpoint();
    return toast('すでに中心にあります');
  }
  symWarned.clear();
  toast('中心に移動しました');
  notify('doc', 'ui', 'pose');
});

// ---------------- 視点 ----------------
const vp = () => ctx.vp!;
def('view-front', '視点', '正面', () => vp().setView('front'));
def('view-back', '視点', '背面', () => vp().setView('back'));
def('view-right', '視点', '右', () => vp().setView('right'));
def('view-left', '視点', '左', () => vp().setView('left'));
def('view-top', '視点', '上', () => vp().setView('top'));
def('view-ortho', '視点', '平行投影 切替', () => ((state.view.ortho = !state.view.ortho), notify('view', 'ui')));
def('view-frame', '視点', '全体を表示', () => vp().frame());
def('view-frame-sel', '視点', '選択部分を表示', () => {
  const o = activeObject();
  const vs = o ? [...ops.selVerts(o, state.sel)].map((v) => o.verts[v]) : [];
  if (state.mode !== 'model' && state.activeBone >= 0) vs.push(mPos(restWorld(state.doc.bones)[state.activeBone]));
  vp().frame(vs.length ? vs : undefined);
});
def('orbit-left', '視点', '視点を左へ回す', () => vp().orbit(-20, 0), { repeat: true });
def('orbit-right', '視点', '視点を右へ回す', () => vp().orbit(20, 0), { repeat: true });
def('orbit-up', '視点', '視点を上へ回す', () => vp().orbit(0, 20), { repeat: true });
def('orbit-down', '視点', '視点を下へ回す', () => vp().orbit(0, -20), { repeat: true });
def('zoom-in', '視点', 'ズームイン', () => vp().zoom(0.9), { repeat: true });
def('zoom-out', '視点', 'ズームアウト', () => vp().zoom(1 / 0.9), { repeat: true });
for (const [id, label] of [
  ['hold-orbit', '押している間: ペンで視点回転'],
  ['hold-pan', '押している間: ペンで視点移動'],
  ['hold-zoom', '押している間: ペンでズーム'],
  ['hold-add', '押している間: 追加選択'],
  ['hold-sub', '押している間: 選択解除'],
  ['hold-picker', '押している間: スポイト'],
] as const)
  def(id, '押しっぱなし', label, () => (ctx.held.add(id), notify('ui')), { release: () => (ctx.held.delete(id), notify('ui')) });

// 表示
def('view-ps1', '表示', 'PS1表示（低解像度・ガタつき・ゆがみ）切替', () => {
  const on = !(state.view.jitter && state.view.affine && state.view.res > 0);
  Object.assign(state.view, on ? { jitter: true, affine: true, res: 240 } : { jitter: false, affine: false });
  toast(`PS1表示: ${on ? 'オン' : 'オフ'}`);
  notify('view', 'ui');
});
def('view-wire', '表示', 'ワイヤー表示 切替', () => ((state.view.wire = !state.view.wire), notify('view', 'ui')));
def('view-xray', '表示', '透視（裏の頂点も選ぶ）切替', () => ((state.view.xray = !state.view.xray), notify('view', 'ui')));

// ---------------- モデリング ----------------
def('sel-vert', '選択', '頂点モード', () => setSelMode('vert'));
def('sel-edge', '選択', '辺モード', () => setSelMode('edge'));
def('sel-face', '選択', '面モード', () => setSelMode('face'));
def('sel-cycle', '選択', '頂点/辺/面 切替', () => setSelMode(cycle(['vert', 'edge', 'face'] as const as unknown as ('vert' | 'edge' | 'face')[], state.sel.mode, 1)));
def('sel-all', '選択', 'すべて選択', () => {
  const o = activeObject();
  if (o) ops.selectAll(o, state.sel);
  notify('sel', 'ui');
});
def('sel-none', '選択', '選択解除', () => {
  state.sel.verts.clear();
  state.sel.edges.clear();
  state.sel.faces.clear();
  notify('sel', 'ui');
});
def('sel-invert', '選択', '選択を反転', () => {
  const o = activeObject();
  if (o) ops.invertSelection(o, state.sel);
  notify('sel', 'ui');
});
def('sel-linked-uv', '選択', 'UVの島を選択（UV上でつながっている面）', () => {
  const o = activeObject();
  if (!o) return;
  if (ops.selFaces(o, state.sel).size === 0) return toast('先に面を1つ選んでください');
  ops.selectLinkedUV(o, state.sel);
  notify('sel', 'ui');
});
def('sel-linked', '選択', 'つながっている部分を選択', () => {
  const o = activeObject();
  if (o) ops.selectLinked(o, state.sel);
  notify('sel', 'ui');
});

def('extrude', 'モデリング', '押し出し', () =>
  meshOp((o) => {
    const r = state.sel.mode === 'edge' ? ops.extrudeEdges(o, state.sel) : ops.extrudeFaces(o, state.sel);
    if (r.length === 0) return toast('面（または辺）を選んでください'), false;
    thenMove();
  }),
);
def('inset', 'モデリング', 'インセット（面の内側に面）', () =>
  meshOp((o) => {
    if (state.sel.mode !== 'face') return toast('面モードで使います'), false;
    ops.insetFaces(o, state.sel, 0.25);
    thenMove();
  }),
);
def('loopcut', 'モデリング', 'ループカット（選択辺の帯に辺を入れる）', () =>
  meshOp((o) => {
    if (!ops.loopCut(o, state.sel)) return toast('辺モードで四角形の辺を選んでください'), false;
  }),
);
def('subdivide', 'モデリング', '細分化', () => meshOp((o) => ops.subdivideFaces(o, state.sel)));
def('split-edge', 'モデリング', '辺を2分割', () =>
  meshOp((o) => {
    if (state.sel.mode !== 'edge') return toast('辺モードで使います'), false;
    ops.splitEdges(o, state.sel);
  }),
);
def('connect', 'モデリング', '2頂点を結んで面を割る', () =>
  meshOp((o) => {
    if (!ops.connectVerts(o, state.sel)) return toast('同じ面の上にある頂点を2つ選んでください'), false;
  }),
);
def('merge', 'モデリング', '頂点を中心で結合', () => meshOp((o) => ops.mergeAtCenter(o, state.sel)));
def('weld', 'モデリング', '重なった頂点を溶接', () =>
  meshOp((o) => {
    const vs = ops.selVerts(o, state.sel);
    const n = ops.weldByDistance(o, 1e-3, vs.size > 1 ? vs : undefined);
    toast(`${n}個の頂点を溶接しました`);
    if (n === 0) return false;
    state.sel.verts.clear();
    state.sel.edges.clear();
    state.sel.faces.clear();
  }, false),
);
def('delete', 'モデリング', '削除', () => meshOp((o) => ops.deleteSelection(o, state.sel)));
def('dissolve', 'モデリング', '辺を溶解（2面を1面に）', () =>
  meshOp((o) => {
    if (state.sel.mode !== 'edge') return toast('辺モードで使います'), false;
    const n = ops.dissolveEdges(o, state.sel);
    if (n === 0) return toast('溶解できる辺がありません'), false;
  }),
);
def('flip', 'モデリング', '面の向きを反転', () => meshOp((o) => ops.flipFaces(o, state.sel)));
def('triangulate', 'モデリング', '三角形に分割', () => meshOp((o) => ops.triangulate(o, state.sel)));
def('duplicate', 'モデリング', '複製', () =>
  meshOp((o) => {
    if (ops.duplicateFaces(o, state.sel).length === 0) return false;
    thenMove();
  }),
);
def('mirror-x', 'モデリング', 'X方向にミラーコピー', () => meshOp((o) => ops.mirrorX(state.doc, o, state.sel), false));
def('make-face', 'モデリング', '選択頂点で面を張る（選んだ順）', () =>
  meshOp((o) => {
    if (state.sel.mode !== 'vert' || state.sel.verts.size < 3) return toast('頂点モードで3〜4個を順に選んでください'), false;
    ops.createFace(o, state.sel, [...state.sel.verts], hexToRgb(state.color));
  }),
);
def('snap-grid', 'モデリング', '選択頂点をグリッドに吸着', () => meshOp((o) => ops.snapVertsToGrid(o, ops.selVerts(o, state.sel), state.gridStep)));
def('paint-sel', 'モデリング', '選択部分を現在色で塗る', () => meshOp((o) => ops.paintSelection(o, state.sel, hexToRgb(state.color))));
def('separate', 'モデリング', '選択面を別オブジェクトに分離', () =>
  meshOp((o) => {
    const n = ops.separateSelection(state.doc, o, state.sel);
    if (!n) return toast('一部の面を選んでください'), false;
    state.activeObj = state.doc.objects.indexOf(n);
  }),
);
for (const [k, label] of [
  ['cube', '立方体'],
  ['plane', '板'],
  ['cylinder', '円柱'],
  ['cone', '円すい'],
  ['sphere', '球'],
] as const)
  def(`add-${k}`, '追加', `${label}を追加`, () => {
    if (state.mode !== 'model') setMode('model');
    checkpoint();
    let o = activeObject();
    if (!o) {
      o = newMesh(state.doc, 'mesh');
      state.activeObj = state.doc.objects.length - 1;
    }
    const v = ctx.vp;
    const center: V3 = v ? [...v.cam.target] : [0, 0.5, 0];
    if (state.snap) for (let i = 0; i < 3; i++) center[i] = Math.round(center[i] / state.gridStep) * state.gridStep;
    // 左右対称モードでは体の中心（X=0）に置く。視点の中心がずれていても左右対称に編集できるように
    const moved = state.symmetryX && Math.abs(center[0]) > 1e-6;
    if (state.symmetryX) center[0] = 0;
    ops.addPrimitive(o, state.sel, k, { size: 0.5, sides: k === 'sphere' ? 8 : 6, center, color: [1, 1, 1] });
    if (moved) toast('左右対称モードなので、中心（X=0）に追加しました');
    notify('doc', 'sel', 'ui');
  });

// ---------------- テクスチャ ----------------
def('brush-bigger', 'テクスチャ', 'ブラシを大きく', () => ((state.brushSize = Math.min(16, state.brushSize + 1)), notify('ui')), { repeat: true });
def('brush-smaller', 'テクスチャ', 'ブラシを小さく', () => ((state.brushSize = Math.max(1, state.brushSize - 1)), notify('ui')), { repeat: true });
def('color-next', 'テクスチャ', 'パレットの次の色', () => shiftColor(1), { repeat: true });
def('color-prev', 'テクスチャ', 'パレットの前の色', () => shiftColor(-1), { repeat: true });
def('swap-eraser', 'テクスチャ', 'ペン⇔消しゴム', () => setTool(state.tool.texture === 'eraser' ? 'pencil' : 'eraser'));
def('new-texture', 'テクスチャ', 'テクスチャを新規作成（64×64）', () => {
  checkpoint();
  newTexture(state.doc, `tex${state.doc.textures.length + 1}`, 64, 64);
  state.activeTex = state.doc.textures.length - 1;
  const o = activeObject();
  if (o && o.tex < 0) o.tex = state.activeTex;
  notify('doc', 'tex', 'ui');
});
function shiftColor(d: number): void {
  const p = state.doc.palette;
  const i = p.indexOf(state.color.toLowerCase());
  state.color = p[(i + d + p.length) % p.length] ?? p[0];
  notify('ui');
}
for (const [k, label] of [
  ['view', '画面から'],
  ['box', '箱型'],
  ['x', 'X方向'],
  ['y', 'Y方向'],
  ['z', 'Z方向'],
  ['reset', '各面いっぱい'],
] as const)
  def(`uv-${k}`, 'UV', `UV展開: ${label}`, () =>
    meshOp((o) => {
      const fs = ops.selFaces(o, state.sel);
      const list = fs.size ? fs : new Set(o.faces.map((_, i) => i));
      const b = ctx.vp?.basis();
      ops.projectUV(o, list, k, b?.right, b?.up);
    }, false),
  );

// ---------------- リグ ----------------
def('bone-delete', 'リグ', 'ボーン削除', () => {
  if (state.activeBone < 0) return toast('ボーンを選んでください');
  checkpoint();
  const p = state.doc.bones[state.activeBone].parent;
  deleteBone(state.doc, state.activeBone);
  state.activeBone = p > state.activeBone ? p - 1 : p;
  notify('doc', 'ui', 'pose');
});
def('bone-parent', 'リグ', 'ボーンの親を選択', () => {
  if (state.activeBone >= 0) state.activeBone = state.doc.bones[state.activeBone].parent;
  notify('ui', 'view');
});
def('bone-child', 'リグ', 'ボーンの子を選択', () => {
  const c = state.doc.bones.findIndex((b) => b.parent === state.activeBone);
  if (c >= 0) state.activeBone = c;
  notify('ui', 'view');
});
def('bone-next', 'リグ', '次のボーン', () => {
  const n = state.doc.bones.length;
  if (n) state.activeBone = (state.activeBone + 1) % n;
  notify('ui', 'view');
}, { repeat: true });
def('bone-prev', 'リグ', '前のボーン', () => {
  const n = state.doc.bones.length;
  if (n) state.activeBone = (state.activeBone - 1 + n) % n;
  notify('ui', 'view');
}, { repeat: true });
def('bone-root', 'リグ', 'ルートボーンを追加（原点）', () => {
  checkpoint();
  state.activeBone = addBone(state.doc, -1, [0, 0, 0], uniqueBoneName(state.doc, 'root'));
  notify('doc', 'ui', 'pose');
});
def('bone-mirror', 'リグ', '左右反対側のボーンを作る（.L/.R）', () => {
  const doc = state.doc;
  checkpoint();
  let made = 0;
  const rw = restWorld(doc.bones);
  const n = doc.bones.length;
  for (let i = 0; i < n; i++) {
    const mn = mirrorBoneName(doc.bones[i].name);
    if (!mn || doc.bones.some((b) => b.name === mn)) continue;
    const pn = doc.bones[i].parent >= 0 ? doc.bones[doc.bones[i].parent].name : null;
    const mpn = pn ? (mirrorBoneName(pn) ?? pn) : null;
    const parent = mpn ? doc.bones.findIndex((b) => b.name === mpn) : -1;
    const p = mPos(rw[i]);
    addBone(doc, parent, [-p[0], p[1], p[2]], mn);
    made++;
  }
  if (!made) {
    dropCheckpoint();
    return toast('名前が .L / .R / Left / Right / 左 / 右 で終わるボーンが対象です');
  }
  toast(`${made}本作りました`);
  notify('doc', 'ui', 'pose');
});
def('weights-auto', 'リグ', '自動ウェイト（最寄りボーンに100%）', () => {
  const o = activeObject();
  if (!o || !state.doc.bones.length) return toast('オブジェクトとボーンが必要です');
  checkpoint();
  const vs = ops.selVerts(o, state.sel);
  autoWeightsRigid(state.doc, o, state.tool.rig === 'weights' && vs.size ? vs : undefined);
  notify('doc', 'ui');
  toast(vs.size && state.tool.rig === 'weights' ? '選択頂点に自動ウェイト' : '全頂点に自動ウェイト');
});
def('weights-assign', 'リグ', '選択頂点をアクティブボーンに割り当て（100%）', () => {
  const o = activeObject();
  if (!o || state.activeBone < 0) return toast('ボーンを選んでください');
  const vs = ops.selVerts(o, state.sel);
  if (!vs.size) return toast('頂点を選んでください');
  checkpoint();
  // 左右対称モードでは、ボーンと反対側にある頂点は反対側のボーン（.L ⇔ .R）へ
  const mb = state.symmetryX ? mirrorBone(state.doc, state.activeBone) : -1;
  const bx = mPos(restWorld(state.doc.bones)[state.activeBone])[0];
  for (const v of vs) {
    const vx = o.verts[v][0];
    const opposite = mb >= 0 && Math.abs(vx) > SYM_EPS && Math.sign(vx) === -Math.sign(bx);
    assignWeight(o, v, opposite ? mb : state.activeBone, 1);
  }
  notify('doc', 'ui');
});
def('weights-view', 'リグ', 'ウェイト色表示 切替', () => ((state.view.weights = !state.view.weights), notify('view', 'ui')));

// ---------------- アニメ ----------------
const clipLen = () => activeClip()?.length ?? 30;
export function setFrame(f: number): void {
  const len = clipLen();
  state.frame = Math.max(0, Math.min(len, Math.round(f)));
  state.poseOverride = null;
  notify('frame', 'pose');
}
def('frame-next', 'アニメ', '次のフレーム', () => setFrame(state.frame + 1 > clipLen() ? 0 : state.frame + 1), { repeat: true });
def('frame-prev', 'アニメ', '前のフレーム', () => setFrame(state.frame - 1 < 0 ? clipLen() : state.frame - 1), { repeat: true });
def('frame-start', 'アニメ', '最初のフレーム', () => setFrame(0));
def('frame-end', 'アニメ', '最後のフレーム', () => setFrame(clipLen()));
function keyFrames(): number[] {
  const c = activeClip();
  if (!c) return [];
  const s = new Set<number>();
  for (const t of c.tracks) for (const k of t.keys) s.add(k.f);
  return [...s].sort((a, b) => a - b);
}
def('key-next', 'アニメ', '次のキーへ', () => {
  const k = keyFrames().find((f) => f > state.frame);
  if (k !== undefined) setFrame(k);
});
def('key-prev', 'アニメ', '前のキーへ', () => {
  const k = keyFrames().reverse().find((f) => f < state.frame);
  if (k !== undefined) setFrame(k);
});
def('play', 'アニメ', '再生／停止', () => {
  if (state.mode !== 'anim') setMode('anim');
  state.playing = !state.playing;
  state.poseOverride = null;
  notify('ui', 'frame');
});
function ensureClip() {
  let c = activeClip();
  if (!c) {
    c = newClip(state.doc);
    state.clip = state.doc.clips.length - 1;
  }
  return c;
}
def('key-insert', 'アニメ', 'キーを打つ（選択ボーン）', () => {
  if (state.mode !== 'anim') setMode('anim');
  if (state.activeBone < 0) return toast('ボーンを選んでください');
  checkpoint();
  const pose = currentPose();
  setKey(ensureClip(), state.activeBone, state.frame, pose[state.activeBone]);
  state.poseOverride = null;
  notify('doc', 'ui', 'pose');
});
def('key-insert-all', 'アニメ', 'キーを打つ（全ボーン）', () => {
  if (state.mode !== 'anim') setMode('anim');
  if (!state.doc.bones.length) return;
  checkpoint();
  const pose = currentPose();
  const c = ensureClip();
  pose.forEach((p, i) => setKey(c, i, state.frame, p));
  state.poseOverride = null;
  notify('doc', 'ui', 'pose');
});
def('key-delete', 'アニメ', 'キーを消す（選択ボーン・現在フレーム）', () => {
  const c = activeClip();
  if (!c || state.activeBone < 0) return;
  checkpoint();
  if (!deleteKey(c, state.activeBone, state.frame)) {
    dropCheckpoint();
    return toast('このフレームにキーはありません');
  }
  notify('doc', 'ui', 'pose');
});
let copiedPose: ReturnType<typeof currentPose> | null = null;
def('pose-copy', 'アニメ', 'ポーズをコピー', () => {
  copiedPose = structuredClone(currentPose());
  toast('ポーズをコピーしました');
});
def('pose-paste', 'アニメ', 'ポーズを貼り付け（全ボーンにキー）', () => {
  if (!copiedPose || copiedPose.length !== state.doc.bones.length) return toast('コピーしたポーズがありません');
  checkpoint();
  const c = ensureClip();
  copiedPose.forEach((p, i) => setKey(c, i, state.frame, p));
  notify('doc', 'ui', 'pose');
});
def('pose-paste-mirror', 'アニメ', 'ポーズを左右反転して貼り付け', () => {
  if (!copiedPose || copiedPose.length !== state.doc.bones.length) return toast('コピーしたポーズがありません');
  checkpoint();
  const c = ensureClip();
  const bones = state.doc.bones;
  bones.forEach((b, i) => {
    const mn = mirrorBoneName(b.name);
    const j = mn ? bones.findIndex((x) => x.name === mn) : i;
    const src = copiedPose![j >= 0 ? j : i];
    // X軸ミラー: 位置xを反転、回転は (x, -y, -z, w)
    setKey(c, i, state.frame, { pos: [-src.pos[0], src.pos[1], src.pos[2]], rot: [src.rot[0], -src.rot[1], -src.rot[2], src.rot[3]], scl: src.scl });
  });
  notify('doc', 'ui', 'pose');
});
def('pose-reset', 'アニメ', '選択ボーンを初期姿勢に（キー）', () => {
  if (state.activeBone < 0) return;
  checkpoint();
  const b = state.doc.bones[state.activeBone];
  setKey(ensureClip(), state.activeBone, state.frame, { pos: b.pos, rot: b.rot, scl: b.scl });
  notify('doc', 'ui', 'pose');
});
