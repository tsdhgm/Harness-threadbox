import { type SessionStore, groupKeyOf, refKey } from '../core/sessionStore.js';
import type { SessionIndexEntry } from '../core/types.js';
import { sessionLabel } from '../core/types.js';
import { SessionLineCache } from '../render/lineCache.js';
import { type RenderOptions, type RenderedLine, renderSessionHeader } from '../render/transcript.js';

export interface Top {
  key: string;
  line: number;
}

export type BaseRenderOptions = Omit<RenderOptions, 'live' | 'cwd'>;

const PLACEHOLDER_LINES = 3;

/**
 * Continuous virtual document over the sessions in store order, optionally
 * scoped to one project group (then scrolling never leaves that project).
 * The cursor is anchored by session key, never by a global line number.
 */
export class Document {
  order: SessionIndexEntry[] = [];
  private keys: string[] = [];
  private scope: string | undefined;
  private caches = new Map<string, SessionLineCache>();
  private placeholders = new Map<string, RenderedLine[]>();
  /** called when an async load completes (so the app can re-render) */
  onLoaded: ((key: string) => void) | undefined;
  onError: ((msg: string) => void) | undefined;

  constructor(
    private store: SessionStore,
    private base: BaseRenderOptions,
  ) {}

  setBase(b: BaseRenderOptions): void {
    this.base = b;
    this.placeholders.clear();
  }

  getBase(): BaseRenderOptions {
    return this.base;
  }

  /** Restrict the document to one project group (ProjectGroup.key); undefined = all. Call refreshOrder() after. */
  setScope(groupKey: string | undefined): void {
    this.scope = groupKey;
  }

  getScope(): string | undefined {
    return this.scope;
  }

  refreshOrder(): void {
    const all = this.store.order();
    this.order = this.scope === undefined ? all : all.filter((e) => groupKeyOf(e) === this.scope);
    this.keys = this.order.map((e) => refKey(e.ref));
    this.placeholders.clear();
  }

  indexOf(key: string): number {
    return this.keys.indexOf(key);
  }

  keyAt(i: number): string | undefined {
    return this.keys[i];
  }

  entry(key: string): SessionIndexEntry | undefined {
    return this.order[this.indexOf(key)];
  }

  optsFor(e: SessionIndexEntry): RenderOptions {
    return { ...this.base, live: e.live !== null, cwd: e.project.cwd };
  }

  /** Get the line cache if the session is loaded (and make it current). */
  cache(key: string): SessionLineCache | undefined {
    const s = this.store.peekSession(key);
    if (!s) {
      this.caches.delete(key);
      return undefined;
    }
    let c = this.caches.get(key);
    if (!c || c.session !== s) {
      c = new SessionLineCache(s);
      this.caches.set(key, c);
    }
    const e = this.entry(key) ?? s.index;
    c.ensure(this.optsFor(e));
    return c;
  }

  isLoaded(key: string): boolean {
    return this.store.isLoaded(key);
  }

  count(key: string): number {
    const c = this.cache(key);
    return c ? c.total() : PLACEHOLDER_LINES;
  }

  private placeholder(key: string): RenderedLine[] {
    let p = this.placeholders.get(key);
    if (p) return p;
    const e = this.entry(key);
    if (!e) return [];
    const o = this.optsFor(e);
    const header = renderSessionHeader(e, sessionLabel(e), o);
    const loading = this.store.isLoading(key) ? 'loading…' : 'loading…';
    const l: RenderedLine = {
      ansi: o.color ? `  \x1b[2m${loading}\x1b[0m` : `  ${loading}`,
      plain: `  ${loading}`,
      width: 2 + loading.length,
      kind: 'meta',
      anchor: { turnId: `placeholder:${key}`, blockIdx: -1 },
    };
    p = [header[0]!, l, { ansi: '', plain: '', width: 0, kind: 'blank', anchor: { turnId: `placeholder:${key}`, blockIdx: -1 } }];
    this.placeholders.set(key, p);
    return p;
  }

  lineAt(key: string, line: number): RenderedLine | undefined {
    const c = this.cache(key);
    if (c) return c.lineAt(line);
    return this.placeholder(key)[line];
  }

  /** Trigger an async load of session index i (no-op if loaded/loading). */
  ensureLoaded(i: number): void {
    const e = this.order[i];
    if (!e) return;
    const k = refKey(e.ref);
    if (this.store.isLoaded(k) || this.store.isLoading(k)) return;
    this.store.load(e).then(
      () => this.onLoaded?.(k),
      (err: unknown) => this.onError?.(`load ${e.ref.sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /** Preload neighbours of i and protect the visible window from eviction. */
  preload(i: number, span = 1): void {
    const keys: string[] = [];
    for (let d = -span; d <= span; d++) {
      const k = this.keys[i + d];
      if (k) keys.push(k);
    }
    this.store.protect(keys);
    for (let d = -span; d <= span; d++) if (i + d >= 0) this.ensureLoaded(i + d);
  }

  topOf(key: string): Top {
    return { key, line: 0 };
  }

  /** Top such that the last line of session i is the last visible row. */
  clampToEnd(i: number, rows: number): Top {
    const key = this.keys[i]!;
    let remaining = rows;
    let idx = i;
    let line = this.count(key);
    // walk backwards from the end of session i
    for (;;) {
      if (line >= remaining) return { key: this.keys[idx]!, line: line - remaining };
      remaining -= line;
      if (idx === 0) return { key: this.keys[0]!, line: 0 };
      idx--;
      line = this.count(this.keys[idx]!);
    }
  }

  /** Scroll by delta lines; crosses session boundaries. */
  scrollBy(top: Top, delta: number, rows: number): Top {
    let i = this.indexOf(top.key);
    if (i < 0) {
      if (this.keys.length === 0) return top;
      i = 0;
      top = { key: this.keys[0]!, line: 0 };
    }
    let line = top.line + delta;
    while (line < 0) {
      if (i === 0) {
        line = 0;
        break;
      }
      i--;
      this.ensureLoaded(i);
      line += this.count(this.keys[i]!);
    }
    while (line >= this.count(this.keys[i]!)) {
      if (i === this.keys.length - 1) {
        const end = this.clampToEnd(i, rows);
        this.preload(this.indexOf(end.key));
        return end;
      }
      line -= this.count(this.keys[i]!);
      i++;
      this.ensureLoaded(i);
    }
    // don't scroll past the global end
    const result = { key: this.keys[i]!, line };
    const end = this.clampToEnd(this.keys.length - 1, rows);
    const ei = this.indexOf(end.key);
    if (i > ei || (i === ei && line > end.line)) {
      this.preload(ei);
      return end;
    }
    this.preload(i);
    return result;
  }

  /** Clamp top into a valid position (after content changes). */
  clamp(top: Top, rows: number): Top {
    const i = this.indexOf(top.key);
    if (i < 0) return this.keys.length ? { key: this.keys[0]!, line: 0 } : top;
    const n = this.count(top.key);
    const line = Math.max(0, Math.min(top.line, Math.max(0, n - 1)));
    return this.scrollBy({ key: top.key, line }, 0, rows);
  }

  /** Lines visible from top (exactly `rows` entries; undefined past the end). */
  visible(top: Top, rows: number): Array<{ key: string; line: RenderedLine | undefined; lineIdx: number }> {
    const out: Array<{ key: string; line: RenderedLine | undefined; lineIdx: number }> = [];
    let i = this.indexOf(top.key);
    if (i < 0) return out;
    let line = top.line;
    while (out.length < rows && i < this.keys.length) {
      const key = this.keys[i]!;
      if (!this.isLoaded(key)) this.ensureLoaded(i);
      const n = this.count(key);
      for (; line < n && out.length < rows; line++) out.push({ key, line: this.lineAt(key, line), lineIdx: line });
      i++;
      line = 0;
    }
    while (out.length < rows) out.push({ key: '', line: undefined, lineIdx: -1 });
    return out;
  }

  /** Session key shown on the last visible row. */
  bottomKey(top: Top, rows: number): string {
    const v = this.visible(top, rows);
    for (let i = v.length - 1; i >= 0; i--) if (v[i]!.key) return v[i]!.key;
    return top.key;
  }

  /** True when the last line of `key` is visible. */
  showsEndOf(top: Top, rows: number, key: string): boolean {
    const v = this.visible(top, rows);
    const n = this.count(key);
    return v.some((x) => x.key === key && x.lineIdx === n - 1);
  }

  isAtGlobalEnd(top: Top, rows: number): boolean {
    const last = this.keys[this.keys.length - 1];
    return last !== undefined && this.showsEndOf(top, rows, last);
  }

  /**
   * Re-anchor `top` after the content of session `key` changed:
   * keep the same (block, offset) if possible.
   */
  reanchor(top: Top, key: string, before: { block: number; offset: number } | undefined): Top {
    if (top.key !== key || !before) return top;
    const c = this.cache(key);
    if (!c) return top;
    const start = c.lineIndexOfBlock(before.block);
    const next = c.lineIndexOfBlock(before.block + 1);
    const len = Math.max(1, next - start);
    return { key, line: start + Math.min(before.offset, len - 1) };
  }

  locate(top: Top): { block: number; offset: number } | undefined {
    const c = this.cache(top.key);
    return c?.locate(top.line);
  }

  /** Drop all caches (e.g. width changed). */
  invalidateAll(): void {
    this.caches.clear();
    this.placeholders.clear();
  }

  invalidate(key: string): void {
    this.caches.delete(key);
    this.placeholders.delete(key);
  }

  totalKnownLines(): number {
    let n = 0;
    for (const k of this.keys) n += this.count(k);
    return n;
  }
}
