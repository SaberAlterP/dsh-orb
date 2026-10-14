#!/usr/bin/env bash
# Dev only: mirror the working tree into the desktop profile's installed copy (no pnpm round trip).
set -euo pipefail
src=/c/Users/98621/dsh-orb
dst=/c/Users/98621/.dsh/profiles/desktop/node_modules/dsh-orb
for p in lib presets cordis.patch.yml package.json; do rm -rf "$dst/$p"; cp -r "$src/$p" "$dst/$p"; done
echo "synced -> $dst"
