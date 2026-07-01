#!/usr/bin/env bash
# scripts/update.sh — pull template evolution into this project (incremental, non-destructive)
# Usage: bash scripts/update.sh [--from <template-path>]
#
# Strategy:
#   - Default template source: sibling ../arthur-tpl/ or $ARTHUR_TEMPLATE env var
#   - Compare each template file with local copy via sha256
#   - If local missing → copy (new file)
#   - If local differs → skip with warning (user customized)
#   - If template unchanged → skip
#   - User can pass --force to overwrite customized files (dangerous)
#
# Always-protected files (never overwritten even with --force):
#   - .claude/settings.local.json (MCP perms, project-specific)
#   - CLAUDE.local.md (personal local layer)
#   - docs/CONTEXT.md (project-specific domain language)
#   - docs/handoff/*.md (project-specific session history)
set -euo pipefail

TEMPLATE="${ARTHUR_TEMPLATE:-}"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --from) TEMPLATE="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) echo "Usage: bash scripts/update.sh [--from <path>] [--force]"; exit 0 ;;
    *) echo "[update] unknown arg: $1" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Resolve template source
if [ -z "$TEMPLATE" ]; then
  # Try common locations
  for cand in "../arthur-tpl" "../../arthur-tpl" "$HOME/arthur-tpl"; do
    if [ -d "$cand" ] && [ -f "$cand/CLAUDE.md" ]; then
      TEMPLATE="$cand"
      break
    fi
  done
fi

if [ -z "$TEMPLATE" ] || [ ! -d "$TEMPLATE" ]; then
  echo "[update] ERROR: template source not found." >&2
  echo "[update] Set ARTHUR_TEMPLATE env var or pass --from <path>" >&2
  echo "[update] Example: ARTHUR_TEMPLATE=/e/提示词/规范化/项目文件原型/arthur-tpl bash scripts/update.sh" >&2
  exit 1
fi

echo "[update] template source: $TEMPLATE"

# Always-protected files
PROTECTED=(
  ".claude/settings.local.json"
  "CLAUDE.local.md"
  "docs/CONTEXT.md"
)
# Protect all handoff docs
while IFS= read -r f; do
  PROTECTED+=("$f")
done < <(find docs/handoff -type f -name "*.md" 2>/dev/null || true)

is_protected() {
  local target="$1"
  for p in "${PROTECTED[@]}"; do
    if [ "$target" = "$p" ]; then return 0; fi
  done
  return 1
}

ADDED=0; UPDATED=0; SKIPPED=0; PROTECTED_SKIP=0

# Get project root (where this script lives' parent.. = scripts/, parent = project root)
PROJECT_ROOT="$(pwd)"

# Files to consider (exclude .git, results, etc.)
cd "$TEMPLATE"
find . -type f \
  -not -path "./.git/*" \
  -not -path "./.evals/results/*" \
  -not -path "*/__pycache__/*" \
  -not -name "*.pyc" \
  -not -name ".DS_Store" \
  | while IFS= read -r relpath || [ -n "$relpath" ]; do
    # Strip leading "./"
    rel="${relpath#./}"
    target="$PROJECT_ROOT/$rel"
    target_dir="$(dirname "$target")"

    if is_protected "$rel"; then
      echo "[update] PROTECTED: $rel (skipped)"
      continue
    fi

    if [ ! -f "$target" ]; then
      mkdir -p "$target_dir"
      cp "$relpath" "$target"
      echo "[update] ADDED: $rel"
      continue
    fi

    SRC_HASH=$(sha256sum "$relpath" | cut -d' ' -f1)
    DST_HASH=$(sha256sum "$target" | cut -d' ' -f1)
    if [ "$SRC_HASH" = "$DST_HASH" ]; then
      echo "[update] SAME:   $rel"
      continue
    fi

    if [ "$FORCE" = "1" ]; then
      cp "$relpath" "$target"
      echo "[update] FORCE:  $rel (overwritten)"
    else
      echo "[update] DIFF:   $rel (local differs — skip, use --force to overwrite)"
    fi
done

cd "$PROJECT_ROOT"

# Bump local .template-version if exists in template (use realpath to handle self-copy)
if [ -f "$TEMPLATE/.template-version" ]; then
  TPL_VERSION="$(cd "$TEMPLATE" && pwd)/.template-version"
  if [ "$TPL_VERSION" != "$PROJECT_ROOT/.template-version" ]; then
    cp "$TEMPLATE/.template-version" .template-version
    echo "[update] bumped .template-version"
  fi
fi

echo ""
echo "[update] done. re-run bash scripts/bootstrap.sh to apply any new deps."