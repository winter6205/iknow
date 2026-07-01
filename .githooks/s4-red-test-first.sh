#!/usr/bin/env bash
# S4 red-test-first check
# Works in two contexts:
#   - client:  Git commit-msg hook passes $1 (commit-msg file) and a staged diff exists
#   - CI:      GitHub Actions passes $1 (commit-msg file); no staging, uses HEAD diff
# Blocks feat:/fix: commits that introduce new functions but no test file.
set -e
MSG_FILE="$1"
[ -z "$MSG_FILE" ] && exit 0
MSG=$(cat "$MSG_FILE" 2>/dev/null || echo "")
[ -z "$MSG" ] && exit 0

# Only enforce on feat:/fix: commits
case "$MSG" in
  feat:*|fix:*) ;;
  *) exit 0 ;;
esac

# Detect context: client (staged) vs CI (committed, no staging)
if [ -n "$(git diff --cached 2>/dev/null)" ]; then
  STAGED=$(git diff --cached)
elif [ "$(git rev-list --count HEAD 2>/dev/null || echo 0)" -gt 1 ]; then
  STAGED=$(git diff HEAD~1 HEAD 2>/dev/null || echo "")
else
  # First commit in repo - use show with format stripped
  STAGED=$(git show HEAD --format= 2>/dev/null || echo "")
fi

HAS_NEW_FUNC=0
HAS_NEW_TEST=0
if echo "$STAGED" | grep -qE '^\+.*(def [A-Za-z_]|export function [A-Za-z_]|^function [A-Za-z_]|const [A-Za-z_][A-Za-z0-9_]* = (async |\()|fn [A-Za-z_])'; then
  HAS_NEW_FUNC=1
fi
if echo "$STAGED" | grep -qE '^\+.*(test_[A-Za-z_]|[A-Za-z_]+\.test\.[a-z]+|[A-Za-z_]+\.spec\.[a-z]+|[A-Za-z_]+_test\.[a-z]+)'; then
  HAS_NEW_TEST=1
fi
if [ "$HAS_NEW_FUNC" = "1" ] && [ "$HAS_NEW_TEST" = "0" ]; then
  echo "BLOCKED: S4 red-test-first - feat:/fix: commit 含新增函数但无对应 test 文件 (Kent Beck TDD)"
  exit 1
fi
exit 0
