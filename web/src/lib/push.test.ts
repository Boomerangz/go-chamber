import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeKey, disablePush, enablePush, pushBlocked, pushEnabled, pushFailure, pushNeedsHttps, pushSupported, WorkerUnavailable } from './push'

function install({ permission = 'granted', existing = null as null | { endpoint: string } } = {}) {
  const sub = { endpoint: 'https://push.example/1', toJSON: () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } }), unsubscribe: vi.fn(async () => true) }
  const pushManager = {
    getSubscription: vi.fn(async () => (existing ? { ...sub, ...existing } : null)),
    subscribe: vi.fn(async () => sub),
  }
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve({ pushManager }), register: vi.fn() } })
  vi.stubGlobal('PushManager', function PushManager() {})
  vi.stubGlobal('Notification', { requestPermission: vi.fn(async () => permission), permission })
  const fetchMock = vi.fn(async (url: string) => new Response(url.endsWith('/key') ? JSON.stringify({ key: 'AQID' }) : null, { status: url.endsWith('/key') ? 200 : 204 }))
  vi.stubGlobal('fetch', fetchMock)
  return { pushManager, sub, fetchMock }
}

describe('push', () => {
  beforeEach(() => vi.unstubAllGlobals())
  afterEach(() => vi.unstubAllGlobals())

  it('decodes a base64url VAPID key', () => {
    expect(Array.from(decodeKey('AQID'))).toEqual([1, 2, 3])
    expect(Array.from(decodeKey('-_8'))).toEqual([251, 255])
  })

  it('knows when the browser cannot push', () => {
    vi.stubGlobal('navigator', {})
    expect(pushSupported()).toBe(false)
    install()
    expect(pushSupported()).toBe(true)
  })

  it('subscribes with the server key and registers the subscription', async () => {
    const { pushManager, fetchMock } = install()
    await enablePush()
    expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) })
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('/api/push/subscriptions')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ endpoint: 'https://push.example/1', keys: { p256dh: 'k', auth: 'a' } })
  })

  it('refuses when notifications are not allowed', async () => {
    const { pushManager } = install({ permission: 'denied' })
    await expect(enablePush()).rejects.toThrow(/blocked for this site/)
    expect(pushManager.subscribe).not.toHaveBeenCalled()
  })

  it('says when the permission prompt was dismissed', async () => {
    install({ permission: 'default' })
    await expect(enablePush()).rejects.toThrow("The browser didn't allow notifications: its prompt was closed")
  })

  it('knows a blocked permission', () => {
    install({ permission: 'denied' })
    expect(pushBlocked()).toBe(true)
    install({ permission: 'granted' })
    expect(pushBlocked()).toBe(false)
  })

  it('knows when plain HTTP is why the browser cannot push', () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('isSecureContext', false)
    expect(pushNeedsHttps()).toBe(true)
    vi.stubGlobal('isSecureContext', true)
    expect(pushNeedsHttps()).toBe(false)
    install()
    vi.stubGlobal('isSecureContext', false)
    expect(pushNeedsHttps()).toBe(false)
  })

  it('puts the browser subscribe failures in plain words', () => {
    expect(pushFailure(new DOMException('Registration failed - permission denied', 'NotAllowedError'))).toMatch(/blocked for this site/)
    expect(pushFailure(new DOMException('Registration failed - push service error', 'AbortError'))).toBe(
      "The browser's push service didn't answer. Try again in a moment.",
    )
    expect(pushFailure(new DOMException('Registration failed - push service not available', 'NotSupportedError'))).toBe(
      "This browser can't receive notifications here.",
    )
    expect(pushFailure(new WorkerUnavailable())).toBe(new WorkerUnavailable().message)
    expect(pushFailure(new Error('500 Internal Server Error'))).toBe('500 Internal Server Error')
  })

  it('unsubscribes on both sides', async () => {
    const { sub, fetchMock } = install({ existing: { endpoint: 'https://push.example/1' } })
    expect(await pushEnabled()).toBe(true)
    await disablePush()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/push/subscriptions')
    expect(init.method).toBe('DELETE')
    expect(sub.unsubscribe).toHaveBeenCalled()
  })

  it('passes on a service worker that failed to get ready', async () => {
    install()
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.reject('broken'), register: vi.fn() } })
    await expect(pushEnabled()).rejects.toThrow('broken')
    vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.reject(new TypeError('bad')), register: vi.fn() } })
    await expect(pushEnabled()).rejects.toBeInstanceOf(TypeError)
  })

  it('names why notifications are unavailable', () => {
    expect(new WorkerUnavailable().message).toBe("Notifications are unavailable: the service worker didn't start")
  })

  it('gives up on a service worker that never becomes ready', async () => {
    install()
    vi.stubGlobal('navigator', { serviceWorker: { ready: new Promise(() => {}), register: vi.fn() } })
    vi.useFakeTimers()
    try {
      const check = pushEnabled().catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(3000)
      expect(await check).toBeInstanceOf(WorkerUnavailable)
    } finally {
      vi.useRealTimers()
    }
  })
})

