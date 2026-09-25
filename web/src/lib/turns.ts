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
