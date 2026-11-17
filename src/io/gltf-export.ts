// glTF 2.0 バイナリ（.glb）書き出し。メッシュ・頂点カラー・テクスチャ（最近傍フィルタ指定）・
// スケルトン・アニメーションを含める。Blender / Unity / Godot / three.js などで読める標準形式。
import type { Doc, MeshObj, V3 } from '../core/types';
import { faceNormal } from '../core/mesh-ops';
import { restWorld } from '../core/skeleton';
import { mInvert } from '../core/vec';
import { encodePNG } from './png';

const NEAREST = 9728;
const REPEAT = 10497;
const FLOAT = 5126;
const USHORT = 5123;
const UINT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  byteOffset?: number;
}

export interface ExportOptions {
  /** 書き出し時の拡大率（例: 0.01 → cm単位のソフト向けではなく、1.0 = 1単位1メートル） */
  scale?: number;
  /** 面の法線をそのまま使う（PS1風のカクカク陰影）。false なら頂点ごとに平均 */
  flat?: boolean;
  /** アニメーションを含める */
  animations?: boolean;
  /** 見えないオブジェクトも含める */
  includeHidden?: boolean;
}

class BinWriter {
  chunks: Uint8Array[] = [];
  length = 0;
  views: { buffer: 0; byteOffset: number; byteLength: number; target?: number }[] = [];
  add(data: Uint8Array, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    this.views.push({ buffer: 0, byteOffset: this.length, byteLength: data.byteLength, ...(target ? { target } : {}) });
    this.chunks.push(data);
    this.length += data.byteLength;
    return this.views.length - 1;
  }
  concat(): Uint8Array {
    const pad = (4 - (this.length % 4)) % 4;
    const out = new Uint8Array(this.length + pad);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }
}

const bytes = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

function minMax(data: Float32Array, n: number): { min: number[]; max: number[] } {
  const min = new Array(n).fill(Infinity),
    max = new Array(n).fill(-Infinity);
  for (let i = 0; i < data.length; i += n)
    for (let k = 0; k < n; k++) {
      min[k] = Math.min(min[k], data[i + k]);
      max[k] = Math.max(max[k], data[i + k]);
    }
  if (data.length === 0) return { min: new Array(n).fill(0), max: new Array(n).fill(0) };
  return { min, max };
}

export async function exportGLB(doc: Doc, opts: ExportOptions = {}): Promise<Uint8Array> {
  const scale = opts.scale ?? 1;
  const flat = opts.flat ?? true;
  const bin = new BinWriter();
  const accessors: Accessor[] = [];
  const accessor = (data: Float32Array | Uint16Array | Uint32Array, type: string, componentType: number, target?: number, withMinMax = false): number => {
    const bv = bin.add(bytes(data), target);
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!;
    const a: Accessor = { bufferView: bv, componentType, count: data.length / n, type };
    if (withMinMax && data instanceof Float32Array) Object.assign(a, minMax(data, n));
    accessors.push(a);
    return accessors.length - 1;
  };

  const objects = doc.objects.filter((o) => (opts.includeHidden || o.visible) && o.faces.length > 0);
  const hasBones = doc.bones.length > 0;
  const needStatic = hasBones && objects.some((o) => o.verts.some((_, i) => !(o.skin[i] && o.skin[i].length)));

  // ---- テクスチャ ----
  const images: { bufferView: number; mimeType: string; name: string }[] = [];
  const textures: { sampler: number; source: number }[] = [];
  const usedTex = [...new Set(objects.map((o) => o.tex).filter((t) => t >= 0 && t < doc.textures.length))];
  const texMap = new Map<number, number>();
  for (const ti of usedTex) {
    const t = doc.textures[ti];
    const png = await encodePNG(t.w, t.h, t.data);
    images.push({ bufferView: bin.add(png), mimeType: 'image/png', name: t.name });
    textures.push({ sampler: 0, source: images.length - 1 });
    texMap.set(ti, textures.length - 1);
  }

  // ---- ノード ----
  const nodes: Record<string, unknown>[] = [];
  const sceneRoots: number[] = [];
  const boneNode: number[] = [];
  // ボーン（と固定用の static）は全部「Armature」の下にまとめる。glTF ではスキンの関節に共通の親が必要なため
  // （ルートボーンが複数ある時や、ウェイトのない頂点用の static がある時に規格違反になっていた）
  let armature = -1;
  const armatureChildren: number[] = [];
  if (hasBones) {
    nodes.push({ name: 'Armature', children: armatureChildren });
    armature = nodes.length - 1;
    sceneRoots.push(armature);
    doc.bones.forEach((b) => {
      nodes.push({ name: b.name, translation: b.pos.map((v) => v * scale), rotation: b.rot, scale: b.scl });
      boneNode.push(nodes.length - 1);
    });
    doc.bones.forEach((b, i) => {
      if (b.parent >= 0) {
        const p = nodes[boneNode[b.parent]];
        ((p.children as number[] | undefined) ?? (p.children = [])) && (p.children as number[]).push(boneNode[i]);
      } else armatureChildren.push(boneNode[i]);
    });
  }
  let staticNode = -1;
  if (needStatic) {
    nodes.push({ name: 'static' });
    staticNode = nodes.length - 1;
    armatureChildren.push(staticNode);
  }

  // ---- スキン ----
  const skins: Record<string, unknown>[] = [];
  if (hasBones) {
    const rw = restWorld(doc.bones);
    const joints = [...boneNode];
    const ibm = new Float32Array((joints.length + (needStatic ? 1 : 0)) * 16);
    rw.forEach((m, i) => {
      const s = m.slice();
      s[12] *= scale;
      s[13] *= scale;
      s[14] *= scale;
      ibm.set(mInvert(s), i * 16);
    });
    if (needStatic) {
      joints.push(staticNode);
      ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], (joints.length - 1) * 16);
    }
    skins.push({ joints, inverseBindMatrices: accessor(ibm, 'MAT4', FLOAT), skeleton: armature });
  }

  // ---- メッシュ ----
  const meshes: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const matFor = new Map<string, number>();
  for (const o of objects) {
    const built = buildMeshArrays(o, flat, hasBones ? (needStatic ? doc.bones.length : 0) : -1, scale);
    const attributes: Record<string, number> = {
      POSITION: accessor(built.pos, 'VEC3', FLOAT, ARRAY_BUFFER, true),
      NORMAL: accessor(built.nor, 'VEC3', FLOAT, ARRAY_BUFFER),
      TEXCOORD_0: accessor(built.uv, 'VEC2', FLOAT, ARRAY_BUFFER),
      COLOR_0: accessor(built.col, 'VEC3', FLOAT, ARRAY_BUFFER),
    };
    if (built.joints && built.weights) {
      attributes.JOINTS_0 = accessor(built.joints, 'VEC4', USHORT, ARRAY_BUFFER);
      attributes.WEIGHTS_0 = accessor(built.weights, 'VEC4', FLOAT, ARRAY_BUFFER);
    }
    const indices = accessor(built.index, 'SCALAR', built.index instanceof Uint16Array ? USHORT : UINT, ELEMENT_ARRAY_BUFFER);
    const opacity = Math.max(0, Math.min(1, o.opacity ?? 1));
    const key = `${o.tex}/${o.doubleSided}/${opacity}`;
    let mi = matFor.get(key);
    if (mi === undefined) {
      const ti = texMap.get(o.tex);
      const base = ti !== undefined ? doc.textures[o.tex].name : 'vertexcolor';
      materials.push({
        name: opacity < 1 ? `${base}_${Math.round(opacity * 100)}` : base,
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, opacity], metallicFactor: 0, roughnessFactor: 1, ...(ti !== undefined ? { baseColorTexture: { index: ti } } : {}) },
        // 半透明は BLEND、テクスチャの透明部分は MASK（切り抜き）
        alphaMode: opacity < 1 ? 'BLEND' : ti !== undefined ? 'MASK' : 'OPAQUE',
        ...(opacity >= 1 && ti !== undefined ? { alphaCutoff: 0.5 } : {}),
        doubleSided: o.doubleSided,
      });
      mi = materials.length - 1;
      matFor.set(key, mi);
    }
    meshes.push({ name: o.name, primitives: [{ attributes, indices, material: mi, mode: 4 }] });
    nodes.push({ name: o.name, mesh: meshes.length - 1, ...(hasBones ? { skin: 0 } : {}) });
    sceneRoots.push(nodes.length - 1);
  }

  // ---- アニメーション ----
  const animations: Record<string, unknown>[] = [];
  if (hasBones && opts.animations !== false) {
    for (const clip of doc.clips) {
      const samplers: Record<string, unknown>[] = [];
      const channels: Record<string, unknown>[] = [];
      for (const tr of clip.tracks) {
        if (tr.keys.length === 0 || tr.bone >= doc.bones.length) continue;
        const times = new Float32Array(tr.keys.map((k) => k.f / clip.fps));
        const input = accessor(times, 'SCALAR', FLOAT, undefined, true);
        const interpolation = clip.interp === 'step' ? 'STEP' : 'LINEAR';
        const add = (path: string, data: Float32Array, type: string) => {
          samplers.push({ input, output: accessor(data, type, FLOAT), interpolation });
          channels.push({ sampler: samplers.length - 1, target: { node: boneNode[tr.bone], path } });
        };
        add('translation', new Float32Array(tr.keys.flatMap((k) => k.pos.map((v) => v * scale))), 'VEC3');
        // 回転は符号をそろえて補間の遠回りを防ぐ
        const rot: number[] = [];
        let prev: number[] | null = null;
        for (const k of tr.keys) {
          let q = [...k.rot];
          if (prev && q[0] * prev[0] + q[1] * prev[1] + q[2] * prev[2] + q[3] * prev[3] < 0) q = q.map((v) => -v);
          rot.push(...q);
          prev = q;
        }
        add('rotation', new Float32Array(rot), 'VEC4');
        add('scale', new Float32Array(tr.keys.flatMap((k) => k.scl)), 'VEC3');
      }
      if (channels.length) animations.push({ name: clip.name, samplers, channels });
    }
  }

  const binData = bin.concat();
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'KakuPoly' },
    scene: 0,
    scenes: [{ name: doc.name, nodes: sceneRoots }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: bin.views,
    buffers: [{ byteLength: binData.byteLength }],
  };
  if (textures.length) {
    json.samplers = [{ magFilter: NEAREST, minFilter: NEAREST, wrapS: REPEAT, wrapT: REPEAT }];
    json.textures = textures;
    json.images = images;
  }
  if (skins.length) json.skins = skins;
  if (animations.length) json.animations = animations;
  return packGLB(json, binData);
}

function packGLB(json: object, bin: Uint8Array): Uint8Array {
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad) {
    const p = new Uint8Array(jsonBytes.length + jpad).fill(0x20);
    p.set(jsonBytes);
    jsonBytes = p;
  }
  const total = 12 + 8 + jsonBytes.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  const o = 20 + jsonBytes.length;
  dv.setUint32(o, bin.length, true);
  dv.setUint32(o + 4, 0x004e4942, true); // 'BIN\0'
  out.set(bin, o + 8);
  return out;
}

/** 面ごとに頂点を分けた配列を作る（同じ値の組は共有して頂点数を抑える） */
export function buildMeshArrays(o: MeshObj, flat: boolean, staticJoint: number, scale = 1) {
  const smooth: V3[] | null = flat ? null : o.verts.map(() => [0, 0, 0] as V3);
  if (smooth)
    for (const f of o.faces) {
      const n = faceNormal(o, f);
      for (const v of f.v) for (let k = 0; k < 3; k++) smooth[v][k] += n[k];
    }
  const map = new Map<string, number>();
  const pos: number[] = [],
    nor: number[] = [],
    uv: number[] = [],
    col: number[] = [],
    jo: number[] = [],
    we: number[] = [];
  const index: number[] = [];
  const skinned = staticJoint >= 0;
  for (const f of o.faces) {
    const fn = faceNormal(o, f);
    const corner = (ci: number): number => {
      const vi = f.v[ci];
      let n: V3 = fn;
      if (smooth) {
        const s = smooth[vi];
        const l = Math.hypot(s[0], s[1], s[2]) || 1;
        n = [s[0] / l, s[1] / l, s[2] / l];
      }
      const key = `${vi}|${f.uv[ci][0]},${f.uv[ci][1]}|${f.col[ci].join(',')}|${n[0].toFixed(4)},${n[1].toFixed(4)},${n[2].toFixed(4)}`;
      let id = map.get(key);
      if (id !== undefined) return id;
      id = pos.length / 3;
      map.set(key, id);
      const p = o.verts[vi];
      pos.push(p[0] * scale, p[1] * scale, p[2] * scale);
      nor.push(...n);
      uv.push(f.uv[ci][0], f.uv[ci][1]);
      col.push(...f.col[ci]);
      if (skinned) {
        const inf = o.skin[vi];
        const j = [0, 0, 0, 0],
          w = [0, 0, 0, 0];
        if (inf && inf.length) {
          const s = inf.slice(0, 4).reduce((t, x) => t + x[1], 0) || 1;
          inf.slice(0, 4).forEach(([b, ww], k) => {
            j[k] = b;
            w[k] = ww / s;
          });
        } else {
          j[0] = staticJoint;
          w[0] = 1;
        }
        jo.push(...j);
        we.push(...w);
      }
      return id;
    };
    for (let k = 1; k < f.v.length - 1; k++) index.push(corner(0), corner(k), corner(k + 1));
  }
  const n = pos.length / 3;
  return {
    pos: new Float32Array(pos),
    nor: new Float32Array(nor),
    uv: new Float32Array(uv),
    col: new Float32Array(col),
    joints: skinned ? new Uint16Array(jo) : null,
    weights: skinned ? new Float32Array(we) : null,
    index: n < 65536 ? new Uint16Array(index) : new Uint32Array(index),
  };
}

/** 現在のポーズ・静止状態の Wavefront OBJ（+MTL）。他のソフトに形だけ渡す用 */
export function exportOBJ(doc: Doc, baseName: string, positions?: (o: MeshObj) => V3[]): { obj: string; mtl: string } {
  const lines: string[] = [`# KakuPoly`, `mtllib ${baseName}.mtl`];
  const mtl: string[] = [];
  let vBase = 1,
    tBase = 1;
  const mats = new Set<string>();
  for (const o of doc.objects) {
    if (!o.visible) continue;
    const P = positions ? positions(o) : o.verts;
    lines.push(`o ${o.name.replace(/\s/g, '_')}`);
    for (const p of P) lines.push(`v ${p[0].toFixed(6)} ${p[1].toFixed(6)} ${p[2].toFixed(6)}`);
    let t = 0;
    for (const f of o.faces) for (const u of f.uv) lines.push(`vt ${u[0].toFixed(6)} ${(1 - u[1]).toFixed(6)}`), t++;
    const mname = o.tex >= 0 && doc.textures[o.tex] ? `tex_${o.tex}` : 'vertexcolor';
    if (!mats.has(mname)) {
      mats.add(mname);
      mtl.push(`newmtl ${mname}`, 'Kd 1 1 1', 'Ka 0 0 0', 'Ks 0 0 0', 'd 1', 'illum 1');
      if (mname !== 'vertexcolor') mtl.push(`map_Kd ${baseName}_${doc.textures[o.tex].name}.png`);
      mtl.push('');
    }
    lines.push(`usemtl ${mname}`);
    let ti = tBase;
    for (const f of o.faces) {
      lines.push('f ' + f.v.map((v) => `${v + vBase}/${ti++}`).join(' '));
    }
    vBase += P.length;
    tBase += t;
  }
  return { obj: lines.join('\n') + '\n', mtl: mtl.join('\n') };
}
