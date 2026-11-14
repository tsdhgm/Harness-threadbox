# The technology behind harness-threadbox (a beginner's guide)

This document explains which languages, libraries and terminal techniques
`hthreadbox` is built from, at a level that should make sense to someone who
has just started programming. Technical terms are explained where they first
appear and again in the glossary at the end.

A Japanese translation is in [TECHNOLOGY_ja.md](TECHNOLOGY_ja.md).

---

## 1. The big picture: what the tool does

Claude Code records every conversation as a text file with one record per
line (the JSONL format, see below) under `~/.claude/projects/` in your home
directory. `hthreadbox` reads those files and redraws them in the terminal so
that they look the way they did while you were using Claude Code. The work
happens in four stages:

```
① find the files  →  ② read them line by line and interpret each record
       →  ③ build what goes on screen (text + colors)  →  ④ draw it and react to keys
```

The source folders map onto those stages.

| Folder | Role | Stage |
|---|---|---|
| `src/providers/claude/` | find, read and normalize Claude Code logs | ①② |
| `src/core/` | the data shapes (types) shared by everything, and the registry of sessions | ② |
| `src/render/` | turn records into strings with colors; Markdown rendering and line wrapping | ③ |
| `src/tui/` | terminal control, screen drawing, keyboard and mouse handling; `widgets/` holds the project and session lists | ④ |
| `src/cli/` | command-line argument parsing and the `cat` / `list` / `export` / `id` subcommands | ①–③ |

---

## 2. Language and runtime

### TypeScript

TypeScript is JavaScript plus *types*. A type is a promise such as "this
variable only ever holds a number" or "this function returns a string". The
compiler (see below) checks those promises before the program runs, so a whole
class of mistakes is caught early.

This project uses the strictest settings (`strict` and friends). For example,
`noUncheckedIndexedAccess` forces the code to admit that "the fifth element of
this array might not exist". That feels pedantic at first, but it almost
eliminates the classic runtime error "cannot read property of undefined".

- **Compiling** means converting the TypeScript you wrote into JavaScript that
  Node.js can run. `npm run build` calls `tsc` (the TypeScript compiler), which
  reads `src/` and writes `dist/`.
- **tsx** runs TypeScript files directly, without a build step. `npm run dev --
  list` uses it, which makes trying things out fast.

### Node.js 24

Node.js runs JavaScript outside the browser, on servers and on the command
line. It gives JavaScript access to the operating system: reading files,
controlling the terminal, watching for file changes. This project requires
Node.js 24 or newer and uses these built-in modules, none of which exist in a
browser:

| Module | Used for |
|---|---|
| `node:fs` | reading files, `stat` (size and modification time), `fs.watch` (change notifications) |
| `node:path` | joining and relativizing paths; also handles Windows `\` separators |
| `node:os` | the home directory |
| `node:tty` | switching the terminal into raw mode (see below) |
| `process` | standard input/output, environment variables, exit codes, signals such as Ctrl-C |

### ESM (ECMAScript Modules)

ESM is the modern, standard way to connect files with `import` and `export`.
The line `"type": "module"` in `package.json` opts into it. One visible
difference from the older CommonJS style (`require()`) is that imports must
spell out the `.js` extension. That is why TypeScript source files contain
`import ... from './foo.js'`: the import refers to the file as it will exist
after compilation.

### npm

npm is the package manager for Node.js. `package.json` lists the libraries the
project uses and gives short names (`scripts`) to common commands. `npm
install` downloads the libraries; `npm run build` and friends run the scripts.
`package-lock.json` pins the exact versions that were installed, so another
machine ends up with the same ones.

---

## 3. Runtime libraries

The runtime dependencies are deliberately limited to three. Fewer libraries
means faster installs and fewer things that can break later.

### markdown-it

Claude's replies are written in Markdown, the lightweight notation with
`**bold**`, `- bullet` lists and so on. markdown-it parses that text into a
list of *tokens*: labelled pieces such as "a heading starts here", "this span
is emphasized", "this is a code block".

Normally tokens are turned into HTML. This tool draws in a terminal instead, so
`src/render/markdown.ts` contains a custom renderer that turns tokens into
*ANSI escape sequences* (explained below) for colors and bold text. Existing
"Markdown to terminal" libraries were not used because line wrapping had to be
based on display width, not character count, as the next section explains.

### string-width and get-east-asian-width

In a terminal, Chinese, Japanese and Korean characters (CJK) take two cells,
emoji take two, and combining marks (such as a standalone accent) take zero.
`string-width` answers "how many cells does this string occupy on screen?";
`get-east-asian-width` answers it for one character at a time.

This matters because a line that is one cell too long makes the terminal wrap
it on its own and the whole layout falls apart. It also matters because the
tool computes how many lines a session occupies in order to position the
viewport, so wrapping must give the same answer every time (it must be
*deterministic*).

Characters are split with the built-in `Intl.Segmenter`, which cuts a string
into *graphemes*: what a human perceives as one character. An emoji with a
skin-tone modifier is several code units but one grapheme, and must never be
cut in the middle.

---

## 4. Development-time tools

| Tool | Role | In one phrase |
|---|---|---|
| **TypeScript (`tsc`)** | compile and type-check | catches broken promises before running |
| **tsx** | run TypeScript directly | try things without building |
| **vitest** | test runner | checks automatically that things still work |
| **eslint** + **typescript-eslint** | static analysis (a linter) | points out mistakes and risky patterns |
| **@types/node**, **@types/markdown-it** | type definitions | give types to libraries written in plain JavaScript |

### Tests (vitest)

A test is a small program that says "for this input, the output must be
that", run automatically after every change. `npm test` runs 51 of them, of
three kinds:

1. **Unit tests** exercise one function in isolation. Example: feed the
   wrapping function a string mixing CJK and Latin text and assert that no
   output line exceeds the requested width (`test/wrap.test.ts`).
2. **Fixture-based tests** generate JSONL shaped exactly like real Claude Code
   logs using the builders in `test/helpers.ts` and check the interpretation
   (number of turns, tool pairing, and so on). Real logs contain private data,
   so synthetic look-alikes are used instead.
3. **End-to-end (E2E) tests** run the real `App` against a fake terminal
   (`FakeTerminal`) and a fake log source (`FakeProvider`), send keystrokes and
   inspect the screen snapshot, an array of strings (`test/app.test.ts`). The
   whole TUI can be tested without a terminal. The same fake terminal is
   behind `node dist/cli.js --frames 3 --keys "G,k"`, which prints screen
   frames to standard output for debugging.

### The linter (eslint)

A linter flags code that compiles but looks suspicious: unused variables,
`==` where `===` was meant, and so on. It also keeps the coding style
consistent.

### Smoke tests

A smoke test is a rough check that "nothing is on fire". `scripts/smoke.mjs`
runs `list`, `cat` and `export` against your real `~/.claude` and checks that
they finish without errors and that a very large session renders within a few
seconds. `scripts/tui-smoke.sh` starts the TUI inside **tmux** (a tool that
creates virtual terminals), sends keys, captures the screen and verifies that
the terminal is restored after quitting.

---

## 5. How the terminal is controlled

This is the lowest-level part of the tool. No general-purpose TUI library
(Ink, blessed, ...) is used; `src/tui/` implements what is needed in about
2,200 lines, including the three panes and their widgets. The reasons: the viewport is a virtual document of up to hundreds of
thousands of lines that must be redrawn line by line, and the candidate
libraries were either unmaintained or required a newer Node.js. The building
blocks are these.

### ANSI escape sequences

These are special strings that tell the terminal "red from here", "move the
cursor to row 3", and so on. They all start with `ESC` (character code 27,
written `\x1b` in JavaScript). Examples:

| Sequence | Meaning |
|---|---|
| `\x1b[31m` | following text in red (SGR, Select Graphic Rendition) |
| `\x1b[0m` | reset colors and attributes |
| `\x1b[5;1H` | move the cursor to row 5, column 1 |
| `\x1b[?1049h` / `l` | switch to / back from the alternate screen (why your shell reappears intact on exit) |
| `\x1b[?25l` / `h` | hide / show the cursor |
| `\x1b[?1000;1002;1006h` | report mouse clicks, drags and wheel (SGR mouse mode) |
| `\x1b[?2026h` / `l` | synchronized output: the terminal applies everything in between at once, avoiding flicker |
| `\x1b]52;c;<base64>\x07` | OSC 52: ask the terminal to put text on the clipboard (see "Clipboard" below) |

Sequences that start with `ESC [` are called CSI (Control Sequence
Introducer); the one that starts with `ESC ]` is an OSC (Operating System
Command), a channel for requests aimed at the terminal program itself rather
than at the screen.

### Raw mode

Normally the terminal buffers input until Enter is pressed and turns Ctrl-C
into "kill the program". `process.stdin.setRawMode(true)` switches that off:
every key arrives immediately and Ctrl-C is just another character. The price
is that the program must restore the terminal itself. `src/tui/terminal.ts`
makes sure the restore runs on normal exit, on errors and on signals.

### Interpreting input (`src/tui/input.ts`)

Arrow keys and PageUp do not arrive as single bytes but as escape sequences
such as `\x1b[A`. Mouse events look like `\x1b[<0;10;5M` ("button 0 pressed at
column 10, row 5"). The parser reads bytes one at a time and converts them
into key names and mouse events the rest of the program can use. To tell a
lone Esc key from the start of a sequence, it waits 30 milliseconds; if nothing
follows, it was Esc.

### Differential drawing (`src/tui/screen.ts`)

Redrawing the whole screen on every change is slow and flickers. Instead the
tool remembers each row as it was last drawn and rewrites only the rows that
changed, moving the cursor to each. Holding two copies of the screen and
comparing them is called *double buffering*.

### Clipboard (`src/tui/clipboard.ts`)

A terminal program has no direct access to the system clipboard, so pressing
`y` (copy the session id) tries two routes at once. First, an external
command-line tool is run with the text on its standard input: `wl-copy` on
Wayland, `xclip` or `xsel` on X11, `pbcopy` on macOS, `clip.exe` under WSL,
or `tmux load-buffer` inside tmux. Second, the text is encoded as *Base64*
(a way of writing arbitrary bytes using only letters, digits, `+` and `/`) and
sent to the terminal in an OSC 52 sequence. The second route works even over
SSH, because the terminal emulator on your own machine is the one that
receives it. The status bar reports which routes succeeded.

---

## 6. Reading Claude Code's logs

### JSONL

**JSON** is a standard notation for data: `{"name": "value", "count": 3}`.
**JSONL** (JSON Lines) is a file with one JSON object per line. It is easy to
append to, and if one line is damaged the others still parse. Claude Code
appends one record per event: your prompts, Claude's replies, tool results and
more.

### Reading appends safely (`src/providers/claude/jsonlTailer.ts`)

In live mode the tool reads a file that Claude Code is still writing. The
tricky part is that the last line may be only half written. The tailer
remembers how far it has read (the *offset*, a byte count from the start of
the file), processes the new bytes only up to the **last newline**, and leaves
a partial line for the next round. It finds the newline in the raw bytes
before decoding, because cutting a UTF-8 character (the encoding that stores
Japanese and other scripts as one to four bytes) in the middle would corrupt
it.

### Normalization (`src/providers/claude/normalizer.ts`)

The log mixes records that should be displayed with records that should not,
and one reply may be split across several lines. Rearranging all of that into
the tool's own simple shape, *turns* (one utterance) made of *blocks* (text,
thinking, a tool call), is called normalization. Supporting Codex or Gemini
later means writing only this part; the screen code stays the same (see
"Provider abstraction" below).

### Watching for changes

`fs.watch` receives notifications from the operating system that "something
in this folder changed". The details are unreliable across operating systems,
so every notification is followed by a `stat` to measure the file size and
decide what really happened. In case a notification is missed, files known to
be live are also re-checked every two seconds (*polling*). To stop a burst of
notifications from triggering a burst of work, they are *debounced*: collected
for 200 milliseconds and handled once.

### Detecting running sessions

While running, Claude Code writes `~/.claude/sessions/<process id>.json`. The
tool checks whether that process still exists by "sending signal 0" to it
(`process.kill(pid, 0)`, an idiom that sends nothing and only tests for
existence).

---

## 7. Tricks that keep the screen fast and stable

### The virtual document and the session-anchored cursor (`src/tui/document.ts`)

The right pane treats all sessions of the selected project as one long
document. Loading all of them at once would be heavy, so only the sessions
near the viewport are loaded; unloaded ones stand in as three lines (a header
and "loading…").

The problem: when a session above the viewport finishes loading and grows from
3 lines to 500, whatever you were reading would jump. So the current position
is stored not as "line N of everything" but as "session X, line N". Whatever
happens above, the text in front of you stays put.

### Line cache and prefix sums (`src/render/lineCache.ts`)

The rendered lines of a session are cached per turn and only turns that
changed are re-rendered. To answer "which turn does line N belong to?"
quickly, the cache keeps a running total of line counts (a *prefix sum*) and
uses *binary search* on it. This is how a 14 MB session renders in about half a
second.

### LRU cache

Loaded sessions are kept in memory up to a limit (6 in the command-line
subcommands, 8 in the TUI). Beyond that, the
one *least recently used* is dropped first, except that sessions currently on
screen are protected from eviction.

### Three panes, one project at a time (`src/tui/layout.ts`, `src/tui/widgets/`)

The screen is split into projects, sessions and transcript. `layout.ts` turns
the terminal size and the two divider positions into rectangles, one per pane;
below 80 columns only the focused pane gets the whole width. Each list pane is
a *widget*: a small object that knows its rows, its selection and how to draw
itself into a rectangle. The virtual document on the right is *scoped* to the
selected project, so scrolling can never cross into another project; choosing
a different project rebuilds the session list and re-scopes the document.

### Follow mode: behaving like `tail -f`

`tail -f` is the Unix command that prints a file and keeps printing as it
grows. The transcript pane does the same for a live session when it is
"pinned" to the end. In **auto** mode the pin is set when you reach the end
(or press `G`) and cleared when you scroll up, so reading older text is never
interrupted. **always** re-pins on every update, and **off** never pins. The
mode is a small *state machine*: a value plus the rules for how each event
changes it.

### Markdown export (`src/render/markdownExport.ts`)

The same normalized turns that feed the screen can also be written out as a
Markdown document: one heading per turn, tool calls folded into
`<details>` blocks, edits as `diff` code fences. Because the data model is
separate from the drawing code, adding an output format is a single new file.

### Provider abstraction

Everything that is specific to one harness, finding, reading and normalizing
its logs, sits behind a single *interface* called `Provider`. An interface is a
contract that lists method names and their types without saying how they
work, so implementations can be swapped. The Claude Code implementation lives
in `src/providers/claude/`; adding Codex means adding another folder that
fulfils the same contract and registering it.

---

## 8. Glossary

| Term | Meaning |
|---|---|
| **TUI** | Text User Interface: an interactive screen made of character cells. Mouse may work, but drawing is text |
| **CLI** | Command Line Interface: type a command with arguments, get text back |
| **Terminal** | The program that shows text input/output: Windows Terminal, GNOME Terminal, a tmux pane |
| **Shell** | The program inside the terminal that accepts commands: bash, zsh, PowerShell |
| **Compile** | Translate human-written code into a form the runtime can execute |
| **Type** | A promise about what kind of value a variable or function handles; violations are caught before running |
| **Module** | One file as a unit of code; `import` pulls in another module's exports |
| **Interface** | A contract listing method names and types only, so implementations can be swapped |
| **JSON / JSONL** | A data notation / a file of one JSON object per line |
| **UTF-8** | The encoding that stores all of the world's characters in 1 to 4 bytes each |
| **Byte / offset** | The smallest unit of data (8 bits) / a position counted in bytes from the start |
| **Grapheme** | What a human sees as one character, even if it is several code units |
| **Display width** | How many terminal cells a string occupies: Latin 1, CJK 2, combining marks 0 |
| **ANSI escape sequence** | A terminal command starting with `ESC`: colors, cursor movement, modes |
| **CSI / OSC** | The two families of escape sequence: `ESC [` for screen control, `ESC ]` for requests to the terminal program (title, clipboard) |
| **Base64** | Writing arbitrary bytes with only letters, digits, `+` and `/`, so they survive text-only channels |
| **Pane** | One rectangular region of the screen with its own content and scrolling |
| **Viewport** | The part of a long document currently visible on screen |
| **Widget** | A self-contained screen component: it owns its rows and selection and draws itself |
| **State machine** | A current state plus rules saying how each event moves to the next state |
| **tail -f** | Unix command that prints a file and keeps printing as it grows; the model for follow mode |
| **Raw mode** | Terminal mode in which keys are delivered immediately and unprocessed |
| **Alternate screen** | A separate screen for full-screen programs; the shell screen returns on exit |
| **Double buffering / differential drawing** | Remembering the last screen and redrawing only what changed |
| **Debounce** | Collapsing a burst of events into one, handled after things calm down |
| **Polling** | Checking state on a timer, as a backup for missed notifications |
| **Cache** | Keeping results around to reuse them instead of recomputing |
| **LRU** | Least Recently Used: when a cache is full, drop the entry unused for longest |
| **Prefix sum** | A table of running totals that answers "which range contains position N?" fast |
| **Binary search** | Finding an item in sorted data by halving the range each step; 100,000 items take about 17 steps |
| **Normalization** | Reshaping messy input into one consistent, convenient form |
| **Process ID (pid)** | The number the operating system gives a running program |
| **Signal** | A notification the OS sends a process; Ctrl-C is SIGINT; signal 0 only tests existence |
| **Linter** | A static-analysis tool that flags questionable code |
| **Unit test / E2E test** | Testing one component alone / testing the whole program the way a user drives it |
| **Fixture** | Sample data prepared for tests |
| **Smoke test** | A quick, coarse check that nothing major is broken |
| **Symbolic link / junction** | A shortcut that points at a file or folder elsewhere; `npm link` uses them |
| **tmux** | A tool that creates several virtual terminals inside one; also used to drive the TUI in tests |
