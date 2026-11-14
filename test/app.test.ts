import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/sessionStore.js';
import { App } from '../src/tui/app.js';
import { FakeTerminal } from '../src/tui/terminal.js';
import { FakeProvider } from './fakeProvider.js';
import { assistant, basicRecords, human, text, toJsonl } from './helpers.js';

const base = { thinking: false, tools: 'collapsed' as const, hideToolOnly: false, showMeta: false, color: false, ascii: false };

async function start(rows = 24): Promise<{ app: App; io: FakeTerminal; fp: FakeProvider; done: Promise<number> }> {
  const fp = new FakeProvider();
  fp.add('s1', 'projA', toJsonl(basicRecords()));
  fp.add('s2', 'projA', toJsonl([human(0, 'second session prompt'), ...assistant(1, 'm', [text('reply two')])]));
  fp.add('s3', 'projB', toJsonl(basicRecords()), { live: true });
  const store = new SessionStore([fp]);
  await store.scan();
  const io = new FakeTerminal(120, rows);
  const app = new App(io, store, base);
  const done = app.run();
  await app.settle();
  return { app, io, fp, done };
}

/** Split a screen row into the three panes (no-color mode uses '│' dividers). */
function panes(row: string): { projects: string; sessions: string; right: string } {
  const d1 = row.indexOf('│');
  const d2 = row.indexOf('│', d1 + 1);
  return { projects: row.slice(0, d1), sessions: row.slice(d1 + 1, d2), right: row.slice(d2 + 1) };
}
const selectedProject = (frame: string[]): string | undefined => frame.map((r) => panes(r).projects).find((p) => p.startsWith('>'));
const selectedSession = (frame: string[]): string | undefined => frame.map((r) => panes(r).sessions).find((p) => p.startsWith('>'));
const sessionRows = (frame: string[]): string[] => frame.slice(0, -1).map((r) => panes(r).sessions);

describe('App (e2e with FakeTerminal, three panes)', () => {
  it('starts at the live session with its project selected and the middle pane scoped to it', async () => {
    const { app, io, done } = await start();
    const frame = app.snapshot();
    const status = frame[frame.length - 1]!;
    expect(status).toContain('FOLLOW');
    expect(status).toContain('LIVE');
    expect(status).toContain('s3');
    expect(selectedProject(frame)).toContain('projB');
    expect(selectedSession(frame)).toContain('title s3');
    // the middle pane lists only projB's sessions
    expect(sessionRows(frame).some((r) => r.includes('title s1'))).toBe(false);
    // right pane shows the end of s3
    expect(frame.some((r) => panes(r).right.includes('There are 2 changes'))).toBe(true);
    io.feed('q');
    expect(await done).toBe(0);
  });

  it('never scrolls out of the project; projects pane switches project; Enter in the sessions pane jumps', async () => {
    const { app, io, done } = await start();
    await app.feedKeys(['k'], io);
    expect(app.snapshot().at(-1)).not.toContain('FOLLOW');
    for (let i = 0; i < 6; i++) await app.feedKeys(['PgUp'], io);
    let frame = app.snapshot();
    // still in s3 (projB has only one session) at its first line
    expect(frame.at(-1)).toContain('s3');
    expect(frame.at(-1)).toContain('L 1/');
    expect(selectedProject(frame)).toContain('projB');
    // Tab → projects pane, k → projA: middle pane and transcript switch to projA, landing at the end of s2
    await app.feedKeys(['Tab', 'k'], io);
    frame = app.snapshot();
    expect(selectedProject(frame)).toContain('projA');
    expect(sessionRows(frame).some((r) => r.includes('title s1'))).toBe(true);
    expect(sessionRows(frame).some((r) => r.includes('title s3'))).toBe(false);
    expect(selectedSession(frame)).toContain('title s2');
    expect(frame.at(-1)).toContain('s2');
    // Tab → sessions pane, g Enter → s1 from its top
    await app.feedKeys(['Tab', 'g', 'Enter'], io);
    frame = app.snapshot();
    expect(frame.some((r) => panes(r).right.includes('· s1 · /work/projA ━'))).toBe(true);
    expect(frame.at(-1)).toContain('L 1/');
    // Tab → transcript, scrolling down crosses from s1 into s2 (same project) and syncs the selection
    for (let i = 0; i < 6; i++) await app.feedKeys(['PgDn'], io);
    frame = app.snapshot();
    expect(selectedSession(frame)).toContain('title s2');
    expect(selectedProject(frame)).toContain('projA');
    await app.feedKeys(['Tab', 'G'], io);
    expect(app.snapshot().at(-1)).toContain('FOLLOW');
    io.feed('q');
    await done;
  });

  it('follows live appends, L switches project, search stays within the project, filters and help work', async () => {
    const { app, io, fp, done } = await start();
    fp.append('s3', toJsonl([human(60, 'late prompt'), ...assistant(61, 'mZ', [text('late reply text')])]));
    await app.settle();
    expect(app.snapshot().some((r) => r.includes('late reply text'))).toBe(true);
    // search for text that exists only in projA: not found while projB is selected
    await app.feedKeys(['/second session', 'Enter'], io);
    expect(app.snapshot().at(-1)).toContain('no match in this project');
    // switch to projA via the projects pane, search again
    await app.feedKeys(['Tab', 'k', 'Tab', 'Tab'], io);
    await app.feedKeys(['/second session', 'Enter'], io);
    let frame = app.snapshot();
    expect(frame.some((r) => panes(r).right.includes('second session prompt'))).toBe(true);
    expect(selectedSession(frame)).toContain('title s2');
    // L jumps back to the live session in projB
    await app.feedKeys(['L'], io);
    frame = app.snapshot();
    expect(selectedProject(frame)).toContain('projB');
    expect(frame.some((r) => panes(r).right.includes('late reply text'))).toBe(true);
    await app.feedKeys(['o'], io);
    expect(app.snapshot().at(-1)).toContain('o:full');
    await app.feedKeys(['?'], io);
    frame = app.snapshot();
    expect(frame.some((r) => r.includes('hthreadbox — keys'))).toBe(true);
    await app.feedKeys(['Esc'], io);
    expect(app.snapshot().some((r) => r.includes('hthreadbox — keys'))).toBe(false);
    const before = app.layoutInfo();
    await app.feedKeys([']', ']'], io);
    expect(app.layoutInfo().sessions!.w).toBe(before.sessions!.w + 4);
    await app.feedKeys(['Shift-Tab', 'Shift-Tab', ']'], io);
    expect(app.layoutInfo().projects!.w).toBe(before.projects!.w + 2);
    io.feed('q');
    await done;
  });

  it('handles mouse clicks on the project and session panes and wheel on the transcript', async () => {
    // 11 transcript rows so that projA's two sessions (21 lines) do not fit and scrolling is possible
    const { app, io, done } = await start(12);
    let frame = app.snapshot();
    const lay = app.layoutInfo();
    const py = frame.findIndex((r) => panes(r).projects.includes('projA'));
    expect(py).toBeGreaterThanOrEqual(0);
    io.feed(`\x1b[<0;3;${py + 1}M\x1b[<0;3;${py + 1}m`);
    await app.settle();
    frame = app.snapshot();
    expect(selectedProject(frame)).toContain('projA');
    const sy = frame.findIndex((r) => panes(r).sessions.includes('title s1'));
    expect(sy).toBeGreaterThanOrEqual(0);
    const sx = lay.sessions!.x + 3;
    io.feed(`\x1b[<0;${sx};${sy + 1}M\x1b[<0;${sx};${sy + 1}m`);
    await app.settle();
    expect(app.snapshot().some((r) => panes(r).right.includes('· s1 · /work/projA ━'))).toBe(true);
    io.feed(`\x1b[<65;${lay.right.x + 10};5M`);
    await app.settle();
    expect(app.snapshot().at(-1)).toContain('L 4/');
    io.feed('q');
    await done;
  });

  it('shows the current session id in the projects pane footer and copies it with y / Y', async () => {
    const fp = new FakeProvider();
    fp.add('s1', 'projA', toJsonl(basicRecords()));
    fp.add('0123456789abcdef-0123-4567-89ab-cdef01234567', 'projB', toJsonl(basicRecords()), { live: true });
    const store = new SessionStore([fp]);
    await store.scan();
    const io = new FakeTerminal(120, 24);
    const copied: string[] = [];
    const app = new App(io, store, base, {
      clipboard: async (t) => {
        copied.push(t);
        return ['fake'];
      },
    });
    const done = app.run();
    await app.settle();
    // the 44-char id is wrapped over the 18-column projects pane
    const left = app.snapshot().map((r) => panes(r).projects.trimEnd());
    const joined = left.filter((r) => /^[0-9a-f-]+$/.test(r)).join('');
    expect(joined).toBe('0123456789abcdef-0123-4567-89ab-cdef01234567');
    await app.feedKeys(['y'], io);
    expect(copied).toEqual(['0123456789abcdef-0123-4567-89ab-cdef01234567']);
    expect(app.snapshot().at(-1)).toContain('copied: 0123456789abcdef');
    await app.feedKeys(['Y'], io);
    expect(copied.at(-1)).toBe('claude --resume 0123456789abcdef-0123-4567-89ab-cdef01234567');
    // in the sessions pane, y copies the *selected* session
    await app.feedKeys(['Tab', 'k', 'Tab', 'k', 'y'], io);
    expect(copied.at(-1)).toBe('s1');
    io.feed('q');
    await done;
  });

  it('follow modes: always jumps to the end on update, off never moves the view', async () => {
    const { app, io, fp, done } = await start(12);
    // auto (default): scrolling up detaches, an append does not move the view
    await app.feedKeys(['k', 'k'], io);
    const before = app.snapshot().at(-1)!;
    expect(before).not.toContain('FOLLOW');
    fp.append('s3', toJsonl([human(60, 'first late prompt'), ...assistant(61, 'mA', [text('first late reply')])]));
    await app.settle();
    expect(app.snapshot().some((r) => r.includes('first late reply'))).toBe(false);
    // F → always: lands at the end now, and every later append snaps back to the end even after scrolling up
    await app.feedKeys(['F'], io);
    expect(app.getFollowMode()).toBe('always');
    expect(app.snapshot().some((r) => r.includes('first late reply'))).toBe(true);
    await app.feedKeys(['k', 'k', 'k'], io);
    fp.append('s3', toJsonl([human(70, 'second late prompt'), ...assistant(71, 'mB', [text('second late reply')])]));
    await app.settle();
    let frame = app.snapshot();
    expect(frame.some((r) => r.includes('second late reply'))).toBe(true);
    // F → off: static; an append leaves the viewport exactly where it is
    await app.feedKeys(['F'], io);
    expect(app.getFollowMode()).toBe('off');
    await app.feedKeys(['k', 'k'], io);
    const still = app.snapshot().slice(0, -1).map((r) => panes(r).right);
    fp.append('s3', toJsonl([human(80, 'third late prompt'), ...assistant(81, 'mC', [text('third late reply')])]));
    await app.settle();
    frame = app.snapshot();
    expect(frame.slice(0, -1).map((r) => panes(r).right)).toEqual(still);
    // G in off mode shows the end but does not pin it
    await app.feedKeys(['>'], io); // less-style alias of G
    expect(app.snapshot().some((r) => r.includes('third late reply'))).toBe(true);
    io.feed('q');
    await done;
  });

  it('shows one pane at a time on narrow terminals', async () => {
    const fp = new FakeProvider();
    fp.add('s1', 'projA', toJsonl(basicRecords()));
    const store = new SessionStore([fp]);
    await store.scan();
    const io = new FakeTerminal(60, 20);
    const app = new App(io, store, base);
    const done = app.run();
    await app.settle();
    expect(app.layoutInfo().single).toBe(true);
    expect(app.snapshot().some((r) => r.includes('│'))).toBe(false);
    await app.feedKeys(['Tab'], io);
    expect(app.snapshot().some((r) => r.startsWith('>') && r.includes('projA'))).toBe(true);
    io.feed('q');
    await done;
  });
});
