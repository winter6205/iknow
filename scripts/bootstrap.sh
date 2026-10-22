#!/usr/bin/env bash
# scripts/bootstrap.sh — idempotent project setup (5 steps)
# Usage: bash scripts/bootstrap.sh
#
# Steps:
#   1. git init (if not)
#   2. Verify .evals/ exists
#   3. Verify docs/CONTEXT.md exists
#   4. Verify docs/handoff/ exists
#   5. Run .evals/run.sh baseline
#
# Local git hooks come from husky (`npm run prepare`); this script leaves
# core.hooksPath alone.
#
# Idempotent: each step checks existing and skips if present.
# Exit code: 0 on full success, 1 if baseline eval fails, 2 if structure missing.
set -euo pipefail

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      echo "Usage: bash scripts/bootstrap.sh"
      exit 0
      ;;
    *) echo "[bootstrap] unknown arg: $1" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

step() {
  echo ""
  echo "[bootstrap] step $1: $2"
}

ok() {
  echo "[bootstrap] OK: $1"
}

skip() {
  echo "[bootstrap] SKIP: $1"
}

fail() {
  echo "[bootstrap] FAIL: $1" >&2
  exit "${2:-1}"
}

# Step 1: git init
step 1 "git init"
if [ -d .git ]; then
  skip ".git already exists"
else
  git init >/dev/null 2>&1 && ok "git init" || fail "git init failed"
fi

# Step 2: .evals/ exists
step 2 "verify .evals/ exists"
if [ -d .evals ] && [ -f .evals/run.sh ] && [ -d .evals/tasks ]; then
  skip ".evals/ scaffold present"
else
  fail ".evals/ missing — template corrupt (re-copy template)"
fi

# Step 3: docs/CONTEXT.md exists
step 3 "verify docs/CONTEXT.md exists"
if [ -f docs/CONTEXT.md ]; then
  skip "docs/CONTEXT.md present"
else
  fail "docs/CONTEXT.md missing — template corrupt"
fi

# Step 4: docs/handoff/ exists
step 4 "verify docs/handoff/ exists"
if [ -d docs/handoff ]; then
  skip "docs/handoff/ present"
else
  fail "docs/handoff/ missing — template corrupt"
fi

# Step 5: Run baseline eval
step 5 "run .evals/run.sh baseline"
if [ -x .evals/run.sh ]; then
  bash .evals/run.sh && ok "baseline eval pass" || fail "baseline eval failed — fix and re-run"
else
  # bash may not need executable bit; try without
  bash .evals/run.sh && ok "baseline eval pass" || fail "baseline eval failed — fix and re-run"
fi

echo ""
echo "[bootstrap] SUCCESS: all 5 steps complete"
exit 0