# #1189 one-task Plan C calibration report

**Date:** 2026-10-05
**Execution contract:** [issue #1189](https://github.com/winner6205build/iknow/issues/1189)
**Verdict:** **ready**, with five stated evidence limits.

Sections 3 and 4 report numbers produced by one **ADR-0130 eval state** run, and name
that state here as ADR-0130 §5 requires. Section 1's build/dataset facts and section
2's oracle preflight are **not** eval-state `ask` numbers — they are build-time and
pre-model preflight facts, labelled as such where they appear. None of the eval-state
numbers are evidence about the fence, about production sandbox permissions, or about
background execution, subagents, or verify sandbox-run; those routes are structurally
absent from the `ask` entry.

This is an **evidence calibration, not a capability estimate**: one task, n=1, not
sampled. Nothing here may be divided into a pass rate.

**Artifact root:** all retained artifacts live under `/home/winner/eval-1189/`, with
the attempt bundle at `/home/winner/eval-1189/runs/attempt1/` and the §2
oracle/grader preflight logs at `/home/winner/eval-1189/runs/oracle2/logs/`. Hashes
for every retained file under **both** roots are in
[`1189-calibration-evidence-index.txt`](1189-calibration-evidence-index.txt).
Selection pinning is in
[`1189-calibration-selection-manifest.md`](1189-calibration-selection-manifest.md).

## 1. Pinned inputs

Build-time and dataset facts — **not** eval-state numbers.

| Field                | Value                                                                                                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source commit        | `9fa88f570e20be3835694c6822802955d6ed4e17` (Plan C merge, #1183)                                                                                                                                                                                                                               |
| Checkout             | fresh isolated worktree; bundle `BUILDINFO.json` reports `dirty:false`                                                                                                                                                                                                                         |
| Bundle               | `iknow-bundle-9fa88f57.tgz`, 50,072,788 B, sha256 `1525d540…b27e7`                                                                                                                                                                                                                             |
| Bundle probes        | `0.1.0` and `iknow-native-ok` both observed green at provisioning time. The probe log was not retained, so this row is an operator observation, not a retained artifact; the bundle's usability is independently evidenced by 40 turns of working `bash`/`read_file`/`grep`/`edit_file` calls. |
| Dataset              | `harbor-framework/terminal-bench-2-1` @ `7131e4375048a0e408a8fb404b5f499d726b695b` (89 task directories)                                                                                                                                                                                       |
| Task                 | `overfull-hbox` (per-file digests in the selection manifest)                                                                                                                                                                                                                                   |
| Task image           | `alexgshaw/overfull-hbox:20260403`                                                                                                                                                                                                                                                             |
| Model                | `minimax-cn/MiniMax-M3.1-Flash-Preview`                                                                                                                                                                                                                                                        |
| Reasoning            | thinking `adaptive`, effort `max`                                                                                                                                                                                                                                                              |
| Posture              | `ask --eval-state`, `max_turns=40`, fs tier `global`, permission `full_auto`                                                                                                                                                                                                                   |
| Attempts             | 1, no retry, concurrency 1                                                                                                                                                                                                                                                                     |
| Declared task limits | verifier 360 s, agent 750 s — **neither was enforced**; see §3                                                                                                                                                                                                                                 |

Selection was fixed and recorded before any model outcome. #1169 records this task
passing at 40 turns in a different run, which is why it was preferred: a known-good
grader makes the measurement valid. That is not evidence about this run.

### Runtime compatibility, measured not inferred

| Measurement                           | Value                             |
| ------------------------------------- | --------------------------------- |
| Task image libstdc++ ceiling          | `GLIBCXX_3.4.33` (Ubuntu 24.04.4) |
| Bundle `tree-sitter.node` requirement | `GLIBCXX_3.4.31`                  |
| Verdict                               | compatible                        |

Both values were measured in-container during this run; the containers were removed
after the artifacts were hashed, so these are recorded measurements without a
re-runnable container. The method is documented in the selection manifest. This is
why the #1173 Jammy exclusion did not reproduce: that limit belonged to the measured
Jammy/bundle pair, which the
[readiness register](https://github.com/winner6205build/iknow/blob/4b26840baa585330f679019efd743c8aa7541a0f/docs/evidence/1189-evaluation-calibration-readiness.md)
correctly scopes to "that measured image/bundle pair, not a requirement for a future
build". The register is not on master; it is PR #1192 at commit `4b26840ba`.

## 2. Environment and grader preflight

Run before the model, in a separate disposable container whose `/app` was never shared
with the attempt. These are preflight facts, not eval-state numbers.

| Step                                | Result                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| Task image pull                     | ok                                                                             |
| Oracle (`solution/solve.sh`)        | `solve_exit=0`, `overfull_left=0`, clean 5-page PDF                            |
| Original grader on the oracle state | `reward.txt=1`, `ctrf.json` present, **4 passed** (1 warning), `grader_exit=0` |

The oracle and the original grader both work, so the later reward of 0 is
attributable to the model rather than to a broken task or grader.

The untruncated logs behind these three rows are retained at
`/home/winner/eval-1189/runs/oracle2/logs/` — `oracle-solve.log`, `oracle-full.log`,
`grader.log`, and `verifier/{reward.txt,ctrf.json}` — and are indexed with sha256 and
byte sizes under the `preflight_artifact_root` section of
[`1189-calibration-evidence-index.txt`](1189-calibration-evidence-index.txt).

## 3. The one attempt — ADR-0130 eval state

| Field         | Value                                                     |
| ------------- | --------------------------------------------------------- |
| Exit code     | 1                                                         |
| Elapsed       | 1129 s                                                    |
| Stop reason   | `max_turns_exceeded`, `turnsRan=40`, `reason=maxTurns`    |
| stdout        | **empty** (sha256 `e3b0c442…b855`, the empty-file digest) |
| Grader reward | **0**                                                     |
| Grader detail | 1 failed, 3 passed in 34.68 s — `test_no_overfull_hboxes` |
| Validity      | **VALID** (see below)                                     |
| Input tokens  | 48,330 summed across `llm_call` rows                      |
| Output tokens | 36,255 summed across `llm_call` rows                      |
| Cost          | **unavailable** — no cost field is exposed on this entry  |

**Which limit actually bound.** The stop was the **turn cap**, not a clock. The
task-declared 750 s agent limit was not enforced on this native path, and the run
exceeded it by 379 s; the operative wall bound was the harness's own `timeout 2700`
around the `ask` invocation. The declared verifier timeout of 360 s was likewise not
enforced — the grader was allowed 1800 s and finished in 34.68 s. Declared task
timeouts are therefore recorded as declared, not applied. The declared values live in
§1's "Declared task limits" row; the applied values are the harness `timeout` calls in
`runs/attempt.sh` (lines 57 and 83), and only those were in force.

### The attempt was real, and it was cut short by the budget

The model did not fail to engage. It ran all 40 turns, and the `stopSummary` in the
stderr envelope reports that it had identified all six required synonym swaps, applied
three (`curious`→`inquisitive`, `riotous`→`wild`, `scorn`→`disdain`), and was
interrupted before applying the remaining three (`responsiveness`, `weatherbeaten`,
`pathfinder`) and doing the final compile.

Independent of that summary, the trace holds **three `edit_file` calls against
`/app/input.tex`, all with `status: ok`**, matching those three substitutions, and the
`worn` and `pioneer` substitutions appear nowhere in the applied set.

This is a **capped failure**: real evidence of performance under a 40-turn budget. A
trace alone cannot establish that a larger budget would have completed the remaining
three swaps.

### Validity, by the #1167 three-clause rule

1. `ctrf.json` exists (2924 B) — pytest ran to completion. ✔
2. Verifier output carries a real result line (`1 failed, 3 passed in 34.68s`). ✔
3. Zero network-failure markers. ✔

All three hold, so this is a **valid, model-attributable** reward of 0. It is not an
environment exclusion and not a broken measurement. This is the discriminator #1169
relied on: `turnsRan` is 40, not 0, so the model did receive the question.

## 4. Evidence readiness — ADR-0130 eval state

**41 `llm_call` rows, 44 `tool_call` rows, 40 `turn` rows, 125 rows total.**

| Check                                                                                                                         | Result                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `llm_call` rows with status `ok`                                                                                              | 41 / 41                                                                               |
| Rows carrying `dispatch_evidence`                                                                                             | 40 / 41                                                                               |
| `dispatch_evidence` entries, all `outcome: ok`                                                                                | 40                                                                                    |
| Request-side (`dispatch_evidence`, `representation: masked-trace-v1`) blob refs resolved, sha256 **and** byte length verified | **120 / 120**                                                                         |
| All blob refs in the trace, any representation                                                                                | **1,741 / 1,741** resolved and verified                                               |
| Distinct blob files on disk                                                                                                   | 124 (0 orphans)                                                                       |
| Missing (`null`/absent) references                                                                                            | 0                                                                                     |
| Broken references                                                                                                             | 0                                                                                     |
| `tool_call` rows                                                                                                              | 44 — **43 `ok`, 1 `execution_failed`**                                                |
| `tool_call` rows carrying a captured result body                                                                              | **0 of 44** (`result_captured: false` on all 44; no `result` field exists on the row) |
| `llm_call` rows referenced by a `turn` row                                                                                    | 40 / 41                                                                               |

Dereferencing confirms the expected content is present, not merely referenced:

- `system` — the real iknow identity/soul prompt, 5164 B, one distinct blob across all
  40 calls.
- `tools` — a JSON array of **29** tool definitions, 28256 B, first entry `bash`.
- `messages` — real conversation content, first 422 B and **final 220,811 B**, with
  `tool_use_id` → `tool_result` linkage matched 43 / 43 with no orphans.
- `stream`, `invocationId`, and `outcome` are present per invocation, so dispatches
  match to their calls.

### Independently re-read with the product's own reader

The findings above come from parsing the JSONL directly. To avoid trusting my own
parser, the retained trace was also read through the product's own reader
(`createGetRecordCore`, the code path the trace panel and trace MCP tools use), once
per `llm_call` record. The reader **dereferences the references and returns the bodies
themselves**, so this is a stronger check than ref resolution.

Retained at `runs/attempt1/reader/reader-output.json` (full, 5.7 MB) with a compact
reviewable form at `docs/evidence/1189-calibration-reader-output.json`. **Units:** the
byte lengths quoted above (5164 B `system`, 28256 B `tools`) are blob sizes as stored
on disk; the `chars` figures in the reader JSON (5012 / 28210) are character counts of
the same bodies after JSON decoding. The two differ by the JSON escaping the blob
stores, so they are the same content measured two ways, not a contradiction.

| Reader result over all 41 `llm_call` records | Value                 |
| -------------------------------------------- | --------------------- |
| Records exposing `final_request_evidence`    | 40                    |
| Records with the key absent                  | 1 (the terminal call) |
| Records with `evidence_gap: unreadable`      | **0**                 |

`final_request_evidence` entries carry `invocationId`, `stream`, `messages`, `system`,
and `tools`, with the bodies inline. The retained sample shows the real user
instruction in `messages`, the `# iknow Identity` / `# iknow Soul` prompt in `system`,
and a tool array beginning with the `bash` definition in `tools`.

**Plan C's open question is answered: in ADR-0130 eval state, both `dispatch_evidence`
and the reader projection `final_request_evidence` carry readable messages, system,
and tools for real dispatches, with no unreadable body.** The gap the readiness
register recorded is closed. An absent `final_request_evidence` on the terminal call
means "no governed invocation recorded"; `evidence_gap` — which would have meant a
referenced body could not be read — is absent on all 41 records.

### Five limits that remain, stated rather than papered over

1. **The terminal call carries no `dispatch_evidence`, and no `turn` row references
   it.** Call `86b1c233-ec8e-4ea4-8bdd-7ea4a8d30a77` (`supplier_stop: success`, the last
   call) has the `dispatch_evidence` key **absent** — not null, not an empty list — and
   is referenced by no turn record. Its **request message bodies _are_ retained**: the
   row carries `messages_captured: true` with 21 content references, all of which
   resolve and hash-verify like every other ref in the trace (they are part of the
   1,741). What is missing is only the `dispatch_evidence` envelope — the governed
   `system`/`tools` refs — and, downstream of it, the reader's
   `final_request_evidence` projection, which is derived from that envelope. So
   request-side evidence and turn linkage both cover 40 of 41 calls. Per ADR-0036,
   "llm_call absent ≠ that call didn't happen"; here the row exists, is `ok`, and its
   conversation messages are readable — the governed request envelope simply was not
   written.
2. **No tool result bodies are captured.** All 44 `tool_call` rows carry
   `result_captured: false` and the row schema has no `result` field, so the trace
   retains tool _arguments_ and outcomes but not result bodies. Tool results are
   recoverable only indirectly, from the request `messages` blobs of later calls. The
   issue's "successful tool results" are therefore readable but not first-class.
3. **One tool call was denied by the hard wall.** Of 44 calls, 43 are `ok` and one is
   `tool_kind: execution_failed`: a `[role_substitution]` refusal — _bash must not
   substitute for "grep"_. This is in-scope evidence about the wall's behavior under
   ADR-0130, and it is reported rather than smoothed away.
4. **No native session JSONL exists on this entry.** `--data-dir` was pointed at a
   per-run directory and the conversation folder was created, but it contains only
   `fence-tmp/` scratch (87 files, **0** `.jsonl`). `SessionStore` is assembled for the
   chat path only, so `ask` writes no session transcript. The issue's "session JSONL"
   artifact therefore **does not exist for this surface**; the equivalent is the trace
   JSONL plus blobs. The final assistant narrative is preserved in the **stderr
   envelope's `stopSummary`**, not in the trace — stdout is empty by design on a
   turn-cap stop.
5. **The retained trace layout is not readable by the product's own reader as
   retained.** `ask --eval-state --trace-out DIR` writes a flat
   `DIR/<conversationId>.jsonl`. Pointed at that directory, the reader raises
   `TraceSessionNotFoundError`, because it resolves conversations through
   `projects/<slug>/<conversationId>/trace.jsonl`. The evidence itself is sound: staged
   into the expected tree layout, all 41 records read and yield 40 populated
   `final_request_evidence` entries with zero evidence gaps. So this is a layout
   incompatibility between the `ask` trace surface and the reader, not missing or
   corrupt evidence.

### Trace-write-failure visibility

**Unavailable, and explicitly not zero.** The `ask` entry surfaces no
trace-write-failure counter in the run JSON or the trace rows, and on a turn-cap stop
no run JSON is written at all. What the retained files _can_ establish: 125 of 125
rows parse as valid JSON, all 1,741 blob references resolve to files whose sha256 and
byte length both match, there are 0 orphan blobs, and no row is truncated. What they
_cannot_ establish: whether the writer internally recorded and swallowed a failure
that never surfaced as a missing row. Per the readiness register's rule, an
unavailable counter is reported as unavailable rather than treated as zero.

## 5. What this run establishes, and what it does not

Establishes:

- The environment, the task oracle, and the original grader all work, so a reward is
  interpretable.
- One real-model attempt ran to a 40-turn cap, with raw grader output retained
  independently of the stop reason.
- Plan C request evidence is populated and dereferenceable in eval state, verified
  both by direct reference resolution and by the product's own reader, with no
  unreadable body.

Does **not** establish:

- Any capability score or pass rate. One task, n=1, not sampled.
- Anything about the fence or production sandbox permissions.
- Anything about background execution, subagents, or verify sandbox-run.
- Whether a larger turn budget would have completed the task.
- Complete evidence coverage for the terminal call, or a trace-write-failure count.
- Anything about the wall's denial rate from a single denied call.

## 6. Evidence-backed follow-ups

1. **Budget sensitivity is a real, named question here.** This run hit the cap with
   three of six validated swaps unapplied and a concrete remaining plan in the trace.
   That is the exact precondition for the controlled same-task 40/80-turn comparison
   the issue contemplates. It requires its own protocol and budget approval, and is
   **not** authorized here.
2. **The terminal call's missing `dispatch_evidence` and missing turn linkage** is an
   evidence-collection defect worth a separate scoped ticket: 1 of 41 calls retains no
   `dispatch_evidence` — and therefore no reader `final_request_evidence` — and is
   referenced by no turn. Its request message bodies are retained and readable; what
   is absent is the governed request envelope (`system`/`tools` refs) and the reader
   projection derived from it.
3. **`ask` has no session transcript.** If a session JSONL is required for evidence
   review, the `ask` eval-state surface cannot currently produce one. Scope
   separately; do not assume the chat path's store is wired here.
4. **A trace-write-failure counter is not exposed on this entry**, which weakens
   completeness claims. Scope separately.
5. **The `ask` trace layout and the trace reader disagree.** `ask` writes a flat
   `<trace-out>/<conversationId>.jsonl`; the reader and the trace panel resolve
   `projects/<slug>/<conversationId>/trace.jsonl`. Until that is reconciled, an
   eval-state trace cannot be opened in the product's own trace UI as retained.
6. **One `[role_substitution]` denial occurred on this task.** A single observation
   cannot characterize the wall's false-positive rate; it is a data point for a
   permission-provenance scope, not a conclusion.

None of these are in scope for #1189, and none are claimed as fixed.

## 7. Deviations and harness notes

- **Bundle construction is a reconstruction.** No bundle-packaging script survives
  in-tree; Harbor took it. The tarball is a documented rebuild from the pinned
  commit, verified by `BUILDINFO.json`, the two install-time probes, and the measured
  GLIBCXX check. It is not a repo convention.
- **Three pre-dispatch failures preceded the attempt**, recorded so the attempt count
  is not misread: a `tar -xJf` xz failure (the image has no `xz`), a transient
  `curl: command not found` immediately after container start, and a 2-second
  `no LLM model configured` fail-fast. All three aborted **before any LLM dispatch**,
  so exactly one model attempt was made. The container needed the user's
  `settings.json` because `IKNOW_LLM_MODEL` is retired and the model comes only from
  `settings.llm.model`; the file was copied into the disposable container and the host
  file was not modified (mtime unchanged, sha256 `993c44f7…`).
- **The oracle preflight needed three attempts of my own harness**, none of them a
  product or task defect: a `head`/`tail` pipe truncation that hid the real output, a
  run that omitted the `/tests` mount so the grader could not start, and an
  `apt install` issued without a preceding `apt-get update` (Docker images ship no apt
  lists). The final oracle and grader results in §2 come from untruncated logs with
  the correct mounts.
- No retry, no task substitution, and no environment repair after observing the model
  outcome. No exclusion set was modified. No credential value appears in any retained
  artifact or in this report; only the model id, the provider prefix, and env var
  _names_ are quoted.

## 8. Cleanup

After the artifacts above were hashed, the run-owned containers (`t2-preflight`,
`t2-attempt1`, and an earlier `t2-*` oracle container) were stopped and removed, and
the buildkit container instance started by the bundle build was removed with its
builder definition left intact. No run-owned process or container survives this
report. Unrelated pre-existing containers on the host were left untouched.
