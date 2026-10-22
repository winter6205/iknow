# Agent QA evaluation (offline mechanism, 20-slot catalog)

Read this when operating `scripts/eval/agent-qa/` — running the offline catalog, rebuilding a
report from retained bytes, or comparing two retained reports. Every flag, verdict string, and
exit code quoted here was read from the source in this tree and re-run before being written down.

**What this tooling is.** A versioned report model over 20 Agent QA slots that runs the **real**
production agent harness, tools, ledger, trace writer, and trace reader against a fresh disposable
workspace, with only the provider replaced by a loopback scripted responder
(`scripts/eval/agent-qa/provider.ts`). It proves the mechanism and the artifact contract.

**What it is not.** It makes no model-quality claim. `mayClaimCapability` is `false` in the
report's own type literal, not merely in prose, and the summary prints `capability claim no`.
A real-model baseline is Issue B of `specs/agent-evaluation-improvement.md`: it needs a frozen
protocol and **separate run authorization**, and it has not run. Do not read a 20/20 offline
report as an Agent quality score.

This guide does not cover the Terminal-Bench headless driver or the TUI harness; those live in
[eval-runner.md](eval-runner.md), which keeps its own frozen counting policy
(`1219-denominator-v1`, `scripts/eval/terminal-bench-2.1/accounting.ts`) and is unaffected by this
capability: no module under `scripts/eval/agent-qa/` imports it, and
`tests/scripts/eval/agent-qa/report.test.ts` and `compare.test.ts` refuse any
`terminal-bench` reference in the reporting or comparison source.

---

## 1. Prerequisites

- `npx tsx` — the entry is a `.ts` file, run the way the other `scripts/` entries are run. No npm
  script exists for it, and none is promised.
- No API key, no network. The scripted provider listens on loopback inside the process
  (`env.llm.baseUrl` is repointed per attempt); nothing reaches an external endpoint.
- A **disposable absolute run root outside the repository**. `--root` inside the repo or a
  relative path is refused before anything is created (`assertRoots`, `scripts/eval/agent-qa/suite.ts`).
  All three commands check it, because `run`, `report --persist` and `compare` each retain bytes
  under `--root`.
- A run root is **write-once**. A second `run` in the same directory refuses with
  `artifact-write@artifact-write`; use a fresh root.
- The catalog locks behavior-local fixtures by digest (see §6), and the lock's digests are read
  from the bytes on disk when the run freezes them. Nothing re-hashes the tree afterwards —
  `report` and `compare` read retained bytes only (§7) — so a fixture edited between two runs is
  frozen at its new digest rather than refused. What the report boundary does refuse is retained
  bytes disagreeing with each other: an attempt whose fixture digest is not one the lock in the
  *same root* froze, or a plan that disagrees with that lock, is `stale-digest@report`. Across arms,
  comparison is where a moved fixture surfaces: `compare` refuses a pair whose per-case fixture
  digests differ (kind `incomparable`), so fixture drift can never be read as a treatment effect.

## 2. Commands

```bash
# run the whole catalog into a fresh root, then rebuild and retain the report
npx tsx scripts/eval/agent-qa/cli.ts run --root /tmp/agent-qa-run-1

# run selected slots (the frozen denominator still holds all 20)
npx tsx scripts/eval/agent-qa/cli.ts run --root /tmp/agent-qa-run-2 --case task-02 --case safety-03

# rebuild a report from retained bytes, read-only
npx tsx scripts/eval/agent-qa/cli.ts report --root /tmp/agent-qa-run-1

# machine form of the same document, for piping
npx tsx scripts/eval/agent-qa/cli.ts report --root /tmp/agent-qa-run-1 --json

# two arms live in two roots, because a run root is write-once and run-2 is already taken
npx tsx scripts/eval/agent-qa/cli.ts run --root /tmp/agent-qa-run-3

# compare the two retained arms; the difference is retained under --baseline's root, and the
# two ids are whatever each `run` printed, so they are placeholders here, not captured bytes
npx tsx scripts/eval/agent-qa/cli.ts compare --root /tmp/agent-qa-run-1 \
  --baseline <offline-id-run-1-printed> \
  --candidate-root /tmp/agent-qa-run-3 --candidate <offline-id-run-3-printed> \
  --treatment source
```

| Flag                                      | Command   | Meaning                                                                                              |
| ----------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `--root <dir>`                            | all       | absolute and outside this checkout; `run` also checks it against `--repo-root`                        |
| `--repo-root <dir>`                       | `run`     | repository whose fixtures the catalog locks; defaults to this checkout                               |
| `--case <caseId>`                         | `run`     | repeatable selection; unknown, empty, or duplicated ids refuse                                       |
| `--max-turns <n>` / `--wall-ms <n>`       | `run`     | per-attempt ceilings (defaults 8 / 30000); these two are the only ceilings the loop can stop a run on, so they are the only ones a record can state as `applied` (see §5, dimension 4) |
| `--provider-usage reported\|absent`       | `run`     | `absent` is the unknown-usage arm: dispatch halts after the first settled slot                       |
| `--persist`                               | `report`  | also retain the rebuilt report (refused if it already exists)                                        |
| `--baseline` / `--candidate`              | `compare` | two run ids; the baseline report is read from `--root`                                               |
| `--candidate-root <dir>`                  | `compare` | the root the candidate was retained in. Absent means `--root`; the difference is still written under `--root` |
| `--treatment source\|model\|prompt\|tool` | `compare` | the one factor claimed to explain the difference                                                     |
| `--allow-diff <field>`                    | `compare` | repeatable; the frozen set of identity fields the treatment may move                                 |
| `--json`                                  | all       | print the document instead of the summary                                                            |
| `--help`                                  | —         | usage text                                                                                           |

A flag that does not belong to its command, a repeated single-valued flag, a missing value, and a
positional argument are all refusals — never silently ignored inputs.

## 3. Exit codes

| Code | Meaning                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| 0    | the operation succeeded **and the measurement is admissible**                                                                  |
| 1    | artifacts were retained or read, but the measurement is not admissible                                                         |
| 2    | the command refused: malformed input, unusable budget, unreadable or corrupt artifact, incomparable arms, or an internal break |

The exit code describes the measurement, never a case's task verdict: a slot that failed its
oracles is valid data and leaves the code at 0. `isAdmissible` (`scripts/eval/agent-qa/cli.ts`)
reads `measurementComplete`, `fullCatalogCoverage`, a defined conditional score,
`measurementCoverage === 1`, per-attempt evidence coverage, `notRun`/`invalid`/`unknown`/
`interrupted`/`providerErrors` all zero, `usageTotals.usageComplete` — the run's token totals are
complete only when every retained call of every executed slot stated one, so a halted or short run
reads unknown rather than as a partial sum (§4) — and no unconfirmed cleanup. `--help` is 0;
a bare invocation is 2.

A `compare` keeps its difference on disk whichever arms produced it, and then reads its exit code
off both reports: 0 only when both are admissible, 1 when either is short, halted, invalid, or
unaccounted for. The retained comparison is not relabeled — it is the reviewer's reminder that a
difference drawn from a half-run is not a difference between two measurements.

## 4. Offline sample report

Captured 2026-10-10 by the first §2 command, into a fresh root (`run --root
/tmp/agent-qa-guide-refresh-1`): exit code 0, 20 slots, no credentials. The working tree was **not
clean**, so this is not a commit reproduction — HEAD was `c8c37195`, but the 34 files under
`scripts/eval/agent-qa/` whose code printed these bytes are staged adds that commit does not
contain (58 changed paths in total).

```text
run offline-a2f8b7e9  evaluator agent-qa-v1  posture scripted-offline
counts  planned 20  executed 20  valid 20  passed 20  interrupted 0  provider-error 0  invalid 0  not-run 0  unknown 0
conditional score 1.000  measurement coverage 1.000  full catalog coverage yes  measurement complete yes
usage  in 616  out 392  wall 6332ms  complete yes
cleanup unconfirmed  none
roster executed  recovery-01, recovery-02, recovery-03, safety-01, safety-02, safety-03, safety-04, task-01, task-02, task-03, task-04, task-05, tool-01, tool-02, tool-03, tool-04, turn-01, turn-02, turn-03, turn-04
  recovery-01  passed       valid           complete  oracles 3
  ...one line per slot, 20 in total...
  turn-04      passed       valid           complete  oracles 3
capability claim  no — offline tooling evidence measures the mechanism, never a model.
report retained at /tmp/agent-qa-guide-refresh-1/reports/offline-a2f8b7e9.report.json
report digest a008aec8442a13d3fa7d5af73affdac53308eeccfed6d9f0cc2c7b68fddbd5e9
```

Token figures are the scripted provider's own reported usage, not a cost estimate; the currency
spend is unavailable and no spend cap is claimed. What the figures are *of* is the attempt's
**total over every model call it retained**: each slot's own trace is read back through the
production trace reader, its `llm_call` rows summed, and here the 20 slots settled 56 calls that
state 11 input / 7 output tokens apiece — 616 and 392. The reading used to come from
`RunResult.lastUsage` (ADR-0008: the last *successful* model call's usage), which priced a whole
multi-call run at one call and would have put 220 / 140 in this block: 20 calls standing in for 56.
A total is complete or unknown, never partly known — a call that stated no usage (an error row
omits the token keys), a trace cut by the reader's 8 MiB cap, or an unparsable line leaves the
attempt's tokens `null`, and `null` prints as `unknown`; nothing writes 0 where it did not look.
Only `wall` will not reproduce byte-for-byte on another machine: it sums that run's measurements,
so it moves with load, while the token totals are retained bytes (a second full run into a fresh
root printed `in 616 out 392` again).

Two shorter runs from the same command, each in its own fresh root because a run root is write-once,
kept because they show the honest-denominator behavior:

```text
# run --root /tmp/agent-qa-guide-refresh-2 --case task-02  → exit 1
run offline-b7a52185  evaluator agent-qa-v1  posture scripted-offline
counts  planned 20  executed 1  valid 1  passed 1  interrupted 0  provider-error 0  invalid 0  not-run 19  unknown 0
conditional score 1.000  measurement coverage 0.043  full catalog coverage no  measurement complete no
usage  in unknown  out unknown  wall unknownms  complete no (unknown usage blocks dispatch)
cleanup unconfirmed  none
roster executed  task-02
roster missing  recovery-01, recovery-02, recovery-03, safety-01, safety-02, safety-03, safety-04, task-01, task-03, task-04, task-05, tool-01, tool-02, tool-03, tool-04, turn-01, turn-02, turn-03, turn-04
  recovery-01  undetermined not-run         missing   oracles 0
  ...7 more not-run lines, same shape...
  task-02      passed       valid           complete  oracles 2
  ...10 more not-run lines, same shape...
  turn-04      undetermined not-run         missing   oracles 0
capability claim  no — offline tooling evidence measures the mechanism, never a model.
report retained at /tmp/agent-qa-guide-refresh-2/reports/offline-b7a52185.report.json
report digest d00e2a88fe339bc2977b4db7078461d6de0bd5ab9ef656f1d8beb108fa5df50e

# stderr: exit 1 — the measurement is not admissible; read the counts.
```

Read the score and the coverage together, because they answer different questions. `conditional
score 1.000` is `passed / valid` over the attempts that were measurement, and one valid passing
attempt divides by one. `measurement coverage 0.043` is named over **every planned slot**: per
attempt its own record, its trace reference, and one slot per required oracle — 93 named slots for
this catalog — of which the one executed slot resolved 4. That a short roster moves coverage and not
the score is the point: `isAdmissible` requires coverage `=== 1` (§3), so the exit code is 1 even
though nothing failed.

The `usage` line of a selection is also worth the pause: nothing halted here, yet the tokens print
`unknown`. A slot that never dispatched states `null` usage — it observed nothing — and a total over
a `null` is `null`, never "just the one slot that ran". The parenthetical
`(unknown usage blocks dispatch)` is one fixed string printed for any incomplete total, so read it
against the counts, not as evidence that an unaccounted-usage halt happened.

```text
# run --root /tmp/agent-qa-guide-refresh-3 --provider-usage absent  → exit 1
run offline-896b0ae8  evaluator agent-qa-v1  posture scripted-offline
counts  planned 20  executed 1  valid 1  passed 1  interrupted 0  provider-error 0  invalid 0  not-run 19  unknown 0
conditional score 1.000  measurement coverage 0.054  full catalog coverage no  measurement complete no
usage  in unknown  out unknown  wall unknownms  complete no (unknown usage blocks dispatch)
cleanup unconfirmed  none
roster executed  recovery-01
roster missing  recovery-02, recovery-03, safety-01, safety-02, safety-03, safety-04, task-01, task-02, task-03, task-04, task-05, tool-01, tool-02, tool-03, tool-04, turn-01, turn-02, turn-03, turn-04
  recovery-01  passed       valid           complete  oracles 3
  ...one line per slot, 20 in total...
  turn-04      undetermined not-run         missing   oracles 0
capability claim  no — offline tooling evidence measures the mechanism, never a model.
report retained at /tmp/agent-qa-guide-refresh-3/reports/offline-896b0ae8.report.json
report digest fde74e8d9663ca670a183d54725fcf43e555783adfa25e99a4957fa31950f9c8

# stderr of the same command, in this order:
halted after recovery-01 (unknown-usage): the rest of the frozen roster stays planned and not run.
exit 1 — the measurement is not admissible; read the counts.
```

This arm is where the counts themselves go missing: the scripted provider omitted its `usage`
object, so `recovery-01`'s own `usage.json` reads
`{"inputTokens":null,"outputTokens":null,"wallMs":277,"usageComplete":false}` — the wall it measured
stays while the counts it never saw stay unknown, and its slot still holds in the denominator.

One caveat about those two stderr quotes: they are the lines this capability writes, and the only
ones the exit code follows. A run assembles the real engine, and the real engine writes its own
diagnostics to the same stream — on this host that added an `[lsp-warmup] partial: typescript: no
client available` line (`src/harness/lsp/warmup.ts`) and `plugin agent bare alias ...` lines from
the operator's own subagent catalog (`src/harness/subagent/user-catalog.ts`), plus an `npm warn`
about the user `.npmrc`. Those are host noise, not verdicts: they appear on a passing run as readily
as on a halted one, and none of them changes an exit code.

A selection never shrinks the plan: the frozen roster keeps all 20 slots and the unrun ones are
reported, not excluded. Unknown usage halts further dispatch and is never written as zero.

## 5. Reading a report

Four dimensions, reported per attempt and never collapsed into one number:

1. **Task outcome** — `passed` / `failed` / `undetermined`, derived only from the case's declared
   independent oracles (`workspace-bytes`, `acceptance-run`, `effect-record`, `permission-record`).
   Assistant prose is never an input: a refusal's wording cannot make a slot pass, and a
   confident claim cannot either.
2. **Measurement validity** — `valid` / `invalid` / `interrupted` / `provider-error` / `not-run` /
   `unknown`. Only `valid` attempts enter the conditional score's denominator.
3. **Required-artifact coverage** — `complete` / `partial` / `missing` / `corrupt` over the named
   artifacts of that attempt. It proves the named references exist and resolve; it does **not**
   claim the trace is lossless.
4. **Posture and applied limits** — `scripted-offline` here. Dimension 4 always states the same
   four limits in the same order — `maxTurns`, `wallMs`, `inputTokens`, `outputTokens` — each as
   what was declared, whether it applied, what was observed, and whether the run went over it. A
   slot that never dispatched states all four as nothing-observed and nothing-applied, so which
   limits exist is a fact about the frozen budget, never about how far this run got; the report
   reader refuses a record that omits one of the four or states one twice, because an unstated cap
   would read as "no such cap was frozen" rather than "this run never said". Only the two ceilings
   the CLI exposes can stop a run, so they are the only ones a record can mark applied. The loop
   enforces no token cap mid-run, so a token ceiling is only ever reported as observed — and as
   `overrun` once it passes a declared number — never as applied; and an offline run declares both of
   them `null`, which is uncapped, not 0. Nothing in a green report claims a token budget was met.

A run that faults is named by evidence, never by elimination: only a call that arrived with no
scripted step left is `provider-error`, a typed fault keeps the kind it carries, and a fault no
boundary of this capability claims is recorded as `unattributed` with validity `unknown` rather
than blamed on the endpoint.

An attempt that started and never settled is read from its own bytes: `intent.json` with no
`hash-index.json` is the signature of a crash before settlement, so the slot reports
`interrupted` with `partial` coverage and unconfirmed cleanup, and the rest of the run stays
readable. A directory that froze its index and then lost the record that index names contradicts
itself, and is a typed refusal rather than a relabelled interruption.

`conditionalScore` is `null` when no attempt was valid — an undefined score is printed as
`undefined (no valid attempt)`, never as `0`, and the gate refuses to call it green.

The six roster states (`executed` / `partial` / `missing` / `skipped` / `credential-blocked` /
`other-not-run`) are the reviewer's roster accounting. Only the plan may name a reason to hold a slot
off dispatch, and it names one of the two declared reasons in that attempt's `notRun` field: a slot
nobody dispatched and nobody declared lands in `missing`, and a slot that retained no measurement for
any other reason — a cancelled dispatch, a fault no boundary could attribute — lands in
`other-not-run` rather than borrowing a reason nobody froze. A fault kind never picks a bucket:
spelling `skipped` into a record's `failure.kind` is a value outside the failure vocabulary, and the
report refuses the record instead of reading a decision out of it. An unaccounted-usage halt leaves
the remaining slots planned.

## 6. Run root layout

```text
<root>/run-plan.json          the frozen plan: identities, budget, 20 case references, attempts
<root>/catalog-lock.json      the same decision's fixture digests, per locked address
<root>/attempts/<attemptId>/  .claim, intent.json, dispatch.json, usage.json, outcome.json,
                              attempt.json, hash-index.json, oracles/<oracleId>.json,
                              trace/<conversationId>.jsonl and trace/blobs/<digest>
<root>/workspaces/<attemptId>/  the disposable workspace that slot actually wrote into
<root>/state/<attemptId>/       the engine's own per-attempt state directory
<root>/reports/<runId>.report.json
<root>/comparisons/<baseline>__vs__<candidate>.json
```

Named artifacts are written once with `O_EXCL`, fsynced, and refused by the kernel if they already
exist; `hash-index.json` is the exception by design — it is rewritten through a temp file and a
rename, and it never indexes its own bytes. `usage.json` is the dispatch's `UsageRecord`, the same
object the settled `attempt.json` embeds: one entry per counter holding that attempt's **totals**
and their completeness flag, not a per-call log — the per-call bytes stay in the trace.
`buildReport` and
`compareReports` import no network or child-process module: they cannot dispatch, and a bad input
is a typed refusal rather than a shorter report — a torn JSONL line as `artifact-corrupt`, a named
artifact that is not there as `missing-reference`, a digest mismatch as `stale-digest`. Every one of
those digest checks compares retained bytes with each other (an attempt record against the
`catalog-lock.json` in the same root, the plan against that lock); none of them re-hashes the
working tree, which is the gate §7 says does not exist.

The catalog's 20 slots are coverage references, not prompt bodies: each
`scripts/eval/agent-qa/cases/<group>/<id>.case.ts` holds its own trajectory and points at the
behavior-local fixture it locks (for example `tool-01` locks
`tests/harness/aci/tools/web-discover-vs-read.fixtures.ts#sc3-empty-search-not-guess-fetch`, and
`tool-04` locks `tests/harness/lsp/worktree-trajectory.fixtures.ts#wt-unsafe-refusal`). No golden
set was relocated.

## 7. Known limitations

- **No final assistant prose is retained.** The production trace keeps the `llm_call` request
  projection; the completion text is not written, so no oracle can read it and none is allowed to.
  Consequence: a slot's verdict is bytes, exit codes, and records only.
- **`bodyScan` in `oracle.ts` is unreachable from any case declaration.** It stays as a
  not-wired helper; nothing in the catalog depends on it.
- **Coverage counts artifacts, it does not name their faults.** `coverageOf`
  (`scripts/eval/agent-qa/retained.ts`) treats an unreadable artifact and an absent one alike
  while counting, so `partial` states only that a named artifact did not resolve; whether that
  file was corrupt, unreadable, or missing is the typed read of the file itself. What coverage
  does not claim, the index does: `hash-index.json` indexes the trace bytes beside the record,
  so a trace torn after settlement is refused as `artifact-corrupt@artifact-read` and a vanished
  one as `missing-reference@artifact-read`, never folded into a softer verdict.
- **`<worktree>` and `<main>` placeholders do not resolve.** The offline runner cannot build a host
  task-worktree address (that seam is registered only with `build-engine.ts`'s worktree wiring), so
  an oracle naming them settles `unreadable` — never an absence, never a pass.
- **The offline arm's `prompt` / `tool` / `source` digests are declared constants**
  (`planDocument`, `scripts/eval/agent-qa/suite.ts`), not digests of the checked-out code, because
  the scripted arm has no prompt or toolset change to freeze. `compare` therefore enforces the
  identities the two reports *declare*; it cannot see that the working tree moved between two
  offline arms. Fixture digests in `catalog-lock.json` are the opposite: they are read from the
  bytes on disk when the run freezes them, and `compare` refuses a pair whose per-case fixture
  digests differ. Issue B must freeze real model/prompt/tool/
  source identities, and a real `source`-treatment comparison is only meaningful once it does (§8).
- **The catalog lock is a record, not a gate.** No production command re-hashes the working tree
  against a frozen lock: `resolveCatalog` digests what is on disk, and `report`/`compare` never read
  the tree at all. `verifyCatalog` (`scripts/eval/agent-qa/catalog.ts`) is the re-digesting check, and
  its callers are the catalog and plan tests, which use it to prove the lock the run froze still
  describes this tree's bytes. A fixture edited between two arms therefore surfaces as differing
  frozen digests in `compare` (kind `incomparable`), never as a run-time re-hash of the tree. The
  `stale-digest` refusals that do exist check retained bytes against each other, never against the
  checkout: an attempt whose fixture digest is not one the lock in its own root froze, a plan that
  disagrees with that lock, and a lock whose primary reference disagrees with its own first locked
  address (`assertFixtureFrozen`, `assertPlanAgreesWithLock`, `assertPrimaryIsFirstLock` in
  `scripts/eval/agent-qa/report.ts`), plus an artifact read back against the digest that named it
  (`readJsonArtifact`, `scripts/eval/agent-qa/artifacts.ts`). A root whose fixture moved in the tree
  after its run froze it is reported, not refused.
- Offline runs share one machine budget; six or more concurrent real-engine workers on a 4-core
  host start producing wall-clock aborts that are load artifacts, not measurements.

## 8. What Issue B still needs before any real run

Nothing here authorizes a model call. Issue B must first freeze, before observing outcomes: the
exact 20 ids and digests, evaluator version, model/prompt/tool/source identities, environment and
posture, numeric time/token ceilings, repetitions, arms, and a unique artifact root — and obtain
separate run authorization. A slot it holds off dispatch is frozen with its `notRun` reason in the
plan and is never dispatched: the offline runner declares none, so this channel has no producer yet,
and a report refuses a run that retained measurement for a slot its own plan froze off dispatch.
`report` and `compare` stay read-only, so a baseline is reconstructable
without credentials afterwards. A candidate arm is planned only if a candidate was selected before
the run; otherwise the valid outcome is a baseline report with no improvement claim.

## 9. Where this is pinned

| Witness                                                         | File                                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| published commands, exit codes, refusal table, budget kinds     | `tests/scripts/eval/agent-qa/cli.test.ts`                                                                          |
| frozen plan, selection, honest denominator; halt and unknown-usage | `tests/scripts/eval/agent-qa/suite.test.ts`, halt and unknown-usage in `tests/scripts/eval/agent-qa/cli.test.ts`  |
| oracle derivation, vacuity guard, evidence refs                 | `oracle.test.ts`, `attempt.test.ts`, `catalog.test.ts`                                                             |
| malformed/duplicate/concurrent claims, corruption, cleanup      | `plan.test.ts`, `artifacts.test.ts`, `dispatch.test.ts`, `lifecycle-negative.test.ts`                              |
| fault attribution: typed fs fault, unattributed, script counts   | `dispatch.test.ts`, `retained` guard in `lifecycle-negative.test.ts`                                               |
| not-run reason: frozen in the plan, never spelled into a fault   | `plan.test.ts`, `report.test.ts`                                                                                   |
| acceptance oracle: watchdog timeout, spawn fault, 127 is a verdict | `oracle.test.ts`                                                                                                 |
| a retained run root holds no secret plaintext, and the trace mask is armed | `secret-scan.test.ts`                                                                                       |
| report dimensions and comparison eligibility                    | `report.test.ts`, `compare.test.ts`                                                                                |
| usage as the sum over an attempt's retained calls, unknown when any was silent; four limits stated once each, a token cap never applied | `attempt.test.ts`, `dispatch.test.ts`, `report.test.ts`                                                       |
| the 20 slots themselves, by group                               | `task-cases.test.ts`, `tool-cases.test.ts`, `turn-cases.test.ts`, `recovery-cases.test.ts`, `safety-cases.test.ts` |

Run them with `npx vitest run tests/scripts/eval/agent-qa/`. Offline halves are not real-model
halves: the roster entry in [prompt-development.md](prompt-development.md) records that gap.
