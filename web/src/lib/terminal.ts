export type TerminalStatus = 'running' | 'exited'

export interface Terminal {
  id: string
  cwd: string
  shell: string
  title: string
  sessionId?: string
  status: TerminalStatus
  exitCode: number
  createdAt: string
}

export interface OpenTerminalOptions {
  cwd?: string
  sessionId?: string
  cols?: number
  rows?: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(text || `${res.status} ${res.statusText}`)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

export function listTerminals(): Promise<Terminal[]> {
  return request<Terminal[]>('/api/terminals')
}

export function openTerminal(opts: OpenTerminalOptions): Promise<Terminal> {
  return request<Terminal>('/api/terminals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
}

export function closeTerminal(id: string): Promise<void> {
  return request<void>(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function renameTerminal(id: string, title: string): Promise<Terminal> {
  return request<Terminal>(`/api/terminals/${encodeURIComponent(id)}/title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  })
}

export function terminalURL(
  id: string,
  loc: { protocol: string; host: string } = window.location,
): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${loc.host}/api/terminals/${encodeURIComponent(id)}/pty`
}

// TerminalState is what the owner sees of the connection: dashed while it
// is being made, struck once it is lost or the shell has exited.
export type TerminalState = 'connecting' | 'live' | 'reconnecting' | 'disconnected' | 'exited'

export interface TerminalHandlers {
  onOutput: (data: Uint8Array) => void
  onExit: (code: number) => void
  // onReady marks the end of the scrollback replay. Replayed output may hold
  // terminal queries (cursor position, device attributes) whose answers must
  // not be sent to the shell again, so input should wait for it.
  onReady: () => void
  // onReset runs when a reconnected socket opens, before the server replays
  // the scrollback, so the screen must be cleared first.
  onReset: (reason?: 'reconnect' | 'upgrade') => void
  // onGiveUp runs when reconnecting failed maxAttempts times in a row while
  // the tab was hidden; reconnect() or showing the tab tries again.
  onGiveUp: () => void
  // onState reports each change of the connection; attempt counts the
  // failures in a row while reconnecting.
  onState?: (state: TerminalState, attempt?: number) => void
}

export interface TerminalConnection {
  send: (text: string) => void
  resize: (cols: number, rows: number) => void
  // reconnect tries again now: after giving up, or instead of waiting out
  // the backoff.
  reconnect: () => void
  close: () => void
}

interface SocketHandlers extends Omit<TerminalHandlers, 'onState'> {
  onRetry: (attempt: number) => void
}

interface SocketConnection extends Omit<TerminalConnection, 'reconnect'> {
  retryNow: () => void
}

const NORMAL_CLOSURE = 1000

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

export interface ConnectOptions {
  reconnectDelayMs?: number
  maxDelayMs?: number
  maxAttempts?: number
  stableMs?: number
  rtc?: boolean
}

// connectTerminal attaches to a shell over WebSocket: binary frames are
// output and input, text frames carry resize, the replay marker and the exit
// notice. Dropped connections (including "lagging" closes) reconnect with a
// growing delay; a normal close means the shell exited or the terminal was
// closed. Failures count as consecutive until a connection stays up for
// stableMs. While the tab is visible it never gives up; coming back online
// or showing the tab again reconnects at once.
export function connectTerminal(
  id: string,
  handlers: TerminalHandlers,
  options: ConnectOptions = {},
): TerminalConnection {
  let socket: SocketConnection
  let peer: RTCConnection | undefined
  let active: 'websocket' | 'webrtc' = 'websocket'
  let stopped = false
  let gaveUp = false
  let tried = false
  let generation = 0
  let size: { cols: number; rows: number } | undefined
  const encoder = new TextEncoder()
  const state = (s: TerminalState, attempt?: number) => handlers.onState?.(s, attempt)
  // socketReady: the current WebSocket replayed the scrollback, so an
  // upgrade can start.
  let socketReady = false
  const close = () => {
    if (stopped) return
    stopped = true
    unsubscribe()
    if (typeof window !== 'undefined') window.removeEventListener('online', wake)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    socket.close()
    peer?.close()
  }
  const fallback = () => {
    if (stopped) return
    const wasActive = active === 'webrtc'
    peer?.close(); peer = undefined
    if (wasActive) { active = 'websocket'; openSocket(true) }
  }
  const tryRTC = () => {
    if (tried || stopped || options.rtc === false || !rtcEnabled() || typeof RTCPeerConnection === 'undefined') return
    tried = true
    peer = connectRTC(id, {
      onOpen() {
        if (stopped) return
        active = 'webrtc'
        socket.close()
        handlers.onReset('upgrade')
        state('connecting')
        recordTerminalTransport(id, 'webrtc')
        if (size) peer?.send(JSON.stringify({ type: 'resize', ...size }))
      },
      onMessage(data) {
        if (stopped || active !== 'webrtc') return
        if (typeof data !== 'string') {
          if (data instanceof ArrayBuffer) handlers.onOutput(new Uint8Array(data))
          return
        }
        let msg: { type?: string; code?: number }
        try { msg = JSON.parse(data) } catch { return }
        if (msg.type === 'ready') { handlers.onReady(); state('live') }
        else if (msg.type === 'exit') { handlers.onExit(msg.code ?? -1); state('exited'); close() }
        else if (msg.type === 'closed') close()
        else if (msg.type === 'fallback') fallback()
      },
      onClose: fallback,
      onRoute(route, protocol) { if (!stopped && active === 'webrtc') recordTerminalTransport(id, 'webrtc', route, protocol) },
    })
  }
  function openSocket(reset: boolean) {
    const ownGeneration = ++generation
    socketReady = false
    gaveUp = false
    recordTerminalTransport(id, 'websocket')
    state(reset ? 'reconnecting' : 'connecting')
    const current = () => !stopped && active === 'websocket' && generation === ownGeneration
    socket = connectWebSocketTerminal(id, {
      onOutput(data) { if (current()) handlers.onOutput(data) },
      onReady() { if (current()) { socketReady = true; handlers.onReady(); state('live'); tryRTC() } },
      onReset() { if (current()) handlers.onReset() },
      onExit(code) { if (current()) { handlers.onExit(code); state('exited'); close() } },
      onGiveUp() { if (current()) { gaveUp = true; handlers.onGiveUp(); state('disconnected') } },
      onRetry(attempt) { if (current()) state('reconnecting', attempt) },
    }, { ...options, resetOnOpen: reset })
    if (size) socket.resize(size.cols, size.rows)
  }
  const reconnect = () => {
    if (stopped) return
    if (gaveUp) openSocket(true)
    else if (active === 'websocket') socket.retryNow()
  }
  function wake() { if (!hidden()) reconnect() }
  function onVisible() { if (!hidden()) reconnect() }
  // Turning WebRTC off moves an open terminal back to the WebSocket;
  // turning it on upgrades again, even after an earlier attempt failed.
  const unsubscribe = onRTCChange((on) => {
    if (!on) { fallback(); return }
    tried = false
    if (active === 'websocket' && socketReady) tryRTC()
  })
  if (typeof window !== 'undefined') window.addEventListener('online', wake)
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  openSocket(false)
  return {
    send(text) { if (!stopped) { if (active === 'webrtc') peer?.send(encoder.encode(text)); else socket.send(text) } },
    resize(cols, rows) {
      size = { cols, rows }
      if (!stopped) { if (active === 'webrtc') peer?.send(JSON.stringify({ type: 'resize', ...size })); else socket.resize(cols, rows) }
    },
    reconnect,
    close,
  }
}

function connectWebSocketTerminal(
  id: string,
  handlers: SocketHandlers,
  { reconnectDelayMs = 500, maxDelayMs = 10_000, maxAttempts = 5, stableMs = 10_000, resetOnOpen = false } = {},
): SocketConnection {
  const encoder = new TextEncoder()
  let ws: WebSocket
  let size: { cols: number; rows: number } | null = null
  let stopped = false
  let failures = 0
  let readyAt: number | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  const sendSize = () => {
    if (size && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', ...size }))
    }
  }

  const connect = (reconnect: boolean) => {
    timer = undefined
    ws = new WebSocket(terminalURL(id))
    ws.binaryType = 'arraybuffer'
    readyAt = null
    ws.onopen = () => {
      if (reconnect) handlers.onReset()
      sendSize()
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') {
        handlers.onOutput(new Uint8Array(ev.data as ArrayBuffer))
        return
      }
      let msg: { type?: string; code?: number }
      try {
        msg = JSON.parse(ev.data) as typeof msg
      } catch {
        return // not a control message
      }
      if (msg.type === 'ready') {
        readyAt = Date.now()
        handlers.onReady()
      } else if (msg.type === 'exit') {
        handlers.onExit(msg.code ?? -1)
      }
    }
    ws.onclose = (ev: CloseEvent) => {
      if (stopped || ev.code === NORMAL_CLOSURE) return
      if (readyAt !== null && Date.now() - readyAt >= stableMs) failures = 0
      failures++
      if (failures >= maxAttempts && hidden()) {
        stopped = true
        handlers.onGiveUp()
        return
      }
      handlers.onRetry(failures)
      const delay = Math.min(reconnectDelayMs * 2 ** (failures - 1), maxDelayMs)
      timer = setTimeout(() => connect(true), delay)
    }
  }
  connect(resetOnOpen)

  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(text))
    },
    resize: (cols, rows) => {
      size = { cols, rows }
      sendSize()
    },
    retryNow: () => {
      if (stopped || timer === undefined) return
      clearTimeout(timer)
      connect(true)
    },
    close: () => {
      stopped = true
      clearTimeout(timer)
      ws.close()
    },
  }
}
import { connectRTC, type RTCConnection } from './rtc'
import { recordTerminalTransport } from './diagnostics'
import { onRTCChange, rtcEnabled } from './transport'
