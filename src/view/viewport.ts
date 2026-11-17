// 3Dビューポート: カメラ、PS1風レンダリング、編集用オーバーレイ、ピッキング
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { MeshObj, V2, V3 } from '../core/types';
import { parseEdge } from '../core/types';
import { edgeFaces } from '../core/mesh-ops';
import { state, subscribe, currentPose, activeObject } from '../state';
import { worldMatrices } from '../core/skeleton';
import { M4, mPos, sub, cross, dot, add, mul, norm } from '../core/vec';
import { buildBones, buildGeometry, buildTexture, boneColor } from './builders';
import { makePostMaterial, makePs1Material, makeSharedUniforms } from './ps1-material';

/** 陰影の強さ → 光の当たらない面の明るさ（1 なら陰なし） */
const AMBIENT = { soft: 0.75, normal: 0.55, strong: 0.35 } as const;

export interface Ray {
  o: V3;
  d: V3;
}
export interface Hit {
  obj: number;
  face: number;
  t: number;
  point: V3;
  uv: V2;
}

const SEL_COLOR = 0xffa018;

export class Viewport {
  readonly el: HTMLElement;
  readonly glCanvas: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private shared = makeSharedUniforms();
  private sceneMain = new THREE.Scene();
  private sceneOverlay = new THREE.Scene();
  private postScene = new THREE.Scene();
  private postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private postMat = makePostMaterial();
  private rt: THREE.WebGLRenderTarget | null = null;
  private persp = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 200);
  private meshGroup = new THREE.Group();
  private boneGroup = new THREE.Group();
  private editGroup = new THREE.Group();
  private grid: THREE.LineSegments;
  private textures: THREE.DataTexture[] = [];
  private bones: THREE.Bone[] = [];
  private meshes: { obj: MeshObj; index: number; mesh: THREE.Mesh }[] = [];
  private depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
  private depthMatDS = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2, side: THREE.DoubleSide });
  private lineMats: LineMaterial[] = [];
  private needRebuild = true;
  private needOverlay = true;
  private dirty = true;
  private rafId = 0;
  w = 1;
  h = 1;
  dpr = 1;
  cam = { target: [0, 0.95, 0] as V3, yaw: 0.6, pitch: 0.16, dist: 4.6 };
  /** 現在ポーズでのボーンのワールド行列（オーバーレイ描画・ピッキング用） */
  boneWorld: M4[] = [];
  /** 2Dオーバーレイに追加で描くもの（ギズモ・選択枠など） */
  onOverlay: ((ctx: CanvasRenderingContext2D) => void) | null = null;

  constructor(el: HTMLElement) {
    this.el = el;
    this.glCanvas = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.glCanvas.className = 'vp-gl';
    this.overlay.className = 'vp-overlay';
    el.append(this.glCanvas, this.overlay);
    THREE.ColorManagement.enabled = false;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.glCanvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.autoClear = false;
    this.sceneMain.add(this.meshGroup, this.boneGroup);
    this.sceneOverlay.add(this.editGroup);
    this.grid = this.makeGrid();
    this.sceneOverlay.add(this.grid);
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat));

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    subscribe((ch) => {
      if (ch.has('doc') || ch.has('mode')) this.needRebuild = true;
      if (ch.has('tex')) this.syncTextures();
      if (ch.has('doc') || ch.has('sel') || ch.has('mode') || ch.has('view')) this.needOverlay = true;
      if (ch.has('view')) this.needRebuild = true;
      this.invalidate();
    });
  }

  get camera(): THREE.Camera {
    return state.view.ortho ? this.ortho : this.persp;
  }

  invalidate(): void {
    this.dirty = true;
    if (!this.rafId)
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0;
        if (this.dirty) this.render();
      });
  }

  private resize(): void {
    const r = this.el.getBoundingClientRect();
    this.w = Math.max(1, Math.round(r.width));
    this.h = Math.max(1, Math.round(r.height));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.w, this.h, false);
    this.overlay.width = Math.round(this.w * this.dpr);
    this.overlay.height = Math.round(this.h * this.dpr);
    for (const m of this.lineMats) m.resolution.set(this.w, this.h);
    this.invalidate();
  }

  private makeGrid(): THREE.LineSegments {
    const pos: number[] = [];
    const col: number[] = [];
    const N = 10,
      step = 0.25;
    const push = (a: V3, b: V3, c: number[]) => {
      pos.push(...a, ...b);
      col.push(...c, ...c);
    };
    for (let i = -N; i <= N; i++) {
      const x = i * step;
      const major = i % 4 === 0;
      const c = major ? [0.42, 0.44, 0.56] : [0.3, 0.32, 0.43];
      if (i !== 0) {
        push([x, 0, -N * step], [x, 0, N * step], c);
        push([-N * step, 0, x], [N * step, 0, x], c);
      }
    }
    push([-N * step, 0, 0], [N * step, 0, 0], [0.85, 0.3, 0.3]);
    push([0, 0, -N * step], [0, 0, N * step], [0.3, 0.45, 0.9]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
  }

  // ---------- シーン構築 ----------

  private disposeGroup(g: THREE.Group): void {
    for (const c of [...g.children]) {
      g.remove(c);
      const m = c as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    }
  }

  private rebuild(): void {
    this.needRebuild = false;
    const doc = state.doc;
    this.disposeGroup(this.meshGroup);
    this.boneGroup.clear();
    for (const t of this.textures) t.dispose();
    this.textures = doc.textures.map((t) => buildTexture(t, state.view.smoothTex));
    this.meshes = [];
    const hasBones = doc.bones.length > 0;
    let skeleton: THREE.Skeleton | null = null;
    this.bones = [];
    if (hasBones) {
      const b = buildBones(doc);
      this.bones = b.bones;
      for (const r of b.roots) this.boneGroup.add(r);
      this.boneGroup.updateMatrixWorld(true);
      skeleton = new THREE.Skeleton(this.bones);
    }
    const weightView = state.mode === 'rig' && state.view.weights;
    doc.objects.forEach((o, index) => {
      if (!o.visible) return;
      const { geo } = buildGeometry(o, {
        smooth: state.view.shade === 'smooth',
        staticBone: hasBones ? doc.bones.length : -1,
        weightColors: weightView,
      });
      const op = weightView ? 1 : (o.opacity ?? 1);
      const mat = makePs1Material(this.shared, weightView ? null : (this.textures[o.tex] ?? null), o.doubleSided, op);
      let mesh: THREE.Mesh;
      if (skeleton) {
        const sm = new THREE.SkinnedMesh(geo, mat);
        sm.bind(skeleton, new THREE.Matrix4());
        mesh = sm;
      } else mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      if (op < 1) mesh.renderOrder = 1;
      this.meshGroup.add(mesh);
      this.meshes.push({ obj: o, index, mesh });
    });
  }

  private syncTextures(): void {
    const doc = state.doc;
    if (doc.textures.length !== this.textures.length) {
      this.needRebuild = true;
      return;
    }
    doc.textures.forEach((t, i) => {
      const tt = this.textures[i];
      const img = tt.image as { data: unknown; width: number; height: number };
      if (img.width !== t.w || img.height !== t.h) {
        this.needRebuild = true;
        return;
      }
      img.data = t.data;
      tt.needsUpdate = true;
    });
  }

  private applyPose(): void {
    const doc = state.doc;
    const pose = currentPose();
    this.boneWorld = worldMatrices(doc.bones, pose);
    if (this.bones.length !== doc.bones.length + 1) return;
    pose.forEach((p, i) => {
      const b = this.bones[i];
      b.position.fromArray(p.pos);
      b.quaternion.fromArray(p.rot);
      b.scale.fromArray(p.scl);
    });
    this.boneGroup.updateMatrixWorld(true);
  }

  private lineMat(color: number, width: number, opacity = 1): LineMaterial {
    const m = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthWrite: false });
    m.resolution.set(this.w, this.h);
    this.lineMats.push(m);
    return m;
  }

  private rebuildOverlay(): void {
    this.needOverlay = false;
    this.disposeGroup(this.editGroup);
    this.lineMats = [];
    this.grid.visible = state.view.grid;
    const o = activeObject();
    const mode = state.mode;
    if (!o || !o.visible || mode === 'anim') return;
    const sel = state.sel;
    const showVerts = sel.mode === 'vert' && (mode === 'model' || (mode === 'rig' && state.tool.rig === 'weights'));
    const ef = edgeFaces(o);

    if (state.view.wire) {
      const pos: number[] = [];
      for (const k of ef.keys()) {
        const [a, b] = parseEdge(k);
        pos.push(...o.verts[a], ...o.verts[b]);
      }
      if (pos.length) {
        const g = new LineSegmentsGeometry();
        g.setPositions(pos);
        this.editGroup.add(new LineSegments2(g, this.lineMat(0x0a0a14, 1.1, mode === 'model' ? 0.75 : 0.4)));
      }
    }
    // 選択面
    if (sel.mode === 'face' && sel.faces.size) {
      const pos: number[] = [];
      for (const fi of sel.faces) {
        const f = o.faces[fi];
        if (!f) continue;
        for (let k = 1; k < f.v.length - 1; k++) pos.push(...o.verts[f.v[0]], ...o.verts[f.v[k]], ...o.verts[f.v[k + 1]]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.MeshBasicMaterial({
        color: SEL_COLOR,
        transparent: true,
        opacity: mode === 'texture' ? 0.18 : 0.38,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.editGroup.add(new THREE.Mesh(g, m));
      const lp: number[] = [];
      for (const fi of sel.faces) {
        const f = o.faces[fi];
        if (!f) continue;
        for (let i = 0; i < f.v.length; i++) lp.push(...o.verts[f.v[i]], ...o.verts[f.v[(i + 1) % f.v.length]]);
      }
      if (lp.length) {
        const lg = new LineSegmentsGeometry();
        lg.setPositions(lp);
        this.editGroup.add(new LineSegments2(lg, this.lineMat(SEL_COLOR, 2)));
      }
    }
    if (sel.mode === 'edge' && sel.edges.size) {
      const lp: number[] = [];
      for (const k of sel.edges) {
        const [a, b] = parseEdge(k);
        if (o.verts[a] && o.verts[b]) lp.push(...o.verts[a], ...o.verts[b]);
      }
      if (lp.length) {
        const lg = new LineSegmentsGeometry();
        lg.setPositions(lp);
        this.editGroup.add(new LineSegments2(lg, this.lineMat(SEL_COLOR, 3)));
      }
    }
    if (showVerts) {
      const pos = new Float32Array(o.verts.length * 3);
      const col = new Float32Array(o.verts.length * 3);
      const sc = new THREE.Color(SEL_COLOR);
      o.verts.forEach((p, i) => {
        pos.set(p, i * 3);
        if (sel.verts.has(i)) col.set([sc.r, sc.g, sc.b], i * 3);
        else if (mode === 'rig') col.set(o.skin[i]?.length ? boneColor(o.skin[i][0][0]) : [0.2, 0.2, 0.2], i * 3);
        else col.set([0.04, 0.04, 0.08], i * 3);
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.PointsMaterial({ size: 7 * this.dpr, sizeAttenuation: false, vertexColors: true });
      this.editGroup.add(new THREE.Points(g, m));
    }
  }

  // ---------- カメラ ----------

  eye(): V3 {
    const { target, yaw, pitch, dist } = this.cam;
    const cp = Math.cos(pitch);
    return [target[0] + dist * cp * Math.sin(yaw), target[1] + dist * Math.sin(pitch), target[2] + dist * cp * Math.cos(yaw)];
  }

  private updateCamera(): void {
    const { target, dist } = this.cam;
    const e = this.eye();
    const aspect = this.w / this.h;
    const near = Math.max(0.01, dist / 100),
      far = Math.max(50, dist * 40);
    for (const c of [this.persp, this.ortho] as THREE.Camera[]) {
      c.position.set(e[0], e[1], e[2]);
      c.up.set(0, 1, 0);
      c.lookAt(target[0], target[1], target[2]);
      c.updateMatrixWorld(true);
    }
    this.persp.aspect = aspect;
    this.persp.near = near;
    this.persp.far = far;
    this.persp.updateProjectionMatrix();
    const hh = dist * Math.tan((this.persp.fov * Math.PI) / 360);
    this.ortho.left = -hh * aspect;
    this.ortho.right = hh * aspect;
    this.ortho.top = hh;
    this.ortho.bottom = -hh;
    this.ortho.near = -far;
    this.ortho.far = far;
    this.ortho.updateProjectionMatrix();
  }

  /** カメラの右・上・前（視線）方向 */
  basis(): { right: V3; up: V3; fwd: V3 } {
    const e = this.eye();
    const fwd = norm(sub(this.cam.target, e));
    let right = norm(cross(fwd, [0, 1, 0]));
    if (right[0] === 0 && right[1] === 0 && right[2] === 0) right = [1, 0, 0];
    const up = norm(cross(right, fwd));
    return { right, up, fwd };
  }

  orbit(dx: number, dy: number): void {
    this.cam.yaw -= dx * 0.008;
    this.cam.pitch = Math.max(-1.55, Math.min(1.55, this.cam.pitch + dy * 0.008));
    this.invalidate();
  }

  pan(dx: number, dy: number): void {
    const { right, up } = this.basis();
    const k = (2 * this.cam.dist * Math.tan((this.persp.fov * Math.PI) / 360)) / this.h;
    this.cam.target = add(this.cam.target, add(mul(right, -dx * k), mul(up, dy * k)));
    this.invalidate();
  }

  zoom(factor: number): void {
    this.cam.dist = Math.max(0.05, Math.min(500, this.cam.dist * factor));
    this.invalidate();
  }

  setView(name: 'front' | 'back' | 'right' | 'left' | 'top' | 'bottom'): void {
    const v = { front: [0, 0], back: [Math.PI, 0], right: [Math.PI / 2, 0], left: [-Math.PI / 2, 0], top: [0, 1.55], bottom: [0, -1.55] }[name];
    this.cam.yaw = v[0];
    this.cam.pitch = v[1];
    this.invalidate();
  }

  /** 全体（または選択）が収まるようにカメラを合わせる */
  frame(points?: V3[]): void {
    let pts = points;
    if (!pts || pts.length === 0) {
      pts = [];
      for (const o of state.doc.objects) if (o.visible) for (const p of o.verts) pts.push(p);
    }
    if (pts.length === 0) {
      this.cam.target = [0, 0.5, 0];
      this.cam.dist = 4;
      this.invalidate();
      return;
    }
    const mn: V3 = [Infinity, Infinity, Infinity],
      mx: V3 = [-Infinity, -Infinity, -Infinity];
    for (const p of pts)
      for (let i = 0; i < 3; i++) {
        mn[i] = Math.min(mn[i], p[i]);
        mx[i] = Math.max(mx[i], p[i]);
      }
    this.cam.target = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
    const r = Math.max(0.1, Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 2);
    this.cam.dist = (r / Math.tan((this.persp.fov * Math.PI) / 360)) * 1.15;
    this.invalidate();
  }

  // ---------- 投影・レイ ----------

  private tmp = new THREE.Vector3();

  /** ワールド座標 → ビューポート内のCSSピクセル。z はカメラからの奥行き（負なら背後） */
  project(p: V3): { x: number; y: number; z: number } {
    const cam = this.camera;
    this.tmp.set(p[0], p[1], p[2]).applyMatrix4(cam.matrixWorldInverse);
    const z = -this.tmp.z;
    this.tmp.applyMatrix4(cam.projectionMatrix);
    return { x: (this.tmp.x * 0.5 + 0.5) * this.w, y: (-this.tmp.y * 0.5 + 0.5) * this.h, z };
  }

  rayAt(x: number, y: number): Ray {
    const nx = (x / this.w) * 2 - 1,
      ny = -((y / this.h) * 2 - 1);
    const cam = this.camera;
    if (state.view.ortho) {
      const o = this.tmp.set(nx, ny, 0).unproject(cam);
      const origin: V3 = [o.x, o.y, o.z];
      const { fwd } = this.basis();
      return { o: sub(origin, mul(fwd, this.cam.dist * 20)), d: fwd };
    }
    const e = this.eye();
    const q = this.tmp.set(nx, ny, 0.5).unproject(cam);
    return { o: e, d: norm([q.x - e[0], q.y - e[1], q.z - e[2]]) };
  }

  /** 画面上の1ピクセルが、点 p の奥行きでワールド何単位に当たるか */
  pixelScale(p: V3): number {
    const fovK = 2 * Math.tan((this.persp.fov * Math.PI) / 360);
    if (state.view.ortho) return (this.cam.dist * fovK) / this.h;
    const z = Math.max(0.01, this.project(p).z);
    return (z * fovK) / this.h;
  }

  /** メッシュとレイの交差。only を指定するとそのオブジェクトだけ。positions でポーズ後の頂点を渡せる */
  raycast(ray: Ray, only = -1, positions?: (oi: number) => V3[], minT = 1e-6): Hit | null {
    let best: Hit | null = null;
    state.doc.objects.forEach((o, oi) => {
      if (!o.visible || (only >= 0 && oi !== only)) return;
      const P = positions ? positions(oi) : o.verts;
      o.faces.forEach((f, fi) => {
        const a = P[f.v[0]];
        for (let k = 1; k < f.v.length - 1; k++) {
          const b = P[f.v[k]],
            c = P[f.v[k + 1]];
          const e1 = sub(b, a),
            e2 = sub(c, a);
          const pv = cross(ray.d, e2);
          const det = dot(e1, pv);
          if (o.doubleSided || minT > 1e-6 ? Math.abs(det) < 1e-12 : det < 1e-12) continue;
          const inv = 1 / det;
          const tv = sub(ray.o, a);
          const u = dot(tv, pv) * inv;
          if (u < -1e-6 || u > 1 + 1e-6) continue;
          const qv = cross(tv, e1);
          const v = dot(ray.d, qv) * inv;
          if (v < -1e-6 || u + v > 1 + 1e-6) continue;
          const t = dot(e2, qv) * inv;
          if (t <= minT || (best && t >= best.t)) continue;
          const w = 1 - u - v;
          const ua = f.uv[0],
            ub = f.uv[k],
            uc = f.uv[k + 1];
          best = {
            obj: oi,
            face: fi,
            t,
            point: add(ray.o, mul(ray.d, t)),
            uv: [ua[0] * w + ub[0] * u + uc[0] * v, ua[1] * w + ub[1] * u + uc[1] * v],
          };
        }
      });
    });
    return best;
  }

  /**
   * 「見えているか」を何度も調べる時用（範囲選択など）。面を一度だけ画面に投影して升目に振り分けておき、
   * 各点はその升目の面とだけ比べる。大きなモデルで点ごとにレイを飛ばすと固まるため。
   */
  visibilityTester(only = -1, positions?: (oi: number) => V3[]): (p: V3) => boolean {
    const CELL = 32;
    const cols = Math.ceil(this.w / CELL) + 1,
      rows = Math.ceil(this.h / CELL) + 1;
    const bins: number[][] = Array.from({ length: cols * rows }, () => []);
    // 三角形ごとに [x0,y0,z0, x1,y1,z1, x2,y2,z2]
    const tris: number[] = [];
    state.doc.objects.forEach((o, oi) => {
      if (!o.visible || (only >= 0 && oi !== only)) return;
      const P = positions ? positions(oi) : o.verts;
      const sp = P.map((p) => this.project(p));
      for (const f of o.faces)
        for (let k = 1; k < f.v.length - 1; k++) {
          const a = sp[f.v[0]],
            b = sp[f.v[k]],
            c = sp[f.v[k + 1]];
          if (a.z <= 0 || b.z <= 0 || c.z <= 0) continue;
          const id = tris.length / 9;
          tris.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
          const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x) / CELL)),
            x1 = Math.min(cols - 1, Math.floor(Math.max(a.x, b.x, c.x) / CELL));
          const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y) / CELL)),
            y1 = Math.min(rows - 1, Math.floor(Math.max(a.y, b.y, c.y) / CELL));
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) bins[y * cols + x].push(id);
        }
    });
    return (p: V3) => {
      const s = this.project(p);
      if (s.z <= 0) return false;
      const cx = Math.floor(s.x / CELL),
        cy = Math.floor(s.y / CELL);
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return true;
      for (const id of bins[cy * cols + cx]) {
        const t = id * 9;
        const ax = tris[t], ay = tris[t + 1], az = tris[t + 2];
        const bx = tris[t + 3], by = tris[t + 4], bz = tris[t + 5];
        const qx = tris[t + 6], qy = tris[t + 7], qz = tris[t + 8];
        const det = (by - qy) * (ax - qx) + (qx - bx) * (ay - qy);
        if (Math.abs(det) < 1e-9) continue;
        const w0 = ((by - qy) * (s.x - qx) + (qx - bx) * (s.y - qy)) / det;
        const w1 = ((qy - ay) * (s.x - qx) + (ax - qx) * (s.y - qy)) / det;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        // 画面上で直線補間できるのは 1/奥行き
        const z = 1 / (w0 / az + w1 / bz + w2 / qz);
        if (z < s.z - Math.max(1e-4, s.z * 2e-3)) return false;
      }
      return true;
    };
  }

  /** 点 p が（アクティブオブジェクトの面に）隠されずに見えているか */
  isVisible(p: V3, only = -1): boolean {
    const s = this.project(p);
    if (s.z <= 0) return false;
    const ray = this.rayAt(s.x, s.y);
    const hit = this.raycast(ray, only);
    if (!hit) return true;
    const d = dot(sub(p, ray.o), ray.d);
    return hit.t >= d - Math.max(1e-4, d * 2e-3);
  }

  // ---------- 描画 ----------

  render(): void {
    this.dirty = false;
    if (this.needRebuild) this.rebuild();
    if (this.needOverlay) this.rebuildOverlay();
    this.updateCamera();
    this.applyPose();
    const v = state.view;
    const r = this.renderer;
    const cam = this.camera;
    this.shared.uJitter.value = v.jitter ? 1 : 0;
    this.shared.uAffine.value = v.affine ? 1 : 0;
    this.shared.uShade.value = v.shade === 'none' || (state.mode === 'rig' && v.weights) ? 0 : 1;
    this.shared.uAmbient.value = AMBIENT[v.light] ?? AMBIENT.soft;
    const bg = new THREE.Color(v.bg);
    r.setClearColor(bg, 1);
    if (v.res > 0) {
      const lh = v.res,
        lw = Math.max(1, Math.round((lh * this.w) / this.h));
      if (!this.rt || this.rt.width !== lw || this.rt.height !== lh) {
        this.rt?.dispose();
        this.rt = new THREE.WebGLRenderTarget(lw, lh, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true });
      }
      this.shared.uRes.value.set(lw, lh);
      r.setRenderTarget(this.rt);
      r.clear();
      r.render(this.sceneMain, cam);
      r.setRenderTarget(null);
      this.postMat.uniforms.uSrc.value = this.rt.texture;
      this.postMat.uniforms.uRes.value.set(lw, lh);
      this.postMat.uniforms.uDither.value = v.dither ? 1 : 0;
      r.clear();
      r.render(this.postScene, this.postCam);
    } else {
      this.shared.uRes.value.set(Math.round((240 * this.w) / this.h), 240);
      r.setRenderTarget(null);
      r.clear();
      r.render(this.sceneMain, cam);
    }
    // 編集用オーバーレイ（端末解像度）。まずメッシュの深度だけ描いて、隠れた線を消す
    r.clearDepth();
    const saved = this.meshes.map((m) => m.mesh.material);
    const sj = this.shared.uJitter.value;
    this.shared.uJitter.value = 0;
    for (const m of this.meshes) m.mesh.material = m.obj.doubleSided || state.view.xray ? this.depthMatDS : this.depthMat;
    if (!state.view.xray) r.render(this.sceneMain, cam);
    this.meshes.forEach((m, i) => (m.mesh.material = saved[i]));
    this.shared.uJitter.value = sj;
    r.render(this.sceneOverlay, cam);
    this.drawOverlay2D();
  }

  private drawOverlay2D(): void {
    const ctx = this.overlay.getContext('2d')!;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if ((state.mode === 'rig' || state.mode === 'anim') && state.view.bones) this.drawBones(ctx);
    this.onOverlay?.(ctx);
    this.drawTriad(ctx);
  }

  boneScreen(): { x: number; y: number; z: number }[] {
    return this.boneWorld.map((m) => this.project(mPos(m)));
  }

  private drawBones(ctx: CanvasRenderingContext2D): void {
    const bones = state.doc.bones;
    const sp = this.boneScreen();
    ctx.lineCap = 'round';
    bones.forEach((b, i) => {
      if (b.parent < 0 || !sp[b.parent]) return;
      const a = sp[b.parent],
        c = sp[i];
      if (a.z <= 0 || c.z <= 0) return;
      const active = state.activeBone === b.parent;
      // 親ジョイント側が太い楔形
      const dx = c.x - a.x,
        dy = c.y - a.y;
      const l = Math.hypot(dx, dy) || 1;
      const nx = (-dy / l) * 5,
        ny = (dx / l) * 5;
      ctx.beginPath();
      ctx.moveTo(a.x + nx, a.y + ny);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(a.x - nx, a.y - ny);
      ctx.closePath();
      ctx.fillStyle = active ? 'rgba(255,170,40,0.75)' : 'rgba(235,235,245,0.5)';
      ctx.strokeStyle = active ? '#fff' : 'rgba(10,10,20,0.9)';
      ctx.lineWidth = 1.25;
      ctx.fill();
      ctx.stroke();
    });
    bones.forEach((b, i) => {
      const c = sp[i];
      if (c.z <= 0) return;
      const active = state.activeBone === i;
      ctx.beginPath();
      ctx.arc(c.x, c.y, active ? 7 : 5, 0, Math.PI * 2);
      const bc = boneColor(i);
      ctx.fillStyle = active ? '#ffa018' : `rgb(${bc.map((x) => Math.round(x * 255)).join(',')})`;
      ctx.strokeStyle = active ? '#fff' : '#0a0a14';
      ctx.lineWidth = active ? 2 : 1.25;
      ctx.fill();
      ctx.stroke();
      if (active) {
        ctx.font = '600 12px system-ui, sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(b.name, c.x + 11, c.y - 9);
        ctx.fillStyle = '#fff';
        ctx.fillText(b.name, c.x + 11, c.y - 9);
      }
    });
  }

  private drawTriad(ctx: CanvasRenderingContext2D): void {
    const { right, up } = this.basis();
    const cx = 34,
      cy = this.h - 34,
      L = 20;
    const axes: [V3, string, string][] = [
      [[1, 0, 0], '#ff5a5a', 'X'],
      [[0, 1, 0], '#6fdc5a', 'Y'],
      [[0, 0, 1], '#5a8cff', 'Z'],
    ];
    ctx.lineWidth = 2;
    ctx.font = '700 10px system-ui, sans-serif';
    for (const [a, c, n] of axes) {
      const x = dot(a, right) * L,
        y = -dot(a, up) * L;
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + x, cy + y);
      ctx.stroke();
      ctx.fillText(n, cx + x * 1.3 - 3, cy + y * 1.3 + 3);
    }
  }

  /** 現在のビューをPNGにする（サムネイル・スクリーンショット用） */
  snapshot(): string {
    this.render();
    return this.glCanvas.toDataURL('image/png');
  }
}
