import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/sessionStore.js';
import { App } from '../src/tui/app.js';
import { FakeTerminal } from '../src/tui/terminal.js';
import { FakeProvider } from './fakeProvider.js';
import { assistant, basicRecords, human, text, toJsonl } from './helpers.js';

const base = { thinking: false, tools: 'collapsed' as const, hideToolOnly: false, showMeta: false, color: false, ascii: false };

async function start(): Promise<{ app: App; io: FakeTerminal; fp: FakeProvider; done: Promise<number> }> {
  const fp = new FakeProvider();
  fp.add('s1', 'projA', toJsonl(basicRecords()));
  fp.add('s2', 'projA', toJsonl([human(0, 'second session prompt'), ...assistant(1, 'm', [text('reply two')])]));
  fp.add('s3', 'projB', toJsonl(basicRecords()), { live: true });
  const store = new SessionStore([fp]);
  await store.scan();
  const io = new FakeTerminal(120, 24);
  const app = new App(io, store, base);
  const done = app.run();
  await app.settle();
  return { app, io, fp, done };
}

describe('App (e2e with FakeTerminal)', () => {
  it('starts at the bottom of the live session in follow mode and syncs the left pane', async () => {
    const { app, io, done } = await start();
    const frame = app.snapshot();
    const status = frame[frame.length - 1]!;
    expect(status).toContain('FOLLOW');
    expect(status).toContain('LIVE');
    expect(status).toContain('s3');
    // left pane: s3 selected (marked with '>' in no-color mode)
    expect(frame.some((r) => r.startsWith('>') && r.includes('title s3'))).toBe(true);
    // right pane shows the end of s3
    expect(frame.some((r) => r.includes('変更が 2 件あります'))).toBe(true);
    io.feed('q');
    expect(await done).toBe(0);
  });

  it('scrolls across sessions with keys and jumps via Enter in the left pane', async () => {
    const { app, io, done } = await start();
    await app.feedKeys(['k'], io);
    expect(app.snapshot().at(-1)).not.toContain('FOLLOW');
    // page up repeatedly until we are in s2 (left selection must follow)
    for (let i = 0; i < 6; i++) await app.feedKeys(['PgUp'], io);
    let frame = app.snapshot();
    expect(frame.some((r) => r.startsWith('>') && (r.includes('title s2') || r.includes('title s1')))).toBe(true);
    await app.feedKeys(['Tab', 'g', 'Enter'], io);
    frame = app.snapshot();
    expect(frame.some((r) => r.includes('· s1 · /work/projA ━'))).toBe(true);
    expect(frame.at(-1)).toContain('L 1/');
    await app.feedKeys(['Tab', 'G'], io);
    expect(app.snapshot().at(-1)).toContain('FOLLOW');
    io.feed('q');
    await done;
  });

  it('follows live appends and supports search, filters and help', async () => {
    const { app, io, fp, done } = await start();
    fp.append('s3', toJsonl([human(60, 'late prompt'), ...assistant(61, 'mZ', [text('late reply text')])]));
    await app.settle();
    expect(app.snapshot().some((r) => r.includes('late reply text'))).toBe(true);
    await app.feedKeys(['/second session', 'Enter'], io);
    let frame = app.snapshot();
    expect(frame.some((r) => r.includes('second session prompt'))).toBe(true);
    expect(frame.some((r) => r.startsWith('>') && r.includes('title s2'))).toBe(true);
    await app.feedKeys(['o'], io);
    expect(app.snapshot().at(-1)).toContain('o:full');
    await app.feedKeys(['?'], io);
    frame = app.snapshot();
    expect(frame.some((r) => r.includes('hthreadbox — keys'))).toBe(true);
    await app.feedKeys(['Esc'], io);
    expect(app.snapshot().some((r) => r.includes('hthreadbox — keys'))).toBe(false);
    await app.feedKeys([']', ']'], io);
    io.feed('q');
    await done;
  });

  it('handles mouse clicks on the left pane and wheel on the right', async () => {
    const { app, io, done } = await start();
    const frame = app.snapshot();
    const y = frame.findIndex((r) => r.includes('title s1'));
    expect(y).toBeGreaterThanOrEqual(0);
    io.feed(`\x1b[<0;3;${y + 1}M`);
    io.feed(`\x1b[<0;3;${y + 1}m`);
    await app.settle();
    expect(app.snapshot().some((r) => r.includes('· s1 · /work/projA ━'))).toBe(true);
    io.feed('\x1b[<65;80;5M');
    await app.settle();
    expect(app.snapshot().at(-1)).toContain('L 4/');
    io.feed('q');
    await done;
  });
});
