import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { type Style, type StyledRun, merge } from './ansi.js';
import { displayWidth, padToWidth } from './width.js';

/** One logical markdown line, to be wrapped by the caller with its indents. */
export interface MdLine {
  runs: StyledRun[];
  firstIndent: string;
  restIndent: string;
  preformatted?: boolean;
  /** blank separator line */
  blank?: boolean;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
// GFM tables are enabled by default in commonmark preset? markdown-it default preset enables table.

const ST = {
  h1: { bold: true, underline: true } as Style,
  h: { bold: true } as Style,
  code: { fg: 'yellow' } as Style,
  codeBlock: {} as Style,
  gutter: { dim: true } as Style,
  link: { fg: 'cyan', underline: true } as Style,
  url: { dim: true } as Style,
  quote: { dim: true } as Style,
  hr: { dim: true } as Style,
  bullet: { fg: 'default' } as Style,
};

interface ListCtx {
  ordered: boolean;
  index: number;
  indent: string;
}

/** Render inline children tokens to styled runs. */
function inlineRuns(tokens: Token[], base: Style): StyledRun[] {
  const runs: StyledRun[] = [];
  const stack: Style[] = [base];
  const cur = (): Style => stack[stack.length - 1]!;
  let linkHref: string | undefined;
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        runs.push({ text: t.content, style: cur() });
        break;
      case 'softbreak':
      case 'hardbreak':
        runs.push({ text: '\n', style: cur() });
        break;
      case 'strong_open':
        stack.push(merge(cur(), { bold: true }));
        break;
      case 'em_open':
        stack.push(merge(cur(), { italic: true }));
        break;
      case 's_open':
        stack.push(merge(cur(), { strike: true, dim: true }));
        break;
      case 'strong_close':
      case 'em_close':
      case 's_close':
        if (stack.length > 1) stack.pop();
        break;
      case 'code_inline':
        runs.push({ text: t.content, style: merge(cur(), ST.code) });
        break;
      case 'link_open': {
        linkHref = t.attrGet('href') ?? undefined;
        stack.push(merge(cur(), ST.link));
        break;
      }
      case 'link_close': {
        if (stack.length > 1) stack.pop();
        if (linkHref) {
          // avoid duplicating when the text is the url itself
          const last = runs[runs.length - 1];
          if (!last || last.text.trim() !== linkHref) runs.push({ text: ` (${linkHref})`, style: merge(cur(), ST.url) });
          linkHref = undefined;
        }
        break;
      }
      case 'image': {
        const alt = t.content || t.attrGet('alt') || 'image';
        runs.push({ text: `[image: ${alt}]`, style: merge(cur(), ST.url) });
        break;
      }
      case 'html_inline':
        runs.push({ text: t.content, style: cur() });
        break;
      default:
        if (t.content) runs.push({ text: t.content, style: cur() });
    }
  }
  return runs;
}

function plainOf(runs: StyledRun[]): string {
  return runs.map((r) => r.text).join('');
}

/**
 * Render markdown source into logical lines. The caller wraps each line to width.
 * `width` is used only for table layout decisions.
 */
export function renderMarkdown(src: string, width: number, base: Style = {}): MdLine[] {
  let tokens: Token[];
  try {
    tokens = md.parse(src, {});
  } catch {
    return src.split('\n').map((l) => ({ runs: [{ text: l, style: base }], firstIndent: '', restIndent: '' }));
  }
  const out: MdLine[] = [];
  const lists: ListCtx[] = [];
  let quoteDepth = 0;
  let pendingPrefix: { text: string; style: Style } | undefined;
  let tightList = false;

  const indentStr = (): string => lists.map((l) => l.indent).join('');
  const quotePrefix = (): string => (quoteDepth > 0 ? '│ '.repeat(quoteDepth) : '');
  const blank = (): void => {
    if (out.length > 0 && !out[out.length - 1]!.blank) out.push({ runs: [], firstIndent: '', restIndent: '', blank: true });
  };
  const push = (runs: StyledRun[], extraFirst = '', extraRest = '', preformatted = false): void => {
    const ind = indentStr();
    const qp = quotePrefix();
    let first = qp + ind + extraFirst;
    let rest = qp + ind + extraRest;
    if (pendingPrefix) {
      first = qp + ind.slice(0, Math.max(0, ind.length - pendingPrefix.text.length)) + pendingPrefix.text + extraFirst;
      rest = qp + ind + extraRest;
      pendingPrefix = undefined;
    }
    const line: MdLine = { runs, firstIndent: first, restIndent: rest };
    if (preformatted) line.preformatted = true;
    out.push(line);
  };

  // table state
  let table: { rows: StyledRun[][][]; aligns: string[]; isHead: boolean[] } | undefined;
  let row: StyledRun[][] | undefined;
  let rowIsHead = false;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t.type) {
      case 'heading_open': {
        blank();
        const level = Number(t.tag.slice(1));
        const inline = tokens[i + 1]!;
        const runs = inlineRuns(inline.children ?? [], merge(base, level === 1 ? ST.h1 : ST.h));
        const prefix = level >= 3 ? '' : '';
        push(runs, prefix);
        i += 2; // inline + heading_close
        blank();
        break;
      }
      case 'paragraph_open': {
        const inline = tokens[i + 1]!;
        const runs = inlineRuns(inline.children ?? [], merge(base, quoteDepth ? ST.quote : {}));
        if (runs.length) push(runs);
        i += 2;
        if (!tightList && lists.length === 0) {
          // paragraphs separated by blank lines outside lists
          const next = tokens[i + 1];
          if (next && next.type !== 'list_item_close' && next.type !== 'blockquote_close') blank();
        }
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = t.type === 'ordered_list_open';
        const start = ordered ? Number(t.attrGet('start') ?? '1') : 1;
        if (lists.length === 0) blank();
        lists.push({ ordered, index: start, indent: ordered ? '   ' : '  ' });
        tightList = true;
        break;
      }
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop();
        if (lists.length === 0) {
          tightList = false;
          blank();
        }
        break;
      case 'list_item_open': {
        const ctx = lists[lists.length - 1]!;
        const marker = ctx.ordered ? `${ctx.index}. ` : '- ';
        ctx.index++;
        // widen indent to marker width for ordered lists >= 10
        ctx.indent = ' '.repeat(Math.max(2, displayWidth(marker)));
        pendingPrefix = { text: marker, style: ST.bullet };
        break;
      }
      case 'list_item_close':
        pendingPrefix = undefined;
        break;
      case 'blockquote_open':
        quoteDepth++;
        break;
      case 'blockquote_close':
        quoteDepth--;
        break;
      case 'fence':
      case 'code_block': {
        blank();
        const lines = t.content.replace(/\n$/, '').split('\n');
        for (const l of lines) push([{ text: l, style: merge(base, ST.codeBlock) }], '', '', true);
        // mark the gutter via prefix: handled by caller? keep simple: prefix in indent
        for (let k = out.length - lines.length; k < out.length; k++) {
          const ln = out[k]!;
          ln.firstIndent = `${ln.firstIndent}  `;
          ln.restIndent = `${ln.restIndent}  `;
        }
        blank();
        break;
      }
      case 'hr':
        blank();
        push([{ text: '─'.repeat(Math.max(4, Math.min(40, width - indentStr().length))), style: merge(base, ST.hr) }]);
        blank();
        break;
      case 'html_block':
        push([{ text: t.content.trimEnd(), style: merge(base, { dim: true }) }], '', '', true);
        break;
      case 'table_open':
        blank();
        table = { rows: [], aligns: [], isHead: [] };
        break;
      case 'thead_open':
        rowIsHead = true;
        break;
      case 'thead_close':
        rowIsHead = false;
        break;
      case 'tr_open':
        row = [];
        break;
      case 'th_open':
      case 'td_open': {
        const inline = tokens[i + 1]!;
        const style = t.type === 'th_open' ? merge(base, { bold: true }) : base;
        row?.push(inline.type === 'inline' ? inlineRuns(inline.children ?? [], style) : []);
        if (table && t.type === 'th_open') {
          const st = t.attrGet('style') ?? '';
          table.aligns.push(st.includes('right') ? 'right' : st.includes('center') ? 'center' : 'left');
        }
        i += 2;
        break;
      }
      case 'tr_close':
        if (table && row) {
          table.rows.push(row);
          table.isHead.push(rowIsHead);
        }
        row = undefined;
        break;
      case 'table_close': {
        if (table) emitTable(table, width - indentStr().length - quotePrefix().length, push, base);
        table = undefined;
        blank();
        break;
      }
      default:
        break;
    }
  }
  // trim leading/trailing blanks
  while (out.length && out[0]!.blank) out.shift();
  while (out.length && out[out.length - 1]!.blank) out.pop();
  return out;
}

function emitTable(
  table: { rows: StyledRun[][][]; aligns: string[]; isHead: boolean[] },
  width: number,
  push: (runs: StyledRun[], f?: string, r?: string, pre?: boolean) => void,
  base: Style,
): void {
  const ncol = Math.max(...table.rows.map((r) => r.length), 0);
  if (ncol === 0) return;
  const widths: number[] = new Array(ncol).fill(0);
  const cellText = table.rows.map((r) => r.map((c) => plainOf(c).replace(/\n/g, ' ')));
  for (const r of cellText) r.forEach((c, j) => (widths[j] = Math.max(widths[j]!, displayWidth(c))));
  const total = widths.reduce((a, b) => a + b, 0) + (ncol - 1) * 3;
  if (total > width) {
    // fallback: compact rows
    table.rows.forEach((r, ri) => {
      const runs: StyledRun[] = [];
      r.forEach((c, j) => {
        if (j) runs.push({ text: ' │ ', style: merge(base, { dim: true }) });
        runs.push(...c.map((x) => ({ text: x.text.replace(/\n/g, ' '), style: x.style })));
      });
      push(runs, '', '  ', false);
      if (table.isHead[ri] && !table.isHead[ri + 1]) push([{ text: '─'.repeat(Math.min(width, 40)), style: merge(base, { dim: true }) }]);
    });
    return;
  }
  table.rows.forEach((r, ri) => {
    const runs: StyledRun[] = [];
    for (let j = 0; j < ncol; j++) {
      if (j) runs.push({ text: ' │ ', style: merge(base, { dim: true }) });
      const cell = r[j] ?? [];
      const text = cellText[ri]![j] ?? '';
      const pad = widths[j]! - displayWidth(text);
      const align = table.aligns[j] ?? 'left';
      if (align === 'right') runs.push({ text: ' '.repeat(pad), style: base });
      else if (align === 'center') runs.push({ text: ' '.repeat(Math.floor(pad / 2)), style: base });
      runs.push(...cell.map((x) => ({ text: x.text.replace(/\n/g, ' '), style: x.style })));
      if (align === 'left') runs.push({ text: ' '.repeat(pad), style: base });
      else if (align === 'center') runs.push({ text: ' '.repeat(pad - Math.floor(pad / 2)), style: base });
    }
    push(runs, '', '', true);
    if (table.isHead[ri] && !table.isHead[ri + 1]) {
      const sep = widths.map((w) => '─'.repeat(w)).join('─┼─');
      push([{ text: sep, style: merge(base, { dim: true }) }], '', '', true);
    }
  });
}

export { padToWidth };
