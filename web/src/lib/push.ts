// Web Push: the service worker shows notifications the server sends when an
// agent asks for a decision or a turn ends. Needs HTTPS (or localhost).

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined' && typeof Notification !== 'undefined'
}

export function registerWorker(): void {
  if (pushSupported()) void navigator.serviceWorker.register('/sw.js').catch(() => {})
}

// decodeKey turns the server's base64url VAPID key into bytes.
export function decodeKey(key: string): Uint8Array<ArrayBuffer> {
  const b64 = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '=')
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

// WorkerUnavailable means the service worker never started (its
// registration failed), so this browser can't receive pushes here.
export class WorkerUnavailable extends Error {
  constructor() {
    super("Notifications are unavailable: the service worker didn't start")
  }
}

const READY_MS = 3000

// ready is the active service worker, or WorkerUnavailable after a wait:
// serviceWorker.ready never settles when registration failed.
function ready(): Promise<ServiceWorkerRegistration> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new WorkerUnavailable()), READY_MS)
    navigator.serviceWorker.ready.then(
      (reg) => {
        clearTimeout(timer)
        resolve(reg)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await ready()
  return reg.pushManager.getSubscription()
}

export async function pushEnabled(): Promise<boolean> {
  return pushSupported() && Notification.permission === 'granted' && (await subscription()) !== null
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `${res.status} ${res.statusText}`)
  return res
}

export async function enablePush(): Promise<void> {
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are not allowed in this browser')
  const { key } = (await (await call('GET', '/api/push/key')).json()) as { key: string }
  const reg = await ready()
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(key) })
  await call('POST', '/api/push/subscriptions', sub.toJSON())
}

export async function disablePush(): Promise<void> {
  const sub = await subscription()
  if (!sub) return
  await call('DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint })
  await sub.unsubscribe()
}
