import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ParsedArgs, flagBool, flagNum, flagStr, useColor } from '../cli/args.js';
import { createContext } from '../cli/context.js';
import { type SessionStore, type StoreEvent, refKey } from '../core/sessionStore.js';
import { sessionLabel } from '../core/types.js';
import { sanitizeFilename, sessionToMarkdown } from '../render/markdownExport.js';
import type { ToolsMode } from '../render/transcript.js';
import { displayWidth, truncateToWidth } from '../render/width.js';
import { type BaseRenderOptions, Document, type Top } from './document.js';
import { highlightAnsi } from './highlight.js';
import { type InputEvent, InputParser, type KeyEvent, type MouseEvent, keyNameToBytes } from './input.js';
import { type Layout, clampLeftWidth, computeLayout, defaultLeftWidth } from './layout.js';
import { Screen, fitAnsi } from './screen.js';
import { FakeTerminal, RealTerminal, type TerminalIO } from './terminal.js';
import { HELP_LINES } from './widgets/help.js';
import { LineInput } from './widgets/lineInput.js';
import { SessionList } from './widgets/sessionList.js';

type Mode = 'normal' | 'search' | 'export' | 'help';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class App {
  private screen: Screen;
  private input: InputParser;
  private doc: Document;
  private list = new SessionList();
  private focus: 'left' | 'right' = 'right';
  private top: Top | undefined;
  private follow = true;
  private pendingBottom: string | undefined;
  private leftWidth: number;
  private mode: Mode = 'normal';
  private lineInput: LineInput | undefined;
  private query = '';
  private message: { text: string; until: number } | undefined;
  private dragging = false;
  private renderScheduled = false;
  private layout: Layout;
  private quitResolve: ((code: number) => void) | undefined;
  private resizeTimer: NodeJS.Timeout | undefined;
  private searchGen = 0;
  private color: boolean;
  private pendingLoads = 0;

  constructor(
    private io: TerminalIO,
    private store: SessionStore,
    base: Omit<BaseRenderOptions, 'width'>,
  ) {
    this.color = base.color;
    this.leftWidth = defaultLeftWidth(io.cols);
    this.layout = computeLayout(io.cols, io.rows, this.leftWidth, this.focus);
    this.screen = new Screen(io, io.cols, io.rows);
    this.doc = new Document(store, { ...base, width: this.layout.right.w });
    this.list.ascii = base.ascii;
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
    this.doc.refreshOrder();
    this.list.setGroups(this.store.groups());
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

  private initialPosition(): void {
    const order = this.doc.order;
    if (order.length === 0) {
      this.top = undefined;
      return;
    }
    const live = order.filter((e) => e.live).sort((a, b) => (b.updatedAt ?? b.mtimeMs) - (a.updatedAt ?? a.mtimeMs));
    const target = live[0] ?? order[order.length - 1]!;
    const key = refKey(target.ref);
    this.top = this.doc.topOf(key);
    this.pendingBottom = key;
    this.follow = true;
    this.list.select(key);
    this.doc.preload(this.doc.indexOf(key));
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
        this.doc.refreshOrder();
        this.list.setGroups(this.store.groups());
        if (this.top && this.doc.indexOf(this.top.key) < 0) this.initialPosition();
        if (!this.top) this.initialPosition();
        break;
      }
      case 'session': {
        if (!this.top) break;
        const h = this.layout.right.h;
        const before = this.top.key === ev.key ? this.doc.locate(this.top) : undefined;
        this.doc.cache(ev.key); // re-render dirty turns now
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
    const h = this.layout.right.h;
    if (this.pendingBottom === key) {
      this.pendingBottom = undefined;
      this.top = this.doc.clampToEnd(this.doc.indexOf(key), h);
      this.syncLeft();
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
    const h = this.layout.right.h;
    const left = this.focus === 'left' && this.layout.left !== undefined;
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
      case 'backtab':
        this.focus = this.focus === 'left' ? 'right' : 'left';
        return;
      case 'j':
      case 'down':
        return left ? this.moveSel(1) : this.scroll(1);
      case 'k':
      case 'up':
        return left ? this.moveSel(-1) : this.scroll(-1);
      case 'pagedown':
      case 'space':
        return left ? this.moveSel(h - 1) : this.scroll(h - 1);
      case 'pageup':
        return left ? this.moveSel(-(h - 1)) : this.scroll(-(h - 1));
      case 'f':
        if (ev.ctrl) return left ? this.moveSel(h - 1) : this.scroll(h - 1);
        return;
      case 'b':
        if (ev.ctrl) return left ? this.moveSel(-(h - 1)) : this.scroll(-(h - 1));
        return;
      case 'd':
        return left ? undefined : this.scroll(Math.floor(h / 2));
      case 'u':
        return left ? undefined : this.scroll(-Math.floor(h / 2));
      case 'g':
        if (left) {
          this.list.first();
          return;
        }
        return this.jumpTo(this.doc.keyAt(0), false);
      case 'G':
        if (left) {
          this.list.last();
          return;
        }
        return this.gotoEnd();
      case 'home':
        return left ? void this.list.first() : this.jumpTo(this.doc.keyAt(0), false);
      case 'end':
        return left ? void this.list.last() : this.gotoEnd();
      case 'enter':
        if (left && this.list.selectedKey) this.jumpTo(this.list.selectedKey, false);
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
        this.leftWidth = clampLeftWidth(this.io.cols, this.leftWidth - 2);
        return;
      case ']':
        this.leftWidth = clampLeftWidth(this.io.cols, this.leftWidth + 2);
        return;
      case '\\':
        this.leftWidth = defaultLeftWidth(this.io.cols);
        return;
      case 'e': {
        const key = left ? this.list.selectedKey : this.currentKey();
        const e = key ? this.doc.entry(key) : undefined;
        if (!e) return;
        this.mode = 'export';
        this.lineInput = new LineInput('export to: ', path.join(process.cwd(), `${sanitizeFilename(sessionLabel(e))}.md`));
        return;
      }
      case 'r':
        void this.store.scan().then(() => this.toast('rescanned'));
        return;
      default:
        return;
    }
  }

  private onMouse(ev: MouseEvent): void {
    const lay = this.layout;
    const inLeft = lay.left !== undefined && ev.x < lay.left.x + lay.left.w && ev.y < lay.left.h && !(lay.single && this.focus === 'right');
    const onDivider = lay.divider !== undefined && ev.x === lay.divider;
    if (ev.action === 'wheel-up' || ev.action === 'wheel-down') {
      const d = ev.action === 'wheel-up' ? -3 : 3;
      if (inLeft) this.list.scrollBy(d, lay.left!.h);
      else this.scroll(d);
      return;
    }
    if (ev.action === 'press' && ev.button === 0) {
      if (onDivider) {
        this.dragging = true;
        return;
      }
      if (inLeft) {
        this.focus = 'left';
        const row = this.list.rowAt(ev.y);
        if (row?.kind === 'session') {
          this.list.select(row.key);
          this.jumpTo(row.key, false);
        }
        return;
      }
      this.focus = 'right';
      return;
    }
    if (ev.action === 'drag' && this.dragging) {
      this.leftWidth = clampLeftWidth(this.io.cols, ev.x);
      return;
    }
    if (ev.action === 'release') this.dragging = false;
  }

  // ---------- navigation ----------

  private scroll(delta: number): void {
    if (!this.top) return;
    const h = this.layout.right.h;
    this.top = this.doc.scrollBy(this.top, delta, h);
    if (delta < 0) this.follow = false;
    else this.updateFollowAtEnd();
    this.syncLeft();
  }

  private updateFollowAtEnd(): void {
    if (!this.top) return;
    const h = this.layout.right.h;
    const bottom = this.doc.bottomKey(this.top, h);
    const e = this.doc.entry(bottom);
    if (e?.live && this.doc.showsEndOf(this.top, h, bottom)) this.follow = true;
  }

  private moveSel(delta: number): void {
    this.list.move(delta);
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
    const i = n - 1;
    const key = this.doc.keyAt(i)!;
    if (!this.doc.isLoaded(key)) {
      this.top = this.doc.topOf(key);
      this.pendingBottom = key;
      this.doc.preload(i);
    } else {
      this.top = this.doc.clampToEnd(i, this.layout.right.h);
      this.doc.preload(i);
    }
    this.follow = true;
    this.syncLeft();
  }

  private nextLive(): void {
    const order = this.doc.order;
    const live = order.map((e, i) => ({ e, i })).filter((x) => x.e.live);
    if (live.length === 0) return this.toast('no live sessions');
    const cur = this.top ? this.doc.indexOf(this.top.key) : -1;
    const next = live.find((x) => x.i > cur) ?? live[0]!;
    const key = refKey(next.e.ref);
    if (this.doc.isLoaded(key)) {
      this.top = this.doc.clampToEnd(next.i, this.layout.right.h);
      this.doc.preload(next.i);
    } else {
      this.top = this.doc.topOf(key);
      this.pendingBottom = key;
      this.doc.preload(next.i);
    }
    this.follow = true;
    this.syncLeft();
  }

  /** The session the user is "on": the bottom one while following, else the top one. */
  private currentKey(): string | undefined {
    if (!this.top) return undefined;
    if (this.follow) return this.doc.bottomKey(this.top, this.layout.right.h);
    return this.top.key;
  }

  private syncLeft(): void {
    const k = this.currentKey();
    if (k) this.list.select(k);
  }

  private setBase(patch: Partial<BaseRenderOptions>): void {
    const b = { ...this.doc.getBase(), ...patch };
    this.doc.setBase(b);
    if (this.top) this.top = this.doc.clamp(this.top, this.layout.right.h);
    const parts = [`thinking:${b.thinking ? 'on' : 'off'}`, `tools:${b.tools}`, `tool-only:${b.hideToolOnly ? 'hidden' : 'shown'}`, `meta:${b.showMeta ? 'on' : 'off'}`];
    this.toast(parts.join(' '), 1500);
  }

  // ---------- search ----------

  private async search(dir: 1 | -1, fromCurrent: boolean): Promise<void> {
    if (!this.top || !this.query) return;
    const gen = ++this.searchGen;
    const q = this.query.toLowerCase();
    const n = this.doc.order.length;
    const h = this.layout.right.h;
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
    this.toast(`no match: ${this.query}`);
  }

  private foundAt(key: string, line: number, h: number): void {
    this.top = this.doc.scrollBy({ key, line }, 0, h);
    this.follow = false;
    this.pendingBottom = undefined;
    this.doc.preload(this.doc.indexOf(key));
    this.syncLeft();
    this.toast(`match: ${this.query}`, 1500);
  }

  // ---------- export ----------

  private async exportTo(file: string): Promise<void> {
    const key = this.focus === 'left' && this.layout.left ? this.list.selectedKey : this.currentKey();
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
    this.layout = computeLayout(cols, rows, this.leftWidth, this.focus);
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
    if (this.focus === 'right' || !lay.left) this.syncLeft();
    this.screen.begin();

    const showLeft = lay.left !== undefined && !(lay.single && this.focus === 'right');
    const showRight = !(lay.single && this.focus === 'left');
    const leftRows = showLeft ? this.list.render(lay.left!.w, lay.left!.h, this.focus === 'left', this.color) : [];
    const rightRows = showRight ? this.renderRight(lay.right.w, lay.right.h) : [];
    const divider = this.color ? `\x1b[2m│\x1b[0m` : '│';
    for (let y = 0; y < rows - 1; y++) {
      let row = '';
      if (showLeft) row += fitAnsi(leftRows[y] ?? '', lay.left!.w);
      if (showLeft && showRight && lay.divider !== undefined) row += divider;
      if (showRight) row += fitAnsi(rightRows[y] ?? '', lay.right.w);
      this.screen.set(y, row);
    }
    this.screen.set(lay.statusY, this.renderStatus(cols));
    if (this.mode === 'help') this.renderHelp();
    this.screen.flush();
  }

  private renderRight(w: number, h: number): string[] {
    if (!this.top) {
      const msg = this.doc.order.length === 0 ? 'no sessions found' : '';
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
    void w;
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
    const app = new App(io, ctx.store, base);
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
