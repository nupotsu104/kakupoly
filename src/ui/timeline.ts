// アニメのタイムライン（下部）。ペンでドラッグしてコマ送り、◆はキーのあるフレーム。
import { state, subscribe, notify, activeClip, checkpoint } from '../state';
import { runAction, setFrame } from '../actions';
import { h, button, capture } from './dom';

export class Timeline {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private label: HTMLElement;
  private playBtn: HTMLButtonElement;
  private dragging: number | null = null;
  private dragKey: { from: number; bone: number } | null = null;
  private lastTime = 0;
  private acc = 0;

  constructor() {
    this.canvas = h('canvas', { class: 'tl-canvas' });
    this.canvas.style.touchAction = 'none';
    this.label = h('span', { class: 'tl-label' });
    this.playBtn = button('▶', () => runAction('play'), { cls: 'tl-play', title: '再生／停止' });
    this.el = h(
      'div',
      { class: 'timeline' },
      h('div', { class: 'tl-buttons' }, button('⏮', () => runAction('frame-start')), button('◀', () => runAction('frame-prev')), this.playBtn, button('▶|', () => runAction('frame-next')), button('◆＋', () => runAction('key-insert'), { title: 'キーを打つ' }), this.label),
      this.canvas,
    );
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.canvas.addEventListener('pointerdown', (e) => {
      capture(this.canvas, e.pointerId);
      this.dragging = e.pointerId;
      const f = this.frameAt(e);
      // アクティブボーンの◆を掴んだら、そのキーを移動
      const c = activeClip();
      const tr = c?.tracks.find((t) => t.bone === state.activeBone);
      const r = this.canvas.getBoundingClientRect();
      const onKeyRow = e.clientY - r.top > r.height * 0.5;
      if (tr && onKeyRow && tr.keys.some((k) => k.f === f)) this.dragKey = { from: f, bone: state.activeBone };
      else setFrame(f);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragging !== e.pointerId) return;
      if (!this.dragKey) setFrame(this.frameAt(e));
      else this.draw(this.frameAt(e));
    });
    const end = (e: PointerEvent) => {
      if (this.dragging !== e.pointerId) return;
      this.dragging = null;
      if (this.dragKey) {
        const to = this.frameAt(e);
        const c = activeClip();
        const tr = c?.tracks.find((t) => t.bone === this.dragKey!.bone);
        if (c && tr && to !== this.dragKey.from && !tr.keys.some((k) => k.f === to)) {
          checkpoint();
          const k = tr.keys.find((x) => x.f === this.dragKey!.from)!;
          k.f = to;
          tr.keys.sort((a, b) => a.f - b.f);
          setFrame(to);
          notify('doc', 'ui', 'pose');
        }
        this.dragKey = null;
        this.draw();
      }
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    subscribe(() => this.draw());
    const tick = (t: number) => {
      requestAnimationFrame(tick);
      const c = activeClip();
      if (!state.playing || !c || state.mode !== 'anim') {
        this.lastTime = t;
        this.acc = 0;
        return;
      }
      this.acc += (t - this.lastTime) / 1000;
      this.lastTime = t;
      const step = 1 / c.fps;
      if (this.acc >= step) {
        const n = Math.floor(this.acc / step);
        this.acc -= n * step;
        let f = state.frame + n;
        if (f > c.length) {
          if (c.loop) f = f % (c.length + 1);
          else {
            f = c.length;
            state.playing = false;
            notify('ui');
          }
        }
        setFrame(f);
      }
    };
    requestAnimationFrame(tick);
  }

  private frameAt(e: PointerEvent): number {
    const r = this.canvas.getBoundingClientRect();
    const len = activeClip()?.length ?? 30;
    const pad = 12;
    return Math.max(0, Math.min(len, Math.round(((e.clientX - r.left - pad) / (r.width - pad * 2)) * len)));
  }

  draw(ghost?: number): void {
    const c = activeClip();
    this.playBtn.textContent = state.playing ? '■' : '▶';
    this.label.textContent = c ? `${state.frame} / ${c.length}  (${(state.frame / c.fps).toFixed(2)}秒)` : 'アニメなし';
    const cv = this.canvas;
    const r = cv.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (r.width < 2) return;
    cv.width = Math.round(r.width * dpr);
    cv.height = Math.round(r.height * dpr);
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#1b1d29';
    g.fillRect(0, 0, r.width, r.height);
    const len = c?.length ?? 30;
    const pad = 12;
    const X = (f: number) => pad + (f / len) * (r.width - pad * 2);
    g.font = '10px system-ui, sans-serif';
    const every = len > 120 ? 10 : len > 60 ? 5 : len > 30 ? 2 : 1;
    for (let f = 0; f <= len; f++) {
      const major = f % (every * 5) === 0;
      if (f % every && !major) continue;
      g.strokeStyle = major ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)';
      g.beginPath();
      g.moveTo(X(f) + 0.5, 14);
      g.lineTo(X(f) + 0.5, r.height);
      g.stroke();
      if (major) {
        g.fillStyle = '#9aa0b8';
        g.fillText(String(f), X(f) + 2, 10);
      }
    }
    if (c) {
      // 全ボーンのキー（上段・薄く）と選択ボーンのキー（下段）
      const all = new Set<number>();
      for (const t of c.tracks) for (const k of t.keys) all.add(k.f);
      g.fillStyle = 'rgba(200,200,220,0.5)';
      for (const f of all) diamond(g, X(f), r.height * 0.38, 4);
      const tr = c.tracks.find((t) => t.bone === state.activeBone);
      g.fillStyle = '#ffa018';
      for (const k of tr?.keys ?? []) diamond(g, X(this.dragKey && k.f === this.dragKey.from && ghost !== undefined ? ghost : k.f), r.height * 0.72, 6);
    }
    g.strokeStyle = '#4da3ff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(state.frame), 0);
    g.lineTo(X(state.frame), r.height);
    g.stroke();
    g.lineWidth = 1;
  }
}

function diamond(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  g.beginPath();
  g.moveTo(x, y - s);
  g.lineTo(x + s, y);
  g.lineTo(x, y + s);
  g.lineTo(x - s, y);
  g.closePath();
  g.fill();
}
