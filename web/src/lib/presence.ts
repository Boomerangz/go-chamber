// Where the single owner is, across their pages on every device. Each page
// tells the server, on the event socket, which session it shows and whether
// it is visible and focused; the server answers with the page the owner was
// at last. That page alone chimes, and the server pushes nothing about a
// session a focused page shows.

function newClientId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

const client = newClientId()
let session: string | null = null
let send: ((frame: string) => void) | null = null
// active is the page the owner was at last; undefined until the server says.
let active: string | undefined
let started = false

export function presenceClient(): string {
  return client
}

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
const focused = () => typeof document !== 'undefined' && document.hasFocus()

function report(): void {
  if (!send) return
  send(JSON.stringify({ type: 'presence', client, session: session ?? undefined, visible: visible(), focused: focused() }))
}

// bindPresence hands over the open socket's send (null once it closes) and
// says where this page is.
export function bindPresence(fn: ((frame: string) => void) | null): void {
  send = fn
  report()
}

export function setPresenceSession(id: string | null): void {
  if (id === session) return
  session = id
  report()
}

// setActiveClient takes the server's word on where the owner was last.
export function setActiveClient(id: string): void {
  active = id
}

// startPresence reports every change of focus and visibility.
export function startPresence(): void {
  if (started || typeof window === 'undefined') return
  started = true
  window.addEventListener('focus', report)
  window.addEventListener('blur', report)
  document.addEventListener('visibilitychange', report)
}

// chimesHere is true on the one page that should sound: the one the owner
// was at last. Until the server says, or with no page counted, every page
// sounds as before.
export function chimesHere(): boolean {
  return !active || active === client
}

// watchingHere is true when this page shows the session to the owner now.
export function watchingHere(id: string): boolean {
  return session === id && visible() && focused()
}

export function resetPresence(): void {
  session = null
  send = null
  active = undefined
}
