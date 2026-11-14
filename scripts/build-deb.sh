#!/usr/bin/env bash
# Build a Debian package (hthreadbox_<version>_all.deb) from the current tree.
#
# Layout inside the package:
#   /usr/bin/hthreadbox                      wrapper that runs node on the CLI
#   /usr/lib/hthreadbox/dist/                compiled JavaScript
#   /usr/lib/hthreadbox/node_modules/        production dependencies only
#   /usr/lib/hthreadbox/package.json         read by `hthreadbox --version`
#   /usr/share/doc/hthreadbox/               README, copyright
#
# The package is Architecture: all (pure JavaScript). Node.js 24+ must be on
# PATH at run time; it is declared as Recommends rather than Depends so that
# installs managed by nvm/fnm (invisible to dpkg) are not rejected.
#
# Usage: scripts/build-deb.sh [out-dir]      (default: build/deb)
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$root/build/deb"}
cd "$root"

name=hthreadbox
version=$(node -p "require('./package.json').version")
stage="$out/${name}_${version}_all"
deb="$out/${name}_${version}_all.deb"

echo "building $deb"
npm ci --no-audit --no-fund >/dev/null
npm run build >/dev/null

rm -rf "$stage" "$deb"
mkdir -p "$stage/DEBIAN" "$stage/usr/bin" "$stage/usr/lib/$name" "$stage/usr/share/doc/$name"

# compiled code + manifest
cp -r dist "$stage/usr/lib/$name/dist"
cp package.json "$stage/usr/lib/$name/package.json"
find "$stage/usr/lib/$name/dist" -name '*.map' -delete

# production dependencies, resolved from the lockfile in a scratch dir
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp package.json package-lock.json "$tmp/"
(cd "$tmp" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
rm -rf "$tmp/node_modules/.bin" "$tmp/node_modules/.package-lock.json"
mv "$tmp/node_modules" "$stage/usr/lib/$name/node_modules"

# wrapper
cat > "$stage/usr/bin/$name" <<'WRAP'
#!/bin/sh
# hthreadbox launcher: runs the installed CLI with the Node.js found on PATH.
if ! command -v node >/dev/null 2>&1; then
  echo "hthreadbox: Node.js 24 or newer is required but 'node' was not found on PATH." >&2
  exit 127
fi
major=$(node --version | sed 's/^v\([0-9]*\).*/\1/')
if [ "${major:-0}" -lt 24 ]; then
  echo "hthreadbox: Node.js 24 or newer is required (found $(node --version))." >&2
  exit 1
fi
exec node /usr/lib/hthreadbox/dist/cli.js "$@"
WRAP
chmod 755 "$stage/usr/bin/$name"

# docs
cp README.md README_ja.md "$stage/usr/share/doc/$name/"
cat > "$stage/usr/share/doc/$name/copyright" <<COPY
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: harness-threadbox
Source: https://github.com/tsdhgm/Harness-threadbox

Files: *
Copyright: $(sed -n 's/^Copyright (c) //p' LICENSE)
License: MIT
$(sed -n '/^Permission is hereby granted/,$p' LICENSE | sed 's/^/ /; s/^ $/ ./')
COPY

installed_kb=$(du -sk "$stage/usr" | cut -f1)
cat > "$stage/DEBIAN/control" <<CTRL
Package: $name
Version: $version
Section: utils
Priority: optional
Architecture: all
Installed-Size: $installed_kb
Maintainer: tsdhgm <tsdhgm@users.noreply.github.com>
Recommends: nodejs (>= 24)
Homepage: https://github.com/tsdhgm/Harness-threadbox
Description: Console (TUI) viewer for AI coding-harness session logs
 Shows the session you are running right now as it streams and lets you
 browse every past session, project by project, as one continuous
 transcript. Reads the JSONL transcripts Claude Code writes locally; other
 harnesses (Codex, Gemini, Grok) can be added as providers.
 .
 Requires Node.js 24 or newer on PATH at run time (apt nodejs, nvm, fnm, ...).
CTRL

find "$stage" -type d -exec chmod 755 {} +
find "$stage/usr" -type f -exec chmod 644 {} +
chmod 755 "$stage/usr/bin/$name"

dpkg-deb --build --root-owner-group "$stage" "$deb" >/dev/null
rm -rf "$stage"
echo "ok   $deb ($(du -h "$deb" | cut -f1))"
