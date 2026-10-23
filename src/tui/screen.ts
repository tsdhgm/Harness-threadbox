import { RESET } from '../render/ansi.js';
import { displayWidth, graphemeWidth } from '../render/width.js';
import type { TerminalIO } from './terminal.js';

 
const RE_SGR = /^\x1b\[[0-9;]*m/;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Pad or truncate an ANSI string to exactly `cols` display columns. */
export function fitAnsi(s: string, cols: number): string {
  let out = '';
  let w = 0;
  let i = 0;
  let sawSgr = false;
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      const m = RE_SGR.exec(s.slice(i, i + 32));
      if (m) {
        out += m[0];
        i += m[0].length;
        sawSgr = true;
        continue;
      }
      // unknown escape: drop ESC
      i++;
      continue;
    }
    // find next ESC
    let j = s.indexOf('\x1b', i);
    if (j < 0) j = s.length;
    const chunk = s.slice(i, j);
    i = j;
    if (w + chunk.length <= cols && isAsciiPrintable(chunk)) {
      out += chunk;
      w += chunk.length;
      continue;
    }
    for (const seg of segmenter.segment(chunk)) {
      const g = seg.segment;
      const gw = graphemeWidth(g);
      if (w + gw > cols) {
        if (sawSgr) out += RESET;
        return out + ' '.repeat(Math.max(0, cols - w));
      }
      out += g;
      w += gw;
    }
  }
  if (sawSgr) out += RESET;
  return out + ' '.repeat(Math.max(0, cols - w));
}

function isAsciiPrintable(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

export { displayWidth };

/** Row-diff double buffer. */
export class Screen {
  private prev: string[] = [];
  private next: string[] = [];
  private forceAll = true;

  constructor(
    private io: TerminalIO,
    public cols: number,
    public rows: number,
  ) {
    this.reset();
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.reset();
  }

  private reset(): void {
    this.prev = new Array(this.rows).fill('');
    this.next = new Array(this.rows).fill(' '.repeat(this.cols));
    this.forceAll = true;
  }

  /** Begin a frame: all rows blank. */
  begin(): void {
    const blank = ' '.repeat(this.cols);
    for (let y = 0; y < this.rows; y++) this.next[y] = blank;
  }

  /** Set row y to an ANSI string (fitted to width). */
  set(y: number, ansi: string): void {
    if (y < 0 || y >= this.rows) return;
    this.next[y] = fitAnsi(ansi, this.cols);
  }

  /** Overlay a string at (x, y): x in columns. */
  put(x: number, y: number, ansi: string, width: number): void {
    if (y < 0 || y >= this.rows) return;
    const row = this.next[y]!;
    const left = fitAnsi(row, x);
    const mid = fitAnsi(ansi, width);
    const rightW = this.cols - x - width;
    // take the right remainder of the existing row (plain approximation: re-fit from plain)
    const plainRow = stripSgr(row);
    const right = rightW > 0 ? sliceCols(plainRow, x + width, rightW) : '';
    this.next[y] = `${left}${mid}${right}`;
  }

  flush(): void {
    let out = '';
    for (let y = 0; y < this.rows; y++) {
      if (this.forceAll || this.next[y] !== this.prev[y]) {
        out += `\x1b[${y + 1};1H${this.next[y]}`;
        this.prev[y] = this.next[y]!;
      }
    }
    this.forceAll = false;
    if (out) this.io.write(`\x1b[?2026h${out}\x1b[?2026l`);
  }

  /** For tests: plain text of the current frame. */
  snapshot(): string[] {
    return this.next.map((r) => stripSgr(r));
  }
}

 
const RE_ALL_SGR = /\x1b\[[0-9;]*m/g;
export function stripSgr(s: string): string {
  return s.replace(RE_ALL_SGR, '');
}

function sliceCols(plain: string, start: number, width: number): string {
  let out = '';
  let w = 0;
  for (const seg of segmenter.segment(plain)) {
    const gw = graphemeWidth(seg.segment);
    if (w >= start) {
      if (displayWidth(out) + gw > width) break;
      out += seg.segment;
    } else if (w + gw > start) {
      // wide char straddles the boundary: replace with space
      out += ' ';
    }
    w += gw;
  }
  return out + ' '.repeat(Math.max(0, width - displayWidth(out)));
}
