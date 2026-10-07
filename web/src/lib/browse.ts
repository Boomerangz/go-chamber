// Stepping through the sessions with j/k is browsing: the chat it opens
// must not take the focus, or the next j would be typed into its composer.

let stepped: string | null = null

// noteBrowse says the next chat to open is session id, reached by a step.
export function noteBrowse(id: string): void {
  stepped = id
}

// browsedTo tells an opening chat whether a step brought it there. It is
// asked once per opening, so the note never outlives the next chat.
export function browsedTo(id: string): boolean {
  const hit = stepped === id
  stepped = null
  return hit
}
