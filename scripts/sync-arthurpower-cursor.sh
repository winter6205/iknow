#!/usr/bin/env bash
# Vendor arthurpower workflow skills/agents into this repo so Cursor Cloud
# Agents can see them under /workspace/.cursor (home-dir plugins are invisible).
#
# Usage:
#   scripts/sync-arthurpower-cursor.sh
#   ARTHURPOWER_SRC=/path/to/arthurpower scripts/sync-arthurpower-cursor.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Prefer marketplace checkout (live); fall back to installed cache pin.
DEFAULT_SRC="$HOME/.claude/plugins/marketplaces/arthurpower-local/plugins/arthurpower"
if [ ! -f "$DEFAULT_SRC/.claude-plugin/plugin.json" ]; then
  DEFAULT_SRC="$HOME/.claude/plugins/cache/arthurpower-local/arthurpower/0.12.1"
fi
SRC="${ARTHURPOWER_SRC:-$DEFAULT_SRC}"

SKILLS_DST="$REPO_ROOT/.cursor/skills"
AGENTS_DST="$REPO_ROOT/.cursor/agents"
VENDOR_DST="$REPO_ROOT/.cursor/vendor/arthurpower"

# Daily Cloud loop from using-agent-skills flowchart. Meta authoring and
# Claude-marketplace setup stay out of the vendor copy.
SKILLS=(
  using-agent-skills
  logicsync
  domain-modeling
  wayfinder
  spec-driven-development
  architecture-change-reviewer
  writing-plans
  test-driven-development
  input-contract-tests
  bounded-context-guardian
  complexity-anti-drift
  error-handling-enforcer
  systematic-debugging
  verification-before-completion
  code-review
  review-report-repair
  boundary-testing
  minimal-change-verifier
  dispatching-parallel-agents
  session-handoff
)

if [ ! -f "$SRC/.claude-plugin/plugin.json" ]; then
  echo "sync-arthurpower-cursor: missing plugin at $SRC" >&2
  echo "Set ARTHURPOWER_SRC to a checkout of arthurpower." >&2
  exit 1
fi

VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC/.claude-plugin/plugin.json")"

mkdir -p "$SKILLS_DST" "$AGENTS_DST" "$VENDOR_DST"

RSYNC_EXCLUDES=(
  --exclude 'iteration/'
  --exclude 'evals/'
  --exclude 'scripts/'
  --exclude '*:Zone.Identifier'
  --exclude 'Zone.Identifier'
)

# Post-impl auditors archived in plugin (TDD-agent, DCV-agent) are intentionally
# omitted — write-time discipline is skills only.
AGENTS=(
  architecture-change-reviewer-agent.md
  arthurpower-audit-agent.md
  boundary-testing-axis1-agent.md
  boundary-testing-axis2-agent.md
  bounded-context-guardian-agent.md
  complexity-anti-drift-agent.md
  error-handling-enforcer-agent.md
  minimal-change-verifier-agent.md
  spec-reviewer-agent.md
  standards-reviewer-agent.md
)

for agent in "${AGENTS[@]}"; do
  if [ ! -f "$SRC/agents/$agent" ]; then
    echo "sync-arthurpower-cursor: missing agent $agent" >&2
    exit 1
  fi
  rsync -a "$SRC/agents/$agent" "$AGENTS_DST/$agent"
done

# Drop agents no longer vendored (archived in plugin).
for stale in \
  defensive-contract-validator-agent.md \
  test-driven-development-agent.md
do
  rm -f "$AGENTS_DST/$stale"
done

for name in "${SKILLS[@]}"; do
  if [ ! -f "$SRC/skills/$name/SKILL.md" ]; then
    echo "sync-arthurpower-cursor: missing skill $name" >&2
    exit 1
  fi
  mkdir -p "$SKILLS_DST/$name"
  rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$SRC/skills/$name/" "$SKILLS_DST/$name/"
done

# Drop skills no longer vendored.
rm -rf "$SKILLS_DST/defensive-contract-validator"

find "$AGENTS_DST" "$SKILLS_DST" -name '*Zone.Identifier' -delete 2>/dev/null || true

printf '%s\n' "$VERSION" >"$VENDOR_DST/VERSION"

{
  printf '%s\n' "# vendor pin $VERSION"
  for name in "${SKILLS[@]}"; do
    printf '%s\n' "$name"
  done
} >"$VENDOR_DST/MANIFEST.txt"

echo "sync-arthurpower-cursor: pinned $VERSION from $SRC → .cursor/skills (${#SKILLS[@]} skills) + .cursor/agents (${#AGENTS[@]} agents)"
