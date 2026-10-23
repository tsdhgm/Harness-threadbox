import { SessionLineCache } from '../render/lineCache.js';
import { refKey } from '../core/sessionStore.js';
import type { ParsedArgs } from './args.js';
import { flagBool } from './args.js';
import { createContext } from './context.js';
import { renderOptionsFromArgs } from './renderOpts.js';
import { resolveSessionArg } from './resolveSession.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function catCommand(args: ParsedArgs): Promise<number> {
  const ctx = createContext(args);
  const entry = await resolveSessionArg(ctx, args.positional[0]);
  const isTTY = process.stdout.isTTY === true;
  const width = process.stdout.columns && isTTY ? process.stdout.columns : 100;
  const opts = renderOptionsFromArgs(args, entry, isTTY, width);
  const session = await ctx.store.load(entry);
  const cache = new SessionLineCache(session);
  opts.live = session.index.live !== null;
  cache.ensure(opts);
  const out = process.stdout;
  let printed = 0;
  const writeFrom = (from: number): void => {
    const total = cache.total();
    const chunks: string[] = [];
    for (let i = from; i < total; i++) {
      const l = cache.lineAt(i)!;
      chunks.push(`${l.ansi}\n`);
    }
    out.write(chunks.join(''));
    printed = total;
  };
  writeFrom(0);
  if (!flagBool(args.flags, 'follow')) return 0;

  // follow mode: poll the reader, re-render changed turns, rewrite from the first changed line
  const key = refKey(entry.ref);
  for (;;) {
    await sleep(400);
    const live = await ctx.claude.liveStates();
    const nowLive = live.has(entry.ref.sessionId);
    if (nowLive !== opts.live) {
      opts.live = nowLive;
      session.index.live = live.get(entry.ref.sessionId) ?? null;
    }
    const loaded = ctx.store.peekSession(key);
    if (!loaded) break;
    // pull via the store's reader
    const d = await (ctx.store as unknown as { loaded: { peek: (k: string) => { reader: { pull: () => Promise<{ kind: string; changedTurnIds?: string[] }> } } | undefined } }).loaded.peek(key)?.reader.pull();
    if (!d || d.kind === 'none') {
      if (!nowLive) continue;
      continue;
    }
    let firstChanged = Infinity;
    if (d.kind === 'reset') firstChanged = 0;
    else for (const id of d.changedTurnIds ?? []) firstChanged = Math.min(firstChanged, cache.lineIndexOfTurn(id) ?? Infinity);
    cache.ensure(opts);
    if (firstChanged === Infinity) firstChanged = printed;
    if (firstChanged < printed) {
      if (isTTY) {
        const up = printed - firstChanged;
        out.write(`\x1b[${up}A\x1b[J`);
        writeFrom(firstChanged);
      } else {
        // non-TTY: cannot rewrite; append only new lines
        writeFrom(printed);
      }
    } else writeFrom(printed);
  }
  return 0;
}
