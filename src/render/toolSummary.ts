import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolCall } from '../core/types.js';
import type { ToolSummary } from '../core/provider.js';
import type { Style, StyledRun } from './ansi.js';

export interface PreviewLine {
  runs: StyledRun[];
}

export interface ToolPreview {
  /** short one-line status shown right after the elbow, e.g. "Read 120 lines" */
  headline?: string;
  /** body lines (already split), rendered dim unless styled */
  lines: PreviewLine[];
  /** true when `lines` are a diff (keep colors even when collapsed) */
  isDiff?: boolean;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function relPath(p: string, cwd: string): string {
  if (!cwd || !path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  if (rel && !rel.startsWith('..')) return rel;
  const home = process.env['HOME'] || os.homedir();
  if (home && p.startsWith(home + path.sep)) return `~${p.slice(home.length)}`;
  return p;
}

function firstLine(s: string, max = 200): string {
  const l = s.split('\n')[0] ?? '';
  return l.length > max ? `${l.slice(0, max)}…` : l;
}

function firstStringField(input: Record<string, unknown>): string {
  for (const k of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill', 'name']) {
    const v = input[k];
    if (typeof v === 'string' && v) return firstLine(v);
  }
  for (const v of Object.values(input)) if (typeof v === 'string' && v) return firstLine(v);
  return '';
}

/** Claude Code tool vocabulary -> label. */
export function summarizeClaudeTool(call: ToolCall, cwd: string): ToolSummary {
  const input = obj(call.input);
  const name = call.name;
  switch (name) {
    case 'Bash':
      return { verb: 'Bash', arg: firstLine(str(input['command']) ?? '') };
    case 'Edit':
    case 'MultiEdit':
      return { verb: 'Update', arg: relPath(str(input['file_path']) ?? '', cwd) };
    case 'Write':
      return { verb: 'Write', arg: relPath(str(input['file_path']) ?? '', cwd) };
    case 'Read': {
      const p = relPath(str(input['file_path']) ?? '', cwd);
      const off = num(input['offset']);
      const lim = num(input['limit']);
      const range = off !== undefined || lim !== undefined ? ` ${off ?? 0}..${off !== undefined && lim !== undefined ? off + lim : lim ?? ''}` : '';
      return { verb: 'Read', arg: `${p}${range}` };
    }
    case 'Grep': {
      const parts = [`pattern: "${str(input['pattern']) ?? ''}"`];
      if (str(input['path'])) parts.push(`path: ${relPath(str(input['path'])!, cwd)}`);
      if (str(input['glob'])) parts.push(`glob: ${str(input['glob'])}`);
      return { verb: 'Search', arg: parts.join(', ') };
    }
    case 'Glob':
      return { verb: 'Glob', arg: `${str(input['pattern']) ?? ''}${str(input['path']) ? ` in ${relPath(str(input['path'])!, cwd)}` : ''}` };
    case 'Agent':
    case 'Task': {
      const s: ToolSummary = { verb: 'Agent', arg: str(input['description']) ?? firstLine(str(input['prompt']) ?? '', 80) };
      const sub = str(input['subagent_type']);
      if (sub) s.tag = `[${sub}]`;
      return s;
    }
    case 'WebSearch':
      return { verb: 'Web Search', arg: `"${str(input['query']) ?? ''}"` };
    case 'WebFetch':
      return { verb: 'Fetch', arg: str(input['url']) ?? '' };
    case 'ToolSearch':
      return { verb: 'ToolSearch', arg: str(input['query']) ?? '' };
    case 'TodoWrite':
      return { verb: 'Todo', arg: '' };
    case 'Skill':
      return { verb: 'Skill', arg: `${str(input['skill']) ?? ''}${str(input['args']) ? ` ${str(input['args'])}` : ''}` };
    case 'AskUserQuestion':
      return { verb: 'Ask', arg: firstLine(JSON.stringify((input['questions'] as unknown[] | undefined)?.length ?? '') + ' question(s)') };
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return { verb: name, arg: '' };
    default: {
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        return { verb: parts.slice(2).join('__') || name, arg: firstStringField(input), tag: `[${parts[1] ?? 'mcp'}]` };
      }
      return { verb: name, arg: firstStringField(input) };
    }
  }
}

function splitLines(s: string): string[] {
  const t = s.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return t ? t.split('\n') : [];
}

function dimLines(lines: string[]): PreviewLine[] {
  return lines.map((l) => ({ runs: [{ text: l, style: { dim: true } }] }));
}

function diffLines(lines: string[]): PreviewLine[] {
  return lines.map((l) => {
    if (l.startsWith('+')) return { runs: [{ text: l, style: { fg: 'green' } }] };
    if (l.startsWith('-')) return { runs: [{ text: l, style: { fg: 'red' } }] };
    if (l.startsWith('@@')) return { runs: [{ text: l, style: { fg: 'cyan', dim: true } }] };
    return { runs: [{ text: l, style: { dim: true } }] };
  });
}

interface Hunk {
  oldStart?: number;
  newStart?: number;
  lines?: string[];
}

function patchPreview(structured: Record<string, unknown>): ToolPreview | undefined {
  const patch = structured['structuredPatch'];
  if (!Array.isArray(patch)) return undefined;
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  for (const h of patch as Hunk[]) {
    if (!h || !Array.isArray(h.lines)) continue;
    if (lines.length) lines.push(`@@ -${h.oldStart ?? '?'} +${h.newStart ?? '?'} @@`);
    // drop leading context lines beyond one, so the collapsed view starts at the change
    let firstChange = h.lines.findIndex((l) => l.startsWith('+') || l.startsWith('-'));
    if (firstChange < 0) firstChange = 0;
    const start = Math.max(0, firstChange - 1);
    for (let i = start; i < h.lines.length; i++) {
      const l = h.lines[i]!;
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
      lines.push(l);
    }
    for (let i = 0; i < start; i++) {
      const l = h.lines[i]!;
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return { headline: `Added ${added} line${added === 1 ? '' : 's'}, removed ${removed} line${removed === 1 ? '' : 's'}`, lines: diffLines(lines), isDiff: true };
}

/** Build the result preview for a Claude tool call (full content; the renderer collapses). */
export function previewClaudeTool(call: ToolCall, _cwd: string): ToolPreview {
  const input = obj(call.input);
  const st = obj(call.structured);
  const res = call.result;
  const text = res?.text ?? '';

  if (res?.isError) {
    return { lines: splitLines(text).map((l) => ({ runs: [{ text: l, style: { fg: 'red' } }] })) };
  }
  switch (call.name) {
    case 'Bash': {
      const out = str(st['stdout']);
      const err = str(st['stderr']);
      const lines: PreviewLine[] = [];
      if (out !== undefined || err !== undefined) {
        lines.push(...dimLines(splitLines(out ?? '')));
        const errStyle: Style = { fg: 'red', dim: true };
        if (err) lines.push(...splitLines(err).map((l) => ({ runs: [{ text: l, style: errStyle }] })));
      } else {
        lines.push(...dimLines(splitLines(text)));
      }
      const p: ToolPreview = { lines };
      if (st['interrupted'] === true) p.headline = 'Interrupted';
      else if (lines.length === 0) p.headline = '(No output)';
      if (res?.persistedPath) lines.unshift({ runs: [{ text: `full output: ${res.persistedPath}`, style: { dim: true, italic: true } }] });
      return p;
    }
    case 'Edit':
    case 'MultiEdit': {
      const pp = patchPreview(st);
      if (pp) return pp;
      return { lines: dimLines(splitLines(text)) };
    }
    case 'Write': {
      const content = str(input['content']) ?? '';
      const n = content ? content.split('\n').length : 0;
      const kind = str(st['type']) === 'update' ? 'Updated' : 'Wrote';
      return { headline: `${kind} ${n} line${n === 1 ? '' : 's'}`, lines: [] };
    }
    case 'Read': {
      const file = obj(st['file']);
      const n = num(file['numLines']) ?? splitLines(text).length;
      return { headline: `Read ${n} line${n === 1 ? '' : 's'}`, lines: [] };
    }
    case 'Grep':
    case 'Glob': {
      const lines = splitLines(text);
      const p: ToolPreview = { lines: dimLines(lines) };
      const nf = num(st['numFiles']) ?? num(st['numLines']);
      if (nf !== undefined) p.headline = `Found ${nf} ${call.name === 'Glob' ? 'file' : 'match'}${nf === 1 ? '' : call.name === 'Glob' ? 's' : 'es'}`;
      return p;
    }
    case 'TodoWrite': {
      const todos = input['todos'];
      if (Array.isArray(todos)) {
        return {
          lines: (todos as Array<Record<string, unknown>>).map((t) => {
            const status = str(t['status']) ?? '';
            const mark = status === 'completed' ? '☒' : status === 'in_progress' ? '◐' : '☐';
            return { runs: [{ text: `${mark} ${str(t['content']) ?? ''}`, style: status === 'completed' ? { dim: true, strike: true } : { dim: true } }] };
          }),
        };
      }
      return { lines: dimLines(splitLines(text)) };
    }
    default: {
      const lines = dimLines(splitLines(text));
      const p: ToolPreview = { lines };
      if (lines.length === 0) p.headline = '(No output)';
      if (res?.persistedPath) lines.unshift({ runs: [{ text: `full output: ${res.persistedPath}`, style: { dim: true, italic: true } }] });
      return p;
    }
  }
}
