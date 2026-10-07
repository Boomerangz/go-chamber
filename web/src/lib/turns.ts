import type { ItemNode } from './tree'

// turnNumbers numbers the user's messages in transcript order; the chat hangs
// these in the margin so a turn can be referred to by number.
export function turnNumbers(nodes: ItemNode[]): Map<string, number> {
  const turns = new Map<string, number>()
  for (const node of nodes) {
    if (node.item.kind === 'user_message') turns.set(node.item.id, turns.size + 1)
  }
  return turns
}

export interface OutlineEntry {
  id: string
  n: number
  text: string
}

// turnOutline is the transcript's table of contents: each of the user's
// turns by its number and the first line of what was asked, in one line. A
// turn sent with no words (an image) is named by its attachment.
export function turnOutline(nodes: ItemNode[]): OutlineEntry[] {
  const out: OutlineEntry[] = []
  for (const node of nodes) {
    if (node.item.kind !== 'user_message') continue
    const first = (node.item.text ?? '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean)
    out.push({ id: node.item.id, n: out.length + 1, text: first || 'attachment' })
  }
  return out
}
