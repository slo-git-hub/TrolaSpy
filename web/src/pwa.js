// Installable app + Android share target, so photos can be shared to TrolaSpy
// from another app (e.g. pCloud) instead of picked through the browser's file picker.
// Android hides GPS from browser file pickers, but not from files shared by an app.
// The service worker also shows the admin's phone alerts.

export const manifest = {
  name: 'TrolaSpy',
  short_name: 'Trola',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#175064',
  theme_color: '#175064',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  share_target: {
    action: '/share',
    method: 'POST',
    enctype: 'multipart/form-data',
    params: { files: [{ name: 'photos', accept: ['image/jpeg', 'image/*', '.jpg', '.jpeg'] }] },
  },
};

// The service worker catches the shared POST (it never reaches the Worker), parks the
// files in a cache and opens the page, which picks them up and starts the uploader.
export const serviceWorker = `
const SHARE_CACHE = 'trolaspy-share';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'POST' || url.pathname !== '/share') return;
  e.respondWith((async () => {
    const form = await e.request.formData();
    const files = form.getAll('photos').filter((f) => f && typeof f !== 'string');
    await caches.delete(SHARE_CACHE);
    const cache = await caches.open(SHARE_CACHE);
    await Promise.all(files.map((f, i) => cache.put('/shared/' + i, new Response(f, {
      headers: { 'content-type': f.type || 'image/jpeg', 'x-name': encodeURIComponent(f.name || 'photo.jpg'), 'x-modified': String(f.lastModified || 0) },
    }))));
    return Response.redirect('/?shared=' + files.length, 303);
  })());
});

// Phone alerts (see shared/push.js): show them, and open TrolaSpy when one is tapped.
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Trola', {
    body: d.body || '', icon: '/icon-192.png', tag: d.tag || 'trola', renotify: true, data: { url: '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (open.length) return open[0].focus();
    return self.clients.openWindow((e.notification.data && e.notification.data.url) || '/');
  })());
});
`;
