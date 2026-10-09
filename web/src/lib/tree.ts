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

// prune drops the nodes keep refuses, at every depth; a node whose children
// all stay is kept as it is.
export function prune(nodes: ItemNode[], keep: (item: Item) => boolean): ItemNode[] {
  const out: ItemNode[] = []
  for (const node of nodes) {
    if (!keep(node.item)) continue
    const children = prune(node.children, keep)
    out.push(children.length === node.children.length ? node : { ...node, children })
  }
  return out
}

// Hooks is how much of the hooks the transcript shows: those that said
// something (some), every run (all), or only the ones that failed (off).
export type Hooks = 'off' | 'some' | 'all'

// showsItem says whether the transcript shows an item under the hooks setting.
export function showsItem(item: Item, hooks: Hooks): boolean {
  if (item.kind !== 'hook' || hooks === 'some') return !isBlank(item)
  return hooks === 'all' || item.outcome === 'error' || item.status === 'failed'
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
// them, e.g. after a hook continued the turn) and hooks with nothing to
// say: a tool hook runs around every tool call, mostly silently.
export function isBlank(item: Item): boolean {
  if (item.kind === 'hook') {
    return !item.text?.trim() && item.outcome !== 'blocked' && item.outcome !== 'error' && item.status !== 'failed'
  }
  return item.kind === 'assistant_message' && item.status === 'completed' && !item.text?.trim()
}

// shownFrom is the first row at or after id in order, so a mark set on an
// item the transcript hides lands on the row that follows it.
export function shownFrom(order: string[], rows: ItemNode[], id: string | null): string | null {
  if (!id) return null
  const shown = new Set(rows.map((row) => row.item.id))
  for (let i = order.indexOf(id); i >= 0 && i < order.length; i++) {
    if (shown.has(order[i]!)) return order[i]!
  }
  return null
}

// Tools that ask the owner a question: the request card asks it and the
// decision record keeps the answer, so the tool line only repeats them.
const QUESTION_TOOLS = new Set(['AskUserQuestion'])

// withoutAnsweredQuestions drops a question tool line once a decision
// record follows it in the same turn.
export function withoutAnsweredQuestions(nodes: ItemNode[]): ItemNode[] {
  const hidden = new Set<ItemNode>()
  let asked: ItemNode[] = []
  for (const node of nodes) {
    const { kind, name } = node.item
    if (kind === 'user_message') asked = []
    else if (kind === 'decision') {
      asked.forEach((q) => hidden.add(q))
      asked = []
    } else if (kind === 'tool_call' && name && QUESTION_TOOLS.has(name)) asked.push(node)
  }
  return hidden.size ? nodes.filter((node) => !hidden.has(node)) : nodes
}
