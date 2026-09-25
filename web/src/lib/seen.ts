// Where the user stopped reading each session, so the transcript can mark
// what arrived since. Kept per browser: it is a convenience, not state.

const KEY = 'go-chamber:seen:'

// firstUnseen returns the first item after the last one seen, or null when
// there is nothing new or no record of a previous visit.
export function firstUnseen(order: string[], seenId: string | null): string | null {
  if (!seenId) return null
  const i = order.indexOf(seenId)
  if (i < 0 || i === order.length - 1) return null
  return order[i + 1]
}

export function loadSeen(sessionId: string): string | null {
  try {
    return localStorage.getItem(KEY + sessionId)
  } catch {
    return null
  }
}

export function saveSeen(sessionId: string, itemId: string): void {
  try {
    localStorage.setItem(KEY + sessionId, itemId)
  } catch {
    // Storage may be blocked; the mark is optional.
  }
}
