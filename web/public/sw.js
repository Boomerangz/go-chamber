// go-chamber service worker: shows push notifications and opens the session
// they are about. Nothing is cached — the app needs the server anyway.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let n = {}
  try {
    n = event.data ? event.data.json() : {}
  } catch {
    n = { title: 'go-chamber', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(n.title || 'go-chamber', {
      body: n.body || '',
      tag: n.tag || undefined,
      renotify: Boolean(n.tag),
      icon: '/icon-192.png',
      data: { url: n.url || '/' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) return open.focus().then((w) => w.navigate(url))
      return self.clients.openWindow(url)
    }),
  )
})
