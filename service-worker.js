const CACHE = 'familycare-senior-v5.1.1';
const SHELL = ['/pages/senior-login.html','/pages/senior.html','/pages/caregiver.html','/styles/common.css','/styles/access-v4.css','/styles/senior-kiosk.css','/assets/logo.svg','/assets/icon-192.png','/assets/icon-512.png','/manifest.webmanifest','/offline.html'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('familycare-senior-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
    return response;
  }).catch(() => caches.match(request).then(hit => hit || (request.mode === 'navigate' ? caches.match('/offline.html') : Response.error()))));
});
