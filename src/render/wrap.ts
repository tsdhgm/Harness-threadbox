import { RESET, type Style, type StyledRun, sgrParams, sanitizeText } from './ansi.js';
import { type Cell, displayWidth, isWideBreakable, toCells } from './width.js';

interface SCell extends Cell {
  sgr: string;
}

export interface WrappedLine {
  ansi: string;
  plain: string;
  width: number;
}

export interface WrapOptions {
  width: number;
  /** prefix for the first line (plain text, may be styled via firstIndentStyle) */
  firstIndent?: string;
  firstIndentStyle?: Style;
  /** prefix for continuation lines */
  restIndent?: string;
  restIndentStyle?: Style;
  color: boolean;
  /** when true, do not break at spaces (preformatted); still hard-wraps */
  preformatted?: boolean;
}

function toSCells(runs: StyledRun[], color: boolean): SCell[] {
  const out: SCell[] = [];
  for (const r of runs) {
    const p = color ? sgrParams(r.style) : '';
    const cells = toCells(sanitizeText(r.text));
    for (const c of cells) out.push({ g: c.g, w: c.w, sgr: p });
  }
  return out;
}

function emit(cells: SCell[], indent: string, indentStyle: Style | undefined, color: boolean): WrappedLine {
  let ansi = '';
  let plainStr = indent;
  if (indent) {
    const p = color && indentStyle ? sgrParams(indentStyle) : '';
    ansi += p ? `\x1b[${p}m${indent}${RESET}` : indent;
  }
  let cur = '';
  let w = displayWidth(indent);
  for (const c of cells) {
    if (color && c.sgr !== cur) {
      ansi += RESET;
      if (c.sgr) ansi += `\x1b[${c.sgr}m`;
      cur = c.sgr;
    }
    ansi += c.g;
    plainStr += c.g;
    w += c.w;
  }
  if (cur) ansi += RESET;
  return { ansi, plain: plainStr, width: w };
}

function trimLeading(cells: SCell[]): SCell[] {
  let i = 0;
  while (i < cells.length && cells[i]!.g === ' ') i++;
  return i ? cells.slice(i) : cells;
}

/**
 * Width-aware word wrap of styled runs. Every emitted line has display width <= opts.width
 * (unless a single grapheme is wider than the available space).
 */
export function wrapRuns(runs: StyledRun[], opts: WrapOptions): WrappedLine[] {
  const width = Math.max(1, opts.width);
  const color = opts.color;
  const firstIndent = opts.firstIndent ?? '';
  const restIndent = opts.restIndent ?? '';
  const fiw = displayWidth(firstIndent);
  const riw = displayWidth(restIndent);
  const cells = toSCells(runs, color);
  const out: WrappedLine[] = [];
  let line: SCell[] = [];
  let w = fiw;
  let lastBreak = -1; // index in `line` at which a break may occur (cells before it stay)

  const indentFor = (): [string, Style | undefined] =>
    out.length === 0 ? [firstIndent, opts.firstIndentStyle] : [restIndent, opts.restIndentStyle];

  const flush = (upto: number): void => {
    const [ind, st] = indentFor();
    const head = line.slice(0, upto);
    // drop trailing spaces on the emitted line
    let end = head.length;
    while (end > 0 && head[end - 1]!.g === ' ') end--;
    out.push(emit(head.slice(0, end), ind, st, color));
    line = trimLeading(line.slice(upto));
    w = riw;
    for (const c of line) w += c.w;
    lastBreak = -1;
  };

  for (const c of cells) {
    if (c.g === '\n') {
      flush(line.length);
      continue;
    }
    const avail = width;
    if (w + c.w > avail && line.length > 0) {
      if (!opts.preformatted && c.g === ' ') {
        // the overflowing cell is a space: end the line here (trailing spaces are trimmed)
        flush(line.length);
        lastBreak = 0;
        continue;
      }
      if (!opts.preformatted && lastBreak > 0) flush(lastBreak);
      else flush(line.length);
    }
    const prev = line[line.length - 1];
    if (!opts.preformatted) {
      if (c.g === ' ') {
        // break after this space
        line.push(c);
        w += c.w;
        lastBreak = line.length;
        continue;
      }
      if (isWideBreakable(c.g) || (prev && isWideBreakable(prev.g))) {
        lastBreak = line.length; // may break before this cell
      }
    }
    line.push(c);
    w += c.w;
  }
  const [ind, st] = indentFor();
  let end = line.length;
  while (end > 0 && line[end - 1]!.g === ' ') end--;
  out.push(emit(line.slice(0, end), ind, st, color));
  return out;
}

/** Convenience: wrap a plain string with a single style. */
export function wrapText(text: string, style: Style, opts: WrapOptions): WrappedLine[] {
  return wrapRuns([{ text, style }], opts);
}
