#!/usr/bin/env bash
# Re-link this repo's third-party deps after a fresh clone. Nothing here is committed:
# sdk/, bin/thymercli and examples/ are symlinks into a shared cache that lives with the
# thymer-plugin-init skill, so one update refreshes every plugin repo at once.
#
#   ./setup.sh              # link what's missing
#   ./setup.sh --refresh    # refresh the shared cache first, then link
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
SKILL="${THYMER_SKILL_DIR:-$HOME/.claude/skills/thymer-plugin-init}"
CACHE="$SKILL/.cache"

if [ ! -d "$SKILL" ]; then
  echo "✗ thymer-plugin-init skill not found at $SKILL"
  echo "  Set THYMER_SKILL_DIR to its location, or vendor the SDK yourself:"
  echo "    git clone --depth 1 https://github.com/thymerapp/thymer-plugin-sdk.git sdk"
  echo "    rm -rf sdk/.git && cd sdk && npm install"
  exit 1
fi

if [ "${1:-}" = "--refresh" ] || [ ! -e "$CACHE/sdk/package.json" ]; then
  "$SKILL/scripts/cache-sync.sh" ${1:+--refresh}
fi

link() {
  [ -e "$1" ] || { echo "· $2 not in cache — skipped"; return; }
  rm -rf "$ROOT/$2"; mkdir -p "$(dirname "$ROOT/$2")"; ln -s "$1" "$ROOT/$2"; echo "✓ $2"
}
link "$CACHE/sdk"          "sdk"
link "$CACHE/bin/thymercli" "bin/thymercli"
link "$CACHE/examples"     "examples"

echo
echo "Note: the Thymer MCP server is the desktop app's built-in one on :13100"
echo "(enable: app → Settings → MCP (AI Agents) → Read & Write). bin/thymercli is the CLI client."

# Route git hooks through the committed hooks/ dir (pre-push keeps dist/ fresh).
if [ -d "$ROOT/.git" ]; then git -C "$ROOT" config core.hooksPath hooks; fi
