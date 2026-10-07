# Issue #1219 — Historical reconciliation note for #1212 and #1213

- **Date:** 2026-10-07
- **Written for:** GitHub issue #1219 §4 ("reconciliation note for the old discrepancies") and its acceptance criterion "Historical discrepancies reconciled transparently; no retrospective protocol-compliance claim."
- **Scope:** the #1212 counting-pilot / 40-vs-80-arms artifacts and the #1213 TUI long-horizon artifacts only. #1212 and #1213 evidence are kept strictly separate here (§2, §7).
- **Inputs:** raw artifacts under `/home/winner/eval-1212/` and `/home/winner/eval-1213/` (unmodified, retained in place); the #1212 documents in worktree `/home/winner/iknow-wt-1212-pilot` @ `5ab3415df`; the #1213 documents at commit `fc67b1764`.
- **Status of this note:** annotation, not adjudication.

## Scope, privacy and method limits

This note quotes **paths, digests, sizes, counts and dispositions only**. It contains no API keys, no settings contents, no grader output blobs, no CTRF payloads, no session JSONL content and no message bodies. Where a historical claim turns on the text of a row or an event field, that single field is cited by name and value; where a claim would require a payload, this note records that the payload is not available in the bundle instead of reproducing it.

Every number below was re-measured from the retained artifacts while writing this note. The exact command for each number is given in [Appendix A](#appendix-a--reproduction-commands). Where a number in the #1219 issue body disagrees with what the artifacts show, the disagreement is recorded in the text and in the discrepancy register; the measured value is never silently substituted for the issue's wording.

**No verdict is rendered here.** This note does not declare any historical run compliant or non-compliant. It records which _sentences_ in the historical documents are supported, contradicted, or unsupported by the artifacts those runs retained. A run's overall verdict is a separate judgment that this note deliberately does not make, and that no future document should make retroactively.

Versioned successors of the historical scripts are landing under `scripts/eval/terminal-bench-2.1/` and `scripts/eval/tui/`, with regression coverage under `tests/scripts/eval/`, in the same PR as this note. The historical scripts, run directories and evidence bundles referenced below are preserved unmodified; nothing here edits them.

## How to read the status column

| Status         | Meaning                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `SUPPORTED`    | The retained artifacts contain the evidence the sentence asserts.                                              |
| `CONTRADICTED` | The retained artifacts contain evidence that cannot be reconciled with the sentence.                           |
| `UNSUPPORTED`  | The bundle contains no evidence either way; the sentence is not derivable from what was retained.              |
| `RECORDED`     | A deviation the historical reports already declare themselves. No conflict is asserted.                        |
| `UNRESOLVED`   | The artifacts support two readings, or the source of a figure could not be established. Recorded, not decided. |

`CONTRADICTED` describes the relation between one sentence and the artifacts. It is not a finding about the run, the harness, or the model.

## 1. Where the evidence lives

A reader of this note cannot assume any of the cited evidence is present in the repository. It is not:

- `git ls-tree -r --name-only master -- docs/evidence/` matches **no** `1212-*` or `1213-*` file.
- `git branch -a --contains 5ab3415df` → only `eval/1212-pilot`.
- `git branch -a --contains fc67b1764` → only `docs/1213-tui-stability-report`.
- The #1212 documents are readable in worktree `/home/winner/iknow-wt-1212-pilot` @ `5ab3415df`.
- The #1213 worktree `/home/winner/iknow-wt-1213-report` is **registered** in `git worktree list` at `fc67b1764` but its directory is **absent from disk**. Read those files with `git show fc67b1764:docs/evidence/<file>` from `/home/winner/projects/iknow`.
- Raw bundles live outside the repository at `/home/winner/eval-1212/` and `/home/winner/eval-1213/` and stay there.

Citations in §2–§6 use #1212 paths; §7–§13 use #1213 paths. The two bundles are independent and neither is used to corroborate the other.

## 2. Discrepancy register

| #   | Claim                                                                                               | Artifact evidence                                                                                                                                                       | Status         |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| D1  | #1212 run 2 "≈165k input / ≈74k output" represents the run's token cost                             | `runs-aborted/run2-missing-logs-mount/ledger.tsv` totals 165,148 in / 74,035 out over 3 rows; a 4th retained trace holds 13,022 in / 12,639 out (§3)                    | `CONTRADICTED` |
| D2  | #1212 amendment A3: attempt `=1` of the aborted run 1 "is excluded from the T6 denominators"        | Manifest `:231-232` declares an interrupted or infrastructure-failed attempt is **still attempted** (§4)                                                                | `CONTRADICTED` |
| D3  | #1212 amendment A4: "harness-fault-invalid: none of its attempts enter the T6 denominator"          | Run 2's three attempts are all `INVALID:ctrf` with a real grader result line — infrastructure-failed in the manifest's own vocabulary                                   | `CONTRADICTED` |
| D4  | A run disposition may drop all of its attempts from the denominator                                 | Same as D2/D3; the frozen rule places exclusions **in** the denominator (`:236-237`)                                                                                    | `CONTRADICTED` |
| D5  | `db-wal-recovery` is scored as a model-attempted, valid success                                     | Pilot ledger row 2 carries `preflight_verdict=EXCLUDE:oracle-or-grader` **and** `validity_1167=VALID`, `reward=1` (§5)                                                  | `CONTRADICTED` |
| D6  | `db-wal-recovery`'s preflight record reflects its final oracle state                                | `preflight/db-wal-recovery/preflight.env:9-13` is a stale `EXCLUDE` record; the driver reads first-existing, so `preflight-retry1/` is never consulted (§5)             | `CONTRADICTED` |
| D7  | #1212 study report: "The pilot's arm40 column is therefore reproduced"                              | Pilot row 6 `bn-fit-modify` = reward 1; arms pair 6 slot 1 `arm40` = reward 0, `maxTurns` (§6)                                                                          | `CONTRADICTED` |
| D8  | #1213: "78 RSS samples" (report `:84`, `:126`, `:131`; verdict comment `:3`)                        | `artifacts/run3/rss.csv` has **66** data rows; `driver-summary.json` `rss[]` length 66; journal 55 + 11 = 66 (§7)                                                       | `CONTRADICTED` |
| D9  | #1213: `driver-summary.json` `"stimuli_sent": 4, "stimuli_total": 4` means 4 stimuli were delivered | Journal records `submission_verified` **2** and `submission_failed` **2** (§9)                                                                                          | `UNSUPPORTED`  |
| D10 | #1213: S4 `submission_verified` at t_rel 1818.400                                                   | S4's payload appears in **no** store file; the run3 window holds no `boundary:"input"` state beyond `e0` (§9)                                                           | `CONTRADICTED` |
| D11 | #1213: "one long real-model TUI session survived … 74 agent turns" (report `:6`, verdict `:3`)      | Run3 window (lines 0-744) holds 88 assistant messages and 88 `native_state` records; no counting definition was pinned (§12)                                            | `UNSUPPORTED`  |
| D12 | #1213: the frozen stop rule governs the observed run's termination                                  | Journal has no `/quit` event; `exit_status.code=143` with `signaled:false`, `signal:null`; run3 window has zero `boundary:"terminal"` (§8)                              | `CONTRADICTED` |
| D13 | #1213 evidence index is a complete, self-consistent manifest                                        | Self-entry at `:3` records a digest/size that does not match the file itself; `stimulus.json` is outside every hashed root (§10)                                        | `CONTRADICTED` |
| D14 | #1213: resume1 restored context (report §6)                                                         | Session store gained `message e297`, `boundary:"input"` anchor `e297` and `boundary:"terminal"` anchor `e299` — but the journal has **0** verified / **0** failed (§11) | `SUPPORTED`    |
| D15 | #1213: driver substitution from `mcp__terminalcp__terminalcp` to a `pty.fork` script                | Report `:28-34`, `freeze-comment.md:5-11` — declared by the report itself                                                                                               | `RECORDED`     |
| D16 | #1212 arms gated on a new `wiring-check.sh` inside the driver, not standing preflight               | `1212-pilot-report.md:141-145` — declared by the report itself                                                                                                          | `RECORDED`     |
| D17 | Stop-reason labels are comparable across runs (`no-envelope` vs `completed-no-envelope`)            | Both labels appear in `1212-pilot-report.md:150-152`; the two ledgers use different vocabularies for the same condition                                                 | `RECORDED`     |
| D18 | #1213 runs 1 and 2 constitute distinct retained evidence                                            | `diff -r artifacts/run1 artifacts/run1-aborted-enter-not-submitted` → identical; same for `run2` (§10)                                                                  | `CONTRADICTED` |
| D19 | #1213 first stimulus was sent at the frozen t+0 s                                                   | Journal `stimulus_due` carries `"at": 0` with `t_rel: 20.226`, `enter_sent` 22.139 (§12)                                                                                | `CONTRADICTED` |
| D20 | #1212 A3/A4 were "recorded in an issue comment after the counting pilot"                            | Commit times `ca7beb596` 19:41:27 and `8a6bb15c9` 20:45:54 both precede pilot attempt 1 at 20:57:26 (§13) — the two statements are recorded side by side                | `UNRESOLVED`   |
| D21 | #1213 report §2 quotes the composer's mid-turn notice                                               | Report `:52` reproduces `src/tui/app.tsx:3123` exactly (`当前会话正在运行；导航命令仍可用，消息请等本轮结束。`) — re-verified, no drift found                           | `SUPPORTED`    |

## 3. #1212 run 2: the ledger omits a fourth attempt

**Measured.** `runs-aborted/run2-missing-logs-mount/ledger.tsv` (md5 `3f16c32afd206644ecfb6ba8fa81cbcc`, byte-identical to `attempt-dirs/ledger.tsv`):

| Attempt | Task                       | Ledger row | LLM calls | Input       | Output      | Validity       | Reward   | Stop                 |
| ------- | -------------------------- | ---------- | --------- | ----------- | ----------- | -------------- | -------- | -------------------- |
| 1       | `password-recovery`        | yes        | 40        | 76,779      | 21,644      | `INVALID:ctrf` | `ABSENT` | `no-envelope`        |
| 2       | `db-wal-recovery`          | yes        | 28        | 12,936      | 17,458      | `INVALID:ctrf` | `ABSENT` | `no-envelope`        |
| 3       | `custom-memory-heap-crash` | yes        | 41        | 75,433      | 34,933      | `INVALID:ctrf` | `ABSENT` | `max_turns_exceeded` |
| 4       | `winning-avg-corewars`     | **no row** | 6         | 13,022      | 12,639      | —              | —        | —                    |
|         | **TRACE TOTAL**            | 4 traces   | **115**   | **178,170** | **86,674**  | —              | —        | —                    |
|         | **LEDGER TOTAL**           | 3 rows     | **109**   | **165,148** | **74,035**  | —              | —        | —                    |
|         | **DELTA**                  | +1 attempt | **+6**    | **+13,022** | **+12,639** | —              | —        | —                    |

For the three rows that exist, the ledger matches the retained trace **exactly** — calls, input and output all agree per row. The entire discrepancy is the unledgered fourth attempt.

**Why attempt 4 has no row.** `runs-aborted/run2-missing-logs-mount/README.md:22` records: "Attempt 4 (`winning-avg-corewars`) was stopped mid-agent-run when this was found; it never reached the grader." The attempt directory corroborates this: `attempt-dirs/winning-avg-corewars/meta/` contains only `instruction.md` and `provision.env` — **`meta/summary.env` and `meta/attempt-timing.env` are absent entirely, not zero-byte files** — and `attempt-dirs/winning-avg-corewars/process/` contains no `grader.log`. The driver reads its row values from those files at `run-pilot.py:171-172` and writes the `preflight_verdict` from the preflight record at `run-pilot.py:193`. The run was stopped before the row was appended, so attempt 4's 6 calls are spent cost with no ledger row anywhere.

**Why it matters.** The figure "≈165k in / ≈74k out" is repeated in `runs-aborted/run2-missing-logs-mount/README.md:1-2` and in `docs/evidence/1212-pilot-selection-manifest.md:102-103`. Both are the **ledger** total, which excludes attempt 4. A4 at `:102-103` calls those tokens "a sunk cost, not recovered" — which is true of the ledger total but is not the run's full spend; the unledgered 13,022 input / 12,639 output tokens are additional cost that no ledger row accounts for.

**The other two #1212 ledgers are internally exact** (recounted while writing this note):

| Ledger                  | Rows | Traces | LLM calls | Input   | Output  |
| ----------------------- | ---- | ------ | --------- | ------- | ------- |
| `runs/pilot/ledger.tsv` | 6    | 6      | 172       | 237,531 | 90,596  |
| `runs/arms/ledger.tsv`  | 12   | 12     | 401       | 407,070 | 481,902 |

## 4. #1212 frozen counting rules, quoted verbatim

Quoted as written in `/home/winner/iknow-wt-1212-pilot/docs/evidence/1212-pilot-selection-manifest.md`, section `## Denominators (predeclared)` (line 227). These are the **historical** rules. They are reproduced for reconciliation and are not reinterpreted here.

| Line(s)    | Verbatim                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `:231-232` | "**Attempted** — 6 (one per task; an interrupted or infrastructure-failed attempt is still attempted)."                              |
| `:235`     | "**Model-attributable** — valid, and not an environment/oracle/grader exclusion."                                                    |
| `:236-237` | "**Excluded** — recorded with its category and **left in the denominator**. Exclusions are never back-filled by substitution."       |
| `:174-175` | "A task whose measured ceiling is below `3.4.31` is an **environment exclusion that stays in the denominator**; it is not replaced." |

The later prose in the same document contradicts these rules:

| Later statement                                                                                                                                                                                                                                                                                   | Location                                                                               | Frozen rule it conflicts with                                    | Status         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------- |
| "`attempt=1` in it was never a model attempt and is excluded from the T6 denominators."                                                                                                                                                                                                           | `:70` (amendment A3, commit `ca7beb596`)                                               | `:231-232` — an infrastructure-failed attempt is still attempted | `CONTRADICTED` |
| "**harness-fault-invalid: none of its attempts enter the T6 denominator.**"                                                                                                                                                                                                                       | `:102` (amendment A4, commit `8a6bb15c9`)                                              | `:236-237` — exclusions stay in the denominator                  | `CONTRADICTED` |
| "**Disposition:** harness-fault-invalid. No attempt in this run enters the T6 denominator."                                                                                                                                                                                                       | `runs-aborted/run2-missing-logs-mount/README.md:3-4`                                   | `:236-237`                                                       | `CONTRADICTED` |
| Opposite direction on the same rule: `db-wal-recovery` carries an environment/oracle/grader exclusion marker in one column and is nonetheless scored `VALID` / reward 1 in both the run2 ledger and the pilot ledger. The exclusion category is recorded and then not applied to the disposition. | `runs/pilot/ledger.tsv` row 2; `runs-aborted/run2-missing-logs-mount/ledger.tsv` row 2 | `:235` vs. the `validity_1167` / `reward` columns                | `CONTRADICTED` |

The amendments changed _which attempts count_. They were recorded after model dispatch had already happened and after grader verdicts had been observed (see §13). Whether that makes them outcome-led is a question this note records rather than answers; §13 sets out the chronology that both readings can be built on.

## 5. #1212 `db-wal-recovery`: a stale preflight record is copied into both ledgers

**Two records exist for the same task, and the driver only ever reads one.**

| Record                                                                             | `oracle_reward` | `ctrf`          | `result_line` | `network_failure_marker` | `preflight_verdict`        |
| ---------------------------------------------------------------------------------- | --------------- | --------------- | ------------- | ------------------------ | -------------------------- |
| `preflight/db-wal-recovery/preflight.env:9-13` (and `preflight.log`)               | `0`             | `absent`        | _(empty)_     | `PRESENT`                | `EXCLUDE:oracle-or-grader` |
| `preflight-retry1/db-wal-recovery/preflight.env:9-13` (and `preflight-retry1.log`) | `1`             | `present:2878B` | `7 passed`    | `none`                   | `OK:oracle-passes-grader`  |

The retry record shows the oracle later passing the grader with a real result line. The driver never consults it:

```
/home/winner/eval-1212/run-pilot.py:173-176
    pf_path = os.path.join(ROOT, "preflight", task, "preflight.env")
    if not os.path.isfile(pf_path):
        pf_path = os.path.join(ROOT, "preflight-retry1", task, "preflight.env")
    pf = kv(pf_path)
```

This is **first-existing-wins**. There is no recency comparison, no mtime check, and no trigger to re-run preflight. Because the stale file exists, the `preflight-retry1` record is unreachable for this task, and the stale verdict is copied verbatim into the ledger at `run-pilot.py:193`.

**Both ledgers therefore carry the contradiction on their face:**

| Ledger                                            | Attempt | `preflight_verdict`        | `validity_1167` | `reward` | `result_line` |
| ------------------------------------------------- | ------- | -------------------------- | --------------- | -------- | ------------- |
| `runs-aborted/run2-missing-logs-mount/ledger.tsv` | 2       | `EXCLUDE:oracle-or-grader` | `INVALID:ctrf`  | `ABSENT` | _(none)_      |
| `runs/pilot/ledger.tsv`                           | 2       | `EXCLUDE:oracle-or-grader` | `VALID`         | `1`      | `7 passed`    |

Run 2's row is internally coherent (the run's grader output was destroyed, so the reward is absent). The pilot's row is not: it asserts an oracle exclusion and a passing reward at the same time.

**The arms run dropped the column.** `runs/arms/ledger.tsv` has no `preflight_verdict` column at all; it carries `wiring_verdict`, with all 12 rows `OK:runner-wired`. So the arms run cannot be compared with the pilot run on preflight state, because the pilot records a field the arms run does not collect.

## 6. #1212 paired reproduction: pair 6 does not reproduce

**Measured, from the two ledgers:**

| Source                                        | `max_turns` | Reward | Stop                    | `result_line`       | Calls | Input  | Output |
| --------------------------------------------- | ----------- | ------ | ----------------------- | ------------------- | ----- | ------ | ------ |
| `runs/pilot/ledger.tsv` row 6 `bn-fit-modify` | 40          | **1**  | `no-envelope`           | `9 passed`          | 22    | 25,509 | 8,930  |
| `runs/arms/ledger.tsv` pair 6 slot 1 `arm40`  | 40          | **0**  | `maxTurns`              | `2 passed 7 failed` | 41    | 48,895 | 14,909 |
| `runs/arms/ledger.tsv` pair 6 slot 2 `arm80`  | 80          | 1      | `completed-no-envelope` | `9 passed`          | 15    | 4,882  | 8,278  |

`docs/evidence/1212-40-80-study-report.md:92-96` claims: "The pilot's two turn-capped failures were `custom-memory-heap-crash` and `winning-avg-corewars`; both reappear as capped at 40 turns here. **The pilot's arm40 column is therefore reproduced** …"

- **The first clause holds.** Both pilot turn-capped failures reappear capped at 40: `custom-memory-heap-crash` pilot reward 0 / `1 failed 5 passed` → arms-40 reward 0 / `1 failed 5 passed`; `winning-avg-corewars` pilot reward 0 / `1 failed 2 passed` → arms-40 reward 0 / `1 failed 2 passed`.
- **The second clause does not.** Of the pilot's six arm40 cells, five reproduce. `bn-fit-modify` reverses (pilot 1 → arms-40 0). The report's own table at `:39` lists pair 6 arm40 as `**0** (`maxTurns`, 40)` without reconciling it against the pilot's 1.
- **Why the cell matters.** Pair 6 carries the report's headline token observation at `:69-78`: `bn-fit-modify` "solved the task with **one tenth** the input tokens at 80 turns that it spent failing at 40" (4,882 vs 48,895 input tokens — both re-verified from the arms ledger). Pair 6 is the one cell where a third same-budget observation went the other way. Run 2 never reached this task, so this is a two-cell disagreement, not three.
- **Holds without contradiction:** arm40 reward 1 on 3 of 6; arm80 reward 1 on 5 of 6; 12/12 rows `VALID`; all four `reward=0` rows carry stop reason `maxTurns`, which does support the report's "Every single failure in the study was a turn-cap failure" at `:48-52`.

## 7. #1213 run 3: the sample count is 66, not 78

**Measured, three independent ways — all agree on 66:**

| Source                                         | Count                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `artifacts/run3/rss.csv`                       | 67 lines − 1 header = **66** data rows                            |
| `artifacts/run3/driver-summary.json` → `rss[]` | length **66**                                                     |
| `artifacts/run3/events.jsonl`                  | 55 `interval_sample_rss` + 11 `interval_sample_snapshot` = **66** |

The report states 78 at `1213-tui-long-horizon-stability-report.md:84` ("every one of the 78 RSS samples"), `:126` ("78/78 RSS samples alive") and `:131`, and the verdict comment repeats it at `verdict-comment.md:3`.

The token `78` does not appear as a standalone value in `rss.csv`, `events.jsonl` or `driver-summary.json`. `rss.csv` carries 66 rows but only **64 unique `t_rel_s` values**, because the snapshot sampler also writes to `rss.csv`, producing duplicates. **`66 + 12 snapshots = 78`** fits arithmetically — but no derivation of that addition exists in any retained artifact, so the origin of the figure is `UNRESOLVED`. This note quotes **66** as the measured number and does not assert what produced 78.

All 66 rows carry `alive=1`. The liveness claim therefore holds **at 66 samples**, not 78.

## 8. #1213 run 3: how the run ended

| Field                              | Value                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `driver-summary.json` `duration_s` | `3330.3`                                                                                                     |
| `started` / `ended`                | 2026-10-06T20:00:32.537 → 20:56:02.815                                                                       |
| `exit_status`                      | `{exited: true, code: 143, signaled: false, signal: null, t_rel_s: 3330.3, detected_by: "teardown-waitpid"}` |
| `died_at_rel_s`                    | `null`                                                                                                       |
| Journal tail                       | `pty_eof` at `t_rel` 3329.727, then `finished` at 3330.3                                                     |

The report's "3330.3 s (55 min 30 s)" matches.

**Precision that must be preserved.** 143 is the conventional `128 + 15` SIGTERM value, but the driver's own record has `signaled: false` and `signal: null`. So "operator SIGTERM" is the operator's account of the stop; the exit record does not independently confirm a signal was delivered. This note records both and does not resolve them.

**The frozen stop rule never fired.** `freeze-comment.md:54` froze: "**Stop conditions (frozen):** after S4, `/quit` is sent once output has been idle for 180 s. If the process dies or wedges first, that is the result and the run is not restarted. Hard wall 3600 s …". The journal contains **no `/quit` event** — the only `/quit` in the whole bundle is in `artifacts/resume1/events.jsonl` at `t_rel` 83.628. There are zero `idle_threshold_reached`, `wall_limit_reached`, `hard_stop_after_quit_timeout` or `teardown_kill_required` records, and the 3600 s wall limit exceeds the 3330.3 s elapsed, so the wall branch was never reached either. The run3 store window holds **zero** `native_state` with `boundary:"terminal"` — see §9.

## 9. #1213 run 3: two of four stimuli were never submitted

**Journal measurement:**

| Stimulus                       | `stimulus_due` `t_rel` | `enter_sent` `t_rel` | `chars` | Outcome                                          |
| ------------------------------ | ---------------------- | -------------------- | ------- | ------------------------------------------------ |
| S1 `S1-task-statement`         | 20.226                 | 22.139               | 1412    | `submission_verified` at 22.300 (first Enter)    |
| S2 `S2-stream-decompress-docs` | 720.063                | 721.759              | 414     | `submission_failed` at 901.9 after **4** Enters  |
| S3 `S3-retry-hardening`        | 1320.065               | 1321.727             | 427     | `submission_failed` at 1502.0 after **4** Enters |
| S4 `S4-final-report`           | 1800.034               | 1801.654             | 301     | `submission_verified` at 1818.400                |

Totals: 4 due, 4 typed, `enter_retry` 6, `submission_verified` **2**, `submission_failed` **2**.

**`driver-summary.json` reports `"stimuli_sent": 4, "stimuli_total": 4`.** That field counts **attempts**, not deliveries, and must never be read as 4/4 delivered. The event journal is the only place the two failures are visible.

**The S4 "verified" is a false positive.** Two independent checks:

1. S4's payload appears in **no** store file — searching every `*.jsonl` under `iknow-data/` for the first 25, 40 and 60 characters of the frozen S4 text returns no hit.
2. The run3 store window (lines 0-744 of the session file) contains exactly **one** `native_state` with `boundary:"input"`, anchored at `e0` (the S1 turn), **zero** for S2/S3/S4, and **zero** with `boundary:"terminal"`. Run 3 never reached a settled state.

The old check was satisfied by sub-agent activity rather than by S4. Two sub-agent session records exist in the bundle — `subagents/55a91052-…` and `subagents/def90f06-…` — each with `turnCount: 2` and `updatedAt` `2026-10-06T12:30:53.622Z` / `…53.650Z`, i.e. local 20:30:53.6, inside the S4 verification interval (`enter_sent` 1801.654 → `submission_verified` 1818.400). The report itself states the old check was "a new session file must appear", which a sub-agent session satisfies. Their creation timestamps are not preserved — the directory mtimes read 2026-10-06 20:56:42, when the bundle was collected — so the false-positive conclusion rests on the two checks above, **not** on any millisecond-ordering claim about the two sub-agent directories.

**Payload identity.** All four run3 payloads are **length-exact and prefix-exact** against the frozen `stimulus.json` (S1 1412, S2 414, S3 427, S4 chars), including both refused stimuli. **Limit:** `events.jsonl` stores only a truncated `head` plus a `chars` count, so a full-payload sha256 **cannot** be recomputed from the bundle. Length-and-prefix agreement is the strongest statement the artifacts support.

## 10. #1213: defects in the retained evidence index

`artifacts/evidence-index.txt` is produced by `hash_artifacts.py`. Three properties of it matter for any later reconciliation.

**(a) The index's self-entry is stale.** Line 3 records `cb64b050…` at 791,091 B for `artifacts/evidence-index.txt`; the real file is sha256 `4d9aaa38…` at **791,347 B** — 256 B behind. `hash_artifacts.py:42-46` writes the index into a directory that `ROOTS` (`hash_artifacts.py:12-16`) already covers, after the directory walk, so the row records the pre-write state. **A sha256 self-entry is structurally unsatisfiable**; this is not a corrupted artifact.

**(b) The other rows do verify.** Six spot-checks all MATCH on both digest and size:

| Path                                    | sha256 (first 12) | Size      |
| --------------------------------------- | ----------------- | --------- |
| `artifacts/run3/rss.csv`                | `575f849878d8`    | 3,133     |
| `artifacts/run3/driver-summary.json`    | `1b2f76236490`    | 6,715     |
| `artifacts/run3/events.jsonl`           | `1f8301773dff`    | 16,485    |
| `artifacts/run3/pty-stream.bin`         | `14a76aab1573`    | 4,760,300 |
| `artifacts/resume1/rss.csv`             | `0f4932b303fb`    | 78        |
| `artifacts/resume1/driver-summary.json` | `6643286adf26`    | 570       |

**(c) The frozen stimulus is unhashed and unindexed.** `hash_artifacts.py:12-16` sets `ROOTS = [artifacts, logs, iknow-data]`; the stimulus files live at the `eval-1213/` top level, outside every root. `grep -c stimulus artifacts/evidence-index.txt` → **0**. So the payloads the protocol froze are not covered by the evidence manifest — while the manifest's _self_-entry, which serves no evidentiary purpose, is covered.

**(d) The index over-counts distinct runs.** `artifacts/run1/*` and `artifacts/run1-aborted-enter-not-submitted/*` are byte-identical, as are `run2` and `run2-aborted-enter-not-submitted` (confirmed by `diff -r`). Any count of "#1213 runs in the bundle" taken from the index is inflated by two.

## 11. #1213 resume1: the resume worked; the driver never saw it

| Field                                       | Value                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `duration_s`                                | 84.3                                                                                                     |
| `total_stream_bytes`                        | 68,605                                                                                                   |
| RSS rows                                    | 1 (`t_rel_s` 60.0, `vmrss_kb` 161,476, `alive` 1)                                                        |
| Journal records                             | 12                                                                                                       |
| `exit_status`                               | `{exited: true, code: 0, signaled: false, signal: null, t_rel_s: 84.3, detected_by: "teardown-waitpid"}` |
| `submission_verified` / `submission_failed` | **0 / 0**                                                                                                |

**The resume itself worked.** The same session file gained `message e297` (the R1 stimulus, `parent: e296`), a `native_state` with `boundary:"input"` anchored at `e297`, and a `native_state` with `boundary:"terminal"` anchored at `e299`. History, context and todos were restored, and the assistant answered from them — the response lists `source/core/errors.ts`, `source/core/options.ts`, `source/core/index.ts`, `readme.md`, `test/max-download-size.ts (new)` and names the `DownloadSizeExceededError` class.

**The driver never verified it.** Zero `submission_verified` and zero `submission_failed` for R1: its pending verification was still outstanding when the idle branch fired. This is the false-**negative** direction, and it is the structural counterpart of §9 — the old check looked for a _new_ session file, which by construction cannot appear on resume.

**The settle guard did not hold.** `idle_threshold_reached` fired at `t_rel` 82.059 with `quiet_s 53.1` and `since_last_stimulus_s 60.1`, then `/quit` was sent at 83.628 and `pty_eof` at 83.866. `since_last_stimulus_s` of 60.1 is well under the `--min-settle 420` guard, so the guard did not prevent the idle branch.

`exit_status.code: 0` is a genuine clean quit, but it was _discovered_ by `teardown-waitpid` — the same detection path as run 3's forced stop. Clean-exit and clean-detection are different properties and only the first is present here.

## 12. #1213 protocol deviations

**The first stimulus was sent at t+20.2 s against a frozen t+0 s.** `freeze-comment.md:46` reads "**S1 — t+0s**" and `stimulus.json` carries `"at": 0` for S1. The run3 journal's `stimulus_due` event still carries `"at": 0` while its `t_rel` is **20.226**, with `enter_sent` at 22.139 and `submission_verified` at 22.300. The 20 s warmup appears in the **report** at `:38` and `:164`, not in any pre-run comment. Note the consequence for auditing: because the `stimulus_due` event retains `"at": 0`, the delay lives entirely in the send path and **the journal alone does not surface the change** — only `t_rel` versus `at` reveals it.

**There is no pre-run comment covering run 3.** `gh api repos/winner6205build/iknow/issues/1213/comments` returns exactly **four** comments:

| Comment ID   | Timestamp (UTC)      | Subject                                    |
| ------------ | -------------------- | ------------------------------------------ |
| `6015373954` | 2026-10-06T11:34:30Z | Protocol freeze — run 1                    |
| `6015629084` | 2026-10-06T11:51:13Z | Amendment before run 2                     |
| `6016911139` | 2026-10-06T13:05:44Z | #1213 result — verdict usable              |
| `6016988601` | 2026-10-06T13:10:07Z | Follow-up — the un-finished post-run suite |

The report cites only the first two as its protocol freeze. The measured run (run 3) was spawned at 20:00:32 local = 12:00:32Z — between the run-2 amendment and the result comment. **No protocol-freeze record covers run 3.** The comment IDs are given so this is checkable.

**Deviations the reports declare themselves** (recorded for completeness; no conflict asserted):

| Deviation                                                                                           | Declared at                                        |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Driver substitution from `mcp__terminalcp__terminalcp` to a `pty.fork` script on the product binary | `1213-…-report.md:28-34`; `freeze-comment.md:5-11` |
| #1212 arms gated on a new `wiring-check.sh` inside the driver rather than in standing preflight     | `1212-pilot-report.md:141-145`                     |
| Stop-reason label conflation `no-envelope` (pilot) vs `completed-no-envelope` (arms)                | `1212-pilot-report.md:150-152`                     |
| Two aborted #1213 runs (run 1, run 2) contributing no evidence                                      | `1213-…-report.md:59-64`                           |

### 12.1 Protocol-deviation ledger: the A3/A4 chronology

**This section records two statements that do not agree. Neither is silently dropped and this note does not choose between them.**

- **The #1219 issue body states:** "#1212 A3/A4 were recorded in an issue comment after the counting pilot."
- **The measured commit and artifact record states:** A3 and A4 were both committed **before** the counting pilot began.

| Item                                | Commit          | Commit time             | Source                                                |
| ----------------------------------- | --------------- | ----------------------- | ----------------------------------------------------- |
| Original freeze (neither A3 nor A4) | `86cc95610`     | 2026-10-06 19:09:24     | commit                                                |
| T11 gate                            | `01bac3205`     | 2026-10-06 19:36:52     | commit                                                |
| **A3**                              | **`ca7beb596`** | **2026-10-06 19:41:27** | commit                                                |
| **A4**                              | **`8a6bb15c9`** | **2026-10-06 20:45:54** | commit                                                |
| Run 1 aborted ledger                | —               | 2026-10-06 19:38:32     | artifact mtime                                        |
| Run 2 `run.log`                     | —               | 2026-10-06 20:45:28     | artifact mtime                                        |
| Counting pilot attempt 1            | —               | **2026-10-06 20:57:26** | `runs/pilot/password-recovery/meta/summary.env` mtime |
| Counting pilot attempt 6            | —               | 2026-10-06 21:41:02     | artifact mtime                                        |
| Counting pilot ledger final write   | —               | 2026-10-06 21:41:03     | artifact mtime                                        |
| Arms ledger final write             | —               | 2026-10-07 00:42:25     | artifact mtime                                        |
| Arms report commit                  | `5ab3415df`     | 2026-10-07 01:22:22     | commit                                                |

Both A3 (19:41:27) and A4 (20:45:54) precede the pilot's first attempt (20:57:26). What the record **does** support is different from both statements above: A3 was recorded after run 1 aborted (19:38:32) and A4 after run 2 stopped (20:45:28) — that is, **after model dispatch, and after three grader verdicts had been observed**. Run 2's own README tabulates those three verdicts (`password-recovery` failed, `db-wal-recovery` passed, `custom-memory-heap-crash` passed), and A4's paragraph at `:102` is built on them. So the amendments were outcome-_adjacent_: not outcome-led by the clock ordering the issue body describes, and not outcome-_blind_ as the manifest asserts.

**The record that is actually contradicted** is the manifest's own heading and assertion:

- `1212-pilot-selection-manifest.md:11` — "## Amendment recorded before the run (required by #1212's freezing statement)"
- `:13-14` — "Both corrections were made **before** any #1212 model run, neither is outcome-led, and both are recorded here as #1212 requires for an amendment."

The measured chronology contradicts `:13-14` (model runs had already been dispatched and graded) and supports neither the issue body's "after the counting pilot" nor the manifest's "before any #1212 model run". Provenance of the amendment text: `git log --all -S'A3 — the provisioning path' -- docs/evidence/1212-pilot-selection-manifest.md` → `ca7beb596`; `-S'A4 — the grader'` → `8a6bb15c9`. The manifest's entire history is four commits: `86cc95610` → `01bac3205` → `ca7beb596` → `8a6bb15c9`.

## 13. What the #1213 run supports, and what it does not

Supported and unsupported claims are listed **separately**. Each supported claim names the artifact that carries it.

### Supported by `artifacts/run3/` + `artifacts/resume1/`

1. **A single real-model TUI session stayed alive for a long horizon.** 3330.3 s, all **66** RSS rows `alive=1`, `died_at_rel_s: null`, no `died` or `wedged` event. (At 66 samples, not 78 — §7.)
2. **The process was stopped externally, not by a product failure.** The journal ends `pty_eof` → `finished` with exit code 143; the run produced a `finished` record rather than a watchdog kill. (How the stop was signalled is not established — §8.)
3. **Render did not visibly break.** 12 snapshot files exist and the journal contains 12 `snapshot` events. **Limit:** only counts were verified, not screen content; "coherent layout" is the report's own reading of those images, not a measurement reproduced here.
4. **The measured bundle is byte-recoverable.** `pty-stream.bin` 4,760,300 B; `events.jsonl` 16,485 B; `driver-summary.json` 6,715 B; `rss.csv` 3,133 B; all six spot-checked index rows re-hash MATCH (§10).
5. **Resume from an unclean stop works at the level the retained artifacts show.** R1 was genuinely accepted and answered from restored context in the same conversation (§11).
6. **Mid-turn input refusal is visible, intentional, and reproducible twice in one run.** S2 and S3 were refused after 4 Enter attempts each, consistent with the composer's running-session notice at `src/tui/app.tsx:3123` (quoted verbatim at `1213-…-report.md:52` — re-verified, no drift).
7. **All four run3 payloads were the frozen ones**, length-exact and prefix-exact, including both refused stimuli (§9).

### Not supported by the retained evidence

1. **Natural or clean stop.** The frozen stop rule (`freeze-comment.md:54`) never fired; the recorded exit is a forced external stop. The journal contains no `/quit` event at all, and the run3 store window has zero `boundary:"terminal"` — run 3 never reached a settled state (§8).
2. **All-stimuli scripted interaction.** Two of four stimuli were never submitted. `"stimuli_sent": 4, "stimuli_total": 4` must not be read as 4/4 delivered. "Interactive throughout" rests on **one** accepted follow-up (S4) — and S4's verification is itself a false positive (§9).
3. **A reliability rate.** n = 1 measured session, single launch, single session id. Nothing in the bundle yields a rate.
4. **Bounded memory trend.** The series is non-monotonic: peak 1,271,684 kB at `t_rel` 1983.0 → 955,416 kB at 2043.0 → 1,086,752 kB at the last sample (3304.6). That is consistent with GC reclamation, but 66 samples over 55 minutes is not a soak. "Qualified yes" is the correct strength of claim; "no leak" is not available from this bundle.
5. **Resume submission verification via the event log** — not supported by construction, since the old driver looked for a new session file, which cannot appear on resume. The resume evidence is the retained screen and session record, not the journal (§11).
6. **Capability or task success.** Report §7's 14-of-15 test observation is context only (`logs/postrun-newtest-isolated.tap`, `logs/postrun-ava.tap`). No grader, no pass rate, no capability inference is drawn from it here.
7. **The verdict comment's "74 agent turns"** (report `:6`, `verdict-comment.md:3`) is not reproducible from the store. The run3 window (lines 0-744) holds 88 assistant messages and 88 `native_state` records; the full file holds 176 assistant messages and 90 `native_state` records (87 `tool_batch`, 2 `input`, 1 `terminal`). The counting definition and the window were never pinned, and the full-file figures are not an independent run3 measure because the resume restored 263 messages into the same store. None of these is 74, and no basis for 74 was found.
8. **Report §2's quoted warning text is verbatim.** `1213-…-report.md:52` reproduces `src/tui/app.tsx:3123` exactly. An earlier draft of this reconciliation expected drift here; on re-verification the quoted string matches character for character and **no drift is claimed**. Recorded so a later reader does not "fix" a quote that is already correct.

## 14. What the next protocol must freeze

#1212's denominators were retrofitted: the frozen rules at `:231-237` and the later amendments A3/A4 describe different populations, and the difference is described only in later prose. **A counting policy for the next run must be frozen before that run starts.** This is a requirement on the next protocol, not a repair of #1212's, and it does not retroactively settle #1212.

Specifically, before the next run begins:

1. **The counting policy is written before dispatch, and amendments after dispatch are labelled as such.** If a rule changes after model dispatch or after any grader verdict is observed, the change must say so at the point of change — the failure mode #1212 exhibits is an amendment whose own heading still claims it predates any model run.
2. **Every attempt gets a row, including interrupted ones.** #1212 run 2 left 6 calls / 13,022 input / 12,639 output tokens outside the ledger because the attempt was stopped mid-run (`README.md:22`). Denominator membership must not depend on whether the process survived to write its summary file.
3. **Ambiguous disposition vocabulary is defined before use.** `harness-fault-invalid` (§4 D3/D4) is not a member of the predeclared vocabulary at `:231-237`, and its introduction changed which attempts counted.
4. **One source of truth per task per field.** A preflight record must be superseded by an explicit, timestamped invalidation, not by the existence of a newer file elsewhere — #1212's driver is first-existing-wins (`run-pilot.py:173-176`) and silently kept a stale `EXCLUDE` verdict after the oracle had passed.
5. **A field is either collected in every run of a comparison or in none.** The pilot records `preflight_verdict` and the arms run does not, so the two cannot be compared on preflight state at all (§5).
6. **Derived counts carry their derivation.** "78 RSS samples" does not follow from any artifact; "66" does, three ways. A count that requires an undocumented addition must not be published.
7. **The evidence index must not contain a self-entry, and must cover the frozen inputs.** The frozen stimulus files must be inside a hashed root, not outside every one of them (§10).
8. **Stimulus delivery and stimulus attempts are distinct recorded quantities.** `"stimuli_sent": 4` counted attempts; the journal showed two failures that only the journal revealed (§9).
9. **Stop conditions record which branch fired, and signal-level detail is preserved.** Run 3's exit code 143 is recorded with `signaled: false` and `signal: null`, which makes the operator's account of the stop unverifiable from the bundle (§8).
10. **Paired-reproduction claims are checked cell by cell.** "The pilot's arm40 column is therefore reproduced" was published while one of six cells reversed (§6).
11. **A counting definition and a window are pinned before a turn count is quoted.** "74 agent turns" has no pinned definition or window and is not reproducible from the store (§13).

## 15. Limits of this note

What was **not** verified, and why:

| Not verified                                          | Reason                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot screen content                               | Only the existence and count of the 12 snapshots were checked. Any statement about what the screen _showed_ is the report's reading, not reproduced here.                         |
| The "74 agent turns" figure                           | No counting definition or window was ever pinned. Store counts of 88 / 176 assistant messages and 88 / 90 `native_state` records do not yield 74.                                 |
| The origin of "78"                                    | `66 + 12 snapshots = 78` fits arithmetically but no derivation exists in any retained artifact. Recorded as `UNRESOLVED`; 66 is quoted as measured.                               |
| Whether outcomes are lost on a forced stop            | The run3 window ends with 87 `tool_batch` states and no `boundary:"terminal"`. Whether the in-flight work at t+3330 s was recoverable is not determinable from the bundle.        |
| The "14 of 15 new tests pass, one genuine hang" claim | Not re-run and not re-verified as a product claim here. `logs/postrun-newtest-isolated.tap` and `logs/postrun-ava.tap` were located but not analysed; the claim is context only.  |
| Full-payload identity of the four stimuli             | `events.jsonl` stores a truncated `head` and a `chars` count only; a full-payload sha256 cannot be recomputed. Length-and-prefix agreement is the limit.                          |
| The three sub-agent sessions' creation timestamps     | Directory mtimes were rewritten when the bundle was collected (2026-10-06 20:56:42). The false-positive finding rests on payload absence from the store, not on directory timing. |
| Whether A3/A4 were outcome-led                        | Recorded as `UNRESOLVED` in §12.1 with both statements and the full chronology. This note does not decide the question.                                                           |
| Any overall verdict for #1212 or #1213                | Out of scope by construction. This note annotates claims against artifacts and deliberately renders no verdict.                                                                   |

## Appendix A — reproduction commands

Every number in this note comes from one of the following. All commands were run from the paths named in §1.

```bash
# §1 — evidence is absent from the default branch
git ls-tree -r --name-only master -- docs/evidence/ | grep -E '121[23]'
git branch -a --contains 5ab3415df
git branch -a --contains fc67b1764
git worktree list

# §3 — run 2 ledger rows and totals (3 rows / 109 / 165,148 / 74,035)
cd /home/winner/eval-1212/runs-aborted/run2-missing-logs-mount
md5sum ledger.tsv attempt-dirs/ledger.tsv
python3 -c "
import csv; rows=list(csv.DictReader(open('ledger.tsv'),delimiter='\t'))
tot={k:0 for k in ('llm_calls','input_tokens','output_tokens')}
for r in rows:
    print(r['attempt'],r['task'],r['llm_calls'],r['input_tokens'],r['output_tokens'])
    for k in tot: tot[k]+=int(r[k] or 0)
print(len(rows),tot)"

# §3 — attempt 4 has no summary/timing file and no grader.log
ls -la attempt-dirs/winning-avg-corewars/meta/
ls attempt-dirs/winning-avg-corewars/process/
sed -n '22p' README.md

# §3 — the other two ledgers are internally exact
cd /home/winner/eval-1212
python3 -c "
import csv
for p in ('runs/pilot/ledger.tsv','runs/arms/ledger.tsv'):
    rows=list(csv.DictReader(open(p),delimiter='\t'))
    print(p,len(rows),sum(int(r['llm_calls']) for r in rows),
          sum(int(r['input_tokens']) for r in rows),
          sum(int(r['output_tokens']) for r in rows))"

# §4 — frozen counting rules, quoted verbatim
sed -n '11,15p;70p;102,103p;174,175p;227p;231,237p' \
  /home/winner/iknow-wt-1212-pilot/docs/evidence/1212-pilot-selection-manifest.md

# §5 — stale vs retry preflight record, and the first-existing-wins selection
grep -n 'oracle_reward\|^ctrf\|result_line\|network_failure_marker\|preflight_verdict' \
  /home/winner/eval-1212/preflight/db-wal-recovery/preflight.env
grep -n 'oracle_reward\|^ctrf\|result_line\|network_failure_marker\|preflight_verdict' \
  /home/winner/eval-1212/preflight-retry1/db-wal-recovery/preflight.env
sed -n '171,176p;193p' /home/winner/eval-1212/run-pilot.py

# §6 — pair 6 arms cells
cd /home/winner/eval-1212
python3 -c "
import csv
for r in csv.DictReader(open('runs/arms/ledger.tsv'),delimiter='\t'):
    if r['pair']=='6': print(r['slot'],r['arm'],r['max_turns'],r['reward'],r['stop_reason'],r['result_line'],r['input_tokens'])"
sed -n '39p;48,52p;69,78p;92,96p' \
  /home/winner/iknow-wt-1212-pilot/docs/evidence/1212-40-80-study-report.md

# §7 — 66 RSS rows, three independent counts
cd /home/winner/eval-1213
wc -l artifacts/run3/rss.csv
python3 -c "
import json,csv,collections
print('driver rss[]',len(json.load(open('artifacts/run3/driver-summary.json'))['rss']))
rows=list(csv.DictReader(open('artifacts/run3/rss.csv')))
print('rss.csv data rows',len(rows),'unique t_rel_s',len({r['t_rel_s'] for r in rows}),
      'alive set',{r['alive'] for r in rows})
c=collections.Counter(json.loads(l).get('event') for l in open('artifacts/run3/events.jsonl') if l.strip())
print('rss+snapshot',c['interval_sample_rss']+c['interval_sample_snapshot'],'snapshots',c['snapshot'])"

# §8 — duration, exit status, stop-rule absence
python3 -c "
import json
d=json.load(open('artifacts/run3/driver-summary.json'))
print(d['duration_s'],d['exit_status'],d['died_at_rel_s'])"
python3 -c "
import json
c={}
for l in open('artifacts/run3/events.jsonl'):
    if l.strip():
        e=json.loads(l); c[e.get('event')]=c.get(e.get('event'),0)+1
for k in ('idle_threshold_reached','wall_limit_reached','hard_stop_after_quit_timeout','teardown_kill_required'):
    print(k,c.get(k,0))"
sed -n '54p' freeze-comment.md

# §9 — stimulus outcomes and the false-positive verification
python3 -c "
import json
for l in open('artifacts/run3/events.jsonl'):
    if l.strip():
        e=json.loads(l)
        if e.get('event') in ('stimulus_due','stimulus_sent','submission_verified','submission_failed','enter_retry'):
            print(e.get('event'),e.get('t_rel') or e.get('t_rel_s'),e.get('at'),e.get('chars'),e.get('why'))"
python3 -c "
import json,glob
s=json.load(open('stimulus.json'))
for st in s: print(len(st['text']),st['at'])"
grep -rl 'Finish and report. List every file you changed' iknow-data/ || echo 'S4 payload: no store hit'

# §10 — evidence index self-entry, spot-checks, stimulus coverage, duplicate runs
sed -n '3p' artifacts/evidence-index.txt
sha256sum artifacts/evidence-index.txt; stat -c%s artifacts/evidence-index.txt
for f in run3/rss.csv run3/driver-summary.json run3/events.jsonl run3/pty-stream.bin \
         resume1/rss.csv resume1/driver-summary.json; do
  sha256sum "artifacts/$f"; stat -c%s "artifacts/$f"; done
grep -c stimulus artifacts/evidence-index.txt
sed -n '12,16p;42,46p' hash_artifacts.py
diff -r artifacts/run1 artifacts/run1-aborted-enter-not-submitted && echo 'run1 identical'
diff -r artifacts/run2 artifacts/run2-aborted-enter-not-submitted && echo 'run2 identical'

# §11 — resume1 summary and the never-verified stimulus
python3 -c "
import json,collections
d=json.load(open('artifacts/resume1/driver-summary.json'))
print(d['duration_s'],d['total_stream_bytes'],d['exit_status'])
c=collections.Counter(json.loads(l).get('event') for l in open('artifacts/resume1/events.jsonl') if l.strip())
print('verified',c.get('submission_verified',0),'failed',c.get('submission_failed',0),
      'idle',c.get('idle_threshold_reached',0))"
cat artifacts/resume1/rss.csv

# §12 — S1 offset, comment IDs, report citations
python3 -c "
import json
for l in open('artifacts/run3/events.jsonl'):
    if l.strip():
        e=json.loads(l)
        if e.get('event')=='stimulus_due': print(e['tag'],'at',e['at'],'t_rel',e['t_rel'])"
gh api repos/winner6205build/iknow/issues/1213/comments \
  --jq '.[] | "\(.id) \(.created_at) \(.title // .body[0:40])"'
sed -n '46p' freeze-comment.md
cd /home/winner/projects/iknow
git show fc67b1764:docs/evidence/1213-tui-long-horizon-stability-report.md | sed -n '6p;52p;84p;126p;131p;164p'

# §12.1 — A3/A4 chronology
for c in 86cc95610 01bac3205 ca7beb596 8a6bb15c9 5ab3415df; do
  git log -1 --format="$c %ad %s" --date=format:'%Y-%m-%d %H:%M:%S' "$c"; done
stat -c'%y %n' /home/winner/eval-1212/runs-aborted/run1-curl-provisioning-failure/ledger.tsv \
  /home/winner/eval-1212/runs-aborted/run2-missing-logs-mount/run.log \
  /home/winner/eval-1212/runs/pilot/password-recovery/meta/summary.env \
  /home/winner/eval-1212/runs/pilot/bn-fit-modify/meta/summary.env \
  /home/winner/eval-1212/runs/pilot/ledger.tsv \
  /home/winner/eval-1212/runs/arms/ledger.tsv

# §13 — store ground truth and the turn counts
cd /home/winner/eval-1213
python3 -c "
import json,collections
p='iknow-data/projects/got-93e6e2f88442/aea1961e-4a62-4259-b26d-bd8d58f9d535/aea1961e-4a62-4259-b26d-bd8d58f9d535.jsonl'
lines=[json.loads(l) for l in open(p) if l.strip()]
for label,seq in (('window 0-744',lines[0:745]),('full file',lines)):
    ns=[l for l in seq if l.get('type')=='native_state']
    a=[l for l in seq if l.get('type')=='message' and (l.get('message') or {}).get('role')=='assistant']
    print(label,'assistant',len(a),'native_state',len(ns),dict(collections.Counter(l.get('boundary') for l in ns)))"

# §13 — the §2 quote, re-verified against source
cd /home/winner/iknow-wt-1219-audit
git show fc67b1764:docs/evidence/1213-tui-long-horizon-stability-report.md | grep -n '当前会话'
sed -n '3123p' src/tui/app.tsx
```
