// 新しい版が公開されていたら、作品を保存してから新しい版に切り替える。
// ホーム画面のアプリは閉じても裏で残っていることがあり、古い版のまま動き続けるのを防ぐ。
import { toast } from './ui/dom';
import { saveToLibrary, isDirty } from './ui/dialogs';

declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
const JUST_UPDATED = 'kakupoly.justUpdated';

let checking = false;
export async function checkForUpdate(): Promise<void> {
  if (checking || APP_VERSION === 'dev' || !/^https?:$/.test(location.protocol)) return;
  checking = true;
  try {
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = (await r.json()) as { version?: string };
    if (!version || version === APP_VERSION) return;
    toast('新しい版があります。作品を保存して更新します…', 4000);
    if (isDirty()) await saveToLibrary(true);
    try {
      sessionStorage.setItem(JUST_UPDATED, '1');
    } catch {
      /* noop */
    }
    setTimeout(() => location.reload(), 600);
  } catch {
    /* 通信できない時は何もしない */
  } finally {
    checking = false;
  }
}

export function installUpdateChecks(): void {
  try {
    if (sessionStorage.getItem(JUST_UPDATED)) {
      sessionStorage.removeItem(JUST_UPDATED);
      setTimeout(() => toast('新しい版に更新しました'), 800);
    }
  } catch {
    /* noop */
  }
  // アプリに戻ってきた時と、起動直後・30分ごとに確かめる
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkForUpdate());
  setTimeout(checkForUpdate, 3000);
  setInterval(checkForUpdate, 30 * 60 * 1000);
  // 部品の読み込みに失敗した（＝古い版のまま、公開側が入れ替わった）時も更新する
  window.addEventListener('error', (e) => {
    if (/module script|dynamically imported|Failed to fetch/i.test(String(e.message))) checkForUpdate();
  });
  window.addEventListener('unhandledrejection', (e) => {
    if (/module script|dynamically imported/i.test(String((e.reason as Error)?.message ?? e.reason))) checkForUpdate();
  });
}
