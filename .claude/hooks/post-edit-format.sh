#!/usr/bin/env bash
set -euo pipefail

# Keep this conservative. Do not format the whole repository automatically.
# Prefer project-specific commands after the team agrees.

if [ -f package.json ]; then
  if jq -e '.scripts["format:check"]' package.json >/dev/null 2>&1; then
    npm run format:check
  elif jq -e '.scripts["lint"]' package.json >/dev/null 2>&1; then
    echo "Post-edit note: lint script exists. Run it before committing."
  fi
fi

exit 0
