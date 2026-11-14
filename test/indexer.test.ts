import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIndexEntry } from '../src/providers/claude/indexer.js';
import { aiTitle, assistant, basicRecords, human, marker, text, tmpDir, toJsonl } from './helpers.js';

describe('indexer', () => {
  it('extracts cwd, prompt, timestamps and the LAST ai-title from a small file', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'sess-0001.jsonl');
    fs.writeFileSync(f, toJsonl(basicRecords()));
    const e = (await buildIndexEntry(f, '-work-proj', { providerId: 'claude' }))!;
    expect(e.ref.sessionId).toBe('sess-0001');
    expect(e.project.cwd).toBe('/work/proj');
    expect(e.project.name).toBe('proj');
    expect(e.title).toBe('Check remote progress');
    expect(e.firstPrompt).toBe('Check the remote. I forgot how far we got');
    expect(e.startedAt).toBeLessThan(e.updatedAt!);
    expect(e.gitBranch).toBe('main');
    expect(e.model).toBe('claude-fable-5-1');
  });

  it('finds a title that only exists in the tail of a large file', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'sess-0001.jsonl');
    const big = 'x'.repeat(100_000);
    const recs: unknown[] = [...marker(), human(0, 'first prompt'), aiTitle('early')];
    for (let i = 0; i < 12; i++) recs.push(...assistant(i + 1, `msg_${i}`, [text(big)]));
    recs.push(aiTitle('late title'));
    fs.writeFileSync(f, toJsonl(recs));
    expect(fs.statSync(f).size).toBeGreaterThan(1_000_000);
    const e = (await buildIndexEntry(f, '-work-proj', { providerId: 'claude' }))!;
    expect(e.title).toBe('late title');
    expect(e.firstPrompt).toBe('first prompt');
  });

  it('falls back to a head title when the tail has none', async () => {
    const dir = tmpDir();
    const f = path.join(dir, 'sess-0001.jsonl');
    const big = 'x'.repeat(100_000);
    const recs: unknown[] = [...marker(), human(0, 'p'), aiTitle('head only')];
    for (let i = 0; i < 20; i++) recs.push(...assistant(i + 1, `msg_${i}`, [text(big)]));
    fs.writeFileSync(f, toJsonl(recs));
    const e = (await buildIndexEntry(f, '-work-proj', { providerId: 'claude' }))!;
    expect(e.title).toBe('head only');
  });
});
