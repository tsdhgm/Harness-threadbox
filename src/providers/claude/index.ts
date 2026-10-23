import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Delta, Provider, ProviderOptions, SessionReader, ToolSummary, WatchEvent } from '../../core/provider.js';
import { type LiveState, type Session, type SessionIndexEntry, type SessionRef, type ToolCall, createSession } from '../../core/types.js';
import { buildIndexEntry } from './indexer.js';
import { JsonlTailer } from './jsonlTailer.js';
import { mtimeLive, readLiveRegistry } from './live.js';
import { ingest } from './normalizer.js';
import { claudeRootDir, encodeProjectPath, isSessionFile, projectsDir, realpathOr } from './paths.js';
import { parseLine } from './rawTypes.js';
import { ClaudeWatcher } from './watcher.js';
import { summarizeClaudeTool } from '../../render/toolSummary.js';

const LOAD_SLICE_BYTES = 2 * 1024 * 1024;
const YIELD_EVERY_LINES = 400;

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r));

export class ClaudeSessionReader implements SessionReader {
  private tailer: JsonlTailer;
  private sess: Session;
  private loaded = false;

  constructor(index: SessionIndexEntry) {
    this.tailer = new JsonlTailer(index.ref.path);
    this.sess = createSession({ ...index, project: { ...index.project } });
  }

  session(): Session {
    return this.sess;
  }

  /** bytes consumed so far (for append/truncate classification) */
  get offset(): number {
    return this.tailer.offset;
  }

  private ingestLines(lines: string[]): string[] {
    const changed: string[] = [];
    for (const l of lines) {
      const r = parseLine(l);
      if (!r) {
        this.sess.parse.errorCount++;
        continue;
      }
      const res = ingest(this.sess, r);
      for (const id of res.changed) changed.push(id);
    }
    this.sess.parse.offset = this.tailer.offset;
    return changed;
  }

  async load(onProgress?: (loaded: number, total: number) => void): Promise<Session> {
    this.tailer.reset();
    this.sess = createSession({ ...this.sess.index, project: { ...this.sess.index.project } });
    let total = 0;
    try {
      total = (await fs.promises.stat(this.tailer.path)).size;
    } catch {
      total = 0;
    }
    let sinceYield = 0;
    for (;;) {
      const r = await this.tailer.pull(LOAD_SLICE_BYTES);
      if (r.reset) {
        this.tailer.reset();
        continue;
      }
      if (r.lines.length === 0) break;
      // ingest in chunks, yielding so a TUI stays responsive
      for (let i = 0; i < r.lines.length; i += YIELD_EVERY_LINES) {
        this.ingestLines(r.lines.slice(i, i + YIELD_EVERY_LINES));
        sinceYield += YIELD_EVERY_LINES;
        if (sinceYield >= YIELD_EVERY_LINES) {
          sinceYield = 0;
          await yieldNow();
        }
      }
      onProgress?.(this.tailer.offset, total);
    }
    this.loaded = true;
    try {
      const st = await fs.promises.stat(this.tailer.path);
      this.sess.index.sizeBytes = st.size;
      this.sess.index.mtimeMs = st.mtimeMs;
    } catch {
      // ignore
    }
    return this.sess;
  }

  async pull(): Promise<Delta> {
    if (!this.loaded) {
      await this.load();
      return { kind: 'reset' };
    }
    const r = await this.tailer.pull();
    if (r.reset) {
      await this.load();
      return { kind: 'reset' };
    }
    if (r.lines.length === 0) return { kind: 'none' };
    const changed = this.ingestLines(r.lines);
    try {
      const st = await fs.promises.stat(this.tailer.path);
      this.sess.index.sizeBytes = st.size;
      this.sess.index.mtimeMs = st.mtimeMs;
    } catch {
      // ignore
    }
    return { kind: 'append', changedTurnIds: [...new Set(changed)] };
  }

  close(): void {
    // nothing to release (file handles are per pull)
  }
}

export class ClaudeProvider implements Provider {
  readonly id = 'claude';
  readonly name = 'Claude Code';
  private root = claudeRootDir();
  private projectFilterKey: string | undefined;
  private projectFilterPath: string | undefined;

  configure(opts: ProviderOptions): void {
    this.root = claudeRootDir(opts.rootDir);
    this.projectFilterPath = opts.projectFilter;
    this.projectFilterKey = undefined;
  }

  get rootDir(): string {
    return this.root;
  }

  private async filterKey(): Promise<string | undefined> {
    if (!this.projectFilterPath) return undefined;
    if (!this.projectFilterKey) this.projectFilterKey = encodeProjectPath(await realpathOr(this.projectFilterPath));
    return this.projectFilterKey;
  }

  async *scanIndex(): AsyncIterable<SessionIndexEntry> {
    const pdir = projectsDir(this.root);
    let dirs: fs.Dirent[] = [];
    try {
      dirs = (await fs.promises.readdir(pdir, { withFileTypes: true })).filter((d) => d.isDirectory());
    } catch {
      return;
    }
    const fk = await this.filterKey();
    const live = await readLiveRegistry(this.root);
    const now = Date.now();
    for (const d of dirs) {
      if (fk && d.name !== fk) continue;
      const dir = path.join(pdir, d.name);
      let files: fs.Dirent[] = [];
      try {
        files = (await fs.promises.readdir(dir, { withFileTypes: true })).filter((f) => f.isFile() && isSessionFile(f.name));
      } catch {
        continue;
      }
      for (const f of files) {
        const e = await buildIndexEntry(path.join(dir, f.name), d.name, { providerId: this.id });
        if (!e) continue;
        e.live = live.get(e.ref.sessionId) ?? mtimeLive(e.mtimeMs, now);
        yield e;
      }
    }
  }

  async indexOne(filePath: string): Promise<SessionIndexEntry | undefined> {
    const projectKey = path.basename(path.dirname(filePath));
    const e = await buildIndexEntry(filePath, projectKey, { providerId: this.id });
    if (!e) return undefined;
    const live = await readLiveRegistry(this.root);
    e.live = live.get(e.ref.sessionId) ?? mtimeLive(e.mtimeMs);
    return e;
  }

  open(index: SessionIndexEntry): ClaudeSessionReader {
    return new ClaudeSessionReader(index);
  }

  async liveStates(): Promise<Map<string, LiveState>> {
    return readLiveRegistry(this.root);
  }

  watch(
    handler: (ev: WatchEvent) => void,
    opts?: { liveRefs?: () => SessionRef[]; knownSize?: (p: string) => number | undefined },
  ): () => void {
    const w = new ClaudeWatcher({
      providerId: this.id,
      root: this.root,
      knownSize: opts?.knownSize ?? (() => undefined),
      liveRefs: opts?.liveRefs ?? (() => []),
      handler,
    });
    void w.start();
    return () => w.stop();
  }

  async resolveArg(arg: string, index: SessionIndexEntry[]): Promise<SessionIndexEntry | undefined> {
    if (arg === 'latest') {
      return [...index].sort((a, b) => (b.updatedAt ?? b.mtimeMs) - (a.updatedAt ?? a.mtimeMs))[0];
    }
    if (arg === 'live') {
      const live = index.filter((e) => e.live);
      return live.sort((a, b) => (b.updatedAt ?? b.mtimeMs) - (a.updatedAt ?? a.mtimeMs))[0];
    }
    if (arg.endsWith('.jsonl') || arg.includes('/') || arg.includes('\\') || path.isAbsolute(arg)) {
      const p = path.resolve(arg);
      try {
        await fs.promises.access(p);
        const found = index.find((e) => e.ref.path === p);
        return found ?? (await this.indexOne(p));
      } catch {
        return undefined;
      }
    }
    const exact = index.find((e) => e.ref.sessionId === arg);
    if (exact) return exact;
    const matches = index.filter((e) => e.ref.sessionId.startsWith(arg));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`ambiguous session id prefix "${arg}":\n${matches.map((m) => `  ${m.ref.sessionId}  ${m.title ?? m.firstPrompt ?? ''}`).join('\n')}`);
    }
    return undefined;
  }

  summarizeTool(call: ToolCall, cwd: string): ToolSummary | undefined {
    return summarizeClaudeTool(call, cwd);
  }
}
