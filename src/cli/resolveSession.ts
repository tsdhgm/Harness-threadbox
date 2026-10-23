import type { SessionIndexEntry } from '../core/types.js';
import type { CliContext } from './context.js';

export async function resolveSessionArg(ctx: CliContext, arg: string | undefined): Promise<SessionIndexEntry> {
  await ctx.store.scan();
  const all = ctx.store.entryList();
  const a = arg ?? 'latest';
  for (const p of ctx.providers) {
    const e = await p.resolveArg(a, all.filter((x) => x.ref.provider === p.id));
    if (e) return e;
  }
  throw new Error(`session not found: ${a}`);
}
