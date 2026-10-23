import { describe, expect, it } from 'vitest';
import { SessionStore, refKey } from '../src/core/sessionStore.js';
import { Document } from '../src/tui/document.js';
import { FakeProvider } from './fakeProvider.js';
import { assistant, basicRecords, human, text, toJsonl } from './helpers.js';

const base = { width: 80, thinking: false, tools: 'collapsed' as const, hideToolOnly: false, showMeta: false, color: false, ascii: false };

async function setup(): Promise<{ store: SessionStore; doc: Document; fp: FakeProvider; keys: string[] }> {
  const fp = new FakeProvider();
  fp.add('s1', 'projA', toJsonl(basicRecords()));
  fp.add('s2', 'projA', toJsonl([human(0, 'second session'), ...assistant(1, 'm', [text('reply two')])]));
  fp.add('s3', 'projB', toJsonl(basicRecords()), { live: true });
  const store = new SessionStore([fp]);
  await store.scan();
  const doc = new Document(store, base);
  doc.refreshOrder();
  const keys = doc.order.map((e) => refKey(e.ref));
  return { store, doc, fp, keys };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Document', () => {
  it('orders sessions and uses placeholders until loaded', async () => {
    const { doc, keys, store } = await setup();
    expect(keys).toEqual(['claude:s1', 'claude:s2', 'claude:s3']);
    expect(doc.count('claude:s1')).toBe(3); // placeholder
    await store.load(doc.order[0]!);
    expect(doc.count('claude:s1')).toBeGreaterThan(10);
    const first = doc.lineAt('claude:s1', 0)!;
    expect(first.kind).toBe('header');
  });

  it('scopes the document to one project and clamps scrolling at its edges', async () => {
    const { doc, store } = await setup();
    doc.setScope('claude:projA');
    doc.refreshOrder();
    expect(doc.order.map((e) => refKey(e.ref))).toEqual(['claude:s1', 'claude:s2']);
    await store.load(doc.order[0]!);
    await store.load(doc.order[1]!);
    // scrolling down from s1 crosses into s2 but stops at the end of s2 (never reaches s3)
    let top = { key: 'claude:s1', line: 0 };
    for (let i = 0; i < 50; i++) top = doc.scrollBy(top, 10, 5);
    expect(['claude:s1', 'claude:s2']).toContain(top.key);
    expect(doc.bottomKey(top, 5)).toBe('claude:s2');
    expect(doc.showsEndOf(top, 5, 'claude:s2')).toBe(true);
    // scrolling up from s1 stays at its first line
    expect(doc.scrollBy({ key: 'claude:s1', line: 0 }, -100, 5)).toEqual({ key: 'claude:s1', line: 0 });
    doc.setScope('claude:projB');
    doc.refreshOrder();
    expect(doc.order.map((e) => refKey(e.ref))).toEqual(['claude:s3']);
  });

  it('scrolls continuously across session boundaries in both directions', async () => {
    const { doc, store } = await setup();
    for (const e of doc.order) await store.load(e);
    const n1 = doc.count('claude:s1');
    const n2 = doc.count('claude:s2');
    const rows = 10;
    let top = doc.topOf('claude:s1');
    top = doc.scrollBy(top, n1 + 2, rows);
    expect(top).toEqual({ key: 'claude:s2', line: 2 });
    top = doc.scrollBy(top, -3, rows);
    expect(top).toEqual({ key: 'claude:s1', line: n1 - 1 });
    top = doc.scrollBy(top, n1 + n2 + 1000, rows);
    const end = doc.clampToEnd(2, rows);
    expect(top).toEqual(end);
    expect(doc.isAtGlobalEnd(top, rows)).toBe(true);
    // visible() crosses boundaries and yields exactly `rows`
    const vis = doc.visible({ key: 'claude:s1', line: n1 - 2 }, rows);
    expect(vis).toHaveLength(rows);
    expect(vis[0]!.key).toBe('claude:s1');
    expect(vis[2]!.key).toBe('claude:s2');
    expect(vis[2]!.line!.kind).toBe('header');
    top = doc.scrollBy({ key: 'claude:s1', line: 0 }, -5, rows);
    expect(top).toEqual({ key: 'claude:s1', line: 0 });
  });

  it('clampToEnd walks back into previous sessions when the last is short', async () => {
    const { doc, store } = await setup();
    for (const e of doc.order) await store.load(e);
    const rows = 200;
    const top = doc.clampToEnd(2, rows);
    expect(top.key).toBe('claude:s1');
    const vis = doc.visible(top, rows);
    const lastReal = [...vis].reverse().find((v) => v.key);
    expect(lastReal!.key).toBe('claude:s3');
    expect(doc.showsEndOf(top, rows, 'claude:s3')).toBe(true);
  });

  it('keeps the anchor when a session is appended to', async () => {
    const { doc, store, fp } = await setup();
    for (const e of doc.order) await store.load(e);
    const rows = 10;
    const top = { key: 'claude:s3', line: 4 };
    const before = doc.locate(top)!;
    const lineBefore = doc.lineAt('claude:s3', 4)!.plain;
    let appended = false;
    store.events.on((ev) => {
      if (ev.kind === 'session' && ev.key === 'claude:s3') appended = true;
    });
    store.startWatching();
    fp.append('s3', toJsonl([human(50, 'another prompt'), ...assistant(51, 'mX', [text('and reply')])]));
    await sleep(50);
    expect(appended).toBe(true);
    const after = doc.reanchor(top, 'claude:s3', before);
    expect(doc.lineAt('claude:s3', after.line)!.plain).toBe(lineBefore);
    const end = doc.clampToEnd(2, rows);
    const vis = doc.visible(end, rows).map((v) => v.line?.plain ?? '');
    expect(vis.some((l) => l.includes('and reply'))).toBe(true);
    store.stop();
  });
});
