// Route is what the URL says is open: a session chat (/s/<id>) or a
// terminal (/t/<id>). Anything else opens the app as it was.
// /terminal is terminal mode before a shell is attached.
export type Route =
  | { kind: 'session'; id: string }
  | { kind: 'terminal'; id: string }
  | { kind: 'terminals' }
  | { kind: 'diagnostics' }
  | { kind: 'overview' }
  | { kind: 'none' }

export function parseRoute(pathname: string): Route {
  if (/^\/diagnostics\/?$/.test(pathname)) return { kind: 'diagnostics' }
  if (/^\/terminal\/?$/.test(pathname)) return { kind: 'terminals' }
  if (/^\/overview\/?$/.test(pathname)) return { kind: 'overview' }
  const m = /^\/([st])\/([^/]+)\/?$/.exec(pathname)
  if (!m) return { kind: 'none' }
  try {
    const id = decodeURIComponent(m[2])
    return m[1] === 's' ? { kind: 'session', id } : { kind: 'terminal', id }
  } catch {
    return { kind: 'none' }
  }
}

export function routePath(mode: 'agents' | 'terminal' | 'diagnostics', sessionId: string | null, terminalId: string | null, pane?: string): string {
  if (mode === 'diagnostics') return '/diagnostics'
  if (mode === 'terminal') return terminalId ? `/t/${encodeURIComponent(terminalId)}` : '/terminal'
  if (pane === 'overview') return '/overview'
  return sessionId ? `/s/${encodeURIComponent(sessionId)}` : '/'
}
