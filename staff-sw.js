// Bloom staff: notifications only. No caching, so pages always load fresh.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || 'Bloom', {
      body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
      icon: '/images/staff-icon-192.png', badge: '/images/staff-icon-192.png',
      data: { url: d.url || '/staff-dashboard.html' }
    });
    try { const n = (await self.registration.getNotifications()).length; if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n); } catch (err) {}
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/staff-dashboard.html', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { try { await c.navigate(url); } catch (err) {} return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
