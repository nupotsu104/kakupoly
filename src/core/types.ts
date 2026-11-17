// ドキュメント（プロジェクト）のデータ構造。three.js には依存しない純粋なデータ。

export type V2 = [number, number];
export type V3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

/** 面。3角形・4角形・多角形（凸を前提にファン分割）を扱う。 */
export interface Face {
  /** 頂点インデックス（反時計回りが表） */
  v: number[];
  /** コーナーごとのUV。画像座標系: (0,0)=左上, vは下向き（glTFと同じ） */
  uv: V2[];
  /** コーナーごとの頂点カラー 0..1 */
  col: V3[];
}

/** 頂点1つ分のスキンウェイト: [ボーン番号, 重み] を最大4つ */
export type Influence = [number, number];

export interface MeshObj {
  id: number;
  name: string;
  verts: V3[];
  faces: Face[];
  /** verts と同じ長さ。空配列ならどのボーンにも属さない */
  skin: Influence[][];
  /** 使用テクスチャ番号。-1 はテクスチャなし（頂点カラーのみ） */
  tex: number;
  visible: boolean;
  doubleSided: boolean;
  /** 不透明度 0..1（省略時 1）。1 未満なら半透明で描く（例: 複眼の殻を透かして中の目を見せる） */
  opacity?: number;
}

export interface Texture {
  id: number;
  name: string;
  w: number;
  h: number;
  /** RGBA 8bit。履歴と共有されるので書き換える前に必ずコピーする（copy-on-write） */
  data: Uint8ClampedArray;
}

export interface Bone {
  name: string;
  parent: number; // -1 = ルート
  /** レスト（初期）姿勢のローカルTRS */
  pos: V3;
  rot: Quat;
  scl: V3;
}

export interface Key {
  f: number; // フレーム番号
  pos: V3;
  rot: Quat;
  scl: V3;
}

export interface Track {
  bone: number;
  keys: Key[]; // f 昇順
}

export interface Clip {
  name: string;
  fps: number;
  length: number; // フレーム数（最終フレーム番号 = length - 1 … ではなく 0..length を再生範囲とする）
  interp: 'linear' | 'step';
  loop: boolean;
  tracks: Track[];
}

export interface Doc {
  version: 1;
  name: string;
  objects: MeshObj[];
  textures: Texture[];
  bones: Bone[];
  clips: Clip[];
  palette: string[]; // '#rrggbb'
  nextId: number;
}

export type SelMode = 'vert' | 'edge' | 'face';

export interface Selection {
  mode: SelMode;
  verts: Set<number>;
  edges: Set<string>; // edgeKey(a,b)
  faces: Set<number>;
}

export const edgeKey = (a: number, b: number): string => (a < b ? `${a}_${b}` : `${b}_${a}`);
export const parseEdge = (k: string): [number, number] => {
  const i = k.indexOf('_');
  return [Number(k.slice(0, i)), Number(k.slice(i + 1))];
};
