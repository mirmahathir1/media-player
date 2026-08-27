#!/bin/bash
#
# Removes everything install.command created, then deletes this checkout —
# this script included. Double-click it inside the checkout.
#
# Media downloaded into your library folder is never touched.

set -euo pipefail

APP_NAME="imdb-desktop"
LAUNCHER="$HOME/Desktop/IMDb.command"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mError: %s\033[0m\n\n' "$1" >&2; exit 1; }

# Bash reads a script as it runs, so a script cannot delete the directory it
# lives in and keep going. Re-run from a copy in /tmp, which frees the checkout.
if [ "${IMDB_UNINSTALL_RELAUNCHED:-}" != "1" ]; then
  SELF="${BASH_SOURCE[0]}"
  [ -f "$SELF" ] || fail "Run this from the checkout, not a pipe."
  PROJECT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
  [ -f "$PROJECT_DIR/package.json" ] || fail "$PROJECT_DIR is not an IMDb checkout."

  COPY="$(mktemp -t imdb-uninstall)"
  cat "$SELF" > "$COPY"
  chmod +x "$COPY"
  export IMDB_UNINSTALL_RELAUNCHED=1
  export IMDB_PROJECT_DIR="$PROJECT_DIR"
  cd /
  exec bash "$COPY"
fi

PROJECT_DIR="$IMDB_PROJECT_DIR"
SUPPORT_DIR="$HOME/Library/Application Support/$APP_NAME"
trap 'rm -f "$0"' EXIT

step "About to remove"
echo "  $PROJECT_DIR   (the whole checkout, including uninstall.command)"
echo "  $SUPPORT_DIR   (settings, watch progress, thumbnails)"
[ -e "$LAUNCHER" ] && echo "  $LAUNCHER"
echo
echo "Your downloaded media and library folder are NOT touched."
printf '\nType "yes" to continue: '
read -r answer < /dev/tty
[ "$answer" = "yes" ] || fail "Cancelled. Nothing was removed."

step "Quitting the app"
pkill -f "$PROJECT_DIR" 2>/dev/null || true
sleep 1

step "Removing the Desktop launcher"
rm -f "$LAUNCHER" && echo "done"

step "Removing app data"
rm -rf "$SUPPORT_DIR" && echo "$SUPPORT_DIR"

# node_modules/electron goes with the checkout below. The shared download cache
# at ~/Library/Caches/electron belongs to every Electron app, so it stays.
step "Removing the app cache"
rm -rf "$HOME/Library/Caches/$APP_NAME" && echo "done"

step "Removing the checkout"
rm -rf "$PROJECT_DIR"
[ -e "$PROJECT_DIR" ] && fail "Could not remove $PROJECT_DIR"

printf '\n\033[32mDone.\033[0m IMDb is gone. You can close this window.\n\n'
