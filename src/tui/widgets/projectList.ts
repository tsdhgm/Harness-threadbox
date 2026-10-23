import type { ProjectGroup } from '../../core/sessionStore.js';
import type { LiveState } from '../../core/types.js';
import { displayWidth, padToWidth, truncateToWidth } from '../../render/width.js';
import { fmtListTime, liveMark, liveRank, scrollToShow } from './sessionList.js';

/** Strongest live state among a project's sessions. */
export function projectLive(g: ProjectGroup): LiveState | null {
  let best: LiveState | null = null;
  for (const e of g.sessions) if (liveRank(e.live) > liveRank(best)) best = e.live;
  return best;
}

/** One row per project (left pane). */
export class ProjectList {
  groups: ProjectGroup[] = [];
  selectedKey: string | undefined;
  scroll = 0;
  ascii = false;

  setGroups(groups: ProjectGroup[]): void {
    this.groups = groups;
    if (this.selectedKey && !groups.some((g) => g.key === this.selectedKey)) this.selectedKey = undefined;
  }

  selectedIndex(): number {
    return this.groups.findIndex((g) => g.key === this.selectedKey);
  }

  select(key: string | undefined): void {
    this.selectedKey = key;
  }

  move(delta: number): string | undefined {
    const n = this.groups.length;
    if (n === 0) return undefined;
    let i = this.selectedIndex();
    if (i < 0) i = delta > 0 ? -1 : n;
    i = Math.max(0, Math.min(n - 1, i + delta));
    this.selectedKey = this.groups[i]!.key;
    return this.selectedKey;
  }

  first(): string | undefined {
    return (this.selectedKey = this.groups[0]?.key);
  }

  last(): string | undefined {
    return (this.selectedKey = this.groups[this.groups.length - 1]?.key);
  }

  rowAt(y: number): ProjectGroup | undefined {
    return this.groups[this.scroll + y];
  }

  ensureVisible(h: number): void {
    this.scroll = scrollToShow(this.scroll, this.selectedIndex(), this.groups.length, h);
  }

  scrollBy(delta: number, h: number): void {
    const maxScroll = Math.max(0, this.groups.length - h);
    this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + delta));
  }

  render(w: number, h: number, focused: boolean, color: boolean): string[] {
    this.ensureVisible(h);
    const out: string[] = [];
    const now = Date.now();
    if (this.groups.length === 0 && h > 0) {
      const msg = truncateToWidth(' (no projects)', w);
      out.push(color ? `\x1b[2m${msg}\x1b[0m` : msg);
    }
    for (let y = out.length; y < h; y++) {
      const g = this.groups[this.scroll + y];
      if (!g) {
        out.push('');
        continue;
      }
      const live = projectLive(g);
      const mark = liveMark(live, this.ascii);
      const time = fmtListTime(g.lastActivity || undefined, now);
      const count = String(g.sessions.length);
      const prefix = ` ${mark.ch} ${time} `;
      const nameW = Math.max(4, w - displayWidth(prefix) - displayWidth(count) - 1);
      const name = truncateToWidth(g.name, nameW);
      const gap = ' '.repeat(Math.max(1, w - displayWidth(prefix) - displayWidth(name) - displayWidth(count)));
      const plainRow = padToWidth(`${prefix}${name}${gap}${count}`, w);
      const selected = g.key === this.selectedKey;
      if (!color) {
        out.push(selected ? `>${plainRow.slice(1)}` : plainRow);
        continue;
      }
      if (selected) {
        const bg = focused ? '\x1b[7m' : '\x1b[2;7m';
        out.push(`${bg}${plainRow}\x1b[0m`);
      } else {
        out.push(` ${mark.sgr}${mark.ch}\x1b[0m \x1b[2m${time}\x1b[0m ${name}${gap}\x1b[2m${count}\x1b[0m`);
      }
    }
    return out;
  }
}
