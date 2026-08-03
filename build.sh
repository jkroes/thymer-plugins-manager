#!/usr/bin/env bash
# Build a plugin folder into a single dist/plugin.js (IIFE) using the SDK's esbuild.
# Usage:  ./build.sh .            # this repo's root plugin
#         ./build.sh path/to/sub  # a sub-plugin folder
# Output: <plugin-dir>/dist/plugin.js — paste its contents into Thymer → Edit Code →
#         Custom Code, and the folder's plugin.json into the Configuration field.
#
# NOTE: needs sdk/node_modules. `./setup.sh` links the shared cache, which already has it.
set -euo pipefail
DIR="${1:?usage: build.sh <plugin-dir>}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
ESBUILD="$ROOT/sdk/node_modules/.bin/esbuild"
[ -x "$ESBUILD" ] || { echo "esbuild not found — run ./setup.sh first"; exit 1; }
mkdir -p "$DIR/dist"
"$ESBUILD" "$DIR/plugin.js" --bundle --format=iife --global-name=plugins --keep-names \
  --loader:.css=text --loader:.png=dataurl --loader:.svg=dataurl \
  --outfile="$DIR/dist/plugin.js"
echo "✓ built $DIR/dist/plugin.js ($(wc -c < "$DIR/dist/plugin.js" | tr -d ' ') bytes)"
