#!/usr/bin/env bash
# Per-boot runtime init for the Cursor Cloud Agent VM (`start` phase).
#
# iknow has no compose/dockerd daemons. Dependencies live in the snapshot
# from cursor-install.sh. This script re-pins PATH (git identity pin moved to
# the archive repo), then setdefaults the MiniMax Anthropic node
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

# ADR-0015 + ADR-0084 + ADR-0093: llm is user-layer only, and model must
# hit llm.providers (bare model → provider_model_not_registered). Project
# `<cwd>/.iknow/settings.json` only carries verify/secrets/permissions
# — seeding llm there is silently ignored. Seed ~/.iknow/settings.json when
# missing so a Cloud Agent with only ANTHROPIC_AUTH_TOKEN can talk to the
# official MiniMax Anthropic node; never overwrite an operator-scp'd file.
SETTINGS_PATH="$HOME/.iknow/settings.json"
if [ ! -f "$SETTINGS_PATH" ]; then
  log "seed $SETTINGS_PATH (user-layer llm + providers, ADR-0084/0093)"
  mkdir -p "$HOME/.iknow"
  printf '%s\n' '{
  "llm": {
    "model": "minimax-cn/MiniMax-M3",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}",
    "providers": [
      {
        "id": "minimax-cn",
        "baseUrl": "https://api.minimaxi.com/anthropic",
        "apiKeyEnv": "ANTHROPIC_AUTH_TOKEN",
        "models": [
          {
            "id": "MiniMax-M3",
            "name": "MiniMax-M3",
            "contextWindow": 1000000,
            "maxTokens": 128000
          }
        ]
      }
    ]
  }
}' >"$SETTINGS_PATH"
  chmod 600 "$SETTINGS_PATH"
else
  log "keep existing $SETTINGS_PATH"
fi

log "ready (no boot daemons)"
