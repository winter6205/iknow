#!/usr/bin/env bash
set -euo pipefail

INPUT="$(cat)"
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')"

block() {
  echo "BLOCKED: $1" >&2
  exit 2
}

[ -z "$COMMAND" ] && exit 0

# Normalize whitespace for safer matching.
NORMALIZED="$(printf '%s' "$COMMAND" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g')"

# Never bypass project quality gates.
if printf '%s' "$NORMALIZED" | grep -Eq 'git[[:space:]]+commit([^;&|]*--no-verify|[^;&|]*-n)([[:space:]]|$)'; then
  block "git commit must not use --no-verify or -n."
fi

if printf '%s' "$NORMALIZED" | grep -Eq 'git[[:space:]]+push([^;&|]*--no-verify)([[:space:]]|$)'; then
  block "git push must not use --no-verify."
fi

# Prevent destructive remote/history operations.
if printf '%s' "$NORMALIZED" | grep -Eq 'git[[:space:]]+push([^;&|]*(--force|-f))([[:space:]]|$)'; then
  block "force push requires explicit human approval outside automated execution."
fi

if printf '%s' "$NORMALIZED" | grep -Eq 'git[[:space:]]+reset[[:space:]]+--hard'; then
  block "git reset --hard is blocked."
fi

if printf '%s' "$NORMALIZED" | grep -Eq 'git[[:space:]]+clean[[:space:]]+-f'; then
  block "git clean is blocked."
fi

# Prevent hook tampering.
if printf '%s' "$NORMALIZED" | grep -Eq '(rm|mv|chmod|sed|perl|python|node|sh|bash).*(\.git/hooks|\.husky|pre-commit|lint-staged)'; then
  block "modifying or disabling Git hooks is blocked."
fi

# Prevent destructive file removal.
if printf '%s' "$NORMALIZED" | grep -Eq 'rm[[:space:]]+(-[[:alnum:]]*r[[:alnum:]]*f|-[[:alnum:]]*f[[:alnum:]]*r)'; then
  block "rm -rf is blocked. Use a safer, explicit deletion plan."
fi

# Prevent secret exfiltration through common shell reads.
if printf '%s' "$NORMALIZED" | grep -Eq '(cat|less|more|tail|head|sed|awk|grep|rg).*(\.env|id_rsa|id_ed25519|\.pem|\.key|credentials|secrets)'; then
  block "reading sensitive files is blocked."
fi

exit 0
