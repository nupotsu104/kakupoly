// 小さなDOMヘルパー
type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const clear = (el: HTMLElement): void => {
  while (el.firstChild) el.removeChild(el.firstChild);
};

export function button(label: string, onClick: () => void, opts: { title?: string; active?: boolean; cls?: string; disabled?: boolean } = {}): HTMLButtonElement {
  return h(
    'button',
    {
      class: ['btn', opts.cls, opts.active ? 'active' : ''].filter(Boolean).join(' '),
      title: opts.title,
      disabled: opts.disabled,
      onclick: (e: Event) => {
        e.preventDefault();
        onClick();
      },
    },
    label,
  );
}

export function numberInput(value: number, onChange: (v: number) => void, opts: { min?: number; max?: number; step?: number; width?: string } = {}): HTMLInputElement {
  const el = h('input', {
    type: 'number',
    class: 'num',
    value: String(value),
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    style: opts.width ? `width:${opts.width}` : undefined,
  });
  el.addEventListener('change', () => {
    const v = Number(el.value);
    if (Number.isFinite(v)) onChange(v);
  });
  return el;
}

export function select<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const el = h('select', { class: 'sel' }, ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

export function checkbox(label: string, value: boolean, onChange: (v: boolean) => void, title?: string): HTMLLabelElement {
  const input = h('input', { type: 'checkbox', checked: value });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'chk', title }, input, h('span', {}, label));
}

let toastTimer = 0;
export function toast(msg: string, ms = 2200): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div', { id: 'toast' });
    document.body.append(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), ms);
}

/** モーダルダイアログ。close() を呼ぶと閉じる */
export function modal(title: string, body: HTMLElement, opts: { wide?: boolean; onClose?: () => void } = {}): { close: () => void; root: HTMLElement } {
  const close = () => {
    root.remove();
    opts.onClose?.();
  };
  const root = h(
    'div',
    { class: 'modal-back', onpointerdown: (e: Event) => e.target === root && close() },
    h('div', { class: `modal ${opts.wide ? 'wide' : ''}` }, h('div', { class: 'modal-head' }, h('b', {}, title), button('閉じる', close, { cls: 'ghost' })), h('div', { class: 'modal-body' }, body)),
  );
  document.body.append(root);
  return { close, root };
}

export function pickFile(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: 'display:none' });
    input.addEventListener('change', () => {
      resolve([...(input.files ?? [])]);
      input.remove();
    });
    document.body.append(input);
    input.click();
  });
}

export async function downloadBlob(blob: Blob, name: string): Promise<void> {
  // iPad では共有シート経由の方が「ファイル」アプリへ保存しやすい
  const file = new File([blob], name, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
  if (/iPad|iPhone|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document && nav.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 2000);
}
