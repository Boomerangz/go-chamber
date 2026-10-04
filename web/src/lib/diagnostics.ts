// Only timings and counters live here; prompts, shell input and output are never recorded.
export type MetricKey = 'http' | 'ws' | 'agentBatch' | 'agentCommit' | 'terminalParse' | 'eventLoop'
const keys: MetricKey[] = ['http', 'ws', 'agentBatch', 'agentCommit', 'terminalParse', 'eventLoop']
const limit = 120
interface Samples { values: number[]; count: number }
export interface MetricSummary { count: number; samples: number; last: number | null; p50: number | null; p95: number | null; max: number | null }
interface TerminalMetrics { id: string; receivedBytes: number; pendingBytes: number; peakPendingBytes: number; reconnects: number }
let samples = freshSamples()
let agent = { events: 0, batches: 0, batchSize: 0 }
let terminals = new Map<string, TerminalMetrics>()
const commits = new Map<string, number>()
const agentViews = new Set<string>()
let startedAt = Date.now()
let longTasks = 0
let longTaskSupport = false

function freshSamples(): Record<MetricKey, Samples> {
  return Object.fromEntries(keys.map((key) => [key, { values: [] as number[], count: 0 }])) as Record<MetricKey, Samples>
}

export function recordSample(key: MetricKey, ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return
  const sample = samples[key]
  sample.count++
  sample.values.push(ms)
  if (sample.values.length > limit) sample.values.shift()
}

function summarize(sample: Samples): MetricSummary {
  const sorted = [...sample.values].sort((a, b) => a - b)
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null
  return { count: sample.count, samples: sorted.length, last: sample.values.at(-1) ?? null, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null }
}

export function diagnostics() {
  return {
    startedAt,
    metrics: Object.fromEntries(keys.map((key) => [key, summarize(samples[key])])) as Record<MetricKey, MetricSummary>,
    agent: { ...agent },
    terminals: [...terminals.values()].map((terminal) => ({ ...terminal })),
    browser: { longTasks, longTaskSupport },
  }
}

export function resetDiagnostics() {
  samples = freshSamples()
  agent = { events: 0, batches: 0, batchSize: 0 }
  // Pending writes still have callbacks outstanding; keep their accounting.
  for (const terminal of terminals.values()) {
    terminal.receivedBytes = 0
    terminal.peakPendingBytes = terminal.pendingBytes
    terminal.reconnects = 0
  }
  commits.clear()
  startedAt = Date.now()
  longTasks = 0
}

export function recordAgentEvent() { agent.events++ }
export function recordAgentBatch(waitMs: number, size: number) {
  agent.batches++
  agent.batchSize = size
  recordSample('agentBatch', waitMs)
}
export function beginAgentView(id: string) { agentViews.add(id); commits.delete(id) }
export function endAgentView(id: string) { agentViews.delete(id); commits.delete(id) }
export function markAgentUpdate(id: string, at = performance.now()) {
  if (!agentViews.has(id)) return
  if (commits.size >= 64 && !commits.has(id)) commits.delete(commits.keys().next().value!)
  commits.set(id, at)
}
export function recordAgentCommit(id: string | undefined, at = performance.now()) {
  if (!id) return
  const start = commits.get(id)
  if (start === undefined) return
  commits.delete(id)
  recordSample('agentCommit', at - start)
}
function terminal(id: string): TerminalMetrics {
  let value = terminals.get(id)
  if (!value) {
    if (terminals.size >= 64) terminals.delete(terminals.keys().next().value!)
    value = { id, receivedBytes: 0, pendingBytes: 0, peakPendingBytes: 0, reconnects: 0 }
    terminals.set(id, value)
  }
  return value
}
export function recordTerminalOutput(id: string, bytes: number) {
  const value = terminal(id)
  value.receivedBytes += bytes
  value.pendingBytes += bytes
  value.peakPendingBytes = Math.max(value.peakPendingBytes, value.pendingBytes)
}
export function completeTerminalOutput(id: string, bytes: number, ms: number) {
  const value = terminals.get(id)
  if (value) value.pendingBytes = Math.max(0, value.pendingBytes - bytes)
  recordSample('terminalParse', ms)
}
export function recordTerminalReconnect(id: string) { terminal(id).reconnects++ }
export function forgetTerminal(id: string) { terminals.delete(id) }

export function monitorBrowser(): () => void {
  let previous = performance.now()
  let hidden = document.hidden
  const timer = setInterval(() => {
    const now = performance.now()
    if (!document.hidden && !hidden) recordSample('eventLoop', Math.max(0, now - previous - 500))
    previous = now
    hidden = document.hidden
  }, 500)
  let observer: PerformanceObserver | undefined
  longTaskSupport = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
  if (longTaskSupport) {
    observer = new PerformanceObserver((list) => { longTasks += list.getEntries().length })
    observer.observe({ type: 'longtask' })
  }
  return () => { clearInterval(timer); observer?.disconnect() }
}
