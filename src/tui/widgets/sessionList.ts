import { type ProjectGroup, refKey } from '../../core/sessionStore.js';
import type { SessionIndexEntry } from '../../core/types.js';
import { sessionLabel } from '../../core/types.js';
import { displayWidth, padToWidth, truncateToWidth } from '../../render/width.js';

export type ListRow = { kind: 'group'; group: ProjectGroup } | { kind: 'session'; key: string; entry: SessionIndexEntry; group: ProjectGroup };

function fmtListTime(ts: number | undefined, now = Date.now()): string {
  if (ts === undefined) return '     ';
  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class SessionList {
  rows: ListRow[] = [];
  selectedKey: string | undefined;
  scroll = 0;
  ascii = false;

  setGroups(groups: ProjectGroup[]): void {
    const rows: ListRow[] = [];
    for (const g of groups) {
      rows.push({ kind: 'group', group: g });
      for (const e of g.sessions) rows.push({ kind: 'session', key: refKey(e.ref), entry: e, group: g });
    }
    this.rows = rows;
    if (this.selectedKey && !rows.some((r) => r.kind === 'session' && r.key === this.selectedKey)) this.selectedKey = undefined;
  }

  selectedIndex(): number {
    return this.rows.findIndex((r) => r.kind === 'session' && r.key === this.selectedKey);
  }

  select(key: string | undefined): void {
    this.selectedKey = key;
  }

  sessionKeys(): string[] {
    return this.rows.filter((r): r is Extract<ListRow, { kind: 'session' }> => r.kind === 'session').map((r) => r.key);
  }

  /** Move selection by delta sessions (skipping group rows). */
  move(delta: number): string | undefined {
    const keys = this.sessionKeys();
    if (keys.length === 0) return undefined;
    let i = this.selectedKey ? keys.indexOf(this.selectedKey) : -1;
    if (i < 0) i = delta > 0 ? -1 : keys.length;
    i = Math.max(0, Math.min(keys.length - 1, i + delta));
    this.selectedKey = keys[i];
    return this.selectedKey;
  }

  first(): string | undefined {
    return (this.selectedKey = this.sessionKeys()[0]);
  }

  last(): string | undefined {
    const k = this.sessionKeys();
    return (this.selectedKey = k[k.length - 1]);
  }

  rowAt(y: number): ListRow | undefined {
    return this.rows[this.scroll + y];
  }

  ensureVisible(h: number): void {
    const i = this.selectedIndex();
    if (i < 0) return;
    if (i < this.scroll) this.scroll = Math.max(0, i - 1);
    else if (i >= this.scroll + h) this.scroll = i - h + 1;
    const maxScroll = Math.max(0, this.rows.length - h);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
  }

  scrollBy(delta: number, h: number): void {
    const maxScroll = Math.max(0, this.rows.length - h);
    this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + delta));
  }

  render(w: number, h: number, focused: boolean, color: boolean): string[] {
    this.ensureVisible(h);
    const out: string[] = [];
    const now = Date.now();
    for (let y = 0; y < h; y++) {
      const r = this.rows[this.scroll + y];
      if (!r) {
        out.push('');
        continue;
      }
      if (r.kind === 'group') {
        const name = truncateToWidth(r.group.name, Math.max(4, w - 2));
        const rest = w - 2 - displayWidth(name) - 2;
        const cwd = rest > 6 ? truncateToWidth(r.group.cwd, rest) : '';
        const text = padToWidth(`${this.ascii ? 'v' : '▾'} ${name}${cwd ? `  ${cwd}` : ''}`, w);
        out.push(color ? `\x1b[1;34m${this.ascii ? 'v' : '▾'} ${name}\x1b[0m${cwd ? `  \x1b[2m${cwd}\x1b[0m` : ''}${' '.repeat(Math.max(0, w - displayWidth(text)))}` : text);
        continue;
      }
      const e = r.entry;
      const live = e.live;
      const mark = live ? (live.source === 'mtime' ? (this.ascii ? 'o' : '◌') : live.status === 'busy' ? (this.ascii ? '*' : '●') : this.ascii ? 'o' : '○') : ' ';
      const time = fmtListTime(e.updatedAt ?? e.mtimeMs, now);
      const prefix = ` ${mark} ${time} `;
      const title = truncateToWidth(sessionLabel(e), Math.max(4, w - displayWidth(prefix)));
      const plainRow = padToWidth(`${prefix}${title}`, w);
      const selected = r.key === this.selectedKey;
      if (!color) {
        out.push(selected ? `>${plainRow.slice(1)}` : plainRow);
        continue;
      }
      const markStyle = live ? (live.source === 'mtime' ? '\x1b[2m' : live.status === 'busy' ? '\x1b[1;32m' : '\x1b[32m') : '';
      if (selected) {
        const bg = focused ? '\x1b[7m' : '\x1b[2;7m';
        out.push(`${bg}${plainRow}\x1b[0m`);
      } else {
        out.push(` ${markStyle}${mark}\x1b[0m \x1b[2m${time}\x1b[0m ${title}${' '.repeat(Math.max(0, w - displayWidth(plainRow)))}`);
      }
    }
    return out;
  }
}
