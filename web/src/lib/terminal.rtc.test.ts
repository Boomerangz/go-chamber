import { afterEach, expect, it, vi } from 'vitest'
import { connectTerminal } from './terminal'
import { connectRTC } from './rtc'
import { diagnostics } from './diagnostics'
import { setRTCEnabled } from './transport'
vi.mock('./rtc', () => ({ connectRTC: vi.fn(() => ({ send: vi.fn(), close: vi.fn() })) }))
class Socket {
 static OPEN = 1
 static instances: Socket[] = []
 readyState = 1
 onmessage: ((event: { data: unknown }) => void) | null = null
 onopen: (() => void) | null = null
 onclose: ((event: { code: number }) => void) | null = null
 send = vi.fn()
 close = vi.fn()
 constructor() { Socket.instances.push(this) }
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); Socket.instances = []; setRTCEnabled(true); localStorage.clear() })
it('upgrades without mixing streams and falls back after a lost peer', () => {
 vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('RTCPeerConnection', class {})
 const handlers = { onOutput: vi.fn(), onReady: vi.fn(), onReset: vi.fn(), onExit: vi.fn(), onGiveUp: vi.fn() }
 const conn = connectTerminal('t1', handlers)
 const socket = Socket.instances[0]
 socket.onmessage?.({ data: '{"type":"ready"}' })
 expect(connectRTC).toHaveBeenCalledOnce()
 const peer = vi.mocked(connectRTC).mock.results[0].value
 const callbacks = vi.mocked(connectRTC).mock.calls[0][1]
 callbacks.onOpen()
 expect(socket.close).toHaveBeenCalledOnce()
 expect(handlers.onReset).toHaveBeenCalledOnce()
 socket.onmessage?.({ data: new Uint8Array([9]).buffer })
 expect(handlers.onOutput).not.toHaveBeenCalled()
 callbacks.onMessage(new Uint8Array([1]).buffer)
 expect(handlers.onOutput).toHaveBeenCalledWith(new Uint8Array([1]))
 conn.send('input')
 expect(peer.send).toHaveBeenCalledWith(new TextEncoder().encode('input'))
 callbacks.onClose()
 expect(Socket.instances).toHaveLength(2)
 const fallback = Socket.instances[1]
 fallback.onopen?.()
 expect(handlers.onReset).toHaveBeenCalledTimes(2)
 conn.send('fallback input')
 expect(fallback.send).toHaveBeenCalledWith(new TextEncoder().encode('fallback input'))
 conn.close()
})

it('keeps WebSocket alive when RTC setup fails and cancels a pending upgrade on dispose', () => {
 vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('RTCPeerConnection', class {})
 const handlers = { onOutput: vi.fn(), onReady: vi.fn(), onReset: vi.fn(), onExit: vi.fn(), onGiveUp: vi.fn() }
 const conn = connectTerminal('t1', handlers)
 Socket.instances[0].onmessage?.({ data: '{"type":"ready"}' })
 const callbacks = vi.mocked(connectRTC).mock.calls[0][1]
 callbacks.onClose()
 expect(Socket.instances).toHaveLength(1)
 expect(handlers.onReset).not.toHaveBeenCalled()
 conn.close()
 callbacks.onOpen()
 expect(handlers.onReset).not.toHaveBeenCalled()
})

it('routes resize and control messages through the active peer and stops on exit', () => {
 vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('RTCPeerConnection', class {})
 const handlers = { onOutput: vi.fn(), onReady: vi.fn(), onReset: vi.fn(), onExit: vi.fn(), onGiveUp: vi.fn() }
 const conn = connectTerminal('controls', handlers)
 conn.resize(100, 30)
 Socket.instances[0].onmessage?.({ data: '{"type":"ready"}' })
 const peer = vi.mocked(connectRTC).mock.results[0].value
 const callbacks = vi.mocked(connectRTC).mock.calls[0][1]
 callbacks.onOpen()
 expect(peer.send).toHaveBeenCalledWith('{"type":"resize","cols":100,"rows":30}')
 conn.resize(120, 40)
 expect(peer.send).toHaveBeenCalledWith('{"type":"resize","cols":120,"rows":40}')
 callbacks.onRoute('relay', 'udp')
 expect(diagnostics().terminals.find((t) => t.id === 'controls')).toMatchObject({ transport: 'webrtc', route: 'relay', protocol: 'udp' })
 callbacks.onMessage('{"type":"ready"}')
 expect(handlers.onReady).toHaveBeenCalledTimes(2)
 callbacks.onMessage('invalid JSON')
 callbacks.onMessage('{"type":"exit","code":7}')
 expect(handlers.onExit).toHaveBeenCalledWith(7)
 expect(peer.close).toHaveBeenCalledOnce()
 callbacks.onClose()
 callbacks.onRoute('direct', 'udp')
 callbacks.onMessage(new Uint8Array([1]).buffer)
 conn.send('late'); conn.resize(80, 24)
 expect(Socket.instances).toHaveLength(1)
 expect(handlers.onOutput).not.toHaveBeenCalled()
})

it('handles an explicit lag fallback and a terminal close without retrying RTC', () => {
 vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('RTCPeerConnection', class {})
 const handlers = { onOutput: vi.fn(), onReady: vi.fn(), onReset: vi.fn(), onExit: vi.fn(), onGiveUp: vi.fn() }
 const conn = connectTerminal('lagged', handlers)
 Socket.instances[0].onmessage?.({ data: '{"type":"ready"}' })
 const callbacks = vi.mocked(connectRTC).mock.calls[0][1]
 callbacks.onOpen()
 callbacks.onMessage('{"type":"fallback"}')
 Socket.instances[1].onmessage?.({ data: '{"type":"ready"}' })
 expect(connectRTC).toHaveBeenCalledOnce()
 expect(Socket.instances).toHaveLength(2)
 conn.close()
})

it('resyncs in place over WebRTC', () => {
 vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('RTCPeerConnection', class {})
 const handlers = { onOutput: vi.fn(), onReady: vi.fn(), onReset: vi.fn(), onExit: vi.fn(), onGiveUp: vi.fn() }
 const conn = connectTerminal('resync', handlers)
 Socket.instances[0].onmessage?.({ data: '{"type":"ready"}' })
 const callbacks = vi.mocked(connectRTC).mock.calls[0][1]
 callbacks.onOpen()
 callbacks.onMessage('{"type":"resync"}')
 expect(handlers.onReset).toHaveBeenLastCalledWith('resync')
 expect(Socket.instances).toHaveLength(1)
 conn.close()
})

it('stays on WebSocket while WebRTC is turned off on this device', () => {
 vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('RTCPeerConnection', class {})
 setRTCEnabled(false)
 const handlers = { onOutput: vi.fn(), onReady: vi.fn(), onReset: vi.fn(), onExit: vi.fn(), onGiveUp: vi.fn() }
 const conn = connectTerminal('off', handlers)
 Socket.instances[0].onmessage?.({ data: '{"type":"ready"}' })
 expect(connectRTC).not.toHaveBeenCalled()
 conn.close()
 setRTCEnabled(true)
 expect(connectRTC).not.toHaveBeenCalled()
})

it('switches an open terminal between WebRTC and WebSocket when the setting changes', () => {
 vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('RTCPeerConnection', class {})
 const handlers = { onOutput: vi.fn(), onReady: vi.fn(), onReset: vi.fn(), onExit: vi.fn(), onGiveUp: vi.fn() }
 const conn = connectTerminal('toggle', handlers)
 Socket.instances[0].onmessage?.({ data: '{"type":"ready"}' })
 const peer = vi.mocked(connectRTC).mock.results[0].value
 vi.mocked(connectRTC).mock.calls[0][1].onOpen()
 setRTCEnabled(false)
 expect(peer.close).toHaveBeenCalledOnce()
 expect(Socket.instances).toHaveLength(2)
 const socket = Socket.instances[1]
 socket.onopen?.()
 conn.send('ws input')
 expect(socket.send).toHaveBeenCalledWith(new TextEncoder().encode('ws input'))
 setRTCEnabled(true)
 expect(connectRTC).toHaveBeenCalledOnce()
 socket.onmessage?.({ data: '{"type":"ready"}' })
 expect(connectRTC).toHaveBeenCalledTimes(2)
 vi.mocked(connectRTC).mock.calls[1][1].onOpen()
 expect(socket.close).toHaveBeenCalledOnce()
 conn.close()
})

it('retries WebRTC on a ready WebSocket when it is turned back on', () => {
 vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('RTCPeerConnection', class {})
 setRTCEnabled(false)
 const handlers = { onOutput: vi.fn(), onReady: vi.fn(), onReset: vi.fn(), onExit: vi.fn(), onGiveUp: vi.fn() }
 const conn = connectTerminal('later', handlers)
 Socket.instances[0].onmessage?.({ data: '{"type":"ready"}' })
 setRTCEnabled(true)
 expect(connectRTC).toHaveBeenCalledOnce()
 const pending = vi.mocked(connectRTC).mock.results[0].value
 setRTCEnabled(false)
 expect(pending.close).toHaveBeenCalledOnce()
 expect(Socket.instances).toHaveLength(1)
 conn.close()
 setRTCEnabled(true)
})

it('waits for the replay before upgrading and keeps a single peer', () => {
 vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('RTCPeerConnection', class {})
 setRTCEnabled(false)
 const handlers = { onOutput: vi.fn(), onReady: vi.fn(), onReset: vi.fn(), onExit: vi.fn(), onGiveUp: vi.fn() }
 const conn = connectTerminal('replay', handlers)
 setRTCEnabled(true)
 expect(connectRTC).not.toHaveBeenCalled()
 Socket.instances[0].onmessage?.({ data: '{"type":"ready"}' })
 expect(connectRTC).toHaveBeenCalledOnce()
 vi.mocked(connectRTC).mock.calls[0][1].onOpen()
 setRTCEnabled(true)
 expect(connectRTC).toHaveBeenCalledOnce()
 conn.close()
})
