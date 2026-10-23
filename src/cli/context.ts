import { ClaudeProvider } from '../providers/claude/index.js';
import { SessionStore } from '../core/sessionStore.js';
import type { Provider } from '../core/provider.js';
import { type ParsedArgs, flagStr } from './args.js';

export interface CliContext {
  providers: Provider[];
  store: SessionStore;
  claude: ClaudeProvider;
}

export function createContext(args: ParsedArgs, opts: { lruSize?: number } = {}): CliContext {
  const claude = new ClaudeProvider();
  const cfg: { rootDir?: string; projectFilter?: string } = {};
  const root = flagStr(args.flags, 'claude-dir');
  if (root) cfg.rootDir = root;
  const proj = flagStr(args.flags, 'project');
  if (proj) cfg.projectFilter = proj;
  claude.configure(cfg);
  const providers: Provider[] = [claude];
  const store = new SessionStore(providers, opts);
  return { providers, store, claude };
}
