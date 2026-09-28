// Route is what the URL says is open: a session chat (/s/<id>) or a
// terminal (/t/<id>). Anything else opens the app as it was.
export type Route = { kind: 'session'; id: string } | { kind: 'terminal'; id: string } | { kind: 'none' }

export function parseRoute(pathname: string): Route {
  const m = /^\/([st])\/([^/]+)\/?$/.exec(pathname)
  if (!m) return { kind: 'none' }
  const id = decodeURIComponent(m[2])
  return m[1] === 's' ? { kind: 'session', id } : { kind: 'terminal', id }
}

export function routePath(mode: 'agents' | 'terminal', sessionId: string | null, terminalId: string | null): string {
  if (mode === 'terminal') return terminalId ? `/t/${encodeURIComponent(terminalId)}` : '/'
  return sessionId ? `/s/${encodeURIComponent(sessionId)}` : '/'
}
