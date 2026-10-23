/**
 * Loose raw record types for Claude Code JSONL. Deliberately open: upstream adds
 * types frequently; we type-guard the few we render and ignore the rest.
 */

export interface RawTextBlock { type: 'text'; text: string }
export interface RawThinkingBlock { type: 'thinking'; thinking?: string; signature?: string }
export interface RawToolUseBlock { type: 'tool_use'; id: string; name: string; input: unknown }
export interface RawToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | RawBlock[];
  is_error?: boolean;
}
export interface RawImageBlock {
  type: 'image';
  source?: { type?: string; media_type?: string; data?: string; url?: string };
}
export interface RawUnknownBlock { type: string; [k: string]: unknown }
export type RawBlock =
  | RawTextBlock
  | RawThinkingBlock
  | RawToolUseBlock
  | RawToolResultBlock
  | RawImageBlock
  | RawUnknownBlock;

export interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [k: string]: unknown;
}

export interface RawMessage {
  role?: string;
  content?: string | RawBlock[];
  model?: string;
  id?: string;
  stop_reason?: string | null;
  usage?: RawUsage;
  [k: string]: unknown;
}

export interface RawRecordBase {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  userType?: string;
  agentId?: string;
  [k: string]: unknown;
}

export interface RawUserRecord extends RawRecordBase {
  type: 'user';
  message: RawMessage;
  toolUseResult?: unknown;
  origin?: { kind?: string };
  promptSource?: string;
}

export interface RawAssistantRecord extends RawRecordBase {
  type: 'assistant';
  message: RawMessage;
  requestId?: string;
  apiBlockIndex?: number;
}

export interface RawSystemRecord extends RawRecordBase {
  type: 'system';
  subtype?: string;
  content?: string;
  durationMs?: number;
}

export interface RawAiTitleRecord extends RawRecordBase {
  type: 'ai-title';
  aiTitle: string;
}

export type RawRecord =
  | RawUserRecord
  | RawAssistantRecord
  | RawSystemRecord
  | RawAiTitleRecord
  | RawRecordBase;

export function isUserRecord(r: RawRecord): r is RawUserRecord {
  return r.type === 'user' && typeof (r as RawUserRecord).message === 'object' && (r as RawUserRecord).message !== null;
}
export function isAssistantRecord(r: RawRecord): r is RawAssistantRecord {
  return r.type === 'assistant' && typeof (r as RawAssistantRecord).message === 'object' && (r as RawAssistantRecord).message !== null;
}
export function isSystemRecord(r: RawRecord): r is RawSystemRecord {
  return r.type === 'system';
}
export function isAiTitleRecord(r: RawRecord): r is RawAiTitleRecord {
  return r.type === 'ai-title' && typeof (r as RawAiTitleRecord).aiTitle === 'string';
}

export function parseTs(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a JSONL line; returns undefined on failure. */
export function parseLine(line: string): RawRecord | undefined {
  const t = line.trim();
  if (!t) return undefined;
  try {
    const v = JSON.parse(t) as unknown;
    if (v && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string') {
      return v as RawRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
