// 画面全体の組み立て
import { state, subscribe, notify, canUndo, canRedo, activeObject, type Mode } from '../state';
import { actions, runAction, ctx as actx, TOOLS, setMode, setTool } from '../actions';
import { bindingsFor, prettyCombo, pencilSettings } from '../input/keymap';
import { h, button, clear, checkbox, select, capture } from './dom';
import { Viewport } from '../view/viewport';
import { Controls } from '../view/controls';
import { TextureEditor } from './texture-editor';
import { Timeline } from './timeline';
import { renderPanel } from './panels';
import { openFileMenu, openSettings, openHelp, saveToLibrary, isDirty } from './dialogs';
import { docStats } from '../core/doc';
import { selVerts } from '../core/mesh-ops';

const MODE_LABEL: Record<Mode, string> = { model: 'モデリング', texture: 'テクスチャ', rig: 'リグ', anim: 'アニメ' };
const TOOL_ICON: Record<string, string> = {
  select: '⬚',
  move: '✥',
  rotate: '⟳',
  scale: '⤡',
  vpaint: '◐',
  pencil: '✎',
  eraser: '⌫',
  fill: '◧',
  picker: '⊙',
  line: '╱',
  rect: '▭',
  uv: '⌗',
  'bone-add': '✚',
  'bone-move': '◎',
  weights: '⬤',
};

export function buildApp(root: HTMLElement): void {
  // ---- 上部バー ----
  const modeTabs = h('div', { class: 'modes' });
  const undoBtn = button('↶', () => runAction('undo'), { title: '取り消し（指2本タップでも）', cls: 'icon' });
  const redoBtn = button('↷', () => runAction('redo'), { title: 'やり直し（指3本タップでも）', cls: 'icon' });
  const viewMenu = h('div', { class: 'popover' });
  const viewBtn = button('表示 ▾', () => viewMenu.classList.toggle('open'));
  const docName = h('span', { class: 'docname' });
  const top = h(
    'header',
    { class: 'topbar' },
    button('ファイル', () => openFileMenu(() => thumbnail()), { cls: 'menu' }),
    docName,
    modeTabs,
    h('div', { class: 'spacer' }),
    undoBtn,
    redoBtn,
    h('div', { class: 'popwrap' }, viewBtn, viewMenu),
    button('⌨', () => openSettings(), { title: 'キー割り当て・TourBox・Apple Pencil', cls: 'icon' }),
    button('?', () => openHelp(), { title: '使い方', cls: 'icon' }),
  );

  // ---- 本体 ----
  const rail = h('nav', { class: 'rail' });
  const vpEl = h('div', { class: 'viewport' });
  const texEl = h('div', { class: 'texpane' });
  const stage = h('div', { class: 'stage' }, vpEl, texEl);
  const panel = h('aside', { class: 'panel' });
  const timeline = new Timeline();
  const status = h('footer', { class: 'status' });
  const center = h('div', { class: 'center' }, stage, timeline.el);
  root.append(top, h('div', { class: 'main' }, rail, center, panel), status);

  const vp = new Viewport(vpEl);
  actx.vp = vp;
  new Controls(vp);
  const tex = new TextureEditor(texEl);

  // 視点操作ボタン（ペンでドラッグ）
  const navBtn = (label: string, title: string, fn: (dx: number, dy: number) => void) => {
    const b = h('button', { class: 'navbtn', title }, label);
    b.style.touchAction = 'none';
    let last: [number, number] | null = null;
    b.addEventListener('pointerdown', (e) => {
      capture(b, e.pointerId);
      last = [e.clientX, e.clientY];
    });
    b.addEventListener('pointermove', (e) => {
      if (!last) return;
      fn(e.clientX - last[0], e.clientY - last[1]);
      last = [e.clientX, e.clientY];
    });
    b.addEventListener('pointerup', () => (last = null));
    b.addEventListener('pointercancel', () => (last = null));
    return b;
  };
  vpEl.append(
    h(
      'div',
      { class: 'navpad' },
      navBtn('⟲', 'ドラッグで視点回転', (dx, dy) => vp.orbit(dx * 1.5, dy * 1.5)),
      navBtn('✥', 'ドラッグで視点移動', (dx, dy) => vp.pan(dx, dy)),
      navBtn('⊕', 'ドラッグでズーム', (_dx, dy) => vp.zoom(Math.exp(dy * 0.01))),
      button('⛶', () => runAction('view-frame'), { cls: 'navbtn', title: '全体を表示' }),
      button('▣', () => runAction('view-frame-sel'), { cls: 'navbtn', title: '選択部分を表示' }),
    ),
  );
  const heldBadge = h('div', { class: 'heldbadge' });
  vpEl.append(heldBadge);

  // ---- 表示メニュー ----
  const drawViewMenu = () => {
    clear(viewMenu);
    const v = state.view;
    const set = (k: keyof typeof v) => (val: unknown) => {
      (v as unknown as Record<string, unknown>)[k] = val;
      notify('view', 'ui');
    };
    viewMenu.append(
      h('b', {}, 'PS1表示'),
      h('label', {}, '解像度 ', select(String(v.res), [['0', 'iPadのまま'], ['240', '240ライン（PS1相当）'], ['480', '480ライン'], ['120', '120ライン（極端）']], (x) => set('res')(Number(x)))),
      checkbox('頂点のガタつき', v.jitter, set('jitter'), '頂点を画面のピクセルに吸着（PS1は頂点座標が整数）'),
      checkbox('テクスチャのゆがみ', v.affine, set('affine'), '遠近補正なしのテクスチャ貼り'),
      checkbox('15bitカラー＋ディザ', v.dither, set('dither')),
      h('label', {}, '陰影 ', select(v.shade, [['flat', 'カクカク'], ['smooth', 'なめらか'], ['none', 'なし（色そのまま）']], set('shade'))),
      h('hr'),
      h('b', {}, '編集表示'),
      checkbox('ワイヤー', v.wire, set('wire')),
      checkbox('グリッド', v.grid, set('grid')),
      checkbox('ボーン', v.bones, set('bones')),
      checkbox('透視（裏も選ぶ）', v.xray, set('xray')),
      checkbox('平行投影', v.ortho, set('ortho')),
      h('label', {}, '背景 ', (() => {
        const i = h('input', { type: 'color', value: v.bg });
        i.addEventListener('input', () => set('bg')(i.value));
        return i;
      })()),
      h('hr'),
      h('div', { class: 'pgrid' }, ...['front', 'right', 'back', 'left', 'top'].map((n) => button({ front: '正面', right: '右', back: '背面', left: '左', top: '上' }[n]!, () => runAction(`view-${n}`)))),
    );
  };
  document.addEventListener('pointerdown', (e) => {
    if (!viewMenu.contains(e.target as Node) && e.target !== viewBtn) viewMenu.classList.remove('open');
  });

  const thumbnail = (): string => {
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 120;
    vp.render();
    const g = c.getContext('2d')!;
    const sw = vp.glCanvas.width,
      sh = vp.glCanvas.height;
    const k = Math.min(sw / 160, sh / 120);
    g.drawImage(vp.glCanvas, (sw - 160 * k) / 2, (sh - 120 * k) / 2, 160 * k, 120 * k, 0, 0, 160, 120);
    return c.toDataURL('image/jpeg', 0.7);
  };

  // ---- 再描画 ----
  let pending = false;
  let lastPanelKey = '';
  const refresh = (force = false) => {
    if (pending && !force) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      root.dataset.mode = state.mode;
      // モードタブ
      clear(modeTabs);
      (Object.keys(MODE_LABEL) as Mode[]).forEach((m, i) =>
        modeTabs.append(button(MODE_LABEL[m], () => setMode(m), { active: state.mode === m, title: `Shift+${i + 1}` })),
      );
      undoBtn.disabled = !canUndo();
      redoBtn.disabled = !canRedo();
      docName.textContent = state.doc.name + (isDirty() ? ' ●' : '');
      // ツール列
      clear(rail);
      for (const [id, label, desc] of TOOLS[state.mode]) {
        const b = button('', () => setTool(id), { active: state.tool[state.mode] === id, title: `${label}: ${desc}`, cls: 'tool' });
        b.append(h('span', { class: 'ti' }, TOOL_ICON[id] ?? '•'), h('span', { class: 'tl' }, label));
        const kb = bindingsFor(`tool-${state.mode}-${id}`)[0];
        if (kb) b.title += `（${prettyCombo(kb.combo)}）`;
        rail.append(b);
      }
      rail.append(h('div', { class: 'rail-sep' }));
      if (state.mode === 'texture' || state.mode === 'model') {
        const sw = h('button', { class: 'tool colorchip', title: '現在の色', style: `--c:${state.color}` }, h('span', { class: 'ti' }, '■'), h('span', { class: 'tl' }, '色'));
        rail.append(sw);
      }
      // テクスチャモードは画面を左右に分ける
      stage.classList.toggle('split', state.mode === 'texture');
      timeline.el.classList.toggle('hidden', state.mode !== 'anim');
      // パネル（入力中は作り直さない）
      const key = JSON.stringify([state.mode, state.tool[state.mode]]);
      const typing = panel.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement!.tagName);
      if (!typing || key !== lastPanelKey) renderPanel(panel);
      lastPanelKey = key;
      drawViewMenu();
      // 押しっぱなし表示
      const held = [...actx.held].map((id) => actions.get(id)?.label.replace('押している間: ', '') ?? id);
      heldBadge.textContent = held.join(' / ');
      heldBadge.classList.toggle('show', held.length > 0);
      // ステータス
      const s = docStats(state.doc);
      const o = activeObject();
      const tool = TOOLS[state.mode].find((t) => t[0] === state.tool[state.mode]);
      const flags = [state.snap ? '吸着' : '', state.symmetryX ? 'X対称' : '', `軸:${'XYZ'[state.axis]}`].filter(Boolean).join(' ');
      status.textContent = `${tool ? `${tool[1]} — ${tool[2]}` : ''}　|　${o ? `${o.name} 選択 ${selVerts(o, state.sel).size}頂点` : ''}　|　全体 ${s.verts}頂点 ${s.tris}三角形　|　${flags}${pencilSettings.fingerEdit ? '　|　指で編集' : ''}`;
    });
  };
  subscribe((ch) => {
    if (ch.has('ui') || ch.has('mode') || ch.has('sel') || ch.has('doc')) refresh();
    if (ch.has('mode') && state.mode === 'texture') requestAnimationFrame(() => tex.fit());
    if (ch.has('mode') || ch.has('ui') || ch.has('frame')) timeline.draw();
  });
  refresh(true);
  requestAnimationFrame(() => vp.frame());

  // 自動保存（変更があれば30秒ごと・画面を離れるとき）
  setInterval(() => {
    if (isDirty()) saveToLibrary(true, thumbnail()).then(() => refresh());
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && isDirty()) saveToLibrary(true);
  });

  // ネイティブアプリとして包んだ場合に、包み側から呼ぶ入口
  (window as unknown as { kakupoly: unknown }).kakupoly = {
    pencil(kind: 'doubleTap' | 'squeeze') {
      const id = kind === 'squeeze' ? pencilSettings.squeeze : pencilSettings.doubleTap;
      runAction(id);
    },
    run: runAction,
    save: () => saveToLibrary(false, thumbnail()),
  };
  void setTool;
}
