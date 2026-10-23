# harness-threadbox (`hthreadbox`)

A Linux console (TUI) viewer for AI coding-harness session logs. It shows the
session you are running **right now** as it streams, and lets you browse every
past session, project by project, in one continuous transcript.

The first supported harness is **Claude Code** (it reads the JSONL transcripts
under `~/.claude/projects/`). Codex / Gemini / Grok are planned as additional
providers behind the same interface.

It is the console counterpart of the VS Code extension
[vsc-claude-threadbox](https://github.com/tosihide/vsc-claude-threadbox).

**Not affiliated with Anthropic.** This is an unofficial, read-only viewer for
files Claude Code writes locally. It never launches or talks to Claude.

## Features

- **Two panes.** Left: sessions grouped by project, newest at the bottom, with
  a live marker (`●` busy, `○` idle). Right: the transcript rendered the way
  Claude Code itself prints it — `> prompt`, `⏺ text`, `⏺ Bash(cmd)` with
  `⎿ result` previews, `✻ Thinking…`, diff coloring for edits.
- **Continuous scrolling.** The right pane is one virtual document over all
  sessions: scroll past the end of a session and the next one begins; the left
  selection follows what you are looking at. Click or press Enter on the left
  to jump.
- **Live tail.** Running sessions are detected from `~/.claude/sessions/`.
  While you are at the bottom of a live session, new turns append and the view
  sticks to the end (`FOLLOW` in the status bar). Pending tool calls show
  `⎿ Running…` until their result arrives.
- **Tool summaries** per tool: command, file path, `Added N lines, removed M`
  with a colored diff, `Read N lines`, agent description, web query, MCP tool
  names.
- **Search and filters.** `/` searches across sessions (loading them on demand),
  `n`/`N` steps through matches. Toggle thinking text, cycle tool-output
  verbosity (collapsed / full / hidden), hide tool-only turns, show hidden
  meta records.
- **Markdown export** of any session (`e` in the TUI, or `hthreadbox export`).
- **Resizable split** (`[`, `]`, `\`, or drag the divider with the mouse).
- **Non-interactive modes** for piping and scripting: `cat`, `cat -f`, `list
  --json`, `export`.
- Handles the real log format: assistant messages split one block per record
  (merged by `message.id`), `attachment` envelopes, `isMeta` records, slash
  command wrappers, `<persisted-output>` references, compaction boundaries,
  images, 14 MB sessions (indexed from head/tail reads, loaded lazily).

## Install

Requires Node.js 24+ (Linux; macOS should work too).

```bash
git clone https://github.com/tosihide/harness-threadbox.git
cd harness-threadbox
npm install
npm run build
npm link            # puts `hthreadbox` on your PATH
```

Or run without linking: `node dist/cli.js`.

## Usage

```
hthreadbox                                   # TUI (all projects)
hthreadbox --project ~/src/myrepo            # only this project's sessions
hthreadbox cat latest                        # print the newest session (ANSI when stdout is a TTY)
hthreadbox cat live -f                       # follow the newest live session like tail -f
hthreadbox cat 6aa06f9a --no-color --tools full --thinking --width 120
hthreadbox export latest -o session.md       # Markdown export ( -o -  writes to stdout )
hthreadbox list [--json] [--live]
```

`<session>` is a session id, a unique id prefix, a path to a `.jsonl` file,
`latest` (default) or `live`.

Global options: `--claude-dir DIR` (default `$CLAUDE_CONFIG_DIR` or
`~/.claude`), `--project PATH`, `--ascii` (use `*`/`L`/`~` instead of
`⏺`/`⎿`/`✻` for terminals that draw those as double width), `--no-color`
(also honours `NO_COLOR` / `FORCE_COLOR`).

### Keys

| Key | Right pane (transcript) | Left pane (list) |
|---|---|---|
| `j`/`↓`, `k`/`↑` | scroll one line | move selection |
| `PgDn`/`Space`/`Ctrl-f`, `PgUp`/`Ctrl-b` | page | page |
| `d` / `u` | half page | |
| `g` / `G` | top / bottom (`G` turns follow on) | first / last session |
| `Tab` | focus left | focus right |
| `Enter` / click | | open the selected session |
| `L` | jump to the next live session | |
| `/`, `n`, `N` | search, next, previous | |
| `t` | toggle thinking text | |
| `o` | tool output: collapsed → full → hidden | |
| `h` | hide tool-only assistant turns | |
| `m` | show hidden meta records | |
| `[` `]` `\` | split −2 / +2 / reset | |
| `e` | export to Markdown | export selected |
| `r` | rescan sessions | |
| `?` / `q` | help / quit | |

Mouse: wheel scrolls the pane under the pointer, click selects, dragging the
divider resizes. Inside tmux you need `set -g mouse on`.

## How it finds sessions

```
cwd  →  realpath  →  replace /[^A-Za-z0-9-]/ with "-"  →  ~/.claude/projects/<encoded>/<sessionId>.jsonl
```

The encoded name is lossy, so the displayed working directory is taken from
the `cwd` field inside the records. Live sessions come from
`~/.claude/sessions/<pid>.json` (checked with `kill -0`), with a fallback of
"modified within the last minute".

Subagent transcripts (`<sessionId>/subagents/agent-*.jsonl`) are not shown
yet; the data model has room for them.

## Development

```bash
npm run dev -- list            # run from source with tsx
npm test                       # vitest (fixtures in test/fixtures)
npm run lint
npm run build && npm run smoke # real-data smoke test against ~/.claude (skips if absent)
npm run smoke:tui              # drives the TUI inside tmux
node dist/cli.js --frames 3 --size 120x40 --keys "G,k,Tab"   # render frames to stdout for debugging
```

See `CLAUDE.md` for the architecture, the Claude Code log-format notes, and
how to add a provider.

## License

MIT
