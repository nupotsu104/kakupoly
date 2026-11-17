// 3Dビューの入力。
//  Apple Pencil / マウス左 … 編集（選択・ギズモ・描画）
//  指 … 視点操作（1本:回転 / 2本:ズーム＋移動 / 2本タップ:取り消し / 3本タップ:やり直し）
//  マウス右・中 … 視点回転（Shift で移動）、ホイール … ズーム
//  キー押しっぱなし（TourBox の Tall/Side 等）… ペンのドラッグを視点操作に変える
import type { V2, V3 } from '../core/types';
import { parseEdge } from '../core/types';
import { state, notify, checkpoint, dropCheckpoint, activeObject, currentPose } from '../state';
import { ctx as actx, runAction, warnSymmetry } from '../actions';
import { pencilSettings } from '../input/keymap';
import * as ops from '../core/mesh-ops';
import { hexToRgb } from '../core/doc';
import { addBone, skinnedPositions } from '../core/skeleton';
import { beginPaint, drawLine, floodFill, getPixel, hexToRGBA, rgbaToHex, stamp, uvToPixel, drawRect, type RGBA } from '../core/paint';
import { add, mul, dot, sub } from '../core/vec';
import { Viewport, type Ray } from './viewport';
import { drawGizmo, GizmoDrag, hitGizmo, type Handle } from './gizmo';
import { beginUndoableSession, endUndoableSession } from './transform';
import { toast, capture } from '../ui/dom';
import { symmetryMap, mirrorSelection, mirrorBone, mirrorV, pairBoneBase, SYM_EPS } from '../core/symmetry';

type Nav = 'orbit' | 'pan' | 'zoom';
interface Drag {
  id: number;
  kind: 'nav' | 'gizmo' | 'box' | 'paint' | 'vpaint' | 'joint' | 'tap';
  nav?: Nav;
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  moved: boolean;
  gizmo?: GizmoDrag;
  session?: ReturnType<typeof beginUndoableSession>;
  /** テクスチャ描画: 直前のピクセル */
  last?: { tex: number; x: number; y: number } | null;
  lastM?: { tex: number; x: number; y: number } | null;
  /** このストロークで書き換え用に複製済みのテクスチャ */
  begun?: Set<number>;
  shapeStart?: { tex: number; x: number; y: number; snapshot: Uint8ClampedArray } | null;
  changed?: boolean;
  pointerType: string;
  additive: 'set' | 'add' | 'sub';
}

const TAP_MOVE = 8;

export class Controls {
  private drag: Drag | null = null;
  private touches = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
  private touchGesture: { maxTouches: number; moved: boolean; start: number; lastDist: number; lastMid: V2 } | null = null;
  private penActiveUntil = 0;
  private hover: Handle | null = null;
  private hoverPt: V2 | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private lastTap: { t: number; x: number; y: number } | null = null;

  constructor(private vp: Viewport) {
    const el = vp.overlay;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('pointerleave', () => {
      this.hoverPt = null;
      this.vp.invalidate();
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // Safari のページ拡大ジェスチャーを止める
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) el.addEventListener(t, (e) => e.preventDefault());
    vp.onOverlay = (c) => this.drawOverlay(c);
  }

  private local(e: PointerEvent | WheelEvent): V2 {
    const r = this.vp.overlay.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private selOp(e: PointerEvent): 'set' | 'add' | 'sub' {
    if (actx.held.has('hold-sub') || e.altKey) return 'sub';
    if (actx.held.has('hold-add') || e.shiftKey) return 'add';
    return state.selOp;
  }

  private heldNav(): Nav | null {
    if (actx.held.has('hold-orbit')) return 'orbit';
    if (actx.held.has('hold-pan')) return 'pan';
    if (actx.held.has('hold-zoom')) return 'zoom';
    return null;
  }

  // ---------------- ポインタ ----------------

  private down(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (e.pointerType === 'touch') {
      // ペン使用中・直後の指は無視（手のひらの誤反応対策）
      if (this.drag?.pointerType === 'pen' || performance.now() < this.penActiveUntil) return;
      if (!(pencilSettings.fingerEdit && this.touches.size === 0 && !this.drag)) {
        this.touchDown(e, x, y);
        return;
      }
    }
    if (this.drag) return;
    if (e.pointerType === 'pen') this.penActiveUntil = performance.now() + 400;
    capture(this.vp.overlay, e.pointerId);
    const base = { id: e.pointerId, sx: x, sy: y, lx: x, ly: y, moved: false, pointerType: e.pointerType, additive: this.selOp(e) };
    // マウス右・中ボタン、または押しっぱなしキーで視点操作
    const held = this.heldNav();
    if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2)) {
      this.drag = { ...base, kind: 'nav', nav: e.shiftKey ? 'pan' : e.ctrlKey ? 'zoom' : 'orbit' };
      return;
    }
    if (held) {
      this.drag = { ...base, kind: 'nav', nav: held };
      return;
    }
    // ギズモ
    const h = hitGizmo(this.vp, x, y);
    if (h) {
      const s = beginUndoableSession();
      if (s) {
        this.drag = { ...base, kind: 'gizmo', session: s, gizmo: new GizmoDrag(this.vp, s, h, x, y) };
        this.hover = h;
        return;
      }
    }
    const mode = state.mode;
    const tool = state.tool[mode];
    if (mode === 'texture' && tool !== 'uv') {
      this.drag = { ...base, kind: 'paint', last: null, begun: new Set() };
      this.paintAt(x, y, true);
      return;
    }
    if (mode === 'model' && tool === 'vpaint') {
      checkpoint();
      this.drag = { ...base, kind: 'vpaint', changed: false };
      this.vpaintAt(x, y);
      return;
    }
    if (mode === 'rig' || mode === 'anim') {
      const j = this.pickJoint(x, y);
      if (j >= 0) {
        state.activeBone = j;
        notify('ui', 'view');
        if (mode === 'rig' && tool === 'bone-move') {
          const s = beginUndoableSession();
          if (s) {
            this.drag = { ...base, kind: 'gizmo', session: s, gizmo: new GizmoDrag(this.vp, s, { kind: 'move', axis: 3 }, x, y) };
            return;
          }
        }
        this.drag = { ...base, kind: 'tap' };
        return;
      }
      if (!(mode === 'rig' && tool === 'weights')) {
        // ボーン以外のドラッグは視点回転（ペンだけで完結できるように）
        this.drag = { ...base, kind: 'tap', nav: 'orbit' };
        return;
      }
    }
    this.drag = { ...base, kind: 'box' };
  }

  private move(e: PointerEvent): void {
    const [x, y] = this.local(e);
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touchMove(e, x, y);
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) {
      // ホバー（Apple Pencil のホバーもここに来る）
      this.hoverPt = [x, y];
      const h = hitGizmo(this.vp, x, y);
      if (h?.axis !== this.hover?.axis || h?.kind !== this.hover?.kind) this.hover = h;
      this.vp.invalidate();
      return;
    }
    if (e.pointerType === 'pen') this.penActiveUntil = performance.now() + 400;
    const dx = x - d.lx,
      dy = y - d.ly;
    if (!d.moved && Math.hypot(x - d.sx, y - d.sy) > TAP_MOVE) d.moved = true;
    d.lx = x;
    d.ly = y;
    this.hoverPt = [x, y];
    switch (d.kind) {
      case 'nav':
        this.navigate(d.nav!, dx, dy);
        break;
      case 'tap':
        if (d.moved && d.nav) this.navigate(d.nav, dx, dy);
        break;
      case 'gizmo':
        if (d.gizmo!.move(x, y)) d.changed = true;
        break;
      case 'box':
        if (d.moved) this.box = { x0: d.sx, y0: d.sy, x1: x, y1: y };
        this.vp.invalidate();
        break;
      case 'paint': {
        // 合体イベントで 240Hz の筆跡を拾う
        const evs = e.getCoalescedEvents?.() ?? [];
        if (evs.length > 1) for (const ce of evs) this.paintAt(...this.local(ce), false);
        else this.paintAt(x, y, false);
        break;
      }
      case 'vpaint':
        this.vpaintAt(x, y);
        break;
    }
  }

  private up(e: PointerEvent, cancel = false): void {
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touchUp(e, cancel);
      return;
    }
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    const [x, y] = this.local(e);
    switch (d.kind) {
      case 'gizmo':
        endUndoableSession(d.session!, !cancel && !!d.changed);
        break;
      case 'box':
        if (cancel) break;
        if (d.moved && this.box) this.boxSelect(this.box, d.additive);
        else {
          // 同じ所を素早く2回タップ → その立体（つながっている部分）を丸ごと選ぶ
          // 間隔は「タップした時刻」で測る（重いモデルで処理が遅れても取りこぼさないように）
          const now = e.timeStamp;
          const lt = this.lastTap;
          const dbl = state.mode === 'model' && lt && now - lt.t < 450 && Math.hypot(x - lt.x, y - lt.y) < 20;
          if (dbl) {
            this.lastTap = null;
            this.selectLinked();
          } else {
            this.lastTap = { t: now, x, y };
            this.tapSelect(x, y, d.additive);
          }
        }
        break;
      case 'tap':
        if (!d.moved && !cancel) this.tapRigAnim(x, y);
        break;
      case 'paint':
        this.endPaint(d);
        break;
      case 'vpaint':
        if (!d.changed) dropCheckpoint();
        else notify('doc', 'ui');
        break;
    }
    this.box = null;
    this.vp.invalidate();
  }

  private wheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey) this.vp.zoom(Math.exp(e.deltaY * 0.01));
    else if (e.shiftKey) this.vp.pan(-e.deltaX, -e.deltaY);
    else this.vp.zoom(Math.exp(e.deltaY * 0.0015));
  }

  private navigate(n: Nav, dx: number, dy: number): void {
    if (n === 'orbit') this.vp.orbit(dx, dy);
    else if (n === 'pan') this.vp.pan(dx, dy);
    else this.vp.zoom(Math.exp(dy * 0.008));
  }

  // ---------------- 指 ----------------

  private touchDown(e: PointerEvent, x: number, y: number): void {
    capture(this.vp.overlay, e.pointerId);
    this.touches.set(e.pointerId, { x, y, sx: x, sy: y, t: performance.now() });
    if (!this.touchGesture) this.touchGesture = { maxTouches: 0, moved: false, start: performance.now(), lastDist: 0, lastMid: [x, y] };
    const g = this.touchGesture;
    g.maxTouches = Math.max(g.maxTouches, this.touches.size);
    this.resetPinch();
  }

  private resetPinch(): void {
    const g = this.touchGesture;
    if (!g) return;
    const pts = [...this.touches.values()];
    if (pts.length >= 2) {
      g.lastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      g.lastMid = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
    }
  }

  private touchMove(e: PointerEvent, x: number, y: number): void {
    const t = this.touches.get(e.pointerId)!;
    const dx = x - t.x,
      dy = y - t.y;
    t.x = x;
    t.y = y;
    const g = this.touchGesture!;
    if (Math.hypot(x - t.sx, y - t.sy) > TAP_MOVE * 1.5) g.moved = true;
    const pts = [...this.touches.values()];
    if (pts.length === 1) {
      if (g.maxTouches === 1) this.vp.orbit(dx, dy);
    } else if (pts.length >= 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid: V2 = [(pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2];
      if (g.lastDist > 0 && dist > 0) this.vp.zoom(g.lastDist / dist);
      this.vp.pan(mid[0] - g.lastMid[0], mid[1] - g.lastMid[1]);
      g.lastDist = dist;
      g.lastMid = mid;
    }
  }

  private touchUp(e: PointerEvent, cancel: boolean): void {
    this.touches.delete(e.pointerId);
    const g = this.touchGesture;
    if (this.touches.size === 0 && g) {
      this.touchGesture = null;
      const quick = performance.now() - g.start < 350;
      if (!cancel && quick && !g.moved) {
        if (g.maxTouches === 2) runAction('undo');
        else if (g.maxTouches === 3) runAction('redo');
      }
    } else this.resetPinch();
  }

  // ---------------- 選択 ----------------

  private visibleFilter(oi: number): (p: V3) => boolean {
    if (state.view.xray) return () => true;
    // 面を一度だけ投影しておく方式（大きなモデルでも固まらない）
    return this.vp.visibilityTester(oi);
  }

  private tapSelect(x: number, y: number, op: 'set' | 'add' | 'sub'): void {
    const mode = state.mode;
    let selMode = state.sel.mode;
    if (mode === 'rig') selMode = 'vert';
    if (mode === 'texture') selMode = 'face';
    const ray = this.vp.rayAt(x, y);
    // 別のオブジェクトを触ったらそちらをアクティブに
    const any = this.vp.raycast(ray);
    let o = activeObject();
    if (any && any.obj !== state.activeObj && (!o || !this.vp.raycast(ray, state.activeObj) || this.vp.raycast(ray, state.activeObj)!.t > any.t + 1e-6)) {
      state.activeObj = any.obj;
      if (mode === 'texture') state.activeTex = Math.max(0, state.doc.objects[any.obj].tex);
      state.sel.verts.clear();
      state.sel.edges.clear();
      state.sel.faces.clear();
      o = activeObject();
      notify('sel', 'ui', 'tex');
      if (op === 'set' && selMode !== 'face') return;
    }
    if (!o) return;
    if (state.sel.mode !== selMode) ops.convertSelection(o, state.sel, selMode);
    const sel = state.sel;
    // 左右対称モードでは、反対側の同じ要素も一緒に選ぶ／外す
    const sym = this.symOn() ? symmetryMap(o) : null;
    const mirrorOf = (item: unknown): unknown =>
      !sym ? undefined : selMode === 'face' ? sym.face(item as number) : selMode === 'vert' ? sym.vert(item as number) : sym.edge(item as string);
    const apply = <T>(set: Set<T>, item: T | null) => {
      if (op === 'set') set.clear();
      if (item === null) return;
      const m = mirrorOf(item) as T | undefined;
      if (sym && m === undefined) warnSymmetry();
      const items = m !== undefined && m !== item ? [item, m] : [item];
      const removing = op === 'sub' || (op === 'add' && set.has(item));
      for (const it of items) removing ? set.delete(it) : set.add(it);
    };
    if (selMode === 'face') {
      const hit = this.vp.raycast(ray, state.activeObj);
      apply(sel.faces, hit ? hit.face : null);
    } else if (selMode === 'vert') {
      const vis = this.visibleFilter(state.activeObj);
      let best = -1,
        bd = 22;
      o.verts.forEach((p, i) => {
        const s = this.vp.project(p);
        if (s.z <= 0) return;
        const d = Math.hypot(s.x - x, s.y - y);
        if (d < bd && vis(p)) {
          bd = d;
          best = i;
        }
      });
      // Set は追加順を保つので、「選んだ順」に面を張れる
      apply(sel.verts, best >= 0 ? best : null);
    } else {
      const vis = this.visibleFilter(state.activeObj);
      let best: string | null = null,
        bd = 16;
      for (const k of ops.edgeFaces(o).keys()) {
        const [a, b] = parseEdge(k);
        const pa = this.vp.project(o.verts[a]),
          pb = this.vp.project(o.verts[b]);
        if (pa.z <= 0 || pb.z <= 0) continue;
        const d = segDist(x, y, pa.x, pa.y, pb.x, pb.y);
        if (d < bd) {
          const mid = mul(add(o.verts[a], o.verts[b]), 0.5);
          if (!vis(mid)) continue;
          bd = d;
          best = k;
        }
      }
      apply(sel.edges, best);
    }
    notify('sel', 'ui');
  }

  private boxSelect(b: { x0: number; y0: number; x1: number; y1: number }, op: 'set' | 'add' | 'sub'): void {
    const o = activeObject();
    if (!o) return;
    const mode = state.mode;
    let selMode = state.sel.mode;
    if (mode === 'rig') selMode = 'vert';
    if (mode === 'texture') selMode = 'face';
    if (state.sel.mode !== selMode) ops.convertSelection(o, state.sel, selMode);
    const x0 = Math.min(b.x0, b.x1),
      x1 = Math.max(b.x0, b.x1),
      y0 = Math.min(b.y0, b.y1),
      y1 = Math.max(b.y0, b.y1);
    const vis = this.visibleFilter(state.activeObj);
    const inside = o.verts.map((p) => {
      const s = this.vp.project(p);
      return s.z > 0 && s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
    });
    const visible = new Map<number, boolean>();
    const isVis = (i: number) => {
      let v = visible.get(i);
      if (v === undefined) {
        v = vis(o.verts[i]);
        visible.set(i, v);
      }
      return v;
    };
    const sel = state.sel;
    const apply = <T>(set: Set<T>, items: T[]) => {
      if (op === 'set') set.clear();
      for (const it of items) op === 'sub' ? set.delete(it) : set.add(it);
    };
    if (selMode === 'vert') apply(sel.verts, o.verts.map((_, i) => i).filter((i) => inside[i] && isVis(i)));
    else if (selMode === 'edge')
      apply(
        sel.edges,
        [...ops.edgeFaces(o).keys()].filter((k) => {
          const [a, c] = parseEdge(k);
          return inside[a] && inside[c] && (isVis(a) || isVis(c));
        }),
      );
    else
      apply(
        sel.faces,
        o.faces
          .map((_, i) => i)
          .filter((i) => {
            const f = o.faces[i];
            if (!f.v.every((v) => inside[v])) return false;
            if (state.view.xray) return true;
            return vis(ops.faceCenter(o, f)) || f.v.some(isVis);
          }),
      );
    if (this.symOn()) {
      if (op === 'sub') {
        // 外した要素の反対側も外す: 反対側の集合を作り直して差し引く
        const keep = { ...sel, verts: new Set(sel.verts), edges: new Set(sel.edges), faces: new Set(sel.faces) };
        const tmp = { mode: sel.mode, verts: new Set<number>(), edges: new Set<string>(), faces: new Set<number>() };
        const s = symmetryMap(o);
        for (const v of keep.verts) if (s.vert(v) !== undefined && !keep.verts.has(s.vert(v)!)) tmp.verts.add(v);
        for (const k of keep.edges) if (s.edge(k) && !keep.edges.has(s.edge(k)!)) tmp.edges.add(k);
        for (const f of keep.faces) if (s.face(f) !== undefined && !keep.faces.has(s.face(f)!)) tmp.faces.add(f);
        for (const v of tmp.verts) sel.verts.delete(v);
        for (const k of tmp.edges) sel.edges.delete(k);
        for (const f of tmp.faces) sel.faces.delete(f);
      } else mirrorSelection(o, sel);
    }
    notify('sel', 'ui');
  }

  private selectLinked(): void {
    const o = activeObject();
    if (!o || ops.selVerts(o, state.sel).size === 0) return;
    ops.selectLinked(o, state.sel);
    if (this.symOn()) mirrorSelection(o, state.sel);
    toast('つながっている部分を丸ごと選びました');
    notify('sel', 'ui');
  }

  /** 左右対称が効く場面か（アニメのポーズは左右別々に動かすので対象外） */
  private symOn(): boolean {
    return state.symmetryX && state.mode !== 'anim';
  }

  private mirrorRay(r: Ray): Ray {
    return { o: mirrorV(r.o), d: mirrorV(r.d) };
  }

  // ---------------- リグ・アニメ ----------------

  private pickJoint(x: number, y: number): number {
    if (!state.view.bones) return -1;
    const sp = this.vp.boneScreen();
    let best = -1,
      bd = 20;
    sp.forEach((p, i) => {
      if (p.z <= 0) return;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  private posedPositions(): (oi: number) => V3[] {
    if (state.mode !== 'anim' || !state.doc.bones.length) return (oi) => state.doc.objects[oi].verts;
    const pose = currentPose();
    const cache = new Map<number, V3[]>();
    return (oi) => {
      let p = cache.get(oi);
      if (!p) {
        p = skinnedPositions(state.doc, state.doc.objects[oi], pose);
        cache.set(oi, p);
      }
      return p;
    };
  }

  private tapRigAnim(x: number, y: number): void {
    const ray = this.vp.rayAt(x, y);
    if (state.mode === 'rig' && state.tool.rig === 'bone-add') {
      this.addBoneAt(ray);
      return;
    }
    // メッシュを触ったら、その部分を動かしているボーンを選ぶ
    const P = this.posedPositions();
    const hit = this.vp.raycast(ray, -1, P);
    if (!hit) {
      return;
    }
    const o = state.doc.objects[hit.obj];
    const f = o.faces[hit.face];
    const score = new Map<number, number>();
    for (const v of f.v) for (const [b, w] of o.skin[v] ?? []) score.set(b, (score.get(b) ?? 0) + w);
    let best = -1,
      bw = 0;
    for (const [b, w] of score)
      if (w > bw) {
        bw = w;
        best = b;
      }
    if (best >= 0) {
      state.activeBone = best;
      notify('ui', 'view');
    } else if (state.mode === 'anim') toast('この部分はどのボーンにも割り当てられていません');
  }

  private addBoneAt(ray: Ray): void {
    // メッシュに当たったら、入口と出口の中間（＝体の中心）に置く
    const h1 = this.vp.raycast(ray);
    let p: V3;
    if (h1) {
      const h2 = this.vp.raycast(ray, h1.obj, undefined, h1.t + 1e-4);
      p = h2 ? add(ray.o, mul(ray.d, (h1.t + h2.t) / 2)) : h1.point;
    } else {
      // 何もなければ注視点を通る画面に平行な面の上
      const { fwd } = this.vp.basis();
      const denom = dot(ray.d, fwd);
      const t = Math.abs(denom) > 1e-6 ? dot(sub(this.vp.cam.target, ray.o), fwd) / denom : this.vp.cam.dist;
      p = add(ray.o, mul(ray.d, t));
    }
    if (state.snap) p = p.map((v) => Math.round(v / state.gridStep) * state.gridStep) as V3;
    checkpoint();
    const doc = state.doc;
    if (this.symOn()) {
      // 中心近くなら中心線上に1本。そうでなければ左右に1本ずつ（名前は .L / .R）
      if (Math.abs(p[0]) < Math.max(state.gridStep * 0.5, SYM_EPS)) {
        p[0] = 0;
        state.activeBone = addBone(doc, state.activeBone, p);
      } else {
        const parent = state.activeBone;
        const mp = parent >= 0 ? mirrorBone(doc, parent) : -1;
        const base = pairBoneBase(doc);
        // キャラクターが +Z を向いているとき、+X 側がキャラクターの左（.L）
        const side = p[0] > 0 ? 'L' : 'R',
          other = side === 'L' ? 'R' : 'L';
        const a = addBone(doc, parent, p, `${base}.${side}`);
        addBone(doc, mp >= 0 ? mp : parent, mirrorV(p), `${base}.${other}`);
        state.activeBone = a;
      }
    } else state.activeBone = addBone(doc, state.activeBone, p);
    notify('doc', 'ui', 'pose');
  }

  // ---------------- 塗り ----------------

  private vpaintAt(x: number, y: number): void {
    const o = activeObject();
    const d = this.drag;
    if (!o || !d) return;
    const ray = this.vp.rayAt(x, y);
    this.vpaintRay(ray);
    if (this.symOn()) this.vpaintRay(this.mirrorRay(ray));
  }

  private vpaintRay(ray: Ray): void {
    const o = activeObject();
    const d = this.drag;
    if (!o || !d) return;
    const col = hexToRgb(state.color);
    const hit = this.vp.raycast(ray, state.activeObj);
    if (!hit) return;
    const f = o.faces[hit.face];
    if (state.sel.mode === 'vert') {
      // 当たった点に一番近いコーナーの頂点を、その頂点を使う全ての面で塗る
      let bi = 0,
        bd = Infinity;
      f.v.forEach((v, i) => {
        const dd = Math.hypot(...(sub(o.verts[v], hit.point) as [number, number, number]));
        if (dd < bd) {
          bd = dd;
          bi = i;
        }
      });
      const vi = f.v[bi];
      for (const ff of o.faces) ff.v.forEach((v, i) => v === vi && (ff.col[i] = [...col] as V3));
    } else f.col = f.v.map(() => [...col] as V3);
    d.changed = true;
    notify('doc');
  }

  private paintAt(x: number, y: number, first: boolean): void {
    const ray = this.vp.rayAt(x, y);
    this.paintRay(ray, first, false);
    const tool = state.tool.texture;
    // 直線・矩形は描き直しのたびに元画像へ戻すので、鏡写しは扱わない
    if (this.symOn() && !actx.held.has('hold-picker') && tool !== 'picker' && tool !== 'line' && tool !== 'rect') this.paintRay(this.mirrorRay(ray), first, true);
  }

  private paintRay(ray: Ray, first: boolean, mirrored: boolean): void {
    const d = this.drag;
    if (!d) return;
    const hit = this.vp.raycast(ray);
    if (!hit) return;
    const o = state.doc.objects[hit.obj];
    if (o.tex < 0 || !state.doc.textures[o.tex]) {
      if (first) toast('このオブジェクトにはテクスチャがありません（右の「テクスチャ」から作成）');
      return;
    }
    const tex = state.doc.textures[o.tex];
    const [px, py] = uvToPixel(tex, hit.uv[0], hit.uv[1]);
    const tool = actx.held.has('hold-picker') ? 'picker' : state.tool.texture;
    if (tool === 'picker') {
      const c = getPixel(tex, px, py);
      if (c[3] > 0) {
        state.color = rgbaToHex(c);
        notify('ui');
      }
      return;
    }
    if (!d.begun!.has(o.tex)) {
      // 最初に書き込むときだけ履歴を積み、ピクセル配列を複製する
      if (d.begun!.size === 0) checkpoint();
      beginPaint(tex);
      d.begun!.add(o.tex);
      if (state.activeTex !== o.tex) {
        state.activeTex = o.tex;
        notify('ui');
      }
    }
    const c: RGBA = tool === 'eraser' ? [0, 0, 0, 0] : hexToRGBA(state.color);
    if (tool === 'fill') {
      if (first && floodFill(tex, px, py, c) > 0) d.changed = true;
      if (first) d.shapeStart = null;
    } else if (tool === 'line' || tool === 'rect') {
      if (first) d.shapeStart = { tex: o.tex, x: px, y: py, snapshot: new Uint8ClampedArray(tex.data) };
      const s = d.shapeStart;
      if (s && s.tex === o.tex) {
        tex.data.set(s.snapshot);
        if (tool === 'line') drawLine(tex, s.x, s.y, px, py, state.brushSize, c);
        else drawRect(tex, s.x, s.y, px, py, c, state.rectFill);
        d.changed = true;
      }
    } else {
      const last = mirrored ? d.lastM : d.last;
      // 同じテクスチャ上で近ければ線でつなぐ（UVの継ぎ目を飛び越える時はつながない）
      if (last && last.tex === o.tex && Math.abs(last.x - px) + Math.abs(last.y - py) <= Math.max(8, tex.w / 8)) drawLine(tex, last.x, last.y, px, py, state.brushSize, c);
      else stamp(tex, px, py, state.brushSize, c);
      d.changed = true;
      if (mirrored) d.lastM = { tex: o.tex, x: px, y: py };
      else d.last = { tex: o.tex, x: px, y: py };
    }
    notify('tex');
  }

  private endPaint(d: Drag): void {
    if (!d.begun?.size) return;
    if (!d.changed) dropCheckpoint();
    notify('tex', 'ui');
  }

  // ---------------- オーバーレイ ----------------

  /** 左右対称モードの鏡の面（X=0）を薄く表示 */
  private drawSymmetryPlane(c: CanvasRenderingContext2D): void {
    let y0 = Infinity,
      y1 = -Infinity,
      z0 = Infinity,
      z1 = -Infinity;
    for (const o of state.doc.objects)
      if (o.visible)
        for (const p of o.verts) {
          y0 = Math.min(y0, p[1]);
          y1 = Math.max(y1, p[1]);
          z0 = Math.min(z0, p[2]);
          z1 = Math.max(z1, p[2]);
        }
    if (!isFinite(y0)) {
      y0 = 0;
      y1 = 1;
      z0 = -0.5;
      z1 = 0.5;
    }
    const m = Math.max(0.1, (y1 - y0) * 0.12);
    const pts = (
      [
        [0, y0 - m, z0 - m],
        [0, y1 + m, z0 - m],
        [0, y1 + m, z1 + m],
        [0, y0 - m, z1 + m],
      ] as V3[]
    ).map((p) => this.vp.project(p));
    if (pts.some((p) => p.z <= 0)) return;
    c.save();
    c.beginPath();
    pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
    c.closePath();
    c.fillStyle = 'rgba(255, 90, 200, 0.07)';
    c.fill();
    c.setLineDash([6, 5]);
    c.strokeStyle = 'rgba(255, 110, 210, 0.7)';
    c.lineWidth = 1.5;
    c.stroke();
    c.setLineDash([]);
    const top = pts[1].y < pts[2].y ? pts[1] : pts[2];
    c.font = '600 11px system-ui, sans-serif';
    c.fillStyle = 'rgba(255, 140, 220, 0.95)';
    c.fillText('左右対称', top.x + 4, top.y - 4);
    c.restore();
  }

  private drawOverlay(c: CanvasRenderingContext2D): void {
    if (this.symOn()) this.drawSymmetryPlane(c);
    drawGizmo(this.vp, c, this.hover, null);
    if (this.box) {
      const b = this.box;
      c.save();
      c.setLineDash([5, 4]);
      c.strokeStyle = '#fff';
      c.lineWidth = 1.5;
      c.fillStyle = 'rgba(255,160,24,0.12)';
      c.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      c.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      c.restore();
    }
    // テクスチャモード: ペン先（ホバー）位置のテクセルを示す
    if (state.mode === 'texture' && this.hoverPt && state.tool.texture !== 'uv') {
      const [x, y] = this.hoverPt;
      c.save();
      c.strokeStyle = '#fff';
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(x, y, 6, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.7)';
      c.beginPath();
      c.arc(x, y, 7.5, 0, Math.PI * 2);
      c.stroke();
      c.restore();
    }
    // 頂点モードで選んだ順番（面を張るとき用）
    if (state.mode === 'model' && state.sel.mode === 'vert' && state.sel.verts.size >= 2 && state.sel.verts.size <= 8) {
      const o = activeObject();
      if (o) {
        c.save();
        c.font = '700 11px system-ui, sans-serif';
        let n = 1;
        for (const v of state.sel.verts) {
          const p = o.verts[v];
          if (!p) continue;
          const s = this.vp.project(p);
          if (s.z <= 0) continue;
          c.fillStyle = 'rgba(0,0,0,0.7)';
          c.fillRect(s.x + 6, s.y - 18, 14, 14);
          c.fillStyle = '#ffa018';
          c.fillText(String(n++), s.x + 9, s.y - 7);
        }
        c.restore();
      }
    }
  }
}

function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax,
    dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

