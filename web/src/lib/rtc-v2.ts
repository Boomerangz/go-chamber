import { recordRTCAttempt, type RTCAttempt } from './diagnostics'

export interface V2Wire {
  readyState: number
  binaryType: string
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string | Uint8Array<ArrayBuffer>): void
  close(): void
}

// Only the control channel accepts client input/ACKs. Output stays reliable
// and ordered on its own channel; no raw PTY bytes use an unreliable stream.
export function rtcV2Wire(id: string, client: string, onRoute?: (route: 'direct' | 'relay' | 'unknown', protocol: string) => void): V2Wire {
  let peer: RTCPeerConnection | undefined
  let control: RTCDataChannel | undefined
  let output: RTCDataChannel | undefined
  let stopped = false
  const started = performance.now()
  let stage: RTCAttempt['stage'] = 'config'
  let httpStatus: number | undefined
  let remoteSDP: string | undefined
  let candidatePairs: RTCAttempt['candidatePairs']
  let deadline: ReturnType<typeof setTimeout>
  const iceErrors = new Set<number>()
  const candidates = (sdp?: string) => {
    const counts = {host: 0, srflx: 0, relay: 0}
    for (const match of (sdp ?? '').matchAll(/^a=candidate:.*? typ (host|srflx|relay)(?: |\r?$)/gm)) counts[match[1] as keyof typeof counts]++
    return counts
  }
  const report = (error?: RTCAttempt['error']) => recordRTCAttempt(id, {
    stage, error, httpStatus, elapsedMs: performance.now() - started,
    gatheringState: peer?.iceGatheringState, connectionState: peer?.connectionState, iceState: peer?.iceConnectionState,
    localCandidates: candidates(peer?.localDescription?.sdp), remoteCandidates: candidates(remoteSDP), iceErrorCodes: [...iceErrors], candidatePairs,
  })
  const advance = (next: RTCAttempt['stage']) => {
    if (stopped) return
    stage = next
    clearTimeout(deadline)
    // Gathering/signaling must not consume the time available to ICE.
    if (next !== 'open') {
      const budget = next === 'connecting' ? 20000 : next === 'signaling' ? 15000 : 12000
      deadline = setTimeout(() => fail('timeout'), budget)
    }
    report()
  }
  report()
  let statsTimer: ReturnType<typeof setInterval> | undefined
  const abort = new AbortController()
  const wire: V2Wire = {
    readyState: 0, binaryType: 'arraybuffer', onmessage: null, onclose: null,
    send(data) {
      if (stopped || control?.readyState !== 'open') throw new Error('RTC control is closed')
      if (typeof data === 'string') control.send(data); else control.send(data as Uint8Array<ArrayBuffer>)
    },
    close() {
      if (stopped) return
      stopped = true; wire.readyState = 3; clearTimeout(deadline); clearInterval(statsTimer); abort.abort()
      control?.close(); output?.close(); peer?.close()
    },
  }
  const fail = (error: RTCAttempt['error'] = 'setup') => { if (!stopped) { report(error); wire.close(); wire.onclose?.(new CloseEvent('close', {code: 1006})) } }
  deadline = setTimeout(() => fail('timeout'), 12000)
  const request = async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, signal: abort.signal })
    if (!response.ok) { httpStatus = response.status; fail('http'); throw new Error('RTC signaling failed') }
    return response.json()
  }
  void (async () => {
    const config = await request('/api/rtc/config') as RTCConfiguration
    if (stopped) return
    peer = new RTCPeerConnection(config)
    peer.onicecandidateerror = (event) => { if (!stopped) { iceErrors.add(event.errorCode); report() } }
    peer.oniceconnectionstatechange = () => { if (!stopped) report() }
    control = peer.createDataChannel('terminal-control-v2', { ordered: true })
    output = peer.createDataChannel('terminal-output-v2', { ordered: true })
    const route = async () => {
      if (!peer || stopped) return
      try {
        const stats = await peer.getStats()
        if (stopped) return
        const checks = {total: 0, succeeded: 0, requestsSent: 0, responsesReceived: 0, requestsReceived: 0, responsesSent: 0}
        stats.forEach((pair) => {
          if (pair.type !== 'candidate-pair') return
          checks.total++
          if (pair.state === 'succeeded') checks.succeeded++
          for (const key of ['requestsSent', 'responsesReceived', 'requestsReceived', 'responsesSent'] as const) {
            if (Number.isFinite(pair[key]) && pair[key] >= 0) checks[key] += pair[key]
          }
          if (!pair.nominated || pair.state !== 'succeeded') return
          const local = stats.get(pair.localCandidateId) as { candidateType?: string; protocol?: string } | undefined
          const remote = stats.get(pair.remoteCandidateId) as { candidateType?: string; protocol?: string } | undefined
          onRoute?.(local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : local && remote ? 'direct' : 'unknown', local?.protocol ?? 'unknown')
        })
        candidatePairs = checks; report()
      } catch { /* Stats are optional. */ }
    }
    // Keep numeric check counters even when no pair succeeds, so a timeout
    // can be distinguished from an established ICE path with a stuck channel.
    statsTimer = setInterval(() => void route(), 1000)
    let opened = 0
    for (const channel of [control, output]) {
      channel.binaryType = 'arraybuffer'
      channel.onopen = () => { if (!stopped && ++opened === 2) { wire.readyState = 1; clearTimeout(deadline); advance('open'); clearInterval(statsTimer); statsTimer = setInterval(() => void route(), 3000); void route() } }
      channel.onmessage = (event) => { if (!stopped) wire.onmessage?.(event) }
      channel.onclose = () => fail('channel'); channel.onerror = () => fail('channel')
    }
    peer.onconnectionstatechange = () => { if (peer?.connectionState === 'failed' || peer?.connectionState === 'disconnected') fail('connection'); else if (!stopped) report() }
    advance('offer')
    await peer.setLocalDescription(await peer.createOffer())
    advance('gathering')
    if (peer.iceGatheringState !== 'complete') await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        abort.signal.removeEventListener('abort', finish)
        peer!.onicegatheringstatechange = null
        resolve()
      }
      const timer = setTimeout(finish, 8000)
      peer!.onicegatheringstatechange = () => { if (peer!.iceGatheringState === 'complete') finish() }
      abort.signal.addEventListener('abort', finish, { once: true })
    })
    if (stopped) return
    advance('signaling')
    const answer = await request(`/api/terminals/${encodeURIComponent(id)}/rtc?v=2&client=${client}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(peer.localDescription) }) as RTCSessionDescriptionInit
    if (stopped) return
    remoteSDP = answer.sdp; advance('answer')
    await peer.setRemoteDescription(answer)
    if (!stopped && wire.readyState !== 1) advance('connecting')
  })().catch(() => fail())
  return wire
}
