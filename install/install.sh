#!/usr/bin/env bash
# Causyne Agent installer for macOS, Linux, and WSL.
# Usage: curl -fsSL https://causyne.com/install.sh | bash
set -euo pipefail

PACKAGE='@causyne/agent@latest'
INSTALL_ROOT="$HOME/.causyne/installation"
RUNTIME_ROOT="$HOME/.causyne/runtime"
BIN_DIR="$HOME/.local/bin"
MIN_NODE_MAJOR=24

say() { printf '  %s\n' "$*"; }
fail() { printf '  Error: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

install_private_node() {
  has curl || fail 'curl is required to download Node.js.'
  has tar || fail 'tar is required to unpack Node.js.'

  local platform machine checksums archive expected actual temp extracted
  case "$(uname -s)" in
    Darwin) platform='darwin' ;;
    Linux)
      if [ -e /etc/alpine-release ]; then
        fail 'A compatible Node.js 24+ runtime is required on Alpine Linux. Install Node.js with apk, then run this installer again.'
      fi
      platform='linux'
      ;;
    *) fail 'Use https://causyne.com/install.ps1 on Windows.' ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) machine='arm64' ;;
    x86_64|amd64) machine='x64' ;;
    *) fail "Unsupported architecture: $(uname -m)" ;;
  esac

  say "Node.js $MIN_NODE_MAJOR+ was not found; installing a private runtime."
  checksums="$(curl -fsSL "https://nodejs.org/dist/latest-v${MIN_NODE_MAJOR}.x/SHASUMS256.txt")"
  archive="$(printf '%s\n' "$checksums" | awk -v suffix="-${platform}-${machine}.tar.gz" '$2 ~ suffix "$" { print $2; exit }')"
  [ -n "$archive" ] || fail 'Could not resolve a compatible Node.js archive.'
  expected="$(printf '%s\n' "$checksums" | awk -v file="$archive" '$2 == file { print $1; exit }')"

  temp="$(mktemp -d "${TMPDIR:-/tmp}/causyne-install.XXXXXX")"
  trap 'rm -rf "$temp"' EXIT
  curl -fsSL "https://nodejs.org/dist/latest-v${MIN_NODE_MAJOR}.x/$archive" -o "$temp/$archive"
  if has shasum; then
    actual="$(shasum -a 256 "$temp/$archive" | awk '{print $1}')"
  elif has sha256sum; then
    actual="$(sha256sum "$temp/$archive" | awk '{print $1}')"
  else
    fail 'A SHA-256 utility is required to verify the Node.js download.'
  fi
  [ "$actual" = "$expected" ] || fail 'Node.js checksum verification failed.'

  tar -xzf "$temp/$archive" -C "$temp"
  extracted="$temp/${archive%.tar.gz}"
  mkdir -p "$RUNTIME_ROOT"
  rm -rf "$RUNTIME_ROOT/node.next"
  mv "$extracted" "$RUNTIME_ROOT/node.next"
  rm -rf "$RUNTIME_ROOT/node"
  mv "$RUNTIME_ROOT/node.next" "$RUNTIME_ROOT/node"
  export PATH="$RUNTIME_ROOT/node/bin:$PATH"
}

install_package() {
  local major
  major="$(node_major || true)"
  if [ -z "$major" ] || [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    install_private_node
  fi
  has npm || fail 'npm was not found after installing Node.js.'

  mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
  say "Installing Causyne Agent from the public npm registry..."
  npm install --global --prefix "$INSTALL_ROOT" "$PACKAGE" --ignore-scripts --no-audit --no-fund

  cat > "$BIN_DIR/causyne" <<'WRAPPER'
#!/bin/sh
INSTALL_ROOT="$HOME/.causyne/installation"
if [ -x "$HOME/.causyne/runtime/node/bin/node" ]; then
  export PATH="$HOME/.causyne/runtime/node/bin:$PATH"
fi
export CAUSYNE_INSTALL_ROOT="$INSTALL_ROOT"
export CAUSYNE_NPM_COMMAND="npm"
exec node "$INSTALL_ROOT/lib/node_modules/@causyne/agent/bin/causyne.js" "$@"
WRAPPER
  chmod 755 "$BIN_DIR/causyne"
  ln -sf "$BIN_DIR/causyne" "$BIN_DIR/causyne-agent"
}

register_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return ;;
  esac
  local profile
  case "${SHELL:-}" in
    */zsh) profile="$HOME/.zprofile" ;;
    *) profile="$HOME/.profile" ;;
  esac
  touch "$profile"
  if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$profile"; then
    printf '\n# Causyne Agent\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$profile"
  fi
  export PATH="$BIN_DIR:$PATH"
  say "Added $BIN_DIR to PATH in $profile."
}

main() {
  printf '\n  Causyne Agent installer\n\n'
  case "$(uname -s)" in
    Darwin) say "Detected macOS ($(uname -m))." ;;
    Linux) say "Detected Linux/WSL ($(uname -m))." ;;
    *) fail 'Unsupported operating system.' ;;
  esac
  install_package
  register_path
  local installed
  installed="$($BIN_DIR/causyne --version)"
  printf '\n  Causyne Agent %s installed.\n' "$installed"
  say 'Open a new terminal, move to your project, and run: causyne'
  say 'The first run opens the foreground local CLI menu.'
  printf '\n'
}

main "$@"
