# Error Handling — Verification

Reference companion to `SKILL.md`. Contains the grep commands and CI gates that mechanically prove no empty catch / null-return / generic throw / unjustified fallback survives a diff. Run these before claiming an error-handling change is complete.

---

## 1. Grep gates (run on diff only)

```bash
# 1a. Empty catch — any language
git diff --name-only | xargs grep -nE "catch ?\([^)]+\) ?\{\s*\}" 2>/dev/null
# expect: 0 new matches

# 1b. Null / -1 / empty-string return on failure path
git diff --name-only | xargs grep -nE "return (null|-1|''|\"\")" 2>/dev/null
# expect: 0 new matches

# 1c. Generic untagged throw
git diff --name-only | xargs grep -nE "throw new (Error|Exception)\\(" 2>/dev/null
# expect: every match has a typed class adjacent (within 5 lines above)

# 1d. Fallback branch without // EXIT: comment
git diff --name-only | xargs grep -nE "if .* (cached|stale|default|fallback)" 2>/dev/null
# expect: every match has "// EXIT:" on the line above (within 3 lines)
```

---

## 2. Structural review checklist

Before claiming the diff is done, manually confirm:

- [ ] Each `catch` either re-throws typed error, converts to `Result<T,E>`, or carries an explicit recovery doc-comment.
- [ ] Each function's failure-mode return is a typed exception or `Result`, never `null` / `-1` / `""` / magic code.
- [ ] Each fallback branch has a `// EXIT:` comment naming the exit condition (TTL, age, signal, feature flag, etc.).
- [ ] Each generic `throw new Error(...)` is replaced with a typed exception class.
- [ ] Functions where happy path and error path return at different points are split into separate handlers.
- [ ] All 5 boundary exception cases (empty / negative / oversized / concurrent / exception) have explicit assertions (cross-check with `defensive-contract-validator`).

---

## 3. CI gate (recommended)

Wire the grep gates into CI so they block merges:

```yaml
# .github/workflows/error-handling-gate.yml
name: error-handling-gate
on: [pull_request]
jobs:
  grep:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: empty-catch gate
        run: |
          matches=$(git diff --name-only origin/${{ github.base_ref }}...HEAD | xargs grep -nE "catch ?\([^)]+\) ?\{\s*\}" 2>/dev/null | wc -l)
          if [ "$matches" -gt 0 ]; then echo "FAIL: empty catch in diff"; exit 1; fi
      - name: null-return gate
        run: |
          matches=$(git diff --name-only origin/${{ github.base_ref }}...HEAD | xargs grep -nE "return (null|-1|''|\"\")" 2>/dev/null | wc -l)
          if [ "$matches" -gt 0 ]; then echo "FAIL: null/-1/empty return in diff"; exit 1; fi
      - name: generic-throw gate
        run: |
          matches=$(git diff --name-only origin/${{ github.base_ref }}...HEAD | xargs grep -nE "throw new (Error|Exception)\\(" 2>/dev/null | wc -l)
          if [ "$matches" -gt 0 ]; then echo "FAIL: generic untagged throw in diff"; exit 1; fi
```

---

## 4. Manual spot-check (1 sample per diff)

Pick one `try/catch` in the diff and answer out loud:

1. What failure mode does this catch represent?
2. Is the failure mode a typed exception class? (name it)
3. If it re-raises, what does the caller decide at that boundary?
4. If it has a fallback, what is the named exit condition?
5. If the answer to any is "I'm not sure" → the diff is not done.

---

## 5. Related verification skills

- `defensive-contract-validator` — boundary-case test coverage (empty / negative / oversized / concurrent / exception)
- `complexity-anti-drift` — keeps error-handling helpers small (≤60 lines soft review-trigger, ≤10 branches)
- `minimal-change-verifier` — confirms error-handling change does not smuggle refactor into a fix commit
