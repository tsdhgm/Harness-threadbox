import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionIndexEntry } from '../../core/types.js';
import { readLinesInRange } from './jsonlTailer.js';
import { isAiTitleRecord, isUserRecord, parseLine, parseTs } from './rawTypes.js';
import { sessionIdFromFile } from './paths.js';
import { humanPromptText } from './normalizer.js';

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const TAIL_RETRY_BYTES = 1024 * 1024;

export interface IndexerOptions {
  providerId: string;
}

/**
 * Build an index entry from head + tail reads only. Never parses the whole file.
 */
export async function buildIndexEntry(
  filePath: string,
  projectKey: string,
  opts: IndexerOptions,
): Promise<SessionIndexEntry | undefined> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(filePath);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return undefined;
  const sessionId = sessionIdFromFile(filePath);

  const headEnd = Math.min(st.size, HEAD_BYTES);
  const headLines = await readLinesInRange(filePath, 0, headEnd, { dropFirstPartial: false });

  let cwd = '';
  let startedAt: number | undefined;
  let gitBranch: string | undefined;
  let version: string | undefined;
  let model: string | undefined;
  let firstPrompt: string | undefined;
  let title: string | undefined;
  let updatedAt: number | undefined;

  const scanCommon = (line: string, mode: 'head' | 'tail'): void => {
    const r = parseLine(line);
    if (!r) return;
    const ts = parseTs(r.timestamp);
    if (ts !== undefined) {
      if (mode === 'head' && startedAt === undefined) startedAt = ts;
      if (updatedAt === undefined || ts > updatedAt) updatedAt = ts;
    }
    if (!cwd && typeof r.cwd === 'string') cwd = r.cwd;
    if (!gitBranch && typeof r.gitBranch === 'string' && r.gitBranch) gitBranch = r.gitBranch;
    if (!version && typeof r.version === 'string') version = r.version;
    if (isAiTitleRecord(r)) title = r.aiTitle; // last wins (file order)
    if (!model && r.type === 'assistant') {
      const m = (r as { message?: { model?: unknown } }).message?.model;
      if (typeof m === 'string' && m && !m.startsWith('<')) model = m;
    }
    if (!firstPrompt && isUserRecord(r) && r.isSidechain !== true && r.isMeta !== true) {
      const t = humanPromptText(r);
      if (t) firstPrompt = t;
    }
  };

  for (const l of headLines) scanCommon(l, 'head');

  if (st.size > headEnd) {
    const tailStart = Math.max(headEnd, st.size - TAIL_BYTES);
    const tailLines = await readLinesInRange(filePath, tailStart, st.size, { dropFirstPartial: tailStart > 0 });
    const headTitle = title;
    title = undefined;
    for (const l of tailLines) scanCommon(l, 'tail');
    if (title === undefined && st.size - tailStart < st.size) {
      // one deeper look for ai-title (max line seen ~140KB)
      const deepStart = Math.max(headEnd, st.size - TAIL_RETRY_BYTES);
      if (deepStart < tailStart) {
        const deepLines = await readLinesInRange(filePath, deepStart, tailStart, { dropFirstPartial: true });
        for (const l of deepLines) {
          const r = parseLine(l);
          if (r && isAiTitleRecord(r)) title = r.aiTitle;
        }
      }
    }
    if (title === undefined) title = headTitle;
  }

  const projectName = cwd ? path.basename(cwd) || cwd : projectKey;
  const entry: SessionIndexEntry = {
    ref: { provider: opts.providerId, sessionId, path: filePath, projectKey },
    project: { key: projectKey, cwd, name: projectName },
    mtimeMs: st.mtimeMs,
    sizeBytes: st.size,
    live: null,
  };
  if (title) entry.title = title.trim();
  if (firstPrompt) entry.firstPrompt = firstPrompt;
  if (startedAt !== undefined) entry.startedAt = startedAt;
  if (updatedAt !== undefined) entry.updatedAt = updatedAt;
  else entry.updatedAt = st.mtimeMs;
  if (gitBranch) entry.gitBranch = gitBranch;
  if (version) entry.version = version;
  if (model) entry.model = model;
  return entry;
}
