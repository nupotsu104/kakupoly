// テクスチャ（ドット絵）編集画面。UVの網目を重ねて表示し、UVツールで選択面のUVを動かせる。
// ペン/マウス = 描く、指 = 1本で移動・2本でズーム、ホイール = ズーム
import type { V2 } from '../core/types';
import { state, subscribe, notify, checkpoint, dropCheckpoint, activeObject, activeTexture } from '../state';
import { ctx as actx } from '../actions';
import { beginPaint, drawLine, drawRect, floodFill, getPixel, hexToRGBA, rgbaToHex, stamp, type RGBA } from '../core/paint';
import { selFaces, selectLinkedUV } from '../core/mesh-ops';
import { capture } from './dom';

interface Drag {
  id: number;
  kind: 'paint' | 'pan' | 'uv';
  last: [number, number] | null;
  start: [number, number];
  snapshot?: Uint8ClampedArray;
  changed: boolean;
  /** UV移動: 動かすコーナー [面, コーナー, 元u, 元v] */
  uvCorners?: [number, number, number, number][];
  startUV?: V2;
}

export class TextureEditor {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private img: HTMLCanvasElement = document.createElement('canvas');
  private zoom = 6;
  private ox = 0;
  private oy = 0;
  private fitted = -1;
  private drag: Drag | null = null;
  private touches = new Map<number, [number, number]>();
  private pinch: { d: number; mid: [number, number] } | null = null;
  private hover: [number, number] | null = null;
  private dpr = 1;
  private raf = 0;
  private imgDirty = true;
  private imgOf: unknown = null;
  private lastUvTap = 0;

  constructor(el: HTMLElement) {
    this.el = el;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'tex-canvas';
    this.canvas.style.touchAction = 'none';
    el.append(this.canvas);
    new ResizeObserver(() => this.invalidate()).observe(el);
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e));
    c.addEventListener('pointerleave', () => ((this.hover = null), this.invalidate()));
    c.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const t of ['gesturestart', 'gesturechange']) c.addEventListener(t, (e) => e.preventDefault());
    subscribe((ch) => {
      if (ch.has('tex') || ch.has('doc')) this.imgDirty = true;
      if (ch.has('tex') || ch.has('doc') || ch.has('sel') || ch.has('ui') || ch.has('mode')) this.invalidate();
    });
  }

  invalidate(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  fit(): void {
    const t = activeTexture();
    if (!t) return;
    const r = this.el.getBoundingClientRect();
    // 小さい画像はドットがそろうよう整数倍、大きい画像（元の大きさの写真など）は画面に収まるよう縮小
    const z = Math.min((r.width - 24) / t.w, (r.height - 24) / t.h);
    this.zoom = z >= 1 ? Math.floor(z) : z;
    this.ox = (r.width - t.w * this.zoom) / 2;
    this.oy = (r.height - t.h * this.zoom) / 2;
    this.invalidate();
  }

  private toTex(x: number, y: number): [number, number] {
    return [(x - this.ox) / this.zoom, (y - this.oy) / this.zoom];
  }

  private local(e: PointerEvent | WheelEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ---------------- 描画 ----------------

  private render(): void {
    const r = this.el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(r.width * this.dpr),
      H = Math.round(r.height * this.dpr);
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }
    const g = this.canvas.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#1b1d29';
    g.fillRect(0, 0, r.width, r.height);
    const t = activeTexture();
    if (!t) {
      g.fillStyle = '#9aa0b8';
      g.font = '14px system-ui, sans-serif';
      g.fillText('テクスチャがありません。右の「新規」か「画像を読み込む」で作成できます。', 16, 28);
      return;
    }
    if (this.fitted !== t.id) {
      this.fitted = t.id;
      this.fit();
      return;
    }
    // 画像
    if (this.img.width !== t.w || this.img.height !== t.h) {
      this.img.width = t.w;
      this.img.height = t.h;
    }
    if (this.imgDirty || this.imgOf !== t) {
      this.img.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(t.data), t.w, t.h), 0, 0);
      this.imgDirty = false;
      this.imgOf = t;
    }
    const z = this.zoom;
    // 透明部分の市松模様
    g.save();
    g.beginPath();
    g.rect(this.ox, this.oy, t.w * z, t.h * z);
    g.clip();
    const cs = Math.max(4, z);
    for (let y = 0; y < t.h * z; y += cs)
      for (let x = 0; x < t.w * z; x += cs) {
        g.fillStyle = ((x / cs + y / cs) & 1) === 0 ? '#3a3d4d' : '#2c2f3c';
        g.fillRect(this.ox + x, this.oy + y, cs, cs);
      }
    g.restore();
    g.imageSmoothingEnabled = false;
    g.drawImage(this.img, this.ox, this.oy, t.w * z, t.h * z);
    // ピクセル格子
    if (z >= 8) {
      g.strokeStyle = 'rgba(0,0,0,0.18)';
      g.lineWidth = 1;
      g.beginPath();
      for (let x = 0; x <= t.w; x++) {
        g.moveTo(Math.round(this.ox + x * z) + 0.5, this.oy);
        g.lineTo(Math.round(this.ox + x * z) + 0.5, this.oy + t.h * z);
      }
      for (let y = 0; y <= t.h; y++) {
        g.moveTo(this.ox, Math.round(this.oy + y * z) + 0.5);
        g.lineTo(this.ox + t.w * z, Math.round(this.oy + y * z) + 0.5);
      }
      g.stroke();
    }
    // 8ピクセルごとの目安線
    if (z >= 3) {
      g.strokeStyle = 'rgba(255,255,255,0.08)';
      g.beginPath();
      for (let x = 0; x <= t.w; x += 8) {
        g.moveTo(this.ox + x * z + 0.5, this.oy);
        g.lineTo(this.ox + x * z + 0.5, this.oy + t.h * z);
      }
      for (let y = 0; y <= t.h; y += 8) {
        g.moveTo(this.ox, this.oy + y * z + 0.5);
        g.lineTo(this.ox + t.w * z, this.oy + y * z + 0.5);
      }
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.strokeRect(this.ox - 0.5, this.oy - 0.5, t.w * z + 1, t.h * z + 1);
    // UV の網目
    const o = activeObject();
    if (o && state.showUV && o.tex === state.activeTex) {
      const sel = state.mode === 'texture' || state.sel.mode === 'face' ? selFaces(o, state.sel) : new Set<number>();
      const P = (uv: V2): [number, number] => [this.ox + uv[0] * t.w * z, this.oy + uv[1] * t.h * z];
      const unselected = new Path2D();
      o.faces.forEach((f, fi) => {
        if (sel.has(fi)) return;
        f.uv.forEach((uv, i) => {
          const p = P(uv);
          if (i === 0) unselected.moveTo(p[0], p[1]);
          else unselected.lineTo(p[0], p[1]);
        });
        unselected.closePath();
      });
      // 明るい縁の上に暗い線（白い画像でも暗い画像でも見える）
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(255,255,255,0.35)';
      g.stroke(unselected);
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(20,20,50,0.55)';
      g.stroke(unselected);
      g.strokeStyle = '#ffa018';
      g.fillStyle = 'rgba(255,160,24,0.15)';
      g.lineWidth = 1.5;
      for (const fi of sel) {
        const f = o.faces[fi];
        if (!f) continue;
        g.beginPath();
        f.uv.forEach((uv, i) => {
          const p = P(uv);
          if (i === 0) g.moveTo(p[0], p[1]);
          else g.lineTo(p[0], p[1]);
        });
        g.closePath();
        g.fill();
        g.stroke();
      }
      if (state.tool.texture === 'uv') {
        g.fillStyle = '#ffa018';
        for (const fi of sel) for (const uv of o.faces[fi]?.uv ?? []) {
          const p = P(uv);
          g.fillRect(p[0] - 3, p[1] - 3, 6, 6);
        }
      }
    }
    // ホバー中（Apple Pencil のホバー含む）のピクセル
    if (this.hover && state.tool.texture !== 'uv') {
      const [hx, hy] = this.hover.map(Math.floor);
      const s = state.brushSize,
        off = Math.floor((s - 1) / 2);
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.strokeRect(this.ox + (hx - off) * z, this.oy + (hy - off) * z, s * z, s * z);
      g.strokeStyle = 'rgba(0,0,0,0.7)';
      g.strokeRect(this.ox + (hx - off) * z - 1.5, this.oy + (hy - off) * z - 1.5, s * z + 3, s * z + 3);
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillRect(4, r.height - 22, 92, 18);
      g.fillStyle = '#fff';
      g.font = '11px ui-monospace, monospace';
      g.fillText(`${hx}, ${hy}`, 8, r.height - 9);
    }
  }

  // ---------------- 入力 ----------------

  private down(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (e.pointerType === 'touch' && !this.drag) {
      capture(this.canvas, e.pointerId);
      this.touches.set(e.pointerId, [x, y]);
      this.updatePinch();
      return;
    }
    if (this.drag) return;
    capture(this.canvas, e.pointerId);
    if ((e.pointerType === 'mouse' && e.button !== 0) || actx.held.has('hold-pan') || actx.held.has('hold-orbit')) {
      this.drag = { id: e.pointerId, kind: 'pan', last: [x, y], start: [x, y], changed: false };
      return;
    }
    const t = activeTexture();
    if (!t) return;
    const tp = this.toTex(x, y);
    if (state.tool.texture === 'uv') {
      this.beginUV(e.pointerId, tp, e.timeStamp);
      return;
    }
    this.drag = { id: e.pointerId, kind: 'paint', last: null, start: [Math.floor(tp[0]), Math.floor(tp[1])], changed: false };
    this.paint(tp, true);
  }

  private move(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (this.touches.has(e.pointerId)) {
      const prev = this.touches.get(e.pointerId)!;
      this.touches.set(e.pointerId, [x, y]);
      if (this.touches.size === 1) {
        this.ox += x - prev[0];
        this.oy += y - prev[1];
      } else this.updatePinch(true);
      this.invalidate();
      return;
    }
    this.hover = this.toTex(x, y);
    const d = this.drag;
    if (!d || d.id !== e.pointerId) {
      this.invalidate();
      return;
    }
    if (d.kind === 'pan') {
      this.ox += x - d.last![0];
      this.oy += y - d.last![1];
      d.last = [x, y];
    } else if (d.kind === 'paint') {
      const evs = e.getCoalescedEvents?.() ?? [];
      if (evs.length > 1) for (const ce of evs) this.paint(this.toTex(...this.local(ce)), false);
      else this.paint(this.toTex(x, y), false);
    } else if (d.kind === 'uv') this.moveUV(this.toTex(x, y));
    this.invalidate();
  }

  private up(e: PointerEvent): void {
    if (this.touches.has(e.pointerId)) {
      this.touches.delete(e.pointerId);
      this.updatePinch();
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    if (d.kind === 'paint' || d.kind === 'uv') {
      if (d.changed) notify(d.kind === 'uv' ? 'doc' : 'tex', 'ui');
      else if (d.snapshot !== undefined || d.kind === 'uv') dropCheckpoint();
    }
  }

  private updatePinch(apply = false): void {
    const pts = [...this.touches.values()];
    if (pts.length < 2) {
      this.pinch = null;
      return;
    }
    const d = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
    const mid: [number, number] = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    if (apply && this.pinch) {
      this.zoomAt(mid[0], mid[1], d / this.pinch.d);
      this.ox += mid[0] - this.pinch.mid[0];
      this.oy += mid[1] - this.pinch.mid[1];
    }
    this.pinch = { d, mid };
  }

  private zoomAt(x: number, y: number, f: number): void {
    const nz = Math.max(0.05, Math.min(64, this.zoom * f));
    const k = nz / this.zoom;
    this.ox = x - (x - this.ox) * k;
    this.oy = y - (y - this.oy) * k;
    this.zoom = nz;
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    const [x, y] = this.local(e);
    this.zoomAt(x, y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    this.invalidate();
  }

  // ---------------- 描く ----------------

  private paint(tp: [number, number], first: boolean): void {
    const t = activeTexture();
    const d = this.drag;
    if (!t || !d) return;
    const px = Math.floor(tp[0]),
      py = Math.floor(tp[1]);
    const tool = actx.held.has('hold-picker') ? 'picker' : state.tool.texture;
    if (tool === 'picker') {
      if (px >= 0 && py >= 0 && px < t.w && py < t.h) {
        const c = getPixel(t, px, py);
        if (c[3] > 0) {
          state.color = rgbaToHex(c);
          notify('ui');
        }
      }
      return;
    }
    if (first) {
      checkpoint();
      beginPaint(t);
      d.snapshot = new Uint8ClampedArray(t.data);
    }
    const c: RGBA = tool === 'eraser' ? [0, 0, 0, 0] : hexToRGBA(state.color);
    if (tool === 'fill') {
      if (first && floodFill(t, px, py, c) > 0) d.changed = true;
    } else if (tool === 'line' || tool === 'rect') {
      t.data.set(d.snapshot!);
      if (tool === 'line') drawLine(t, d.start[0], d.start[1], px, py, state.brushSize, c);
      else drawRect(t, d.start[0], d.start[1], px, py, c, state.rectFill);
      d.changed = true;
    } else {
      if (d.last) drawLine(t, d.last[0], d.last[1], px, py, state.brushSize, c);
      else stamp(t, px, py, state.brushSize, c);
      d.last = [px, py];
      d.changed = true;
    }
    notify('tex');
  }

  // ---------------- UV ----------------

  private beginUV(id: number, tp: [number, number], at: number): void {
    const t = activeTexture()!;
    const o = activeObject();
    if (!o) return;
    const uv: V2 = [tp[0] / t.w, tp[1] / t.h];
    // 素早く2回タップしたら、そこの UV の島を丸ごと選ぶ。
    // 間隔は「タップした時刻」で測る（重いモデルで処理が遅れても、素早いタップを取りこぼさないように）
    const now = at;
    const last = this.lastUvTap;
    this.lastUvTap = now;
    if (now - last < 450) {
      const hit = o.faces.findIndex((f) => pointInPoly(uv, f.uv));
      if (hit >= 0) {
        // 「追加」の時は、今の選択に島を足す（左右の目など、離れた島をまとめて選べるように）
        const adding = actx.held.has('hold-add') || state.selOp === 'add';
        const keep = adding && state.sel.mode === 'face' ? new Set(state.sel.faces) : new Set<number>();
        state.sel.mode = 'face';
        state.sel.verts.clear();
        state.sel.edges.clear();
        state.sel.faces.clear();
        state.sel.faces.add(hit);
        selectLinkedUV(o, state.sel);
        for (const fi of keep) state.sel.faces.add(fi);
        this.lastUvTap = 0;
        notify('sel', 'ui');
        return;
      }
    }
    const sel = selFaces(o, state.sel);
    // 1) 選択面の頂点の近くなら、その頂点（同じ位置を共有するコーナー全部）を動かす
    const tol = 10 / (this.zoom * t.w);
    let target: V2 | null = null;
    let best = tol;
    for (const fi of sel)
      for (const p of o.faces[fi].uv) {
        const dd = Math.hypot(p[0] - uv[0], (p[1] - uv[1]) * (t.h / t.w));
        if (dd < best) {
          best = dd;
          target = p;
        }
      }
    const corners: [number, number, number, number][] = [];
    if (target) {
      for (const fi of sel)
        o.faces[fi].uv.forEach((p, ci) => {
          if (Math.abs(p[0] - target![0]) < 1e-6 && Math.abs(p[1] - target![1]) < 1e-6) corners.push([fi, ci, p[0], p[1]]);
        });
    } else {
      // 2) 選択面の内側なら選択面全体を動かす
      const inside = [...sel].some((fi) => pointInPoly(uv, o.faces[fi].uv));
      if (inside) for (const fi of sel) o.faces[fi].uv.forEach((p, ci) => corners.push([fi, ci, p[0], p[1]]));
      else {
        // 3) それ以外は、そこにある面を選ぶ
        const hit = o.faces.findIndex((f) => pointInPoly(uv, f.uv));
        if (state.sel.mode !== 'face') state.sel.mode = 'face';
        if (!(actx.held.has('hold-add') || state.selOp === 'add')) state.sel.faces.clear();
        if (hit >= 0) state.sel.faces.add(hit);
        state.sel.verts.clear();
        state.sel.edges.clear();
        notify('sel', 'ui');
        return;
      }
    }
    checkpoint();
    this.drag = { id, kind: 'uv', last: null, start: tp, changed: false, uvCorners: corners, startUV: uv };
  }

  private moveUV(tp: [number, number]): void {
    const t = activeTexture()!;
    const o = activeObject();
    const d = this.drag!;
    if (!o || !d.uvCorners) return;
    let du = tp[0] / t.w - d.startUV![0],
      dv = tp[1] / t.h - d.startUV![1];
    if (state.uvSnap) {
      // ピクセルの角に吸着（PS1のUVも整数座標）
      du = Math.round(du * t.w) / t.w;
      dv = Math.round(dv * t.h) / t.h;
    }
    for (const [fi, ci, u, v] of d.uvCorners) o.faces[fi].uv[ci] = [u + du, v + dv];
    d.changed = du !== 0 || dv !== 0;
    notify('doc');
  }
}

function pointInPoly(p: V2, poly: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i],
      b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
