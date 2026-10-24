import { Emitter } from './emitter.js';
import { Lru } from './lru.js';
import type { Provider, SessionReader, WatchEvent } from './provider.js';
import type { Session, SessionIndexEntry, SessionRef } from './types.js';

export type StoreEvent =
  | { kind: 'index' }
  | { kind: 'session'; key: string; changedTurnIds: string[]; reset: boolean }
  | { kind: 'live' }
  | { kind: 'loaded'; key: string }
  | { kind: 'error'; message: string };

export interface ProjectGroup {
  key: string;
  name: string;
  cwd: string;
  lastActivity: number;
  sessions: SessionIndexEntry[];
}

export function refKey(ref: SessionRef): string {
  return `${ref.provider}:${ref.sessionId}`;
}

/** Key of the project group an entry belongs to (matches ProjectGroup.key). */
/** Timestamp of the last activity of a session — the one shown in the lists and used for ordering. */
export function activityOf(e: SessionIndexEntry): number {
  return e.updatedAt ?? e.mtimeMs;
}

export function groupKeyOf(e: SessionIndexEntry): string {
  return `${e.ref.provider}:${e.project.key}`;
}

interface Loaded {
  reader: SessionReader & { offset?: number };
  session: Session;
}

/**
 * Provider-agnostic registry of sessions: index entries, document ordering,
 * LRU of loaded sessions, and change events.
 */
export class SessionStore {
  readonly events = new Emitter<StoreEvent>();
  private entries = new Map<string, SessionIndexEntry>();
  private loaded: Lru<string, Loaded>;
  private loading = new Map<string, Promise<Session>>();
  private stops: Array<() => void> = [];
  private orderCache: SessionIndexEntry[] | undefined;
  private protectedKeys = new Set<string>();

  constructor(
    private providers: Provider[],
    opts: { lruSize?: number } = {},
  ) {
    this.loaded = new Lru<string, Loaded>(opts.lruSize ?? 6, (_k, v) => v.reader.close());
  }

  async scan(): Promise<void> {
    const fresh = new Map<string, SessionIndexEntry>();
    for (const p of this.providers) {
      for await (const e of p.scanIndex()) {
        const k = refKey(e.ref);
        const loaded = this.loaded.peek(k);
        if (loaded) {
          // keep the loaded session's (fresher) index, but refresh live & stat
          loaded.session.index.live = e.live;
          loaded.session.index.mtimeMs = e.mtimeMs;
          loaded.session.index.sizeBytes = e.sizeBytes;
          fresh.set(k, loaded.session.index);
        } else fresh.set(k, e);
      }
    }
    this.entries = fresh;
    this.orderCache = undefined;
    this.events.emit({ kind: 'index' });
  }

  startWatching(): void {
    for (const p of this.providers) {
      const stop = p.watch((ev) => void this.onWatch(p, ev), {
        liveRefs: () => this.order().filter((e) => e.live).map((e) => e.ref),
        knownSize: (filePath: string) => {
          for (const e of this.entries.values()) {
            if (e.ref.path === filePath) {
              const l = this.loaded.peek(refKey(e.ref));
              return l?.reader.offset ?? e.sizeBytes;
            }
          }
          return undefined;
        },
      } as never);
      this.stops.push(stop);
    }
  }

  stop(): void {
    for (const s of this.stops) s();
    this.stops = [];
  }

  private async onWatch(p: Provider, ev: WatchEvent): Promise<void> {
    switch (ev.kind) {
      case 'index-changed':
        await this.rescanProvider(p);
        break;
      case 'session-appended': {
        const k = refKey(ev.ref);
        const l = this.loaded.peek(k);
        if (l) {
          const d = await l.reader.pull();
          if (d.kind === 'append') {
            this.entries.set(k, l.session.index);
            this.orderCache = undefined;
            this.events.emit({ kind: 'session', key: k, changedTurnIds: d.changedTurnIds, reset: false });
            this.events.emit({ kind: 'index' });
          } else if (d.kind === 'reset') {
            this.events.emit({ kind: 'session', key: k, changedTurnIds: [], reset: true });
          }
        } else {
          const e = await p.indexOne(ev.ref.path);
          if (e) {
            this.entries.set(k, e);
            this.orderCache = undefined;
            this.events.emit({ kind: 'index' });
          }
        }
        break;
      }
      case 'session-truncated': {
        const k = refKey(ev.ref);
        const l = this.loaded.peek(k);
        if (l) {
          await l.reader.load();
          this.events.emit({ kind: 'session', key: k, changedTurnIds: [], reset: true });
        } else {
          const e = await p.indexOne(ev.ref.path);
          if (e) this.entries.set(k, e);
        }
        this.orderCache = undefined;
        this.events.emit({ kind: 'index' });
        break;
      }
      case 'session-removed': {
        const k = refKey(ev.ref);
        this.entries.delete(k);
        this.loaded.delete(k);
        this.orderCache = undefined;
        this.events.emit({ kind: 'index' });
        break;
      }
      case 'live-changed':
        await this.refreshLive();
        break;
      case 'error':
        this.events.emit({ kind: 'error', message: ev.message });
        break;
    }
  }

  private async rescanProvider(p: Provider): Promise<void> {
    const seen = new Set<string>();
    let changed = false;
    for await (const e of p.scanIndex()) {
      const k = refKey(e.ref);
      seen.add(k);
      const cur = this.entries.get(k);
      if (!cur) {
        this.entries.set(k, e);
        changed = true;
      } else if (!this.loaded.has(k) && (cur.sizeBytes !== e.sizeBytes || cur.title !== e.title)) {
        this.entries.set(k, e);
        changed = true;
      }
    }
    for (const k of [...this.entries.keys()]) {
      if (this.entries.get(k)!.ref.provider === p.id && !seen.has(k)) {
        this.entries.delete(k);
        this.loaded.delete(k);
        changed = true;
      }
    }
    if (changed) {
      this.orderCache = undefined;
      this.events.emit({ kind: 'index' });
    }
  }

  async refreshLive(): Promise<void> {
    let changed = false;
    const now = Date.now();
    for (const p of this.providers) {
      const live = await p.liveStates();
      for (const e of this.entries.values()) {
        if (e.ref.provider !== p.id) continue;
        const next = live.get(e.ref.sessionId) ?? (now - e.mtimeMs < 60_000 ? { pid: 0, status: 'unknown' as const, source: 'mtime' as const } : null);
        const a = JSON.stringify(e.live);
        const b = JSON.stringify(next);
        if (a !== b) {
          e.live = next;
          changed = true;
        }
      }
    }
    if (changed) this.events.emit({ kind: 'live' });
  }

  /** All entries in document order: projects by last activity asc, sessions by last activity asc. */
  order(): SessionIndexEntry[] {
    if (this.orderCache) return this.orderCache;
    const groups = this.groups();
    this.orderCache = groups.flatMap((g) => g.sessions);
    return this.orderCache;
  }

  groups(): ProjectGroup[] {
    const map = new Map<string, ProjectGroup>();
    for (const e of this.entries.values()) {
      const gk = groupKeyOf(e);
      let g = map.get(gk);
      if (!g) {
        g = { key: gk, name: e.project.name, cwd: e.project.cwd, lastActivity: 0, sessions: [] };
        map.set(gk, g);
      }
      if (!g.cwd && e.project.cwd) {
        g.cwd = e.project.cwd;
        g.name = e.project.name;
      }
      g.sessions.push(e);
      g.lastActivity = Math.max(g.lastActivity, activityOf(e));
    }
    const groups = [...map.values()];
    // Sessions sort by the same timestamp the list displays (last activity), so a session
    // resumed with `claude --resume` moves below the ones it was started before and the
    // right pane never scrolls "down" into an older transcript.
    for (const g of groups) g.sessions.sort((a, b) => activityOf(a) - activityOf(b) || (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.ref.sessionId.localeCompare(b.ref.sessionId));
    groups.sort((a, b) => a.lastActivity - b.lastActivity || a.key.localeCompare(b.key));
    return groups;
  }

  get(key: string): SessionIndexEntry | undefined {
    return this.entries.get(key);
  }

  entryList(): SessionIndexEntry[] {
    return [...this.entries.values()];
  }

  provider(id: string): Provider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  isLoaded(key: string): boolean {
    return this.loaded.has(key);
  }

  loadedSession(key: string): Session | undefined {
    return this.loaded.get(key)?.session;
  }

  peekSession(key: string): Session | undefined {
    return this.loaded.peek(key)?.session;
  }

  /** Keys that must not be evicted (e.g. currently visible). */
  protect(keys: Iterable<string>): void {
    this.protectedKeys = new Set(keys);
  }

  /** Load (or return) a session. Concurrent calls share one load. */
  load(entry: SessionIndexEntry): Promise<Session> {
    const k = refKey(entry.ref);
    const have = this.loaded.get(k);
    if (have) return Promise.resolve(have.session);
    const inflight = this.loading.get(k);
    if (inflight) return inflight;
    const p = this.provider(entry.ref.provider);
    if (!p) return Promise.reject(new Error(`no provider ${entry.ref.provider}`));
    const reader = p.open(entry);
    const prom = reader
      .load()
      .then((session) => {
        this.loading.delete(k);
        this.loaded.set(k, { reader, session }, (key) => this.protectedKeys.has(key));
        this.entries.set(k, session.index);
        this.orderCache = undefined;
        this.events.emit({ kind: 'loaded', key: k });
        return session;
      })
      .catch((err) => {
        this.loading.delete(k);
        throw err;
      });
    this.loading.set(k, prom);
    return prom;
  }

  isLoading(key: string): boolean {
    return this.loading.has(key);
  }
}
