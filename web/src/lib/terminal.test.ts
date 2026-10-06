import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeTerminal,
  connectTerminal,
  listTerminals,
  openTerminal,
  terminalURL,
  type TerminalHandlers,
} from './terminal'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn(impl)
  vi.stubGlobal('fetch', fn)
  return fn
}

describe('terminal REST', () => {
  it('lists terminals', async () => {
    const fn = stubFetch(async () => new Response(JSON.stringify([{ id: 't1' }])))
    expect(await listTerminals()).toEqual([{ id: 't1' }])
    expect(fn).toHaveBeenCalledWith('/api/terminals', { credentials: 'same-origin' })
  })

  it('opens a terminal with options', async () => {
    const fn = stubFetch(async () => new Response(JSON.stringify({ id: 't1' }), { status: 201 }))
    expect(await openTerminal({ cwd: '/srv', cols: 80, rows: 24 })).toEqual({ id: 't1' })
    const [url, init] = fn.mock.calls[0]
    expect(url).toBe('/api/terminals')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ cwd: '/srv', cols: 80, rows: 24 })
  })

  it('closes a terminal', async () => {
    const fn = stubFetch(async () => new Response(null, { status: 204 }))
    await closeTerminal('a/b')
    expect(fn).toHaveBeenCalledWith('/api/terminals/a%2Fb', { credentials: 'same-origin', method: 'DELETE' })
  })

  it('surfaces server errors', async () => {
    stubFetch(async () => new Response('{"error":"bad cwd"}', { status: 400 }))
    await expect(openTerminal({ cwd: 'x' })).rejects.toThrow(/^bad cwd$/)
  })
})

describe('terminalURL', () => {
  it('uses ws for http and wss for https', () => {
    expect(terminalURL('t 1', { protocol: 'http:', host: 'h:1' })).toBe('ws://h:1/api/terminals/t%201/pty')
    expect(terminalURL('t', { protocol: 'https:', host: 'x.ts.net' })).toBe('wss://x.ts.net/api/terminals/t/pty')
  })

  it('defaults to the page location', () => {
    expect(terminalURL('t')).toBe(`ws://${window.location.host}/api/terminals/t/pty`)
  })
})

class FakeSocket {
  static OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  binaryType = 'blob'
  sent: unknown[] = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }
  send(data: unknown) {
    this.sent.push(data)
  }
  close() {
    this.closed = true
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(data: unknown) {
    this.onmessage?.({ data })
  }
  drop(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]

function handlers(): TerminalHandlers & {
  output: string[]
  exits: number[]
  resets: number
  readies: number
  gaveUp: number
} {
  const h = {
    output: [] as string[],
    exits: [] as number[],
    resets: 0,
    readies: 0,
    gaveUp: 0,
    onOutput: (d: Uint8Array) => h.output.push(new TextDecoder().decode(d)),
    onExit: (code: number) => h.exits.push(code),
    onReset: () => {
      h.resets++
    },
    onReady: () => {
      h.readies++
    },
    onGiveUp: () => {
      h.gaveUp++
    },
  }
  return h
}

function hide(hidden: boolean) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
}

describe('connectTerminal', () => {
  beforeEach(() => {
    FakeSocket.instances = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.useFakeTimers()
  })
  afterEach(() => {
    hide(false)
  })

  it('backs off from half a second to ten and keeps trying while the tab is visible', () => {
    const h = handlers()
    const states: string[] = []
    connectTerminal('t1', { ...h, onState: (s, attempt) => states.push(attempt ? `${s} ${attempt}` : s) })
    const waits: number[] = []
    for (let i = 0; i < 8; i++) {
      const before = FakeSocket.instances.length
      last().drop(1006)
      let waited = 0
      while (FakeSocket.instances.length === before) {
        vi.advanceTimersByTime(100)
        waited += 100
      }
      waits.push(waited)
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000])
    expect(h.gaveUp).toBe(0)
    expect(states.slice(0, 3)).toEqual(['connecting', 'reconnecting 1', 'reconnecting 2'])
  })

  it('reconnects at once when the network returns or the tab is shown again', () => {
    const h = handlers()
    connectTerminal('t1', h)
    for (let i = 0; i < 4; i++) {
      last().drop(1006)
      vi.advanceTimersByTime(10_000)
    }
    expect(FakeSocket.instances).toHaveLength(5)
    last().drop(1006)
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.instances).toHaveLength(6)
    last().drop(1006)
    hide(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(FakeSocket.instances).toHaveLength(7)
    // nothing pending: a second wake does not open another socket
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.instances).toHaveLength(7)
  })

  it('reports its state: connecting, live, reconnecting, exited', () => {
    const states: string[] = []
    connectTerminal('t1', { ...handlers(), onState: (s) => states.push(s) })
    last().open()
    last().message('{"type":"ready"}')
    last().drop(1006)
    vi.advanceTimersByTime(500)
    last().open()
    last().message('{"type":"ready"}')
    last().message('{"type":"exit","code":0}')
    expect(states).toEqual(['connecting', 'live', 'reconnecting', 'live', 'exited'])
  })

  it('reconnects on demand after giving up, and on its own once the tab is shown', () => {
    hide(true)
    const h = handlers()
    const states: string[] = []
    const conn = connectTerminal('t1', { ...h, onState: (s) => states.push(s) }, { reconnectDelayMs: 10, maxAttempts: 1 })
    last().drop(1006)
    expect(h.gaveUp).toBe(1)
    expect(states.at(-1)).toBe('disconnected')
    conn.reconnect()
    expect(FakeSocket.instances).toHaveLength(2)
    expect(states.at(-1)).toBe('reconnecting')
    last().open()
    expect(h.resets).toBe(1)
    last().drop(1006)
    expect(h.gaveUp).toBe(2)
    hide(false)
    document.dispatchEvent(new Event('visibilitychange'))
    expect(FakeSocket.instances).toHaveLength(3)
    conn.close()
    window.dispatchEvent(new Event('online'))
    conn.reconnect()
    expect(FakeSocket.instances).toHaveLength(3)
  })

  it('streams binary output and sends input and size', () => {
    const h = handlers()
    const conn = connectTerminal('t1', h)
    const ws = last()
    expect(ws.url).toBe(terminalURL('t1'))
    expect(ws.binaryType).toBe('arraybuffer')

    conn.send('dropped before open')
    conn.resize(100, 30)
    expect(ws.sent).toEqual([])
    ws.open()
    expect(ws.sent).toEqual([JSON.stringify({ type: 'resize', cols: 100, rows: 30 })])

    ws.message(new TextEncoder().encode('hello').buffer)
    expect(h.output).toEqual(['hello'])

    conn.send('ls\r')
    expect(new TextDecoder().decode(ws.sent[1] as Uint8Array)).toBe('ls\r')
    conn.resize(120, 40)
    expect(ws.sent[2]).toBe(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
  })

  it('reports exit and does not reconnect', () => {
    const h = handlers()
    connectTerminal('t1', h)
    const ws = last()
    ws.open()
    ws.message('{"type":"exit","code":3}')
    ws.drop(1000)
    vi.advanceTimersByTime(10_000)
    expect(h.exits).toEqual([3])
    expect(FakeSocket.instances).toHaveLength(1)
  })

  it('reports an exit without code as -1', () => {
    const h = handlers()
    connectTerminal('t1', h)
    last().open()
    last().message('{"type":"exit"}')
    expect(h.exits).toEqual([-1])
  })

  it('ignores unknown text frames', () => {
    const h = handlers()
    connectTerminal('t1', h)
    last().open()
    last().message('not json')
    last().message('{"type":"other"}')
    expect(h.exits).toEqual([])
    expect(h.output).toEqual([])
  })

  it('does not reconnect after a normal close', () => {
    const h = handlers()
    connectTerminal('t1', h)
    last().open()
    last().drop(1000)
    vi.advanceTimersByTime(10_000)
    expect(FakeSocket.instances).toHaveLength(1)
    expect(h.resets).toBe(0)
  })

  it('signals when the scrollback replay is done', () => {
    const h = handlers()
    connectTerminal('t1', h)
    last().open()
    last().message(new TextEncoder().encode('old').buffer)
    expect(h.readies).toBe(0)
    last().message('{"type":"ready"}')
    expect(h.readies).toBe(1)
    expect(h.output).toEqual(['old'])
  })

  it('reconnects after lagging or a dropped connection, resetting once reopened', () => {
    const h = handlers()
    const conn = connectTerminal('t1', h, { reconnectDelayMs: 100 })
    conn.resize(90, 20)
    last().open()
    expect(h.resets).toBe(0)
    last().drop(1013)
    vi.advanceTimersByTime(99)
    expect(FakeSocket.instances).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(2)
    expect(h.resets).toBe(0)
    last().open()
    expect(h.resets).toBe(1)
    expect(last().sent).toEqual([JSON.stringify({ type: 'resize', cols: 90, rows: 20 })])
    last().drop(1006)
    // the second failure in a row waits twice as long
    vi.advanceTimersByTime(199)
    expect(FakeSocket.instances).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.instances).toHaveLength(3)
    last().open()
    expect(h.resets).toBe(2)
  })

  it('gives up after repeated failures without opening while the tab is hidden', () => {
    hide(true)
    const h = handlers()
    connectTerminal('t1', h, { reconnectDelayMs: 10, maxAttempts: 3 })
    for (let i = 0; i < 5; i++) {
      last().drop(1006)
      vi.advanceTimersByTime(1000)
    }
    expect(FakeSocket.instances).toHaveLength(3)
    expect(h.gaveUp).toBe(1)
    expect(h.resets).toBe(0)
  })

  it('caps reconnects that keep lagging right after opening while the tab is hidden', () => {
    hide(true)
    const h = handlers()
    connectTerminal('t1', h, { reconnectDelayMs: 10, maxAttempts: 3 })
    for (let i = 0; i < 5; i++) {
      last().open()
      last().message('{"type":"ready"}')
      last().drop(1013)
      vi.advanceTimersByTime(1000)
    }
    expect(FakeSocket.instances).toHaveLength(3)
    expect(h.gaveUp).toBe(1)
  })

  it('forgets old failures once a connection was stable', () => {
    const h = handlers()
    connectTerminal('t1', h, { reconnectDelayMs: 10, maxAttempts: 2, stableMs: 1000 })
    for (let i = 0; i < 4; i++) {
      last().open()
      last().message('{"type":"ready"}')
      vi.advanceTimersByTime(1000)
      last().drop(1006)
      vi.advanceTimersByTime(10)
    }
    expect(FakeSocket.instances).toHaveLength(5)
    expect(h.gaveUp).toBe(0)
  })

  it('close stops the socket and pending reconnects', () => {
    const h = handlers()
    const conn = connectTerminal('t1', h, { reconnectDelayMs: 10 })
    last().open()
    last().drop(1006)
    conn.close()
    vi.advanceTimersByTime(100)
    expect(FakeSocket.instances).toHaveLength(1)
    const conn2 = connectTerminal('t2', h)
    const ws = last()
    conn2.close()
    expect(ws.closed).toBe(true)
    ws.drop(1006)
    vi.advanceTimersByTime(10_000)
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
