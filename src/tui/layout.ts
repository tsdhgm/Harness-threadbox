export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Focus = 'projects' | 'sessions' | 'right';

export interface PaneWidths {
  projects: number;
  sessions: number;
}

export interface Layout {
  cols: number;
  rows: number;
  /** undefined when the pane is hidden (single-pane mode) */
  projects: Rect | undefined;
  sessions: Rect | undefined;
  /** always defined; in single-pane mode it spans the whole width even when not shown */
  right: Rect;
  /** divider columns: between projects|sessions and sessions|right */
  div1: number | undefined;
  div2: number | undefined;
  statusY: number;
  /** when true the terminal is too narrow for three panes; only the focused pane is shown */
  single: boolean;
}

export const MIN_PROJECTS = 14;
export const MIN_SESSIONS = 20;
export const MIN_RIGHT = 40;
export const SINGLE_PANE_BELOW = 80;

export function defaultWidths(cols: number): PaneWidths {
  return {
    projects: Math.max(MIN_PROJECTS, Math.min(28, Math.floor(cols * 0.15))),
    sessions: Math.max(MIN_SESSIONS, Math.min(40, Math.floor(cols * 0.22))),
  };
}

export function clampWidths(cols: number, w: PaneWidths): PaneWidths {
  const projects = Math.max(MIN_PROJECTS, Math.min(cols - MIN_SESSIONS - MIN_RIGHT - 2, w.projects));
  const sessions = Math.max(MIN_SESSIONS, Math.min(cols - projects - MIN_RIGHT - 2, w.sessions));
  return { projects, sessions };
}

export function nextFocus(f: Focus, dir: 1 | -1): Focus {
  const order: Focus[] = ['projects', 'sessions', 'right'];
  const i = order.indexOf(f);
  return order[(i + dir + order.length) % order.length]!;
}

export function computeLayout(cols: number, rows: number, widths: PaneWidths, focus: Focus): Layout {
  const statusY = rows - 1;
  const h = Math.max(1, rows - 1);
  if (cols < SINGLE_PANE_BELOW) {
    const full: Rect = { x: 0, y: 0, w: cols, h };
    return {
      cols,
      rows,
      projects: focus === 'projects' ? full : undefined,
      sessions: focus === 'sessions' ? full : undefined,
      right: full,
      div1: undefined,
      div2: undefined,
      statusY,
      single: true,
    };
  }
  const w = clampWidths(cols, widths);
  const div1 = w.projects;
  const div2 = w.projects + 1 + w.sessions;
  return {
    cols,
    rows,
    projects: { x: 0, y: 0, w: w.projects, h },
    sessions: { x: div1 + 1, y: 0, w: w.sessions, h },
    right: { x: div2 + 1, y: 0, w: cols - div2 - 1, h },
    div1,
    div2,
    statusY,
    single: false,
  };
}
