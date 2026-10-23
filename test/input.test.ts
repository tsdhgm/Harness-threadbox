import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args.js';
import { type InputEvent, InputParser } from '../src/tui/input.js';
import { fitAnsi, stripSgr } from '../src/tui/screen.js';
import { highlightAnsi } from '../src/tui/highlight.js';

function parse(s: string): InputEvent[] {
  const out: InputEvent[] = [];
  const p = new InputParser((e) => out.push(e));
  p.feed(Buffer.from(s, 'utf8'));
  return out;
}

describe('InputParser', () => {
  it('parses plain keys and control keys', () => {
    expect(parse('j').map((e) => e.type === 'key' && e.name)).toEqual(['j']);
    expect(parse('G')[0]).toMatchObject({ name: 'G', shift: true });
    expect(parse('\r')[0]).toMatchObject({ name: 'enter' });
    expect(parse('\t')[0]).toMatchObject({ name: 'tab' });
    expect(parse('\x03')[0]).toMatchObject({ name: 'c', ctrl: true });
    expect(parse('あ')[0]).toMatchObject({ name: 'あ' });
  });

  it('parses CSI sequences', () => {
    expect(parse('\x1b[A')[0]).toMatchObject({ name: 'up' });
    expect(parse('\x1b[6~')[0]).toMatchObject({ name: 'pagedown' });
    expect(parse('\x1b[5~')[0]).toMatchObject({ name: 'pageup' });
    expect(parse('\x1b[Z')[0]).toMatchObject({ name: 'backtab' });
    expect(parse('\x1b[1;5A')[0]).toMatchObject({ name: 'up', ctrl: true });
    expect(parse('\x1bOH')[0]).toMatchObject({ name: 'home' });
  });

  it('parses SGR mouse events', () => {
    expect(parse('\x1b[<0;10;5M')[0]).toMatchObject({ type: 'mouse', action: 'press', button: 0, x: 9, y: 4 });
    expect(parse('\x1b[<0;10;5m')[0]).toMatchObject({ action: 'release' });
    expect(parse('\x1b[<64;1;1M')[0]).toMatchObject({ action: 'wheel-up' });
    expect(parse('\x1b[<65;1;1M')[0]).toMatchObject({ action: 'wheel-down' });
    expect(parse('\x1b[<32;3;3M')[0]).toMatchObject({ action: 'drag' });
  });

  it('handles split sequences across feeds', () => {
    const out: InputEvent[] = [];
    const p = new InputParser((e) => out.push(e));
    p.feed(Buffer.from('\x1b['));
    p.feed(Buffer.from('B'));
    expect(out[0]).toMatchObject({ name: 'down' });
  });
});

describe('args', () => {
  it('parses commands, flags and positionals', () => {
    const a = parseArgs(['cat', 'abc123', '--width', '90', '--no-color', '-f', '--tools=full'], new Set(['cat', 'list']));
    expect(a.command).toBe('cat');
    expect(a.positional).toEqual(['abc123']);
    expect(a.flags).toEqual({ width: '90', 'no-color': true, follow: true, tools: 'full' });
  });
});

describe('screen helpers', () => {
  it('fits ANSI strings to a width', () => {
    expect(fitAnsi('abc', 5)).toBe('abc  ');
    expect(stripSgr(fitAnsi('\x1b[31mabcdef\x1b[0m', 4))).toBe('abcd');
    expect(fitAnsi('日本語', 5)).toBe('日本 ');
  });
  it('highlights matches inside ANSI text', () => {
    const h = highlightAnsi('\x1b[2mfoo bar\x1b[0m', 'foo bar', 'bar');
    expect(h).toBe('\x1b[2mfoo \x1b[7mbar\x1b[27m\x1b[0m');
    expect(stripSgr(h)).toBe('foo bar');
  });
});
