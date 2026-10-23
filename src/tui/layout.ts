export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  cols: number;
  rows: number;
  left: Rect | undefined;
  divider: number | undefined;
  right: Rect;
  statusY: number;
  /** when true the terminal is too narrow for two panes */
  single: boolean;
}

export const MIN_LEFT = 20;
export const MIN_RIGHT = 40;
export const SINGLE_PANE_BELOW = 70;

export function defaultLeftWidth(cols: number): number {
  return Math.max(28, Math.min(48, Math.floor(cols * 0.3)));
}

export function clampLeftWidth(cols: number, w: number): number {
  return Math.max(MIN_LEFT, Math.min(cols - MIN_RIGHT - 1, w));
}

export function computeLayout(cols: number, rows: number, leftWidth: number, focus: 'left' | 'right'): Layout {
  const statusY = rows - 1;
  const h = Math.max(1, rows - 1);
  if (cols < SINGLE_PANE_BELOW) {
    if (focus === 'left') {
      return { cols, rows, left: { x: 0, y: 0, w: cols, h }, divider: undefined, right: { x: 0, y: 0, w: cols, h }, statusY, single: true };
    }
    return { cols, rows, left: undefined, divider: undefined, right: { x: 0, y: 0, w: cols, h }, statusY, single: true };
  }
  const lw = clampLeftWidth(cols, leftWidth);
  return {
    cols,
    rows,
    left: { x: 0, y: 0, w: lw, h },
    divider: lw,
    right: { x: lw + 1, y: 0, w: cols - lw - 1, h },
    statusY,
    single: false,
  };
}
