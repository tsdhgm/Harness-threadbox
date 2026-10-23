import type { Block, Session, ToolCall, Turn } from '../core/types.js';
import { sessionLabel } from '../core/types.js';
import { summarizeClaudeTool } from './toolSummary.js';

function iso(ts: number | undefined): string {
  return ts === undefined ? '' : new Date(ts).toISOString();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fence(body: string, lang = ''): string[] {
  // choose a fence longer than any backtick run inside
  const runs = body.match(/`+/g) ?? [];
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
  const f = '`'.repeat(Math.max(3, longest + 1));
  return [`${f}${lang}`, body, f];
}

function toolCallMd(call: ToolCall, cwd: string): string[] {
  const s = summarizeClaudeTool(call, cwd);
  const label = `${s.verb}${s.arg ? `(${s.arg})` : ''}${s.tag ? ` ${s.tag}` : ''}`;
  const out: string[] = [];
  out.push('<details>');
  out.push(`<summary>${escapeHtml(label)} · ${call.status}</summary>`);
  out.push('');
  let input = '';
  try {
    input = JSON.stringify(call.input ?? {}, null, 2);
  } catch {
    input = String(call.input);
  }
  out.push(...fence(input, 'json'));
  if (call.result) {
    out.push('');
    out.push(`**result**${call.result.isError ? ' (error)' : ''}:`);
    out.push('');
    const st = call.structured as { structuredPatch?: unknown } | undefined;
    if ((call.name === 'Edit' || call.name === 'MultiEdit') && st && Array.isArray(st.structuredPatch)) {
      const lines: string[] = [];
      for (const h of st.structuredPatch as Array<{ lines?: string[] }>) if (Array.isArray(h.lines)) lines.push(...h.lines);
      out.push(...fence(lines.join('\n'), 'diff'));
    } else {
      out.push(...fence(call.result.text.replace(/\n+$/, '')));
    }
    if (call.result.persistedPath) out.push('', `_full output: ${call.result.persistedPath}_`);
  }
  out.push('</details>');
  out.push('');
  return out;
}

function blockMd(b: Block, turn: Turn, cwd: string): string[] {
  switch (b.kind) {
    case 'text':
      return b.text.trim() ? [b.text, ''] : [];
    case 'thinking':
      if (!b.text.trim()) return [];
      return ['<details><summary>Thinking</summary>', '', b.text, '', '</details>', ''];
    case 'tool_call':
      return toolCallMd(b.call, cwd);
    case 'image':
      return [`_[image ${b.mediaType}, ${Math.round(b.bytes / 1024)} KB]_`, ''];
    case 'command':
      return [`\`${b.name}${b.args ? ` ${b.args}` : ''}\``, '', ...(b.stdout ? [...fence(b.stdout.replace(/\n+$/, '')), ''] : [])];
    case 'notice':
      return [`_${b.text}_`, ''];
    case 'interrupted':
      return [`_${b.text}_`, ''];
    case 'unknown': {
      let raw = '';
      try {
        raw = JSON.stringify(b.raw, null, 2);
      } catch {
        raw = String(b.raw);
      }
      return [`<!-- block type: ${b.type} -->`, ...fence(raw, 'json'), ''];
    }
  }
}

export interface ExportOptions {
  includeMeta?: boolean;
}

export function sessionToMarkdown(s: Session, opts: ExportOptions = {}): string {
  const idx = s.index;
  const lines: string[] = [];
  lines.push(`# ${sessionLabel(idx)}`);
  lines.push('');
  lines.push(`- **Session**: \`${idx.ref.sessionId}\``);
  if (idx.project.cwd) lines.push(`- **cwd**: \`${idx.project.cwd}\``);
  if (idx.gitBranch) lines.push(`- **Branch**: \`${idx.gitBranch}\``);
  if (idx.startedAt !== undefined) lines.push(`- **Started**: ${iso(idx.startedAt)}`);
  if (idx.updatedAt !== undefined) lines.push(`- **Last update**: ${iso(idx.updatedAt)}`);
  if (idx.model) lines.push(`- **Model**: ${idx.model}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const t of s.turns) {
    if (t.meta.hidden && !opts.includeMeta) continue;
    const role = t.role === 'user' ? 'User' : t.role === 'assistant' ? 'Assistant' : 'System';
    const ts = t.ts !== undefined ? ` · ${iso(t.ts)}` : '';
    const body: string[] = [];
    for (const b of t.blocks) body.push(...blockMd(b, t, idx.project.cwd));
    if (body.length === 0) continue;
    lines.push(`## ${role}${ts}`);
    lines.push('');
    lines.push(...body);
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

export function sanitizeFilename(s: string): string {
  const t = s.replace(/[/\\?%*:|"<>]/g, '-').replace(/\s+/g, '_').trim();
  const name = t || 'session';
  return name.length > 80 ? name.slice(0, 80) : name;
}
