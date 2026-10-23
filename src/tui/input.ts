export interface KeyEvent {
  type: 'key';
  /** 'up','down','left','right','pageup','pagedown','home','end','enter','escape','tab','backtab','backspace','delete','space', or the character */
  name: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface MouseEvent {
  type: 'mouse';
  action: 'press' | 'release' | 'drag' | 'move' | 'wheel-up' | 'wheel-down';
  button: number;
  /** 0-based column */
  x: number;
  /** 0-based row */
  y: number;
}

export type InputEvent = KeyEvent | MouseEvent;

const ESC_TIMEOUT_MS = 30;

const CSI_KEYS: Record<string, string> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab',
  '1~': 'home',
  '2~': 'insert',
  '3~': 'delete',
  '4~': 'end',
  '5~': 'pageup',
  '6~': 'pagedown',
  '7~': 'home',
  '8~': 'end',
};

function key(name: string, mods: Partial<Pick<KeyEvent, 'ctrl' | 'alt' | 'shift'>> = {}): KeyEvent {
  return { type: 'key', name, ctrl: mods.ctrl ?? false, alt: mods.alt ?? false, shift: mods.shift ?? false };
}

/** Incremental decoder of terminal input bytes into events. */
export class InputParser {
  private buf = '';
  private timer: NodeJS.Timeout | undefined;

  constructor(private emit: (ev: InputEvent) => void) {}

  feed(data: Buffer): void {
    this.buf += data.toString('utf8');
    this.drain();
  }

  private drain(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.buf.length > 0) {
      const consumed = this.parseOne();
      if (consumed === 0) {
        // incomplete escape sequence: wait briefly for the rest
        this.timer = setTimeout(() => {
          this.timer = undefined;
          if (this.buf.startsWith('\x1b')) {
            // lone ESC (or unknown sequence): emit escape and drop one byte
            this.buf = this.buf.slice(1);
            this.emit(key('escape'));
            this.drain();
          }
        }, ESC_TIMEOUT_MS);
        return;
      }
      this.buf = this.buf.slice(consumed);
    }
  }

  /** Parse one event from the front of buf; return bytes consumed (0 = need more). */
  private parseOne(): number {
    const s = this.buf;
    const c = s.charCodeAt(0);
    if (c !== 0x1b) {
      // plain char / control
      const ch = String.fromCodePoint(s.codePointAt(0)!);
      const len = ch.length;
      if (c === 0x0d || c === 0x0a) this.emit(key('enter'));
      else if (c === 0x09) this.emit(key('tab'));
      else if (c === 0x7f || c === 0x08) this.emit(key('backspace'));
      else if (c === 0x20) this.emit(key('space'));
      else if (c < 0x20) this.emit(key(String.fromCharCode(c + 0x60), { ctrl: true }));
      else this.emit(key(ch, { shift: ch !== ch.toLowerCase() && ch.length === 1 }));
      return len;
    }
    if (s.length === 1) return 0;
    const n = s[1]!;
    if (n === '[') {
      // CSI
      if (s.length < 3) return 0;
      if (s[2] === '<') {
        // SGR mouse: ESC [ < b ; x ; y (M|m)
        const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
        if (!m) return /^\x1b\[<[\d;]*$/.test(s) ? 0 : 3;
        const b = Number(m[1]);
        const x = Number(m[2]) - 1;
        const y = Number(m[3]) - 1;
        const release = m[4] === 'm';
        const button = b & 3;
        if (b & 64) this.emit({ type: 'mouse', action: button === 0 ? 'wheel-up' : 'wheel-down', button, x, y });
        else if (b & 32) this.emit({ type: 'mouse', action: button === 3 ? 'move' : 'drag', button, x, y });
        else this.emit({ type: 'mouse', action: release ? 'release' : 'press', button, x, y });
        return m[0].length;
      }
      const m = /^\x1b\[([\d;]*)([A-Za-z~])/.exec(s);
      if (!m) return /^\x1b\[[\d;]*$/.test(s) ? 0 : 2;
      const params = m[1]!;
      const final = m[2]!;
      const parts = params.split(';').filter(Boolean).map(Number);
      let mod = 0;
      let name: string | undefined;
      if (final === '~') {
        name = CSI_KEYS[`${parts[0] ?? ''}~`];
        mod = parts[1] ?? 0;
      } else {
        name = CSI_KEYS[final];
        mod = parts.length >= 2 ? parts[1]! : parts.length === 1 && final !== 'Z' ? 0 : 0;
        if (parts.length === 2) mod = parts[1]!;
      }
      if (name) {
        const mods = { shift: ((mod - 1) & 1) !== 0 || final === 'Z', alt: ((mod - 1) & 2) !== 0, ctrl: ((mod - 1) & 4) !== 0 };
        this.emit(key(name, mod > 0 ? mods : { shift: final === 'Z' }));
      }
      return m[0].length;
    }
    if (n === 'O') {
      if (s.length < 3) return 0;
      const name = CSI_KEYS[s[2]!];
      if (name) this.emit(key(name));
      return 3;
    }
    // Alt + key
    const ch = String.fromCodePoint(s.codePointAt(1)!);
    if (ch === '\x1b') {
      this.emit(key('escape'));
      return 1;
    }
    this.emit(key(ch, { alt: true }));
    return 1 + ch.length;
  }
}

/** Convert a human key name (for --keys) to raw bytes. */
export function keyNameToBytes(name: string): string {
  const map: Record<string, string> = {
    Enter: '\r',
    Tab: '\t',
    BackTab: '\x1b[Z',
    Esc: '\x1b',
    Escape: '\x1b',
    Up: '\x1b[A',
    Down: '\x1b[B',
    Left: '\x1b[D',
    Right: '\x1b[C',
    PgUp: '\x1b[5~',
    PgDn: '\x1b[6~',
    Home: '\x1b[H',
    End: '\x1b[F',
    Space: ' ',
    Backspace: '\x7f',
    'C-c': '\x03',
    'C-f': '\x06',
    'C-b': '\x02',
    'C-d': '\x04',
    'C-u': '\x15',
  };
  return map[name] ?? name;
}
