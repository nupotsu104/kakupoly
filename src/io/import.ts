// 外部ファイルの読み込み（glTF/GLB・OBJ(+MTL)・FBX）→ 編集用ドキュメントへ変換。
// 三角形の集まりで来ることが多いので、重なった頂点の溶接と「三角形→四角形」の整理も行う。
import * as THREE from 'three';
// 読み込み用の部品は本体に含める（後から別ファイルを取りに行くと、アプリ更新の前後で見つからず失敗するため）
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import type { Doc, Face, MeshObj, V2, V3, Bone, Influence, Texture } from '../core/types';
import { newDoc } from '../core/doc';
import { weldByDistance } from '../core/mesh-ops';
import { trisToQuads } from '../core/cleanup';
import { simplifyDoc } from '../core/simplify';
import { mDecompose, mInvert, mMul, type M4 } from '../core/vec';
import { newClip, setKey, reduceKeys } from '../core/skeleton';

export interface ImportOptions {
  quads: boolean;
  weld: boolean;
  /** テクスチャの最大辺。大きい画像はこのサイズまで縮める（0=そのまま） */
  maxTex: number;
  fps: number;
  /** 読み込み後に全体をこの三角形数まで減らす（0 = 元のまま） */
  targetTris: number;
}

export const DEFAULT_IMPORT: ImportOptions = { quads: true, weld: true, maxTex: 256, fps: 15, targetTris: 0 };

/** 複数ファイル（OBJ + MTL + 画像 など）を受け取り、名前で相互参照できるようにする */
function makeManager(files: File[]): { manager: THREE.LoadingManager; revoke: () => void } {
  const urls = new Map<string, string>();
  for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    const name = decodeURIComponent(url.split(/[\\/]/).pop() ?? '').toLowerCase();
    return urls.get(name) ?? url;
  });
  return { manager, revoke: () => urls.forEach((u) => URL.revokeObjectURL(u)) };
}

export async function importFiles(files: File[], opts: ImportOptions = DEFAULT_IMPORT): Promise<Doc> {
  const main =
    files.find((f) => /\.(glb|gltf)$/i.test(f.name)) ?? files.find((f) => /\.fbx$/i.test(f.name)) ?? files.find((f) => /\.obj$/i.test(f.name));
  if (!main) throw new Error('対応形式（.glb .gltf .obj .fbx）のファイルが見つかりません');
  const { manager, revoke } = makeManager(files);
  try {
    const ext = main.name.split('.').pop()!.toLowerCase();
    let root: THREE.Object3D;
    let clips: THREE.AnimationClip[] = [];
    if (ext === 'glb' || ext === 'gltf') {
      const loader = new GLTFLoader(manager);
      // 圧縮された glTF（Draco・meshopt）にも対応。Draco の復号器は public/draco/ に置いてある
      const draco = new DRACOLoader();
      draco.setDecoderPath(new URL('./draco/', document.baseURI).href);
      loader.setDRACOLoader(draco);
      loader.setMeshoptDecoder(MeshoptDecoder);
      const data = ext === 'glb' ? await main.arrayBuffer() : await main.text();
      const g = await loader.parseAsync(data, '');
      restoreGltfNames(g);
      root = g.scene;
      clips = g.animations;
    } else if (ext === 'fbx') {
      const loader = new FBXLoader(manager);
      root = loader.parse(await main.arrayBuffer(), '');
      clips = (root as THREE.Object3D & { animations: THREE.AnimationClip[] }).animations ?? [];
    } else {
      const loader = new OBJLoader(manager);
      const mtlFile = files.find((f) => /\.mtl$/i.test(f.name));
      if (mtlFile) {
        const mtl = new MTLLoader(manager).parse(await mtlFile.text(), '');
        mtl.preload();
        loader.setMaterials(mtl);
      }
      root = loader.parse(await main.text());
    }
    // テクスチャ画像の読み込み完了を待つ
    await waitForTextures(root);
    // FBX・OBJ の UV は「下が 0・上が 1」。KakuPoly（と glTF）は「上が 0」なので、テクスチャの有無に関係なく上下を直す
    const doc = await sceneToDoc(root, clips, opts, ext !== 'glb' && ext !== 'gltf');
    doc.name = main.name.replace(/\.[^.]+$/, '');
    if (opts.targetTris > 0) await simplifyDoc(doc, opts.targetTris);
    return doc;
  } finally {
    setTimeout(revoke, 5000);
  }
}

async function waitForTextures(root: THREE.Object3D): Promise<void> {
  const waits: Promise<void>[] = [];
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      const t = (mat as THREE.MeshStandardMaterial).map;
      const img = t?.image as HTMLImageElement | undefined;
      if (img && 'complete' in img && !img.complete)
        waits.push(new Promise((r) => {
          img.addEventListener('load', () => r(), { once: true });
          img.addEventListener('error', () => r(), { once: true });
        }));
    }
  });
  await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, 8000))]);
}

function imageToRGBA(img: CanvasImageSource & { width: number; height: number }, maxSide: number): { w: number; h: number; data: Uint8ClampedArray } | null {
  let w = img.width,
    h = img.height;
  if (!w || !h) return null;
  if (maxSide > 0 && Math.max(w, h) > maxSide) {
    const s = maxSide / Math.max(w, h);
    w = Math.max(1, Math.round(w * s));
    h = Math.max(1, Math.round(h * s));
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true;
  g.drawImage(img, 0, 0, w, h);
  return { w, h, data: g.getImageData(0, 0, w, h).data };
}

/**
 * three.js の glTF 読み込みはノード名の「.」などを取り除く（例: arm.L → armL）。
 * 左右の対応付けに名前を使うので、元の名前を userData に戻しておく。
 */
export function restoreGltfNames(g: { scene: THREE.Object3D; parser: { json: { nodes?: { name?: string }[] }; associations: Map<unknown, { nodes?: number }> } }): void {
  const nodes = g.parser.json.nodes ?? [];
  g.scene.traverse((o) => {
    const a = g.parser.associations.get(o);
    const n = a?.nodes !== undefined ? nodes[a.nodes]?.name : undefined;
    if (n) o.userData.originalName = n;
  });
}

const nameOf = (o: THREE.Object3D): string => (o.userData.originalName as string | undefined) ?? o.name;

export async function sceneToDoc(root: THREE.Object3D, clips: THREE.AnimationClip[], opts: ImportOptions, flipV = false): Promise<Doc> {
  const doc = newDoc();
  root.updateMatrixWorld(true);

  // ---- ボーン ----
  const boneList: THREE.Bone[] = [];
  const boneIndex = new Map<THREE.Object3D, number>();
  const restWorldOf = new Map<THREE.Object3D, THREE.Matrix4>();
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh || !sm.skeleton) return;
    sm.skeleton.bones.forEach((b, i) => {
      if (!boneIndex.has(b)) {
        boneIndex.set(b, boneList.length);
        boneList.push(b);
        // バインド時のワールド行列 = boneInverse の逆
        restWorldOf.set(b, sm.skeleton.boneInverses[i].clone().invert());
      }
    });
  });
  // スケルトンに入っていない Bone もぶら下がっていれば拾う（末端ボーンなど）
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone && !boneIndex.has(o)) {
      boneIndex.set(o, boneList.length);
      boneList.push(o as THREE.Bone);
      restWorldOf.set(o, o.matrixWorld.clone());
    }
  });
  const boneParent = (b: THREE.Object3D): number => {
    for (let p = b.parent; p; p = p.parent) if (boneIndex.has(p)) return boneIndex.get(p)!;
    return -1;
  };
  const rw: M4[] = boneList.map((b) => restWorldOf.get(b)!.toArray());
  doc.bones = boneList.map((b, i): Bone => {
    const p = boneParent(b);
    const local = p >= 0 ? mMul(mInvert(rw[p]), rw[i]) : rw[i];
    const d = mDecompose(local);
    return { name: nameOf(b) || `bone${i}`, parent: p, pos: d.pos, rot: d.rot, scl: d.scl };
  });
  // 名前の重複を避ける
  const seen = new Map<string, number>();
  for (const b of doc.bones) {
    const n = seen.get(b.name) ?? 0;
    seen.set(b.name, n + 1);
    if (n) b.name = `${b.name}.${String(n).padStart(2, '0')}`;
  }

  // ---- テクスチャ ----
  const texCache = new Map<THREE.Texture, number>();
  const texIndex = (t: THREE.Texture | null | undefined): number => {
    if (!t?.image) return -1;
    const c = texCache.get(t);
    if (c !== undefined) return c;
    const img = imageToRGBA(t.image as CanvasImageSource & { width: number; height: number }, opts.maxTex);
    if (!img) return -1;
    const tex: Texture = { id: doc.nextId++, name: t.name || `tex${doc.textures.length + 1}`, w: img.w, h: img.h, data: img.data };
    doc.textures.push(tex);
    texCache.set(t, doc.textures.length - 1);
    return doc.textures.length - 1;
  };

  // ---- メッシュ ----
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const uvA = geo.getAttribute('uv');
    const colA = geo.getAttribute('color');
    const si = geo.getAttribute('skinIndex');
    const sw = geo.getAttribute('skinWeight');
    const sm = mesh as THREE.SkinnedMesh;
    const isSkinned = !!sm.isSkinnedMesh && !!si && !!sw;
    // スキンなしでも、親（祖先）にボーンがあれば、そのボーンに100%くっつける（3ds Max 等の「骨にリンクした部品」）。
    // 位置は「今のボーンの姿勢」から「バインド姿勢」へ置き直す
    let attachBone = -1;
    let mat = isSkinned ? sm.bindMatrix : mesh.matrixWorld;
    if (!isSkinned) {
      for (let p = mesh.parent; p; p = p.parent)
        if (boneIndex.has(p)) {
          attachBone = boneIndex.get(p)!;
          mat = restWorldOf.get(p)!.clone().multiply(p.matrixWorld.clone().invert()).multiply(mesh.matrixWorld);
          break;
        }
    }
    const flip = mat.determinant() < 0;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // 材質が1つなら区分け（グループ）は無視して1つのオブジェクトにする。複数なら材質ごとに分ける
    const whole = [{ start: 0, count: geo.index ? geo.index.count : pos.count, materialIndex: 0 }];
    let groups = Array.isArray(mesh.material) && geo.groups.length ? geo.groups : whole;
    if (Array.isArray(mesh.material) && new Set(groups.map((g) => mats[g.materialIndex ?? 0])).size === 1) groups = whole;
    const index = geo.index;
    const v = new THREE.Vector3();
    groups.forEach((g, gi) => {
      const material = mats[g.materialIndex ?? 0] as THREE.MeshStandardMaterial | undefined;
      const o: MeshObj = {
        id: doc.nextId++,
        name: (nameOf(mesh) || 'mesh') + (groups.length > 1 ? `.${gi}` : ''),
        verts: [],
        faces: [],
        skin: [],
        tex: texIndex(material?.map),
        visible: true,
        doubleSided: material?.side === THREE.DoubleSide,
      };
      const base = material?.color ? [material.color.r, material.color.g, material.color.b] : [1, 1, 1];
      // 使う頂点だけを取り出す
      const remap = new Map<number, number>();
      const vid = (i: number): number => {
        let r = remap.get(i);
        if (r !== undefined) return r;
        v.fromBufferAttribute(pos, i).applyMatrix4(mat);
        r = o.verts.length;
        o.verts.push([v.x, v.y, v.z]);
        const inf: Influence[] = [];
        if (attachBone >= 0) inf.push([attachBone, 1]);
        else if (isSkinned) {
          for (let k = 0; k < 4; k++) {
            const w = sw.getComponent(i, k);
            const b = sm.skeleton.bones[si.getComponent(i, k)];
            if (w > 1e-4 && b && boneIndex.has(b)) inf.push([boneIndex.get(b)!, w]);
          }
        }
        o.skin.push(inf);
        remap.set(i, r);
        return r;
      };
      const end = Math.min(g.start + g.count, index ? index.count : pos.count);
      for (let t = g.start; t + 2 < end; t += 3) {
        const ids = [0, 1, 2].map((k) => (index ? index.getX(t + k) : t + k));
        if (flip) ids.reverse();
        const f: Face = {
          v: ids.map(vid),
          uv: ids.map((i): V2 => (uvA ? [uvA.getX(i), flipV ? 1 - uvA.getY(i) : uvA.getY(i)] : [0, 0])),
          // three.js は読み込み時に UV を上下反転しないので glTF の座標系（左上原点）と一致する
          col: ids.map((i): V3 => (colA ? [colA.getX(i) * base[0], colA.getY(i) * base[1], colA.getZ(i) * base[2]] : [base[0], base[1], base[2]])),
        };
        if (new Set(f.v).size === 3) o.faces.push(f);
      }
      if (o.faces.length === 0) return;
      if (opts.weld) weldByDistance(o, 1e-5, undefined, true);
      if (opts.quads) trisToQuads(o);
      doc.objects.push(o);
    });
  });


  // ---- アニメーション（各フレームでボーンを動かしてローカル姿勢を読み取る） ----
  if (clips.length && boneList.length) {
    const mixer = new THREE.AnimationMixer(root);
    for (const clip of clips) {
      const action = mixer.clipAction(clip);
      action.play();
      const c = newClip(doc, clip.name || `anim${doc.clips.length + 1}`);
      c.fps = opts.fps;
      c.length = Math.max(1, Math.round(clip.duration * opts.fps));
      c.loop = true;
      for (let f = 0; f <= c.length; f++) {
        mixer.setTime(Math.min(clip.duration, f / opts.fps));
        root.updateMatrixWorld(true);
        const worlds = boneList.map((b) => b.matrixWorld.toArray());
        boneList.forEach((_, i) => {
          const p = doc.bones[i].parent;
          // ルートボーンはワールド姿勢をそのままローカルとして持つ（Armature 等の親の変形を含める）
          const local: M4 = p >= 0 ? mMul(mInvert(worlds[p]), worlds[i]) : worlds[i];
          setKey(c, i, f, mDecompose(local));
        });
      }
      action.stop();
      mixer.uncacheClip(clip);
      for (const t of c.tracks) t.keys = reduceKeys(t.keys);
      // 動いていないボーンのトラックは消す
      c.tracks = c.tracks.filter((t) => {
        const b = doc.bones[t.bone];
        return !(t.keys.length === 1 && near(t.keys[0].pos, b.pos) && near(t.keys[0].rot, b.rot) && near(t.keys[0].scl, b.scl));
      });
    }
    // 再生で動いたボーンをレストに戻す
    mixer.stopAllAction();
  }
  return doc;
}

const near = (a: number[], b: number[], eps = 1e-4) => a.every((x, i) => Math.abs(x - b[i]) < eps);

/** 画像ファイル → RGBA */
export async function loadImageFile(file: File): Promise<{ w: number; h: number; data: Uint8ClampedArray }> {
  const bmp = await createImageBitmap(file);
  const r = imageToRGBA(bmp, 0)!;
  bmp.close();
  return r;
}
