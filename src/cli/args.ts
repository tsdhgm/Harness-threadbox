export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const BOOL_FLAGS = new Set([
  'help',
  'version',
  'no-color',
  'color',
  'ascii',
  'json',
  'live',
  'thinking',
  'follow',
  'f',
  'h',
  'V',
  'show-meta',
  'hide-tool-only',
  'debug',
]);

const SHORT: Record<string, string> = { f: 'follow', h: 'help', V: 'version', o: 'out', w: 'width', p: 'project' };

/** Minimal argv parser: first non-flag token is the command, --k v / --k=v / -k. */
export function parseArgs(argv: string[], commands: Set<string>): ParsedArgs {
  const out: ParsedArgs = { command: undefined, positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) out.flags[key] = a.slice(eq + 1);
      else if (BOOL_FLAGS.has(key)) out.flags[key] = true;
      else {
        const next = argv[i + 1];
        if (next !== undefined && (next === '-' || !next.startsWith('-'))) {
          out.flags[key] = next;
          i++;
        } else out.flags[key] = true;
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const short = a.slice(1);
      const key = SHORT[short] ?? short;
      if (BOOL_FLAGS.has(short) || BOOL_FLAGS.has(key)) out.flags[key] = true;
      else {
        const next = argv[i + 1];
        if (next !== undefined && (next === '-' || !next.startsWith('-'))) {
          out.flags[key] = next;
          i++;
        } else out.flags[key] = true;
      }
      continue;
    }
    if (out.command === undefined && commands.has(a)) out.command = a;
    else out.positional.push(a);
  }
  return out;
}

export function flagStr(f: ParsedArgs['flags'], key: string): string | undefined {
  const v = f[key];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(f: ParsedArgs['flags'], key: string): boolean {
  return f[key] === true || f[key] === 'true';
}

export function flagNum(f: ParsedArgs['flags'], key: string): number | undefined {
  const v = f[key];
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function useColor(f: ParsedArgs['flags'], isTTY: boolean): boolean {
  if (flagBool(f, 'no-color')) return false;
  if (flagBool(f, 'color')) return true;
  if (process.env['NO_COLOR']) return false;
  if (process.env['FORCE_COLOR'] && process.env['FORCE_COLOR'] !== '0') return true;
  return isTTY;
}
