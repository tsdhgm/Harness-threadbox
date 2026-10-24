import type { ParsedArgs } from './args.js';
import { createContext } from './context.js';
import { resolveSessionArg } from './resolveSession.js';

/** Print the full session id (default: the most recent session) so it can be fed to `claude --resume`. */
export async function idCommand(args: ParsedArgs): Promise<number> {
  const ctx = createContext(args);
  const entry = await resolveSessionArg(ctx, args.positional[0]);
  process.stdout.write(`${entry.ref.sessionId}\n`);
  return 0;
}
