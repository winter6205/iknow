---
name: test-driven-development
description: Use when implementing any logic, fixing any bug, or changing any behavior — write the failing test first, then minimal code to pass, then refactor. Use when proving code works, when a bug report arrives, or before modifying existing functionality.
bucket: engineering
---

# Test-Driven Development

## Overview

Write a failing test before writing the code that makes it pass. For bug fixes, reproduce the bug with a test before attempting a fix. Tests are proof — "seems right" is not done. A codebase with good tests is an AI agent's superpower; a codebase without tests is a liability.

## When to use

- Implementing any new logic or behavior
- Fixing any bug (the Prove-It Pattern)
- Modifying existing functionality
- Adding edge case handling
- Any change that could break existing behavior

**Related:** For browser-based changes, combine TDD with runtime verification using Chrome DevTools MCP — see [`references/browser-testing.md`](references/browser-testing.md).

## When not to use

- Pure configuration changes with no behavioral impact
- Documentation updates or static content changes
- Cosmetic reformatting with no logic change
- Throwaway exploratory spikes (return to TDD when code graduates to production)

## The TDD Cycle

```
    RED                GREEN              REFACTOR
 Write a test    Write minimal code    Clean up the
 that fails  ──→  to make it pass  ──→  implementation  ──→  (repeat)
      │                  │                    │
      ▼                  ▼                    ▼
   Test FAILS        Test PASSES         Tests still PASS
```

### Step 1: RED — Write a Failing Test

Write the test first. It must fail. A test that passes immediately proves nothing.

### Step 2: GREEN — Make It Pass

Write the minimum code to make the test pass. Don't over-engineer.

### Step 3: REFACTOR — Clean Up

With tests green, improve the code without changing behavior: extract shared logic, improve naming, remove duplication, optimize if necessary. Run tests after every refactor step to confirm nothing broke.

Full RED/GREEN code examples: [`references/tdd-cycle-examples.md`](references/tdd-cycle-examples.md).

## The Prove-It Pattern (Bug Fixes)

When a bug is reported, **do not start by trying to fix it.** Start by writing a test that reproduces it. Flow: write reproduction test → test FAILS (bug confirmed) → implement fix → test PASSES (fix proven) → run full suite (no regressions).

Full Prove-It code example: [`references/prove-it-example.md`](references/prove-it-example.md).

## The Test Pyramid

Most tests should be small and fast, with progressively fewer tests at higher levels. The pyramid shape: **Unit Tests (~80%)** at the base (pure logic, isolated, milliseconds), **Integration Tests (~15%)** in the middle (component interactions, API boundaries), **E2E Tests (~5%)** at the top (full user flows, real browser).

**The Beyonce Rule:** If you liked it, you should have put a test on it. Infrastructure changes, refactoring, and migrations are not responsible for catching your bugs — your tests are. If a change breaks your code and you didn't have a test for it, that's on you.

### Test Sizes (Resource Model)

| Size       | Constraints                                            | Speed        | Example                              |
| ---------- | ------------------------------------------------------ | ------------ | ------------------------------------ |
| **Small**  | Single process, no I/O, no network, no database        | Milliseconds | Pure function tests, data transforms |
| **Medium** | Multi-process OK, localhost only, no external services | Seconds      | API tests with test DB               |
| **Large**  | Multi-machine OK, external services allowed            | Minutes      | E2E tests, performance benchmarks    |

### Decision Guide

- Pure logic with no side effects → Unit test (small)
- Crosses a boundary (API, DB, FS) → Integration test (medium)
- Critical user flow that must work end-to-end → E2E test (large) — limit to critical paths

## Writing Good Tests

### Test State, Not Interactions

Assert on the _outcome_ of an operation, not on which methods were called internally. Tests that verify method call sequences break when you refactor, even if behavior is unchanged.

### DAMP Over DRY in Tests

In production code, DRY is usually right. In tests, **DAMP (Descriptive And Meaningful Phrases)** is better — each test reads like a specification, telling a complete story without shared helpers.

### Prefer Real Implementations Over Mocks

Order: real implementation (highest confidence) → fake (in-memory dep) → stub (canned data) → mock (verifies method calls, sparingly). Use mocks only when the real implementation is too slow, non-deterministic, or has uncontrollable side effects.

### Arrange-Act-Assert + One Concept + Descriptive Names

Structure each test as Arrange / Act / Assert. One behavior per test. Name reads like a spec: `"rejects empty titles"` beats `"validates titles correctly"`.

Full code examples: [`references/testing-patterns.md`](references/testing-patterns.md).

## Test Anti-Patterns to Avoid

| Anti-Pattern                          | Problem                                            | Fix                                                  |
| ------------------------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| Testing implementation details        | Tests break on refactor even if behavior unchanged | Test inputs and outputs                              |
| Flaky tests (timing, order-dependent) | Erode trust in the suite                           | Deterministic assertions, isolated state             |
| Testing framework code                | Wastes time                                        | Only test YOUR code                                  |
| Snapshot abuse                        | Large snapshots nobody reviews                     | Use sparingly, review every change                   |
| No test isolation                     | Pass alone, fail together                          | Each test sets up + tears down its own state         |
| Mocking everything                    | Tests pass but production breaks                   | Prefer real implementations; mock only at boundaries |

## Dispatch

本环节由 `arthurpower:test-driven-development-agent` 承接。识别到实现新逻辑 / 修 bug / 改行为前的 S4 Spec-as-Test 验证时机（测试先于实现、测试覆盖 spec 验收点、mock 不替代真实代码、重构保持既有测试通过）时，用 Agent 工具以 `subagent_type: "arthurpower:test-driven-development-agent"` 派发，而非在主线程自跑。派发时传：diff 范围 + 本 skill 判据 + 证据格式（file:line + PASS/FAIL）。软触发：应当派，非必须派；偶发主线程自跑属可接受降级，不视为违规。

## Procedure

1. **Identify the behavior to add or fix.** Write it as a single sentence: "After X input, the system does Y."
2. **Write the failing test first (RED).** The test must fail in the current code. If it passes immediately, the test proves nothing — rewrite until it fails.
3. **Run the test to confirm RED.** Capture the failure output. A passing test before you wrote implementation is a smell.
4. **Write minimal code to pass (GREEN).** No optimization, no extra features — only what makes the test pass.
5. **Run the test to confirm GREEN.** If it fails, fix the implementation, not the test (unless the test itself is wrong).
6. **Run the full suite.** No regressions allowed.
7. **Refactor with confidence.** Clean up names, extract helpers, remove duplication. Re-run tests after every change.
8. **For bug fixes: write the reproduction test first (Prove-It Pattern).** Do not attempt a fix without a failing test that demonstrates the bug.
9. **Commit only when green.** A red test in the commit means broken code shipped.

## Acceptance Criteria

- [ ] New behavior has a corresponding test written before implementation
- [ ] Test failed before implementation was added (RED phase captured)
- [ ] Test passes after minimal implementation (GREEN phase captured)
- [ ] Bug fixes include a reproduction test that failed before the fix
- [ ] Full test suite passes — no regressions
- [ ] Test names describe the behavior being verified, not implementation
- [ ] No tests skipped or disabled to make the suite pass
- [ ] Refactor step ran with all tests still green
- [ ] Test pyramid ratios respected (~80% small, ~15% medium, ~5% large)

## When to Use Subagents for Testing

For complex bug fixes, spawn a subagent to write the reproduction test without knowledge of the fix — the subagent has no bias toward the fix, making the test more robust. Main agent: spawn subagent with bug description → subagent writes failing reproduction test → main agent verifies RED, implements fix, verifies GREEN.

## Verification

```
Skill type: discipline
Bar level:  discipline
```

**Verification commands** (runnable):

- Validator: `python skills/skill-authoring/scripts/validate_skill.py skills/test-driven-development/SKILL.md` → exit 0
- Skill trigger sanity: ask "should I write a test first for this function?" → skill responds with RED→GREEN→REFACTOR
- Driver: `python evals/run_skill_eval.py evals/test-driven-development.json` (if defined) → ≥90% pass

## Red Flags

- Writing code without any corresponding tests
- Tests that pass on the first run (they may not be testing what you think)
- "All tests pass" but no tests were actually run
- Bug fixes without reproduction tests
- Tests that test framework behavior instead of application behavior
- Test names that don't describe the expected behavior
- Skipping tests to make the suite pass
- Running the same test command twice in a row without intervening code change
- "I'll add tests later" / "this is too simple to test" rationalizations

## Rationalization Table

| Rationalization                                    | Reality                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "I'll write tests after the code works"            | You won't. Tests written after test implementation, not behavior.                                         |
| "This is too simple to test"                       | Simple code gets complicated. The test documents the expected behavior.                                   |
| "Tests slow me down"                               | Tests slow you down now. They speed you up every change later.                                            |
| "I tested it manually"                             | Manual testing doesn't persist. Tomorrow's change might break with no way to know.                        |
| "The code is self-explanatory"                     | Tests ARE the specification. They document what code should do, not what it does.                         |
| "It's just a prototype"                            | Prototypes become production code. Tests from day one prevent test debt.                                  |
| "Let me run the tests again just to be extra sure" | After a clean run, repeating adds nothing unless code changed. Run again after edits, not as reassurance. |

## See Also

- [`references/browser-testing.md`](references/browser-testing.md) — DevTools MCP workflow
- [`references/testing-patterns.md`](references/testing-patterns.md) — Full code examples
- [`references/rationalizations.md`](references/rationalizations.md) — Extended rationalization playbook
