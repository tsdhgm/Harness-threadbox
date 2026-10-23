import { sessionLabel } from '../core/types.js';
import { fmtDateTime } from '../render/transcript.js';
import { displayWidth, padToWidth, truncateToWidth } from '../render/width.js';
import type { ParsedArgs } from './args.js';
import { flagBool } from './args.js';
import { createContext } from './context.js';

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export async function listCommand(args: ParsedArgs): Promise<number> {
  const ctx = createContext(args);
  await ctx.store.scan();
  let entries = ctx.store.order();
  if (flagBool(args.flags, 'live')) entries = entries.filter((e) => e.live);
  if (flagBool(args.flags, 'json')) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }
  const width = process.stdout.columns ?? 120;
  const projW = Math.min(24, Math.max(8, ...entries.map((e) => displayWidth(e.project.name))));
  for (const e of entries) {
    const live = e.live ? (e.live.status === 'busy' ? 'LIVE*' : 'LIVE ') : '     ';
    const date = fmtDateTime(e.updatedAt ?? e.mtimeMs);
    const proj = padToWidth(truncateToWidth(e.project.name, projW), projW);
    const size = padToWidth(fmtSize(e.sizeBytes), 7);
    const id = e.ref.sessionId.slice(0, 8);
    const fixed = `${live} ${date}  ${proj}  ${size} ${id}  `;
    const title = truncateToWidth(sessionLabel(e), Math.max(10, width - displayWidth(fixed)));
    process.stdout.write(`${fixed}${title}\n`);
  }
  return 0;
}
