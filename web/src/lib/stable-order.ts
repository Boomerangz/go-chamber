// An always-open page that reorders its lists by activity all day breaks
// the owner's memory of where things are. A stable order keeps each known
// key where it first appeared until the page reloads; a key never seen
// before goes on top.

export interface Kept {
  // order is fresh, rearranged: new keys first, then known ones as before.
  order: string[]
  // memory is every key seen so far, in place, including ones now away.
  memory: string[]
}

// keepOrder arranges fresh (keys in their natural order, newest activity
// first) by memory.
export function keepOrder(fresh: string[], memory: string[]): Kept {
  const known = new Set(memory)
  const added = fresh.filter((k) => !known.has(k))
  const next = [...added, ...memory]
  const now = new Set(fresh)
  return { order: next.filter((k) => now.has(k)), memory: next }
}

const memories = new Map<string, string[]>()

// stableOrder arranges fresh by what the named list showed before on this
// page.
export function stableOrder(list: string, fresh: string[]): string[] {
  const kept = keepOrder(fresh, memories.get(list) ?? [])
  memories.set(list, kept.memory)
  return kept.order
}

// by arranges items, by their keys, in the named list's stable order.
stableOrder.by = function by<T>(list: string, items: T[], key: (item: T) => string): T[] {
  const at = new Map(stableOrder(list, items.map(key)).map((k, i) => [k, i]))
  return [...items].sort((a, b) => at.get(key(a))! - at.get(key(b))!)
}

// resetStableOrders forgets every list's order, as a reload does.
export function resetStableOrders(): void {
  memories.clear()
}
