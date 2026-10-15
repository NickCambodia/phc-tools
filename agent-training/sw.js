/* Offline copy of PHC Agent Training.
   - The page, manifest, icons and the clip list: network first (updates arrive whenever you're online),
     the saved copy when there's no signal.
   - Voice clips (audio/*.m4a?v=<hash>): saved once and served from the phone. The page sends the full clip
     list after it loads ("save-clips"); missing clips download in the background and old versions are removed.
   - Safari plays audio with byte-range requests, so saved clips are answered with 206 partial responses.
   - Google Fonts are saved the first time they load. */
const CORE = 'phcat-core-v1', CLIPS = 'phcat-clips-v1', FONTS = 'phcat-fonts-v1';
const CORE_FILES = ['./', 'index.html', 'manifest.webmanifest', 'audio/manifest.js',
  'icons/phc.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CORE).then(c => c.addAll(CORE_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // Only our own old caches. Never touch others (the on-device voice model lives in "transformers-cache").
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('phcat-') && ![CORE, CLIPS, FONTS].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function ranged(req, res) {
  const range = req.headers.get('range');
  if (!range || !res || res.status !== 200) return res;
  const buf = await res.arrayBuffer(), size = buf.byteLength, m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  const start = m[1] ? +m[1] : 0, end = Math.min(m[2] ? +m[2] : size - 1, size - 1);
  return new Response(buf.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers: {
    'Content-Type': res.headers.get('Content-Type') || 'audio/mp4', 'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' } });
}
async function clip(req) {
  const cache = await caches.open(CLIPS), url = req.url;
  let res = await cache.match(url);
  if (!res) {
    res = await fetch(url);                                   // the whole file, without the Range header
    if (res.ok) await cache.put(url, res.clone());
  }
  return ranged(req, res);
}
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') (await caches.open(CORE)).put(req, res.clone());
    return res;
  } catch (e) {
    return (await caches.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? caches.match('index.html') : Response.error());
  }
}
async function cacheFirst(req, name) {
  const hit = await caches.match(req); if (hit) return hit;
  const res = await fetch(req); if (res.ok || res.type === 'opaque') (await caches.open(name)).put(req, res.clone());
  return res;
}
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin && /\/audio\/[^/]+\.m4a$/.test(u.pathname)) return e.respondWith(clip(req));
  if (u.origin === location.origin) return e.respondWith(networkFirst(req));
  if (/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) return e.respondWith(cacheFirst(req, FONTS));
});

let saving = null;
self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'save-clips') return;
  const src = e.source, urls = e.data.urls.map(x => new URL(x, self.registration.scope).href);
  const post = msg => { try { src && src.postMessage(msg); } catch (err) {} };
  if (saving) { saving.then(() => post({ type: 'clips', done: urls.length, total: urls.length })); return; }
  saving = (async () => {
    const cache = await caches.open(CLIPS), want = new Set(urls);
    for (const r of await cache.keys()) if (!want.has(r.url)) await cache.delete(r);   // old versions
    const have = new Set((await cache.keys()).map(r => r.url)); let done = have.size;
    post({ type: 'clips', done, total: urls.length });
    const todo = urls.filter(u => !have.has(u));
    for (let i = 0; i < todo.length; i += 6) {                 // six at a time
      await Promise.all(todo.slice(i, i + 6).map(async u => { try { const r = await fetch(u); if (r.ok) { await cache.put(u, r); done++; } } catch (err) {} }));
      post({ type: 'clips', done, total: urls.length });
    }
  })().finally(() => { saving = null; });
  e.waitUntil && e.waitUntil(saving);
});
