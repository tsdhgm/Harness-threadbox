#!/usr/bin/env node
import { createRequire } from 'node:module';
import { parseArgs } from './cli/args.js';

const COMMANDS = new Set(['tui', 'cat', 'export', 'list', 'help']);

const HELP = `hthreadbox — console viewer for AI coding-harness session logs (Claude Code)

Usage:
  hthreadbox [tui] [--claude-dir DIR] [--project PATH] [--ascii]
  hthreadbox cat <session> [--no-color] [--tools full|collapsed|hidden] [--thinking] [--width N] [-f]
  hthreadbox export <session> [-o FILE | -o -] [--show-meta]
  hthreadbox list [--json] [--live]

<session>: session id, unique id prefix, path to a .jsonl, "latest" (default) or "live".

Options:
  --claude-dir DIR   Claude config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  --project PATH     only sessions of this project directory
  --ascii            use ASCII glyphs instead of ⏺ ⎿ ✻
  --no-color         disable ANSI colors (also NO_COLOR)
  --frames N         (debug) render N TUI frames to stdout; with --size WxH --keys k1,k2,...
  -h, --help         show help
  -V, --version      show version
`;

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv, COMMANDS);
  if (args.flags['help'] === true || args.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.flags['version'] === true) {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  switch (args.command) {
    case 'cat':
      return (await import('./cli/cat.js')).catCommand(args);
    case 'list':
      return (await import('./cli/list.js')).listCommand(args);
    case 'export':
      return (await import('./cli/export.js')).exportCommand(args);
    case 'tui':
    case undefined:
      return (await import('./tui/app.js')).runTui(args);
    default:
      process.stderr.write(`unknown command: ${args.command}\n${HELP}`);
      return 2;
  }
}

// piping into `head` etc. closes stdout early: exit quietly instead of crashing
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`hthreadbox: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
