export interface Attention {
  // pending is how many agent requests wait for the owner.
  pending: number
  // running is true while any session's turn runs.
  running: boolean
  session?: string
  // unseen is how many sessions changed since the owner last opened them.
  unseen?: number
}

// attentionTitle is the tab title: a background tab still says that an agent
// needs you (the count), is working (the dot), or changed while you were
// away (new).
export function attentionTitle({ pending, running, session, unseen = 0 }: Attention): string {
  const parts: string[] = []
  if (pending > 0) parts.push(`(${pending})`)
  if (running) parts.push('●')
  if (unseen > 0) parts.push(`${unseen} new ·`)
  parts.push(session ? `${session} · go-chamber` : 'go-chamber')
  return parts.join(' ')
}
