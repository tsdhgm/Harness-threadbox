import type { Block, SessionIndexEntry, ToolCall, Turn } from '../core/types.js';
import type { ToolSummary } from '../core/provider.js';
import { type Style, type StyledRun } from './ansi.js';
import { renderMarkdown } from './markdown.js';
import { type ToolPreview, previewClaudeTool, summarizeClaudeTool } from './toolSummary.js';
import { displayWidth, truncateToWidth } from './width.js';
import { type WrappedLine, wrapRuns } from './wrap.js';
import { isToolOnlyTurn } from '../providers/claude/normalizer.js';

export type ToolsMode = 'collapsed' | 'full' | 'hidden';

export interface RenderOptions {
  width: number;
  thinking: boolean;
  tools: ToolsMode;
  hideToolOnly: boolean;
  showMeta: boolean;
  color: boolean;
  /** session is currently live (pending tools shown as running) */
  live: boolean;
  cwd: string;
  ascii: boolean;
  summarize?: (call: ToolCall, cwd: string) => ToolSummary | undefined;
  preview?: (call: ToolCall, cwd: string) => ToolPreview | undefined;
}

export type LineKind =
  | 'header'
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'tool-result'
  | 'notice'
  | 'meta'
  | 'blank';

export interface RenderedLine {
  ansi: string;
  plain: string;
  width: number;
  kind: LineKind;
  anchor: { turnId: string; blockIdx: number };
}

const COLLAPSED_LINES = 3;
const COLLAPSED_DIFF_LINES = 6;

interface Glyphs {
  bullet: string;
  elbow: string;
  think: string;
  prompt: string;
  rule: string;
}
const UNICODE: Glyphs = { bullet: '⏺', elbow: '⎿', think: '✻', prompt: '>', rule: '─' };
const ASCII: Glyphs = { bullet: '*', elbow: 'L', think: '~', prompt: '>', rule: '-' };

const DIM: Style = { dim: true };

function fmtTime(ts: number | undefined): string {
  if (ts === undefined) return '';
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function fmtDateTime(ts: number | undefined): string {
  if (ts === undefined) return '';
  const d = new Date(ts);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da} ${fmtTime(ts)}`;
}

function mk(w: WrappedLine, kind: LineKind, turnId: string, blockIdx: number): RenderedLine {
  return { ansi: w.ansi, plain: w.plain, width: w.width, kind, anchor: { turnId, blockIdx } };
}

function blankLine(turnId: string, blockIdx = -1): RenderedLine {
  return { ansi: '', plain: '', width: 0, kind: 'blank', anchor: { turnId, blockIdx } };
}

/** Append a right-aligned dim timestamp to the first line if it fits. */
function withTime(line: RenderedLine, ts: number | undefined, width: number, color: boolean): RenderedLine {
  const t = fmtTime(ts);
  if (!t) return line;
  const gap = width - line.width - displayWidth(t);
  if (gap < 2) return line;
  const pad = ' '.repeat(gap);
  const tAnsi = color ? `\x1b[2m${t}\x1b[0m` : t;
  return { ...line, ansi: `${line.ansi}${pad}${tAnsi}`, plain: `${line.plain}${pad}${t}`, width };
}

function wrap(runs: StyledRun[], first: string, rest: string, o: RenderOptions, firstStyle?: Style, restStyle?: Style, pre = false): WrappedLine[] {
  const opts: Parameters<typeof wrapRuns>[1] = { width: o.width, firstIndent: first, restIndent: rest, color: o.color };
  if (firstStyle) opts.firstIndentStyle = firstStyle;
  if (restStyle) opts.restIndentStyle = restStyle;
  if (pre) opts.preformatted = true;
  return wrapRuns(runs, opts);
}

function statusColor(call: ToolCall, live: boolean): Style {
  switch (call.status) {
    case 'ok':
      return { fg: 'green' };
    case 'error':
      return { fg: 'red' };
    default:
      return live ? { fg: 'yellow' } : { dim: true };
  }
}

export function renderSessionHeader(index: SessionIndexEntry, title: string, o: RenderOptions): RenderedLine[] {
  const g = o.ascii ? ASCII : UNICODE;
  const bar = o.ascii ? '=' : '━';
  const metaParts = [fmtDateTime(index.startedAt), index.ref.sessionId.slice(0, 8)];
  if (index.project.cwd) metaParts.push(index.project.cwd);
  const meta = ` · ${metaParts.filter(Boolean).join(' · ')} `;
  const maxTitle = Math.max(8, o.width - 4 - displayWidth(meta) - 3);
  const t = truncateToWidth(title, maxTitle);
  const used = 4 + displayWidth(t) + displayWidth(meta);
  const fill = Math.max(0, o.width - used - 1);
  const runs: StyledRun[] = [
    { text: `${bar}${bar}${bar} `, style: { dim: true } },
    { text: t, style: { bold: true, fg: 'cyan' } },
    { text: meta, style: { dim: true } },
    { text: bar.repeat(fill), style: { dim: true } },
  ];
  const lines = wrap(runs, '', '', o, undefined, undefined, true);
  void g;
  const id = `header:${index.ref.sessionId}`;
  return [...lines.map((w) => mk(w, 'header', id, -1)), blankLine(id)];
}

function renderUserText(text: string, turn: Turn, bi: number, o: RenderOptions, g: Glyphs): RenderedLine[] {
  const lines = wrap([{ text, style: {} }], `${g.prompt} `, '  ', o, DIM).map((w) => mk(w, 'user', turn.id, bi));
  if (lines.length) lines[0] = withTime(lines[0]!, turn.ts, o.width, o.color);
  return lines;
}

function renderThinking(text: string, turn: Turn, bi: number, o: RenderOptions, g: Glyphs): RenderedLine[] {
  const head = wrap([{ text: 'Thinking…', style: { dim: true, italic: true } }], `${g.think} `, '  ', o, DIM).map((w) => mk(w, 'thinking', turn.id, bi));
  if (!o.thinking || !text.trim()) return head;
  const body = wrap([{ text: text.trim(), style: { dim: true, italic: true } }], '  ', '  ', o).map((w) => mk(w, 'thinking', turn.id, bi));
  return [...head, ...body];
}

function renderAssistantText(text: string, turn: Turn, bi: number, o: RenderOptions, g: Glyphs, first: boolean): RenderedLine[] {
  const mdLines = renderMarkdown(text, o.width - 2);
  const out: RenderedLine[] = [];
  let bulletPending = first;
  for (const ml of mdLines) {
    if (ml.blank) {
      out.push(blankLine(turn.id, bi));
      continue;
    }
    const prefix = bulletPending ? `${g.bullet} ` : '  ';
    bulletPending = false;
    const ws = wrap(ml.runs, prefix + ml.firstIndent, '  ' + ml.restIndent, o, undefined, undefined, ml.preformatted ?? false);
    for (const w of ws) out.push(mk(w, 'assistant', turn.id, bi));
  }
  if (out.length === 0 && first) {
    // empty text block: still show the bullet so the turn is visible
    return [];
  }
  return out;
}

function renderToolCall(call: ToolCall, turn: Turn, bi: number, o: RenderOptions, g: Glyphs): RenderedLine[] {
  const sum = (o.summarize ?? summarizeClaudeTool)(call, o.cwd) ?? { verb: call.name, arg: '' };
  const runs: StyledRun[] = [{ text: sum.verb, style: { bold: true } }];
  if (sum.arg) runs.push({ text: '(', style: {} }, { text: sum.arg.replace(/\n/g, ' '), style: {} }, { text: ')', style: {} });
  else runs.push({ text: '', style: {} });
  if (sum.tag) runs.push({ text: ` ${sum.tag}`, style: DIM });
  const out: RenderedLine[] = [];
  const label = wrap(runs, `${g.bullet} `, '    ', o, statusColor(call, o.live)).map((w) => mk(w, 'tool', turn.id, bi));
  out.push(...label);

  const elbow = `  ${g.elbow}  `;
  const cont = '     ';
  const resultLine = (r: StyledRun[], pre = true): RenderedLine[] =>
    wrap(r, elbow, cont, o, DIM, undefined, pre).map((w) => mk(w, 'tool-result', turn.id, bi));
  const bodyLine = (r: StyledRun[], pre = true): RenderedLine[] =>
    wrap(r, cont, cont, o, undefined, undefined, pre).map((w) => mk(w, 'tool-result', turn.id, bi));

  if (call.status === 'pending') {
    if (o.live) out.push(...resultLine([{ text: 'Running…', style: { fg: 'yellow' } }]));
    else out.push(...resultLine([{ text: '(no result recorded)', style: DIM }]));
    return out;
  }
  if (o.tools === 'hidden') return out;

  const pv = (o.preview ?? previewClaudeTool)(call, o.cwd) ?? { lines: [] };
  const limit = o.tools === 'full' ? Infinity : pv.isDiff ? COLLAPSED_DIFF_LINES : COLLAPSED_LINES;
  let first = true;
  if (pv.headline) {
    out.push(...resultLine([{ text: pv.headline, style: call.status === 'error' ? { fg: 'red' } : DIM }]));
    first = false;
  }
  const shown = pv.lines.slice(0, limit);
  for (const l of shown) {
    if (first) {
      out.push(...resultLine(l.runs));
      first = false;
    } else out.push(...bodyLine(l.runs));
  }
  const rest = pv.lines.length - shown.length;
  if (rest > 0) {
    const more: StyledRun[] = [{ text: `… +${rest} line${rest === 1 ? '' : 's'} (o to expand)`, style: DIM }];
    out.push(...(first ? resultLine(more) : bodyLine(more)));
    first = false;
  }
  if (first) out.push(...resultLine([{ text: pv.headline ?? '(No output)', style: DIM }]));
  return out;
}

function renderCommand(b: Extract<Block, { kind: 'command' }>, turn: Turn, bi: number, o: RenderOptions, g: Glyphs): RenderedLine[] {
  const text = `${b.name}${b.args ? ` ${b.args}` : ''}`;
  const out = wrap([{ text, style: DIM }], `${g.prompt} `, '  ', o, DIM).map((w) => mk(w, 'user', turn.id, bi));
  if (out.length) out[0] = withTime(out[0]!, turn.ts, o.width, o.color);
  if (b.stdout !== undefined && o.tools !== 'hidden') {
    const lines = b.stdout.replace(/\n+$/, '').split('\n');
    const limit = o.tools === 'full' ? Infinity : COLLAPSED_LINES;
    const shown = lines.slice(0, limit);
    shown.forEach((l, i) => {
      const w = wrap([{ text: l, style: DIM }], i === 0 ? `  ${g.elbow}  ` : '     ', '     ', o, DIM, undefined, true);
      out.push(...w.map((x) => mk(x, 'tool-result', turn.id, bi)));
    });
    if (lines.length > shown.length) {
      const w = wrap([{ text: `… +${lines.length - shown.length} lines (o to expand)`, style: DIM }], '     ', '     ', o);
      out.push(...w.map((x) => mk(x, 'tool-result', turn.id, bi)));
    }
    if (shown.length === 0) out.push(...wrap([{ text: '(no content)', style: DIM }], `  ${g.elbow}  `, '     ', o, DIM).map((x) => mk(x, 'tool-result', turn.id, bi)));
  }
  return out;
}

function renderNotice(text: string, subtype: string, turn: Turn, bi: number, o: RenderOptions, g: Glyphs): RenderedLine[] {
  if (subtype === 'compact_boundary') {
    const label = ` ${text} `;
    const side = Math.max(2, Math.floor((o.width - displayWidth(label)) / 2));
    const runs: StyledRun[] = [{ text: `${g.rule.repeat(side)}${label}${g.rule.repeat(Math.max(0, o.width - side - displayWidth(label)))}`, style: DIM }];
    return wrap(runs, '', '', o, undefined, undefined, true).map((w) => mk(w, 'notice', turn.id, bi));
  }
  return wrap([{ text, style: { dim: true, italic: true } }], '· ', '  ', o, DIM).map((w) => mk(w, 'notice', turn.id, bi));
}

/** Render one turn to lines (including one trailing blank line). Returns [] when filtered out. */
export function renderTurn(turn: Turn, o: RenderOptions): RenderedLine[] {
  const g = o.ascii ? ASCII : UNICODE;
  if (turn.meta.hidden) {
    if (!o.showMeta) return [];
    const text = turn.blocks
      .map((b) => (b.kind === 'text' ? b.text : b.kind === 'notice' ? b.text : `[${b.kind}]`))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    const l = wrap([{ text: `meta ${turn.role}: ${truncateToWidth(text, Math.max(10, o.width - 12))}`, style: { dim: true, italic: true } }], '· ', '  ', o, DIM);
    return [...l.map((w) => mk(w, 'meta', turn.id, -1)), blankLine(turn.id)];
  }
  if (o.hideToolOnly && isToolOnlyTurn(turn)) return [];

  const out: RenderedLine[] = [];
  let firstText = true;
  const sep = (): void => {
    // Claude Code separates each ⏺ item (text / tool call) with a blank line
    if (out.length && out[out.length - 1]!.kind !== 'blank') out.push(blankLine(turn.id));
  };
  turn.blocks.forEach((b, bi) => {
    if (turn.role === 'assistant' && (b.kind === 'tool_call' || (b.kind === 'text' && b.text.trim()))) sep();
    switch (b.kind) {
      case 'text':
        if (turn.role === 'user') out.push(...renderUserText(b.text, turn, bi, o, g));
        else if (turn.role === 'assistant') {
          const lines = renderAssistantText(b.text, turn, bi, o, g, firstText);
          if (lines.length) firstText = false;
          out.push(...lines);
        } else out.push(...renderNotice(b.text, 'system', turn, bi, o, g));
        break;
      case 'thinking': {
        if (!o.thinking && !b.text.trim()) break;
        out.push(...renderThinking(b.text, turn, bi, o, g));
        break;
      }
      case 'tool_call':
        out.push(...renderToolCall(b.call, turn, bi, o, g));
        break;
      case 'image':
        out.push(...wrap([{ text: `[image ${b.mediaType}, ${Math.max(1, Math.round(b.bytes / 1024))} KB]`, style: DIM }], turn.role === 'user' ? `${g.prompt} ` : '  ', '  ', o, DIM).map((w) => mk(w, turn.role === 'user' ? 'user' : 'assistant', turn.id, bi)));
        break;
      case 'command':
        out.push(...renderCommand(b, turn, bi, o, g));
        break;
      case 'notice':
        out.push(...renderNotice(b.text, b.subtype, turn, bi, o, g));
        break;
      case 'interrupted':
        out.push(...wrap([{ text: 'Interrupted by user', style: { fg: 'red' } }], `  ${g.elbow}  `, '     ', o, { fg: 'red' }).map((w) => mk(w, 'notice', turn.id, bi)));
        break;
      case 'unknown': {
        let raw = '';
        try {
          raw = JSON.stringify(b.raw);
        } catch {
          raw = String(b.raw);
        }
        out.push(...wrap([{ text: `[${b.type}] ${truncateToWidth(raw, 200)}`, style: DIM }], '  ', '  ', o).map((w) => mk(w, 'meta', turn.id, bi)));
        break;
      }
    }
  });
  if (out.length === 0) return [];
  // collapse multiple trailing blanks, then add exactly one separator
  while (out.length && out[out.length - 1]!.kind === 'blank') out.pop();
  out.push(blankLine(turn.id));
  return out;
}

export function filterHash(o: RenderOptions): string {
  return `${o.width}|${o.thinking ? 1 : 0}|${o.tools}|${o.hideToolOnly ? 1 : 0}|${o.showMeta ? 1 : 0}|${o.color ? 1 : 0}|${o.live ? 1 : 0}|${o.ascii ? 1 : 0}`;
}
