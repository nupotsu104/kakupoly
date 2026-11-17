// アプリ全体の状態・変更通知・取り消し履歴
import type { Doc, MeshObj, Selection, Texture, Clip } from './core/types';
import { emptySelection } from './core/doc';
import { sampleDoc } from './core/sample';
import type { Pose } from './core/skeleton';
import { samplePose, restPose } from './core/skeleton';

export type Mode = 'model' | 'texture' | 'rig' | 'anim';
export type Change = 'doc' | 'sel' | 'tex' | 'pose' | 'ui' | 'view' | 'mode' | 'frame';

export interface ViewSettings {
  /** 縦解像度。0 = 端末の解像度そのまま */
  res: number;
  jitter: boolean;
  affine: boolean;
  dither: boolean;
  shade: 'none' | 'flat' | 'smooth';
  wire: boolean;
  grid: boolean;
  ortho: boolean;
  bones: boolean;
  xray: boolean;
  weights: boolean;
  bg: string;
}

export const state = {
  doc: sampleDoc() as Doc,
  mode: 'model' as Mode,
  tool: { model: 'select', texture: 'pencil', rig: 'bone-move', anim: 'rotate' } as Record<Mode, string>,
  sel: emptySelection('face') as Selection,
  activeObj: 0,
  activeBone: -1,
  clip: 0,
  frame: 0,
  playing: false,
  autoKey: true,
  /** アニメモードで編集中の一時ポーズ（キー未挿入の変更を保持） */
  poseOverride: null as Pose[] | null,
  color: '#f83800',
  brushSize: 1,
  gridStep: 0.05,
  snap: false,
  symmetryX: false,
  axis: 1 as 0 | 1 | 2,
  localAxes: true,
  keepChildren: true,
  /** 選択の仕方: 置き換え / 追加 / 解除 */
  selOp: 'set' as 'set' | 'add' | 'sub',
  activeTex: 0,
  uvSnap: true,
  showUV: true,
  rectFill: true,
  view: {
    res: 240,
    jitter: false,
    affine: false,
    dither: true,
    shade: 'flat',
    wire: true,
    grid: true,
    ortho: false,
    bones: true,
    xray: false,
    weights: false,
    bg: '#3a3f58',
  } as ViewSettings,
};

export type State = typeof state;

type Listener = (changes: Set<Change>) => void;
const listeners: Listener[] = [];
export const subscribe = (fn: Listener): void => void listeners.push(fn);
export function notify(...changes: Change[]): void {
  const s = new Set(changes);
  for (const l of listeners) l(s);
}

export const activeObject = (): MeshObj | null => state.doc.objects[state.activeObj] ?? null;
export const activeTexture = (): Texture | null => state.doc.textures[state.activeTex] ?? null;
export const activeClip = (): Clip | null => state.doc.clips[state.clip] ?? null;

/** いま画面に出すべきポーズ */
export function currentPose(): Pose[] {
  if (state.mode !== 'anim') return restPose(state.doc.bones);
  if (state.poseOverride && state.poseOverride.length === state.doc.bones.length) return state.poseOverride;
  return samplePose(state.doc, activeClip(), state.frame);
}

// ---------- 履歴 ----------

interface Snap {
  doc: Doc;
  sel: Selection;
  activeObj: number;
  activeBone: number;
  activeTex: number;
  clip: number;
}

/** テクスチャのピクセル配列だけは参照共有でコピーする（描く側が copy-on-write する約束） */
export function cloneDoc(doc: Doc): Doc {
  const tex = doc.textures;
  const d = structuredClone({ ...doc, textures: [] as Texture[] });
  d.textures = tex.map((t) => ({ ...t }));
  return d;
}

const cloneSel = (s: Selection): Selection => ({ mode: s.mode, verts: new Set(s.verts), edges: new Set(s.edges), faces: new Set(s.faces) });

const takeSnap = (): Snap => ({
  doc: cloneDoc(state.doc),
  sel: cloneSel(state.sel),
  activeObj: state.activeObj,
  activeBone: state.activeBone,
  activeTex: state.activeTex,
  clip: state.clip,
});

const undoStack: Snap[] = [];
const redoStack: Snap[] = [];
const MAX_HISTORY = 80;
let dirtyCounter = 0;

/** 変更を加える「前」に呼ぶ */
export function checkpoint(): void {
  undoStack.push(takeSnap());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  dirtyCounter++;
}

/** 直前の checkpoint を取り消す（結局なにも変えなかったとき用） */
export function dropCheckpoint(): void {
  undoStack.pop();
}

function restore(s: Snap): void {
  state.doc = cloneDoc(s.doc);
  state.sel = cloneSel(s.sel);
  state.activeObj = s.activeObj;
  state.activeBone = s.activeBone;
  state.activeTex = s.activeTex;
  state.clip = s.clip;
  state.poseOverride = null;
  dirtyCounter++;
  notify('doc', 'sel', 'tex', 'pose', 'ui');
}

export function undo(): boolean {
  const s = undoStack.pop();
  if (!s) return false;
  redoStack.push(takeSnap());
  restore(s);
  return true;
}

export function redo(): boolean {
  const s = redoStack.pop();
  if (!s) return false;
  undoStack.push(takeSnap());
  restore(s);
  return true;
}

export const canUndo = (): boolean => undoStack.length > 0;
export const canRedo = (): boolean => redoStack.length > 0;
export const changeCounter = (): number => dirtyCounter;

/** 新しいドキュメントに差し替える（履歴はリセット） */
export function setDoc(doc: Doc): void {
  state.doc = doc;
  state.sel = emptySelection(state.sel.mode);
  state.activeObj = 0;
  state.activeBone = doc.bones.length ? 0 : -1;
  state.activeTex = Math.max(0, doc.objects[0]?.tex ?? 0);
  state.clip = 0;
  state.frame = 0;
  state.playing = false;
  state.poseOverride = null;
  undoStack.length = 0;
  redoStack.length = 0;
  dirtyCounter++;
  notify('doc', 'sel', 'tex', 'pose', 'ui', 'mode');
}
