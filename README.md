# harness-threadbox (`hthreadbox`)

A Linux console (TUI) viewer for AI coding-harness session logs. It shows the
session you are running **right now** as it streams, and lets you browse every
past session, project by project, as one continuous transcript per project.

The first supported harness is **Claude Code** (it reads the JSONL transcripts
under `~/.claude/projects/`). Codex / Gemini / Grok are planned as additional
providers behind the same interface.

It is the console counterpart of the VS Code extension
[vsc-claude-threadbox](https://github.com/tosihide/vsc-claude-threadbox).

**Not affiliated with Anthropic.** This is an unofficial, read-only viewer for
files Claude Code writes locally. It never launches or talks to Claude.

## Features

- **Three panes.** Left: projects (repositories), most recently active at the
  bottom, with a live marker (`●` busy, `○` idle) and session count. Middle:
  the sessions of the selected project. Right: the transcript rendered the way
  Claude Code itself prints it — `> prompt`, `⏺ text`, `⏺ Bash(cmd)` with
  `⎿ result` previews, `✻ Thinking…`, diff coloring for edits.
- **Continuous scrolling within a project.** The right pane is one virtual
  document over the selected project's sessions: scroll past the end of a
  session and the next one begins, but you never leave the project. The middle
  selection follows what you are looking at. Moving in the projects pane
  switches the other two panes; click or press Enter in the sessions pane to
  jump to a session.
- **Live tail.** Running sessions are detected from `~/.claude/sessions/`.
  While you are at the bottom of a live session, new turns append and the view
  sticks to the end (`FOLLOW` in the status bar). Pending tool calls show
  `⎿ Running…` until their result arrives.
- **Tool summaries** per tool: command, file path, `Added N lines, removed M`
  with a colored diff, `Read N lines`, agent description, web query, MCP tool
  names.
- **Search and filters.** `/` searches across the project's sessions (loading
  them on demand), `n`/`N` steps through matches. Toggle thinking text, cycle tool-output
  verbosity (collapsed / full / hidden), hide tool-only turns, show hidden
  meta records.
- **Markdown export** of any session (`e` in the TUI, or `hthreadbox export`).
- **Resizable panes** (`[`, `]`, `\`, or drag a divider with the mouse).
- **Non-interactive modes** for piping and scripting: `cat`, `cat -f`, `list
  --json`, `export`.
- Handles the real log format: assistant messages split one block per record
  (merged by `message.id`), `attachment` envelopes, `isMeta` records, slash
  command wrappers, `<persisted-output>` references, compaction boundaries,
  images, 14 MB sessions (indexed from head/tail reads, loaded lazily).

## Install

Requires Node.js 24+ (Linux; macOS should work too; Windows see below).

```bash
git clone https://github.com/tsdhgm/Harness-threadbox.git
cd Harness-threadbox
npm install
npm run build
npm link            # puts `hthreadbox` on your PATH
```

Or run without linking: `node dist/cli.js`.

### Windows: WSL (recommended)

Install inside a WSL distribution (Ubuntu etc.) with Node.js 24+, using the
same commands as above. If Claude Code itself runs in WSL, its logs are in the
WSL home directory (`~/.claude`) and everything works as on Linux.

If Claude Code runs on the Windows side, its logs live under the Windows
profile. Point `hthreadbox` at them through the `/mnt/c` mount:

```bash
hthreadbox --claude-dir /mnt/c/Users/<you>/.claude
```

Two limitations apply when reading logs across the WSL boundary:

- `/mnt/c` does not deliver file-change events, so live sessions update only
  through the 2-second polling of files already marked live. New sessions and
  projects appear after `r` (rescan) rather than automatically.
- Process ids in the Windows live registry are not visible from WSL, so live
  detection falls back to "modified within the last 60 s" (`◌` in the list).

Terminal: Windows Terminal is recommended. Enable mouse support in tmux with
`set -g mouse on` if you run it inside tmux.

### Windows: PowerShell or cmd.exe (experimental)

`hthreadbox` is developed and tested on Linux. Native Windows is untested by
the author but nothing in it is Linux-specific: it uses `node:tty` raw mode,
`fs.watch` and standard VT escape sequences, all of which work in
**Windows Terminal** on Windows 10/11 (the legacy console host is not
supported). Node.js 24+ and Git for Windows are required.

PowerShell:

```powershell
git clone https://github.com/tsdhgm/Harness-threadbox.git
cd Harness-threadbox
npm install
npm run build
npm link            # creates hthreadbox.cmd / hthreadbox.ps1 in %APPDATA%\npm
hthreadbox
```

cmd.exe uses the same commands. If PowerShell refuses to run `hthreadbox.ps1`
("running scripts is disabled"), either allow local scripts once with
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or call `hthreadbox.cmd`
with the extension.

Notes for native Windows:

- Logs are read from `%USERPROFILE%\.claude` (or `%CLAUDE_CONFIG_DIR%`).
  Project directory names follow Claude Code's encoding, e.g.
  `C--Users-you-src-myrepo`. `--project C:\Users\you\src\myrepo` works.
- `npm run smoke:tui` needs bash and tmux, so it is WSL/Linux only. The unit
  tests (`npm test`) and `npm run smoke` run anywhere.
- If `⏺` / `⎿` render as two cells or as boxes, use `--ascii` or set
  `HTHREADBOX_ASCII=1`.

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

| Key | Transcript (right) | Sessions (middle) | Projects (left) |
|---|---|---|---|
| `j`/`↓`, `k`/`↑` | scroll one line | move selection | switch project |
| `PgDn`/`Space`/`Ctrl-f`, `PgUp`/`Ctrl-b` | page | page | page |
| `d` / `u` | half page | | |
| `g` / `G` | top / bottom of the project (`G` turns follow on) | first / last session | first / last project |
| `Tab` / `Shift-Tab` | cycle focus: projects → sessions → transcript | | |
| `Enter` / click | | show the selected session | go to its session list |
| `L` | jump to the next live session (any project) | | |
| `/`, `n`, `N` | search within the project, next, previous | | |
| `t` | toggle thinking text | | |
| `o` | tool output: collapsed → full → hidden | | |
| `h` | hide tool-only assistant turns | | |
| `m` | show hidden meta records | | |
| `[` `]` `\` | divider right of the focused pane −2 / +2 / reset both | | |
| `e` | export to Markdown | export selected | |
| `r` | rescan sessions | | |
| `?` / `q` | help / quit | | |

Mouse: wheel scrolls the pane under the pointer, click selects, dragging a
divider resizes. Below 80 columns only the focused pane is shown (`Tab` cycles).
Inside tmux you need `set -g mouse on`.

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
