import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LiveState } from '../../core/types.js';
import { sessionsRegistryDir } from './paths.js';

interface RegistryEntry {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number | string;
  status?: string;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read ~/.claude/sessions/<pid>.json files and return live states for running sessions. */
export async function readLiveRegistry(root: string): Promise<Map<string, LiveState>> {
  const out = new Map<string, LiveState>();
  const dir = sessionsRegistryDir(root);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(dir, name), 'utf8');
      const e = JSON.parse(raw) as RegistryEntry;
      const pid = typeof e.pid === 'number' ? e.pid : Number(name.replace(/\.json$/, ''));
      if (!e.sessionId || !pidAlive(pid)) continue;
      const status: LiveState['status'] = e.status === 'busy' || e.status === 'idle' ? e.status : 'unknown';
      const ls: LiveState = { pid, status, source: 'registry' };
      const st = typeof e.startedAt === 'string' ? Date.parse(e.startedAt) : e.startedAt;
      if (typeof st === 'number' && Number.isFinite(st)) ls.startedAt = st;
      out.set(e.sessionId, ls);
    } catch {
      // ignore malformed entries
    }
  }
  return out;
}

export const MTIME_LIVE_WINDOW_MS = 60_000;

export function mtimeLive(mtimeMs: number, now = Date.now()): LiveState | null {
  if (now - mtimeMs < MTIME_LIVE_WINDOW_MS) return { pid: 0, status: 'unknown', source: 'mtime' };
  return null;
}
