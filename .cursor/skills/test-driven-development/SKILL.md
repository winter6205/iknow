---
name: test-driven-development
description: Use when implementing logic, fixing a bug, or changing behavior — write the failing test first (RED), then minimal code (GREEN), then refactor. Triggers on "write the failing test first", "Prove-It", or a bug that needs a reproduction test before the fix.
bucket: engineering
type: discipline
---

# Test-Driven Development

Write-time discipline: a failing test before the code that makes it pass. "Seems right" is not done.

## When to use

- New logic or behavior
- Bug fix (Prove-It: reproduction test before the fix)
- Behavior change that could regress

Skip: pure config/docs/formatting; throwaway spikes (return when code graduates).

Browser + runtime checks: [`references/browser-testing.md`](references/browser-testing.md).

## Cycle

```
RED (failing test) → GREEN (minimal code) → REFACTOR (tests stay green)
```

Bug path (Prove-It): reproduction test FAILS → fix → PASSES → full suite.

Examples: [`references/tdd-cycle-examples.md`](references/tdd-cycle-examples.md), [`references/prove-it-example.md`](references/prove-it-example.md).
Pyramid / writing style / anti-patterns: [`references/test-shape.md`](references/test-shape.md).

## Procedure

1. **Name the behavior.** One sentence: "After X, the system does Y." Completion: that sentence exists.
2. **RED — write the failing test.** It must fail on current code. Completion: failure output captured.
3. **GREEN — minimal code to pass.** No extras. Completion: the new test passes.
4. **Full suite.** Completion: suite green; no new skips.
5. **REFACTOR.** Cleanup only; re-run after each edit. Completion: suite still green.
6. **Commit only when green.** Completion: no red tests in the landing diff.

Complex bug, unbiased repro: spawn a writer that sees the bug description **not** the fix; verify RED yourself, then GREEN. Do not hard-wire a host-local persona path.

## Acceptance Criteria

- [ ] Test for the new behavior existed before implementation (RED captured)
- [ ] Minimal implementation made that test pass (GREEN captured)
- [ ] Bug fixes include a reproduction test that failed before the fix
- [ ] Full suite green; no skips added to force green
- [ ] Test names describe behavior, not implementation

## Rationalization Table

| Excuse                 | Reality                                          |
| ---------------------- | ------------------------------------------------ |
| "Tests after it works" | Post-hoc tests lock implementation, not behavior |
| "Too simple to test"   | Simple code grows; the test is the spec          |
| "I tested it manually" | Manual does not persist across tomorrow's change |
| "Just a prototype"     | Prototypes ship; debt starts on day one          |

Extended playbook: [`references/rationalizations.md`](references/rationalizations.md).

## Red Flags

- Code with no corresponding test
- Test passes on first run (may prove nothing)
- "All tests pass" without running them
- Bug fix without reproduction test
- Skipping tests to go green

## Verification

```
Skill type: discipline
Bar level:  discipline
```

## See Also

- [`references/test-shape.md`](references/test-shape.md) — pyramid, patterns, anti-patterns
- [`references/testing-patterns.md`](references/testing-patterns.md) — code examples
- [`references/spec-as-test.md`](references/spec-as-test.md) — S4 criteria
- [`references/testing-standards.md`](references/testing-standards.md) — path conventions
