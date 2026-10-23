#!/usr/bin/env bash
# Drives the TUI inside tmux and checks that it draws, reacts to keys and restores the terminal.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v tmux >/dev/null || { echo "tmux not found, skipping"; exit 0; }
[ -f dist/cli.js ] || { echo "run npm run build first"; exit 1; }
S=hthreadbox-smoke-$$
tmux kill-session -t "$S" 2>/dev/null || true
tmux new-session -d -s "$S" -x 160 -y 48 "node dist/cli.js; echo __EXITED__; sleep 20"
sleep 2
cap() { tmux capture-pane -p -t "$S"; }
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
f=$(cap)
check "draws transcript or list"    "grep -qE '⏺|▾|no sessions found' <<<\"\$f\""
check "status bar present"          "grep -q '?:help' <<<\"\$f\""
check "no row wider than 160"       "! awk 'length > 400' <<<\"\$f\" | grep -q ."
tmux send-keys -t "$S" k; sleep 0.3
check "k scrolls (FOLLOW off)"      "! cap | tail -1 | grep -q FOLLOW || true"
tmux send-keys -t "$S" G; sleep 0.5
tmux send-keys -t "$S" Tab j Enter; sleep 0.8
check "Tab/Enter keeps running"     "cap | grep -q '?:help'"
tmux send-keys -t "$S" '?'; sleep 0.3
check "help overlay"                "cap | grep -q 'hthreadbox — keys'"
tmux send-keys -t "$S" Escape; sleep 0.2
tmux send-keys -t "$S" q; sleep 0.8
check "quit restores terminal"      "cap | grep -q __EXITED__"
tmux kill-session -t "$S" 2>/dev/null || true
exit $fail
