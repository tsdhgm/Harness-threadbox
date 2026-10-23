import { displayWidth, truncateToWidth } from '../../render/width.js';
import type { KeyEvent } from '../input.js';

/** Single-line text input used for search and export path prompts. */
export class LineInput {
  value = '';
  cursor = 0;
  constructor(
    public prompt: string,
    initial = '',
  ) {
    this.value = initial;
    this.cursor = initial.length;
  }

  /** Returns 'submit' | 'cancel' | 'edit'. */
  handle(ev: KeyEvent): 'submit' | 'cancel' | 'edit' {
    if (ev.name === 'enter') return 'submit';
    if (ev.name === 'escape' || (ev.ctrl && ev.name === 'c') || (ev.ctrl && ev.name === 'g')) return 'cancel';
    if (ev.name === 'backspace') {
      if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor--;
      }
      return 'edit';
    }
    if (ev.name === 'delete') {
      this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
      return 'edit';
    }
    if (ev.name === 'left') {
      this.cursor = Math.max(0, this.cursor - 1);
      return 'edit';
    }
    if (ev.name === 'right') {
      this.cursor = Math.min(this.value.length, this.cursor + 1);
      return 'edit';
    }
    if (ev.name === 'home' || (ev.ctrl && ev.name === 'a')) {
      this.cursor = 0;
      return 'edit';
    }
    if (ev.name === 'end' || (ev.ctrl && ev.name === 'e')) {
      this.cursor = this.value.length;
      return 'edit';
    }
    if (ev.ctrl && ev.name === 'u') {
      this.value = this.value.slice(this.cursor);
      this.cursor = 0;
      return 'edit';
    }
    if (ev.ctrl && ev.name === 'w') {
      const before = this.value.slice(0, this.cursor).replace(/\S+\s*$/, '');
      this.value = before + this.value.slice(this.cursor);
      this.cursor = before.length;
      return 'edit';
    }
    if (ev.name === 'space') {
      this.insert(' ');
      return 'edit';
    }
    if (!ev.ctrl && !ev.alt && ev.name.length >= 1 && ![...'up down left right tab backtab pageup pagedown insert'.split(' ')].includes(ev.name)) {
      this.insert(ev.name);
    }
    return 'edit';
  }

  private insert(s: string): void {
    this.value = this.value.slice(0, this.cursor) + s + this.value.slice(this.cursor);
    this.cursor += s.length;
  }

  render(w: number, color: boolean): string {
    const p = this.prompt;
    const avail = Math.max(1, w - displayWidth(p) - 1);
    const text = truncateToWidth(this.value, avail, '');
    const body = `${p}${text}`;
    const pad = ' '.repeat(Math.max(0, w - displayWidth(body)));
    return color ? `\x1b[1m${p}\x1b[0m${text}\x1b[7m \x1b[0m${pad.slice(1)}` : `${body}_${pad.slice(1)}`;
  }
}
