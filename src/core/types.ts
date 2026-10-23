/**
 * Provider-agnostic, normalized session model.
 * Everything in render/ and tui/ depends only on this file.
 */

export interface SessionRef {
  /** provider id, e.g. "claude" */
  provider: string;
  sessionId: string;
  /** absolute path of the primary log file */
  path: string;
  /** opaque project key (for claude: encoded project dir name) */
  projectKey: string;
}

export interface ProjectInfo {
  key: string;
  /** real working directory, as recorded in the logs ("" if unknown) */
  cwd: string;
  /** short display name (basename of cwd, or key) */
  name: string;
}

export type LiveStatus = 'busy' | 'idle' | 'unknown';

export interface LiveState {
  pid: number;
  status: LiveStatus;
  startedAt?: number;
  source: 'registry' | 'mtime';
}

export interface SessionIndexEntry {
  ref: SessionRef;
  project: ProjectInfo;
  title?: string;
  firstPrompt?: string;
  /** epoch ms */
  startedAt?: number;
  /** epoch ms */
  updatedAt?: number;
  mtimeMs: number;
  sizeBytes: number;
  gitBranch?: string;
  version?: string;
  model?: string;
  live: LiveState | null;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export type Role = 'user' | 'assistant' | 'system';

export type ToolStatus = 'pending' | 'ok' | 'error';

export interface ToolResult {
  text: string;
  blocks?: Block[];
  isError: boolean;
  persistedPath?: string;
  truncated: boolean;
  ts?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  ts?: number;
  status: ToolStatus;
  result?: ToolResult;
  /** provider-specific structured result (claude: toolUseResult) */
  structured?: unknown;
  /** set when this call spawned a subagent (room for later nesting) */
  agent?: { agentId: string; description?: string };
}

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; call: ToolCall }
  | { kind: 'image'; mediaType: string; bytes: number }
  | { kind: 'command'; name: string; args: string; stdout?: string }
  | { kind: 'notice'; subtype: string; text: string }
  | { kind: 'interrupted'; text: string }
  | { kind: 'unknown'; type: string; raw: unknown };

export interface TurnMeta {
  model?: string;
  stopReason?: string;
  usage?: Usage;
  /** injected by the harness (claude: isMeta) */
  isMeta: boolean;
  /** not rendered unless showMeta */
  hidden: boolean;
  durationMs?: number;
}

export interface Turn {
  /** stable id (uuid of the first record) */
  id: string;
  role: Role;
  ts?: number;
  /** assistant: API message id used for chunk merge */
  messageId?: string;
  blocks: Block[];
  meta: TurnMeta;
  /** render cache invalidation flag */
  dirty: boolean;
}

export interface SubagentRef {
  agentId: string;
  path: string;
  toolUseId?: string;
  description?: string;
}

export interface ParseState {
  offset: number;
  recordCount: number;
  errorCount: number;
  skippedTypes: Map<string, number>;
}

export interface Session {
  ref: SessionRef;
  index: SessionIndexEntry;
  turns: Turn[];
  turnsByMessageId: Map<string, Turn>;
  toolCalls: Map<string, ToolCall>;
  orphanResults: ToolResult[];
  children: SubagentRef[];
  parse: ParseState;
  /** bumps on every change; used as a cache key */
  revision: number;
  /** uuids already ingested (duplicate defense) */
  seenUuids: Set<string>;
}

export function createSession(index: SessionIndexEntry): Session {
  return {
    ref: index.ref,
    index,
    turns: [],
    turnsByMessageId: new Map(),
    toolCalls: new Map(),
    orphanResults: [],
    children: [],
    parse: { offset: 0, recordCount: 0, errorCount: 0, skippedTypes: new Map() },
    revision: 0,
    seenUuids: new Set(),
  };
}

export function sessionLabel(e: SessionIndexEntry, max = 80): string {
  const t = e.title?.trim();
  if (t) return t;
  const p = (e.firstPrompt ?? '').replace(/\s+/g, ' ').trim();
  if (p) return p.length > max ? `${p.slice(0, max)}…` : p;
  return e.ref.sessionId.slice(0, 8);
}
