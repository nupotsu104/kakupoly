// 新しい版が公開されていたら、作品を保存してから新しい版に切り替える。
// ホーム画面のアプリは閉じても裏で残っていることがあり、古い版のまま動き続けるのを防ぐ。
import { toast } from './ui/dom';
import { saveToLibrary, isDirty } from './ui/dialogs';

declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
const JUST_UPDATED = 'kakupoly.justUpdated';
const TRIED = 'kakupoly.updateTried';

/** 表示用の版（ビルドした日時を、その端末の時刻で） */
export const versionLabel = (): string => {
  const d = new Date(APP_VERSION);
  return isNaN(d.getTime()) ? APP_VERSION : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

let checking = false;
/** manual=true は「更新を確認」ボタンから。最新なら知らせる */
export async function checkForUpdate(manual = false): Promise<void> {
  if (checking || APP_VERSION === 'dev' || !/^https?:$/.test(location.protocol)) return;
  checking = true;
  try {
    const r = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return;
    const { version } = (await r.json()) as { version?: string };
    if (!version || version === APP_VERSION) {
      if (manual) toast(`最新の版です（${versionLabel()}）`);
      return;
    }
    // 同じ版への切り替えを2分以内に試していたら、繰り返さない（読み直しが止まらなくなるのを防ぐ）
    let tried: { v: string; at: number } | null = null;
    try {
      tried = JSON.parse(sessionStorage.getItem(TRIED) ?? 'null');
    } catch {
      /* noop */
    }
    if (!manual && tried && tried.v === version && Date.now() - tried.at < 120000) return;
    toast('新しい版があります。作品を保存して更新します…', 4000);
    if (isDirty()) await saveToLibrary(true);
    try {
      sessionStorage.setItem(JUST_UPDATED, '1');
      sessionStorage.setItem(TRIED, JSON.stringify({ v: version, at: Date.now() }));
    } catch {
      /* noop */
    }
    // 同じアドレスを読み直すと、ブラウザが覚えている古いページ本体が使われることがある。
    // 版ごとに違うアドレスを開いて、必ず新しい本体を読む（GitHub Pages は ? 以降を無視して同じページを返す）
    const url = `${location.pathname}?v=${encodeURIComponent(version)}`;
    setTimeout(() => location.replace(url), 600);
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
