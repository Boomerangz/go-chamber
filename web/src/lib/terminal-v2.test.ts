import { afterEach, expect, it, vi } from 'vitest'
import { connectTerminalV2 } from './terminal-v2'

class Socket {
  static OPEN = 1
  static all: Socket[] = []
  readyState = 1
  binaryType = ''
  onopen?: () => void
  onmessage?: (e: {data: unknown}) => void
  onclose?: (e: {code: number}) => void
  sent: (string | Uint8Array)[] = []
  constructor() { Socket.all.push(this) }
  send(data: string | Uint8Array) { this.sent.push(data) }
  close() { this.readyState = 3 }
  control(value: object) { this.onmessage?.({data: JSON.stringify(value)}) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Socket.all = [] })
const setup = () => {
  vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket)
  const processed: (() => void)[] = []
  const state = vi.fn()
  const conn = connectTerminalV2('t', {onOutput: (_data, done) => {if (done) processed.push(done)}, onReady: vi.fn(), onExit: vi.fn(), onReset: vi.fn(), onGiveUp: vi.fn(), onClientState: state}, {rtc: false})
  const socket = Socket.all.at(-1)!
  socket.onopen?.()
  socket.control({type: 'hello', run: 'r', owner: true, epoch: 1, written: 0, uncertain: false})
  socket.control({type: 'ready'})
  return {conn, socket, processed, state}
}
it('ACKs output only after xterm has processed it; old callbacks cannot ACK a new socket', () => {
  const {conn, socket, processed} = setup()
  const data = new Uint8Array(12); data[0] = 1
  new DataView(data.buffer).setBigUint64(1, 3n)
  socket.onmessage?.({data: data.buffer})
  expect(socket.sent.filter((x) => typeof x === 'string' && x.includes('"ack"'))).toHaveLength(0)
  processed[0]()
  expect(socket.sent).toContain(JSON.stringify({type: 'ack', bytes: 3}))
  const second = data.slice(); new DataView(second.buffer).setBigUint64(1, 6n)
  socket.onmessage?.({data: second.buffer})
  conn.reconnect()
  const next = Socket.all.at(-1)!
  processed[1]()
  expect(next.sent).toHaveLength(0)
  conn.close()
})
it('bounds pending input and retransmits the unwritten prefix after reconnect', () => {
  const {conn, socket, state} = setup()
  expect(conn.send('a'.repeat(65536))).toBe(true)
  expect(conn.send('b')).toBe(false)
  conn.reconnect()
  const next = Socket.all.at(-1)!; next.onopen?.()
  next.control({type: 'hello', run: 'r', owner: true, epoch: 1, written: 3, uncertain: false})
  const frame = next.sent.find((x) => x instanceof Uint8Array) as Uint8Array
  expect(new DataView(frame.buffer).getBigUint64(9)).toBe(3n)
  next.control({type: 'control', owner: false, epoch: 2, written: 3, uncertain: false})
  expect(conn.send('x')).toBe(false)
  expect(state).toHaveBeenCalledWith(expect.objectContaining({owner: false, pendingBytes: 0}))
  expect(socket.readyState).toBe(3)
  conn.close()
})
it('never replays pending input to another server run or after an ambiguous write', () => {
  const {conn} = setup()
  conn.send('password')
  conn.reconnect()
  const next = Socket.all.at(-1)!; next.onopen?.()
  next.control({type: 'hello', run: 'new', owner: true, epoch: 1, written: 0, uncertain: false})
  expect(next.sent.filter((x) => x instanceof Uint8Array)).toHaveLength(0)
  conn.send('new')
  next.control({type: 'inputAck', owner: true, epoch: 1, written: 1, uncertain: true, problem: 'write failed'})
  expect(conn.send('more')).toBe(false)
  conn.close()
})
it('keeps newer acknowledged state when an RTC attachment hello was captured earlier', () => {
  const {conn, socket, state} = setup()
  conn.send('abcdef')
  socket.control({type: 'inputAck', owner: true, epoch: 1, written: 3, uncertain: false})
  conn.reconnect()
  const next = Socket.all.at(-1)!; next.onopen?.()
  next.control({type: 'hello', run: 'r', owner: true, epoch: 1, written: 1, uncertain: false})
  const frame = next.sent.find((x) => x instanceof Uint8Array) as Uint8Array
  expect(new DataView(frame.buffer).getBigUint64(9)).toBe(3n)
  expect(state).toHaveBeenLastCalledWith(expect.objectContaining({pendingBytes: 3, written: 3}))
  conn.close()
})
it('explicitly reports cancelled pending input when control changes', () => {
  const {conn, socket, state} = setup()
  conn.send('unacknowledged')
  socket.control({type: 'control', owner: false, epoch: 2, written: 0, uncertain: false})
  expect(state).toHaveBeenLastCalledWith(expect.objectContaining({pendingBytes: 0, problem: 'Pending input was cancelled after control changed.'}))
  conn.close()
})

it('pipelines keystrokes without waiting for an ACK when the server supports it', () => {
  const {conn, socket} = setup()
  socket.control({type: 'hello', run: 'r', owner: true, epoch: 1, written: 0, inputPipeline: true})
  conn.send('a'); conn.send('б')
  const frames = () => socket.sent.filter((x): x is Uint8Array => x instanceof Uint8Array)
  expect(frames()).toHaveLength(2)
  expect(new DataView(frames()[1].buffer).getBigUint64(9)).toBe(1n)
  socket.control({type: 'inputAck', owner: true, epoch: 1, written: 1})
  conn.send('c')
  expect(frames()).toHaveLength(3)
  expect(new DataView(frames()[2].buffer).getBigUint64(9)).toBe(3n)
  expect(new TextDecoder().decode(frames()[2].slice(17))).toBe('c')
  conn.close()
})

it('reconciles a pipelined written prefix on reconnect and cancels it after write uncertainty', () => {
  const {conn, socket, state} = setup()
  socket.control({type: 'hello', run: 'r', owner: true, epoch: 1, written: 0, inputPipeline: true})
  conn.send('a'); conn.send('b')
  conn.reconnect()
  const next = Socket.all.at(-1)!
  next.control({type: 'hello', run: 'r', owner: true, epoch: 1, written: 1, inputPipeline: true})
  const frames = () => next.sent.filter((x): x is Uint8Array => x instanceof Uint8Array)
  expect(frames()).toHaveLength(1)
  expect(new TextDecoder().decode(frames()[0].slice(17))).toBe('b')
  conn.send('c')
  expect(frames()).toHaveLength(2)
  expect(new DataView(frames()[1].buffer).getBigUint64(9)).toBe(2n)
  next.control({type: 'inputAck', owner: true, epoch: 1, written: 2, uncertain: true, problem: 'write failed'})
  expect(conn.send('d')).toBe(false)
  expect(state).toHaveBeenLastCalledWith(expect.objectContaining({pendingBytes: 0, uncertain: true}))
  conn.close()
})

it('keeps the 64 KiB pending-input bound while pipelining multiple frames', () => {
  const {conn, socket, state} = setup()
  socket.control({type: 'hello', run: 'r', owner: true, epoch: 1, written: 0, inputPipeline: true})
  expect(conn.send('x'.repeat(65536))).toBe(true)
  const frames = socket.sent.filter((x): x is Uint8Array => x instanceof Uint8Array)
  expect(frames.reduce((n, frame) => n + frame.length - 17, 0)).toBe(65536)
  expect(frames.every((frame) => frame.length <= 16384)).toBe(true)
  expect(conn.send('overflow')).toBe(false)
  expect(state).toHaveBeenLastCalledWith(expect.objectContaining({pendingBytes: 65536, paused: true}))
  conn.close()
})

it('retains single-flight compatibility without the server pipeline capability', () => {
  const {conn, socket} = setup()
  conn.send('a'); conn.send('b')
  const frames = () => socket.sent.filter((x): x is Uint8Array => x instanceof Uint8Array)
  expect(frames()).toHaveLength(1)
  socket.control({type: 'inputAck', owner: true, epoch: 1, written: 1})
  expect(frames()).toHaveLength(2)
  expect(new DataView(frames()[1].buffer).getBigUint64(9)).toBe(1n)
  conn.close()
})
