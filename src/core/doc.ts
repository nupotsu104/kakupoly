import type { Doc, MeshObj, Texture, Selection, Face, V3 } from './types';

// 初期パレット（32色）。PS1時代のゲームで多用された、彩度高めの原色＋肌・土・草色。
export const DEFAULT_PALETTE = [
  '#000000', '#181818', '#404040', '#787878', '#b0b0b0', '#e0e0e0', '#ffffff', '#f8d8b0',
  '#e8a878', '#c07848', '#885030', '#502810', '#f83800', '#c81010', '#801010', '#f87858',
  '#f8b800', '#f8d878', '#a87000', '#58d854', '#00a800', '#005800', '#b8f818', '#3cbcfc',
  '#0078f8', '#0000bc', '#101850', '#6844fc', '#9878f8', '#d800cc', '#f878f8', '#00e8d8',
];

export function newDoc(name = '無題'): Doc {
  return {
    version: 1,
    name,
    objects: [],
    textures: [],
    bones: [],
    clips: [],
    palette: [...DEFAULT_PALETTE],
    nextId: 1,
  };
}

export function newMesh(doc: Doc, name: string): MeshObj {
  const m: MeshObj = {
    id: doc.nextId++,
    name,
    verts: [],
    faces: [],
    skin: [],
    tex: -1,
    visible: true,
    doubleSided: false,
  };
  doc.objects.push(m);
  return m;
}

export function newTexture(doc: Doc, name: string, w: number, h: number, fill: [number, number, number, number] = [200, 200, 200, 255]): Texture {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  const t: Texture = { id: doc.nextId++, name, w, h, data };
  doc.textures.push(t);
  return t;
}

export function emptySelection(mode: Selection['mode'] = 'face'): Selection {
  return { mode, verts: new Set(), edges: new Set(), faces: new Set() };
}

export function makeFace(v: number[], uv?: [number, number][], col?: V3[]): Face {
  return {
    v: [...v],
    uv: uv ? uv.map((p) => [p[0], p[1]] as [number, number]) : v.map(() => [0, 0] as [number, number]),
    col: col ? col.map((c) => [c[0], c[1], c[2]] as V3) : v.map(() => [1, 1, 1] as V3),
  };
}

/** ドキュメント全体の統計 */
export function docStats(doc: Doc): { verts: number; faces: number; tris: number } {
  let verts = 0,
    faces = 0,
    tris = 0;
  for (const o of doc.objects) {
    verts += o.verts.length;
    faces += o.faces.length;
    for (const f of o.faces) tris += Math.max(0, f.v.length - 2);
  }
  return { verts, faces, tris };
}

export const hexToRgb = (hex: string): V3 => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
export const rgbToHex = (c: ArrayLike<number>, scale = 255): string => {
  const h = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x * scale)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
};
