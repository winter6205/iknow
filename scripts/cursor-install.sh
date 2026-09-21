#!/usr/bin/env bash
# Baseline setup for the Cursor Cloud Agent environment (`install` phase).
#
# With environment builds this runs once, while the snapshot is created;
# pods that boot from that snapshot never re-run it. So everything here
# must be idempotent and may only produce durable files. Anything that
# needs a live process on every boot belongs in `cursor-start.sh`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n=== cursor-install: %s ===\n' "$*"; }

# package.json engines floor; the preferred pin is what nvm ships on this image
# and what the sandbox/TUI suites are exercised against.
NODE_VERSION_MIN="20.0.0"
NODE_VERSION_PREFERRED="22.22.0"
# specs/security-guardrails.md documents this floor. Ubuntu noble only ships
# 0.9.0, which still satisfies every fence flag the runner emits, so a lower
# version is a warning rather than a failure.
BWRAP_VERSION_PREFERRED="0.11.1"

# True when $1 >= $2 under dotted-numeric ordering.
version_ge() {
  [ "$1" = "$2" ] && return 0
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo -n "$@"
  fi
}

# --------------------------------------------------------------------
# bubblewrap (bwrap is a hard runtime dependency of the sandbox fence)
# --------------------------------------------------------------------
log "bubblewrap"
if ! command -v bwrap >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  as_root apt-get update -qq || true
  as_root apt-get install -y -qq --no-install-recommends bubblewrap ||
    echo "cursor-install: WARNING apt install bubblewrap failed" >&2
fi
if ! bwrap --version >/dev/null 2>&1; then
  echo "cursor-install: bwrap is required by src/harness/sandbox but is missing or not runnable" >&2
  exit 1
fi
bwrap --version
BWRAP_VERSION="$(bwrap --version | awk '{print $NF}')"
if ! version_ge "$BWRAP_VERSION" "$BWRAP_VERSION_PREFERRED"; then
  echo "cursor-install: WARNING bwrap $BWRAP_VERSION < ${BWRAP_VERSION_PREFERRED} (distro cap); fence flags still verified below" >&2
fi
# Smoke the exact fence shape the runner emits, so a distro bwrap that lacks a
# flag fails here rather than inside the sandbox suite.
bwrap --unshare-user-try --unshare-net --die-with-parent \
  --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 --ro-bind /etc /etc --size 268435456 --tmpfs /tmp \
  --proc /proc --dev-bind /dev /dev --clearenv --chdir / \
  -- /bin/true

# --------------------------------------------------------------------
# Sensitive-path fixtures
# --------------------------------------------------------------------
# createBwrapFence only emits `--tmpfs <HOME>/.ssh` when the directory exists
# (bwrap.ts existsSync guard), and tests/harness/aci/bash-sandbox.test.ts
# asserts that overlay. A pod without ~/.ssh fails the assertion.
log "sensitive-path fixtures"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"

# --------------------------------------------------------------------
# PATH
# --------------------------------------------------------------------
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NVM_BIN_DIR=""
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  # `nvm use` is required, not decorative: the pod ships /exec-daemon, which
  # provides its own `node` but no `npm`, and sits ahead of the nvm bin dir on
  # PATH. Without pinning, `node` and `npm` resolve to two different Node
  # trees (observed: /exec-daemon/node v22.14.0 vs nvm npm from v22.22.2).
  nvm use --silent default >/dev/null 2>&1 ||
    nvm use --silent --lts >/dev/null 2>&1 || true
  NVM_BIN_DIR="${NVM_BIN:-}"
  if [ -z "$NVM_BIN_DIR" ]; then
    NVM_NODE_PATH="$(nvm which current 2>/dev/null || true)"
    if [ -n "$NVM_NODE_PATH" ] && [ -x "$NVM_NODE_PATH" ]; then
      NVM_BIN_DIR="$(dirname "$NVM_NODE_PATH")"
    fi
  fi
fi

mkdir -p "$HOME/.local/bin"
if [ -n "$NVM_BIN_DIR" ] && [ -x "$NVM_BIN_DIR/node" ]; then
  export PATH="$NVM_BIN_DIR:$PATH"
fi
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

BASHRC_MARKER='# cursor-install: ~/.local/bin'
if ! grep -qF "$BASHRC_MARKER" "$HOME/.bashrc" 2>/dev/null; then
  {
    printf '%s\n' "$BASHRC_MARKER"
    printf '%s\n' 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"'
  } >>"$HOME/.bashrc"
fi

# Durable half of the same pin: interactive/boot shells re-derive PATH after
# nvm.sh has run, so re-prepend the nvm bin dir there too.
NVM_BASHRC_MARKER='# cursor-install: prefer nvm node over /exec-daemon'
if [ -n "$NVM_BIN_DIR" ] &&
  ! grep -qF "$NVM_BASHRC_MARKER" "$HOME/.bashrc" 2>/dev/null; then
  {
    printf '%s\n' "$NVM_BASHRC_MARKER"
    printf '%s\n' "[ -x \"$NVM_BIN_DIR/node\" ] && export PATH=\"$NVM_BIN_DIR:\$PATH\""
    printf '%s\n' 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"'
  } >>"$HOME/.bashrc"
fi

# .bashrc only covers interactive shells. Non-interactive ones (the agent's own
# shell, npm lifecycle scripts) keep the pod's PATH, where /exec-daemon still
# wins. ~/.local/bin already leads that PATH, so shadow the split there — this
# is the only pin that survives without a shell rc.
if [ -n "$NVM_BIN_DIR" ]; then
  for tool in node npm npx; do
    if [ -x "$NVM_BIN_DIR/$tool" ]; then
      ln -sfn "$NVM_BIN_DIR/$tool" "$HOME/.local/bin/$tool"
    fi
  done
fi

log "toolchain preflight"
command -v node
node --version
command -v npm
npm --version

# node and npm must come from one Node install; a split pair (npm's package
# files from tree A running under a node from tree B) breaks native module
# resolution in ways that only surface deep inside `npm ci`. Resolve through
# the ~/.local/bin symlinks — comparing the link paths themselves would compare
# one directory against itself and assert nothing.
NODE_REAL="$(readlink -f "$(command -v node)")"
NPM_REAL="$(readlink -f "$(command -v npm)")"
NODE_PREFIX="$(dirname "$(dirname "$NODE_REAL")")"
case "$NPM_REAL" in
"$NODE_PREFIX"/*) ;;
*)
  echo "cursor-install: npm ($NPM_REAL) is not part of the node install at $NODE_PREFIX" >&2
  exit 1
  ;;
esac

NODE_VERSION="$(node --version)"
NODE_VERSION="${NODE_VERSION#v}"
if ! version_ge "$NODE_VERSION" "$NODE_VERSION_PREFERRED"; then
  echo "cursor-install: WARNING node $NODE_VERSION < ${NODE_VERSION_PREFERRED} (preferred)" >&2
fi
if ! version_ge "$NODE_VERSION" "$NODE_VERSION_MIN"; then
  echo "cursor-install: node $NODE_VERSION is below the required ${NODE_VERSION_MIN}" >&2
  exit 1
fi

# --------------------------------------------------------------------
# Bun (TUI tests: npm test runs bun test tests/tui/)
# --------------------------------------------------------------------
log "bun"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors \
    https://bun.sh/install -o /tmp/bun-install.sh
  bash /tmp/bun-install.sh
  rm -f /tmp/bun-install.sh
  export PATH="$HOME/.bun/bin:$PATH"
fi
command -v bun
bun --version

# --------------------------------------------------------------------
# npm workspaces (root + web) + builds
# --------------------------------------------------------------------
log "npm ci + TypeScript build"
HUSKY=0 npm ci
HUSKY=0 npm run build
test -f "$REPO_ROOT/dist/index.js"
test -f "$REPO_ROOT/dist/cli.js"

log "web SPA build"
HUSKY=0 npm run web:build
test -f "$REPO_ROOT/web/dist/index.html"

log "done"
