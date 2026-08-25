#!/usr/bin/env bash
# Per-boot runtime init for the Cursor Cloud Agent VM (`start` phase).
#
# iknow has no compose/dockerd daemons. Dependencies live in the snapshot
# from cursor-install.sh. This script re-pins PATH + git identity (install
# does not run on every boot), then setdefaults the MiniMax Anthropic node
# so a Cloud Agent with only ANTHROPIC_AUTH_TOKEN injected can talk to
# official MiniMax without a gitignored .env.local.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { printf '\n=== cursor-start: %s ===\n' "$*"; }

# MiniMax CN Anthropic Messages node (SDK appends /v1/messages).
# Same operator key as fin; fin uses the Chat Completions node instead.
IKNOW_MINIMAX_ANTHROPIC_URL="https://api.minimaxi.com/anthropic"
BASHRC_LLM_MARKER="# cursor-start: iknow MiniMax Anthropic node"

GIT_IDENTITY_NAME="winter6205"
GIT_IDENTITY_EMAIL="136674824+winter6205@users.noreply.github.com"
log "git author identity"
git config --global user.name "$GIT_IDENTITY_NAME"
git config --global user.email "$GIT_IDENTITY_EMAIL"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git config --local user.name "$GIT_IDENTITY_NAME"
  git config --local user.email "$GIT_IDENTITY_EMAIL"
fi

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
fi
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

test -f "$REPO_ROOT/dist/index.js"
test -f "$REPO_ROOT/web/dist/index.html"

# --------------------------------------------------------------------
# LLM boot defaults (official MiniMax Anthropic node)
# --------------------------------------------------------------------
# Process env / Cloud secrets win. URL setdefault only — never assign
# ANTHROPIC_AUTH_TOKEN here. Agent shells spawned after start may not
# inherit this process env, so the same ${VAR:-default} line is kept in
# ~/.bashrc (idempotent marker).
log "llm env defaults"
export IKNOW_LLM_BASE_URL="${IKNOW_LLM_BASE_URL:-$IKNOW_MINIMAX_ANTHROPIC_URL}"
if [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  log "ANTHROPIC_AUTH_TOKEN=SET"
else
  log "ANTHROPIC_AUTH_TOKEN=UNSET (inject Cloud Secret with this name)"
fi

if ! grep -qF "$BASHRC_LLM_MARKER" "$HOME/.bashrc" 2>/dev/null; then
  {
    printf '%s\n' "$BASHRC_LLM_MARKER"
    printf '%s\n' 'export IKNOW_LLM_BASE_URL="${IKNOW_LLM_BASE_URL:-https://api.minimaxi.com/anthropic}"'
  } >>"$HOME/.bashrc"
fi

# ADR-0015: model + apiKey placeholder live in settings.json (gitignore).
# Seed only when missing so a scp'd operator file is never overwritten.
SETTINGS_PATH="$REPO_ROOT/.iknow/settings.json"
if [ ! -f "$SETTINGS_PATH" ]; then
  log "seed $SETTINGS_PATH"
  mkdir -p "$REPO_ROOT/.iknow"
  printf '%s\n' '{
  "llm": {
    "model": "MiniMax-M3",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}"
  }
}' >"$SETTINGS_PATH"
  chmod 600 "$SETTINGS_PATH"
else
  log "keep existing $SETTINGS_PATH"
fi

log "ready (no boot daemons)"
