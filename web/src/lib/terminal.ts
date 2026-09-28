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

export interface TerminalHandlers {
  onOutput: (data: Uint8Array) => void
  onExit: (code: number) => void
  // onReady marks the end of the scrollback replay. Replayed output may hold
  // terminal queries (cursor position, device attributes) whose answers must
  // not be sent to the shell again, so input should wait for it.
  onReady: () => void
  // onReset runs when a reconnected socket opens, before the server replays
  // the scrollback, so the screen must be cleared first.
  onReset: () => void
  // onGiveUp runs when reconnecting failed maxAttempts times in a row.
  onGiveUp: () => void
}

export interface TerminalConnection {
  send: (text: string) => void
  resize: (cols: number, rows: number) => void
  close: () => void
}

const NORMAL_CLOSURE = 1000

// connectTerminal attaches to a shell over WebSocket: binary frames are
// output and input, text frames carry resize, the replay marker and the exit
// notice. Dropped connections (including "lagging" closes) reconnect; a
// normal close means the shell exited or the terminal was closed. Failures
// count as consecutive until a connection stays up for stableMs.
export function connectTerminal(
  id: string,
  handlers: TerminalHandlers,
  { reconnectDelayMs = 500, maxAttempts = 5, stableMs = 10_000 } = {},
): TerminalConnection {
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
      if (failures >= maxAttempts) {
        stopped = true
        handlers.onGiveUp()
        return
      }
      timer = setTimeout(() => connect(true), reconnectDelayMs)
    }
  }
  connect(false)

  return {
    send: (text) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(text))
    },
    resize: (cols, rows) => {
      size = { cols, rows }
      sendSize()
    },
    close: () => {
      stopped = true
      clearTimeout(timer)
      ws.close()
    },
  }
}
