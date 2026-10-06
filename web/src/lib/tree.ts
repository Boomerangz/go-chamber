import type { Item } from './api'

export interface ItemNode {
  item: Item
  children: ItemNode[]
  // group holds the tool lines folded into this one row (see groupTools).
  group?: ItemNode[]
}

// itemTree nests items by parentItemId, preserving order. Items whose parent
// is missing become roots, so a partially loaded replay still renders.
export function itemTree(order: string[], items: Record<string, Item>): ItemNode[] {
  const nodes = new Map<string, ItemNode>()
  for (const id of order) {
    const item = items[id]
    if (item) nodes.set(id, { item, children: [] })
  }
  const roots: ItemNode[] = []
  for (const id of order) {
    const node = nodes.get(id)
    if (!node) continue
    const parent = node.item.parentItemId ? nodes.get(node.item.parentItemId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

import type { Session } from './api'

export interface SessionNode {
  session: Session
  children: SessionNode[]
}

// sessionTree nests sessions by parentId, preserving order. Sessions whose
// parent is unknown become roots.
export function sessionTree(sessions: Session[]): SessionNode[] {
  const nodes = new Map<string, SessionNode>()
  for (const session of sessions) nodes.set(session.id, { session, children: [] })
  const roots: SessionNode[] = []
  for (const session of sessions) {
    const node = nodes.get(session.id)!
    const parent = session.parentId ? nodes.get(session.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

// sameNode reports whether two trees hold the same item objects, so a row
// rebuilt by itemTree can skip rendering when nothing in it changed.
export function sameNode(a: ItemNode, b: ItemNode): boolean {
  return a.item === b.item && a.children.length === b.children.length &&
    a.children.every((child, i) => sameNode(child, b.children[i]!)) &&
    a.group?.length === b.group?.length &&
    (a.group ?? []).every((member, i) => sameNode(member, b.group![i]!))
}

// isBlank hides finished assistant messages without text (Codex sends
// them, e.g. after a hook continued the turn).
export function isBlank(item: Item): boolean {
  return item.kind === 'assistant_message' && item.status === 'completed' && !item.text?.trim()
}
