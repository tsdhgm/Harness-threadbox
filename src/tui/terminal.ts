export interface TerminalIO {
  readonly isTTY: boolean;
  cols: number;
  rows: number;
  write(s: string): void;
  onResize(cb: () => void): void;
  onInput(cb: (data: Buffer) => void): void;
  /** enter raw mode + alt screen + mouse */
  enter(): void;
  /** restore everything */
  exit(): void;
}

const ENTER_SEQ = '\x1b[?1049h\x1b[?25l\x1b[?1000;1002;1006h\x1b[?2004l';
const EXIT_SEQ = '\x1b[?1000;1002;1006l\x1b[?25h\x1b[?1049l';

export class RealTerminal implements TerminalIO {
  readonly isTTY: boolean;
  cols: number;
  rows: number;
  private entered = false;
  private resizeCbs: Array<() => void> = [];
  private inputCbs: Array<(d: Buffer) => void> = [];
  private restoreHooks: Array<() => void> = [];

  constructor(
    private out: NodeJS.WriteStream = process.stdout,
    private inp: NodeJS.ReadStream = process.stdin,
  ) {
    this.isTTY = out.isTTY === true && inp.isTTY === true;
    this.cols = out.columns ?? 80;
    this.rows = out.rows ?? 24;
  }

  write(s: string): void {
    if (s) this.out.write(s);
  }

  onResize(cb: () => void): void {
    this.resizeCbs.push(cb);
  }

  onInput(cb: (d: Buffer) => void): void {
    this.inputCbs.push(cb);
  }

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    if (this.inp.isTTY) this.inp.setRawMode(true);
    this.inp.resume();
    this.inp.on('data', this.handleData);
    this.out.on('resize', this.handleResize);
    this.out.write(ENTER_SEQ);
    const restore = (): void => this.exit();
    const onSig = (): void => {
      this.exit();
      process.exit(130);
    };
    const onErr = (err: unknown): void => {
      this.exit();
      process.stderr.write(`hthreadbox: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    };
    process.on('exit', restore);
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    process.on('SIGHUP', onSig);
    process.on('uncaughtException', onErr);
    process.on('unhandledRejection', onErr);
    this.restoreHooks.push(() => {
      process.off('exit', restore);
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
      process.off('SIGHUP', onSig);
      process.off('uncaughtException', onErr);
      process.off('unhandledRejection', onErr);
    });
  }

  exit(): void {
    if (!this.entered) return;
    this.entered = false;
    this.out.write(EXIT_SEQ);
    this.inp.off('data', this.handleData);
    this.out.off('resize', this.handleResize);
    if (this.inp.isTTY) {
      try {
        this.inp.setRawMode(false);
      } catch {
        // ignore
      }
    }
    this.inp.pause();
    for (const h of this.restoreHooks) h();
    this.restoreHooks = [];
  }

  private handleData = (d: Buffer): void => {
    for (const cb of this.inputCbs) cb(d);
  };

  private handleResize = (): void => {
    this.cols = this.out.columns ?? this.cols;
    this.rows = this.out.rows ?? this.rows;
    for (const cb of this.resizeCbs) cb();
  };
}

/** In-memory terminal for tests and --frames mode. */
export class FakeTerminal implements TerminalIO {
  readonly isTTY = true;
  private inputCbs: Array<(d: Buffer) => void> = [];
  private resizeCbs: Array<() => void> = [];
  output = '';
  constructor(
    public cols: number,
    public rows: number,
  ) {}
  write(s: string): void {
    this.output += s;
  }
  onResize(cb: () => void): void {
    this.resizeCbs.push(cb);
  }
  onInput(cb: (d: Buffer) => void): void {
    this.inputCbs.push(cb);
  }
  enter(): void {}
  exit(): void {}
  feed(data: Buffer | string): void {
    const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    for (const cb of this.inputCbs) cb(b);
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    for (const cb of this.resizeCbs) cb();
  }
}
