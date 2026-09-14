# When to Use — Detail

## When to Use

Use for ANY technical issue:

- Test failures (any runner: pytest / vitest / playwright)
- Build failures (`pnpm build` / `make` / CI red)
- Behavior doesn't match expectations
- Unexpected exceptions / runtime errors
- Flaky tests (intermittent pass/fail)
- Hanging / timeout issues

**Trigger phrases (literal):** debug, 修个 bug, 出错了, 报错了, 失败了, 报错, 不工作, flaky, hanging, 修到一半

**Use this ESPECIALLY when:**

- Under time pressure (emergencies make guessing tempting)
- "Just one quick fix" seems obvious
- 3+ fix attempts already tried in the same session
- Previous fix didn't work
- Don't fully understand the issue

**Don't skip when:**

- Issue seems simple (simple bugs have root causes too)
- In a hurry (rushing guarantees rework)
- User wants it fixed NOW (systematic is faster than thrashing)

## When NOT to Use

Do not load this skill when:

- Design discussion or trade-off analysis — wrong skill (use `logicsync`)
- Trivial 1-line typo with the fix obviously visible (e.g. misspelled variable on the failing line, stack trace points directly at it)
- User explicitly said "skip debugging, just patch it"
- Clearly external infra failure (e.g. GitHub down, network outage) — verify, do not debug

## Related Skills

- `input-contract-tests` (S2) — for the failing test itself (5-class boundary tests)
- `minimal-change-verifier` (S6) — enforce fix scope = task scope
- `error-handling-enforcer` (S3) — proper try/except, no empty catches
- `verification-before-completion` — applies after Phase 4 FIX succeeds; the failing test must be observed green before claiming fix verified. Evidence before assertions.
- `dispatching-parallel-agents` — applies when systematic-debugging Phase 2 ISOLATE needs parallel subagent investigation (>= 2 independent hypotheses).
- `writing-plans` — applies when debugging reveals a multi-step fix requiring ordered task decomposition.
- `Grep` + `Glob` + `Read` 深度组合 — multi-hop impact + dead code during isolation (Phase 2)

## Cross-references

- [L1: end-to-end-test-mandatory] — verification standard for any fix claim
- [L1: debug-stop-4-phases] — 3 fix attempts failed triggers reload of this skill
- [L1: single-occurrence-not-pattern] — N>=3 reproductions required before generalizing
- [L1: no-impression-based-guessing] — debug first principle
- [L1: credential-safety] — never write secrets in plaintext
