import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ParsedArgs, flagBool, flagNum, flagStr, useColor } from '../cli/args.js';
import { createContext } from '../cli/context.js';
import { type SessionStore, type StoreEvent, groupKeyOf, refKey } from '../core/sessionStore.js';
import type { SessionIndexEntry } from '../core/types.js';
import { sessionLabel } from '../core/types.js';
import { sanitizeFilename, sessionToMarkdown } from '../render/markdownExport.js';
import type { ToolsMode } from '../render/transcript.js';
import { displayWidth, truncateToWidth } from '../render/width.js';
import { copyToClipboard } from './clipboard.js';
import { type BaseRenderOptions, Document, type Top } from './document.js';
import { highlightAnsi } from './highlight.js';
import { type InputEvent, InputParser, type KeyEvent, type MouseEvent, keyNameToBytes } from './input.js';
import { type Focus, type Layout, type PaneWidths, type Rect, clampWidths, computeLayout, defaultWidths, nextFocus } from './layout.js';
import { Screen, fitAnsi } from './screen.js';
import { FakeTerminal, RealTerminal, type TerminalIO } from './terminal.js';
import { HELP_LINES } from './widgets/help.js';
import { LineInput } from './widgets/lineInput.js';
import { ProjectList } from './widgets/projectList.js';
import { SessionList } from './widgets/sessionList.js';

type Mode = 'normal' | 'search' | 'export' | 'help';

export interface AppOptions {
  /** copies text to the clipboard; returns the methods that worked (injected in tests) */
  clipboard?: (text: string) => Promise<string[]>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const newestFirst = (a: SessionIndexEntry, b: SessionIndexEntry): number => (b.updatedAt ?? b.mtimeMs) - (a.updatedAt ?? a.mtimeMs);

/**
 * Three panes: projects │ sessions of the selected project │ transcript.
 * The transcript is a continuous document over the selected project's sessions only;
 * scrolling past its first/last session stops at the project boundary.
 */
export class App {
  private screen: Screen;
  private input: InputParser;
  private doc: Document;
  private projects = new ProjectList();
  private list = new SessionList();
  private focus: Focus = 'right';
  /** ProjectGroup.key of the project shown in the middle/right panes */
  private projectKey: string | undefined;
  private top: Top | undefined;
  private follow = true;
  private pendingBottom: string | undefined;
  private widths: PaneWidths;
  private mode: Mode = 'normal';
  private lineInput: LineInput | undefined;
  private query = '';
  private message: { text: string; until: number } | undefined;
  /** divider being dragged: 1 = projects|sessions, 2 = sessions|right */
  private dragging: 0 | 1 | 2 = 0;
  private renderScheduled = false;
  private layout: Layout;
  private quitResolve: ((code: number) => void) | undefined;
  private resizeTimer: NodeJS.Timeout | undefined;
  private searchGen = 0;
  private color: boolean;
  private pendingLoads = 0;
  private clipboard: (text: string) => Promise<string[]>;

  constructor(
    private io: TerminalIO,
    private store: SessionStore,
    base: Omit<BaseRenderOptions, 'width'>,
    opts: AppOptions = {},
  ) {
    this.color = base.color;
    this.clipboard = opts.clipboard ?? (async (text) => (await copyToClipboard(text, { write: (s) => io.write(s), allowExternal: true })).methods);
    this.widths = defaultWidths(io.cols);
    this.layout = computeLayout(io.cols, io.rows, this.widths, this.focus);
    this.screen = new Screen(io, io.cols, io.rows);
    this.doc = new Document(store, { ...base, width: this.layout.right.w });
    this.list.ascii = base.ascii;
    this.projects.ascii = base.ascii;
    this.input = new InputParser((ev) => this.onInput(ev));
    this.doc.onLoaded = (key) => this.onLoaded(key);
    this.doc.onError = (msg) => this.toast(msg);
  }

  // ---------- lifecycle ----------

  async run(): Promise<number> {
    this.io.enter();
    this.io.onInput((d) => this.input.feed(d));
    this.io.onResize(() => this.onResize());
    this.store.events.on((ev) => this.onStore(ev));
    this.store.startWatching();
    this.refreshLists();
    this.initialPosition();
    this.scheduleRender();
    return new Promise<number>((resolve) => {
      this.quitResolve = resolve;
    });
  }

  quit(code = 0): void {
    this.store.stop();
    this.io.exit();
    this.quitResolve?.(code);
  }

  private rightH(): number {
    return this.layout.right.h;
  }

  /** Rebuild both lists from the store and re-scope the document to the current project. */
  private refreshLists(): void {
    const groups = this.store.groups();
    this.projects.setGroups(groups);
    if (this.projectKey && !groups.some((g) => g.key === this.projectKey)) this.projectKey = undefined;
    const g = groups.find((x) => x.key === this.projectKey);
    this.list.setSessions(g?.sessions ?? []);
    this.projects.select(this.projectKey);
    this.doc.setScope(this.projectKey);
    this.doc.refreshOrder();
  }

  /** Pick the project of the newest live session (else the most recent session) and land at its end. */
  private initialPosition(): void {
    const all = this.store.order();
    if (all.length === 0) {
      this.top = undefined;
      this.projectKey = undefined;
      this.refreshLists();
      return;
    }
    const live = all.filter((e) => e.live).sort(newestFirst);
    const target = live[0] ?? all[all.length - 1]!;
    this.selectProject(groupKeyOf(target), refKey(target.ref));
  }

  /**
   * Show project `gk` in the middle and right panes and land at the end of `key`
   * (default: the project's newest live session, else its last session).
   */
  private selectProject(gk: string, key?: string): void {
    this.projectKey = gk;
    this.refreshLists();
    const order = this.doc.order;
    if (order.length === 0) {
      this.top = undefined;
      return;
    }
    let target = key && this.doc.indexOf(key) >= 0 ? key : undefined;
    if (!target) {
      const live = order.filter((e) => e.live).sort(newestFirst);
      target = refKey((live[0] ?? order[order.length - 1]!).ref);
    }
    this.landAtEnd(target);
  }

  /** Put the last line of session `key` on the last row and follow it. */
  private landAtEnd(key: string): void {
    const i = this.doc.indexOf(key);
    if (i < 0) return;
    if (this.doc.isLoaded(key)) {
      this.top = this.doc.clampToEnd(i, this.rightH());
      this.pendingBottom = undefined;
    } else {
      this.top = this.doc.topOf(key);
      this.pendingBottom = key;
    }
    this.follow = true;
    this.doc.preload(i);
    this.syncLists();
  }

  // ---------- events ----------

  private onResize(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.screen.resize(this.io.cols, this.io.rows);
      this.scheduleRender();
    }, 50);
  }

  private onStore(ev: StoreEvent): void {
    switch (ev.kind) {
      case 'index': {
        this.refreshLists();
        if (!this.top || this.doc.indexOf(this.top.key) < 0) {
          if (this.projectKey && this.doc.order.length > 0) this.selectProject(this.projectKey);
          else this.initialPosition();
        }
        break;
      }
      case 'session': {
        if (!this.top) break;
        const h = this.rightH();
        const before = this.top.key === ev.key ? this.doc.locate(this.top) : undefined;
        this.doc.cache(ev.key); // re-render dirty turns now
        if (this.doc.indexOf(ev.key) < 0) break; // another project
        if (this.follow && (this.doc.bottomKey(this.top, h) === ev.key || this.top.key === ev.key)) {
          this.top = this.doc.clampToEnd(this.doc.indexOf(ev.key), h);
        } else if (this.top.key === ev.key) {
          this.top = ev.reset ? this.doc.clamp(this.top, h) : this.doc.reanchor(this.top, ev.key, before);
        }
        break;
      }
      case 'loaded':
        this.onLoaded(ev.key);
        return;
      case 'live':
        break;
      case 'error':
        this.toast(ev.message);
        break;
    }
    this.scheduleRender();
  }

  private onLoaded(key: string): void {
    if (!this.top) return;
    const h = this.rightH();
    if (this.pendingBottom === key) {
      this.pendingBottom = undefined;
      if (this.doc.indexOf(key) >= 0) this.top = this.doc.clampToEnd(this.doc.indexOf(key), h);
      this.syncLists();
    } else if (this.top.key === key) {
      this.top = this.doc.clamp(this.top, h);
    }
    this.scheduleRender();
  }

  private toast(text: string, ms = 3000): void {
    this.message = { text, until: Date.now() + ms };
    this.scheduleRender();
    setTimeout(() => this.scheduleRender(), ms + 10).unref();
  }

  // ---------- input ----------

  private onInput(ev: InputEvent): void {
    if (ev.type === 'mouse') this.onMouse(ev);
    else this.onKey(ev);
    this.scheduleRender();
  }

  /** The pane that keys act on (the focused one, if it is visible). */
  private activePane(): Focus {
    const lay = this.layout;
    if (this.focus === 'projects' && lay.projects) return 'projects';
    if (this.focus === 'sessions' && lay.sessions) return 'sessions';
    return 'right';
  }

  private onKey(ev: KeyEvent): void {
    if (this.mode === 'help') {
      if (ev.name === 'escape' || ev.name === 'q' || ev.name === '?' || ev.name === 'enter') this.mode = 'normal';
      return;
    }
    if (this.mode === 'search' || this.mode === 'export') {
      const li = this.lineInput!;
      const r = li.handle(ev);
      if (r === 'cancel') {
        this.mode = 'normal';
        this.lineInput = undefined;
      } else if (r === 'submit') {
        const mode = this.mode;
        this.mode = 'normal';
        this.lineInput = undefined;
        if (mode === 'search') {
          this.query = li.value;
          if (this.query) void this.search(1, true);
        } else void this.exportTo(li.value);
      }
      return;
    }
    const h = this.rightH();
    const pane = this.activePane();
    const page = h - 1;
    const vertical = (delta: number): void => {
      if (pane === 'projects') this.moveProject(delta);
      else if (pane === 'sessions') this.list.move(delta);
      else this.scroll(delta);
    };
    if (ev.ctrl && ev.name === 'c') return this.quit(0);
    switch (ev.name) {
      case 'q':
        return this.quit(0);
      case '?':
        this.mode = 'help';
        return;
      case 'escape':
        this.query = '';
        return;
      case 'tab':
        this.focus = nextFocus(this.focus, 1);
        return;
      case 'backtab':
        this.focus = nextFocus(this.focus, -1);
        return;
      case 'j':
      case 'down':
        return vertical(1);
      case 'k':
      case 'up':
        return vertical(-1);
      case 'pagedown':
      case 'space':
        return vertical(page);
      case 'pageup':
        return vertical(-page);
      case 'f':
        if (ev.ctrl) return vertical(page);
        return;
      case 'b':
        if (ev.ctrl) return vertical(-page);
        return;
      case 'd':
        return pane === 'right' ? this.scroll(Math.floor(h / 2)) : undefined;
      case 'u':
        return pane === 'right' ? this.scroll(-Math.floor(h / 2)) : undefined;
      case 'g':
      case 'home':
        if (pane === 'projects') return this.switchProject(this.projects.first());
        if (pane === 'sessions') return void this.list.first();
        return this.jumpTo(this.doc.keyAt(0), false);
      case 'G':
      case 'end':
        if (pane === 'projects') return this.switchProject(this.projects.last());
        if (pane === 'sessions') return void this.list.last();
        return this.gotoEnd();
      case 'enter':
        if (pane === 'projects') {
          this.switchProject(this.projects.selectedKey);
          this.focus = 'sessions';
        } else if (pane === 'sessions' && this.list.selectedKey) this.jumpTo(this.list.selectedKey, false);
        return;
      case 'L':
        return this.nextLive();
      case '/':
        this.mode = 'search';
        this.lineInput = new LineInput('/', this.query);
        return;
      case 'n':
        if (this.query) void this.search(1, false);
        return;
      case 'N':
        if (this.query) void this.search(-1, false);
        return;
      case 't':
        return this.setBase({ thinking: !this.doc.getBase().thinking });
      case 'o': {
        const cur = this.doc.getBase().tools;
        const next: ToolsMode = cur === 'collapsed' ? 'full' : cur === 'full' ? 'hidden' : 'collapsed';
        return this.setBase({ tools: next });
      }
      case 'h':
        return this.setBase({ hideToolOnly: !this.doc.getBase().hideToolOnly });
      case 'm':
        return this.setBase({ showMeta: !this.doc.getBase().showMeta });
      case '[':
        return this.resizeFocused(-2);
      case ']':
        return this.resizeFocused(2);
      case '\\':
        this.widths = defaultWidths(this.io.cols);
        return;
      case 'e': {
        const e = this.targetEntry(pane);
        if (!e) return;
        this.mode = 'export';
        this.lineInput = new LineInput('export to: ', path.join(process.cwd(), `${sanitizeFilename(sessionLabel(e))}.md`));
        return;
      }
      case 'r':
        void this.store.scan().then(() => this.toast('rescanned'));
        return;
      case 'y':
      case 'Y': {
        const e = this.targetEntry(pane);
        if (!e) return this.toast('no session');
        const text = ev.name === 'y' ? e.ref.sessionId : `claude --resume ${e.ref.sessionId}`;
        void this.clipboard(text).then(
          (methods) => this.toast(`copied: ${text}  (${methods.join(', ')})`, 5000),
          (err: unknown) => this.toast(`copy failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        return;
      }
      default:
        return;
    }
  }

  /** The session that y / Y / e act on: the selected one in the sessions pane, else the current one. */
  private targetEntry(pane: Focus): SessionIndexEntry | undefined {
    const key = pane === 'sessions' ? this.list.selectedKey : this.currentKey();
    return key ? this.doc.entry(key) : undefined;
  }

  /** `[` / `]` move the divider to the right of the focused pane (projects → div1, otherwise div2). */
  private resizeFocused(delta: number): void {
    const w = { ...this.widths };
    if (this.focus === 'projects') w.projects += delta;
    else w.sessions += delta;
    this.widths = clampWidths(this.io.cols, w);
  }

  private onMouse(ev: MouseEvent): void {
    const lay = this.layout;
    const inRect = (r: Rect | undefined): boolean => r !== undefined && ev.x >= r.x && ev.x < r.x + r.w && ev.y < r.h;
    const inProjects = inRect(lay.projects);
    const inSessions = inRect(lay.sessions);
    const showRight = !lay.single || this.focus === 'right';
    const onDiv: 0 | 1 | 2 = lay.div1 === ev.x ? 1 : lay.div2 === ev.x ? 2 : 0;
    if (ev.action === 'wheel-up' || ev.action === 'wheel-down') {
      const d = ev.action === 'wheel-up' ? -3 : 3;
      if (inProjects) this.projects.scrollBy(d, lay.projects!.h);
      else if (inSessions) this.list.scrollBy(d, lay.sessions!.h);
      else if (showRight) this.scroll(d);
      return;
    }
    if (ev.action === 'press' && ev.button === 0) {
      if (onDiv) {
        this.dragging = onDiv;
        return;
      }
      if (inProjects) {
        this.focus = 'projects';
        const g = this.projects.rowAt(ev.y);
        if (g) this.switchProject(g.key);
        return;
      }
      if (inSessions) {
        this.focus = 'sessions';
        const row = this.list.rowAt(ev.y);
        if (row) {
          this.list.select(row.key);
          this.jumpTo(row.key, false);
        }
        return;
      }
      if (showRight) this.focus = 'right';
      return;
    }
    if (ev.action === 'drag' && this.dragging) {
      const w = { ...this.widths };
      if (this.dragging === 1) w.projects = ev.x;
      else w.sessions = ev.x - this.widths.projects - 1;
      this.widths = clampWidths(this.io.cols, w);
      return;
    }
    if (ev.action === 'release') this.dragging = 0;
  }

  // ---------- navigation ----------

  private scroll(delta: number): void {
    if (!this.top) return;
    const h = this.rightH();
    this.top = this.doc.scrollBy(this.top, delta, h);
    if (delta < 0) this.follow = false;
    else this.updateFollowAtEnd();
    this.syncLists();
  }

  private updateFollowAtEnd(): void {
    if (!this.top) return;
    const h = this.rightH();
    const bottom = this.doc.bottomKey(this.top, h);
    const e = this.doc.entry(bottom);
    if (e?.live && this.doc.showsEndOf(this.top, h, bottom)) this.follow = true;
  }

  /** Move the project selection and switch the other panes to it. */
  private moveProject(delta: number): void {
    this.switchProject(this.projects.move(delta));
  }

  private switchProject(gk: string | undefined): void {
    if (!gk) return;
    this.projects.select(gk);
    if (gk !== this.projectKey) this.selectProject(gk);
  }

  private jumpTo(key: string | undefined, follow: boolean): void {
    if (!key) return;
    const i = this.doc.indexOf(key);
    if (i < 0) return;
    this.top = this.doc.topOf(key);
    this.follow = follow;
    this.pendingBottom = undefined;
    this.doc.preload(i);
    this.list.select(key);
  }

  private gotoEnd(): void {
    const n = this.doc.order.length;
    if (n === 0) return;
    this.landAtEnd(this.doc.keyAt(n - 1)!);
  }

  /** Next live session in global order, switching project if needed. */
  private nextLive(): void {
    const all = this.store.order();
    const live = all.map((e, i) => ({ e, i })).filter((x) => x.e.live);
    if (live.length === 0) return this.toast('no live sessions');
    const ck = this.currentKey();
    const cur = ck ? all.findIndex((e) => refKey(e.ref) === ck) : -1;
    const next = live.find((x) => x.i > cur) ?? live[0]!;
    const gk = groupKeyOf(next.e);
    const key = refKey(next.e.ref);
    if (gk !== this.projectKey) this.selectProject(gk, key);
    else this.landAtEnd(key);
  }

  /** The session the user is "on": the bottom one while following, else the top one. */
  private currentKey(): string | undefined {
    if (!this.top) return undefined;
    if (this.follow) return this.doc.bottomKey(this.top, this.rightH());
    return this.top.key;
  }

  /** Reflect the transcript position in the two lists. */
  private syncLists(): void {
    const k = this.currentKey();
    if (k) this.list.select(k);
    this.projects.select(this.projectKey);
  }

  private setBase(patch: Partial<BaseRenderOptions>): void {
    const b = { ...this.doc.getBase(), ...patch };
    this.doc.setBase(b);
    if (this.top) this.top = this.doc.clamp(this.top, this.rightH());
    const parts = [`thinking:${b.thinking ? 'on' : 'off'}`, `tools:${b.tools}`, `tool-only:${b.hideToolOnly ? 'hidden' : 'shown'}`, `meta:${b.showMeta ? 'on' : 'off'}`];
    this.toast(parts.join(' '), 1500);
  }

  // ---------- search (within the current project) ----------

  private async search(dir: 1 | -1, fromCurrent: boolean): Promise<void> {
    if (!this.top || !this.query) return;
    const gen = ++this.searchGen;
    const q = this.query.toLowerCase();
    const n = this.doc.order.length;
    const h = this.rightH();
    let i = this.doc.indexOf(this.top.key);
    let line = this.top.line + (fromCurrent ? 0 : dir);
    this.toast('searching…', 10000);
    for (let visited = 0; visited <= n; visited++) {
      const e = this.doc.order[i];
      if (!e) break;
      const key = refKey(e.ref);
      try {
        await this.store.load(e);
      } catch {
        // skip unreadable
      }
      if (gen !== this.searchGen) return;
      const c = this.doc.cache(key);
      if (c) {
        const total = c.total();
        if (dir > 0) {
          for (let l = Math.max(0, line); l < total; l++) {
            if (c.lineAt(l)!.plain.toLowerCase().includes(q)) return this.foundAt(key, l, h);
          }
        } else {
          for (let l = Math.min(total - 1, line); l >= 0; l--) {
            if (c.lineAt(l)!.plain.toLowerCase().includes(q)) return this.foundAt(key, l, h);
          }
        }
      }
      i += dir;
      if (i < 0) i = n - 1;
      if (i >= n) i = 0;
      line = dir > 0 ? 0 : Number.MAX_SAFE_INTEGER;
    }
    this.toast(`no match in this project: ${this.query}`);
  }

  private foundAt(key: string, line: number, h: number): void {
    this.top = this.doc.scrollBy({ key, line }, 0, h);
    this.follow = false;
    this.pendingBottom = undefined;
    this.doc.preload(this.doc.indexOf(key));
    this.syncLists();
    this.toast(`match: ${this.query}`, 1500);
  }

  // ---------- export ----------

  private async exportTo(file: string): Promise<void> {
    const key = this.activePane() === 'sessions' ? this.list.selectedKey : this.currentKey();
    const e = key ? this.doc.entry(key) : undefined;
    if (!e || !file) return;
    try {
      const s = await this.store.load(e);
      await fs.promises.writeFile(file, sessionToMarkdown(s, { includeMeta: this.doc.getBase().showMeta }), 'utf8');
      this.toast(`exported → ${file}`);
    } catch (err) {
      this.toast(`export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---------- rendering ----------

  scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    setImmediate(() => {
      this.renderScheduled = false;
      try {
        this.render();
      } catch (err) {
        this.io.exit();
        throw err;
      }
    });
  }

  private render(): void {
    const cols = this.io.cols;
    const rows = this.io.rows;
    if (this.screen.cols !== cols || this.screen.rows !== rows) this.screen.resize(cols, rows);
    this.layout = computeLayout(cols, rows, this.widths, this.focus);
    const lay = this.layout;
    if (this.doc.getBase().width !== lay.right.w) {
      this.doc.setBase({ ...this.doc.getBase(), width: lay.right.w });
      if (this.top) this.top = this.doc.clamp(this.top, lay.right.h);
    }
    if (this.top && this.follow && this.pendingBottom === undefined) {
      // keep the end pinned while following
      const bottom = this.doc.bottomKey(this.top, lay.right.h);
      if (this.doc.isLoaded(bottom) && this.doc.entry(bottom)?.live) this.top = this.doc.clampToEnd(this.doc.indexOf(bottom), lay.right.h);
    }
    // the session list follows the transcript unless the user is moving its selection
    if (this.focus !== 'sessions') this.syncLists();
    this.screen.begin();

    const showRight = !lay.single || this.focus === 'right';
    const pRows = lay.projects ? this.renderProjectsPane(lay.projects.w, lay.projects.h) : [];
    const sRows = lay.sessions ? this.list.render(lay.sessions.w, lay.sessions.h, this.focus === 'sessions', this.color) : [];
    const rRows = showRight ? this.renderRight(lay.right.h) : [];
    const divider = this.color ? `\x1b[2m│\x1b[0m` : '│';
    for (let y = 0; y < rows - 1; y++) {
      let row = '';
      if (lay.projects) row += fitAnsi(pRows[y] ?? '', lay.projects.w);
      if (lay.div1 !== undefined) row += divider;
      if (lay.sessions) row += fitAnsi(sRows[y] ?? '', lay.sessions.w);
      if (lay.div2 !== undefined) row += divider;
      if (showRight) row += fitAnsi(rRows[y] ?? '', lay.right.w);
      this.screen.set(y, row);
    }
    this.screen.set(lay.statusY, this.renderStatus(cols));
    if (this.mode === 'help') this.renderHelp();
    this.screen.flush();
  }

  /** Projects list with a footer showing the full id of the current session (what `y` copies). */
  private renderProjectsPane(w: number, h: number): string[] {
    const footer = this.renderIdFooter(w, h);
    const rows = this.projects.render(w, h - footer.length, this.focus === 'projects', this.color);
    return [...rows, ...footer];
  }

  private renderIdFooter(w: number, h: number): string[] {
    const e = this.targetEntry(this.activePane());
    if (!e || w < 8) return [];
    const id = e.ref.sessionId;
    const chunks: string[] = [];
    for (let i = 0; i < id.length; i += w) chunks.push(id.slice(i, i + w));
    const hint = truncateToWidth('y copy id  Y copy resume cmd', w);
    const withHint = h >= chunks.length + 1 + 1 + 6;
    const needed = 1 + chunks.length + (withHint ? 1 : 0);
    if (h < needed + 3) return [];
    const dim = (s: string): string => (this.color ? `\x1b[2m${s}\x1b[0m` : s);
    const out = [dim('─'.repeat(w)), ...chunks.map((c) => (this.color ? `\x1b[1m${c}\x1b[0m` : c))];
    if (withHint) out.push(dim(hint));
    return out;
  }

  private renderRight(h: number): string[] {
    if (!this.top) {
      const msg = this.store.order().length === 0 ? 'no sessions found' : this.doc.order.length === 0 ? 'no sessions in this project' : '';
      return [msg];
    }
    const vis = this.doc.visible(this.top, h);
    const out: string[] = [];
    for (const v of vis) {
      if (!v.line) {
        out.push('');
        continue;
      }
      let a = v.line.ansi;
      if (this.query && v.line.plain.toLowerCase().includes(this.query.toLowerCase())) a = highlightAnsi(a, v.line.plain, this.query);
      out.push(a);
    }
    return out;
  }

  private renderStatus(cols: number): string {
    const now = Date.now();
    if (this.mode === 'search' || this.mode === 'export') return this.lineInput!.render(cols, this.color);
    const b = this.doc.getBase();
    let leftText: string;
    if (this.message && this.message.until > now) leftText = this.message.text;
    else {
      const ck = this.currentKey();
      const e = ck ? this.doc.entry(ck) : undefined;
      const parts: string[] = [];
      if (e) {
        parts.push(e.project.name, truncateToWidth(sessionLabel(e), 40), e.ref.sessionId.slice(0, 8));
        if (e.model) parts.push(e.model.replace(/^claude-/, ''));
        if (e.live) parts.push(`LIVE ${e.live.status === 'unknown' ? '' : e.live.status}`.trim());
      }
      if (this.follow) parts.push('FOLLOW');
      leftText = parts.join(' · ');
    }
    const flags = `t:${b.thinking ? 'on' : 'off'} o:${b.tools} h:${b.hideToolOnly ? 'on' : 'off'}${b.showMeta ? ' m:on' : ''}`;
    const ck = this.currentKey();
    const pos = this.top && ck ? (ck === this.top.key ? `L ${this.top.line + 1}/${this.doc.count(ck)}` : `L ${this.doc.count(ck)}/${this.doc.count(ck)}`) : '';
    const right = `${flags} · ${pos} · ?:help`;
    const avail = Math.max(0, cols - displayWidth(right) - 1);
    const leftFit = truncateToWidth(leftText, avail);
    const pad = ' '.repeat(Math.max(0, cols - displayWidth(leftFit) - displayWidth(right)));
    const line = `${leftFit}${pad}${right}`;
    return this.color ? `\x1b[7m${fitAnsi(line, cols)}\x1b[0m` : line;
  }

  private renderHelp(): void {
    const cols = this.io.cols;
    const w = Math.min(cols - 4, Math.max(...HELP_LINES.map((l) => displayWidth(l))) + 4);
    const h = Math.min(this.io.rows - 2, HELP_LINES.length + 2);
    const x = Math.max(0, Math.floor((cols - w) / 2));
    const y = Math.max(0, Math.floor((this.io.rows - 1 - h) / 2));
    const border = this.color ? '\x1b[1;36m' : '';
    const reset = this.color ? '\x1b[0m' : '';
    const top = `${border}┌${'─'.repeat(w - 2)}┐${reset}`;
    const bottom = `${border}└${'─'.repeat(w - 2)}┘${reset}`;
    this.screen.put(x, y, top, w);
    for (let i = 0; i < h - 2; i++) {
      const text = HELP_LINES[i] ?? '';
      const inner = fitAnsi(` ${text}`, w - 2);
      this.screen.put(x, y + 1 + i, `${border}│${reset}${inner}${border}│${reset}`, w);
    }
    this.screen.put(x, y + h - 1, bottom, w);
  }

  // ---------- debug / tests ----------

  snapshot(): string[] {
    return this.screen.snapshot();
  }

  /** Current layout (for tests). */
  layoutInfo(): Layout {
    return this.layout;
  }

  async settle(maxMs = 1500): Promise<void> {
    const start = Date.now();
    for (;;) {
      await sleep(30);
      const busy = this.doc.order.some((e) => this.store.isLoading(refKey(e.ref))) || this.renderScheduled;
      if (!busy) {
        // one extra frame to flush any pending render
        await sleep(30);
        if (!this.renderScheduled) return;
      }
      if (Date.now() - start > maxMs) return;
    }
  }

  feedKeys(keys: string[], io: FakeTerminal): Promise<void> {
    return (async () => {
      for (const k of keys) {
        if (k.startsWith('/') && k.length > 1) {
          io.feed('/');
          await this.settle(200);
          for (const ch of k.slice(1)) io.feed(ch);
        } else io.feed(keyNameToBytes(k));
        await this.settle();
      }
    })();
  }

  get pendingLoadCount(): number {
    return this.pendingLoads;
  }
}

export async function runTui(args: ParsedArgs): Promise<number> {
  const ctx = createContext(args, { lruSize: 8 });
  const framesN = flagNum(args.flags, 'frames');
  const base = {
    thinking: flagBool(args.flags, 'thinking'),
    tools: ((): ToolsMode => {
      const t = flagStr(args.flags, 'tools');
      return t === 'full' || t === 'hidden' ? t : 'collapsed';
    })(),
    hideToolOnly: flagBool(args.flags, 'hide-tool-only'),
    showMeta: flagBool(args.flags, 'show-meta'),
    color: useColor(args.flags, process.stdout.isTTY === true),
    ascii: flagBool(args.flags, 'ascii') || process.env['HTHREADBOX_ASCII'] === '1',
  };

  if (framesN !== undefined) {
    const size = flagStr(args.flags, 'size') ?? '120x40';
    const m = /^(\d+)x(\d+)$/.exec(size);
    const cols = m ? Number(m[1]) : 120;
    const rows = m ? Number(m[2]) : 40;
    const io = new FakeTerminal(cols, rows);
    base.color = flagBool(args.flags, 'color');
    await ctx.store.scan();
    const app = new App(io, ctx.store, base, { clipboard: async () => ['fake'] });
    const done = app.run();
    await app.settle();
    const keys = (flagStr(args.flags, 'keys') ?? '').split(',').filter(Boolean);
    const frames: string[][] = [app.snapshot()];
    for (const k of keys) {
      await app.feedKeys([k], io);
      frames.push(app.snapshot());
      if (frames.length >= framesN) break;
    }
    frames.forEach((f, i) => {
      process.stdout.write(`---frame ${i}---\n${f.join('\n')}\n`);
    });
    app.quit(0);
    await done;
    return 0;
  }

  const io = new RealTerminal();
  if (!io.isTTY) {
    process.stderr.write('hthreadbox: TUI needs a terminal (use `hthreadbox cat` for piping)\n');
    return 2;
  }
  await ctx.store.scan();
  const app = new App(io, ctx.store, base);
  return app.run();
}
