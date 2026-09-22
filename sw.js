/* Service Worker —— 离线可用
 * 只缓存本站静态资源；分子量查询等外部 API 请求一律走网络，不进缓存。
 * 注意：file:// 协议下 Service Worker 不可用，只在 http(s) 下生效。
 *
 * 策略是「网络优先，缓存兜底」而不是缓存优先：缓存优先会让改完的代码永远送不到
 * 页面上（缓存名不变就不会重新下载），开发期每次都得手动改版本号。有网就取新的，
 * 断网才用缓存 —— 离线能力不受影响。
 */
const CACHE = 'peiyetool-v3';

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/app.css',
  './js/data-reagents.js',
  './js/data-buffers.js',
  './js/data-zh.js',
  /* public:strip-start 内置库存数据，公开版不打包 */
  './js/inventory-data.js',
  /* public:strip-end */
  './js/inventory.js',
  './js/inventory-import.js',
  './js/units.js',
  './js/calc.js',
  './js/store.js',
  './js/lookup.js',
  './js/ui.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())   // 个别资源缺失不该卡住安装
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 跨域请求（NCI Cactus / PubChem）不拦截，交给网络
  if (url.origin !== self.location.origin) return;

  e.respondWith(handle(req));
});

async function handle(req) {
  try {
    const res = await fetch(req);
    // 只缓存正常的同源 GET 响应
    if (res && res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    // 断网：先看缓存；导航请求都没有就退到首页
    const hit = await caches.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const home = await caches.match('./index.html');
      if (home) return home;
    }
    return Response.error();
  }
}
