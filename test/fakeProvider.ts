import type { Delta, LiveState, Provider, ProviderOptions, SessionReader, WatchEvent } from '../src/core/provider.js';
import { type Session, type SessionIndexEntry, createSession } from '../src/core/types.js';
import { ingest } from '../src/providers/claude/normalizer.js';
import { parseLine } from '../src/providers/claude/rawTypes.js';

/** In-memory provider for Document/App tests. Sessions are JSONL strings that can be appended. */
export class FakeProvider implements Provider {
  readonly id = 'claude';
  readonly name = 'fake';
  sessions = new Map<string, { entry: SessionIndexEntry; lines: string[]; consumed: number }>();
  handlers: Array<(ev: WatchEvent) => void> = [];

  add(sessionId: string, project: string, jsonl: string, opts: { live?: boolean; startedAt?: number } = {}): SessionIndexEntry {
    const entry: SessionIndexEntry = {
      ref: { provider: 'claude', sessionId, path: `/fake/${project}/${sessionId}.jsonl`, projectKey: project },
      project: { key: project, cwd: `/work/${project}`, name: project },
      title: `title ${sessionId}`,
      startedAt: opts.startedAt ?? Date.parse('2026-10-24T00:00:00Z') + this.sessions.size * 3600_000,
      updatedAt: opts.startedAt ?? Date.parse('2026-10-24T00:00:00Z') + this.sessions.size * 3600_000,
      mtimeMs: Date.now(),
      sizeBytes: jsonl.length,
      live: opts.live ? { pid: 1, status: 'busy', source: 'registry' } : null,
    };
    this.sessions.set(sessionId, { entry, lines: jsonl.split('\n').filter(Boolean), consumed: 0 });
    return entry;
  }

  append(sessionId: string, jsonl: string): void {
    const s = this.sessions.get(sessionId)!;
    s.lines.push(...jsonl.split('\n').filter(Boolean));
    s.entry.sizeBytes += jsonl.length;
    for (const h of this.handlers) h({ kind: 'session-appended', ref: s.entry.ref });
  }

  configure(_opts: ProviderOptions): void {}
  async *scanIndex(): AsyncIterable<SessionIndexEntry> {
    for (const s of this.sessions.values()) yield s.entry;
  }
  async indexOne(p: string): Promise<SessionIndexEntry | undefined> {
    for (const s of this.sessions.values()) if (s.entry.ref.path === p) return s.entry;
    return undefined;
  }
  open(index: SessionIndexEntry): SessionReader {
    const store = this.sessions.get(index.ref.sessionId)!;
    let sess = createSession({ ...index, project: { ...index.project } });
    let consumed = 0;
    const ingestLines = (lines: string[]): string[] => {
      const changed: string[] = [];
      for (const l of lines) {
        const r = parseLine(l);
        if (r) changed.push(...ingest(sess, r).changed);
      }
      return changed;
    };
    return {
      async load(): Promise<Session> {
        sess = createSession({ ...index, project: { ...index.project } });
        consumed = 0;
        ingestLines(store.lines);
        consumed = store.lines.length;
        await new Promise((r) => setTimeout(r, 5));
        return sess;
      },
      async pull(): Promise<Delta> {
        if (consumed >= store.lines.length) return { kind: 'none' };
        const changed = ingestLines(store.lines.slice(consumed));
        consumed = store.lines.length;
        return { kind: 'append', changedTurnIds: [...new Set(changed)] };
      },
      session: () => sess,
      close(): void {},
    };
  }
  async liveStates(): Promise<Map<string, LiveState>> {
    const m = new Map<string, LiveState>();
    for (const s of this.sessions.values()) if (s.entry.live) m.set(s.entry.ref.sessionId, s.entry.live);
    return m;
  }
  watch(handler: (ev: WatchEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
  async resolveArg(arg: string, index: SessionIndexEntry[]): Promise<SessionIndexEntry | undefined> {
    return index.find((e) => e.ref.sessionId === arg);
  }
}
