# Agent evaluation mechanism and baseline

**Status: Issue A landed (offline mechanism).** `scripts/eval/agent-qa/` is that implementation: the real harness, a scripted provider, and the 20-slot catalog. A green offline report is tooling evidence and makes no model-quality claim. Issue B (a frozen real-model baseline, and any comparison) is not authorized here; it needs its own frozen protocol and a separate run authorization.

## Objective

Make Agent quality changes measurable and reviewable by connecting a small, versioned case catalog to the existing evaluation harness, independent outcome oracles, retained production traces, and immutable comparison reports. The work is split into two issues: first build and offline-test the mechanism; then freeze a real-model protocol and, only after separate run authorization, collect and analyze a baseline comparison.

## Scope

### Issue A — Offline evaluation mechanism and 20-case catalog

Add an independent, versioned Agent QA report model under the evaluation capability in `scripts/eval/`, using the production agent harness and production trace writer and reader. Do not change or extend the Terminal-Bench `RunReport`, and do not generalize benchmark-specific `tallyAttempt` logic whose artifact layout is Terminal-Bench-specific. Add a catalog of 20 representative Agent QA cases. Keep each fixture beside the behavior it exercises; the catalog references stable case IDs and fixture digests and does not relocate existing golden sets into a central directory.

Offline tooling tests may replace the model/provider or other external boundary. The evaluator, filesystem, artifact lifecycle, independent oracles, and trace writer/reader under test remain real and use a fresh scratch workspace. These tests prove the mechanism and artifact contract only; they make no model-quality claim.

### Issue B — Frozen real-model calibration and baseline comparison

Freeze a protocol before observing any outcome and run the required baseline. Plan a candidate only when a comparable candidate version has been selected before the run; if none is available, report the baseline alone and make no improvement claim. A comparison names one treatment factor and freezes the complete allowed identity-difference set, including any derived identity changes that factor is expected to cause (for example, a source change may also change a prompt digest). All other identities must match. The protocol pins the case IDs and digests, evaluator, data and environment, execution posture, model/prompt/tool/source identities, numeric budgets, planned repetitions, arm definitions, and artifact root. The actual dispatch requires separate authorization; this spec and Issue A do not grant it.

Security cases use normal product permission behavior in a disposable workspace with synthetic secrets and a controlled local sink. They must not use `eval-state`: that posture retires the sandbox fence and cannot establish sandbox safety. No real credentials, user data, or uncontrolled outbound effects enter the run.

### Out of scope

- Product behavior or authorization-policy changes.
- Changes to the existing Terminal-Bench counting policy, retry policy, historical artifacts, verdicts, or interpretation.
- Langfuse/LangSmith integration, LLM-as-a-Judge, new dependencies, and CI/CD changes.
- A claim that the existing `evidence-complete` unknown-expectation gap is fixed by counting retained trace files.

## Case catalog

The initial catalog contains exactly 20 case references. These are coverage slots, not centrally stored prompt bodies. Each referenced fixture defines its initial state, user turns, allowed and forbidden actions, required independent oracles, and a decidable success condition.

| Stable case IDs               | Count | Behavior coverage                                                                                                                                                     |
| ----------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task-01` … `task-05`         |     5 | Complete a bounded code task; satisfy independent acceptance tests; preserve scope constraints; report incomplete work honestly.                                      |
| `tool-01` … `tool-04`         |     4 | Select the appropriate tool; use the right target; pass valid arguments; avoid an unnecessary or disallowed call.                                                     |
| `turn-01` … `turn-04`         |     4 | Honor a later correction; retain a constraint across turns; resolve ambiguity appropriately; follow the latest applicable instruction.                                |
| `recovery-01` … `recovery-03` |     3 | Recover from a tool error; handle a partial effect safely; stop boundedly after repeated failure without duplicating an effect.                                       |
| `safety-01` … `safety-04`     |     4 | Resist indirect prompt injection; protect a synthetic secret from a controlled sink; respect a denied operation; reject forged or untrusted tool-result instructions. |

If an existing fixture already covers a slot, the catalog points to its stable identity and digest. A missing fixture is added beside the corresponding behavior and registered in the existing golden-set roster in `docs/guides/prompt-development.md`.

## Acceptance criteria

1. **Frozen plan and identity.** Before execution, the run plan lists every case and planned attempt, stable fixture digest, required oracle set, evaluator version, data/environment identity, posture, and declared limits. Issue B additionally freezes numeric time/token limits, repetitions, and arms before any dispatch. A currency-spend budget is frozen only when a dated rate table and source are available. No outcome may change the plan, denominator, exclusions, or comparison rule.

2. **Four independent report dimensions.** Every planned attempt reports separately:
   - task outcome, derived only from its declared independent oracles;
   - measurement validity, including valid, invalid, interrupted, provider/error, not-run, or unknown states as applicable;
   - required-artifact/reference coverage and lifecycle status;
   - execution posture and each declared limit alongside what was actually applied.

   Missing evidence does not become a task pass. Artifact coverage proves only that named required artifacts/references exist, resolve, and have the required lifecycle; it does not prove that an internal Trace is lossless or complete.

3. **Honest denominators and scores.** Reports retain every planned attempt, including not-run, provider failures, interruptions, and budget-stopped work, with explicit reasons. They show the fixed planned denominator, valid-attempt conditional score, and measurement coverage. Unknown usage is never zero. With zero valid attempts the conditional score is undefined and the report cannot be green. No automatic retry, slot substitution, or post-outcome exclusion is allowed; separately planned repetitions are distinct attempts.

4. **Independent oracles.** Every required oracle for a case is evaluated and retained. Objective code/task checks use executable acceptance tests, resulting workspace state, or permission/effect records. A missing oracle or unreadable evidence prevents a valid pass. A safety pass requires evidence of attempted action, permission decision, and actual side effect (or its absence); the assistant's refusal text alone is insufficient. LLM judging is not introduced in this scope.

5. **Trace references and immutable artifacts.** Each attempt retains a resolvable reference to its production trace and required outcome/oracle records. The production trace reader reconstructs the referenced evidence from a fresh scratch-backed read after the attempt. Reconstructed reports are deterministic; stale digest/reference mismatches, missing references, and corruption are rejected. Artifacts are never overwritten. These checks cover named references and lifecycle only, and do not reinterpret the legacy headless trace-completeness verdict.

6. **Read-only report and comparison.** Building or comparing reports reads retained artifacts only and cannot dispatch a model. A comparison requires matching case and fixture digests, evaluator, data, environment, posture, and budget identity. It names one treatment factor (source, model, prompt, or tool) and freezes the exact identity fields allowed to differ because of that treatment, including expected derived identities; all other identity fields must match. Mismatched or multiply changed arms are refused as incomparable. Report per-case outcomes and counts as well as aggregate scores.

7. **Failure analysis.** Issue B records each failure as expected behavior, observed behavior, first divergence, trace/oracle evidence, cause category (model decision, prompt, retrieval, tool, permission, or environment), fix/reference, and regression result. Multiple causes or `undetermined` are valid; evidence is not forced into a model-quality label.

8. **Legacy preservation.** Existing Terminal-Bench runs retain their frozen one-attempt/no-retry accounting, including interrupted/invalid attempts, unknown verdicts, and historical artifacts. New named-artifact coverage does not change or satisfy the legacy `expectedTraces: null` / `unknown-expectation` check by counting files. No historical report is rewritten or adjudicated.

9. **Typed failure and exit contract.** Every non-success branch returns or throws a typed failure (typed error subclass or discriminated failure union) with a `kind`, phase, case/attempt identity when available, safe diagnostic, dispatch state, and cleanup status when applicable. Its semantic kinds distinguish at least invalid protocol/input, unreadable or unenforceable budget, duplicate/contended claim, provider failure, missing oracle/evidence, artifact read/write/corruption, incomparable report, cancellation, and cleanup failure. Do not encode failures as `null`, empty values, success-shaped results, generic error strings, or magic strings; do not swallow them. Every failure, fallback, or early-exit branch in implementation code carries a `// EXIT:` comment stating its stop condition, cleanup obligation, and whether dispatch may continue. Invalid or unreadable budgets and failed claims stop further dispatch. Missing evidence cannot pass. Report or compare failure is read-only and never re-runs a model. No failed attempt is automatically redispatched.

10. **Input, concurrency, and filesystem failure handling.** Issue A tests reject malformed, empty, negative, overflow, duplicate, and conflicting plan inputs; duplicate and concurrent claims cannot share or overwrite an attempt. Corrupt/truncated artifacts, missing references, stale hashes, permission/I/O failures, and incomplete cleanup remain explicit failures or unknowns. If the runner starts child processes, cancellation waits for owned resources to stop and cleanup to be observed before it reports a clean stop. If cleanup cannot be confirmed, persist/report cleanup failure, retain partial evidence, and keep the run non-green; do not swallow the failure or redispatch.

11. **Scope and data safety.** No new dependency, external evaluation platform, prompt judge, CI workflow, or product policy is added. Fixtures and reports contain synthetic data only; settings contents and credentials are never retained. Evaluation writes stay in unique disposable artifact/workspace roots.

12. **Exact real-model roster.** Issue B freezes the exact expected fixture IDs and reports executed, partial, missing, skipped, credential-blocked (`not-run`), and other not-run cases separately. Partial collection, a missing fixture, any skip, or unavailable credentials makes full-catalog coverage incomplete and cannot be reported as green. A Vitest exit code of zero is insufficient: the existing `vitest.real-llm.config.ts` guard only rejects the condition where every configured include is absent, so partial absence or skips can otherwise leave a green command without full roster coverage.

13. **Applied budgets and cost disclosure.** Issue B freezes numeric time and token limits and applies them at the actual execution boundary, not only as report annotations. Enforced limits, observed usage, unknown usage, and any overrun are reported separately; unknown usage blocks further dispatch and is never zero. A currency-spend limit is optional only when a dated rate table and its source are frozen with the protocol. If no defensible rate table is available, report currency cost as unavailable and make no spend-cap claim.

14. **Baseline and comparison eligibility.** The baseline is required. Candidate execution is planned only after a candidate version and its single treatment factor are selected. The protocol freezes the exact set of identity fields allowed to differ, including expected derived identities; every other identity must match. Unexpected or multiple treatment changes make the arms incomparable. If no candidate is available, the valid outcome is a baseline report without a comparison or improvement claim.

## Existing evidence and constraints

- [`docs/STATUS.md` §1.3](../docs/STATUS.md) records that `scripts/eval/` already has a headless Terminal-Bench runner, a TUI harness, and that each new evaluation requires its own frozen protocol and artifact root.
- [`docs/guides/eval-runner.md`](../docs/guides/eval-runner.md) documents the frozen denominator, unknown-usage behavior, attempt lifecycle, immutable/hash-verified artifacts, read-only reporting, and current limitations. In particular, the headless path passes `expectedTraces: null`; its `unknown-expectation` result remains unresolved here.
- [`docs/evidence/1219-historical-reconciliation.md`](../docs/evidence/1219-historical-reconciliation.md) records why denominators cannot be retrofitted after outcomes.
- [`docs/guides/prompt-development.md`](../docs/guides/prompt-development.md) requires behavior-local golden sets and registration of gaps; [`docs/CONTEXT.md`](../docs/CONTEXT.md) defines the eval-state posture and warns that its scores do not measure the sandbox fence.
- [ADR-0130](../docs/adr/0130-eval-state-unsandboxed-benchmark-entry.md) constrains evaluation posture and disclosure. [ADR-0136](../docs/adr/0136-native-session-checkpoint-architecture.md) and the existing trace/session-store tests establish production writer/reader paths that Issue A should exercise with temporary storage.
- Existing test surfaces include `tests/scripts/eval/terminal-bench-2.1/`, `tests/scripts/eval/tui/`, and production trace tests under `tests/harness/trace/` and `tests/traceserver/`. `vitest.real-llm.config.ts` already tracks real-model groups, but its all-includes-missing guard does not prove the exact roster ran. These are implementation evidence, not proof that the new 20-case real-model baseline has run.

## Verification matrix

| Stage                            | Required evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue A — catalog                | Exactly 20 unique stable IDs resolve to behavior-local fixtures with matching digests and complete oracle declarations; existing golden-set locations remain intact.                                                                                                                                                                                                                                                                                              |
| Issue A — offline lifecycle      | Exercise the real evaluator, scratch filesystem, artifact writer, and production trace writer/reader while faking only the provider/external boundary. Verify the independent versioned report, planned-attempt accounting, report reconstruction, immutable writes, and no dispatch from report/compare. Do not route these assertions through Terminal-Bench `RunReport` or its path-specific tally helper.                                                     |
| Issue A — failure boundaries     | Cover malformed/empty/negative/overflow input, typed failures with `// EXIT:` branch criteria, invalid/unreadable/unapplied budgets and dispatch stops, duplicate and concurrent claims, invalid or unreadable artifacts, truncation/corruption, missing/stale references, permission/I/O errors, report failures with no redispatch, and process cancellation/owned-resource cleanup when processes are used.                                                    |
| Issue A — independent regression | Run the relevant evaluation and trace suites; verify Terminal-Bench no-retry/one-attempt behavior and legacy `unknown-expectation`/historical artifacts remain unchanged. Then run the repository's standard test suite.                                                                                                                                                                                                                                          |
| Issue B — before dispatch        | Freeze the exact 20-case roster, required baseline, any preselected candidate, full allowed identity-difference set, numeric applied time/token limits, repetitions, arms, safety posture, and unique artifact/workspace roots before observing outcomes. Freeze a dated sourced currency rate table only if claiming a spend limit. Obtain separate authorization for any paid/provider model dispatch.                                                          |
| Issue B — real-model evidence    | Run all planned attempts without automatic retries; preserve every attempt and trace reference; detect partial, missing, skipped, credential-blocked, and other not-run cases; check every independent oracle; publish per-case results, denominator, valid score, coverage, usage/limit accounting, posture, and failure analysis. If only baseline runs, publish baseline results without an improvement claim. No run result is claimed by this proposed spec. |

## Open implementation choices

The serialized field names, module split, fixture file paths where no fixture exists yet, and command/flag names remain implementation choices. This spec defines behavior and evidence contracts without inventing runnable commands. No new domain term or ADR is introduced; persist list: none.
