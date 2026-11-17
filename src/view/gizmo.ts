// 変形ギズモ（画面に2Dで描く）。指やペンで掴みやすいよう当たり判定は太めにとる。
import type { V3 } from '../core/types';
import { add, cross, mul, norm, dot } from '../core/vec';
import { state } from '../state';
import type { Viewport } from './viewport';
import type { Session } from './transform';
import { targetInfo } from './transform';

export type GizmoKind = 'move' | 'rotate' | 'scale';
export interface Handle {
  kind: GizmoKind;
  axis: 0 | 1 | 2 | 3; // 3 = 画面平面 / 全体
}
interface P2 {
  x: number;
  y: number;
}

const COLORS = ['#ff4d4d', '#5ad84a', '#4d86ff'];
const ARROW = 92; // px
const RING = 78;
const VIEW_RING = 100;
const HIT = 16;

export function gizmoKind(): GizmoKind | null {
  const t = state.tool[state.mode];
  if (state.mode === 'model' || state.mode === 'anim') {
    if (t === 'move' || t === 'rotate' || t === 'scale') return t;
    return null;
  }
  if (state.mode === 'rig' && t === 'bone-move') return 'move';
  return null;
}

interface Geo {
  kind: GizmoKind;
  p: P2;
  axes: V3[];
  ends: P2[];
  rings: P2[][];
  can: Session['can'];
}

function geometry(vp: Viewport): Geo | null {
  const kind = gizmoKind();
  if (!kind) return null;
  const info = targetInfo();
  if (!info) return null;
  if ((kind === 'rotate' && !info.can.rotate) || (kind === 'scale' && !info.can.scale)) return null;
  const pp = vp.project(info.pivot);
  if (pp.z <= 0) return null;
  const ps = vp.pixelScale(info.pivot);
  const ends = info.axes.map((a) => {
    const e = vp.project(add(info.pivot, mul(a, ARROW * ps)));
    return { x: e.x, y: e.y };
  });
  const rings: P2[][] = [];
  if (kind === 'rotate')
    for (let k = 0; k < 3; k++) {
      const a = info.axes[k];
      const u = norm(cross(a, Math.abs(a[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
      const v = cross(a, u);
      const pts: P2[] = [];
      for (let i = 0; i <= 48; i++) {
        const t = (i / 48) * Math.PI * 2;
        const w = add(info.pivot, mul(add(mul(u, Math.cos(t)), mul(v, Math.sin(t))), RING * ps));
        const s = vp.project(w);
        pts.push({ x: s.x, y: s.y });
      }
      rings.push(pts);
    }
  return { kind, p: { x: pp.x, y: pp.y }, axes: info.axes, ends, rings, can: info.can };
}

const segDist = (q: P2, a: P2, b: P2): number => {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(q.x - (a.x + dx * t), q.y - (a.y + dy * t));
};

export function hitGizmo(vp: Viewport, x: number, y: number): Handle | null {
  const g = geometry(vp);
  if (!g) return null;
  const q = { x, y };
  const dc = Math.hypot(x - g.p.x, y - g.p.y);
  if (g.kind === 'rotate') {
    let best: Handle | null = null,
      bd = HIT;
    g.rings.forEach((r, k) => {
      for (let i = 0; i < r.length - 1; i++) {
        const d = segDist(q, r[i], r[i + 1]);
        if (d < bd) {
          bd = d;
          best = { kind: 'rotate', axis: k as 0 | 1 | 2 };
        }
      }
    });
    if (best) return best;
    if (Math.abs(dc - VIEW_RING) < HIT) return { kind: 'rotate', axis: 3 };
    return null;
  }
  if (dc < 18 && (g.kind === 'move' ? g.can.move : true)) return { kind: g.kind, axis: 3 };
  if (state.mode === 'rig') return null; // リグでは画面平面の移動のみ
  let best: Handle | null = null,
    bd = HIT;
  g.ends.forEach((e, k) => {
    const d = segDist(q, g.p, e);
    if (d < bd && Math.hypot(e.x - g.p.x, e.y - g.p.y) > 10) {
      bd = d;
      best = { kind: g.kind, axis: k as 0 | 1 | 2 };
    }
  });
  return best;
}

export function drawGizmo(vp: Viewport, ctx: CanvasRenderingContext2D, hover: Handle | null, active: Handle | null): void {
  const g = geometry(vp);
  if (!g) return;
  const hl = (k: number) => (active && active.axis === k) || (!active && hover && hover.axis === k);
  ctx.save();
  ctx.lineCap = 'round';
  const outline = (draw: () => void, color: string, w: number) => {
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = w + 3;
    draw();
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    draw();
    ctx.stroke();
  };
  if (g.kind === 'rotate') {
    outline(
      () => {
        ctx.beginPath();
        ctx.arc(g.p.x, g.p.y, VIEW_RING, 0, Math.PI * 2);
      },
      hl(3) ? '#fff' : 'rgba(255,255,255,0.6)',
      hl(3) ? 3 : 2,
    );
    g.rings.forEach((r, k) => {
      outline(
        () => {
          ctx.beginPath();
          r.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        },
        hl(k) ? '#fff' : COLORS[k],
        hl(k) || state.axis === k ? 3.5 : 2.5,
      );
    });
  } else if (state.mode !== 'rig') {
    g.ends.forEach((e, k) => {
      const len = Math.hypot(e.x - g.p.x, e.y - g.p.y);
      if (len < 10) return;
      const c = hl(k) ? '#fff' : COLORS[k];
      outline(
        () => {
          ctx.beginPath();
          ctx.moveTo(g.p.x + ((e.x - g.p.x) / len) * 20, g.p.y + ((e.y - g.p.y) / len) * 20);
          ctx.lineTo(e.x, e.y);
        },
        c,
        state.axis === k ? 3.5 : 2.5,
      );
      ctx.fillStyle = c;
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (g.kind === 'move') {
        const ux = (e.x - g.p.x) / len,
          uy = (e.y - g.p.y) / len;
        ctx.moveTo(e.x + ux * 14, e.y + uy * 14);
        ctx.lineTo(e.x - uy * 7, e.y + ux * 7);
        ctx.lineTo(e.x + uy * 7, e.y - ux * 7);
        ctx.closePath();
      } else ctx.rect(e.x - 6, e.y - 6, 12, 12);
      ctx.fill();
      ctx.stroke();
    });
  }
  if (g.kind !== 'rotate') {
    ctx.beginPath();
    ctx.arc(g.p.x, g.p.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = hl(3) ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.18)';
    ctx.fill();
    ctx.strokeStyle = hl(3) ? '#fff' : 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.restore();
}

/** ハンドルのドラッグ量 → セッションへの変形適用 */
export class GizmoDrag {
  private startAngle = 0;
  private lastAngle = 0;
  private total = 0;
  private g: Geo;
  constructor(
    private vp: Viewport,
    private s: Session,
    private h: Handle,
    private sx: number,
    private sy: number,
  ) {
    this.g = geometry(vp)!;
    this.startAngle = this.lastAngle = Math.atan2(sy - this.g.p.y, sx - this.g.p.x);
  }

  move(x: number, y: number): boolean {
    const { g, h, s, vp } = this;
    if (!g) return false;
    const dx = x - this.sx,
      dy = y - this.sy;
    if (h.kind === 'move') {
      if (h.axis === 3) {
        const ps = vp.pixelScale(s.pivot);
        const { right, up } = vp.basis();
        s.translate(add(mul(right, dx * ps), mul(up, -dy * ps)));
      } else {
        const e = g.ends[h.axis];
        const len = Math.hypot(e.x - g.p.x, e.y - g.p.y);
        if (len < 1) return false;
        const pxPerWorld = len / (ARROW * vp.pixelScale(s.pivot));
        const d = (dx * (e.x - g.p.x) + dy * (e.y - g.p.y)) / len / pxPerWorld;
        s.translate(mul(g.axes[h.axis], d));
      }
      return true;
    }
    if (h.kind === 'rotate') {
      const a = Math.atan2(y - g.p.y, x - g.p.x);
      let d = a - this.lastAngle;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      this.lastAngle = a;
      this.total += d;
      const { fwd } = vp.basis();
      const axis: V3 = h.axis === 3 ? mul(fwd, -1) : g.axes[h.axis];
      const sign = dot(axis, fwd) < 0 ? -1 : 1;
      s.rotate(axis, sign * this.total);
      return true;
    }
    // scale
    if (h.axis === 3) {
      const d0 = Math.max(4, Math.hypot(this.sx - g.p.x, this.sy - g.p.y));
      const r = Math.hypot(x - g.p.x, y - g.p.y) / d0;
      s.scale([r, r, r]);
    } else {
      const e = g.ends[h.axis];
      const len = Math.hypot(e.x - g.p.x, e.y - g.p.y);
      if (len < 1) return false;
      const r = 1 + (dx * (e.x - g.p.x) + dy * (e.y - g.p.y)) / len / ARROW;
      const f: V3 = [1, 1, 1];
      f[h.axis] = r;
      s.scale(f);
    }
    return true;
  }
}
