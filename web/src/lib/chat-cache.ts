// RecentCache keeps the values of the last few keys used, newest last: a
// revisited chat renders from memory while only newer events are fetched.
export class RecentCache<T> {
  private readonly entries = new Map<string, T>()
  private readonly max: number

  constructor(max: number) {
    this.max = max
  }

  get(key: string): T | undefined {
    return this.entries.get(key)
  }

  // put stores value as the newest entry, dropping the oldest beyond max.
  put(key: string, value: T): void {
    this.entries.delete(key)
    this.entries.set(key, value)
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.max) break
      this.entries.delete(oldest)
    }
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}
