// キー割り当て。TourBox Elite Plus は iPad では「Bluetoothキーボード」として振る舞うので、
// TourBox Console で各ボタン・ダイヤルに好きなキーを設定し、本アプリ側の「キーを覚えさせる」で
// そのキーを操作に結び付ける。キーの種類は何でもよい。
import { actions, runAction } from '../actions';
import { state, type Mode } from '../state';

export interface Binding {
  combo: string; // 例: "Shift+KeyE"
  action: string;
  mode?: Mode; // 指定するとそのモードでだけ有効（モード指定の方が優先）
}

const STORAGE_KEY = 'kakupoly.keymap.v1';
const PENCIL_KEY = 'kakupoly.pencil.v1';

export const DEFAULT_BINDINGS: Binding[] = [
  { combo: 'Meta+KeyZ', action: 'undo' },
  { combo: 'Ctrl+KeyZ', action: 'undo' },
  { combo: 'Meta+Shift+KeyZ', action: 'redo' },
  { combo: 'Ctrl+Shift+KeyZ', action: 'redo' },
  { combo: 'Ctrl+KeyY', action: 'redo' },
  { combo: 'Tab', action: 'mode-next' },
  { combo: 'Shift+Digit1', action: 'mode-model' },
  { combo: 'Shift+Digit2', action: 'mode-texture' },
  { combo: 'Shift+Digit3', action: 'mode-rig' },
  { combo: 'Shift+Digit4', action: 'mode-anim' },
  { combo: 'Digit1', action: 'sel-vert' },
  { combo: 'Digit2', action: 'sel-edge' },
  { combo: 'Digit3', action: 'sel-face' },
  { combo: 'KeyQ', action: 'tool-select' },
  { combo: 'KeyG', action: 'tool-move' },
  { combo: 'KeyR', action: 'tool-rotate' },
  { combo: 'KeyS', action: 'tool-scale' },
  { combo: 'KeyX', action: 'axis-x' },
  { combo: 'KeyY', action: 'axis-y' },
  { combo: 'KeyZ', action: 'axis-z' },
  { combo: 'KeyC', action: 'axis-next' },
  { combo: 'Equal', action: 'nudge-plus' },
  { combo: 'Minus', action: 'nudge-minus' },
  { combo: 'Shift+Equal', action: 'nudge-plus-fine' },
  { combo: 'Shift+Minus', action: 'nudge-minus-fine' },
  { combo: 'Semicolon', action: 'snap-toggle' },
  { combo: 'Shift+KeyX', action: 'symmetry-toggle' },
  { combo: 'KeyA', action: 'sel-all' },
  { combo: 'Alt+KeyA', action: 'sel-none' },
  { combo: 'Escape', action: 'sel-none' },
  { combo: 'Ctrl+KeyI', action: 'sel-invert' },
  { combo: 'KeyL', action: 'sel-linked', mode: 'model' },
  { combo: 'KeyE', action: 'extrude', mode: 'model' },
  { combo: 'KeyI', action: 'inset', mode: 'model' },
  { combo: 'Ctrl+KeyR', action: 'loopcut' },
  { combo: 'KeyW', action: 'subdivide', mode: 'model' },
  { combo: 'KeyJ', action: 'connect', mode: 'model' },
  { combo: 'KeyM', action: 'merge', mode: 'model' },
  { combo: 'KeyF', action: 'make-face', mode: 'model' },
  { combo: 'Shift+KeyD', action: 'duplicate' },
  { combo: 'Delete', action: 'delete', mode: 'model' },
  { combo: 'Backspace', action: 'delete', mode: 'model' },
  { combo: 'Delete', action: 'bone-delete', mode: 'rig' },
  { combo: 'Backspace', action: 'bone-delete', mode: 'rig' },
  { combo: 'KeyP', action: 'paint-sel', mode: 'model' },
  { combo: 'Alt+Digit1', action: 'view-front' },
  { combo: 'Alt+Digit3', action: 'view-right' },
  { combo: 'Alt+Digit7', action: 'view-top' },
  { combo: 'Alt+Digit9', action: 'view-back' },
  { combo: 'Alt+Digit5', action: 'view-ortho' },
  { combo: 'Period', action: 'view-frame-sel' },
  { combo: 'Home', action: 'view-frame' },
  { combo: 'KeyH', action: 'view-frame' },
  { combo: 'Space', action: 'hold-orbit' },
  { combo: 'Shift+Space', action: 'hold-pan' },
  { combo: 'Alt+Space', action: 'hold-zoom' },
  { combo: 'Backquote', action: 'view-ps1' },
  { combo: 'KeyB', action: 'tool-texture-pencil', mode: 'texture' },
  { combo: 'KeyE', action: 'swap-eraser', mode: 'texture' },
  { combo: 'KeyG', action: 'tool-texture-fill', mode: 'texture' },
  { combo: 'KeyI', action: 'tool-texture-picker', mode: 'texture' },
  { combo: 'KeyL', action: 'tool-texture-line', mode: 'texture' },
  { combo: 'KeyU', action: 'tool-texture-uv', mode: 'texture' },
  { combo: 'Alt', action: 'hold-picker', mode: 'texture' },
  { combo: 'BracketRight', action: 'brush-bigger' },
  { combo: 'BracketLeft', action: 'brush-smaller' },
  { combo: 'Quote', action: 'color-next' },
  { combo: 'Backslash', action: 'color-prev' },
  { combo: 'KeyN', action: 'tool-rig-bone-add', mode: 'rig' },
  { combo: 'KeyW', action: 'tool-rig-weights', mode: 'rig' },
  { combo: 'ArrowUp', action: 'bone-parent', mode: 'rig' },
  { combo: 'ArrowDown', action: 'bone-child', mode: 'rig' },
  { combo: 'ArrowRight', action: 'bone-next', mode: 'rig' },
  { combo: 'ArrowLeft', action: 'bone-prev', mode: 'rig' },
  { combo: 'ArrowRight', action: 'frame-next', mode: 'anim' },
  { combo: 'ArrowLeft', action: 'frame-prev', mode: 'anim' },
  { combo: 'ArrowUp', action: 'key-next', mode: 'anim' },
  { combo: 'ArrowDown', action: 'key-prev', mode: 'anim' },
  { combo: 'KeyK', action: 'key-insert' },
  { combo: 'Shift+KeyK', action: 'key-insert-all' },
  { combo: 'Alt+KeyK', action: 'key-delete' },
  { combo: 'KeyP', action: 'play', mode: 'anim' },
  { combo: 'Enter', action: 'play', mode: 'anim' },
  { combo: 'Ctrl+KeyC', action: 'pose-copy', mode: 'anim' },
  { combo: 'Ctrl+KeyV', action: 'pose-paste', mode: 'anim' },
  { combo: 'Ctrl+Shift+KeyV', action: 'pose-paste-mirror', mode: 'anim' },
];

/**
 * TourBox Elite Plus のおすすめ配置（操作部の名前は TourBox の公式表記）。
 * キーそのものは何でもよいので、Console で割り当てた後に本アプリで「覚えさせる」。
 */
export const TOURBOX_PRESET: { control: string; action: string; note: string }[] = [
  { control: 'ダイヤル 右/左', action: 'nudge-plus / nudge-minus', note: '選択中のツールと軸で少しずつ動かす（移動・回転・拡縮）' },
  { control: 'ノブ 右/左', action: 'zoom-in / zoom-out', note: '視点のズーム' },
  { control: 'スクロール 上/下', action: 'frame-next / frame-prev', note: 'アニメのコマ送り（モデリング中は「次/前のツール」でも可）' },
  { control: 'Tall（長押し）', action: 'hold-orbit', note: '押している間ペンでドラッグ＝視点回転' },
  { control: 'Side（長押し）', action: 'hold-pan', note: '押している間ペンでドラッグ＝視点移動' },
  { control: 'Top', action: 'axis-next', note: 'X→Y→Z 軸の切り替え（ダイヤルの効く軸）' },
  { control: 'Short', action: 'undo', note: '取り消し' },
  { control: 'C1', action: 'tool-move', note: '移動ツール' },
  { control: 'C2', action: 'tool-rotate', note: '回転ツール' },
  { control: 'Tour', action: 'mode-next', note: 'モード切り替え' },
  { control: '上', action: 'key-insert', note: 'キーを打つ（アニメ）' },
  { control: '下', action: 'sel-cycle', note: '頂点/辺/面 切り替え' },
  { control: '左/右', action: 'tool-prev / tool-next', note: 'ツール切り替え' },
];

export let bindings: Binding[] = load();

function load(): Binding[] {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (s) {
      const b = JSON.parse(s) as Binding[];
      if (Array.isArray(b)) return b.filter((x) => typeof x.combo === 'string' && typeof x.action === 'string');
    }
  } catch {
    /* 保存領域が使えなくても既定で動く */
  }
  return DEFAULT_BINDINGS.map((b) => ({ ...b }));
}

export function saveBindings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  } catch {
    /* noop */
  }
}

export function resetBindings(): void {
  bindings = DEFAULT_BINDINGS.map((b) => ({ ...b }));
  saveBindings();
}

export function setBindings(b: Binding[]): void {
  bindings = b;
  saveBindings();
}

const MOD_ONLY = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

export function comboOf(e: KeyboardEvent): string {
  if (MOD_ONLY.has(e.code)) {
    // 修飾キー単独（押しっぱなし用）
    return e.code.replace(/Left|Right/, '').replace('Control', 'Ctrl');
  }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(e.code || e.key);
  return parts.join('+');
}

const KEY_NAMES: Record<string, string> = {
  Meta: '⌘',
  Ctrl: 'Ctrl',
  Alt: '⌥',
  Shift: '⇧',
  Space: 'Space',
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Backslash: '\\',
  Slash: '/',
  Backspace: '⌫',
  Delete: 'Del',
  Enter: '⏎',
};

export function prettyCombo(c: string): string {
  return c
    .split('+')
    .map((p) => KEY_NAMES[p] ?? p.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'テンキー'))
    .join(' ');
}

export function findBinding(combo: string, mode: Mode): Binding | undefined {
  return bindings.find((b) => b.combo === combo && b.mode === mode) ?? bindings.find((b) => b.combo === combo && !b.mode);
}

export function bindingsFor(action: string): Binding[] {
  return bindings.filter((b) => b.action === action);
}

// ---------- Apple Pencil のダブルタップ・スクイーズ ----------
// Webページ（Safari）にはこの2つのイベントが届かない。ネイティブアプリとして包んだ場合に、
// 包み側から window.kakupoly.pencil('doubleTap' | 'squeeze') を呼べば、ここで設定した操作が実行される。
export const pencilSettings: { doubleTap: string; squeeze: string; fingerEdit: boolean } = (() => {
  const d = { doubleTap: 'swap-eraser', squeeze: 'tool-last', fingerEdit: false };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PENCIL_KEY) ?? '{}') };
  } catch {
    return d;
  }
})();

export function savePencil(): void {
  try {
    localStorage.setItem(PENCIL_KEY, JSON.stringify(pencilSettings));
  } catch {
    /* noop */
  }
}

// ---------- キー入力の配送 ----------
type Learner = (combo: string) => void;
let learner: Learner | null = null;
/** 次に押されたキーを受け取る（割り当て画面用）。キャンセル関数を返す */
export function learnNextKey(fn: Learner): () => void {
  learner = fn;
  return () => {
    if (learner === fn) learner = null;
  };
}

const pressed = new Map<string, string>(); // code → 押下時に実行した action id

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (tag === 'INPUT' && !['checkbox', 'range', 'radio', 'button'].includes((el as HTMLInputElement).type)) || tag === 'TEXTAREA' || el.isContentEditable;
}

export function installKeyHandler(): void {
  window.addEventListener(
    'keydown',
    (e) => {
      if (learner) {
        if (MOD_ONLY.has(e.code) && !e.repeat) {
          // 修飾キーは離したとき単独なら確定（Shift+X などを押す途中かもしれないので）
          return;
        }
        e.preventDefault();
        const l = learner;
        learner = null;
        l(comboOf(e));
        return;
      }
      if (isTyping(e.target)) return;
      const combo = comboOf(e);
      const b = findBinding(combo, state.mode);
      if (!b) return;
      const a = actions.get(b.action);
      if (!a) return;
      e.preventDefault();
      if (e.repeat && !a.repeat) return;
      if (a.release) pressed.set(e.code, a.id);
      runAction(a.id);
    },
    { capture: true },
  );
  window.addEventListener(
    'keyup',
    (e) => {
      if (learner && MOD_ONLY.has(e.code)) {
        const l = learner;
        learner = null;
        l(comboOf(e));
        return;
      }
      // 修飾キーを先に離しても止まるよう、記録しておいた code で解除する
      const id = pressed.get(e.code);
      if (id) {
        pressed.delete(e.code);
        actions.get(id)?.release?.();
      }
    },
    { capture: true },
  );
  // アプリを切り替えたときに押しっぱなし状態が残らないように
  window.addEventListener('blur', () => {
    for (const id of pressed.values()) actions.get(id)?.release?.();
    pressed.clear();
  });
}
