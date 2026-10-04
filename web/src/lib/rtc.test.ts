import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectRTC } from './rtc'
import { diagnostics, resetDiagnostics } from './diagnostics'

class Channel {
 readyState = 'connecting'
 binaryType = ''
 bufferedAmount = 0
 onopen: (() => void) | null = null
 onmessage: ((event: { data: unknown }) => void) | null = null
 onclose: (() => void) | null = null
 onerror: (() => void) | null = null
 sent: unknown[] = []
 send(data: unknown) { this.sent.push(data) }
 close = vi.fn()
}
class Peer {
 static instances: Peer[] = []
 static gathering = false
 channel = new Channel()
 iceGatheringState = 'complete'
 connectionState = 'new'
 onconnectionstatechange: (() => void) | null = null
 onicegatheringstatechange: (() => void) | null = null
 localDescription = { type: 'offer', sdp: 'offer-sdp' }
 createDataChannel = vi.fn(() => this.channel)
 createOffer = vi.fn(async () => this.localDescription)
 setLocalDescription = vi.fn(async () => {})
 setRemoteDescription = vi.fn(async () => {})
 getStats = vi.fn(async () => new Map([
  ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
  ['pair', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
  ['local', { candidateType: 'host', protocol: 'udp' }],
  ['remote', { candidateType: 'srflx', protocol: 'udp' }],
 ]))
 close = vi.fn()
 constructor() { if (Peer.gathering) this.iceGatheringState = 'gathering'; Peer.instances.push(this) }
}
beforeEach(() => {
 vi.useFakeTimers()
 resetDiagnostics()
 Peer.instances = []
 Peer.gathering = false
 vi.stubGlobal('RTCPeerConnection', Peer)
 vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/api/rtc/config' ? { iceServers: [] } : { type: 'answer', sdp: 'answer-sdp' } })))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('negotiates a reliable channel, streams bytes and probes its selected route', async () => {
 const interval = vi.spyOn(globalThis, 'setInterval')
 const onOpen = vi.fn(), onMessage = vi.fn(), onClose = vi.fn(), onRoute = vi.fn()
 const conn = connectRTC('t1', { onOpen, onMessage, onClose, onRoute })
 await vi.advanceTimersByTimeAsync(0)
 const peer = Peer.instances[0]
 expect(peer.createDataChannel).toHaveBeenCalledWith('terminal', { ordered: true })
 expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' })
 peer.channel.readyState = 'open'; peer.channel.onopen?.()
 expect(onOpen).toHaveBeenCalledOnce()
 const bytes = new Uint8Array([1,2])
 conn.send(bytes)
 expect(peer.channel.sent).toContainEqual(bytes)
 peer.channel.onmessage?.({ data: bytes.buffer })
 expect(onMessage).toHaveBeenCalledWith(bytes.buffer)
 expect(interval).toHaveBeenCalledWith(expect.any(Function), 2000)
 await vi.advanceTimersByTimeAsync(2000)
 expect(onRoute).toHaveBeenCalledWith('direct', 'udp')
 conn.close()
 expect(peer.close).toHaveBeenCalledOnce()
 expect(vi.getTimerCount()).toBe(0)
 expect(onClose).not.toHaveBeenCalled()
 interval.mockRestore()
})

it('measures a matching echo and identifies TURN without recording candidate addresses', async () => {
 const onRoute = vi.fn()
 const conn = connectRTC('t1', { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), onRoute })
 await vi.advanceTimersByTimeAsync(0)
 const peer = Peer.instances[0]
 peer.getStats.mockResolvedValue(new Map([
  ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
  ['pair', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote' }],
  ['local', { candidateType: 'relay', protocol: 'udp' }],
  ['remote', { candidateType: 'host', protocol: 'udp' }],
 ]))
 peer.channel.readyState = 'open'; peer.channel.onopen?.()
 vi.spyOn(performance, 'now').mockReturnValue(25)
 peer.channel.onmessage?.({ data: '{"type":"pong","token":"wrong"}' })
 expect(diagnostics().metrics.rtc.count).toBe(0)
 peer.channel.onmessage?.({ data: '{"type":"pong","token":"1"}' })
 expect(diagnostics().metrics.rtc.last).toBe(25)
 await Promise.resolve()
 expect(onRoute).toHaveBeenCalledWith('relay', 'udp')
 conn.close()
 vi.restoreAllMocks()
})

it('splits a large paste into ordered messages within browser message limits', async () => {
 const conn = connectRTC('t1', { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), onRoute: vi.fn() })
 await vi.advanceTimersByTimeAsync(0)
 const channel = Peer.instances[0].channel
 channel.readyState = 'open'; channel.onopen?.()
 conn.send(new Uint8Array(20000))
 const binary = channel.sent.filter((data) => data instanceof Uint8Array) as Uint8Array[]
 expect(binary.map((data) => data.byteLength)).toEqual([16384, 3616])
 conn.close()
})

it('reports signaling failure and closes the peer', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })))
 const onClose = vi.fn()
 connectRTC('t1', { onOpen: vi.fn(), onMessage: vi.fn(), onClose, onRoute: vi.fn() })
 await vi.advanceTimersByTimeAsync(0)
 expect(onClose).toHaveBeenCalledOnce()
 expect(vi.getTimerCount()).toBe(0)
})

it('waits for gathered candidates and cancels a peer disposed during gathering', async () => {
 Peer.gathering = true
 const onClose = vi.fn()
 const conn = connectRTC('t/1', { onOpen: vi.fn(), onMessage: vi.fn(), onClose, onRoute: vi.fn() })
 await vi.advanceTimersByTimeAsync(0)
 const peer = Peer.instances[0]
 expect(fetch).toHaveBeenCalledTimes(1)
 expect(peer.setRemoteDescription).not.toHaveBeenCalled()
 conn.close()
 expect(peer.close).toHaveBeenCalledOnce()
 expect(onClose).not.toHaveBeenCalled()
})

it('signals only after candidate gathering completes and encodes the terminal id', async () => {
 Peer.gathering = true
 const conn = connectRTC('t/1', { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn(), onRoute: vi.fn() })
 await vi.advanceTimersByTimeAsync(0)
 const peer = Peer.instances[0]
 peer.iceGatheringState = 'complete'; peer.onicegatheringstatechange?.()
 await vi.advanceTimersByTimeAsync(0)
 expect(fetch).toHaveBeenCalledWith('/api/terminals/t%2F1/rtc', expect.objectContaining({ method: 'POST', body: JSON.stringify(peer.localDescription) }))
 expect(peer.setRemoteDescription).toHaveBeenCalledOnce()
 conn.close()
})

it('expires an unanswered echo without depending on ICE statistics support', async () => {
 const interval = vi.spyOn(globalThis, 'setInterval')
 const onClose = vi.fn()
 connectRTC('t1', { onOpen: vi.fn(), onMessage: vi.fn(), onClose, onRoute: vi.fn() })
 await vi.advanceTimersByTimeAsync(0)
 const peer = Peer.instances[0]
 peer.getStats.mockRejectedValue(new Error('stats unsupported'))
 peer.channel.readyState = 'open'; peer.channel.onopen?.()
 await Promise.resolve()
 expect(onClose).not.toHaveBeenCalled()
 vi.spyOn(performance, 'now').mockReturnValue(6001)
 const tick = interval.mock.calls[0][0] as () => void
 tick()
 expect(onClose).toHaveBeenCalledOnce()
})

it('closes the peer if an authenticated offer request fails', async () => {
 vi.stubGlobal('fetch', vi.fn()
  .mockResolvedValueOnce({ ok: true, json: async () => ({ iceServers: [] }) })
  .mockResolvedValueOnce({ ok: false }))
 const onClose = vi.fn()
 connectRTC('t1', { onOpen: vi.fn(), onMessage: vi.fn(), onClose, onRoute: vi.fn() })
 await vi.advanceTimersByTimeAsync(0)
 expect(onClose).toHaveBeenCalledOnce()
 expect(Peer.instances[0].close).toHaveBeenCalledOnce()
})

it('fails once on a lost or closed channel and ignores late messages', async () => {
 const onClose = vi.fn(), onMessage = vi.fn()
 connectRTC('t1', { onOpen: vi.fn(), onMessage, onClose, onRoute: vi.fn() })
 await vi.advanceTimersByTimeAsync(0)
 const peer = Peer.instances[0]
 peer.connectionState = 'failed'; peer.onconnectionstatechange?.()
 peer.channel.onclose?.(); peer.channel.onerror?.()
 peer.channel.onmessage?.({ data: new ArrayBuffer(1) })
 expect(onClose).toHaveBeenCalledOnce()
 expect(onMessage).not.toHaveBeenCalled()
 expect(peer.channel.close).toHaveBeenCalledOnce()
})

it('falls back rather than building an unbounded input queue', async () => {
 const onClose = vi.fn()
 const conn = connectRTC('t1', { onOpen: vi.fn(), onMessage: vi.fn(), onClose, onRoute: vi.fn() })
 conn.send('not open')
 await vi.advanceTimersByTimeAsync(0)
 const channel = Peer.instances[0].channel
 channel.readyState = 'open'; channel.onopen?.()
 channel.bufferedAmount = (1 << 20) + 1
 conn.send('unsent')
 expect(channel.sent).not.toContain('unsent')
 expect(onClose).toHaveBeenCalledOnce()
 conn.send('late')
})

it('bounds an unopened connection and does not revive it after close', async () => {
 const onOpen = vi.fn(), onClose = vi.fn()
 const conn = connectRTC('t1', { onOpen, onMessage: vi.fn(), onClose, onRoute: vi.fn() })
 await vi.advanceTimersByTimeAsync(12000)
 expect(onClose).toHaveBeenCalledOnce()
 Peer.instances[0].channel.onopen?.()
 expect(onOpen).not.toHaveBeenCalled()
 conn.close()
})
