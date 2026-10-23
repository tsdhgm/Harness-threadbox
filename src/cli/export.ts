import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionLabel } from '../core/types.js';
import { sanitizeFilename, sessionToMarkdown } from '../render/markdownExport.js';
import type { ParsedArgs } from './args.js';
import { flagBool, flagStr } from './args.js';
import { createContext } from './context.js';
import { resolveSessionArg } from './resolveSession.js';

export async function exportCommand(args: ParsedArgs): Promise<number> {
  const ctx = createContext(args);
  const entry = await resolveSessionArg(ctx, args.positional[0]);
  const session = await ctx.store.load(entry);
  const md = sessionToMarkdown(session, { includeMeta: flagBool(args.flags, 'show-meta') });
  const out = flagStr(args.flags, 'out');
  if (out === '-') {
    process.stdout.write(md);
    return 0;
  }
  const file = out ?? path.join(process.cwd(), `${sanitizeFilename(sessionLabel(entry))}.md`);
  await fs.promises.writeFile(file, md, 'utf8');
  process.stderr.write(`exported ${session.turns.length} turn(s) to ${file}\n`);
  return 0;
}
