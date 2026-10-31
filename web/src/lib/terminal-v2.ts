import type { ConnectOptions, TerminalClientState, TerminalConnection, TerminalHandlers } from './terminal'
import { recordTerminalTransport, recordTerminalRTT, recordSample, recordTerminalInput } from './diagnostics'

import { rtcV2Wire, type V2Wire } from './rtc-v2'
import { onRTCChange, rtcEnabled } from './transport'

type Control = Partial<TerminalClientState> & { type: string; run?: string; cols?: number; rows?: number; bytes?: number; position?: number; code?: number; token?: string; promptId?: number; commandId?: number; prompt?: boolean; inputPipeline?: boolean }

// Pending keystrokes live only in this connection object in this tab. Nothing
// is persisted: neither reload nor another server run may replay them.
export function connectTerminalV2(id: string, h: TerminalHandlers, options: ConnectOptions = {}): TerminalConnection {
  const client = crypto.randomUUID()
  const encoder = new TextEncoder()
  let ws: V2Wire
  let candidate: V2Wire | undefined
  let rtcTimer: ReturnType<typeof setTimeout> | undefined
  let rtcDelay = 1000
  let transport: 'websocket' | 'webrtc' = 'websocket'
  let activatedAt = 0
  let generation = 0
  let stopped = false
  let attempt = 0
  let retry: ReturnType<typeof setTimeout> | undefined
  let run: string | undefined
  let state: TerminalClientState = { owner: false, epoch: 0, written: 0, uncertain: false, pendingBytes: 0 }
  let pending = new Uint8Array(0)
  let base = 0
  let inflight = false
  let pipeline = false
  let sentThrough = 0
  let hello = false
  let ready = false
  let size: { cols: number; rows: number } | undefined
  let received = 0
  let acknowledged = 0
  let position = 0
  let restoring = 0
  let promptId = 0, commandId = 0, atPrompt = false
  let deliveries: { length: number; done: boolean }[] = []
  let ping: { token: string; at: number } | undefined
  let sequence = 0
  const emit = (problem = state.problem) => { state = { ...state, pendingBytes: pending.length, problem }; recordTerminalInput(id, pending.length); h.onClientState?.(state) }
  const control = (value: object) => { if (ws?.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(value)); return true } catch { reconnect(); return false } }; return false }
  const flush = () => {
    if (!hello || !state.owner || state.uncertain || (!pipeline && inflight) || !pending.length || ws.readyState !== WebSocket.OPEN) return
    let offset = pipeline ? Math.max(base, sentThrough) : base
    while (offset < base + pending.length) {
      const data = pending.subarray(offset - base, offset - base + (16 << 10) - 17)
      const frame = new Uint8Array(17 + data.length)
      frame[0] = 3
      const view = new DataView(frame.buffer)
      view.setBigUint64(1, BigInt(state.epoch)); view.setBigUint64(9, BigInt(offset))
      frame.set(data, 17)
      inflight = true; sentThrough = offset + data.length
      try { ws.send(frame) } catch { inflight = false; reconnect(); return }
      if (!pipeline) return
      offset = sentThrough
    }
  }
  const applyState = (msg: Control) => {
    if (!Number.isSafeInteger(msg.epoch) || !Number.isSafeInteger(msg.written)) { pending = new Uint8Array(0); state.uncertain = true; emit(msg.problem ?? 'Input state is unknown; take control to continue.'); return }
    const epoch = msg.epoch!, written = msg.written!
    if (epoch < state.epoch || (epoch === state.epoch && msg.owner && !msg.uncertain && !msg.problem && written < base)) {
      if (msg.type === 'hello') { inflight = false; emit(); flush() }
      return
    }
    const cancelled = pending.length > 0 && (state.epoch !== epoch || !msg.owner)
    if (state.epoch !== epoch || !msg.owner || msg.uncertain || msg.problem || written < base || written > base + pending.length) {
      pending = new Uint8Array(0); base = written; sentThrough = base
    } else if (written > base) {
      pending = pending.slice(written - base); base = written
    }
    state = { owner: msg.owner === true, epoch, written, uncertain: msg.uncertain === true, pendingBytes: pending.length, problem: msg.problem ?? (cancelled ? 'Pending input was cancelled after control changed.' : undefined) }
    inflight = false
    emit()
    flush()
  }
  const resize = () => { if (hello && ready && size && state.owner) control({ type: 'resize', epoch: state.epoch, ...size }) }
  const scheduleRTC = () => {
    if (stopped || rtcTimer || candidate || transport !== 'websocket' || !ready || options.rtc === false || !rtcEnabled() || typeof RTCPeerConnection === 'undefined') return
    rtcTimer = setTimeout(() => {
      rtcTimer = undefined
      if (stopped || transport !== 'websocket' || !ready) return
      const own = rtcV2Wire(id, client, (route, protocol) => { if (ws === own && !stopped) recordTerminalTransport(id, 'webrtc', route, protocol) })
      candidate = own
      const queued: MessageEvent[] = []
      let queuedBytes = 0
      own.onmessage = (event) => {
        if (candidate !== own || stopped) return
        let isHello = false
        if (typeof event.data === 'string') { try { isHello = JSON.parse(event.data).type === 'hello' } catch { return } }
        if (!isHello) {
          queuedBytes += typeof event.data === 'string' ? event.data.length : (event.data as ArrayBuffer).byteLength
          if (queuedBytes > 128 << 10) { own.close(); candidate = undefined; rtcDelay = Math.min(rtcDelay * 2, 30000); scheduleRTC(); return }
          queued.push(event); return
        }
        candidate = undefined
        activate(own, 'webrtc')
        own.onmessage?.(event)
        for (const buffered of queued) own.onmessage?.(buffered)
      }
      own.onclose = () => { if (candidate === own) { candidate = undefined; rtcDelay = Math.min(rtcDelay * 2, 30000); scheduleRTC() } }
    }, rtcDelay)
  }
  const connect = () => {
    clearTimeout(retry); retry = undefined; clearTimeout(rtcTimer); rtcTimer = undefined
    candidate?.close(); candidate = undefined
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    activate(new WebSocket(`${scheme}//${window.location.host}/api/terminals/${encodeURIComponent(id)}/pty?v=2&client=${client}`), 'websocket')
  }
  function activate(socket: V2Wire, kind: 'websocket' | 'webrtc') {
    const mine = ++generation
    ws?.close()
    hello = false; ready = false; inflight = false; ping = undefined
    pipeline = false; sentThrough = base
    received = 0; acknowledged = 0; deliveries = []; restoring = 0
    h.onState?.(attempt ? 'reconnecting' : 'connecting', attempt)
    transport = kind; activatedAt = performance.now()
    recordTerminalTransport(id, kind)
    ws = socket
    ws.binaryType = 'arraybuffer'
    const current = () => !stopped && mine === generation
    ws.onmessage = (event: MessageEvent) => {
      if (!current()) return
      if (typeof event.data !== 'string') {
        const b = new Uint8Array(event.data as ArrayBuffer)
        if (b.length < 9 || b.length > 16 << 10 || !hello) { reconnect(); return }
        const at = Number(new DataView(b.buffer, b.byteOffset).getBigUint64(1))
        const data = b.slice(9)
        if (b[0] === 2) { if (!restoring || restoring < data.length) { reconnect(); return }; restoring -= data.length }
        else if (b[0] === 1) { if (at !== position + data.length) { reconnect(); return }; position = at }
        else { reconnect(); return }
        received += data.length
        const delivery = { length: data.length, done: false }; deliveries.push(delivery)
        h.onOutput(data, () => {
          if (!current() || delivery.done) return
          delivery.done = true
          while (deliveries[0]?.done) acknowledged += deliveries.shift()!.length
          control({ type: 'ack', bytes: acknowledged })
        })
        return
      }
      let msg: Control
      try { msg = JSON.parse(event.data) as Control } catch { return }
      switch (msg.type) {
        case 'hello': {
          const changed = run !== undefined && run !== msg.run
          if (changed) { pending = new Uint8Array(0); base = msg.written ?? 0; state = { owner: false, epoch: 0, written: base, uncertain: false, pendingBytes: 0 } }
          run = msg.run; hello = true; pipeline = msg.inputPipeline === true; sentThrough = base; applyState(msg)
          if (changed) emit('Server restarted; pending input was cancelled.')
          break
        }
        case 'control': case 'inputAck': applyState(msg); resize(); break
        case 'snapshot':
          ready = false; position = msg.position ?? 0; restoring = msg.bytes ?? 0
          promptId = msg.promptId ?? 0; commandId = msg.commandId ?? 0; atPrompt = msg.prompt === true
          h.onReset('resync'); h.onSnapshot?.(msg.cols ?? 80, msg.rows ?? 24)
          break
        case 'ready':
          if (restoring) { reconnect(); return }
          ready = true; attempt = 0; h.onReady(); h.onPrompt?.(promptId, atPrompt, commandId); h.onState?.('live'); resize(); flush(); scheduleRTC(); break
        case 'prompt': h.onPrompt?.(msg.promptId ?? 0, msg.prompt === true, msg.commandId ?? 0); break
        case 'problem': emit(msg.problem); break
        case 'pong':
          if (ping && ping.token === msg.token) { const ms = performance.now() - ping.at; if (transport === 'webrtc') recordTerminalRTT(id, ms); else recordSample('ws', ms); h.onRTT?.(ms); ping = undefined }
          break
        case 'exit': pending = new Uint8Array(0); emit(); h.onExit(msg.code ?? -1); h.onState?.('exited'); close(); break
        case 'closed': h.onGiveUp(); close(); break
      }
    }
    ws.onclose = () => {
      if (!current()) return
      hello = false; ready = false; attempt++
      h.onState?.('reconnecting', attempt)
      if (kind === 'webrtc') { if (performance.now() - activatedAt < 10000) rtcDelay = Math.min(rtcDelay * 2, 30000); connect(); return }
      if (document.hidden && attempt >= (options.maxAttempts ?? 5)) { h.onGiveUp(); h.onState?.('disconnected'); return }
      retry = setTimeout(connect, Math.min((options.reconnectDelayMs ?? 500) * 2 ** (attempt - 1), options.maxDelayMs ?? 10_000))
    }
  }
  function reconnect() { if (!stopped) { attempt++; connect() } }
  const wake = () => { if (!document.hidden) reconnect() }
  function close() {
    if (stopped) return
    stopped = true; generation++; clearTimeout(retry); clearTimeout(rtcTimer); candidate?.close(); candidate = undefined; unsubscribeRTC(); clearInterval(heartbeat); pending = new Uint8Array(0)
    window.removeEventListener('online', wake); window.removeEventListener('pageshow', wake); window.removeEventListener('focus', wake)
    document.removeEventListener('visibilitychange', wake)
    network?.removeEventListener('change', wake)
    ws.close()
  }
  const heartbeat = setInterval(() => {
    if (transport === 'webrtc' && performance.now() - activatedAt > 10000) rtcDelay = 1000
    if (!hello) return
    if (ping && performance.now() - ping.at > 6000) { reconnect(); return }
    if (!ping) { ping = { token: String(++sequence), at: performance.now() }; control({ type: 'ping', token: ping.token }) }
  }, 2000)
  window.addEventListener('online', wake); window.addEventListener('pageshow', wake); window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', wake)
  const network = (navigator as Navigator & { connection?: EventTarget }).connection
  network?.addEventListener('change', wake)
  const unsubscribeRTC = onRTCChange((enabled) => { if (!enabled) { clearTimeout(rtcTimer); rtcTimer = undefined; candidate?.close(); candidate = undefined; if (transport === 'webrtc') connect() } else scheduleRTC() })
  h.onProtocol?.(2)
  connect()
  return {
    send(text) {
      if (stopped || !state.owner || state.uncertain || state.paused) return false
      const data = encoder.encode(text)
      if (pending.length + data.length > 64 << 10) { state.paused = true; emit('Input buffer is full; new input is paused.'); return false }
      const next = new Uint8Array(pending.length + data.length); next.set(pending); next.set(data, pending.length); pending = next
      emit(); flush(); return true
    },
    resize(cols, rows) { size = { cols, rows }; resize() },
    takeControl() { control({ type: 'take' }) },
    reconnect,
    close,
  }
}
