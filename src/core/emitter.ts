export type Listener<T> = (ev: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(ev: T): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(ev);
      } catch (err) {
        // listeners must not break the emitter
        console.error(err);
      }
    }
  }
  clear(): void {
    this.listeners.clear();
  }
}
