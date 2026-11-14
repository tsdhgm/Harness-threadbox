import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/render/markdown.js';
import { sessionToMarkdown } from '../src/render/markdownExport.js';
import { basicRecords, fixture, sessionFrom, sessionFromJsonl } from './helpers.js';

const plain = (src: string, width = 80): string[] =>
  renderMarkdown(src, width).map((l) => (l.blank ? '' : l.firstIndent + l.runs.map((r) => r.text).join('')));

describe('markdown renderer', () => {
  it('renders headings, lists, code and quotes', () => {
    const out = plain('# Title\n\nPara one\nline two\n\n- a\n- b\n  - nested\n\n1. one\n2. two\n\n> quoted\n\n```js\nconst x = 1;\n```\n');
    expect(out).toEqual([
      'Title',
      '',
      'Para one\nline two',
      '',
      '- a',
      '- b',
      '  - nested',
      '',
      '1. one',
      '2. two',
      '',
      '│ quoted',
      '',
      '  const x = 1;',
    ]);
  });

  it('renders inline styles as runs', () => {
    const lines = renderMarkdown('**bold** and `code` and [link](http://x)', 80);
    const runs = lines[0]!.runs;
    expect(runs.find((r) => r.text === 'bold')?.style.bold).toBe(true);
    expect(runs.find((r) => r.text === 'code')?.style.fg).toBe('yellow');
    expect(runs.map((r) => r.text).join('')).toBe('bold and code and link (http://x)');
  });
});

describe('markdown export', () => {
  it('writes a document with meta, turns and tool details', () => {
    const md = sessionToMarkdown(sessionFrom(basicRecords()));
    expect(md.startsWith('# Check remote progress\n')).toBe(true);
    expect(md).toContain('- **cwd**: `/work/proj`');
    expect(md).toContain('## User · 2026-10-24T01:00:00.000Z');
    expect(md).toContain('<summary>Bash(git status --short) · ok</summary>');
    expect(md).toContain('```json\n{\n  "command": "git status --short"');
    expect(md).toContain('**result**:');
  });

  it('uses diff fences for edits and marks images', () => {
    const md = sessionToMarkdown(sessionFromJsonl(fixture('tools.jsonl')));
    expect(md).toContain('```diff\n ctx1\n ctx2\n-a\n+b\n+c\n ctx3\n```');
    const misc = sessionToMarkdown(sessionFromJsonl(fixture('misc.jsonl')));
    expect(misc).toContain('_[image image/png, 3 KB]_');
    expect(misc).toContain('`/init --force`');
  });
});
