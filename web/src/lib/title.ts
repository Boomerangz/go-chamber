export interface Attention {
  // pending is how many agent requests wait for the owner.
  pending: number
  // running is true while any session's turn runs.
  running: boolean
  session?: string
}

// attentionTitle is the tab title: a background tab still says that an agent
// needs you (the count) or is working (the dot).
export function attentionTitle({ pending, running, session }: Attention): string {
  const parts: string[] = []
  if (pending > 0) parts.push(`(${pending})`)
  if (running) parts.push('●')
  parts.push(session ? `${session} · go-chamber` : 'go-chamber')
  return parts.join(' ')
}
