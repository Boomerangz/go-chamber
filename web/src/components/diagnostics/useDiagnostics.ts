import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage, type CLIStatus } from '../../lib/api'
import { diagnostics, recordSample } from '../../lib/diagnostics'
import { describeError } from '../../stores/notices'

export interface ServerDiagnostics {
  uptimeSeconds: number
  goroutines: number
  heapBytes: number
  events: { published: number; persistCalls: number; persistErrors: number; persistMeanMs: number; persistMaxMs: number; lockWaitMeanMs: number; lockWaitMaxMs: number }
  terminals: { id: string; clients: number; queuedBytes: number; outputBytes: number; laggedClients: number }[]
  clis?: CLIStatus[]
}

export function useDiagnostics(enabled: boolean) {
  const [client, setClient] = useState(diagnostics)
  const [server, setServer] = useState<ServerDiagnostics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [socketStatus, setSocketStatus] = useState('connecting')
  // probe asks the server again now; it is the running effect's own probe.
  const probe = useRef<(() => void) | null>(null)

  useEffect(() => {
    const timer = setInterval(() => setClient(diagnostics()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let busy = false
    let socket: WebSocket | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let pending: { token: string; start: number } | null = null
    let sequence = 0
    let currentRequest: AbortController | undefined

    const probeHTTP = async () => {
      if (busy) return
      busy = true
      const start = performance.now()
      const controller = new AbortController()
      currentRequest = controller
      // Bound a stalled request so it cannot suppress all later samples.
      const deadline = setTimeout(() => controller.abort(), 5000)
      try {
        const response = await fetch('/api/diagnostics', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
        if (!response.ok) {
          const body = await response.text().catch(() => '')
          throw new Error(errorMessage(body, `${response.status} ${response.statusText}`.trim()))
        }
        const body = await response.json() as ServerDiagnostics
        if (!disposed) {
          recordSample('http', performance.now() - start)
          setServer(body)
          setError(null)
        }
      } catch (err) {
        if (!disposed) setError(describeError(err))
      } finally {
        clearTimeout(deadline)
        busy = false
      }
    }

    const probeSocket = () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return
      if (pending) {
        if (performance.now() - pending.start > 5000) {
          setSocketStatus('timed out')
          socket.close()
        }
        return
      }
      pending = { token: String(++sequence), start: performance.now() }
      socket.send(pending.token)
    }
    const connect = () => {
      if (disposed || typeof WebSocket === 'undefined') return
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
      socket = new WebSocket(`${scheme}//${location.host}/api/diagnostics/ws`)
      socket.onopen = () => { if (!disposed) { setSocketStatus('online'); probeSocket() } }
      socket.onmessage = (event) => {
        if (!disposed && pending && event.data === pending.token) {
          recordSample('ws', performance.now() - pending.start)
          pending = null
        }
      }
      socket.onerror = () => { if (!disposed) setSocketStatus('offline') }
      socket.onclose = () => {
        pending = null
        if (!disposed) { setSocketStatus('reconnecting'); retry = setTimeout(connect, 1000) }
      }
    }
    probe.current = () => void probeHTTP()
    void probeHTTP()
    connect()
    const timer = setInterval(() => { void probeHTTP(); probeSocket() }, 2000)
    return () => {
      disposed = true
      probe.current = null
      currentRequest?.abort()
      clearInterval(timer)
      clearTimeout(retry)
      socket?.close()
    }
  }, [enabled])
  const retry = useCallback(() => probe.current?.(), [])
  return { client, server, error, socketStatus, retry }
}
