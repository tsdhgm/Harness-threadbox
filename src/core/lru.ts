/** Minimal LRU with eviction callback. Keys can be protected from eviction. */
export class Lru<K, V> {
  private map = new Map<K, V>();
  constructor(
    public capacity: number,
    private onEvict?: (key: K, value: V) => void,
  ) {}
  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }
  peek(key: K): V | undefined {
    return this.map.get(key);
  }
  has(key: K): boolean {
    return this.map.has(key);
  }
  set(key: K, value: V, protect?: (key: K) => boolean): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    this.evict(protect);
  }
  delete(key: K): boolean {
    return this.map.delete(key);
  }
  keys(): K[] {
    return [...this.map.keys()];
  }
  get size(): number {
    return this.map.size;
  }
  private evict(protect?: (key: K) => boolean): void {
    if (this.map.size <= this.capacity) return;
    for (const [k, v] of this.map) {
      if (this.map.size <= this.capacity) break;
      if (protect?.(k)) continue;
      this.map.delete(k);
      this.onEvict?.(k, v);
    }
  }
}
