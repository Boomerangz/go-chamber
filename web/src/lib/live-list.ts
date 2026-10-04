// LiveList overlays changes made during a list fetch on its server snapshot.
// Updates are retained only for in-flight fetches, including deletion markers.
export class LiveList<T> {
  private generation = 0
  private pending = new Set<Map<string, T | null>>()
  private key: (value: T) => string

  constructor(key: (value: T) => string) {
    this.key = key
  }

  update(id: string, value: T | null): void {
    for (const changes of this.pending) changes.set(id, value)
  }

  async load(fetch: () => Promise<T[]>): Promise<T[] | null> {
    const mine = ++this.generation
    const changes = new Map<string, T | null>()
    this.pending.add(changes)
    try {
      const values = await fetch()
      if (mine !== this.generation) return null
      const merged = new Map(values.map((value) => [this.key(value), value]))
      for (const [id, value] of changes) {
        if (value === null) merged.delete(id)
        else merged.set(id, value)
      }
      return [...merged.values()]
    } catch (err) {
      if (mine !== this.generation) return null
      throw err
    } finally {
      this.pending.delete(changes)
    }
  }

  reset(): void {
    this.generation++
    this.pending.clear()
  }
}
