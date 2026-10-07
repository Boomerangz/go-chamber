// go-chamber service worker: shows push notifications and opens the session
// they are about. Nothing is cached — the app needs the server anyway.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// WebKit (Safari, and every browser on iOS) takes the push subscription
// away after a few pushes that show nothing, so there every push shows one.
function webkit() {
  const ua = (self.navigator && self.navigator.userAgent) || ''
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|Android/.test(ua)
}

// showing tells whether a focused, visible window shows the page url points at.
async function showing(url) {
  const path = new URL(url, self.location.origin).pathname
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  return windows.some((w) => w.focused && w.visibilityState === 'visible' && new URL(w.url).pathname === path)
}

// takeBack closes what is shown under tag, a request answered on another
// device. A quiet stand-in is shown first and closed with the rest, so the
// push still shows something, as browsers ask.
async function takeBack(n) {
  await self.registration.showNotification(n.title || 'go-chamber', {
    body: n.body || '',
    tag: n.tag,
    silent: true,
    icon: '/icon-192.png',
    data: { url: n.url || '/' },
  })
  const open = await self.registration.getNotifications({ tag: n.tag })
  for (const shown of open) shown.close()
}

self.addEventListener('push', (event) => {
  let n = {}
  try {
    n = event.data ? event.data.json() : {}
  } catch {
    n = { title: 'go-chamber', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    (async () => {
      if (n.close && n.tag) return takeBack(n)
      // The owner is looking at it already; only WebKit insists on a show.
      if (!webkit() && (await showing(n.url || '/'))) return
      await self.registration.showNotification(n.title || 'go-chamber', {
        body: n.body || '',
        tag: n.tag || undefined,
        renotify: Boolean(n.tag),
        icon: '/icon-192.png',
        data: { url: n.url || '/' },
      })
    })(),
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
