import { describe, expect, it } from 'vitest';
import { SessionLineCache } from '../src/render/lineCache.js';
import type { RenderOptions } from '../src/render/transcript.js';
import { stripAnsi } from '../src/render/ansi.js';
import { basicRecords, fixture, sessionFrom, sessionFromJsonl } from './helpers.js';
import type { Session } from '../src/core/types.js';

const opts = (o: Partial<RenderOptions> = {}): RenderOptions => ({
  width: 80,
  thinking: false,
  tools: 'collapsed',
  hideToolOnly: false,
  showMeta: false,
  color: false,
  live: false,
  cwd: '/work/proj',
  ascii: false,
  ...o,
});

function render(s: Session, o: Partial<RenderOptions> = {}): string[] {
  const c = new SessionLineCache(s);
  c.ensure(opts(o));
  return [...c.lines()].map((l) => l.plain);
}

describe('transcript rendering', () => {
  it('renders a Claude-Code-like transcript', () => {
    const s = sessionFrom(basicRecords());
    const lines = render(s);
    expect(lines[0]).toMatch(/^━━━ Remote の進捗確認 · .* · sess-000 · \/work\/proj ━+$/);
    const user = lines.find((l) => l.startsWith('> remote を確認して'))!;
    expect(user).toMatch(/^> remote を確認して。どこまで進んだか忘れた\s+\d\d:\d\d$/);
    expect(user.length).toBeLessThanOrEqual(80);
    const bash = lines.findIndex((l) => l === '⏺ Bash(git status --short)');
    expect(bash).toBeGreaterThan(0);
    expect(lines[bash + 1]).toBe('  ⎿   M src/a.ts');
    expect(lines[bash + 2]).toBe('     ?? new.txt');
    expect(lines).toContain('⏺ 確認します。');
    expect(lines).toContain('⏺ 変更が 2 件あります。');
    expect(lines).toContain('  - src/a.ts が修正済み');
    // thinking with empty text is omitted when thinking=off
    expect(lines.some((l) => l.includes('Thinking'))).toBe(false);
    // every line within width
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80 * 2);
  });

  it('shows pending tools differently for live and dead sessions', () => {
    const s = sessionFromJsonl(fixture('tools.jsonl'));
    const dead = render(s);
    const i = dead.indexOf('⏺ Bash(sleep 100)');
    expect(dead[i + 1]).toBe('  ⎿  (no result recorded)');
    const live = render(s, { live: true });
    expect(live[live.indexOf('⏺ Bash(sleep 100)') + 1]).toBe('  ⎿  Running…');
  });

  it('summarizes tools per kind', () => {
    const s = sessionFromJsonl(fixture('tools.jsonl'));
    const lines = render(s);
    expect(lines).toContain('⏺ Update(src/a.ts)');
    const up = lines.indexOf('⏺ Update(src/a.ts)');
    expect(lines[up + 1]).toBe('  ⎿  Added 2 lines, removed 1 line');
    expect(lines[up + 2]).toBe('      ctx2');
    expect(lines[up + 3]).toBe('     -a');
    expect(lines[up + 4]).toBe('     +b');
    expect(lines).toContain('⏺ Write(out.txt)');
    expect(lines[lines.indexOf('⏺ Write(out.txt)') + 1]).toBe('  ⎿  Wrote 3 lines');
    expect(lines).toContain('⏺ Read(README.md 10..30)');
    expect(lines[lines.indexOf('⏺ Read(README.md 10..30)') + 1]).toBe('  ⎿  Read 2 lines');
    expect(lines).toContain('⏺ Search(pattern: "foo", path: src)');
    expect(lines).toContain('⏺ Agent(Explore repo) [Explore]');
    expect(lines).toContain('⏺ Web Search("node 24 fs.watch")');
    expect(lines.some((l) => l.includes('full output: /tmp/tool-results/abc.txt'))).toBe(true);
    expect(lines).toContain('⏺ navigate(https://example.com) [chrome]');
    expect(lines[lines.indexOf('⏺ navigate(https://example.com) [chrome]') + 1]).toBe('  ⎿  navigated');
  });

  it('respects tools mode and hideToolOnly', () => {
    const s = sessionFromJsonl(fixture('tools.jsonl'));
    const hidden = render(s, { tools: 'hidden' });
    expect(hidden.some((l) => l.includes('⎿') && !l.includes('no result'))).toBe(false);
    const none = render(s, { hideToolOnly: true });
    expect(none.some((l) => l.startsWith('⏺'))).toBe(false);
    expect(none.some((l) => l.startsWith('> いろいろ'))).toBe(true);
  });

  it('renders thinking, commands, interrupts, compaction and images', () => {
    const s = sessionFromJsonl(fixture('misc.jsonl'));
    const lines = render(s, { thinking: true });
    expect(lines.some((l) => l.startsWith('> /init --force'))).toBe(true);
    expect(lines).toContain('  ⎿  Initialized.');
    expect(lines).toContain('✻ Thinking…');
    expect(lines).toContain('  let me think about it');
    expect(lines).toContain('  ⎿  Interrupted by user');
    expect(lines.some((l) => /^─+ Conversation compacted ─+$/.test(l))).toBe(true);
    expect(lines).toContain('· summary text (disable recaps in /config)');
    expect(lines).toContain('> [image image/png, 3 KB]');
    const off = render(s, { thinking: false });
    expect(off).toContain('✻ Thinking…');
    expect(off).not.toContain('  let me think about it');
  });

  it('keeps CJK markdown within width and renders tables', () => {
    const s = sessionFromJsonl(fixture('cjk.jsonl'));
    for (const w of [40, 61, 100]) {
      const c = new SessionLineCache(s);
      c.ensure(opts({ width: w }));
      for (const l of c.lines()) expect(l.width).toBeLessThanOrEqual(w);
    }
    const lines = render(s, { width: 100 });
    expect(lines).toContain('⏺ 見出し');
    expect(lines.some((l) => l.includes('列A') && l.includes('│') && l.includes('列B'))).toBe(true);
    expect(lines.some((l) => l.includes('いい │ ccc'))).toBe(true);
    expect(lines).toContain('    code line');
  });

  it('re-renders only dirty turns incrementally', () => {
    const s = sessionFrom(basicRecords());
    const c = new SessionLineCache(s);
    c.ensure(opts());
    const total = c.total();
    expect(c.ensure(opts())).toBe(false);
    s.turns[1]!.dirty = true;
    expect(c.ensure(opts())).toBe(true);
    expect(c.total()).toBe(total);
    expect(c.locate(0)).toEqual({ block: 0, offset: 0 });
    expect(c.lineAt(c.total() - 1)!.kind).toBe('blank');
  });

  it('color output strips to the same plain text', () => {
    const s = sessionFrom(basicRecords());
    const c = new SessionLineCache(s);
    c.ensure(opts({ color: true }));
    for (const l of c.lines()) expect(stripAnsi(l.ansi)).toBe(l.plain);
  });
});
