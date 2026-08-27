#!/bin/bash
#
# Installs IMDb and puts a launcher on the Desktop.
#
# Double-click this file inside a checkout, or run it straight from the web,
# in which case it asks where to put the clone first:
#
#   curl -fsSL https://raw.githubusercontent.com/mirmahathir1/media-player/master/install.command | bash

set -euo pipefail

REPO_URL="https://github.com/mirmahathir1/media-player.git"
REPO_NAME="media-player"
LAUNCHER="$HOME/Desktop/IMDb.command"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31mError: %s\033[0m\n\n' "$1" >&2; exit 1; }

# Piped from curl there is no file on disk, so this reports no checkout.
checkout_dir() {
  local src="${BASH_SOURCE[0]:-}"
  [ -n "$src" ] && [ -f "$src" ] || return 1
  local dir
  dir="$(cd "$(dirname "$src")" && pwd)"
  [ -f "$dir/package.json" ] || return 1
  printf '%s' "$dir"
}

# The Finder's own folder picker, so running from the web needs no typing.
ask_for_folder() {
  osascript -e 'POSIX path of (choose folder with prompt "Choose a folder to install IMDb into")' 2>/dev/null
}

step "Checking for git and node"
command -v git >/dev/null || fail "git is not installed. Install Xcode command line tools with: xcode-select --install"
command -v node >/dev/null || fail "node is not installed. Get it from https://nodejs.org or with: brew install node"
command -v npm >/dev/null || fail "npm is not installed. It normally ships with node."
echo "git $(git --version | awk '{print $3}'), node $(node --version), npm $(npm --version)"

if PROJECT_DIR="$(checkout_dir)"; then
  step "Using this checkout"
  echo "$PROJECT_DIR"
else
  step "Choosing where to install"
  PARENT="$(ask_for_folder)"
  [ -n "$PARENT" ] || fail "No folder chosen."
  PROJECT_DIR="${PARENT%/}/$REPO_NAME"

  if [ -d "$PROJECT_DIR/.git" ]; then
    echo "Already cloned, updating $PROJECT_DIR"
    git -C "$PROJECT_DIR" pull --ff-only
  else
    [ -e "$PROJECT_DIR" ] && fail "$PROJECT_DIR already exists and is not a checkout."
    echo "Cloning into $PROJECT_DIR"
    git clone "$REPO_URL" "$PROJECT_DIR"
  fi
fi

cd "$PROJECT_DIR"

step "Installing npm packages"
npm install

# npm can hold back install scripts, which leaves electron without the binary
# it downloads for itself. The archive still lands in the cache, so unpack it
# by hand when the postinstall did not run or did not finish.
step "Checking the Electron binary"
ELECTRON_DIR="$PROJECT_DIR/node_modules/electron"
ELECTRON_BIN="$ELECTRON_DIR/dist/Electron.app/Contents/MacOS/Electron"

if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Electron is missing its binary, downloading it"
  node "$ELECTRON_DIR/install.js" || true
fi

if [ ! -x "$ELECTRON_BIN" ]; then
  echo "Unpacking the cached download"
  VERSION="$(node -p "require('$ELECTRON_DIR/package.json').version")"
  ARCH="$(uname -m)"; [ "$ARCH" = "x86_64" ] && ARCH="x64" || ARCH="arm64"
  ZIP="$(find "$HOME/Library/Caches/electron" -name "electron-v$VERSION-darwin-$ARCH.zip" -print -quit 2>/dev/null || true)"
  [ -n "$ZIP" ] || fail "Electron did not download. Try again, or run: npm approve-scripts electron"

  rm -rf "$ELECTRON_DIR/dist"
  mkdir -p "$ELECTRON_DIR/dist"
  ditto -xk "$ZIP" "$ELECTRON_DIR/dist"
  printf 'Electron.app/Contents/MacOS/Electron' > "$ELECTRON_DIR/path.txt"
fi

[ -x "$ELECTRON_BIN" ] || fail "Electron is still not installed."
echo "Electron is ready"

# ffmpeg, ffprobe and VLC live under vendor/ so nothing has to be installed on
# the machine. npm install normally fetches them; this covers a partial run.
step "Checking ffmpeg, ffprobe and VLC"
npm run vendor

step "Putting IMDb.command on the Desktop"
cat > "$LAUNCHER" <<LAUNCHER_EOF
#!/bin/bash
# Starts IMDb. Created by install.command; delete it whenever you like.
export PATH="$(dirname "$(command -v npm)"):\$PATH"
cd "$PROJECT_DIR" || exit 1
exec npm start
LAUNCHER_EOF
chmod +x "$LAUNCHER"
echo "$LAUNCHER"

printf '\n\033[32mDone.\033[0m Double-click IMDb.command on your Desktop to start the app.\n\n'
