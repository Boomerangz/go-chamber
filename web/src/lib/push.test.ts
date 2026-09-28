import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeKey, disablePush, enablePush, pushEnabled, pushSupported } from './push'

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
    await expect(enablePush()).rejects.toThrow(/not allowed/)
    expect(pushManager.subscribe).not.toHaveBeenCalled()
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
})
