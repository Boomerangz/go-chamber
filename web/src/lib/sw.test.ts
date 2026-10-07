import { beforeEach, describe, expect, it, vi } from 'vitest'
import source from '../../public/sw.js?raw'

// The service worker is a plain script in public/; it runs here against a
// stand-in for its global scope.

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

interface Shown {
  title: string
  options: { tag?: string; silent?: boolean; body?: string }
  close: ReturnType<typeof vi.fn>
}

function worker(userAgent: string, windows: { url: string; focused: boolean; visibilityState: string }[] = []) {
  const handlers: Record<string, (event: unknown) => void> = {}
  const shown: Shown[] = []
  const scope = {
    navigator: { userAgent },
    location: { origin: 'https://chamber.test' },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers[type] = fn
    },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => windows), openWindow: vi.fn() },
    registration: {
      showNotification: vi.fn(async (title: string, options: Shown['options']) => {
        const old = shown.findIndex((n) => options.tag && n.options.tag === options.tag)
        if (old >= 0) shown.splice(old, 1)
        const n: Shown = { title, options, close: vi.fn(() => shown.splice(shown.indexOf(n), 1)) }
        shown.push(n)
      }),
      getNotifications: vi.fn(async ({ tag }: { tag?: string } = {}) => shown.filter((n) => !tag || n.options.tag === tag)),
    },
  }
  new Function('self', source)(scope)
  const push = async (data: object) => {
    let done: Promise<unknown> = Promise.resolve()
    handlers.push!({ data: { json: () => data, text: () => JSON.stringify(data) }, waitUntil: (p: Promise<unknown>) => (done = p) })
    await done
  }
  return { push, shown, scope }
}

const finished = { title: 'Fix finished', body: 'done', url: '/s/s1', tag: 'turn-s1' }

describe('service worker', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows what the server pushes', async () => {
    const w = worker(CHROME)
    await w.push(finished)
    expect(w.shown.map((n) => n.title)).toEqual(['Fix finished'])
  })

  it('stays quiet while a focused window shows that very session', async () => {
    const w = worker(CHROME, [{ url: 'https://chamber.test/s/s1?x=1', focused: true, visibilityState: 'visible' }])
    await w.push(finished)
    expect(w.shown).toEqual([])
  })

  it('still shows it when the focused window is elsewhere, or not in front', async () => {
    const elsewhere = worker(CHROME, [{ url: 'https://chamber.test/s/s2', focused: true, visibilityState: 'visible' }])
    await elsewhere.push(finished)
    expect(elsewhere.shown).toHaveLength(1)
    const behind = worker(CHROME, [{ url: 'https://chamber.test/s/s1', focused: false, visibilityState: 'visible' }])
    await behind.push(finished)
    expect(behind.shown).toHaveLength(1)
  })

  it('always shows on WebKit, which takes the subscription away after pushes that show nothing', async () => {
    const w = worker(SAFARI, [{ url: 'https://chamber.test/s/s1', focused: true, visibilityState: 'visible' }])
    await w.push(finished)
    expect(w.shown).toHaveLength(1)
  })

  it('takes back a request answered elsewhere, showing nothing that stays', async () => {
    for (const ua of [CHROME, SAFARI]) {
      const w = worker(ua)
      await w.push({ title: 'Fix needs you', body: 'Run', url: '/s/s1', tag: 'request-r1' })
      await w.push({ title: 'Other needs you', url: '/s/s2', tag: 'request-r2' })
      await w.push({ title: 'Fix: answered', url: '/s/s1', tag: 'request-r1', close: true })
      expect(w.shown.map((n) => n.options.tag)).toEqual(['request-r2'])
      // The stand-in that keeps the push visible is a quiet one.
      const calls = w.scope.registration.showNotification.mock.calls
      expect(calls.at(-1)![1]).toMatchObject({ tag: 'request-r1', silent: true })
    }
  })
})
