import { refKey } from '../../core/sessionStore.js';
import type { LiveState, SessionIndexEntry } from '../../core/types.js';
import { sessionLabel } from '../../core/types.js';
import { displayWidth, padToWidth, truncateToWidth } from '../../render/width.js';

export interface ListRow {
  key: string;
  entry: SessionIndexEntry;
}

export function fmtListTime(ts: number | undefined, now = Date.now()): string {
  if (ts === undefined) return '     ';
  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 0 = not live, 1 = recently modified, 2 = idle, 3 = busy */
export function liveRank(live: LiveState | null): number {
  if (!live) return 0;
  if (live.source === 'mtime') return 1;
  return live.status === 'busy' ? 3 : 2;
}

export function liveMark(live: LiveState | null, ascii: boolean): { ch: string; sgr: string } {
  switch (liveRank(live)) {
    case 3:
      return { ch: ascii ? '*' : '●', sgr: '\x1b[1;32m' };
    case 2:
      return { ch: ascii ? 'o' : '○', sgr: '\x1b[32m' };
    case 1:
      return { ch: ascii ? 'o' : '◌', sgr: '\x1b[2m' };
    default:
      return { ch: ' ', sgr: '' };
  }
}

/** Keeps the list scrolled so that `index` is visible; returns the new scroll. */
export function scrollToShow(scroll: number, index: number, count: number, h: number): number {
  let s = scroll;
  if (index >= 0) {
    if (index < s) s = Math.max(0, index - 1);
    else if (index >= s + h) s = index - h + 1;
  }
  return Math.max(0, Math.min(s, Math.max(0, count - h)));
}

/** Flat list of the sessions of one project (middle pane). */
export class SessionList {
  rows: ListRow[] = [];
  selectedKey: string | undefined;
  scroll = 0;
  ascii = false;

  setSessions(entries: SessionIndexEntry[]): void {
    this.rows = entries.map((e) => ({ key: refKey(e.ref), entry: e }));
    if (this.selectedKey && !this.rows.some((r) => r.key === this.selectedKey)) this.selectedKey = undefined;
  }

  selectedIndex(): number {
    return this.rows.findIndex((r) => r.key === this.selectedKey);
  }

  select(key: string | undefined): void {
    this.selectedKey = key;
  }

  keys(): string[] {
    return this.rows.map((r) => r.key);
  }

  /** Move selection by delta rows. */
  move(delta: number): string | undefined {
    const keys = this.keys();
    if (keys.length === 0) return undefined;
    let i = this.selectedKey ? keys.indexOf(this.selectedKey) : -1;
    if (i < 0) i = delta > 0 ? -1 : keys.length;
    i = Math.max(0, Math.min(keys.length - 1, i + delta));
    this.selectedKey = keys[i];
    return this.selectedKey;
  }

  first(): string | undefined {
    return (this.selectedKey = this.keys()[0]);
  }

  last(): string | undefined {
    const k = this.keys();
    return (this.selectedKey = k[k.length - 1]);
  }

  rowAt(y: number): ListRow | undefined {
    return this.rows[this.scroll + y];
  }

  ensureVisible(h: number): void {
    this.scroll = scrollToShow(this.scroll, this.selectedIndex(), this.rows.length, h);
  }

  scrollBy(delta: number, h: number): void {
    const maxScroll = Math.max(0, this.rows.length - h);
    this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + delta));
  }

  render(w: number, h: number, focused: boolean, color: boolean): string[] {
    this.ensureVisible(h);
    const out: string[] = [];
    const now = Date.now();
    if (this.rows.length === 0 && h > 0) {
      const msg = truncateToWidth(' (no sessions)', w);
      out.push(color ? `\x1b[2m${msg}\x1b[0m` : msg);
    }
    for (let y = out.length; y < h; y++) {
      const r = this.rows[this.scroll + y];
      if (!r) {
        out.push('');
        continue;
      }
      const e = r.entry;
      const mark = liveMark(e.live, this.ascii);
      const time = fmtListTime(e.updatedAt ?? e.mtimeMs, now);
      const prefix = ` ${mark.ch} ${time} `;
      const title = truncateToWidth(sessionLabel(e), Math.max(4, w - displayWidth(prefix)));
      const plainRow = padToWidth(`${prefix}${title}`, w);
      const selected = r.key === this.selectedKey;
      if (!color) {
        out.push(selected ? `>${plainRow.slice(1)}` : plainRow);
        continue;
      }
      if (selected) {
        const bg = focused ? '\x1b[7m' : '\x1b[2;7m';
        out.push(`${bg}${plainRow}\x1b[0m`);
      } else {
        out.push(` ${mark.sgr}${mark.ch}\x1b[0m \x1b[2m${time}\x1b[0m ${title}${' '.repeat(Math.max(0, w - displayWidth(plainRow)))}`);
      }
    }
    return out;
  }
}
