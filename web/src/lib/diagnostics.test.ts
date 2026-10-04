import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { diagnostics, recordSample, recordAgentEvent, recordAgentBatch, beginAgentView, endAgentView, markAgentUpdate, recordAgentCommit, recordTerminalOutput, completeTerminalOutput, recordTerminalReconnect, resetDiagnostics, forgetTerminal, monitorBrowser, recordTerminalTransport, recordTerminalRTT } from './diagnostics'

beforeEach(() => { resetDiagnostics(); for (const terminal of diagnostics().terminals) forgetTerminal(terminal.id) })
afterEach(() => { endAgentView('s1'); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

it('records route classifications and resets RTC timings without losing the active connection', () => {
 recordTerminalTransport('rtc', 'webrtc', 'direct', 'udp')
 recordTerminalRTT('rtc', 42)
 expect(diagnostics().terminals[0]).toMatchObject({ transport: 'webrtc', route: 'direct', protocol: 'udp', rtcRTTMs: 42 })
 expect(diagnostics().metrics.rtc.last).toBe(42)
 resetDiagnostics()
 expect(diagnostics().terminals[0]).toMatchObject({ transport: 'webrtc', route: 'direct' })
 expect(diagnostics().terminals[0].rtcRTTMs).toBeUndefined()
})

it('bounds samples and computes percentiles without recording message content', () => {
  for (let i = 1; i <= 200; i++) recordSample('http', i)
  const snapshot = diagnostics()
  expect(snapshot.metrics.http.count).toBe(200)
  expect(snapshot.metrics.http.samples).toBe(120)
  expect(snapshot.metrics.http.p50).toBe(140)
  expect(snapshot.metrics.http.p95).toBe(194)
  expect(snapshot.metrics.http.last).toBe(200)
  expect(snapshot.metrics.http.max).toBe(200)
})

it('ignores invalid timing samples and reports empty metrics', () => {
  for (const value of [NaN, Infinity, -1]) recordSample('http', value)
  expect(diagnostics().metrics.http).toEqual({ count: 0, samples: 0, last: null, p50: null, p95: null, max: null })
  recordSample('http', 0)
  expect(diagnostics().metrics.http.last).toBe(0)
})

it('does not time inactive or unmounted chats', () => {
  markAgentUpdate('inactive', 0)
  recordAgentCommit('inactive', 10)
  beginAgentView('mounted')
  markAgentUpdate('mounted', 0)
  endAgentView('mounted')
  recordAgentCommit('mounted', 10)
  recordAgentCommit(undefined)
  expect(diagnostics().metrics.agentCommit.count).toBe(0)
})

it('preserves outstanding write accounting on reset and forgets disposed terminals', () => {
  recordTerminalOutput('reset', 100)
  resetDiagnostics()
  expect(diagnostics().terminals.find((t) => t.id === 'reset')).toEqual({ id: 'reset', receivedBytes: 0, pendingBytes: 100, peakPendingBytes: 100, reconnects: 0 })
  completeTerminalOutput('reset', 150, 3)
  expect(diagnostics().terminals.find((t) => t.id === 'reset')?.pendingBytes).toBe(0)
  forgetTerminal('reset')
  completeTerminalOutput('reset', 100, 3)
  expect(diagnostics().terminals.some((t) => t.id === 'reset')).toBe(false)
})

it('bounds retained terminal records', () => {
  for (let i = 0; i < 70; i++) recordTerminalReconnect(`bounded-${i}`)
  expect(diagnostics().terminals).toHaveLength(64)
  expect(diagnostics().terminals.some((t) => t.id === 'bounded-0')).toBe(false)
  for (const terminal of diagnostics().terminals) forgetTerminal(terminal.id)
})

it('stops browser sampling when disposed and skips hidden-tab intervals', () => {
  vi.useFakeTimers()
  const interval = vi.spyOn(globalThis, 'setInterval')
  const clear = vi.spyOn(globalThis, 'clearInterval')
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const stop = monitorBrowser()
  expect(interval).toHaveBeenCalledWith(expect.any(Function), 500)
  const tick = interval.mock.calls[0][0] as () => void
  clock.mockReturnValue(800)
  tick()
  expect(diagnostics().metrics.eventLoop.count).toBe(1)
  expect(diagnostics().metrics.eventLoop.last).toBe(200)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  clock.mockReturnValue(1300)
  tick()
  expect(diagnostics().metrics.eventLoop.count).toBe(1)
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  clock.mockReturnValue(1800)
  tick()
  expect(diagnostics().metrics.eventLoop.count).toBe(1)
  clock.mockReturnValue(2300)
  tick()
  expect(diagnostics().metrics.eventLoop.count).toBe(2)
  stop()
  expect(clear).toHaveBeenCalledWith(interval.mock.results[0].value)
  expect(diagnostics().metrics.eventLoop.count).toBe(2)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('counts supported long tasks and disconnects the observer', () => {
  vi.useFakeTimers()
  const observe = vi.fn()
  const disconnect = vi.fn()
  let deliver: ((list: { getEntries(): unknown[] }) => void) | undefined
  vi.stubGlobal('PerformanceObserver', class {
    static supportedEntryTypes = ['longtask']
    observe = observe
    disconnect = disconnect
    constructor(callback: typeof deliver) { deliver = callback }
  })
  const stop = monitorBrowser()
  expect(observe).toHaveBeenCalledWith({ type: 'longtask' })
  deliver?.({ getEntries: () => [{}, {}] })
  expect(diagnostics().browser).toEqual({ longTasks: 2, longTaskSupport: true })
  resetDiagnostics()
  expect(diagnostics().browser.longTasks).toBe(0)
  stop()
  expect(disconnect).toHaveBeenCalledOnce()
})

it('bounds pending chat commits while keeping updates for an existing chat', () => {
  for (let i = 0; i < 64; i++) { beginAgentView(`bounded-${i}`); markAgentUpdate(`bounded-${i}`, 0) }
  markAgentUpdate('bounded-0', 2)
  recordAgentCommit('bounded-0', 10)
  expect(diagnostics().metrics.agentCommit.last).toBe(8)
  markAgentUpdate('bounded-0', 0)
  beginAgentView('overflow'); markAgentUpdate('overflow', 0)
  recordAgentCommit('bounded-1', 10)
  expect(diagnostics().metrics.agentCommit.count).toBe(1)
  recordAgentCommit('overflow', 10)
  expect(diagnostics().metrics.agentCommit.count).toBe(2)
  for (let i = 0; i < 64; i++) endAgentView(`bounded-${i}`)
  endAgentView('overflow')
})

it('measures agent batching and React commit separately', () => {
  recordAgentEvent()
  recordAgentEvent()
  recordAgentBatch(20, 2)
  beginAgentView('s1')
  markAgentUpdate('s1', 100)
  recordAgentCommit('other', 130)
  expect(diagnostics().metrics.agentCommit.count).toBe(0)
  recordAgentCommit('s1', 140)
  recordAgentCommit('s1', 150)
  expect(diagnostics().agent.events).toBe(2)
  expect(diagnostics().agent.batchSize).toBe(2)
  expect(diagnostics().metrics.agentBatch.last).toBe(20)
  expect(diagnostics().metrics.agentCommit.last).toBe(40)
})

it('tracks terminal backlog through output callbacks and reconnects', () => {
  recordTerminalOutput('t1', 1024)
  recordTerminalOutput('t1', 512)
  completeTerminalOutput('t1', 1024, 12)
  recordTerminalReconnect('t1')
  const terminal = diagnostics().terminals[0]!
  expect(terminal.receivedBytes).toBe(1536)
  expect(terminal.pendingBytes).toBe(512)
  expect(terminal.peakPendingBytes).toBe(1536)
  expect(terminal.reconnects).toBe(1)
  expect(diagnostics().metrics.terminalParse.last).toBe(12)
  completeTerminalOutput('t1', 512, 5)
  expect(diagnostics().terminals[0]!.pendingBytes).toBe(0)
})
