// オフライン起動用: 一度開いたファイルを保存しておき、通信できない時はそれを返す
const CACHE = 'kakupoly-v3';
// 版を上げると古いキャッシュは消える。通常はネット優先なので更新はそのまま反映される
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // ダウンロード用のファイル（ネイティブ版の zip など）には手を出さない。
  // iPad の Safari では、Service Worker を通すとダウンロードが失敗することがあるため
  if (/\.(zip|kpoly|glb|gltf|obj|png)$/i.test(url.pathname) && !url.pathname.includes('/icon-')) return;
  // ページ本体（index.html）は、ブラウザが覚えている古いものを使わず、必ず公開側に新しいものがあるか確かめる
  const isPage = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');
  const req = isPage ? new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : e.request;
  // 新しい版があれば使い、なければ保存済みを使う
  e.respondWith(
    fetch(req)
      .then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return r;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))),
  );
});
