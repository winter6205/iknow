# Evaluation harness failure containment

Basis: issue #1219 and the review of PR #1220 at
`9640ca9b615e259ccef99efbd2eb71fbe6ca7b7a` (one High, one Medium).

## Repair units

1. A failed TUI observer must stop delivery before any stimulus write. The
   acceptance ledger must retain its observer-error state on repeated submission.
2. A readable ledger containing malformed or partial rows cannot establish complete
   usage. Preserve known spend, report unknown usage, and refuse further dispatch.

## Expected scope

- `scripts/eval/tui/run.ts`
- `scripts/eval/tui/acceptance.ts`
- `scripts/eval/terminal-bench-2.1/accounting.ts`
- `tests/scripts/eval/tui/acceptance.test.ts`
- `tests/scripts/eval/tui/pty-fixture.test.ts`
- `tests/scripts/eval/terminal-bench-2.1/ledger-unreadable.test.ts`
- `tests/scripts/eval/terminal-bench-2.1/report-ceiling-unreadable.test.ts`
- This plan and a verification receipt under `docs/evidence/`.

No product behavior, settings, dependencies, historical payloads, or lockfiles change.

## Architecture gate

bounded-context-guardian: yes — repairs remain in the two existing harness capabilities.
input-contract-tests: yes — cover empty/missing, malformed, partial, repeated/concurrent
reads, and filesystem exceptions; numeric negative/overflow semantics are unchanged.
error-handling-enforcer: yes — retain typed error states and diagnostics and halt before
delivery or dispatch when observation is incomplete.
complexity-anti-drift: yes — localized guards and focused regressions, no new orchestrator.
minimal-change-verifier: yes — one evaluation-integrity repair, with no unrelated changes.

The independent pre-implementation review approved all five dimensions.

## Verification and handoff

Capture RED before implementation, then GREEN with real temporary files and a real
PTY fixture. Run the complete evaluation-tooling suite, typecheck, formatting and
changed-file complexity checks, then independent Standards and Spec reviews. Preserve
normal ENOENT pending behavior and valid ledger budget behavior.

Check the issue #1219 acceptance matrix and record fresh no-model Docker smoke evidence
if existing evidence cannot be bound to the reviewed runner. After verification and a
local commit, open a separate evaluation issue with source/tooling/artifact identities,
task and stimulus lists, delivery and stop rules, counting policy, budgets and fresh
output roots frozen before any model run. Creating that issue does not launch a run.

No push or merge is authorized in this session.

## Cleanup extension discovered during full verification

The first full evaluation suite at `8efd0a584` passed 559 of 560 tests. The
new real-PTY observer-fault case correctly sent no input but reported a transient
owned child as stray. Read-only process telemetry showed the relay was killed
before it could `waitpid` its child: the zombie became an orphan before disappearing.

Extend the repair within the same TUI capability:

- Change `scripts/eval/tui/pty.ts` shutdown ordering. Ask the relay to stop and
  retain it until it reports child exit and closes; await that completion before
  returning from `dispose()` or `killGroup()`.
- Use a bounded fallback that kills the child group first and the relay last.
  Report a typed cleanup failure if owned resources remain.
- Repeated or concurrent cleanup calls await the same completion.
- Add real-process lifecycle regressions in
  `tests/scripts/eval/tui/pty-shutdown.test.ts`; retain the strong no-stray-process
  assertion in the existing fault-before-Enter fixture.
- Keep the existing Python EOF/KILL reaper and public interfaces unchanged.

Independent extension gate:

bounded-context-guardian: yes — shutdown and tests remain in the TUI harness.
input-contract-tests: yes — concurrent/repeated, hung/interrupted and exception
cases apply; no public numeric input changes.
error-handling-enforcer: yes — typed cleanup failure and explicit EXIT conditions.
complexity-anti-drift: yes — focused bounded cleanup helpers, no new orchestrator.
minimal-change-verifier: yes — owned-process reaping is part of evaluation integrity.

Capture a deterministic pre-fix lifecycle failure, then rerun the lifecycle tests,
the real-PTY fixture, the full evaluation suite and independent review on the
extended repair. The headless Docker code is unchanged by this extension.
