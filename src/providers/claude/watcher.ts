import * as fs from 'node:fs';
import * as path from 'node:path';
import type { WatchEvent } from '../../core/provider.js';
import type { SessionRef } from '../../core/types.js';
import { isSessionFile, projectsDir, sessionIdFromFile, sessionsRegistryDir } from './paths.js';

const DEBOUNCE_MS = 200;
const LIVE_POLL_MS = 2000;
const REGISTRY_POLL_MS = 5000;

export interface WatcherDeps {
  providerId: string;
  root: string;
  /** which files are known and their last seen size (for append/truncate classification) */
  knownSize: (filePath: string) => number | undefined;
  /** refs of sessions considered live (polled as a safety net) */
  liveRefs: () => SessionRef[];
  handler: (ev: WatchEvent) => void;
}

/**
 * Non-recursive fs.watch on projects/ (new project dirs) and on each project dir,
 * plus stat polling of live files. Events are classified by stat, never by name.
 */
export class ClaudeWatcher {
  private rootWatcher?: fs.FSWatcher;
  private registryWatcher?: fs.FSWatcher;
  private dirWatchers = new Map<string, fs.FSWatcher>();
  private timers = new Map<string, NodeJS.Timeout>();
  private livePoll?: NodeJS.Timeout;
  private registryPoll?: NodeJS.Timeout;
  private stopped = false;

  constructor(private deps: WatcherDeps) {}

  async start(): Promise<void> {
    const pdir = projectsDir(this.deps.root);
    try {
      this.rootWatcher = fs.watch(pdir, { persistent: false }, () => void this.refreshDirs());
      this.rootWatcher.on('error', (e) => this.deps.handler({ kind: 'error', message: `watch ${pdir}: ${String(e)}` }));
    } catch (e) {
      this.deps.handler({ kind: 'error', message: `cannot watch ${pdir}: ${String(e)}` });
    }
    await this.refreshDirs();
    const rdir = sessionsRegistryDir(this.deps.root);
    try {
      this.registryWatcher = fs.watch(rdir, { persistent: false }, () => this.scheduleLive());
      this.registryWatcher.on('error', () => undefined);
    } catch {
      // registry dir may not exist yet
    }
    this.livePoll = setInterval(() => void this.pollLive(), LIVE_POLL_MS);
    this.livePoll.unref();
    this.registryPoll = setInterval(() => this.deps.handler({ kind: 'live-changed' }), REGISTRY_POLL_MS);
    this.registryPoll.unref();
  }

  stop(): void {
    this.stopped = true;
    this.rootWatcher?.close();
    this.registryWatcher?.close();
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.livePoll) clearInterval(this.livePoll);
    if (this.registryPoll) clearInterval(this.registryPoll);
  }

  private liveTimer?: NodeJS.Timeout;
  private scheduleLive(): void {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => this.deps.handler({ kind: 'live-changed' }), 300);
  }

  private async refreshDirs(): Promise<void> {
    if (this.stopped) return;
    const pdir = projectsDir(this.deps.root);
    let names: string[] = [];
    try {
      names = (await fs.promises.readdir(pdir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return;
    }
    const seen = new Set<string>();
    let added = false;
    for (const n of names) {
      const dir = path.join(pdir, n);
      seen.add(dir);
      if (this.dirWatchers.has(dir)) continue;
      try {
        const w = fs.watch(dir, { persistent: false }, (_ev, fname) => {
          if (!fname) return;
          const name = fname.toString();
          if (!isSessionFile(name)) return;
          this.schedule(path.join(dir, name), n);
        });
        w.on('error', () => undefined);
        this.dirWatchers.set(dir, w);
        added = true;
      } catch {
        // ignore
      }
    }
    for (const [dir, w] of this.dirWatchers) {
      if (!seen.has(dir)) {
        w.close();
        this.dirWatchers.delete(dir);
      }
    }
    if (added) this.deps.handler({ kind: 'index-changed' });
  }

  private schedule(filePath: string, projectKey: string): void {
    const t = this.timers.get(filePath);
    if (t) clearTimeout(t);
    this.timers.set(
      filePath,
      setTimeout(() => {
        this.timers.delete(filePath);
        void this.check(filePath, projectKey);
      }, DEBOUNCE_MS),
    );
  }

  private ref(filePath: string, projectKey: string): SessionRef {
    return { provider: this.deps.providerId, sessionId: sessionIdFromFile(filePath), path: filePath, projectKey };
  }

  private async check(filePath: string, projectKey: string): Promise<void> {
    if (this.stopped) return;
    const ref = this.ref(filePath, projectKey);
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(filePath);
    } catch {
      if (this.deps.knownSize(filePath) !== undefined) this.deps.handler({ kind: 'session-removed', ref });
      return;
    }
    const known = this.deps.knownSize(filePath);
    if (known === undefined) {
      this.deps.handler({ kind: 'index-changed' });
      return;
    }
    if (st.size < known) this.deps.handler({ kind: 'session-truncated', ref });
    else if (st.size > known) this.deps.handler({ kind: 'session-appended', ref });
  }

  private async pollLive(): Promise<void> {
    if (this.stopped) return;
    for (const ref of this.deps.liveRefs()) {
      try {
        const st = await fs.promises.stat(ref.path);
        const known = this.deps.knownSize(ref.path);
        if (known === undefined) continue;
        if (st.size > known) this.deps.handler({ kind: 'session-appended', ref });
        else if (st.size < known) this.deps.handler({ kind: 'session-truncated', ref });
      } catch {
        // ignore
      }
    }
  }
}
