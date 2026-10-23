import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSession, type Session, type SessionIndexEntry } from '../src/core/types.js';
import { ingest } from '../src/providers/claude/normalizer.js';
import { parseLine } from '../src/providers/claude/rawTypes.js';

let seq = 0;
export const uid = (): string => `uuid-${String(++seq).padStart(4, '0')}`;
const T0 = Date.parse('2026-10-24T01:00:00.000Z');
export const ts = (i: number): string => new Date(T0 + i * 1000).toISOString();

const common = (i: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  uuid: uid(),
  parentUuid: null,
  isSidechain: false,
  sessionId: 'sess-0001',
  timestamp: ts(i),
  cwd: '/work/proj',
  version: '2.1.300',
  gitBranch: 'main',
  userType: 'external',
  ...extra,
});

export const marker = (): Record<string, unknown>[] => [
  { type: 'mode', mode: 'normal', sessionId: 'sess-0001' },
  { type: 'permission-mode', permissionMode: 'auto', sessionId: 'sess-0001' },
  { type: 'atis-latch', atis: '', sessionId: 'sess-0001' },
];

export const human = (i: number, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  common(i, { type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' }, promptSource: 'typed', ...extra });

export const userBlocks = (i: number, blocks: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> =>
  common(i, { type: 'user', message: { role: 'user', content: blocks }, ...extra });

export const toolResult = (
  i: number,
  toolUseId: string,
  content: unknown,
  opts: { isError?: boolean; structured?: unknown } = {},
): Record<string, unknown> =>
  common(i, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: opts.isError ?? false }] },
    toolUseResult: opts.structured,
  });

/** One record per content block, sharing message.id (as Claude Code writes them). */
export const assistant = (i: number, messageId: string, blocks: unknown[], opts: { model?: string; usage?: unknown } = {}): Record<string, unknown>[] =>
  blocks.map((b, k) =>
    common(i, {
      type: 'assistant',
      requestId: `req_${messageId}`,
      apiBlockIndex: k,
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: opts.model ?? 'claude-fable-5-1',
        content: [b],
        stop_reason: k === blocks.length - 1 ? 'end_turn' : null,
        usage: opts.usage ?? { input_tokens: 10, output_tokens: 20 },
      },
    }),
  );

export const text = (t: string): unknown => ({ type: 'text', text: t });
export const thinking = (t = ''): unknown => ({ type: 'thinking', thinking: t, signature: 'sig' });
export const toolUse = (id: string, name: string, input: unknown): unknown => ({ type: 'tool_use', id, name, input });
export const aiTitle = (t: string): Record<string, unknown> => ({ type: 'ai-title', aiTitle: t, sessionId: 'sess-0001' });
export const system = (i: number, subtype: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  common(i, { type: 'system', subtype, isMeta: false, ...extra });
export const attachment = (i: number, type: string): Record<string, unknown> =>
  common(i, { type: 'attachment', attachment: { type }, rendered: [{ content: '<system-reminder>x</system-reminder>' }], renderedRole: 'system' });

export const toJsonl = (records: unknown[]): string => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

export function indexEntry(filePath = '/work/sess-0001.jsonl', live = false): SessionIndexEntry {
  return {
    ref: { provider: 'claude', sessionId: 'sess-0001', path: filePath, projectKey: '-work-proj' },
    project: { key: '-work-proj', cwd: '/work/proj', name: 'proj' },
    mtimeMs: Date.now(),
    sizeBytes: 0,
    live: live ? { pid: 1, status: 'busy', source: 'registry' } : null,
  };
}

export function sessionFrom(records: unknown[], live = false): Session {
  const s = createSession(indexEntry('/work/sess-0001.jsonl', live));
  for (const r of records) {
    const raw = parseLine(JSON.stringify(r));
    if (raw) ingest(s, raw);
    else s.parse.errorCount++;
  }
  return s;
}

export function sessionFromJsonl(jsonl: string, live = false): Session {
  const s = createSession(indexEntry('/work/sess-0001.jsonl', live));
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    const raw = parseLine(line);
    if (raw) ingest(s, raw);
    else s.parse.errorCount++;
  }
  return s;
}

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hthreadbox-test-'));
}

export function fixture(name: string): string {
  return fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
}

/** A basic conversation: prompt, thinking+text+tool_use chunks, result, final text, duration, titles. */
export function basicRecords(): Record<string, unknown>[] {
  return [
    ...marker(),
    human(0, 'remote を確認して。どこまで進んだか忘れた'),
    ...assistant(1, 'msg_001', [thinking(''), text('確認します。'), toolUse('toolu_01', 'Bash', { command: 'git status --short', description: 'Show status' })]),
    toolResult(2, 'toolu_01', ' M src/a.ts\n?? new.txt\n', { structured: { stdout: ' M src/a.ts\n?? new.txt\n', stderr: '', interrupted: false } }),
    ...assistant(3, 'msg_002', [text('変更が 2 件あります。\n\n- `src/a.ts` が修正済み\n- `new.txt` が未追跡')]),
    system(4, 'turn_duration', { durationMs: 1234, messageCount: 5 }),
    aiTitle('first title'),
    aiTitle('Remote の進捗確認'),
    { type: 'last-prompt', lastPrompt: 'remote', leafUuid: 'x', sessionId: 'sess-0001' },
    ...marker(),
  ];
}
