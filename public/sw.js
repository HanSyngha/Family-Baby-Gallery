// v4 - 무한 리로드 수정
const SW_VERSION = 4;

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

// API 요청은 브라우저 HTTP 캐시를 무시하고 반드시 서버에서 가져옴
self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
  }
});

// Service Worker for Push Notifications
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || '땅콩땅콩땅콩콩땅';
  const options = {
    body: data.body || '새로운 사진이 올라왔어요! 🥜',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || 'new-media',
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: '보러가기 🥜' },
    ],
    vibrate: [100, 50, 100],
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
