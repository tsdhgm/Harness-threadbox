import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const cache = new Map<string, number>();

export interface Cell {
  /** grapheme */
  g: string;
  /** display width (0, 1, 2) */
  w: number;
}

export function graphemeWidth(g: string): number {
  if (g.length === 1) {
    const c = g.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return 1;
    if (c < 0x20 || c === 0x7f) return 0;
  }
  let w = cache.get(g);
  if (w === undefined) {
    w = stringWidth(g);
    if (cache.size > 50000) cache.clear();
    cache.set(g, w);
  }
  return w;
}

export function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7e) return false;
  return true;
}

/** Split into grapheme cells with widths. Newlines are kept as cells with w=0. */
export function toCells(s: string): Cell[] {
  const out: Cell[] = [];
  if (isAscii(s)) {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!;
      const c = s.charCodeAt(i);
      out.push({ g: ch, w: c >= 0x20 && c < 0x7f ? 1 : 0 });
    }
    return out;
  }
  for (const seg of segmenter.segment(s)) {
    const g = seg.segment;
    out.push({ g, w: g === '\n' ? 0 : graphemeWidth(g) });
  }
  return out;
}

export function displayWidth(s: string): number {
  if (isAscii(s)) {
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x20 && c < 0x7f) n++;
    }
    return n;
  }
  let n = 0;
  for (const seg of segmenter.segment(s)) n += graphemeWidth(seg.segment);
  return n;
}

/** Truncate to at most `width` columns, appending `ellipsis` if cut. */
export function truncateToWidth(s: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  if (displayWidth(s) <= width) return s;
  const ew = displayWidth(ellipsis);
  const target = Math.max(0, width - ew);
  let out = '';
  let w = 0;
  for (const seg of segmenter.segment(s)) {
    const gw = graphemeWidth(seg.segment);
    if (w + gw > target) break;
    out += seg.segment;
    w += gw;
  }
  return out + ellipsis;
}

export function padToWidth(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** Is this grapheme "wide/CJK-ish" so that we may break on either side of it? */
export function isWideBreakable(g: string): boolean {
  if (g.length === 0) return false;
  const c = g.codePointAt(0)!;
  // CJK unified, Hiragana/Katakana, Hangul, fullwidth forms, CJK punctuation
  return (
    (c >= 0x1100 && c <= 0x11ff) ||
    (c >= 0x2e80 && c <= 0x9fff) ||
    (c >= 0xac00 && c <= 0xd7af) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xffef) ||
    (c >= 0x20000 && c <= 0x3134f)
  );
}
