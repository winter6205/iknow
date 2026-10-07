# PR #1220 repair verification and qualification boundary

## Basis and source identity

Basis: issue [#1219](https://github.com/winner6205build/iknow/issues/1219),
`plans/1220-fail-closed-finalize.md`, and the operator's request to delegate repairs
in a worktree until a separate evaluation issue can be opened.

Worktree: `/home/winner/iknow-wt-1220-finalize`.
Branch: `fix/1220-fail-closed-finalize`.
Reviewed base: `9640ca9b615e259ccef99efbd2eb71fbe6ca7b7a`.
Reviewed and tested code: `74d226f54b6a870e52147f03c3d9e81208a4389c`.
The delivery commit adds only this receipt and a runbook pointer to that code.

| Code area                         | Git tree identity                          |
| --------------------------------- | ------------------------------------------ |
| `scripts/eval/terminal-bench-2.1` | `f7d05414d301a1f3b4508c6d96dbbc234e617fba` |
| `scripts/eval/tui`                | `ddbd854297ce0657e93e7a6482d839bd31d2958e` |
| `tests/scripts/eval`              | `b263c1e7e64f6882c5d20b3dea85d7b592a01531` |

## Acceptance reconciliation

| In-scope outcome                                                                                                                                                            | Classification and evidence                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Observer faults halt TUI dispatch before input/Enter; later `markSent` cannot overwrite the fault                                                                           | Delivered. `run.ts` and `acceptance.ts`; real persisted-file and real-PTY RED/GREEN regressions, included in the final full suite.                                                                           |
| Torn readable ledger blocks dispatch, preserves known spend, and reports remaining usage unknown                                                                            | Delivered. `accounting.ts`; malformed-complete/trailing-partial, valid-prefix, completion-recovery, real-wired ceiling and report tests.                                                                     |
| Healthy PTY stop awaits child `waitpid` evidence and relay close; concurrent and global cleanup await the same operation                                                    | Delivered. `pty.ts` and two new real-process lifecycle tests. Confirmed transient zombie race reproduced before repair; no weakened liveness assertion or timeout increase.                                  |
| Bounded fallback when the relay is unresponsive, with typed incomplete-cleanup failure                                                                                      | Implemented, but failure-path verification is missing. Both independent review axes retain a Medium coverage finding. Follow-up remains in #1219; this receipt does not claim that branch is fully verified. |
| Existing versioned tools/runbook, actual-runner gate, durable attempt lifecycle/recovery/exclusive slots, full denominators/spend                                           | Delivered at baseline and exercised by the fresh full evaluation suite. No product, settings, dependency or lockfile changes.                                                                                |
| Explicit evidence failures; persisted first/follow-up/resume acknowledgement; state-based stop/forced-stop distinction; independent artifact counts and payload-only hashes | Delivered and covered by the full suite, including real PTY fixtures. Headless `expectedTraces: null` still yields `unknown-expectation` and fails `evidence-complete`; task reward is separate.             |
| Zero-model real PTY and fresh actual-path Docker smoke, owned-resource cleanup                                                                                              | Delivered within the coverage stated below. Gate-only rows are not graded/preflight passes.                                                                                                                  |
| Historical reconciliation without retrospective protocol compliance                                                                                                         | Preserved in `1219-historical-reconciliation.md`; #1212/#1213 evidence is not changed or pooled.                                                                                                             |
| Independent review and required local checks                                                                                                                                | Delivered with the residual Medium below. Exact new-commit CI and full repository `npm test` are not run.                                                                                                    |
| Separate frozen qualification issue before measured model execution                                                                                                         | Prepared after the local checks. Its exact source, task, protocol, budget and fresh output root are frozen in the issue; publication/CI and selected-task preflight remain dispatch gates.                   |

## Actual verification

| Command                                                                                                                                                                | Actual result and retained evidence                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run tests/scripts/eval`                                                                                                                                    | Exit 0, **33 files / 562 tests passed**, default parallel configuration. `/tmp/iknow1220-final-eval-suite-green.log`, SHA-256 `c96a2665437e097e8420b80b23ab8502dc5be2d5f5d8c6c1fa6e657148ac1d89`.                                                                                                                               |
| Normal production commit hook: lint-staged, `npm run lint:s5:staged`, `npm run typecheck`, `npm run test:changed`                                                      | Exit 0; 14 touched functions clean, production typecheck passed, changed tests **3 files / 27 tests passed**. `/tmp/iknow1220-pty-commit-green.log`, SHA-256 `811188dcbabe5d74338367b288b0af3339527ddd317c973319cbef6650747d9f`. Initial complexity-15 rejection was repaired by responsibility-based extraction, not bypassed. |
| `npx vitest run --no-file-parallelism tests/scripts/eval/tui/pty-shutdown.test.ts tests/scripts/eval/tui/pty-fixture.test.ts tests/scripts/eval/tui/pty-relay.test.ts` | Exit 0, **3 files / 18 tests passed** after the S5 refactor. `/tmp/iknow1220-final-pty-after-s5.log`.                                                                                                                                                                                                                           |
| `npm run typecheck:tests`                                                                                                                                              | Exit 2, **1,281 pre-existing diagnostics**, matching the reviewed baseline; none in `scripts/eval` or `tests/scripts/eval`. `/tmp/iknow1220-final-typecheck-tests.log`. Not a pass; repository-wide typing repair belongs to the other active workstream.                                                                       |

RED evidence is retained in `/tmp/iknow1220-tui-mark-sent-red.log`,
`/tmp/iknow1220-tui-pty-red.log`, `/tmp/iknow1220-red-tests.log`,
`/tmp/iknow1220-pty-shutdown-red.log`, and
`/tmp/iknow1220-pty-all-sessions-red.log`. Initial full-suite failure was
559/560 with a transient child PID still visible after premature relay killing
(`/tmp/iknow1220-final-eval-suite.log`). The final suite above follows the repair.

## Fresh Docker smoke, zero model dispatch

```bash
npx tsx scripts/eval/terminal-bench-2.1/smoke.ts \
  --dataset /home/winner/eval-1189/dataset \
  --bundle /home/winner/eval-1189/bundle/iknow-bundle-9fa88f57.tgz \
  --node-archive /home/winner/eval-1212/prov/node.tar.gz \
  --out /tmp/iknow1220-finalize-docker-smoke \
  --tasks db-wal-recovery,password-recovery,custom-memory-heap-crash \
  --grader-wall-sec 420 --grader-grace-sec 120
```

Exit 0; report `passed: true`, `modelDispatchCalls: 0`, `failures: []`.
Report: `/tmp/iknow1220-finalize-docker-smoke/smoke-report.json`, SHA-256
`d288fb0c980f6f8fb4d8a61087d2d3c386a0029cf21e6e69b5494e43ea154b43`.
Source sidecar: `/tmp/iknow1220-finalize-docker-smoke/provenance.json`.
Executed snapshot `8efd0a5843f33ea4dba1fcb1df513a56576934eb` has the exact
same headless source tree as the final reviewed code; later changes are PTY-only.

Coverage: **3 fully graded / 89 total; 86 gate-only; 0 probe failures**.
The three original graders retained CTRF and returned expected pristine-task
reward 0 (heap: 1 failed; WAL: 7 failed; password: 2 failed). This proves grader
execution and retained evidence, not capability success. Missing-log-mount,
stale-identity and corrupted-Node negatives were detected; the no-curl image path
passed. No owned containers leaked. Foreign containers
`tb21-db-wal-recovery-1449711` and `tb21-db-wal-recovery-1539228` were unchanged.
The new qualification task still needs its own actual-path preflight.

## Independent review and remaining limits

| Axis      | Exact overall verdict                | Remaining finding                                                                                                     |
| --------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Spec      | `OVERALL: 0 High / 1 Medium / 0 Low` | `tests/scripts/eval/tui/pty-shutdown.test.ts:37`: unresponsive-relay fallback / typed failure not directly exercised. |
| Standards | `OVERALL: 0 High / 1 Medium / 0 Low` | `scripts/eval/tui/pty.ts:280`, same failure-path coverage gap.                                                        |

Reports: `/tmp/iknow1220-final-spec-review.md` and
`/tmp/iknow1220-final-standards-review.md`. The axes remain independent; their
Medium findings concern the same gap. **GATE: PASS**, with that advisory tracked
in open #1219 before extending to long or adversarial process qualification.

Two earlier PTY fixture invocations timed out at 30 seconds in different cases.
Their failing artifacts had already been deleted, and the root cause remains
unknown. Logs: `/tmp/iknow1220-pty-combined-intermittent-timeout.log` and
`/tmp/iknow1220-pty-fixture-standalone-timeout.log`. A buffered-stdin hypothesis
was disproved by source inspection and five real burst-input probes. A retained
subsequent probe completed both cases but lost its overall exit capture, so it
is not counted as a whole-file pass. Forensics:
`/tmp/iknow1220-cleanup-forensics.md`. The fresh full-suite pass does not prove
these intermittent timeouts have been fixed.

Not run: full repository `npm test`, exact new-source remote CI, unresponsive
relay final-fallback failure-path test, selected qualification-task preflight,
or any measured model/long evaluation. No push, merge or release was performed.

**PASS = the operator's worktree repair and separate bounded qualification-issue
preparation, for the three reproduced defects and tested healthy cleanup paths,
supported by the commands above.** This is not a claim of complete #1219 closure,
all fallback paths verified, evidence completeness, or completion of #1212/#1213.
