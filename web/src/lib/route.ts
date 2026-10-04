// Route is what the URL says is open: a session chat (/s/<id>) or a
// terminal (/t/<id>). Anything else opens the app as it was.
export type Route = { kind: 'session'; id: string } | { kind: 'terminal'; id: string } | { kind: 'diagnostics' } | { kind: 'none' }

export function parseRoute(pathname: string): Route {
  if (/^\/diagnostics\/?$/.test(pathname)) return { kind: 'diagnostics' }
  const m = /^\/([st])\/([^/]+)\/?$/.exec(pathname)
  if (!m) return { kind: 'none' }
  try {
    const id = decodeURIComponent(m[2])
    return m[1] === 's' ? { kind: 'session', id } : { kind: 'terminal', id }
  } catch {
    return { kind: 'none' }
  }
}

export function routePath(mode: 'agents' | 'terminal' | 'diagnostics', sessionId: string | null, terminalId: string | null): string {
  if (mode === 'diagnostics') return '/diagnostics'
  if (mode === 'terminal') return terminalId ? `/t/${encodeURIComponent(terminalId)}` : '/'
  return sessionId ? `/s/${encodeURIComponent(sessionId)}` : '/'
}
