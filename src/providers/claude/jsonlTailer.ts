import * as fs from 'node:fs';

export interface PullResult {
  /** complete lines (without trailing newline / CR) */
  lines: string[];
  /** file shrank below our offset: caller must reload from scratch */
  reset: boolean;
  /** bytes consumed in this pull */
  consumed: number;
}

const CHUNK = 1 << 20; // 1 MiB

/**
 * Newline-safe incremental JSONL reader.
 *
 * Invariant: `offset` always points one byte past a consumed '\n' (or 0).
 * We never derive the offset from stat.size: we read to the real EOF, then
 * split on the LAST '\n' at the byte level (before UTF-8 decode) and keep
 * any trailing partial line for the next pull.
 */
export class JsonlTailer {
  offset = 0;

  constructor(public readonly path: string) {}

  reset(): void {
    this.offset = 0;
  }

  /**
   * Read everything appended since `offset`. `maxBytes` limits one pull so
   * callers can yield between slices on huge initial loads.
   */
  async pull(maxBytes = Infinity): Promise<PullResult> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(this.path);
    } catch {
      return { lines: [], reset: false, consumed: 0 };
    }
    if (st.size < this.offset) {
      this.offset = 0;
      return { lines: [], reset: true, consumed: 0 };
    }
    if (st.size === this.offset) return { lines: [], reset: false, consumed: 0 };

    const fh = await fs.promises.open(this.path, 'r');
    try {
      const chunks: Buffer[] = [];
      let pos = this.offset;
      let total = 0;
      for (;;) {
        if (total >= maxBytes) break;
        const want = Math.min(CHUNK, maxBytes === Infinity ? CHUNK : maxBytes - total);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (bytesRead === 0) break;
        chunks.push(buf.subarray(0, bytesRead));
        pos += bytesRead;
        total += bytesRead;
      }
      if (chunks.length === 0) return { lines: [], reset: false, consumed: 0 };
      const all = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      const lastNl = all.lastIndexOf(0x0a);
      if (lastNl < 0) {
        // only a partial line so far: wait for more
        return { lines: [], reset: false, consumed: 0 };
      }
      const complete = all.subarray(0, lastNl);
      this.offset += lastNl + 1;
      const lines = complete
        .toString('utf8')
        .split('\n')
        .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
        .filter((l) => l.length > 0);
      return { lines, reset: false, consumed: lastNl + 1 };
    } finally {
      await fh.close();
    }
  }
}

/** Read a byte range and return only complete lines inside it (used by the indexer). */
export async function readLinesInRange(
  filePath: string,
  start: number,
  end: number,
  opts: { dropFirstPartial: boolean },
): Promise<string[]> {
  if (end <= start) return [];
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const len = end - start;
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    let b = buf.subarray(0, bytesRead);
    if (opts.dropFirstPartial && start > 0) {
      const nl = b.indexOf(0x0a);
      if (nl < 0) return [];
      b = b.subarray(nl + 1);
    }
    const lastNl = b.lastIndexOf(0x0a);
    const complete = lastNl >= 0 ? b.subarray(0, lastNl) : (bytesRead < len ? b : Buffer.alloc(0));
    return complete
      .toString('utf8')
      .split('\n')
      .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
      .filter((l) => l.length > 0);
  } finally {
    await fh.close();
  }
}
