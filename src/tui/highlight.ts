/** Wrap every case-insensitive match of `query` in the ANSI string with inverse video. */
export function highlightAnsi(ansi: string, plain: string, query: string): string {
  if (!query) return ansi;
  const lq = query.toLowerCase();
  const lp = plain.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const i = lp.indexOf(lq, from);
    if (i < 0) break;
    ranges.push([i, i + lq.length]);
    from = i + Math.max(1, lq.length);
  }
  if (ranges.length === 0) return ansi;
  let out = '';
  let pi = 0; // plain index (in UTF-16 units)
  let ri = 0;
  let inMatch = false;
  let i = 0;
  while (i < ansi.length) {
    if (ansi.charCodeAt(i) === 0x1b) {
      const m = /^\x1b\[[0-9;]*m/.exec(ansi.slice(i, i + 32));
      if (m) {
        out += m[0];
        if (inMatch) out += '\x1b[7m';
        i += m[0].length;
        continue;
      }
    }
    const r = ranges[ri];
    if (r && !inMatch && pi >= r[0]) {
      out += '\x1b[7m';
      inMatch = true;
    }
    const cp = ansi.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out += ch;
    i += ch.length;
    pi += ch.length;
    if (r && inMatch && pi >= r[1]) {
      out += '\x1b[27m';
      inMatch = false;
      ri++;
    }
  }
  if (inMatch) out += '\x1b[27m';
  return out;
}
