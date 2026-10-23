import type { LiveState, Session, SessionIndexEntry, SessionRef, ToolCall } from './types.js';

export type Delta =
  | { kind: 'append'; changedTurnIds: string[] }
  | { kind: 'reset' }
  | { kind: 'none' };

export interface SessionReader {
  /** Full load from the beginning. Yields to the event loop periodically. */
  load(onProgress?: (loadedBytes: number, totalBytes: number) => void): Promise<Session>;
  /** Pull appended data. Must be called after load(). */
  pull(): Promise<Delta>;
  session(): Session;
  close(): void;
}

export type WatchEvent =
  | { kind: 'index-changed'; entries?: SessionIndexEntry[] }
  | { kind: 'session-appended'; ref: SessionRef }
  | { kind: 'session-truncated'; ref: SessionRef }
  | { kind: 'session-removed'; ref: SessionRef }
  | { kind: 'live-changed' }
  | { kind: 'error'; message: string };

export interface ToolSummary {
  /** e.g. "Bash" / "Update" */
  verb: string;
  /** e.g. the command, the path */
  arg: string;
  /** optional dim suffix, e.g. "[Explore]" */
  tag?: string;
}

export interface ProviderOptions {
  rootDir?: string;
  /** only include sessions whose project matches this path (realpath'd) */
  projectFilter?: string;
}

export interface Provider {
  readonly id: string;
  readonly name: string;
  configure(opts: ProviderOptions): void;
  /** Cheap scan: head/tail reads only. */
  scanIndex(): AsyncIterable<SessionIndexEntry>;
  indexOne(path: string): Promise<SessionIndexEntry | undefined>;
  open(index: SessionIndexEntry): SessionReader;
  liveStates(): Promise<Map<string, LiveState>>;
  /** Start watching; returns a stop function. */
  watch(handler: (ev: WatchEvent) => void, opts?: { liveRefs?: () => SessionRef[] }): () => void;
  /** Resolve a CLI argument (id / prefix / path) to an index entry. */
  resolveArg(arg: string, index: SessionIndexEntry[]): Promise<SessionIndexEntry | undefined>;
  summarizeTool?(call: ToolCall, cwd: string): ToolSummary | undefined;
}

export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  register(p: Provider): void {
    this.providers.set(p.id, p);
  }
  get(id: string): Provider | undefined {
    return this.providers.get(id);
  }
  all(): Provider[] {
    return [...this.providers.values()];
  }
}
