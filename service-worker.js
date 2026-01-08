const CACHE_VERSION = 'v2'; // 変更したらここを更新
const CACHE_NAME = `time-tracker-${CACHE_VERSION}`;

// サブディレクトリ配下でも壊れないように相対指定
const urlsToCache = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// インストール：必要ファイルを先にキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
  // 新SWをすぐ有効化（更新反映を早く）
  self.skipWaiting();
});

// アクティベート：古いキャッシュ削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : null))
      )
    )
  );
  // すべてのクライアントを制御下に
  self.clients.claim();
});

// フェッチ：GET かつ同一オリジンのみキャッシュ対象
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // POSTなどは触らない（CSV/フォーム/将来拡張の事故防止）
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 外部URLは触らない（Google等）
  if (url.origin !== self.location.origin) return;

  // キャッシュ優先（オフラインでも動く）
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req)
        .then((res) => {
          // 成功したGETだけキャッシュ（opaqueは除外）
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // 何も取れない場合の最終フォールバック（必要なら）
          return caches.match('./index.html');
        });
    })
  );
});
