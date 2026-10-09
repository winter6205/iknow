# subagent-output-handoff — live A/B trajectory digest

**Status:** Live half RUN on the final tree (2026-10-09, `v3.2.7`, Node
v24.21.0, ~286 s; `npx vitest run --config vitest.real-llm.config.ts
real-llm/subagent-output-handoff.test.ts`). Outcome: **all three controls pass
on both arms (no tool-choice regression from the wording change); the two
report-producing cases (`incident-4`, `paged-report`) never produced their
premise and are RESIDUAL — not judged, never a hidden pass.** The retrieval A/B
therefore shows **no demonstrated gain**, and separately **no product defect**:
the `output_path`-stamps-end-to-end contract is proven by the offline
production-entry test (see _Live result — load-vs-defect verdict_). The manifest
table and fields below are that run's output; nothing above this line is a
result.

This digest is the tracked evidence area for the real-model A/B half of the
subagent-output-handoff golden set
(`real-llm/subagent-output-handoff.test.ts`, registered in `TRACKED_INCLUDE`).
The offline invariant half
(`tests/subagent/subagent-output-handoff.test.ts` + `.fixtures.ts`) already
locks the fixture shape and the encoded contract deterministically.

## Run plan — counts fixed before examining any result

| Case           | Tier            | Trials per arm | Hard gates (tool RESULTS / FS bytes only)                                                                                                                                                                                                                                                                                                                                    |
| -------------- | --------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `incident-4`   | Real trajectory | 3              | four completed `wait:true` receipts, each `truncated:true`; per receipt a `subagent_result` read with matching `task_id` + `tmp_path` equal to the receipt's relative `output_path`; the read (and the saved pad file) carries its own witness and no foreign witness; parent answer contains all 4 witnesses; no `read_image` / `read_file` / `grep` / pad-targeting `bash` |
| `status-only`  | Real trajectory | 1              | every `subagent_result` poll passes `task_id` only (`tmp_path` on any poll is a violation); no generic file-read route appears                                                                                                                                                                                                                                               |
| `wait-false`   | Real trajectory | 1              | launched with `wait:false`; no `tmp_path` read before the first observed completion on the dispatch trace (bare `run()` has no mailbox drain, so polls are the completion surface)                                                                                                                                                                                           |
| `image-input`  | Real trajectory | 1              | `read_image` on `scene.png` is selected; any `spawn_subagent` / `subagent_result` dispatch is a violation                                                                                                                                                                                                                                                                    |
| `paged-report` | Real trajectory | 1              | bounded raw-page chain via `offset`/`next_offset` from 0 to `eof`; concatenated pages reproduce the saved `final.md` bytes exactly; parent answer contains the tail witness                                                                                                                                                                                                  |

Premise breaks (worker did not restate verbatim, fewer than four completed
receipts, no `output_path` stamped, trajectory shape not produced) print
RESIDUAL and the trial is **not judged** — never silently converted to a pass.
No LLM judge participates at all; a judge could never override a hard failure
because there is nothing to override with.

## Arms — model-visible strings only

Both arms run the same post-T3/T4 build, the same fixture inputs, the same
tool inventory and order, and the same real worker path. Only these segments
differ. The bytes are quoted in one place only —
`tests/subagent/subagent-output-handoff.fixtures.ts`, named below — because an
inlined copy of model-visible text that itself contains backticks drifts and
collapses spaces when rendered, which is exactly the misquote this section had.

| Segment                                             |   arm-B constant (committed HEAD) | arm-A constant (pre-change)       |
| --------------------------------------------------- | --------------------------------: | --------------------------------- |
| `spawn_subagent` description tail                   |                `ARM_B_SPAWN_TAIL` | `ARM_A_SPAWN_TAIL`                |
| `spawn_subagent` `wait` field sentence              |             `ARM_B_WAIT_SENTENCE` | `ARM_A_WAIT_SENTENCE`             |
| coordinator parenthetical (surfaces that inject it) | `ARM_B_COORDINATOR_PARENTHETICAL` | `ARM_A_COORDINATOR_PARENTHETICAL` |

Semantically: arm-B names the retrieval action — `subagent_result` with the
receipt's `task_id` and the pad-relative `tmp_path` taken from the receipt's
`output_path` — while arm-A limits `subagent_result` to "an explicit status
query". The swap is exact-string (`armSwap`), so the two arms share every other
byte of presentation, and a live text that no longer carries the arm-B segment
throws as a premise break instead of measuring a fabricated arm.

## A/B seam (test-time only — no production flag)

The live production text is arm-B, so arm-A is **derived**, not hardcoded into
a parallel registry: the test wraps `deps.promptTools` (the existing
presentation seam the memory layer uses) so the `spawn_subagent` ToolDef
carries the arm's description and `wait`-field description via a targeted
substring swap (`armSwap`; a miss throws as a premise break rather than
measuring a fabricated arm), and wraps `deps.system` for the coordinator
parenthetical where a surface injects it (conditional no-op on this surface —
the default chat assembly carries the guidance in the tool description). The
executor, ajv validation, handlers, and every receipt come from the untouched
frozen production registry through `buildHarnessEngine` → real
`spawn_subagent` → real worker run → pad write → real `subagent_result`.
`task_id`s, `output_path`s, statuses, and report bodies are never fabricated,
and no production feature flag or env switch exists.

## Per-trial capture schema

Each trial prints scrubbed lines tagged `[<case>/arm-<A|B>/trial-<n>]`:

| Field                                         | Line / source                                                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| arm, case, trial #                            | tag prefix                                                                                                             |
| verdict (pass / fail / residual) + stopReason | `verdict=... stop=...`                                                                                                 |
| tool sequence + `task_id`/`tmp_path` args     | one line per dispatch: `<i> <name> wait=... / task=tN tmp_path=... offset=... kind=...`                                |
| tool-error type / reason                      | `TOOL-ERROR #i <name> <kind>: <first 140 chars>` for any non-`ok` result                                               |
| full-report witness retrieved?                | `fullReportWitnessRetrieved` (true/false; null where the case has no report read)                                      |
| parent answer contains witness?               | `parentAnswerContainsWitness` (same null rule)                                                                         |
| hard / residual strings                       | printed on fail (`BASELINE FAIL` for arm-A, which is recorded and never asserted as a pass; thrown `expect` for arm-B) |

Scrubbing: task ids become `t1..tN` labels, the trial workspace becomes
`<WS>`, the repo root becomes `<REPO>`; absolute pad paths and report bodies
stay in the local `.evals/real-llm/` scratch (gitignored) and never enter this
file. Raw local traces, if kept, live outside the tracked tree.

## Manifest — live run (2026-10-09)

Runner's verbatim manifest block:

```text
[manifest] fixed counts decided before results:
[manifest] incident-4: planned 3 trials/arm; recorded A=3 B=3
[manifest] status-only: planned 1 trials/arm; recorded A=1 B=1
[manifest] wait-false: planned 1 trials/arm; recorded A=1 B=1
[manifest] image-input: planned 1 trials/arm; recorded A=1 B=1
[manifest] paged-report: planned 1 trials/arm; recorded A=1 B=1
[manifest] incident-4 verdicts A=[residual,residual,residual] B=[residual,residual,residual]
[manifest] status-only verdicts A=[pass] B=[pass]
[manifest] wait-false verdicts A=[pass] B=[pass]
[manifest] image-input verdicts A=[pass] B=[pass]
[manifest] paged-report verdicts A=[residual] B=[residual]
[manifest] MANIFEST-INCOMPLETE: incident-4 arm-B not fully judged (3/3 recorded trial(s) not passed (residual, residual, residual)) — no "controls preserved" pass may be claimed for this case.
[manifest] MANIFEST-INCOMPLETE: paged-report arm-B not fully judged (1/1 recorded trial(s) not passed (residual)) — no "controls preserved" pass may be claimed for this case.
```

| Case         | arm-A pass | arm-A fail | arm-A residual | arm-B pass | arm-B fail | arm-B residual |
| ------------ | ---------- | ---------- | -------------- | ---------- | ---------- | -------------- |
| incident-4   | 0          | 0          | 3              | 0          | 0          | 3              |
| status-only  | 1          | 0          | 0              | 1          | 0          | 0              |
| wait-false   | 1          | 0          | 0              | 1          | 0          | 0              |
| image-input  | 1          | 0          | 0              | 1          | 0          | 0              |
| paged-report | 0          | 0          | 1              | 0          | 0          | 1              |

The runner exits 0 and vitest reports `Tests 11 passed (11)` even so: RESIDUAL
is a soft `return`, not a thrown assertion, so vitest-green is not a substantive
retrieval pass. The two `MANIFEST-INCOMPLETE` lines are the real gate.

**Gain rule:** `incident-4 arm-A all-pass?` — **no** (arm-A 0/3 pass, 3/3
residual). The all-pass branch that would read "reassess the wording change" did
not fire; instead neither arm produced the retrieval premise, so the A/B
retrieval comparison is **undecidable on live data — recorded as no demonstrated
gain**, and the substantive result is the negative control finding (no
regression).

**Counterpart guard:** it covers every arm-B case, not only `incident-4`. For
each of `incident-4` / `status-only` / `wait-false` / `image-input` /
`paged-report`, any recorded arm-B trial that is not a pass (residual or hard
failure) or any arm-B trial that was never recorded makes the runner print
`MANIFEST-INCOMPLETE: <case> arm-B not fully judged (...) — no "controls
preserved" pass may be claimed for this case.` A control case that never got
judged is undemonstrated, not satisfied. Field: `arm-B fully judged per case —
incident-4 / status-only / wait-false / image-input / paged-report: no / yes /
yes / yes / no.` Matches the two printed `MANIFEST-INCOMPLETE` lines exactly:
the three controls were fully judged as pass, the two report cases were not.

**Overall live outcome (2026-10-09):** **no demonstrated gain, and no product
defect.** The retrieval arms could not be judged because their premise (four
completed `wait:true` receipts, and one `output_path`-bearing completed receipt,
respectively) was never produced by the live workers; the controls passed on
both arms, which is the load-bearing negative result — the arm-B wording did not
regress tool selection. Recorded, not asserted as a pass.

## Live result — load-vs-defect verdict

The open question carried into the repair round was whether the live RESIDUAL
("no completed receipt with `output_path`") hid a real product bug the offline
mocks never exercised. It does not. The three independent live runs produced the
identical pattern (controls pass, report cases residual), and the offline
production-entry test closes the gap the mocks left:

`tests/subagent/worker-entry-output-path-stamping.test.ts` drives the real
`runSubagentWorker` entry (only the model is stubbed), captures its actual
stdout wire bytes, feeds them through the real `createSubAgentManager` dispatch
into a temp pad, and asserts the parent-visible completed-`ok` envelope carries
`output_path: "final.md"` whose pad holds the raw report byte-for-byte (no lone
surrogate), readable back through the model-visible `subagent_result` reader
across the `offset`/`next_offset` page chain to the tail witness. That is the
stamp contract, proven end to end.

So the live workers simply did not reach a completed-`ok` terminal envelope for
the report tasks (the trace shows `subagent_continue … no_transcript` failures —
workers that errored rather than finishing ok), and per the host-as-writer
invariant an envelope that is not a pad-writing `ok` receipt is _correctly_ not
stamped. Attribution: **live trajectory / worker outcome, not a product defect**
and not a fabricated arm.

Validation:

- Not run: a judged arm-B retrieval win. Expected command: the same live run.
  Blocking issue: the report-producing premise requires the real worker to finish
  `ok` within the trajectory; across three runs it did not, so the retrieval
  benefit is undemonstrated. Chasing a fourth live run would not change the
  premise outcome and is deliberately not done (full real-model runs are capped).

## Not-run semantics

Missing credentials print `[SKIP] LLM key not set; Not run` and skip the file;
that is reported as **Not run**, never as a pass (verified: with an isolated
`HOME` whose settings register a provider but leave its `apiKeyEnv` unset, the
run collects 11 tests, skips all, exits 0; a non-key config fault instead
propagates as a suite failure, per the load contract in
`real-llm/real-llm-env.ts`).
