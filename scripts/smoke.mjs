#!/usr/bin/env node
// Real-data smoke test: runs the built CLI against ~/.claude (skips when absent).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const projects = path.join(root, 'projects');
if (!fs.existsSync(projects)) {
  console.log(`smoke: ${projects} not found, skipping`);
  process.exit(0);
}
const cli = path.join(import.meta.dirname, '..', 'dist', 'cli.js');
if (!fs.existsSync(cli)) {
  console.error('smoke: dist/cli.js missing — run `npm run build` first');
  process.exit(1);
}
const run = (args, opts = {}) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 1 << 28, ...opts });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const list = JSON.parse(run(['list', '--json']));
check('list --json returns entries', Array.isArray(list) && list.length >= 1, `${list.length} sessions`);

const t0 = Date.now();
const out = run(['cat', 'latest', '--no-color', '--width', '100']);
const dt = Date.now() - t0;
const lines = out.split('\n');
check('cat latest exits 0 and prints lines', lines.length > 3, `${lines.length} lines in ${dt}ms`);
check('cat output contains transcript glyphs', out.includes('⏺') || out.includes('> '), '');
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const width = (s) => {
  let n = 0;
  for (const g of segmenter.segment(s)) {
    const cp = g.segment.codePointAt(0);
    n += cp >= 0x1100 && /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|[\u{20000}-\u{3fffd}]/u.test(g.segment) ? 2 : 1;
  }
  return n;
};
const tooWide = lines.filter((l) => width(l) > 100);
check('no line wider than 100 columns', tooWide.length === 0, tooWide.length ? JSON.stringify(tooWide[0].slice(0, 60)) : '');

const biggest = [...list].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
if (biggest) {
  const t1 = Date.now();
  run(['cat', biggest.ref.sessionId, '--no-color', '--width', '120']);
  const d = Date.now() - t1;
  check('largest session renders in < 5s', d < 5000, `${(biggest.sizeBytes / 1048576).toFixed(1)}MB in ${d}ms`);
}

const md = run(['export', 'latest', '-o', '-']);
check('export produces markdown', md.startsWith('# ') && md.includes('## '), `${md.length} chars`);

const id = run(['id']).trim();
check('id prints a session id', /^[0-9a-f-]{8,}$/.test(id), id);

const frames = run(['--frames', '2', '--size', '120x30', '--keys', 'k']);
check('--frames renders two frames', frames.includes('---frame 0---') && frames.includes('---frame 1---'));

process.exit(failures ? 1 : 0);
