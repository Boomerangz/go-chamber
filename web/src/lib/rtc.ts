import { recordTerminalRTT, recordRTCAttempt, type RTCAttempt } from './diagnostics'

export type RTCRoute = 'direct' | 'relay' | 'unknown'
interface RTCHandlers {
 onOpen(): void
 onMessage(data: unknown): void
 onClose(): void
 onRoute(route: RTCRoute, protocol: string): void
}
export interface RTCConnection { send(data: string | Uint8Array): void; close(): void }

// Signaling uses authenticated HTTPS; terminal bytes use the encrypted ICE
// connection. Only route classifications and echo timings enter diagnostics.
export function connectRTC(id: string, handlers: RTCHandlers): RTCConnection {
 let peer: RTCPeerConnection | undefined
 let channel: RTCDataChannel | undefined
 let stopped = false
 let timer: ReturnType<typeof setInterval> | undefined
 let pending: { token: string; at: number } | null = null
 let sequence = 0
 const controller = new AbortController()
 const startedAt = performance.now()
 let stage: RTCAttempt['stage'] = 'config'
 let httpStatus: number | undefined
 let remoteSDP: string | undefined
 const iceErrorCodes = new Set<number>()
 const candidates = (sdp?: string) => {
  const counts = { host: 0, srflx: 0, relay: 0 }
  for (const match of (sdp ?? '').matchAll(/^a=candidate:.*? typ (host|srflx|relay)(?: |\r?$)/gm)) counts[match[1] as keyof typeof counts]++
  return counts
 }
 const report = (error?: RTCAttempt['error']) => recordRTCAttempt(id, {
  stage, error, httpStatus, elapsedMs: performance.now() - startedAt,
  gatheringState: peer?.iceGatheringState, connectionState: peer?.connectionState, iceState: peer?.iceConnectionState,
  localCandidates: candidates(peer?.localDescription?.sdp), remoteCandidates: candidates(remoteSDP), iceErrorCodes: [...iceErrorCodes],
 })
 const advance = (next: RTCAttempt['stage']) => { stage = next; report() }
 report()
 const close = () => {
  if (stopped) return
  stopped = true
  clearTimeout(deadline)
  clearInterval(timer)
  controller.abort()
  channel?.close()
  peer?.close()
 }
 const fail = (error: RTCAttempt['error'] = 'setup') => { if (!stopped) { report(error); close(); handlers.onClose() } }
 const deadline = setTimeout(() => fail('timeout'), 12000)
 const request = async (path: string, init?: RequestInit) => {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init, signal: controller.signal })
  if (!response.ok) { httpStatus = response.status; fail('http'); throw new Error('RTC signaling failed') }
  return response.json()
 }
 const probe = async () => {
  if (stopped || !peer || !channel || channel.readyState !== 'open') return
  if (pending && performance.now() - pending.at > 6000) { fail('echo'); return }
  if (!pending) {
   pending = { token: String(++sequence), at: performance.now() }
   try { channel.send(JSON.stringify({ type: 'ping', token: pending.token })) } catch { fail('send'); return }
  }
  try {
   const stats = await peer.getStats()
   if (stopped) return
   let pair: RTCStats | undefined
   stats.forEach((stat) => { if (stat.type === 'transport' && stat.selectedCandidatePairId) pair = stats.get(stat.selectedCandidatePairId) })
   if (!pair) stats.forEach((stat) => { if (stat.type === 'candidate-pair' && stat.nominated && stat.state === 'succeeded') pair = stat })
   if (pair) {
    const selected = pair as RTCIceCandidatePairStats
    const local = stats.get(selected.localCandidateId) as { candidateType?: string; protocol?: string } | undefined
    const remote = stats.get(selected.remoteCandidateId) as { candidateType?: string; protocol?: string } | undefined
    const route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : local && remote ? 'direct' : 'unknown'
    handlers.onRoute(route, local?.protocol === 'udp' || local?.protocol === 'tcp' ? local.protocol : 'unknown')
   }
  } catch { /* Stats support is optional; the data channel can still work. */ }
 }
 const negotiate = async () => {
  const config = await request('/api/rtc/config') as RTCConfiguration
  if (stopped) return
  peer = new RTCPeerConnection(config)
  channel = peer.createDataChannel('terminal', { ordered: true })
  channel.binaryType = 'arraybuffer'
  peer.onicecandidateerror = (event) => { if (!stopped) { iceErrorCodes.add(event.errorCode); report() } }
  peer.oniceconnectionstatechange = () => { if (!stopped) report() }
  channel.onopen = () => {
   if (stopped) return
   clearTimeout(deadline)
   advance('open')
   handlers.onOpen()
   timer = setInterval(() => { void probe() }, 2000)
   void probe()
  }
  channel.onmessage = (event) => {
   if (stopped) return
   if (typeof event.data === 'string') {
    try {
     const msg = JSON.parse(event.data) as { type?: string; token?: string }
     if (msg.type === 'pong') {
      if (pending && msg.token === pending.token) { recordTerminalRTT(id, performance.now() - pending.at); pending = null }
      return
     }
    } catch { return }
   }
   handlers.onMessage(event.data)
  }
  channel.onclose = () => fail('channel')
  channel.onerror = () => fail('channel')
  peer.onconnectionstatechange = () => { if (stopped) return; if (peer?.connectionState === 'failed' || peer?.connectionState === 'disconnected') fail('connection'); else report() }
  advance('offer')
  const offer = await peer.createOffer()
  if (stopped) return
  await peer.setLocalDescription(offer)
  if (stopped) return
  advance('gathering')
  if (peer.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
   const abort = () => reject(new Error('RTC canceled'))
   controller.signal.addEventListener('abort', abort, { once: true })
   peer!.onicegatheringstatechange = () => {
    if (peer!.iceGatheringState === 'complete') { controller.signal.removeEventListener('abort', abort); resolve() }
   }
   if (controller.signal.aborted) abort()
  })
  if (stopped) return
  advance('signaling')
  const answer = await request(`/api/terminals/${encodeURIComponent(id)}/rtc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(peer.localDescription) }) as RTCSessionDescriptionInit
  if (stopped) return
  remoteSDP = answer.sdp
  advance('answer')
  await peer.setRemoteDescription(answer)
  if (!stopped) advance('connecting')
 }
 void negotiate().catch(() => fail('setup'))
 return {
  send(data) {
   if (stopped || channel?.readyState !== 'open') return
   if (channel.bufferedAmount > 1 << 20) { fail('backpressure'); return }
   try {
    if (typeof data === 'string') channel.send(data)
    else for (let offset = 0; offset < data.byteLength; offset += 16 << 10) channel.send(data.subarray(offset, offset + (16 << 10)) as Uint8Array<ArrayBuffer>)
   } catch { fail('send') }
  },
  close,
 }
}
