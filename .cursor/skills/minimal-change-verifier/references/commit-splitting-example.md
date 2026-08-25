# Commit Splitting Example (S6 — 1 commit = 1 logical task)

This example demonstrates the core discipline: one commit = one logical task (refactor + feat must split).

## Anti-pattern: 1 commit with refactor + feat (violates S6)

```bash
git log -1 --format=%B
# feat: add new API endpoint + refactor auth module
#
# - Add POST /api/users endpoint with validation
# - Refactor auth.py: extract JWT validation into jwt_validator.py (move + 5 file edits)
# - Update tests for new endpoint

git diff --stat HEAD~1
# auth.py                    | 120 +++++-----
# jwt_validator.py           | 200 ++++++++++++++++  (new file, moved from auth.py)
# jwt_utils.py               | 50 ++++--
# users.py                   | 80 ++++++ (new endpoint)
# tests/test_users.py        | 45 ++++
# 5 files changed, 495 insertions(+), 87 deletions(-)
```

Problem: 1 commit contains 2 independent logical tasks (refactor + feat).

- Change auth.py breaks → revert whole commit, lose feat changes
- Change feat breaks → revert whole commit, lose refactor changes
- blame / bisect difficult, 2 tasks' history mixed together

## Correct: 2 commits (refactor 1 commit + feat 1 commit, per 1 logical task)

```bash
git log -2 --format=%B
# commit abc123
# feat(api): add POST /api/users endpoint with validation
#
# - Add POST /api/users endpoint with validation
# - Update tests for new endpoint
#
# verified = pytest tests/test_users.py -v exit 0, curl returns 201
#
# commit def456
# refactor(auth): extract JWT validation into jwt_validator.py
#
# - Move JWT decode/verify/refresh logic from auth.py to jwt_validator.py
# - Update all imports across the codebase
# - All existing tests still pass (no behavior change)
#
# verified = pytest tests/ exit 0 (no test changes = no behavior change)

git diff --stat HEAD~1  # feat commit only
# users.py                   | 80 ++++++
# tests/test_users.py        | 45 ++++
# 2 files changed, 125 insertions(+), 0 deletions(-)

git diff --stat HEAD~2 HEAD~1  # refactor commit only
# auth.py                    | 120 +++++-----
# jwt_validator.py           | 200 ++++++++++++++++
# jwt_utils.py               | 50 ++++--
# 3 files changed, 250 insertions(+), 120 deletions(-)
```

The example above demonstrates the core discipline: 1 commit = 1 logical task. Anti-pattern: 1 commit containing refactor + feat, breaking one affects 2 independent tasks. Correct: 2 commits, refactor first (no behavior change, tests pass), feat after (new functionality). git bisect-friendly, revert isolated. Apply this pattern to any PR containing multiple independent tasks.
