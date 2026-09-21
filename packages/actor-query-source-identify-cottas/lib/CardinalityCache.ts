/**
 * A bounded least-recently-used cache of pending cardinality lookups.
 *
 * A COTTAS document is a read-only file for its whole lifetime, so a pattern's cardinality cannot
 * change and may be reused. Pending promises are stored rather than resolved values, so the
 * concurrent duplicate probes a bind join produces collapse onto a single query.
 */
export class CardinalityCache<T> {
  private readonly entries = new Map<string, Promise<T>>();
  private readonly maxSize: number;

  public constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  public get(key: string): Promise<T> | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      // Re-insert so that the most recently used key is evicted last.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  public set(key: string, value: Promise<T>): void {
    this.entries.set(key, value);
    // A failed lookup must not be remembered; the next caller should retry it. The identity check
    // matters because this entry may already have been evicted and replaced by the time it settles.
    value.catch(() => {
      if (this.entries.get(key) === value) {
        this.entries.delete(key);
      }
    });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxSize) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  public clear(): void {
    this.entries.clear();
  }
}
