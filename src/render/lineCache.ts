import type { Session } from '../core/types.js';
import { sessionLabel } from '../core/types.js';
import { type RenderOptions, type RenderedLine, filterHash, renderSessionHeader, renderTurn } from './transcript.js';

/**
 * Per-session cache of rendered lines: one array per turn (+ header at index 0)
 * with prefix sums for O(log n) line lookup. Only dirty turns re-render.
 */
export class SessionLineCache {
  private blocks: RenderedLine[][] = [];
  private cum: number[] = [];
  private key = '';
  private renderedTurns = 0;
  private titleKey = '';

  constructor(public readonly session: Session) {}

  /** Make the cache consistent with the session + options. Returns true if anything changed. */
  ensure(o: RenderOptions): boolean {
    const k = filterHash(o);
    const title = sessionLabel(this.session.index);
    let changed = false;
    if (k !== this.key || this.blocks.length === 0) {
      this.key = k;
      this.blocks = [renderSessionHeader(this.session.index, title, o)];
      this.titleKey = title;
      for (const t of this.session.turns) {
        this.blocks.push(renderTurn(t, o));
        t.dirty = false;
      }
      this.renderedTurns = this.session.turns.length;
      changed = true;
    } else {
      if (title !== this.titleKey) {
        this.blocks[0] = renderSessionHeader(this.session.index, title, o);
        this.titleKey = title;
        changed = true;
      }
      const turns = this.session.turns;
      for (let i = 0; i < this.renderedTurns; i++) {
        const t = turns[i]!;
        if (t.dirty) {
          this.blocks[i + 1] = renderTurn(t, o);
          t.dirty = false;
          changed = true;
        }
      }
      for (let i = this.renderedTurns; i < turns.length; i++) {
        const t = turns[i]!;
        this.blocks.push(renderTurn(t, o));
        t.dirty = false;
        changed = true;
      }
      this.renderedTurns = turns.length;
    }
    if (changed) this.rebuildCum();
    return changed;
  }

  private rebuildCum(): void {
    this.cum = new Array(this.blocks.length + 1);
    this.cum[0] = 0;
    for (let i = 0; i < this.blocks.length; i++) this.cum[i + 1] = this.cum[i]! + this.blocks[i]!.length;
  }

  total(): number {
    return this.cum[this.cum.length - 1] ?? 0;
  }

  /** Locate block index and offset for a global line index. */
  locate(line: number): { block: number; offset: number } | undefined {
    const n = this.blocks.length;
    if (n === 0 || line < 0 || line >= this.total()) return undefined;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid]! <= line) lo = mid;
      else hi = mid - 1;
    }
    return { block: lo, offset: line - this.cum[lo]! };
  }

  lineAt(line: number): RenderedLine | undefined {
    const loc = this.locate(line);
    if (!loc) return undefined;
    return this.blocks[loc.block]![loc.offset];
  }

  /** First line index of a turn (by turn id), or undefined. */
  lineIndexOfTurn(turnId: string): number | undefined {
    const idx = this.session.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) return undefined;
    return this.cum[idx + 1];
  }

  /** First line index of block i (0 = header). */
  lineIndexOfBlock(i: number): number {
    return this.cum[i] ?? 0;
  }

  /** All lines (for cat/export). */
  *lines(): Iterable<RenderedLine> {
    for (const b of this.blocks) for (const l of b) yield l;
  }

  blockCount(): number {
    return this.blocks.length;
  }
}
