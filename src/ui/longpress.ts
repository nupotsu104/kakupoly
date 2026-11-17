// 長押し（またはマウスの右クリック）で、data-help を持つ部品の説明を出す。
// 長押しした後に指・ペンを離しても、そのボタンの操作は実行しない。
import { HELP, type HelpText } from './help-texts';
import { actions } from '../actions';
import { bindingsFor, prettyCombo } from '../input/keymap';
import { h } from './dom';

const HOLD_MS = 450;
const MOVE_TOL = 10;

export function helpFor(key: string): HelpText | null {
  const t = HELP[key];
  if (t) return t;
  if (key.startsWith('action:')) {
    const a = actions.get(key.slice(7));
    if (a) return { title: a.label, body: [] };
  }
  return null;
}

let pop: HTMLElement | null = null;

export function closeHelp(): void {
  pop?.remove();
  pop = null;
}

export function showHelp(key: string, anchor: Element): void {
  const t = helpFor(key);
  if (!t) return;
  closeHelp();
  const keys = key.startsWith('action:') ? bindingsFor(key.slice(7)).map((b) => prettyCombo(b.combo)) : [];
  pop = h(
    'div',
    { class: 'helppop', role: 'dialog' },
    h('b', {}, t.title),
    ...t.body.map((line) => h('p', {}, line)),
    keys.length ? h('p', { class: 'helpkeys' }, 'キー: ', ...keys.map((k) => h('kbd', {}, k))) : null,
    h('small', {}, 'どこかをタップすると閉じます'),
  );
  document.body.append(pop);
  // 部品の横（入らなければ下・上）に置く
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth,
    ph = pop.offsetHeight;
  const vw = window.innerWidth,
    vh = window.innerHeight;
  let x = r.right + 10,
    y = r.top;
  if (x + pw > vw - 8) x = r.left - pw - 10;
  if (x < 8) {
    x = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), vw - pw - 8);
    y = r.bottom + 10;
    if (y + ph > vh - 8) y = r.top - ph - 10;
  }
  y = Math.min(Math.max(8, y), vh - ph - 8);
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;
}

export function installLongPressHelp(): void {
  let timer = 0;
  let start: { x: number; y: number; id: number } | null = null;
  let suppressClick = false;

  const cancel = () => {
    clearTimeout(timer);
    start = null;
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      suppressClick = false;
      if (pop && !pop.contains(e.target as Node)) closeHelp();
      const el = (e.target as Element | null)?.closest?.('[data-help]');
      if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId };
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        start = null;
        suppressClick = true;
        showHelp(el.getAttribute('data-help')!, el);
        navigator.vibrate?.(10);
      }, HOLD_MS);
    },
    true,
  );
  document.addEventListener(
    'pointermove',
    (e) => {
      if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > MOVE_TOL) cancel();
    },
    true,
  );
  document.addEventListener('pointerup', cancel, true);
  document.addEventListener('pointercancel', cancel, true);
  // 長押しの後の click（＝ボタンの実行）は捨てる
  document.addEventListener(
    'click',
    (e) => {
      if (!suppressClick) return;
      suppressClick = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
  // マウスでは右クリックで説明
  document.addEventListener(
    'contextmenu',
    (e) => {
      const el = (e.target as Element | null)?.closest?.('[data-help]');
      if (!el) return;
      e.preventDefault();
      cancel();
      showHelp(el.getAttribute('data-help')!, el);
    },
    true,
  );
  window.addEventListener('keydown', (e) => e.key === 'Escape' && closeHelp(), true);
}

/** 要素に説明キーを付ける */
export function withHelp<T extends HTMLElement>(el: T, key: string): T {
  el.setAttribute('data-help', key);
  return el;
}
