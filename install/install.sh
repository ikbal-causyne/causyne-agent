#!/usr/bin/env bash
# Causyne Agent installer for macOS, Linux, WSL, and Windows Git Bash.
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
  local bin="${1:-node}"
  "$bin" --version 2>/dev/null | sed 's/^v//' | cut -d. -f1 | tr -cd '0-9'
}

find_existing_node() {
  if [ -x "$RUNTIME_ROOT/node/bin/node" ]; then
    local m
    m="$(node_major "$RUNTIME_ROOT/node/bin/node" || true)"
    if [ -n "$m" ] && [ "$m" -ge "$MIN_NODE_MAJOR" ]; then
      export PATH="$RUNTIME_ROOT/node/bin:$PATH"
      return 0
    fi
  fi

  if has node; then
    local m
    m="$(node_major node || true)"
    if [ -n "$m" ] && [ "$m" -ge "$MIN_NODE_MAJOR" ]; then
      return 0
    fi
  fi

  local dir candidate
  for dir in \
    "/opt/homebrew/bin" \
    "/usr/local/bin" \
    "$HOME/.local/bin" \
    "$HOME/.volta/bin" \
    "$HOME/.local/share/mise/shims" \
    "$HOME/.asdf/shims" \
    "$HOME/.fnm/current/bin"
  do
    if [ -x "$dir/node" ]; then
      local m
      m="$(node_major "$dir/node" || true)"
      if [ -n "$m" ] && [ "$m" -ge "$MIN_NODE_MAJOR" ]; then
        export PATH="$dir:$PATH"
        return 0
      fi
    fi
  done

  if [ -d "$HOME/.nvm/versions/node" ]; then
    for candidate in "$HOME/.nvm/versions/node"/v*/bin/node; do
      [ -x "$candidate" ] || continue
      local m
      m="$(node_major "$candidate" || true)"
      if [ -n "$m" ] && [ "$m" -ge "$MIN_NODE_MAJOR" ]; then
        export PATH="$(dirname "$candidate"):$PATH"
      fi
    done
    if has node; then
      local m
      m="$(node_major node || true)"
      if [ -n "$m" ] && [ "$m" -ge "$MIN_NODE_MAJOR" ]; then
        return 0
      fi
    fi
  fi

  return 1
}

resolve_arch() {
  local arch
  arch="$(uname -m)"
  if [ "$(uname -s)" = "Darwin" ] && [ "$arch" = "x86_64" ]; then
    if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
      arch="arm64"
    fi
  fi
  case "$arch" in
    arm64|aarch64) printf 'arm64' ;;
    x86_64|amd64) printf 'x64' ;;
    *) fail "Unsupported architecture: $arch" ;;
  esac
}

verify_sha256() {
  local file="$1" expected="$2" actual=""
  if has shasum; then
    actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  elif has sha256sum; then
    actual="$(sha256sum "$file" | awk '{print $1}')"
  elif has openssl; then
    actual="$(openssl dgst -sha256 "$file" | awk '{print $NF}')"
  else
    fail 'A SHA-256 utility is required to verify the Node.js download.'
  fi
  [ "$actual" = "$expected" ] || fail 'Node.js checksum verification failed.'
}

install_private_node() {
  has curl || fail 'curl is required to download Node.js.'
  has tar || fail 'tar is required to unpack Node.js.'

  local platform machine dist_base checksums archive expected temp extracted
  machine="$(resolve_arch)"
  dist_base="https://nodejs.org/dist/latest-v${MIN_NODE_MAJOR}.x"

  case "$(uname -s)" in
    Darwin) platform='darwin' ;;
    Linux)
      platform='linux'
      if [ -e /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then
        dist_base="https://unofficial-builds.nodejs.org/download/release/latest-v${MIN_NODE_MAJOR}.x"
        machine="${machine}-musl"
      fi
      ;;
    *) fail 'Use https://causyne.com/install.ps1 on Windows.' ;;
  esac

  say "Node.js $MIN_NODE_MAJOR+ was not found; installing a private runtime..."
  checksums="$(curl -fsSL "$dist_base/SHASUMS256.txt")" || fail 'Could not download Node.js checksums.'
  archive="$(printf '%s\n' "$checksums" | awk -v suffix="-${platform}-${machine}.tar.gz" '$2 ~ suffix "$" { print $2; exit }')"
  [ -n "$archive" ] || fail "Could not resolve a compatible Node.js archive for ${platform}-${machine}."
  expected="$(printf '%s\n' "$checksums" | awk -v file="$archive" '$2 == file { print $1; exit }')"

  temp="$(mktemp -d "${TMPDIR:-/tmp}/causyne-install.XXXXXX")"
  trap 'rm -rf "$temp"' EXIT
  curl -fsSL "$dist_base/$archive" -o "$temp/$archive"
  verify_sha256 "$temp/$archive" "$expected"

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
  if ! find_existing_node; then
    install_private_node
  fi
  has npm || fail 'npm was not found after installing Node.js.'

  local active_node_dir
  active_node_dir="$(dirname "$(command -v node)")"

  mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
  say "Installing Causyne Agent from the public npm registry..."
  npm install --global --prefix "$INSTALL_ROOT" "$PACKAGE" --ignore-scripts --no-audit --no-fund

  rm -f "$BIN_DIR/causyne" "$BIN_DIR/causyne-agent"

  cat > "$BIN_DIR/causyne" <<WRAPPER
#!/bin/sh
INSTALL_ROOT="\$HOME/.causyne/installation"
if [ -x "\$HOME/.causyne/runtime/node/bin/node" ]; then
  export PATH="\$HOME/.causyne/runtime/node/bin:\$PATH"
elif [ -d "${active_node_dir}" ]; then
  export PATH="${active_node_dir}:\$PATH"
fi
export PATH="\$PATH:/opt/homebrew/bin:/usr/local/bin"
export CAUSYNE_INSTALL_ROOT="\$INSTALL_ROOT"
export CAUSYNE_NPM_COMMAND="npm"
if [ -f "\$INSTALL_ROOT/lib/node_modules/@causyne/agent/bin/causyne.js" ]; then
  exec node "\$INSTALL_ROOT/lib/node_modules/@causyne/agent/bin/causyne.js" "\$@"
elif [ -f "\$INSTALL_ROOT/node_modules/@causyne/agent/bin/causyne.js" ]; then
  exec node "\$INSTALL_ROOT/node_modules/@causyne/agent/bin/causyne.js" "\$@"
else
  echo "Causyne Agent installation not found in \$INSTALL_ROOT" >&2
  exit 1
fi
WRAPPER
  chmod 755 "$BIN_DIR/causyne"
  ln -sf "$BIN_DIR/causyne" "$BIN_DIR/causyne-agent"

  local sys_bin
  for sys_bin in /opt/homebrew/bin /usr/local/bin; do
    if [ -d "$sys_bin" ] && [ -w "$sys_bin" ]; then
      case ":$PATH:" in
        *":$sys_bin:"*)
          rm -f "$sys_bin/causyne" "$sys_bin/causyne-agent" 2>/dev/null || true
          ln -sf "$BIN_DIR/causyne" "$sys_bin/causyne" 2>/dev/null || true
          ln -sf "$BIN_DIR/causyne" "$sys_bin/causyne-agent" 2>/dev/null || true
          ;;
      esac
    fi
  done
}

append_path_to_profile() {
  local profile="$1"
  touch "$profile" 2>/dev/null || return 0
  if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$profile" 2>/dev/null; then
    printf '\n# Causyne Agent\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$profile"
    say "Added $BIN_DIR to PATH in $profile."
  fi
}

register_path() {
  local updated=0
  if [ -f "$HOME/.zshrc" ] || [ "${SHELL:-}" = "/bin/zsh" ] || [ "${SHELL:-}" = "/usr/bin/zsh" ]; then
    append_path_to_profile "$HOME/.zshrc"
    append_path_to_profile "$HOME/.zprofile"
    updated=1
  fi
  if [ -f "$HOME/.bashrc" ] || [ "${SHELL:-}" = "/bin/bash" ] || [ "${SHELL:-}" = "/usr/bin/bash" ]; then
    append_path_to_profile "$HOME/.bashrc"
    if [ -f "$HOME/.bash_profile" ]; then
      append_path_to_profile "$HOME/.bash_profile"
    else
      append_path_to_profile "$HOME/.profile"
    fi
    updated=1
  fi
  if [ "$updated" -eq 0 ]; then
    append_path_to_profile "$HOME/.profile"
  fi
  if [ -d "$HOME/.config/fish" ] || [ "${SHELL:-}" = "/usr/bin/fish" ] || [ "${SHELL:-}" = "/opt/homebrew/bin/fish" ]; then
    local fish_cfg="$HOME/.config/fish/config.fish"
    mkdir -p "$HOME/.config/fish" 2>/dev/null || true
    touch "$fish_cfg" 2>/dev/null || true
    if ! grep -Fq 'fish_add_path' "$fish_cfg" 2>/dev/null && ! grep -Fq '/.local/bin' "$fish_cfg" 2>/dev/null; then
      printf '\n# Causyne Agent\nfish_add_path -g "$HOME/.local/bin"\n' >> "$fish_cfg"
      say "Added $BIN_DIR to PATH in $fish_cfg."
    fi
  fi
  export PATH="$BIN_DIR:$PATH"
}

main() {
  printf '\n  Causyne Agent installer\n\n'
  local os_name
  os_name="$(uname -s)"
  case "$os_name" in
    Darwin) say "Detected macOS ($(resolve_arch))." ;;
    Linux) say "Detected Linux/WSL ($(resolve_arch))." ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      say "Detected Windows shell ($os_name); delegating to PowerShell installer..."
      if has powershell.exe; then
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://causyne.com/install.ps1 | iex"
        return $?
      elif has pwsh; then
        pwsh -NoProfile -ExecutionPolicy Bypass -Command "irm https://causyne.com/install.ps1 | iex"
        return $?
      else
        fail 'PowerShell is required on Windows. Run: irm https://causyne.com/install.ps1 | iex'
      fi
      ;;
    *) fail "Unsupported operating system: $os_name" ;;
  esac
  install_package
  register_path
  local installed
  installed="$("$BIN_DIR/causyne" --version)"
  printf '\n  Causyne Agent %s installed.\n' "$installed"
  say 'Run `causyne` in your project directory to start.'
  say 'If `causyne` is not found in this terminal, run: export PATH="$HOME/.local/bin:$PATH"'
  printf '\n'
}

main "$@"
