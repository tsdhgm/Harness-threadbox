export type Color =
  | 'default'
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'gray'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite';

export interface Style {
  fg?: Color;
  bg?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

export interface StyledRun {
  text: string;
  style: Style;
}

const FG: Record<Color, number> = {
  default: 39,
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  brightRed: 91,
  brightGreen: 92,
  brightYellow: 93,
  brightBlue: 94,
  brightMagenta: 95,
  brightCyan: 96,
  brightWhite: 97,
};

export const RESET = '\x1b[0m';

/** SGR parameter list (without ESC[ and m) for a style; '' for plain. */
export function sgrParams(s: Style): string {
  const p: number[] = [];
  if (s.bold) p.push(1);
  if (s.dim) p.push(2);
  if (s.italic) p.push(3);
  if (s.underline) p.push(4);
  if (s.inverse) p.push(7);
  if (s.strike) p.push(9);
  if (s.fg && s.fg !== 'default') p.push(FG[s.fg]);
  if (s.bg && s.bg !== 'default') p.push(FG[s.bg] + 10);
  return p.join(';');
}

export function sgr(s: Style): string {
  const p = sgrParams(s);
  return p ? `\x1b[${p}m` : '';
}

export function styled(text: string, style: Style = {}): StyledRun {
  return { text, style };
}

export function plain(text: string): StyledRun {
  return { text, style: {} };
}

export function merge(a: Style, b: Style): Style {
  return { ...a, ...b };
}

/** Render runs to a single ANSI string (no wrapping). */
export function runsToAnsi(runs: StyledRun[], color: boolean): string {
  if (!color) return runs.map((r) => r.text).join('');
  let out = '';
  let cur = '';
  for (const r of runs) {
    const p = sgrParams(r.style);
    if (p !== cur) {
      out += RESET;
      if (p) out += `\x1b[${p}m`;
      cur = p;
    }
    out += r.text;
  }
  if (cur) out += RESET;
  return out;
}

export function runsToPlain(runs: StyledRun[]): string {
  return runs.map((r) => r.text).join('');
}

 
const RE_ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
 
const RE_C0 = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function stripAnsi(s: string): string {
  return s.replace(RE_ANSI, '');
}

/** Remove escape sequences and control chars that would corrupt the screen; expand tabs. */
export function sanitizeText(s: string, tabWidth = 4): string {
  return s
    .replace(RE_ANSI, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' '.repeat(tabWidth))
    .replace(RE_C0, '');
}
