import { afterEach, expect, it, vi } from 'vitest'
import { rtcV2Wire } from './rtc-v2'
import { diagnostics, resetDiagnostics } from './diagnostics'

class Channel {
  readyState = 'open'
  binaryType = ''
  onopen?: () => void
  onmessage?: (event: MessageEvent) => void
  onclose?: () => void
  onerror?: () => void
  send = vi.fn()
  close = vi.fn()
  readonly label: string
  readonly options: RTCDataChannelInit
  constructor(label: string, options: RTCDataChannelInit) { this.label = label; this.options = options }
}
class Peer {
  static all: Peer[] = []
  static gathering = 'complete'
  channels: Channel[] = []
  iceGatheringState = Peer.gathering
  onicegatheringstatechange?: () => void
  connectionState = 'new'
  localDescription = {type: 'offer', sdp: 'offer'}
  onconnectionstatechange?: () => void
  createOffer = vi.fn(async () => this.localDescription)
  setLocalDescription = vi.fn(async () => {})
  setRemoteDescription = vi.fn(async () => {})
  close = vi.fn()
  getStats = vi.fn(async () => new Map([
    ['pair', {type: 'candidate-pair', nominated: true, state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote', requestsSent: 4, responsesReceived: 3, requestsReceived: 2, responsesSent: 2}],
    ['local', {candidateType: 'host', protocol: 'udp'}],
    ['remote', {candidateType: 'relay', protocol: 'udp'}],
  ]))
  constructor() { Peer.all.push(this) }
  createDataChannel(label: string, options: RTCDataChannelInit) { const c = new Channel(label, options); this.channels.push(c); return c }
}
const setup = (gathering = 'complete') => {
  vi.useFakeTimers(); vi.stubGlobal('RTCPeerConnection', Peer)
  Peer.gathering = gathering
  resetDiagnostics()
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => ({ok: true, status: 200, json: async () => ({type: 'answer', sdp: 'answer'})}))
  vi.stubGlobal('fetch', fetcher)
  const route = vi.fn(), wire = rtcV2Wire('terminal/1', 'tab', route)
  return {wire, route, fetcher}
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Peer.all = [] })
it('uses two reliable ordered channels and sends input only on control', async () => {
  const {wire, route, fetcher} = setup()
  await vi.advanceTimersByTimeAsync(0)
  const peer = Peer.all[0], [control, output] = peer.channels
  expect(peer.channels.map((c) => [c.label, c.options])).toEqual([
    ['terminal-control-v2', {ordered: true}], ['terminal-output-v2', {ordered: true}],
  ])
  expect(fetcher).toHaveBeenLastCalledWith('/api/terminals/terminal%2F1/rtc?v=2&client=tab', expect.objectContaining({method: 'POST'}))
  expect(peer.setRemoteDescription).toHaveBeenCalledWith({type: 'answer', sdp: 'answer'})
  control.onopen?.(); expect(wire.readyState).toBe(0)
  output.onopen?.(); expect(wire.readyState).toBe(1)
  expect(diagnostics().terminals.find((t) => t.id === 'terminal/1')?.rtcAttempt).toMatchObject({stage: 'open'})
  wire.send('ping'); const bytes = new Uint8Array([3, 1]); wire.send(bytes)
  expect(control.send.mock.calls).toEqual([['ping'], [bytes]])
  expect(output.send).not.toHaveBeenCalled()
  const message = vi.fn(); wire.onmessage = message
  const event = new MessageEvent('message', {data: bytes.buffer}); output.onmessage?.(event)
  expect(message).toHaveBeenCalledWith(event)
  await vi.advanceTimersByTimeAsync(0)
  expect(route).toHaveBeenCalledWith('relay', 'udp')
  expect(diagnostics().terminals.find((t) => t.id === 'terminal/1')?.rtcAttempt).toMatchObject({
    candidatePairs: {total: 1, succeeded: 1, requestsSent: 4, responsesReceived: 3, requestsReceived: 2, responsesSent: 2},
  })
  wire.close(); expect(peer.close).toHaveBeenCalledOnce()
  output.onmessage?.(event); expect(message).toHaveBeenCalledTimes(1)
  expect(() => wire.send('late')).toThrow('closed')
})
it('times out an unopened peer once and aborts signaling', async () => {
  const {wire, fetcher} = setup()
  const close = vi.fn(); wire.onclose = close
  await vi.advanceTimersByTimeAsync(20000)
  expect(wire.readyState).toBe(3); expect(close).toHaveBeenCalledOnce()
  expect(diagnostics().terminals.find((t) => t.id === 'terminal/1')?.rtcAttempt).toMatchObject({stage: 'connecting', error: 'timeout'})
  expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  wire.close(); expect(close).toHaveBeenCalledOnce()
})
it('includes server-reflexive candidates gathered after four seconds in the offer', async () => {
  const {wire, fetcher} = setup('gathering')
  await vi.advanceTimersByTimeAsync(6000)
  expect(fetcher).toHaveBeenCalledTimes(1)
  const peer = Peer.all[0]
  peer.localDescription.sdp = 'late-public-candidate'
  peer.iceGatheringState = 'complete'; peer.onicegatheringstatechange?.()
  await vi.advanceTimersByTimeAsync(0)
  expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).sdp).toBe('late-public-candidate')
  wire.close()
})
it('gives ICE its own connection budget after delayed answer delivery', async () => {
  const {wire, fetcher} = setup()
  let answer!: (response: Awaited<ReturnType<typeof fetcher>>) => void
  fetcher.mockImplementationOnce(() => new Promise((resolve) => {answer = resolve}))
  await vi.advanceTimersByTimeAsync(13000)
  answer({ok: true, status: 200, json: async () => ({type: 'answer', sdp: 'answer'})})
  await vi.advanceTimersByTimeAsync(4000)
  expect(wire.readyState).toBe(0)
  Peer.all[0].channels.forEach((c) => c.onopen?.())
  expect(wire.readyState).toBe(1)
  wire.close()
})
it('retains the signaling HTTP failure so a WebSocket fallback is explainable', async () => {
  const {wire, fetcher} = setup()
  fetcher.mockResolvedValueOnce({ok: false, status: 503, json: async () => ({type: 'answer', sdp: ''})})
  await vi.advanceTimersByTimeAsync(0)
  expect(wire.readyState).toBe(3)
  expect(diagnostics().terminals.find((t) => t.id === 'terminal/1')?.rtcAttempt).toMatchObject({stage: 'signaling', error: 'http', httpStatus: 503})
})
it('reports failed signaling and channel closure for mandatory WebSocket fallback', async () => {
  const {wire, fetcher} = setup()
  fetcher.mockRejectedValueOnce(new Error('offline'))
  const closed = vi.fn(); wire.onclose = closed
  await vi.advanceTimersByTimeAsync(0)
  expect(closed).toHaveBeenCalledOnce(); expect(wire.readyState).toBe(3)
  const next = setup().wire
  await vi.advanceTimersByTimeAsync(0)
  const otherClosed = vi.fn(); next.onclose = otherClosed
  Peer.all.at(-1)!.channels[0].onclose?.()
  expect(otherClosed).toHaveBeenCalledOnce(); expect(next.readyState).toBe(3)
})
