import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/render/ansi.js';
import { displayWidth, truncateToWidth } from '../src/render/width.js';
import { wrapRuns } from '../src/render/wrap.js';

const widthOf = (ansi: string): number => displayWidth(stripAnsi(ansi));

describe('wrap', () => {
  it('keeps every line within width (latin, word wrap)', () => {
    const text = 'The quick brown fox jumps over the lazy dog and keeps running through the forest until dawn';
    for (const w of [10, 17, 33, 80]) {
      const lines = wrapRuns([{ text, style: {} }], { width: w, color: false });
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(w);
      expect(lines.map((l) => l.plain).join(' ')).toBe(text);
    }
  });

  it('breaks CJK anywhere without straddling a wide char', () => {
    const text = '日本語の長い文章がどこで折り返されるかを確認します'.repeat(3);
    for (const w of [9, 10, 23]) {
      const lines = wrapRuns([{ text, style: {} }], { width: w, color: false });
      for (const l of lines) {
        expect(l.width).toBeLessThanOrEqual(w);
        expect(displayWidth(l.plain)).toBe(l.width);
      }
      expect(lines.map((l) => l.plain).join('')).toBe(text);
    }
  });

  it('applies indents and re-opens SGR on every line', () => {
    const lines = wrapRuns([{ text: 'aaa bbb ccc ddd', style: { fg: 'red' } }], { width: 9, color: true, firstIndent: '> ', restIndent: '  ' });
    expect(lines.map((l) => l.plain)).toEqual(['> aaa bbb', '  ccc ddd']);
    for (const l of lines) {
      expect(l.ansi).toContain('\x1b[31m');
      expect(l.ansi.endsWith('\x1b[0m')).toBe(true);
      expect(widthOf(l.ansi)).toBe(l.width);
    }
  });

  it('sanitizes escape sequences, tabs and control chars', () => {
    const lines = wrapRuns([{ text: 'a\x1b[31mb\tc\x07d', style: {} }], { width: 40, color: false });
    expect(lines[0]!.plain).toBe('ab    cd');
  });

  it('honours explicit newlines and preformatted mode', () => {
    const lines = wrapRuns([{ text: 'one two\nthree four five', style: {} }], { width: 8, color: false, preformatted: true });
    expect(lines.map((l) => l.plain)).toEqual(['one two', 'three fo', 'ur five']);
  });
});

describe('width', () => {
  it('measures CJK as 2 columns and truncates with ellipsis', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('日本')).toBe(4);
    expect(truncateToWidth('日本語テキスト', 7)).toBe('日本語…');
    expect(displayWidth(truncateToWidth('日本語テキスト', 7))).toBeLessThanOrEqual(7);
  });
});
