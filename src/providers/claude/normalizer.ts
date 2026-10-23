import type { Block, Session, ToolCall, ToolResult, Turn, Usage } from '../../core/types.js';
import {
  type RawAssistantRecord,
  type RawBlock,
  type RawRecord,
  type RawSystemRecord,
  type RawUserRecord,
  isAiTitleRecord,
  isAssistantRecord,
  isSystemRecord,
  isUserRecord,
  parseTs,
} from './rawTypes.js';

const MAX_RESULT_TEXT = 256 * 1024;

/** Record types we deliberately drop (counted in skippedTypes). */
const DROP_TYPES = new Set([
  'attachment',
  'mode',
  'permission-mode',
  'atis-latch',
  'last-prompt',
  'file-history-snapshot',
  'file-history-delta',
  'cost-state',
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'queue-operation',
  'summary',
  'result',
]);

/** system subtypes rendered as visible notices; others become hidden notices */
const VISIBLE_SYSTEM_SUBTYPES = new Set(['compact_boundary', 'informational', 'away_summary']);

const RE_SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const RE_LOCAL_CAVEAT = /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g;
const RE_PERSISTED = /<persisted-output>[\s\S]*?Full output saved to:\s*(\S+)/;

export interface IngestResult {
  /** turn ids whose rendering changed */
  changed: string[];
}

export function stripInjected(text: string): string {
  return text.replace(RE_SYSTEM_REMINDER, '').replace(RE_LOCAL_CAVEAT, '').trim();
}

function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`).exec(text);
  return m ? m[1]!.trim() : undefined;
}

/** Text of a genuine human prompt, or undefined for wrappers / tool results. */
export function humanPromptText(r: RawUserRecord): string | undefined {
  const c = r.message.content;
  if (typeof c === 'string') {
    if (c.includes('<command-name>') || c.includes('<local-command-stdout>')) return undefined;
    if (c.startsWith('<task-notification>') || c.startsWith('<agent-message')) return undefined;
    if (/^\[Request interrupted/.test(c)) return undefined;
    const t = stripInjected(c);
    return t || undefined;
  }
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const b of c) {
      if (b && typeof b === 'object' && b.type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
        const t = stripInjected((b as { text: string }).text);
        if (t) parts.push(t);
      }
    }
    const joined = parts.join(' ').trim();
    return joined || undefined;
  }
  return undefined;
}

function toUsage(u: RawAssistantRecord['message']['usage']): Usage | undefined {
  if (!u) return undefined;
  const out: Usage = {};
  if (typeof u.input_tokens === 'number') out.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') out.outputTokens = u.output_tokens;
  if (typeof u.cache_creation_input_tokens === 'number') out.cacheCreationInputTokens = u.cache_creation_input_tokens;
  if (typeof u.cache_read_input_tokens === 'number') out.cacheReadInputTokens = u.cache_read_input_tokens;
  return out;
}

function bump(s: Session, type: string): void {
  s.parse.skippedTypes.set(type, (s.parse.skippedTypes.get(type) ?? 0) + 1);
}

function newTurn(id: string, role: Turn['role'], ts: number | undefined, hidden = false, isMeta = false): Turn {
  const t: Turn = { id, role, blocks: [], meta: { isMeta, hidden }, dirty: true };
  if (ts !== undefined) t.ts = ts;
  return t;
}

function lastTurn(s: Session): Turn | undefined {
  return s.turns[s.turns.length - 1];
}

function imageBytes(b: RawBlock): { mediaType: string; bytes: number } {
  const src = (b as { source?: { media_type?: string; data?: string } }).source;
  const data = src?.data ?? '';
  return { mediaType: src?.media_type ?? 'image', bytes: Math.floor((data.length * 3) / 4) };
}

/** Convert tool_result content (string | blocks) to a ToolResult. */
function toToolResult(content: unknown, isError: boolean, ts: number | undefined): ToolResult {
  let text = '';
  let blocks: Block[] | undefined;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    blocks = [];
    for (const b of content as RawBlock[]) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
        parts.push((b as { text: string }).text);
        blocks.push({ kind: 'text', text: (b as { text: string }).text });
      } else if (b.type === 'image') {
        const im = imageBytes(b);
        blocks.push({ kind: 'image', ...im });
        parts.push(`[image ${im.mediaType}, ${Math.round(im.bytes / 1024)} KB]`);
      } else {
        blocks.push({ kind: 'unknown', type: b.type, raw: b });
      }
    }
    text = parts.join('\n');
  } else if (content !== undefined && content !== null) {
    try {
      text = JSON.stringify(content, null, 2);
    } catch {
      text = String(content);
    }
  }
  let truncated = false;
  if (text.length > MAX_RESULT_TEXT) {
    text = text.slice(0, MAX_RESULT_TEXT);
    truncated = true;
  }
  const r: ToolResult = { text, isError, truncated };
  if (blocks) r.blocks = blocks;
  const m = RE_PERSISTED.exec(text);
  if (m) r.persistedPath = m[1]!;
  if (ts !== undefined) r.ts = ts;
  return r;
}

function ingestAssistant(s: Session, r: RawAssistantRecord, changed: string[]): void {
  const ts = parseTs(r.timestamp);
  const mid = typeof r.message.id === 'string' ? r.message.id : undefined;
  let turn: Turn | undefined;
  if (mid) {
    const existing = s.turnsByMessageId.get(mid);
    // Merge only when no human turn was inserted after it (keeps display order sane).
    if (existing) {
      const last = lastTurn(s);
      if (last === existing || (last && last.role !== 'user')) turn = existing;
      else if (last) {
        // find existing among the tail; merge if only system/hidden turns follow it
        let ok = true;
        for (let i = s.turns.length - 1; i >= 0; i--) {
          const t = s.turns[i]!;
          if (t === existing) break;
          if (t.role === 'user' && !t.meta.hidden) {
            ok = false;
            break;
          }
        }
        if (ok) turn = existing;
      }
    }
  }
  if (!turn) {
    turn = newTurn(r.uuid ?? `${s.turns.length}`, 'assistant', ts);
    if (mid) turn.messageId = mid;
    if (typeof r.message.model === 'string') turn.meta.model = r.message.model;
    s.turns.push(turn);
    if (mid) s.turnsByMessageId.set(mid, turn);
  }
  const content = r.message.content;
  if (typeof content === 'string') {
    if (content.trim()) turn.blocks.push({ kind: 'text', text: content });
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      switch (b.type) {
        case 'text':
          turn.blocks.push({ kind: 'text', text: String((b as { text?: unknown }).text ?? '') });
          break;
        case 'thinking':
          turn.blocks.push({ kind: 'thinking', text: String((b as { thinking?: unknown }).thinking ?? '') });
          break;
        case 'redacted_thinking':
          turn.blocks.push({ kind: 'thinking', text: '' });
          break;
        case 'tool_use': {
          const tb = b as { id?: unknown; name?: unknown; input?: unknown };
          const id = typeof tb.id === 'string' ? tb.id : `anon-${s.toolCalls.size}`;
          const call: ToolCall = {
            id,
            name: typeof tb.name === 'string' ? tb.name : 'tool',
            input: tb.input,
            status: 'pending',
          };
          if (ts !== undefined) call.ts = ts;
          s.toolCalls.set(id, call);
          turn.blocks.push({ kind: 'tool_call', call });
          break;
        }
        default:
          turn.blocks.push({ kind: 'unknown', type: b.type, raw: b });
      }
    }
  }
  if (typeof r.message.stop_reason === 'string') turn.meta.stopReason = r.message.stop_reason;
  const usage = toUsage(r.message.usage);
  if (usage) turn.meta.usage = usage; // repeated per chunk: last wins, counted once
  if (!turn.meta.model && typeof r.message.model === 'string') turn.meta.model = r.message.model;
  turn.dirty = true;
  changed.push(turn.id);
}

function ingestUserString(s: Session, r: RawUserRecord, text: string, changed: string[]): void {
  const ts = parseTs(r.timestamp);
  const id = r.uuid ?? `${s.turns.length}`;

  if (/^\[Request interrupted/.test(text)) {
    const t = newTurn(id, 'user', ts);
    t.blocks.push({ kind: 'interrupted', text: text.trim() });
    s.turns.push(t);
    changed.push(t.id);
    return;
  }
  if (text.includes('<local-command-stdout>')) {
    const out = tag(text, 'local-command-stdout') ?? '';
    // attach to the last command block if there is one
    for (let i = s.turns.length - 1; i >= 0 && i >= s.turns.length - 3; i--) {
      const t = s.turns[i]!;
      const cmd = [...t.blocks].reverse().find((b) => b.kind === 'command');
      if (cmd && cmd.kind === 'command') {
        if (cmd.stdout === undefined) cmd.stdout = out;
        else cmd.stdout += `\n${out}`;
        t.dirty = true;
        changed.push(t.id);
        return;
      }
    }
    const t = newTurn(id, 'system', ts);
    t.blocks.push({ kind: 'notice', subtype: 'local-command-stdout', text: out || '(no content)' });
    s.turns.push(t);
    changed.push(t.id);
    return;
  }
  if (text.includes('<command-name>')) {
    const name = tag(text, 'command-name') ?? '/?';
    const args = tag(text, 'command-args') ?? '';
    const t = newTurn(id, 'user', ts);
    t.blocks.push({ kind: 'command', name, args });
    s.turns.push(t);
    changed.push(t.id);
    return;
  }
  if (text.startsWith('<task-notification>')) {
    const tid = tag(text, 'task-id') ?? '';
    const status = tag(text, 'status') ?? '';
    const summary = tag(text, 'summary') ?? '';
    const t = newTurn(id, 'system', ts, r.isMeta === true, r.isMeta === true);
    t.blocks.push({ kind: 'notice', subtype: 'task-notification', text: `task ${tid.slice(0, 8)} ${status}${summary ? `: ${summary}` : ''}` });
    s.turns.push(t);
    changed.push(t.id);
    return;
  }
  if (r.isMeta === true) {
    const t = newTurn(id, 'user', ts, true, true);
    t.blocks.push({ kind: 'text', text: stripInjected(text) || text });
    s.turns.push(t);
    changed.push(t.id);
    return;
  }
  const clean = stripInjected(text);
  if (!clean) {
    // only injected content: keep as hidden meta turn
    const t = newTurn(id, 'user', ts, true, true);
    t.blocks.push({ kind: 'text', text });
    s.turns.push(t);
    changed.push(t.id);
    return;
  }
  const t = newTurn(id, 'user', ts);
  t.blocks.push({ kind: 'text', text: clean });
  s.turns.push(t);
  changed.push(t.id);
}

function ingestUserArray(s: Session, r: RawUserRecord, blocks: RawBlock[], changed: string[]): void {
  const ts = parseTs(r.timestamp);
  const visible: Block[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_result') {
      const tb = b as { tool_use_id?: unknown; content?: unknown; is_error?: unknown };
      const result = toToolResult(tb.content, tb.is_error === true, ts);
      const call = typeof tb.tool_use_id === 'string' ? s.toolCalls.get(tb.tool_use_id) : undefined;
      if (call) {
        call.result = result;
        call.status = result.isError ? 'error' : 'ok';
        if (r.toolUseResult !== undefined) {
          call.structured = r.toolUseResult;
          const st = r.toolUseResult as { agentId?: unknown; description?: unknown } | null;
          if (st && typeof st === 'object' && typeof st.agentId === 'string') {
            call.agent = { agentId: st.agentId };
            if (typeof st.description === 'string') call.agent.description = st.description;
          }
        }
        // mark the owning turn dirty
        for (let i = s.turns.length - 1; i >= 0; i--) {
          const t = s.turns[i]!;
          if (t.blocks.some((x) => x.kind === 'tool_call' && x.call === call)) {
            t.dirty = true;
            changed.push(t.id);
            break;
          }
        }
      } else {
        s.orphanResults.push(result);
      }
    } else if (b.type === 'text') {
      const t = stripInjected(String((b as { text?: unknown }).text ?? ''));
      if (t) visible.push({ kind: 'text', text: t });
    } else if (b.type === 'image') {
      visible.push({ kind: 'image', ...imageBytes(b) });
    } else {
      visible.push({ kind: 'unknown', type: b.type, raw: b });
    }
  }
  if (visible.length > 0) {
    const t = newTurn(r.uuid ?? `${s.turns.length}`, 'user', ts, r.isMeta === true, r.isMeta === true);
    t.blocks.push(...visible);
    s.turns.push(t);
    changed.push(t.id);
  }
}

function ingestSystem(s: Session, r: RawSystemRecord, changed: string[]): void {
  const sub = r.subtype ?? 'system';
  if (sub === 'turn_duration') {
    for (let i = s.turns.length - 1; i >= 0; i--) {
      const t = s.turns[i]!;
      if (t.role === 'assistant') {
        if (typeof r.durationMs === 'number') t.meta.durationMs = r.durationMs;
        break;
      }
    }
    bump(s, 'system:turn_duration');
    return;
  }
  const ts = parseTs(r.timestamp);
  const visible = VISIBLE_SYSTEM_SUBTYPES.has(sub);
  const t = newTurn(r.uuid ?? `${s.turns.length}`, 'system', ts, !visible, r.isMeta === true);
  const text = sub === 'compact_boundary' ? 'Conversation compacted' : typeof r.content === 'string' ? stripInjected(r.content) : '';
  t.blocks.push({ kind: 'notice', subtype: sub, text: text || sub });
  s.turns.push(t);
  changed.push(t.id);
}

/**
 * Ingest one raw record into the session. Idempotent per uuid.
 * Returns ids of turns whose rendering changed.
 */
export function ingest(s: Session, r: RawRecord): IngestResult {
  const changed: string[] = [];
  s.parse.recordCount++;
  if (typeof r.uuid === 'string') {
    if (s.seenUuids.has(r.uuid)) return { changed };
    s.seenUuids.add(r.uuid);
  }
  if (r.isSidechain === true) {
    bump(s, 'sidechain');
    return { changed };
  }
  if (DROP_TYPES.has(r.type)) {
    bump(s, r.type);
    return { changed };
  }
  if (isAiTitleRecord(r)) {
    s.index.title = r.aiTitle.trim();
    s.revision++;
    return { changed };
  }
  if (isAssistantRecord(r)) {
    ingestAssistant(s, r, changed);
  } else if (isUserRecord(r)) {
    const c = r.message.content;
    if (typeof c === 'string') ingestUserString(s, r, c, changed);
    else if (Array.isArray(c)) ingestUserArray(s, r, c, changed);
    else bump(s, 'user:empty');
  } else if (isSystemRecord(r)) {
    ingestSystem(s, r, changed);
  } else {
    bump(s, r.type);
  }
  // keep index fresh
  const ts = parseTs(r.timestamp);
  if (ts !== undefined) {
    if (s.index.startedAt === undefined) s.index.startedAt = ts;
    if (s.index.updatedAt === undefined || ts > s.index.updatedAt) s.index.updatedAt = ts;
  }
  if (!s.index.project.cwd && typeof r.cwd === 'string') s.index.project.cwd = r.cwd;
  if (!s.index.gitBranch && typeof r.gitBranch === 'string' && r.gitBranch) s.index.gitBranch = r.gitBranch;
  if (changed.length > 0) s.revision++;
  return { changed };
}

/** True when the turn has no visible text and at least one tool call. */
export function isToolOnlyTurn(t: Turn): boolean {
  if (t.role !== 'assistant') return false;
  let hasTool = false;
  for (const b of t.blocks) {
    if (b.kind === 'text' && b.text.trim()) return false;
    if (b.kind === 'tool_call') hasTool = true;
  }
  return hasTool;
}
