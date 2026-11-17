// ドキュメントのデータ → three.js のジオメトリ/テクスチャ
import * as THREE from 'three';
import type { Doc, MeshObj, Texture, V3 } from '../core/types';
import { faceNormal } from '../core/mesh-ops';

export interface BuiltGeometry {
  geo: THREE.BufferGeometry;
  /** 三角形番号 → 元の面番号 */
  triFace: Int32Array;
}

const BONE_HUES = [0, 0.33, 0.6, 0.12, 0.8, 0.45, 0.92, 0.22, 0.7, 0.05, 0.52, 0.28];
export function boneColor(i: number): V3 {
  const c = new THREE.Color().setHSL(BONE_HUES[i % BONE_HUES.length], 0.85, i % 24 < 12 ? 0.55 : 0.4);
  return [c.r, c.g, c.b];
}

export interface BuildOpts {
  smooth: boolean;
  /** スケルトンがあるときの「どのボーンにも属さない頂点」用の固定ボーン番号。-1ならスキンなし */
  staticBone: number;
  /** ウェイト表示: 頂点カラーを支配ボーンの色で上書き */
  weightColors: boolean;
  positions?: V3[];
}

export function buildGeometry(o: MeshObj, opts: BuildOpts): BuiltGeometry {
  const verts = opts.positions ?? o.verts;
  let nTri = 0;
  for (const f of o.faces) nTri += Math.max(0, f.v.length - 2);
  const pos = new Float32Array(nTri * 9);
  const nor = new Float32Array(nTri * 9);
  const uv = new Float32Array(nTri * 6);
  const col = new Float32Array(nTri * 9);
  const skinned = opts.staticBone >= 0;
  const si = skinned ? new Uint16Array(nTri * 12) : null;
  const sw = skinned ? new Float32Array(nTri * 12) : null;
  const triFace = new Int32Array(nTri);

  let smoothN: V3[] | null = null;
  if (opts.smooth) {
    smoothN = verts.map(() => [0, 0, 0] as V3);
    for (const f of o.faces) {
      const n = faceNormal(o, f, verts);
      for (const v of f.v) {
        smoothN[v][0] += n[0];
        smoothN[v][1] += n[1];
        smoothN[v][2] += n[2];
      }
    }
  }

  let t = 0;
  o.faces.forEach((f, fi) => {
    const fn = faceNormal(o, f, verts);
    for (let k = 1; k < f.v.length - 1; k++) {
      const corners = [0, k, k + 1];
      for (let c = 0; c < 3; c++) {
        const ci = corners[c];
        const vi = f.v[ci];
        const p = verts[vi];
        const o3 = t * 9 + c * 3;
        pos[o3] = p[0];
        pos[o3 + 1] = p[1];
        pos[o3 + 2] = p[2];
        const n = smoothN ? smoothN[vi] : fn;
        nor[o3] = n[0];
        nor[o3 + 1] = n[1];
        nor[o3 + 2] = n[2];
        uv[t * 6 + c * 2] = f.uv[ci][0];
        uv[t * 6 + c * 2 + 1] = f.uv[ci][1];
        let cc = f.col[ci];
        if (opts.weightColors) {
          const inf = o.skin[vi];
          cc = inf && inf.length ? boneColor(inf[0][0]) : [0.35, 0.35, 0.35];
        }
        col[o3] = cc[0];
        col[o3 + 1] = cc[1];
        col[o3 + 2] = cc[2];
        if (si && sw) {
          const inf = o.skin[vi];
          const o4 = t * 12 + c * 4;
          if (inf && inf.length) {
            for (let j = 0; j < Math.min(4, inf.length); j++) {
              si[o4 + j] = inf[j][0];
              sw[o4 + j] = inf[j][1];
            }
          } else {
            si[o4] = opts.staticBone;
            sw[o4] = 1;
          }
        }
      }
      triFace[t++] = fi;
    }
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('acol', new THREE.BufferAttribute(col, 3));
  if (si && sw) {
    geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
  }
  return { geo, triFace };
}

export function buildTexture(t: Texture, smooth = false): THREE.DataTexture {
  const tex = new THREE.DataTexture(t.data as unknown as Uint8Array, t.w, t.h, THREE.RGBAFormat, THREE.UnsignedByteType);
  // PS1風はドットのまま（最近傍）。元の見た目は縮小しても粗くならないよう段階縮小（ミップマップ）を使う
  tex.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
  tex.minFilter = smooth ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = smooth;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** ドキュメントの骨格から three.js の Bone 階層を作る。末尾に固定ボーンを1本足す */
export function buildBones(doc: Doc): { bones: THREE.Bone[]; roots: THREE.Bone[] } {
  const bones = doc.bones.map((b) => {
    const tb = new THREE.Bone();
    tb.name = b.name;
    tb.position.fromArray(b.pos);
    tb.quaternion.fromArray(b.rot);
    tb.scale.fromArray(b.scl);
    return tb;
  });
  const roots: THREE.Bone[] = [];
  doc.bones.forEach((b, i) => {
    if (b.parent >= 0 && b.parent < bones.length && b.parent !== i) bones[b.parent].add(bones[i]);
    else roots.push(bones[i]);
  });
  const stat = new THREE.Bone();
  stat.name = '__static';
  bones.push(stat);
  roots.push(stat);
  return { bones, roots };
}
