#!/usr/bin/env bash
set -euo pipefail

echo "Running pre-commit guard..."

if git diff --cached --name-only | grep -E '(^|/)\.env(\.|$)|\.pem$|\.key$|id_rsa|id_ed25519|credentials|secrets' >/dev/null; then
  echo "ERROR: staged files include sensitive-looking files." >&2
  exit 1
fi

if git diff --cached | grep -E '(AKIA[0-9A-Z]{16}|BEGIN RSA PRIVATE KEY|BEGIN OPENSSH PRIVATE KEY|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-)' >/dev/null; then
  echo "ERROR: staged diff appears to contain secret material." >&2
  exit 1
fi

if git diff --cached --check; then
  true
else
  echo "ERROR: whitespace errors detected." >&2
  exit 1
fi

echo "Pre-commit guard passed."
