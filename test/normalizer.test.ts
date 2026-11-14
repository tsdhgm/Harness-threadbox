import { describe, expect, it } from 'vitest';
import { basicRecords, fixture, sessionFrom, sessionFromJsonl } from './helpers.js';
import { isToolOnlyTurn } from '../src/providers/claude/normalizer.js';

describe('normalizer', () => {
  it('merges assistant chunks by message.id and pairs tool results', () => {
    const s = sessionFrom(basicRecords());
    const visible = s.turns.filter((t) => !t.meta.hidden);
    // user, assistant(msg_001), assistant(msg_002) — turn_duration attaches, markers dropped
    expect(visible.map((t) => t.role)).toEqual(['user', 'assistant', 'assistant']);
    const a1 = visible[1]!;
    expect(a1.messageId).toBe('msg_001');
    expect(a1.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool_call']);
    const call = a1.blocks[2]!;
    if (call.kind !== 'tool_call') throw new Error('expected tool_call');
    expect(call.call.status).toBe('ok');
    expect(call.call.result?.text).toContain('src/a.ts');
    expect((call.call.structured as { stdout: string }).stdout).toContain('new.txt');
    // usage counted once (last chunk wins), not summed
    expect(a1.meta.usage?.outputTokens).toBe(20);
    expect(visible[2]!.meta.durationMs).toBe(1234);
    expect(s.index.title).toBe('Check remote progress');
    expect(s.parse.skippedTypes.get('mode')).toBe(2);
    expect(s.parse.skippedTypes.get('last-prompt')).toBe(1);
  });

  it('ignores duplicate uuids', () => {
    const recs = basicRecords();
    const s = sessionFrom([...recs, ...recs]);
    expect(s.turns.filter((t) => !t.meta.hidden)).toHaveLength(3);
  });

  it('handles noise: attachments, meta, task notifications, unknown types, malformed lines, CRLF', () => {
    const s = sessionFromJsonl(fixture('noise.jsonl'));
    expect(s.parse.errorCount).toBe(1); // "{not json"
    expect(s.parse.skippedTypes.get('attachment')).toBe(1);
    expect(s.parse.skippedTypes.get('future-thing')).toBe(1);
    expect(s.parse.skippedTypes.get('api-request-blob')).toBe(1);
    const kinds = s.turns.map((t) => `${t.role}:${t.meta.hidden ? 'hidden' : 'shown'}:${t.blocks[0]?.kind}`);
    expect(kinds).toEqual(['user:shown:text', 'user:hidden:text', 'system:shown:notice', 'assistant:shown:text']);
    const first = s.turns[0]!.blocks[0]!;
    expect(first.kind === 'text' && first.text).toBe('the actual question');
    const notice = s.turns[2]!.blocks[0]!;
    expect(notice.kind === 'notice' && notice.text).toBe('task abc12345 completed: done it');
  });

  it('handles slash commands, interrupts, compaction, images and orphan results', () => {
    const s = sessionFromJsonl(fixture('misc.jsonl'));
    const cmd = s.turns[0]!.blocks[0]!;
    expect(cmd.kind).toBe('command');
    if (cmd.kind === 'command') {
      expect(cmd.name).toBe('/init');
      expect(cmd.args).toBe('--force');
      expect(cmd.stdout).toBe('Initialized.');
    }
    expect(s.turns[1]!.blocks[0]!.kind).toBe('thinking');
    expect(s.turns[2]!.blocks[0]!.kind).toBe('interrupted');
    const compact = s.turns[3]!;
    expect(compact.role).toBe('system');
    expect(compact.meta.hidden).toBe(false);
    expect(compact.blocks[0]!.kind === 'notice' && compact.blocks[0]!.text).toBe('Conversation compacted');
    const img = s.turns[5]!;
    expect(img.blocks.map((b) => b.kind)).toEqual(['text', 'image']);
    const ib = img.blocks[1]!;
    expect(ib.kind === 'image' && ib.bytes).toBe(3000);
    expect(s.orphanResults).toHaveLength(1);
  });

  it('extracts persisted output path, agent ids and error status', () => {
    const s = sessionFromJsonl(fixture('tools.jsonl'));
    const web = s.toolCalls.get('t_web')!;
    expect(web.result?.persistedPath).toBe('/tmp/tool-results/abc.txt');
    expect(s.toolCalls.get('t_agent')!.agent?.agentId).toBe('agent-xyz');
    expect(s.toolCalls.get('t_mcp')!.status).toBe('error');
    expect(s.toolCalls.get('t_pending')!.status).toBe('pending');
    expect(isToolOnlyTurn(s.turns[1]!)).toBe(true);
    expect(isToolOnlyTurn(s.turns[0]!)).toBe(false);
  });
});
