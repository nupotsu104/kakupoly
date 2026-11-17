import './styles.css';
import { buildApp } from './ui/app';
import { installKeyHandler } from './input/keymap';
import { openLatestFromLibrary } from './ui/dialogs';
import { requestPersistence } from './io/project';
import { ctx } from './actions';

async function start(): Promise<void> {
  const root = document.getElementById('app')!;
  installKeyHandler();
  // 前回の作業があれば開く（なければサンプル人型）
  const restored = await openLatestFromLibrary();
  buildApp(root);
  if (restored) requestAnimationFrame(() => ctx.vp?.frame());
  requestPersistence();
  // オフラインでも起動できるように（https かつ ネイティブ包みでない時）
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

start();
