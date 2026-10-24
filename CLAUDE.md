# harness-threadbox — notes for Claude Code

Console (TUI) viewer for AI coding-harness session logs. TypeScript, Node 24, ESM, no bundler.
Binary: `hthreadbox` (`dist/cli.js`). Console counterpart of `vsc-claude-threadbox`.

## Commands

- `npm run build` — `tsc` to `dist/`. `npm run dev -- <args>` runs from source via tsx.
- `npm test` — vitest. Fixtures are generated from `test/helpers.ts` builders (`test/fixtures/*.jsonl` mirror real record shapes).
- `npm run lint` — eslint 9 flat config.
- `npm run smoke` — real-data smoke against `~/.claude` (skips when absent). `npm run smoke:tui` — tmux-driven TUI check.
- `node dist/cli.js --frames N --size WxH --keys "G,k,Tab,/foo,Enter"` — renders TUI frames to stdout with a fake terminal; the e2e tests (`test/app.test.ts`) use the same `App` + `FakeTerminal` + `FakeProvider`.

## Architecture (what depends on what)

```
core/types.ts        normalized model: Session / Turn / Block / ToolCall / SessionIndexEntry / LiveState
core/provider.ts     Provider interface (scanIndex, indexOne, open→SessionReader{load,pull}, liveStates, watch, resolveArg, summarizeTool)
core/sessionStore.ts registry of index entries, document ORDER (projects by last activity asc, sessions by start asc),
                     LRU of loaded sessions (protects visible keys), watch-event handling, events: index/session/live/loaded
providers/claude/    the only provider so far (see below)
render/              pure functions: Turn → RenderedLine[] (transcript.ts), markdown→ANSI (markdown.ts),
                     width-aware wrap (wrap.ts), tool summaries (toolSummary.ts), per-session line cache with
                     prefix sums (lineCache.ts), Markdown export (markdownExport.ts)
tui/                 hand-rolled terminal core (terminal/screen/input/layout), Document = continuous virtual
                     viewport over the sessions of ONE project group (document.ts, `setScope`), App = state machine +
                     key/mouse dispatch (app.ts); widgets/projectList.ts (left) and widgets/sessionList.ts (middle)
cli/                 arg parsing and the cat / list / export / id subcommands
```

Rules that keep this maintainable:
- `render/` and `tui/` import only `core/types.ts` (+ `summarizeClaudeTool` as the default tool vocabulary). Provider-specific knowledge stays in `providers/*`.
- `renderTurn` is pure; line counts are a function of `(turn, RenderOptions)`. `SessionLineCache` re-renders only `dirty` turns; `filterHash(opts)` (width, toggles, live, color, ascii) keys the cache.
- The viewport cursor is `Top { key: sessionKey, line }` — anchored by session, never a global line number — so lazy loads and re-sorting above the viewport cannot move what the user sees. `Document.reanchor` keeps (block, offset) across re-renders of the top session.
- Three panes: projects │ sessions of `App.projectKey` │ transcript. `App.refreshLists()` rebuilds both lists and re-scopes the Document to the project, so scrolling in the right pane can never cross into another project; `selectProject()` switches project and lands at the end of its newest live (else last) session. `L` is the only navigation that changes project implicitly. Search is per project.
- Follow: `App.followMode` (`auto` | `always` | `off`, key `F`, flag `--follow-mode`) decides how updates move the view; `App.follow` is the "pinned to the end" flag used by `auto`/`always`. In `auto` it is set by `G`, `L`, initial position / project switch, or scrolling onto the end of a live session and cleared by scrolling up or jumping; in `always` every `session` event for `currentKey()` re-pins; in `off` it is never set and `session` events only re-anchor. "Current session" = bottom visible session while pinned, else the top one (`App.currentKey`).

## Claude Code log format (observed CLI 2.1.29x–2.1.30x, 2026-10)

Paths: `~/.claude/projects/<enc>/<sessionId>.jsonl`, `enc = realpath(cwd).replace(/[^A-Za-z0-9-]/g,'-')` (lossy; cwd comes from records). `$CLAUDE_CONFIG_DIR` overrides `~/.claude`. Per session also `<sessionId>/subagents/agent-<id>.jsonl` + `.meta.json` (not read yet) and `<sessionId>/tool-results/<id>.txt` (large outputs; the tool_result text contains `<persisted-output> … Full output saved to: <path>`).
Live registry: `~/.claude/sessions/<pid>.json` `{pid, sessionId, cwd, startedAt, status: busy|idle}` (+ `.key` files to skip). `~/.claude/history.jsonl` maps prompts to sessions (unused).

Record types and what `providers/claude/normalizer.ts` does with them:
- `user` / `assistant` — rendered. `assistant` is **one content block per record**; records of one API response share `message.id` and `requestId` (`apiBlockIndex` 0,1,2…), `usage` repeated on each → merged into one Turn by `message.id` (only if no human turn was inserted after it), usage last-wins.
- `user` string content: human prompt; may wrap `<command-name>/<command-args>/<command-message>` (slash command → `command` block), `<local-command-stdout>` (attached to the previous command), `<system-reminder>…` (stripped), `<task-notification>` (→ notice), `<agent-message>`; `[Request interrupted…]` → `interrupted`. `isMeta: true` → hidden turn (shown with `m`).
- `user` array content: `tool_result {tool_use_id, content: string|blocks, is_error}` paired to the `tool_use` by id (status pending→ok/error; top-level `toolUseResult` kept as `structured`: Bash `{stdout,stderr,interrupted}`, Edit `{structuredPatch}`, Read `{file.numLines}`, Agent `{agentId}`), `text`, `image` (base64 dropped, size kept).
- `ai-title` `{aiTitle}` — appears many times; **last wins** → session title. Indexer reads the file tail (256 KB, then 1 MB) to find it without parsing the whole file.
- `system` with `subtype`: `turn_duration` (attached to the previous assistant turn), `compact_boundary` / `informational` / `away_summary` (visible notices), others hidden.
- Dropped (counted in `parse.skippedTypes`): `attachment` (envelope for harness-injected context — the same text that appears as `<system-reminder>`; NOT user attachments), `mode`, `permission-mode`, `atis-latch`, `last-prompt`, `file-history-snapshot|delta`, `cost-state`, `api-request*`, `queue-operation`, anything unknown, `isSidechain: true`.
- Files end with state markers (`mode`/`permission-mode`/`atis-latch`) between turns; writes are bursty. `jsonlTailer.ts` keeps its offset at the last consumed `\n` (byte-level split before UTF-8 decode) — this fixes the duplicate/partial-line race that `vsc-claude-threadbox`'s `parseJsonlFromOffset` had. Duplicate `uuid`s are ignored as a second line of defense.
- Largest file seen: 14.4 MB / 5,894 lines / 140 KB max line; `cat` renders it in ~0.5 s.

Verify against real data before "fixing" a gap: `python3 -I` over a `.jsonl` beats guessing (see the threadbox docs: the `attachment` type was once mistaken for user attachments).

## Adding a provider (Codex / Gemini / Grok)

1. Create `src/providers/<id>/index.ts` implementing `Provider` from `core/provider.ts`. Produce `SessionIndexEntry` (cheap scan) and a `SessionReader` whose `load()`/`pull()` fill a `Session` with normalized `Turn`s (see `core/types.ts`). Reuse `JsonlTailer` if the format is JSONL.
2. Implement `summarizeTool(call, cwd)` for the tool vocabulary of that harness (or return undefined for the generic `Name(first string arg)` fallback). Result previews currently go through `previewClaudeTool`; add a `preview` hook on `RenderOptions` if the structured results differ.
3. Register it in `src/cli/context.ts` (`providers` array). Everything else (store, document, TUI, cat/export) is provider-agnostic. Session keys are `${provider}:${sessionId}`.

## Decisions

- Hand-rolled TUI core instead of Ink/blessed/opentui: `@opentui/core` needs Node ≥ 26.4, Ink re-renders the whole tree and fights a line-addressed 100k-line viewport, blessed is unmaintained. ~600 lines in `tui/` do what we need.
- `markdown-it` tokens + our own ANSI renderer (no `marked-terminal`) because wrapping must be display-width based and deterministic (line counts drive the viewport). CJK = 2 columns via `string-width` + grapheme segmentation.
- Non-recursive `fs.watch` on `projects/` and each project dir + 2 s stat polling of live files. Recursive watch would cover `subagents/`/`tool-results/`/`memory/` and is unreliable for new dirs. Event names are never trusted; size is re-`stat`ed.
- Ordering is chronological ascending (oldest top, live at the bottom) so the live session behaves like a terminal tail. The projects list reorders when a background project becomes active; the right pane does not move (session-anchored cursor, project-scoped document).
- Clipboard (`tui/clipboard.ts`): `y`/`Y` try external tools in order (pbcopy, clip, wl-copy, xclip, xsel, clip.exe on WSL, `tmux load-buffer -w`) and always also emit OSC 52 via `TerminalIO.write`. `App` takes the copier through `AppOptions.clipboard` so tests and `--frames` never spawn processes. The projects pane footer shows the full id of `App.targetEntry()` (selected session in the sessions pane, else the current one).
- Layout: three panes from 80 columns (`defaultWidths` ≈ 15 % / 25 % / rest, mins 14 / 20 / 40); below that a single pane showing the focused one. Session rows show the first 8 chars of the id when the middle pane is ≥ 30 columns. `[`/`]` move the divider to the right of the focused pane.
- Ambiguous-width glyphs (`⏺` `⎿` `✻`) can render as 2 cells in CJK-locale terminals → `--ascii` / `HTHREADBOX_ASCII=1`.
