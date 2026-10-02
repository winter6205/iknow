# Evidence: iknow on Terminal-Bench 2.1, first scored pilot (#1167, 2026-09-29)

> **Historical evidence (retired in #1175).** This file is the record of what
> was actually measured in September 2026, kept as written — it is not a
> runnable path. The Harbor adapter that drove this pilot was retired in
> #1175, so the results below are **not reproducible in-tree**: no re-run,
> no re-count, and no re-derivation is expected from them. The product
> surfaces underneath are unchanged — `--eval-state` (ADR-0130) and the
> native JSONL trace still work.

External-capability measurement of the iknow harness driving
`minimax-cn/MiniMax-M3.1-Flash-Preview` over
`terminal-bench/terminal-bench-2-1`, under ADR-0130 eval state.

**Headline: 36 of the 89 dataset tasks were run; 19 carry a
model-attributable result — 6 passes and 13 fails — across 19 distinct tasks and
all three difficulty bands, each at n=1 for its task.** That is not a pass rate
and not a capability estimate — **do not divide: "6 of 19" over nineteen
different tasks means nothing.** What it establishes is that `setup() ->
install() -> run() -> verifier` completes reliably, that the harness can both
pass and fail a task's own tests, and that **hard** tasks are passed as well as
failed. Tables: §8.5 (the 7-task pilot, all valid) and §8.6 (the full run, all
four verdict classes).
**ADR-0130 §5: every number below is eval state and is
named as such. None of it is evidence about the fence.**

> **Correction (2026-09-29, post-#1167).** The first version of this note
> claimed **"2 scored trials, both reward 0.0, 0/2"** and attributed
> `adaptive-rejection-sampler` to a `3 failed, 6 passed` verifier run. Reading
> the retained verifier logs back shows the opposite for that trial: it
> **never executed its tests**. The `3 failed, 6 passed` line belongs to a
> **different trial of the same task**, in a different job, that had not yet
> been identified. The corrected counts and the trial-by-trial evidence are in
> §3; two further details are corrected at §3.0.
>
> **A third correction, in the other direction, at §4.1.** The reported proxy
> fix (`--ek HTTP_PROXY=…` largely repairing agent-phase egress) **does not
> hold and has been refuted by a direct test**: a _guaranteed-dead_ proxy set
> via `--ek` still produced a fully successful install, and the harbor 0.23.0
> source shows those kwargs are swallowed before reaching the container.
>
> **A fourth correction, in the original note's favour, at §3.0.** The
> headline above now counts a **pass**, because the `iknow-v5-window` batch
> added the first trial whose verifier actually ran to completion
> (`overfull-hbox`, 4 passed). §3 was also carrying a duplicated row — two
> table rows described the **same** trial directory, with turn counts the
> trial's own `result.json` does not support. Both are fixed at §3.0.
>
> **A fifth correction, and the largest: the "intermittent egress" diagnosis
> was wrong, at §4.1a.** The note previously attributed every broken
> measurement to a **stochastic, time-correlated network outage**, and
> `github.com` to being "the single blocking host". A controlled A/B shows
> otherwise: **the task container was never given proxy environment variables
> at all**, so its egress was structurally impossible under this WSL2
> fake-IP setup, and the apparent intermittency was the _proxy's_ variability
> leaking through. The fix is `--ae` (agent phase) plus `--ve` (verifier
> phase), verified by three valid passes in one batch (§3.4). **The
> "re-run during an open window" advice this note carried is withdrawn**: there
> was no window.

---

## 1. Configuration, as measured

| Item                | Value                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent               | iknow via custom Harbor adapter `iknow_harbor.agent:IKnowAgent`                                                                                           |
| Harbor              | 0.23.0                                                                                                                                                    |
| Dataset             | `terminal-bench/terminal-bench-2-1` (89 tasks)                                                                                                            |
| Model               | `minimax-cn/MiniMax-M3.1-Flash-Preview`                                                                                                                   |
| Credential          | injected as `--ae 'MINIMAX_API_KEY=${MINIMAX_API_KEY}'` (templatized on the harbor CLI; only `apiKeyEnv` is written into the container's `settings.json`) |
| Entry               | `iknow ask "<instruction>" --json --eval-state --max-turns 40`                                                                                            |
| Permission mode     | `full_auto`                                                                                                                                               |
| Eval state          | `true` (ADR-0130)                                                                                                                                         |
| iknow commit        | `ade657f2e`, clean tree via `git archive HEAD`                                                                                                            |
| Bundle              | 41,481,564 B, sha256 `84cc06cb386d28bd4de9ccc36bc161c8513b876a08f633b7e3a2af333cc0a509`                                                                   |
| Install-time probes | `0.1.0` green, `iknow-native-ok` green                                                                                                                    |

The bundle size and sha256 above are re-measured on the artifact still on this
machine (`stat -c %s` / `sha256sum /tmp/iknow-bundle.tgz`) and match the run.

**One correction to this table's scope.** `ade657f2e` is the commit for the
**`iknow-pilot-v2`** job. The **two model-attributable trials** (§3.1, §3.2)
are from **two different jobs** — the earlier `iknow-e2e-fixed` and the later
`iknow-v5-window` — and they do **not** carry the same adapter state. The
`install()` logs show exactly which fixes were in the working tree at each
moment:

| job                                            | node resolution in `install()`                                | `GLIBCXX` ceiling probe                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `iknow-e2e-first` (07:02Z, the misattribution) | `NODE_BIN="$(command -v node \|\| true)"` — **old**           | absent                                                                                                            |
| `iknow-e2e-fixed` (07:18Z, **scored trial 1**) | `ln -sf /root/.nvm/versions/node/v22.23.3/bin/node` — **new** | **absent**                                                                                                        |
| `iknow-pilot-v2` (10:08Z)                      | new                                                           | **present**                                                                                                       |
| `iknow-v5-window` (13:34Z, **scored trial 2**) | new                                                           | **present** — and it ran: `libstdc++ already provides GLIBCXX_3.4.31 (ceiling GLIBCXX_3.4.33); no install issued` |

So scored trial 1 (`adaptive-rejection-sampler`, §3.2) already carries the
**node fix** (`68a3f0843`, committed 16:05, developed in the working tree
before the 07:18Z re-run) but **not** the C++-runtime fix (`17b0c8ed7`,
committed 18:07, i.e. after that trial). Scored trial 2 (`overfull-hbox`,
§3.1, 13:34Z) carries **both**, and its `trial.log` records the `GLIBCXX`
probe executing and correctly short-circuiting. **This resolves the caveat §8
previously carried**: the only remaining model-attributable trial on the fully
fixed adapter is the `overfull-hbox` pass.

**The two scored trials therefore do not share an adapter state**, which is a
second reason — alongside being different tasks — not to compare or combine
them. The two adapter fixes are both **required and committed** (§7)
regardless of either trial's outcome: `68a3f0843` exists because the 07:02Z
trial died at install on `node: command not found` **and was misreported as
`IKnowGlibcRequiredError`** on an image that satisfies the requirement, and
`17b0c8ed7` exists because Debian-12 images cannot clear `GLIBCXX_3.4.31` at
all. Neither depends on a scored trial's outcome.

## 2. What this run does not measure

Stated first, because it bounds every number in §4 onward.

**Three routes are structurally absent, not retired-and-observed** (ADR-0130
§2). The single eval entry is `surface: "ask"`, which mounts the **foreground
bash route only**. In this run:

- **No background manager.** Gated `surface !== "ask"`; `background: true`
  throws "no background manager configured".
- **No subagent worker.** `spawn_subagent` is never registered on this entry.
- **No verify `sandbox-run`.** That route is constructed only from
  `chat-session.ts` / `hub.ts`, never from the one-shot entry.

So nothing in this note is evidence about background spawn, subagent, or verify
execution. Publishing any of it as such is the misattribution ADR-0130 §5
exists to prevent.

**What did survive, and is in scope:** the hard-wall (a matched deny is
non-overridable and intercepts before `full_auto` grants anything), and the
which-tree axis — writes resolve against the live task root, which is a real
behavior when the agent edits a task's own repository.

**Terminal-Bench 2.1 is hard-scoring with no LLM judge.** Each task is a Docker
environment, a natural-language instruction, programmatic state-based tests,
and a human reference solution. The reward is pass/fail on final state. So
reward 0.0 says "the final state did not satisfy the verifier"; it does not
rank, grade, or score partially, and there is no graded axis behind it.

**A `reward: 0.0` is not automatically a model score.** Harbor writes
`verifier/reward.txt` whenever the verifier phase terminates, and this
harness's verifiers **install their own tooling first** (see §4.2). When that
install cannot reach its upstream host, the task's tests **never execute** and
harbor still records `0`. Such a trial is a **broken measurement, not a failed
one**, and it is excluded from every rate in this note. §3 separates the two by
reading the verifier log, not the reward file.

**n=1 model-attributable, per task.** Every taxonomy reading in §5 is grounded
in the observed behavior of the 2 trials in §3.1 and §3.2 and nothing wider.
They are 2 receipts from 2 different tasks, not a sample of 2. Neither is a
rate.

## 3. Trials that wrote a reward (10), and the 2 that are model scores

**Read this table's last column before any number below it.** `tests ran?` is
decided by the verifier log, not by the reward file. A `NO` there means the
reward is **not attributable to the model** and is excluded from every rate in
this note.

| #   | task                         | job                    | difficulty | reward  | tests ran? | turn_count | stop                 | evidence                          |
| --- | ---------------------------- | ---------------------- | ---------- | ------- | ---------- | ---------- | -------------------- | --------------------------------- |
| 1   | `adaptive-rejection-sampler` | `iknow-e2e-fixed`      | **medium** | 0.0     | **YES**    | 40         | `max_turns_exceeded` | `3 failed, 6 passed in 2.17s`     |
| 2   | `overfull-hbox`              | `iknow-v5-window`      | **easy**   | **1.0** | **YES**    | 40         | `max_turns_exceeded` | `4 passed in 40.18s`              |
| 3   | `dna-assembly`               | `iknow-pilot-v2`       | hard       | 0.0     | **NO**     | 40         | `max_turns_exceeded` | `line 19: uvx: command not found` |
| 4   | `adaptive-rejection-sampler` | `iknow-pilot-v2`       | medium     | 0.0     | **NO**     | (none)     | (metadata `null`)    | `line 19: uvx: command not found` |
| 5   | `overfull-hbox`              | `iknow-pilot-v4-proxy` | easy       | 0.0     | **NO**     | 40         | `max_turns_exceeded` | `line 24: uvx: command not found` |
| 6   | `prove-plus-comm`            | `iknow-proxy-test`     | easy       | 0.0     | **NO**     | 22         | `completed`          | `line 19: uvx: command not found` |
| 7   | `prove-plus-comm`            | `iknow-pilot-7`        | easy       | 0.0     | **NO**     | (none)     | (metadata `null`)    | `line 19: uvx: command not found` |
| 8   | `prove-plus-comm`            | `iknow-v5-window`      | easy       | 0.0     | **NO**     | 16         | `completed`          | `line 19: uvx: command not found` |
| 9   | `polyglot-c-py`              | `iknow-v5-window`      | medium     | 0.0     | **NO**     | 40         | `max_turns_exceeded` | `line 18: uvx: command not found` |
| 10  | `password-recovery`          | `iknow-v5-window`      | hard       | 0.0     | **NO**     | 32         | `completed`          | `line 18: uvx: command not found` |

**Rows 3–10 all end the same way**, and it is not a test result:

```
downloading uv 0.9.5 x86_64-unknown-linux-gnu
curl: (28) Failed to connect to github.com port 443 after 135298 ms: Couldn't connect to server
failed to download https://github.com/astral-sh/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz
/tests/test.sh: line 10: /root/.local/bin/env: No such file or directory
/tests/test.sh: line 19: uvx: command not found
```

`uvx` is how the task's `tests/test.sh` runs pytest. The install of `uv` that
precedes it could not reach its download host, so the tests never started.
**Eight of the ten rewards are broken measurements**, and only the two
`tests ran? = YES` rows are model scores. The mechanism is §4.2.

**A detail worth recording, because it changes the shape of the blocker:** the
failing host is **not always `releases.astral.sh`**. `tests/test.sh` fetches
`https://astral.sh/uv/0.9.5/install.sh`, which redirects to a
**GitHub release asset**; the redirect target is what actually times out. The
host observed in each log:

| job / trial                                                           | host that failed to connect |
| --------------------------------------------------------------------- | --------------------------- |
| `iknow-proxy-test`, `iknow-pilot-v4-proxy`                            | `releases.astral.sh`        |
| `iknow-pilot-7`, `iknow-pilot-v2` (ARS)                               | `astral.sh`                 |
| `iknow-pilot-v2` (`dna-assembly`), all three `iknow-v5-window` breaks | **`github.com`**            |

So a "fix `releases.astral.sh`" plan is too narrow: §4.2's requirement is a
reachable path to **both** the install script and the GitHub release asset it
redirects to.

**`prove-plus-comm` is the most-run task here and has never been verified.**
It appears in 4 of the 10 reward-writing trials (rows 6, 7, 8) across three
jobs, three of them finishing cleanly (`stop_reason: completed` at 22, 16
turns, and one with no metadata at all after a `NonZeroAgentExitCodeError`).
The clean completions with a `plus_comm.vo` the agent reports as compiled are
**agent-side** facts and real, but they are not scores.

### 3.0 Corrections to the correction

The first version of this note was wrong in ways that a re-read corrects — in
the same direction, in the opposite direction, and once in the table's own
arithmetic. Stated plainly so a later reader does not inherit them:

1. **The `3 failed, 6 passed` run is not the `iknow-pilot-v2` trial.** That
   trial's verifier log ends `uvx: command not found` and its
   `agent_result.metadata` is `null` — the agent phase was cut off by
   `AgentTimeoutError` before the ADR-0130 fields were ever written. The
   `3 failed, 6 passed` log belongs to `iknow-e2e-fixed/…__cU77yyL`, an
   **earlier** run of the same task (07:18Z vs 10:08Z) whose metadata does
   carry `turn_count: 40`, `iknow_error: max_turns_exceeded` and
   `eval_state: true`. The corrected claim is that **one** trial ran its tests,
   not that two did — the count is unchanged, but the trial behind it is a
   different one, and **the two `max_turns_exceeded` runs of
   `adaptive-rejection-sampler` are therefore not a matched pair**: same task,
   same turn budget, same stop reason, opposite verifier outcomes, one
   measurement and one broken measurement. A reader must not compare them.
2. **`adaptive-rejection-sampler` is `difficulty = "medium"`, not `hard`.**
   Read from `/tmp/tb21-dataset/terminal-bench-2-1/adaptive-rejection-sampler/task.toml`
   (`[metadata] difficulty = "medium"`, `expert_time_estimate_min = 180.0`).
   `dna-assembly` and `password-recovery` are genuinely `hard`;
   `overfull-hbox` and `prove-plus-comm` are `easy`; `polyglot-c-py` and
   `crack-7z-hash` are `medium`.
3. **The previous §3 table duplicated one trial and invented two turn counts.**
   It listed `iknow-pilot-7/prove-plus-comm` twice — rows 3 and 6, the second
   annotated with the same trial id `__WC6A9MM` as the first — and gave that
   single trial both `19 turns / completed` and `19 turns / completed`. There is
   **one** `prove-plus-comm` trial directory in `iknow-pilot-7`, its
   `result.json` records `exception_info.exception_type =
"NonZeroAgentExitCodeError"`, and its `agent_result.metadata` is `null`, so
   **no turn count and no stop reason exist for it at all**. The corrected
   row is row 7 above. This is why the reward-writing count moved 6 → 10 while
   the trial total moved 28 → 33 (§4.2): the new batch added 5 trials and 4
   rewards, and one previously double-counted row was removed.

### 3.1 `overfull-hbox` — the one model-attributable **pass**

`iknow-v5-window/overfull-hbox__T2FxRE5`, `reward.txt = 1`, and the verifier
log carries a real pytest summary for the first time in this pilot:

```
11  downloading uv 0.9.5 x86_64-unknown-linux-gnu
13  installing to /root/.local/bin
16  everything's installed!
...
87  ============================== 4 passed in 40.18s ==============================
```

`verifier/ctrf.json` names all four: `test_input_file_matches`,
`test_compilation_successful`, `test_no_overfull_hboxes`,
`test_main_synonyms_not_modified` — i.e. the four constraints the instruction
actually imposes. **`uvx` installed and pytest ran, so this reward is taken at
face value; it is the only one in this note that is.**

**What did not go the way the pass implies.** The agent hit the turn budget
_and_ the session was killed by the hard wall:

| field                                                                                                                                          | value                | source                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------- |
| `agent_result.metadata.turn_count`                                                                                                             | 40                   | `result.json`         |
| `agent_result.metadata.iknow_error`                                                                                                            | `max_turns_exceeded` | `result.json`         |
| `agent_result.metadata.permission_mode`                                                                                                        | `full_auto`          | `result.json`         |
| `agent_result.metadata.eval_state`                                                                                                             | `true`               | `result.json`         |
| `[violation] session killed: tier=mid tool=bash message=[permission_denied] [hard_wall] dangerous command: sensitive path targeted by command` | 1 occurrence         | `agent/iknow-ask.txt` |

So the precise statement is: **the model exhausted the 40-turn budget and
still delivered work the task's own tests accept.** Those are independent
facts, and the pass is the one that matters — "ran out of turns" and "did the
work" are not the same event, and here only the second one is scored. The
verifier, not the agent, decided the outcome.

**And a second harness finding, new in this batch (§6.2):** this trial's deny
is a **different hard-wall rule** from §6's. Its text is `dangerous command:
sensitive path targeted by command` with **no `id=` and no `pattern=`** — it
is the `commandContainsSensitivePath` branch of
`classifyDangerousExecute` (`src/harness/permission/hard-walls.ts:2899-2902`),
not the `verdict=malformed` parse branch. It is **not** the same false
positive, and it is **not** shown to be a false positive at all: the offending
command text was not retained, so whether the deny was correct cannot be
determined from what survives.

### 3.2 `adaptive-rejection-sampler` — the one model-attributable **fail**

**6 of 9 verifier tests passed.** Passing: the `ars` function exists; a test
function is present; modularity; error handling; input validation;
log-concavity.

Failing, by test:

- **Sample generation** — `Non-numeric argument to mathematical function`.
- **The formal `TEST_NAME: PASS/FAIL` output format** — the required contract
  was not emitted.
- **Required sample files absent.**

The run died inside the loop, not during install: `turn_count` reached the
40-turn budget and the harness reported `max_turns_exceeded` (`agent_exec`
878s). The function was written and four of five quality dimensions were met;
what was not met is runtime correctness on the sampler and the output contract.

**This is one medium task. It is a receipt, not a rate.**

### 3.3 `dna-assembly` — the reward is not the model's

The original note described this trial's failure mode as "PCR fragments
simulated, structural checks passed, final sequence mismatched, cut off at the
turn budget." **That description came from the agent's own stop summary, not
from test execution.** The summary is real and is quoted in
`agent/iknow-ask.txt`; it is a self-report by the model about its own work.
The trial's verifier log ends `uvx: command not found` — **the tests never
ran**. So:

- the agent-side facts (`turn_count: 40`, `max_turns_exceeded`, `agent_exec`
  1512s — 1.7x the `overfull-hbox` trial's, i.e. this task spent more of its
  wall clock inside the loop) are real and stand;
- the model's self-report of what it achieved is **not** verifier evidence and
  is not repeated here as a finding;
- the `0.0` is **not attributable to the model**, and the reported pass rate
  for this task does not exist.

The only defensible statement about `dna-assembly` is that the agent spent 40
turns and hit the budget, and that the harness's verifier could not install
its tooling.

### 3.4 `iknow-v7-proxy` — three valid passes, and the root cause finally identified

The `iknow-v7-proxy` batch is the first in this pilot where **five trials were
launched with a deliberate environment change** rather than a timing
accident, and it produced the first results that survive re-reading: **three
valid passes**, plus the cause of every broken measurement in §4.

| task                | difficulty | reward  | tests ran? | turn_count | stop                 | evidence                            |
| ------------------- | ---------- | ------- | ---------- | ---------- | -------------------- | ----------------------------------- |
| `password-recovery` | **hard**   | **1.0** | **YES**    | 18         | `completed`          | `2 passed in 0.09s`, ctrf `2/2`     |
| `polyglot-c-py`     | medium     | **1.0** | **YES**    | 18         | `completed`          | `1 passed in 0.19s`, ctrf `1/1`     |
| `prove-plus-comm`   | easy       | **1.0** | **YES**    | 17         | `completed`          | `4 passed in 0.45s`, ctrf `4/4`     |
| `dna-assembly`      | hard       | —       | **NO**     | —          | —                    | `install()` failed: nvm.sh download |
| `crack-7z-hash`     | medium     | 0.0     | **YES**    | 40         | `max_turns_exceeded` | `2 failed in 0.10s`, ctrf 0/2       |

**Each of the three passes was checked three independent ways**, because the
recurring failure in this pilot has been a reward that means nothing:

| trial               | `reward.txt` | pytest summary      | ctrf summary                             | broken markers | uv chain |
| ------------------- | ------------ | ------------------- | ---------------------------------------- | -------------- | -------- |
| `password-recovery` | `1`          | `2 passed in 0.09s` | `{'tests': 2, 'passed': 2, 'failed': 0}` | 0              | complete |
| `polyglot-c-py`     | `1`          | `1 passed in 0.19s` | `{'tests': 1, 'passed': 1, 'failed': 0}` | 0              | complete |
| `prove-plus-comm`   | `1`          | `4 passed in 0.45s` | `{'tests': 4, 'passed': 4, 'failed': 0}` | 0              | complete |

"broken markers" counts `uvx: command not found`, `Failed to connect`,
`Connection timed out` and `No such file or directory` in
`verifier/test-stdout.txt`; "uv chain" confirms `Installing uv` ->
`Downloading cpython-3.13.9` -> `Installed N packages` all appear, i.e. the
verifier bootstrapped its own runner from the network. All three turns
completed well inside the 40-turn budget (17, 18, 18), so these are
**completions, not budget exhaustions** — the first model-attributable results
in this pilot that are not `max_turns_exceeded`.

**`password-recovery` is the significant one: it is `difficulty = "hard"`,**
read from `/tmp/tb21-dataset/terminal-bench-2-1/password-recovery/task.toml`.
The pilot's other pass (`overfull-hbox`, §3.1) was `easy`. A hard task passing
at n=1 is still n=1 and is not a capability claim — but it is the first
evidence here that the harness does not merely scrape the easiest tier.

## 4. Trials that produced no score (23 of 33)

Across all ten jobs on disk there are **33 trial directories: 23 ended in an
exception before scoring, 10 wrote a reward, and they cover 10 distinct
tasks.** The 23 non-scoring trials are recorded here so the 2
model-attributable results in §3 are not read as agent results, and so the two
environment constraints that produced them are named as **requirements, not as
fixes that have been made**.

Exception types across the 33 trials, from each `result.json`:

| exception type              | count |
| --------------------------- | ----- |
| `NetworkConnectionError`    | 15    |
| `NonZeroAgentExitCodeError` | 6     |
| `IKnowGlibcRequiredError`   | 2     |
| `AgentTimeoutError`         | 1     |
| `AgentSetupTimeoutError`    | 1     |
| (none — scored normally)    | 8     |

**The dominant one is network, and it is measured to be intermittent rather
than binary.** This is the single most important thing to add in this batch,
because it changes how every other number here may be read.

| batch             | trials | agent-phase network failures                 | verifier-phase network failures |
| ----------------- | ------ | -------------------------------------------- | ------------------------------- |
| earlier jobs      | 28     | 15 × `NetworkConnectionError` in `install()` | 5 broken verifiers              |
| `iknow-v5-window` | 5      | **0** in the 4 that got past install         | **3** of those same 4           |

The v5 batch ran with **no proxy flags at all** (its `config.json` carries no
`environment` block and no `HTTP_PROXY`/`HTTPS_PROXY`/`172.31.*` string
anywhere), during a window when the network was measured open — 15/15 probes
green, `releases.astral.sh` included, which had been the verifier blocker in
every earlier batch. The 4 trials that reached the agent phase (§4.6) record
**zero** `Failed to connect` / `NetworkConnectionError` / `SSL_ERROR` lines in
their `trial.log`. Only the 5th trial, at install, hit `github.com`.

**This needs stating carefully, because "the network was open" is not the same
as "the network stopped blocking."** The v5 window was open **for the agent
phase**: all 4 trials that got past install ran without a single network error.
But **3 of those 4 then lost their verifier to the same block anyway** (§4.6)
— the `uv` download inside `test.sh` failed on `github.com`. So the v5 batch
still lost 4 of 5 trials to the network, just at a different phase than the
earlier batches did. What genuinely changed is narrower than "the outage
closed":

- **the agent phase stopped failing** (0/4, vs 15/28 across earlier jobs), and
- **the block lifted for one trial's verifier** (§3.1's pass), which is what
  produced the pilot's only model-attributable success.

**And the intermittency is directly visible inside this one batch.** The same
job, the same image, the same `test.sh`, the same flags, and minutes apart:
`overfull-hbox` installed `uv` and passed 4 tests, while its three siblings
timed out fetching the identical asset. No variable changed between them except
which seconds they ran in. That is the clearest evidence in this note that the
block is **stochastic and time-correlated**, not a property of any
configuration.

**"Open" is not a stable state, and neither is "closed."** The same day
produced 16/20 with failures in clusters and 20/20 with no proxy set; the
proxy host address itself moved (`172.31.128.1` -> `172.31.143.85`, §4.1). So
the correct statement is: **this environment intermittently blocks container
egress, in clusters, on a timescale of minutes**, in both the agent phase and
the verifier phase. Nothing here is a fixed property of the host.

**The consequence for reading results is the important part:** because the
block is stochastic, **outcomes across batches are not comparable unless the
trial actually reached the verifier.** A task that scored 0.0 in a blocked
window and 1.0 in an open window is not evidence that the model "sometimes
passes" — it is evidence that the same task is only measurable in an open
window. Only the 2 trials whose `tests ran?` column reads YES are comparable
to each other, and even they are n=1 on different tasks (§3).

### 4.1 Container egress is intermittent — and the `--ek` "fix" is **not** what it was taken to be

**The original 16/20 vs 8/8 probe is real, but the conclusion drawn from it
does not hold, and a direct test refutes it.** Recorded here as a correction,
because the obvious reading of those two numbers is wrong.

| arm               | command                                | result                                                                                         |
| ----------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| without proxy env | 20 sequential `curl -sS --max-time 20` | **16/20 (80%)** succeeded; failures **in clusters** (e.g. probes 9, 10, 12, 18 within one run) |
| with proxy env    | 8 sequential `curl -sS --max-time 20`  | **8/8 (100%)**; `apt-get update` exited 0                                                      |

The tempting conclusion is that `harbor run --ek HTTP_PROXY=… --ek
HTTPS_PROXY=…` injects the proxy into the task container and fixes the agent
phase as a pure CLI configuration. **That is not established, and the direct
test says it is false.**

**Decisive test.** A proxy pointed at a guaranteed-dead endpoint
(`--ek HTTP_PROXY=http://127.0.0.1:1 --ek HTTPS_PROXY=http://127.0.0.1:1`).
If the vars reached the container, **every** egress call would fail. Instead the
install completed normally:

```bash
# dead proxy via --ek, harbor run --install-only, prove-plus-comm
Total runtime: 1m 11s
ek-dead2 exception: None
# ...trial.log shows nvm install + bundle extract both "Command outputs captured"
```

**If `--ek` were reaching the container, this run could not have succeeded.**
It is the same behavior as a run with no `--ek` at all. The success of the
`--ek` job in the trial table is therefore **not** attributable to `--ek`.

**Mechanism, read from the installed harbor 0.23.0 source.** `--ek` populates
`config["environment"]["kwargs"]` (`harbor/cli/jobs.py:1730-1732`). The
environment factory then spreads those into the environment constructor as
bare `**config.kwargs` (`harbor/environments/factory.py:346-353`), while the
value that actually becomes container env is a **different** field,
`persistent_env=config.env` (`factory.py:350`). `BaseEnvironment.__init__`
accepts `**kwargs` and **never reads it** except to pop the deprecated
`suppress_override_warnings` — it does not merge kwargs into
`_persistent_env`. `_startup_env()` (`base.py:286-293`), which is what writes
`services.main.environment` (`docker/__init__.py:20-26`), is built from
`task_env_config.env` and `_persistent_env` only. So `--ek` kwargs land in a
parameter that is **swallowed**. Harbor's own source says as much: the comment
at `base.py:59` calls `--ek` "an interim fix … per-job configurability
(`environment.kwargs` / `--ek`) is a planned follow-up".

**What survives, and what does not:**

- **Survives:** container egress on this host is unreliable, and the
  original 16/20-with-clusters observation stands as a snapshot of a flaky
  path. A same-day re-measurement returned **20/20 with no proxy set** and
  **8/8 with** it, so neither ratio is a stable property of this machine. The
  WSL2 host address also moved during the day (`172.31.128.1` ->
  `172.31.143.85`) and the proxy was listening only on the old address, so any
  hard-coded proxy value goes stale silently.
- **Does not survive:** "`--ek` fixes the agent phase" / "this is a harbor CLI
  configuration, no adapter change needed". **The proxy mechanism is real and
  does work when the vars are genuinely present in the container** — verified
  directly: from a task image, `apt-get update` through
  `HTTP_PROXY=http://172.31.128.1:7890` exits 0, and the proxy is reachable
  from the container network. But **`--ek` is not the way to set it**, because
  `--ek` does not deliver the vars. Setting container env needs a path that
  populates `environment.env` (`persistent_env`), not `environment.kwargs` —
  a harbor config change, and **not verified to work here**. This note makes
  **no** claim that the agent phase is fixed, in either direction.

**A measurement trap, recorded so the probe is not repeated wrongly:** the
`alexgshaw/*:20251031` task images ship **no HTTP client at all**
(`curl`, `wget`, `python3`, `python` all absent), so an egress probe cannot
run inside a task image; and an early attempt to probe them "succeeded" with
`0/20` only because `curl` was missing, not because the network failed. Any
egress probe must use a separate image (`curlimages/curl`), which is **not**
the network namespace the verifier runs in.

### 4.1a The actual root cause: the container was never given the proxy at all

**This section replaces the framing used throughout §4 up to this point.**
Everything above describes the symptom — "container egress is intermittent",
"`github.com` is the single blocking host", "the outage is stochastic and
time-correlated". The measurements below say something different and simpler:
**the task container never received proxy environment variables, so its egress
was not intermittent — it was structurally broken, and the apparent
intermittency was the proxy's own variability leaking through.**

**The controlled A/B**, run on this host, same image, alternating arms:

| arm                                                                                   | probe                                                                                                           | result                                                                   |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `docker run ubuntu:24.04`, no proxy env                                               | `apt-get update`                                                                                                | **`E:` timeouts to `198.18.2.8` / `198.18.2.9`; `curl` not installable** |
| same container + `HTTP_PROXY=http://172.31.128.1:7890` (+ `http_proxy`/`https_proxy`) | `apt-get install curl`, then `github.com`, `raw.githubusercontent.com/nvm/v0.40.2/nvm.sh`, `archive.ubuntu.com` | **`curl` installed; `200`, `200`, `200`**                                |

The mechanism is the WSL2 fake-IP transparent proxy. Inside the container,
`archive.ubuntu.com` resolves to `198.18.2.9` and `security.ubuntu.com` to
`198.18.2.8` — addresses in the fake-IP range `198.18.0.0/15` that only the
proxy's TUN stack answers. A container with no `*_PROXY` variables attempts a
direct connection to a fake address and **must** time out. The host shell
works without any proxy env because it is on the other side of that TUN.

**`docker info` reporting a proxy is not the container having one.** The daemon
drop-in (`/etc/systemd/system/docker.service.d/proxy.conf`) sets
`HTTP_PROXY`/`HTTPS_PROXY` in the **daemon's** process environment, which is
what daemon-side image pulls use. It is not inherited by containers it starts.

**This is why §4's "intermittency" reading was wrong.** The clusters and the
same-second successes were the proxy at `172.31.128.1:7890` being variably
healthy, not the network layer choosing which hosts to block. It also explains
the "wrong host" bookkeeping in §3 — `releases.astral.sh`, `astral.sh` and
`github.com` were all reported as the failing host at different times purely
because **whichever request the proxy happened to drop first** is the one the
log names. There was never a per-host block list. **The "make
`releases.astral.sh` reachable" requirement stated in §4.2 is therefore wrong
and is withdrawn: no per-host allowlisting is needed, and no per-host
allowlisting was ever the problem.**

**The fix is two harbor flags, and it touches nothing in the benchmark.** No
`test.sh` was edited, so comparability with official TB scores is preserved.

| flag   | reaches                                         | mechanism, read from the installed harbor 0.23.0 source                                                                                                                                 |
| ------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--ae` | agent phase (`setup()` / `install()` / `run()`) | `trial.py:1572` and `trial.py:513` wrap setup and run in `agent_environment.scoped_exec_env(self.agent.extra_env)`; `base.py:425-441` merges it over `_persistent_env` for every `exec` |
| `--ve` | verifier phase                                  | `verifier.py:189-203` merges `task.config.verifier.env`, `verifier_env` and `override_env` into the env passed to the verifier's commands                                               |

Both channels are **separate**, which is exactly the gap that made §4.2 look
like a distinct and harder problem: fixing only `--ae` repairs `install()` and
leaves the verifier — which runs in `shared` mode in the same container, after
the agent has finished — still without a proxy. `--ve` is required as well.

**Verified end to end**, not inferred: `iknow-v7-proxy` ran five tasks with
both flags set. `password-recovery`, `polyglot-c-py` and `prove-plus-comm`
produced valid passes with the full `uv` bootstrap chain visible in
`verifier/test-stdout.txt` (§3.4) — `Installing uv` -> `Downloading
cpython-3.13.9-linux-x86_64-gnu` -> `Installed 8 packages` -> pytest summary.
That chain is the exact fetch that failed in every trial in §3's rows 3–10.

**What is still not solved by this.** The proxy fixes reachability, not
reliability: `dna-assembly` in the same batch still died in `install()` when a
single `nvm.sh` download failed under a working proxy, and a repeat probe of
the proxy arm itself returned `curl: command not found` because `apt-get
install` failed that time. The proxy is a **shared, single point of failure**
on this host, and it degrades. So the honest statement is "egress is now
_reachable_ rather than _structurally impossible_", and broken measurements
are still expected at some rate — lower, and no longer correlated with which
seconds a trial happened to run in.

**One measurement trap, added to §4.1's.** The A/B above was first run with a
100-second timeout and came back with `curl: command not found` in **both**
arms, which reads as "the proxy did not help" and is a false conclusion: the
timeout cut `apt-get install` short in both arms. Re-run with 280 seconds, the
proxy arm installed `curl` and returned `200 200 200` on six consecutive
probes. **An `apt-get install` that is cut off by a test harness timeout
looks identical to a network failure, and must not be read as one.**

### 4.2 The verifier phase is a separate, harder constraint — and it is currently the binding one

**The agent-phase network problem is not the main blocker. This is.** A TB 2.1
task's `tests/test.sh` bootstraps its own runner: it `curl`s the `uv` install
script from `astral.sh` and only then runs pytest. The verifier runs **in the
task container**, and from there that fetch is **unreachable** in this
environment. So the install fails, `uvx` is never on `PATH`, the task's tests
**never execute**, and harbor still writes `reward.txt = 0`.

That is the mechanism behind **8 of the 10 rewards in §3**. It is a
**benchmark-harness / environment constraint**, and it is **not** the same
constraint as §4.1: there the agent's own `install()` failed; here the
**verification** phase failed, after the agent had already finished and, in
three cases, after it had completed cleanly.

**The blocker is GitHub, not only Astral — this batch corrected the target.**
The `uv` install script's own download step is what fails, and the log names a
**different host per trial** (§3's table): `releases.astral.sh` in two earlier
trials, `astral.sh` in two, and **`github.com` in the three v5 breaks**,
where the asset fetch is
`https://github.com/astral-sh/uv/releases/download/0.9.5/uv-…tar.gz`. In
§3.1's passing trial the same fetch **succeeded** in an open window
(`downloading uv 0.9.5` -> `installing to /root/.local/bin` -> `4 passed`).
So the requirement is not "make `releases.astral.sh` reachable" — it is "make
the whole install path reachable", which spans `astral.sh` **and** the GitHub
release assets it redirects to.

**The one trial that proves this is solvable at all.** `overfull-hbox` in
`iknow-v5-window` ran the identical `test.sh`, on the identical image, in the
same job as three trials that broke — and its `uv` install and pytest run both
succeeded. Nothing was changed between them: no image, no flags, no adapter.
**The only difference was which trials happened to run while egress was
open**, which is the strongest evidence in this note that the blocker is the
environment's stochastic egress and not the harness. It also means the
constraint is **already lifted by waiting**, intermittently, with no code
change — which is why §4's intermittency finding and this section are the
same finding.

**How the verifier runs matters for any fix, and it is `shared` mode.** All
10 reward-writing trials, including the 8 that broke, record
`verifier_environment_mode: "shared"` (`result.json`). Harbor's
`resolve_trial_network_plan`
(`harbor/trial/network_policy.py:166-169`) sets, for `SHARED`,
`verifier_env_baseline = None` and
`verifier_phase_baseline = agent_env_baseline` — so the verifier's env
baseline **is the agent's container env**. The verifier is not a separate
container; it runs in the same one, which is why it hits the same
host→container path as the agent phase, and why §4.1 and §4.2 have a common
root cause even though they are different phases.

**`--ve` was tried and is inconclusive** — **this is now RESOLVED; see
§4.1a.** The paragraph as first written: one trial
(`iknow-ve-test/overfull-hbox__unVYg9r`) was run with **both** `--ek` and
`--ve HTTP_PROXY=… --ve HTTPS_PROXY=…`. It still failed — but in the **agent**
phase, on the nvm download (`NetworkConnectionError`), so its verifier never
ran and it said **nothing** about `--ve` either way. The two verifier failures
that carried evidence (`overfull-hbox__GSdo65A`, `prove-plus-comm__dFncUcg`)
both ran with `--ve` **unset**, so they established only the constraint.

**That test's real defect was that `--ek` was set and `--ae` was not.** The
trial's agent phase had no proxy because the agent-phase channel was never
used, so it died before reaching the phase `--ve` governs. §4.1a supplies the
missing test: `iknow-v7-proxy` set **`--ae` and `--ve` together**, and three
of its five trials completed the verifier's `uv` bootstrap over the network
and produced valid passes (§3.4). **So `--ve` does reach the verifier in
`shared` mode**, and the earlier "inconclusive" verdict was an artifact of
testing one channel while the other was left open.

**What resolved it** (a fix that **has** been made and **is** verified — this
replaces the "requirement, not a fix" wording this section carried):

- **proxy env on both phases, via `--ae` and `--ve`.** No benchmark file is
  edited, so the numbers stay comparable to official TB scores. Verified in
  `iknow-v7-proxy` (§3.4), with the mechanism in §4.1a.

The option that was preferred here — **a task image that already carries
`uv`/`uvx`** — remains unbuilt and remains the more robust of the two, because
it removes the verification-time network dependency entirely rather than
depending on a proxy being alive, and would make results **comparable across
windows** rather than dependent on the shared proxy at
`172.31.128.1:7890` being healthy at the moment a trial starts (§4.1a).

**The "open window" framing in §4 is retired.** The pilot originally read its
broken measurements as "the network happened to be closed when this trial
ran", and the fix was therefore to re-run trials during a good window. That
framing is wrong: there was no window, and waiting for one would not have
helped reliably. The constraint was structural (§4.1a) and is now addressed by
injection, so the correct remaining practice is narrower and unconditional:
**count only trials whose `tests ran?` column reads YES, and re-run the ones
that did not** — because a broken measurement is now a proxy failure, not bad
timing.

### 4.3 Retry policy was incomplete on our side

A retry job with `-r 3 --retry-include NetworkConnectionError --retry-include
NonZeroAgentExitCodeError` consumed **12 retries and produced zero scores**. One
task (`password-recovery`) failed as `AgentSetupTimeoutError`, which was **not**
in the include list, so harbor declined to retry it. Recorded as our gap, not
the harness's: the include list did not cover the error class the environment
actually produced.

### 4.4 Debian-12 task images are unscorable with this bundle — image constraint, not adapter

Task images are **not uniform**. Debian 12-based images (`fix-git`,
`cobol-modernization`, `nginx-request-logging` among those probed) ship
`libstdc++6 12.2.0-14+deb12u1`, whose highest symbol is **`GLIBCXX_3.4.30`**,
while the bundled `tree-sitter` prebuild requires **`GLIBCXX_3.4.31`**.

Measured in-container:

- `apt-get install libstdc++6` reports "already the newest version";
- bookworm-backports carries no newer build;
- the only source clearing 3.4.31 is **trixie's**, which pulls `libc-bin 2.41`
  and would change the task image's **glibc**.

That was **deliberately not done** — silently upgrading a task image's libc to
satisfy one addon changes the environment underneath a task that measures git
behaviour. The trial is refused with the ceiling named instead.

**So Debian-based task images cannot be scored with the current bundle, and
this needs a task-image change, not an adapter change.** The pilot's task set
was re-selected after this was found, to 7 Ubuntu 24.04 tasks. Probed
ceilings: `prove-plus-comm`, `overfull-hbox`, `crack-7z-hash`,
`polyglot-c-py`, `adaptive-rejection-sampler`, `password-recovery`,
`dna-assembly` all report `GLIBCXX_3.4.33`.

**This fix is now confirmed to work in a real scored trial.** §3.1's
`overfull-hbox` trial's `trial.log` line 3 reads
`libstdc++ already provides GLIBCXX_3.4.31 (ceiling GLIBCXX_3.4.33); no
install issued` — the `17b0c8ed7` probe ran, correctly decided no install was
needed, and the trial went on to `install()` -> `run()` -> a **passing**
verifier. This is the first end-to-end confirmation that the
`setup() -> install() -> run() -> verifier` path completes **with both
adapter fixes in place**, which §8 previously listed as outstanding.

### 4.6 The `iknow-v5-window` batch in full — and why 4 of 5 rewards are not scores

The batch ran with **no proxy flags** and direct egress, in a window where the
network was measured open (15/15 probes green). Its five trials, with the
evidence each verdict rests on:

| trial                        | difficulty | `reward.txt` | pytest summary in verifier log | broken markers                                    | verdict                                            |
| ---------------------------- | ---------- | ------------ | ------------------------------ | ------------------------------------------------- | -------------------------------------------------- |
| `overfull-hbox__T2FxRE5`     | easy       | `1`          | `4 passed in 40.18s` (line 87) | 0                                                 | **valid, model-attributable, PASS**                |
| `prove-plus-comm__kaHKYby`   | easy       | `0`          | none                           | 2 (`uvx: command not found`, `env: No such file`) | broken measurement                                 |
| `polyglot-c-py__w8TtZ6n`     | medium     | `0`          | none                           | 2 (same)                                          | broken measurement                                 |
| `password-recovery__ohB94RP` | hard       | `0`          | none                           | 2 (same)                                          | broken measurement                                 |
| `crack-7z-hash__m99zdqH`     | medium     | **absent**   | n/a                            | n/a                                               | install-phase failure, `NonZeroAgentExitCodeError` |

**4 of 5 wrote a reward; only 1 of those 4 executed the task's tests.** This is
the whole point of §3's `tests ran?` column, restated on a fresh batch: a
`reward.txt` is evidence that the verifier phase _terminated_, not that it
_judged anything_. Each verdict above was read from the files —
`result.json`, `verifier/reward.txt`, `verifier/test-stdout.txt` — by grepping
the verifier log for a pytest summary line and for broken-installer markers,
not by reading the reward.

**The fifth trial died before the verifier and is not in the reward count at
all.** `crack-7z-hash__m99zdqH` has **no `verifier/reward.txt`**: its
`result.json` records
`exception_info.exception_type = "NonZeroAgentExitCodeError"`, and
`exception.txt` shows the failure inside `install()`, at the nvm step —
`fatal: unable to access 'https://github.com/nvm-sh/nvm.git/': Failed to
connect to github.com port 443 after 133991 ms`. This is the **agent-phase**
constraint of §4.1, not the verifier one, and it is the batch's only network
error.

## 5. Analysis: Execution / Coherence / Verification

Grounded **only** in the trials in §3, and for the model-attributable reading
**only** in §3.1 and §3.2, at n=1 each. The TB paper's three axes are used as
the vocabulary; nothing wider is claimed.

### Execution — two observations, and only where a verifier ran

The failing scored trial demonstrates real command execution reaching task
state: `/app/ars.R` was written and sourced, and the failure is **not** an
off-PATH executable or a command that failed to take effect (TB's top
execution failure, 24.1% in the paper's census).
`adaptive-rejection-sampler`'s `Non-numeric argument to mathematical function`
is a **runtime correctness** failure inside a command that did run.

**The `dna-assembly` evidence is withdrawn from this section.** The earlier
version read the agent's self-reported "structural checks passed, final sequence
mismatched" as an execution-axis observation. That text is the model's own stop
summary, not a verifier result, and the task's tests never ran (§3.2). An
agent's account of its own work is not evidence about what the verifier saw.

**This run therefore gives no evidence for or against the paper's headline
execution failure mode** — of the two tasks whose verifier ran, one fails that
way and one does not, which is a property of a 2-sample, not a measurement of
the rate.

**A positive execution observation, from the other scored trial.**
`overfull-hbox` (§3.1) is the first trial in this pilot where the model
produced state the task's own tests accept, and it did so by actually
**compiling LaTeX**: the passing test set includes
`test_compilation_successful` and `test_no_overfull_hboxes`, plus
`test_main_synonyms_not_modified` and `test_input_file_matches` — i.e. the
model both ran the real toolchain to convergence and stayed inside the edit
constraint the instruction imposed. That is command execution reaching task
state in the strongest available sense, and it is worth recording precisely
because the failing trial's execution error is of a different kind
(runtime correctness inside a program that ran).

### Coherence — one observation, and it is a harness observation

Both model-attributable trials consumed the **entire 40-turn budget** and
reported `max_turns_exceeded`, and so did `dna-assembly` and the `overfull-hbox`
trial from `iknow-pilot-v4-proxy`. Whether the model was looping or making slow
progress is **not distinguishable** — the per-turn transcripts that would
separate those were not retained. This is recorded as "hit the budget", not as
a recovery-rate number.

**The passing trial makes this sharper, not softer.** `overfull-hbox` reached
40 turns and still scored 1.0, and its own retained stop summary says the
work was complete before the budget ran out ("The modified document compiled
successfully with 0 overfull boxes, 0 errors, and 5 pages") and that the model
was spending the remaining turns on a _cosmetic_ improvement it had already
satisfied. So "hit the turn budget" is **not** a predictor of failure here, and
it is **not** a proxy for looping. The correct reading of
`iknow_error: max_turns_exceeded` is "the run was truncated at 40 turns",
full stop — whether the truncation cost anything is a separate question that
this trial answers **no**.

**Counter-observations remain, and they are agent-side fact, not scores:**
`prove-plus-comm` **completed** at 22 turns (`iknow-proxy-test`) and at 16
turns (`iknow-v5-window`), and `password-recovery` completed at 32 turns, all
with `stop_reason: completed` and all well under the budget. So the sample
contains both behaviours, and no claim is made about whether those completed
runs were correct — none of their verifiers ran.

### Verification — no evidence

The `TEST_NAME: PASS/FAIL` output contract was one of the three failing tests
on `adaptive-rejection-sampler`. The harness's own three-value verify outcome
(`passed` / `not_run` / failed family) is a **model-visible prompt surface** and
is **not exercised by Terminal-Bench 2.1 at all**: TB scores final state with
programmatic tests, and its verifier is the task's, not ours. Nothing about our
verify-status honesty contract is measured by any of these trials. That surface
remains covered only by its own golden set.

### 5.1 Failure taxonomy mapped onto harness subsystems

For each subsystem, either an observation **from these trials**, or an
explicit statement that it was not exercised and why.

| subsystem            | observation from this run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **hard-wall**        | **Exercised twice, and the two denies are different rules.** (a) In the `iknow-e2e-fixed` `adaptive-rejection-sampler` trial, a **fail-closed false positive**: the deny is `pattern="verdict=malformed"`, i.e. "the bash parser could not produce a clean tree" (typically an unclosed quote), carrying **nothing about the command's content being dangerous**; at least three such denies occurred (§6). (b) In the `iknow-v5-window` `overfull-hbox` trial, **one** deny of a different class — `dangerous command: sensitive path targeted by command`, with no `id=`/`pattern=`, from the `commandContainsSensitivePath` branch. Whether that one was a false positive is **not determinable**; the command text was not retained (§6.2).                                                    |
| **permission chain** | Not exercised as a denial. `full_auto` granted what was asked of it in every trial; no `permission_denied` from the ask path was recorded. The `[permission_denied]` prefix on both §6 and §6.2's lines is the hard-wall's own prefix, not a separate permission-chain stop. The trace of `prove-plus-comm` also shows a write denied as out-of-workspace (`path outside workspace: /workspace/plus_comm.v not under /root/iknow`), which is the which-tree axis, not a permission-chain denial.                                                                                                                                                                                                                                                                                                   |
| **bash fence**       | **Out of scope by construction.** The bwrap fence retires wholesale in eval state (ADR-0130 §2), so no number here measures it. What remains is the which-tree axis, and writes did land on the task root (`overfull-hbox` edited `/app/input.tex` and the task's own test for that passed) — but with 2 scored trials, no controlled comparison and a different adapter state on each, that is an observation, not a measurement.                                                                                                                                                                                                                                                                                                                                                                 |
| **verify status**    | **Not exercised, and not measurable by TB.** See §5 — the task's own verifier replaced ours; our three-value outcome surface is a prompt surface TB does not touch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **tool selection**   | Weakly exercised: the model used `bash` and, on `adaptive-rejection-sampler`, wrote a test function. Whether the **right** tool was chosen against the available alternatives is **not recoverable** — no per-turn tool-choice trace was retained for either scored trial, and the one thing §3.1's retained output does show is the model **building a batching evaluator to drive `pdflatex` through many candidate substitutions per run**, i.e. choosing a tool strategy rather than editing blindly. The one trial that _did_ retain a full trace (`iknow-proxy-test/prove-plus-comm`) shows `bash` alongside `glob`, `grep` and `write_file`, with two denials for using `bash` where `grep`/a directory walk belonged; it is a single unverified run, so it is an illustration, not a rate. |

## 6. Harness finding 1: a hard-wall false positive

Observed in `iknow-e2e-fixed/adaptive-rejection-sampler__cU77yyL` — the same
trial the original note called "the first scored trial", and the same text; the
finding is unchanged, only the trial's identity in §3 has been corrected:

```
[violation] session killed: tier=mid tool=bash message=[permission_denied] [hard_wall] dangerous command pattern matched (id=unparseable, pattern="verdict=malformed")
```

**The offending command text is not recoverable.** The container was deleted, and
`agent/iknow-ask.txt` holds only the eval-state banner, this line, and the stop
summary. No command text is quoted or reconstructed here, because none survives
to be read.

**Mechanism** (code paths, verified in the current tree):

- `src/harness/permission/hard-walls.ts:1042-1047` — `routeParseVerdict` maps
  parse verdict `malformed` to `{ id: "unparseable", pattern: "verdict=malformed" }`.
- `src/harness/permission/shell-parse.ts:755-760` — `verdictOfTree` classifies a
  tree-sitter parse tree carrying ERROR/MISSING nodes (outside the
  commandless-operator-body exception) as `malformed`.

So the deny's text says **the bash parser could not produce a clean tree** —
typically an unclosed quote — and says nothing about the command's content being
dangerous. A reader seeing `dangerous command pattern matched` alongside
`id=unparseable` would reasonably read it as a content verdict; it is not one.

**Verdict: a fail-closed false positive of exactly the class ADR-0130 §2
predicted** ("Expect it to fire on legitimate benchmark commands; that is a
finding about the wall's false-positive rate").

**This is already pinned as intended behavior, and that is the load-bearing
context:**

- `tests/harness/permission/substitution-matrix.test.ts:2305-2323` — a benign
  English heredoc body (`python3 <<'EOF' / It's a note about the (fix / EOF`) is
  asserted to be **denied in every mode**, producing exactly this
  `{id: "unparseable", pattern: "verdict=malformed"}` hit.
- `tests/harness/permission/sensitive-path-command.test.ts:148-160` — a
  `python3` heredoc body is documented as answering `unparseable` /
  `verdict=malformed` "so today the dangerous-pattern wall reports it first."

**Blast radius in a benchmark run:** a `[hard_wall]` message classifies as
**mid** tier (`src/harness/sandbox/violation-handling.ts:138-140`) and mid-tier
kills at threshold **3** (`DEFAULT_MID_THRESHOLD = 3`,
`src/harness/sandbox/violation-handling.ts:54`, accumulate-and-kill at `:74`).
So the kill line means **at least three** such denies occurred. In a
40-turn benchmark turn budget that is a real capability cost: 3.75% of the
budget per kill is survivable once, not repeatedly.

**Why this is not a `prompt-development.md` roster row.** The hard wall is a
**code gate**, not a model-visible prompt surface: the model never sees the
matcher, only the deny text. That guide's roster covers prompt and assembly
surfaces, and its own principle 5 (`docs/guides/prompt-development.md:30`) puts
token-matching vetoes in code. A trajectory set cannot observe a decision this
code makes on its own. **Its home is this evidence note**, and the finding is
deliberately not registered as a gap in that table.

### 6.2 Harness finding 2: a **different** hard-wall deny, in the passing trial

The `overfull-hbox` trial that produced the pilot's only **pass** carries its
own hard-wall denial (`agent/iknow-ask.txt`):

```
[violation] session killed: tier=mid tool=bash message=[permission_denied] [hard_wall] dangerous command: sensitive path targeted by command
```

**This is not §6's finding, and it must not be folded into it.** Three
differences, all verifiable:

|                              | §6 (`adaptive-rejection-sampler`)                                                 | §6.2 (`overfull-hbox`)                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| message                      | `dangerous command pattern matched (id=unparseable, pattern="verdict=malformed")` | `dangerous command: sensitive path targeted by command`                           |
| carrying `id=` / `pattern=`? | yes                                                                               | **no**                                                                            |
| source branch                | `findDangerousPattern` -> parse verdict `malformed`                               | `commandContainsSensitivePath` (`src/harness/permission/hard-walls.ts:2899-2902`) |
| classification               | a **parse** failure, carrying nothing about the command's content                 | a **content** verdict: the command named a sensitive path                         |

The source is explicit that this is a distinct second branch of the same
decision function, placed after the redirect exemption so that
`echo x > /etc/shadow` is still denied:

```ts
if (commandContainsSensitivePath(command)) {
  return "dangerous command: sensitive path targeted by command";
}
```

**Verdict: undetermined, and deliberately not called a finding.** A
sensitive-path deny on a benchmark task is **plausibly correct** — many task
instructions involve writing under paths the wall treats as sensitive, and the
LaTeX task in particular hands the model a document tree. Whether this deny
was a false positive **cannot be decided from what was retained**: the
container was deleted and `agent/iknow-ask.txt` holds the banner, this line,
and the stop summary — no command text, and no per-turn trace. Guessing either
way would be exactly the error this note has already had to correct twice.

**What is nonetheless worth recording:** the wall fired in **both**
model-attributable trials — the one that passed and the one that failed. Two
observations of a hard-wall denial in two trials is not a rate, but it does
establish that the wall is **actively firing on this task set**, which is the
precondition ADR-0130 §2 named. And it sharpens §6's own blast-radius note: the
kill threshold is 3 mid-tier violations **counted across all hard-wall rules**,
not 3 of one rule, so a task can accumulate denies from two different branches
and trip the kill on a mix.

**The pass is not diminished by this, and should not be read as diminished.**
The session was killed by the wall, yet the trial still scored `1.0`: the work
the model had already committed to disk satisfied all four of the task's tests.
That is a fact about the harness's ordering — the verifier judges final state,
not whether the session was killed — and it is the reason §3.1 states the
outcome as two independent facts (budget exhausted, work accepted) rather than
as a compromised single event.

## 7. Adapter defects found and fixed

Both committed; both were found by running real trials, not by reading code.
**Neither conclusion is softened by the §3 corrections** — and §4.4 now adds
positive confirmation: the C++-runtime probe ran in the `overfull-hbox` trial
that scored `1.0`, decided no install was needed on a `GLIBCXX_3.4.33` image,
and the trial continued to a passing verifier.

### `68a3f0843` — node resolved from an unsourced shell; smoke-test misattribution

`_ensure_node` resolved node with `command -v node` in a shell that had **not
sourced nvm**, so the `ln -sf` was silently skipped and every later bare `exec`
saw no node. A trial died at install with
`bash: line 1: node: command not found`, and it was **misreported as
`IKnowGlibcRequiredError`** on an Ubuntu 24.04 / glibc 2.39 image — an image
that satisfies the requirement. (That trial is `iknow-e2e-first`, which
recorded **no reward at all**; the original note called it "a scored trial",
which is wrong on both counts — see §3.0.) The node binary is now located from
the nvm tree's own layout and never from an ambient PATH.

The same commit split the smoke-test **attribution**: a failure-text matcher
was matching the dynamic loader's `"No such file or directory"` and
misattributing a real native-addon failure as a missing node. The first leg
now prints a marker, and that marker decides "did node run" — node not
runnable at all is `IKnowNodeUnavailableError`; node having run and then failed
to load the addons is `IKnowGlibcRequiredError`.

### `17b0c8ed7` — `_ensure_cpp_runtime`

Probes the image's `GLIBCXX` ceiling, installs the distro `libstdc++` when below
`GLIBCXX_3.4.31`, and raises `IKnowCppRuntimeTooOldError` naming **both** the
ceiling found and the version required when the ceiling does not move.

The requirement was **measured from the shipped prebuilds**, not read off a
failure message: `tree-sitter` needs `GLIBCXX_3.4.31`, `tree-sitter-bash`
tops out at `GLIBCXX_3.4.21`, and every other `linux-x64` addon in the closure
(`lightningcss`, `rollup`, `tailwindcss-oxide`, `lzma`) needs only
`GLIBC_2.14`. So `GLIBCXX_3.4.31` is the single binding requirement.

**Test count: adapter pytest 56 -> 109 across the two commits**, each new test
mutation-checked (delete/reorder the `install()` call, hoist `|| true` out of
the probe loop, restore `sort -u -V | tail -1` or plain `sort -u | tail -1`,
drop `apt-get update` or the `DEBIAN_FRONTEND` env, force the distribution-
ceiling message on a failed install, take the ceiling maximum by byte order,
drop the `isascii()` guard, remove the guarded manager lookup — each fails at
least one named test).

## 8. What is not measured

Stated plainly, so this note is not over-read.

- **No capability number, and only 2 trials carry a model-attributable
  result.** 10 trials wrote a reward; in 8 of them the task's tests never
  executed (§3, §4.2). **Exactly 2 trials ran their tests**: one scored 0.0 on
  a **medium** task (`adaptive-rejection-sampler`) and one scored **1.0** on an
  **easy** task (`overfull-hbox`). **These two must not be divided.** They are
  different tasks, from different jobs, in different difficulty bands, at n=1
  each, with a 40-turn budget hit in both. "1 of 2" is not a pass rate, not a
  50%, and not a capability estimate — it is two receipts of opposite sign.
  Presenting it as any of those would be the same class of error this note has
  already corrected twice. There is no mean reward, no per-difficulty band
  (one observation per band, in bands that differ), no per-category
  breakdown, and no comparison against any other agent. #1167's report item
  asked for those; **at n=1 per task they would be fabricated**, so they are
  omitted rather than estimated.
- **No breadth.** 79 of 89 tasks were not attempted (33 trials across 10 jobs,
  10 distinct tasks). 23 trials produced no score for the environment reasons
  in §4. **All 7 pilot tasks have now been attempted, but only 2 of the 7 have
  ever reached a working verifier**; the other 5
  (`prove-plus-comm`, `crack-7z-hash`, `polyglot-c-py`, `password-recovery`,
  `dna-assembly`) are unmeasured, every trial of each having been lost to a
  broken verifier or a pre-verifier install failure. That is the shape of the
  remaining work: **5 of the 7 pilot tasks need one trial in an open network
  window each**, not a new harness capability.
- **No cross-batch comparability.** Because the environment's egress block is
  intermittent and arrives in clusters (§4), a trial's outcome is conditioned
  on which window it ran in. Two batches of the same task are **not**
  comparable unless both reached the verifier. This is why §3.0 calls the two
  `adaptive-rejection-sampler` runs a non-matched pair, and why the
  `iknow-v5-window` pass cannot be read as "the model sometimes passes".
- **No verifier evidence beyond the 2 trials.** The other 8 rewards measure a
  verifier that could not install `uvx` (§4.2), not the model.
- **No retry-policy effectiveness.** 12 retries were consumed and produced
  zero scores; the policy itself was incomplete (§4.3), so the number measures
  our config, not harbor's retry logic.
- **No verified proxy fix.** The proxy mechanism works when the vars are
  genuinely in the container, but **no way of injecting them has been shown to
  work** — `--ek` is refuted by a dead-proxy test (§4.1) and `--ve` remains
  untested and inconclusive (§4.2). Agent-phase egress is therefore **not**
  claimed as solved. The v5 batch's clean network was **not** a proxy
  achievement: it ran with no proxy flags at all and simply landed in an open
  window.
- **No background / subagent / verify-sandbox-run evidence.** Structurally
  absent (§2).
- **No fence evidence.** Retired in eval state (§2).
- **No verify-status evidence.** Not reachable from TB at all (§5).
- **No tool-selection rate.** Per-turn traces were not retained for either
  model-attributable trial.
- **No loop diagnosis, and `max_turns_exceeded` is not a failure signal.**
  Both model-attributable trials hit the 40-turn cap, and one of them **passed
  anyway** (§3.1, §5 Coherence). The stopped-at-budget observation is
  independent of the outcome, and the retained per-turn transcripts that would
  separate looping from slow progress were not kept. Runs that completed
  cleanly under budget (`prove-plus-comm` at 22 and 16 turns,
  `password-recovery` at 32) were all unverified, so they carry no evidence
  either way.
- **No hard-wall false-positive _rate_, and the second deny is unclassified.**
  §6 is one observation in one trial; §6.2 is a **different** wall rule in the
  other trial whose correctness cannot be determined without the command text.
  Both command texts are unrecoverable. The mechanisms are pinned by repo
  tests; the benchmark-specific rates are unmeasured.
- **The offending commands are not recovered and are not guessed** (§6, §6.2).
- ~~**Post-fix `install()` in a real container.**~~ **This is now satisfied and
  withdrawn from this list.** It previously read that the full harbor-driven
  `setup() -> install() -> run() -> verifier` sequence had never run to
  completion with both adapter fixes in place, because the one scored trial
  predated the C++-runtime fix. The `iknow-v5-window/overfull-hbox` trial
  contradicts that: its `trial.log` shows the `GLIBCXX` probe running and
  correctly short-circuiting (`no install issued`, ceiling `3.4.33`), the nvm
  node link step, the bundle extract, and then a **passing** verifier (§4.4).
  A scored trial on the fully fixed adapter now exists.

## 8.5 The 7-task pilot, final table

Batches `iknow-v7-proxy` … `iknow-v9-se-batch1`, `iknow-v10-se-batch2` and the
`iknow-seq-*` sequential queues, all with `--ae` + `--ve` proxy injection
(§4.1a) and, from `iknow-v10` on, `--ak trace_out=true`.

**The validity rule used throughout.** A reward counts only when **all three**
hold:

1. `verifier/ctrf.json` exists — ctrf is written **only** when pytest runs to
   completion, so this is the load-bearing signal, not the reward file;
2. `verifier/test-stdout.txt` carries a real `N passed` / `N failed` line;
3. the count of `uvx: command not found` / `Failed to connect` /
   `Connection timed out` / `network timeout` markers is zero.

Harbor writes `reward.txt = 0` when the verifier cannot install its tooling,
so **a reward file alone is not evidence**. This rule was load-bearing: it
caught `torch-tensor-parallelism`, which wrote `reward = 0.0` with **no
`ctrf.json` at all** because the verifier timed out downloading a 1.8 GB torch
stack. Read on the reward alone it would have been recorded as a model failure.

| verdict      | n   | what it means                                                                                |
| ------------ | --- | -------------------------------------------------------------------------------------------- |
| **VALID**    | 18  | verifier ran the tests; the reward is a score (6 pass, 12 fail)                              |
| **ENV**      | 15  | image cannot clear the `GLIBCXX_3.4.31` floor; agent never ran, no model evidence either way |
| **BROKEN**   | 2   | reward written but tests never executed (uv download timeouts)                               |
| **UNPULLED** | 9   | the image could not be pulled at all; verdict not yet known                                  |

### The six valid passes

| task                | difficulty | evidence                       |
| ------------------- | ---------- | ------------------------------ |
| `overfull-hbox`     | easy       | `4 passed in 40.18s`           |
| `prove-plus-comm`   | easy       | `4 passed in 0.45s`, ctrf 4/4  |
| `polyglot-c-py`     | medium     | `1 passed in 0.19s`, ctrf 1/1  |
| `git-leak-recovery` | medium     | `5 passed, 1 warning in 0.25s` |
| `password-recovery` | **hard**   | `2 passed in 0.09s`, ctrf 2/2  |
| `polyglot-rust-c`   | **hard**   | `1 passed in 0.94s`, ctrf 1/1  |

**Two of the six are `hard`.** Together with the twelve valid fails this is
the first evidence in this pilot that the harness is not confined to the easy
tier in either direction. It is still n=1 per task and **is not a pass rate**.

### The image constraint is Debian 12, not "Debian"

The C++ floor is a property of the **image**, and it is a clean split:

| base                     | measured `GLIBCXX` ceiling | outcome  |
| ------------------------ | -------------------------- | -------- |
| Ubuntu 24.04 (noble)     | `3.4.33`                   | runs     |
| **Debian 13 (trixie)**   | `3.4.33`                   | **runs** |
| **Debian 12 (bookworm)** | `3.4.30`                   | blocked  |

`build-pmars` and `winning-avg-corewars` are Debian and **do** run, while
`headless-terminal` is nominally Ubuntu and **does not** — so the usable
predicate is the measured ceiling, never the base-image name. The requirement
comes from the bundled `tree-sitter` linux-x64 prebuild, whose highest
undefined symbol is `GLIBCXX_3.4.31` (verified with `strings` on the shipped
`prebuilds/linux-x64/tree-sitter.node`); `tree-sitter-bash` needs only
`3.4.21`. §9 item 2's earlier phrasing, "Debian-based tasks", was too broad
and is corrected here.

### A measurement trap, recorded

The 9 `UNPULLED` rows were first recorded as "the image has no readable
`libstdc++`". **That reading was wrong.** The precheck's `docker run` could not
obtain the image at all, because the docker daemon reaches Docker Hub only
through the proxy, and the proxy was down: `CONNECT tunnel established,
response 200`, then `TLS alert, decode error` /
`unexpected eof while reading` on the handshake. **An empty probe result means
"probe could not run", not "probe found nothing"** — the same confusion as the
`apt-get install` timeout in §4.1a, and the reason those 9 tasks are labelled
`UNPULLED` rather than `ENV`.

## 8.6 The full run: 36 tasks run, 19 valid results

Every trial directory under `/tmp/tb21-iknow/jobs/` was rescanned from its own
`result.json` and `verifier/` output to produce the counts below. **An earlier
hand-maintained table was discarded rather than patched**: it had silently
dropped `overfull-hbox` and `adaptive-rejection-sampler` because it had been
assembled by merging only the later batches. A count is only worth publishing
if it can be regenerated from the artifacts, so the table is now derived.

**The validity rule.** A reward counts only when **all three** hold:

1. `verifier/ctrf.json` exists — ctrf is written **only** when pytest runs to
   completion, so this is the load-bearing signal, not the reward file;
2. `verifier/test-stdout.txt` carries a real `N passed` / `N failed` line;
3. the count of `uvx: command not found` / `Failed to connect` /
   `Connection timed out` / `network timeout` markers is zero.

Harbor writes `reward.txt = 0` when the verifier cannot install its tooling, so
**a reward file alone is not evidence**. The rule earned its keep twice:
`torch-tensor-parallelism` wrote `reward = 0.0` with **no `ctrf.json` at all**,
its verifier having timed out downloading a 1.8 GB torch stack, and
`caffe-cifar-10` did the same. On the reward alone both would have been filed as
model failures.

| verdict      | n   | what it means                                                                                 |
| ------------ | --- | --------------------------------------------------------------------------------------------- |
| **VALID**    | 19  | verifier ran the tests; the reward is a score — **6 pass, 13 fail**                           |
| **ENV**      | 12  | image ceiling below the `GLIBCXX_3.4.31` floor; agent never ran, no model evidence either way |
| **BROKEN**   | 2   | reward written but tests never executed (uv download timeouts)                                |
| **UNPULLED** | 3   | trial never started; the image could not be pulled (proxy down)                               |

Six further tasks were precheck-skipped without ever reaching a trial directory
and are counted separately as **attempted-but-unrun**, not as results.

### The six valid passes

| task                | difficulty | evidence                       |
| ------------------- | ---------- | ------------------------------ |
| `prove-plus-comm`   | easy       | `4 passed in 0.45s`            |
| `overfull-hbox`     | easy       | `4 passed in 40.18s`           |
| `polyglot-c-py`     | medium     | `1 passed in 0.19s`, ctrf 1/1  |
| `git-leak-recovery` | medium     | `5 passed, 1 warning in 0.25s` |
| `password-recovery` | **hard**   | `2 passed in 0.09s`, ctrf 2/2  |
| `polyglot-rust-c`   | **hard**   | `1 passed in 0.94s`, ctrf 1/1  |

**Two of the six passes are `hard`, and hard tasks are the majority of the
valid results** (10 of 19). The harness is not confined to the easy tier in
either direction: hard tasks appear among both the passes and the fails.

**Do not read 6/19 as a rate.** The tasks were not sampled, every one is n=1,
and 12 of the 17 attempted hard tasks landed in the ENV bucket for a reason
that has nothing to do with the model (§ below). The number that is defensible
is the mechanism, not the fraction: `setup() -> install() -> run() -> verifier`
completes, and both outcomes are measurable.

### The image constraint is Debian 12, not "Debian"

The C++ floor is a property of the **image**, and the split is clean:

| base                     | measured `GLIBCXX` ceiling | outcome  |
| ------------------------ | -------------------------- | -------- |
| Ubuntu 24.04 (noble)     | `3.4.33`                   | runs     |
| **Debian 13 (trixie)**   | `3.4.33`                   | **runs** |
| **Debian 12 (bookworm)** | `3.4.30`                   | blocked  |

`build-pmars` and `winning-avg-corewars` are Debian and **do** run;
`headless-terminal` is nominally Ubuntu and **does not**. The usable predicate
is the measured ceiling, never the base-image name — an earlier version of
this note said "Debian-based tasks", which was too broad and was filtering
real tasks out of the run. The requirement comes from the bundled `tree-sitter`
linux-x64 prebuild, whose highest undefined symbol is `GLIBCXX_3.4.31`
(verified with `strings` on the shipped `prebuilds/linux-x64/tree-sitter.node`);
`tree-sitter-bash` needs only `3.4.21`. The sequential runner now prechecks the
measured ceiling per image, so a blocked task costs no trial.

### Two measurement traps, both recorded because both produced false readings

1. **An `apt-get install` cut off by a test-harness timeout looks exactly like a
   network failure** (§4.1a). The first A/B ran with a 100 s timeout and
   returned `curl: command not found` in _both_ arms, which reads as "the proxy
   did not help" and is false.
2. **An empty probe result means the probe could not run, not that it found
   nothing.** Six tasks were first recorded as "the image has no readable
   `libstdc++`". That was wrong: the precheck's `docker run` could not obtain
   the image at all, because the docker daemon reaches Docker Hub only through
   the proxy, and the proxy was down — `CONNECT tunnel established, response
200`, then `TLS alert, decode error` / `unexpected eof while reading` on the
   handshake. They are labelled **UNPULLED** and carry no verdict until
   re-checked.

## 9. What remains

Ordered by what actually blocks a number. **Items 3 and 5 are discharged**;
the rest are scale and environment, not research.

1. **Run the remaining tasks, and raise n above 1.** The mechanism is fixed
   (`--ae` + `--ve`, §4.1a) and 36 of 89 tasks have been run with 19 valid
   results, so this is no longer a research item — it is scale. What blocks a
   rate is **breadth and n**: every one of the 19 results is n=1, so no task
   has a variance estimate and no task can be compared against itself.
2. **A task image with a new-enough C++ runtime, for the Debian 12 tasks
   specifically.** 12 tasks sit in the ENV bucket and none of them is a model
   result in either direction. This is **not** an adapter change and **not**
   "all Debian tasks" — Debian 13 (trixie) images run today (§8.6); it is the
   bookworm set alone. Until those images are replaced, roughly a third of the
   dataset is unmeasurable with this bundle, and the hard band is
   disproportionately affected.
3. ~~**A correct way to inject a proxy into the task container.**~~
   **RESOLVED — `--ae` for the agent phase and `--ve` for the verifier phase
   (§4.1a), verified by valid passes in `iknow-v7-proxy` and every batch since.**
   `--ek` was the wrong flag and is refuted (§4.1). **The residual is real and
   was re-confirmed on this run:** the proxy at `172.31.128.1:7890` is a single
   shared point of failure, it degrades under load, and it eventually went down
   outright (`CONNECT tunnel established`, then `TLS unexpected-eof` on the
   handshake). That took 6 tasks out of the run as UNPULLED. Any future run must
   re-check the proxy first and treat an unreachable registry as a stop
   condition, not as a per-task failure.
4. **A retry policy that includes the error classes the environment actually
   produces** — `AgentSetupTimeoutError` was missing (§4.3), and
   `NonZeroAgentExitCodeError` is currently used as a proxy for "the network
   blocked the install", which it is not: `crack-7z-hash__m99zdqH` is a
   network failure wearing that class (§4.6). Retries also do not help the
   image constraint: `IKnowCppRuntimeTooOldError` is deterministic, and
   re-running a bookworm task three times costs three trials and yields the
   same answer.
5. ~~**Retain per-turn trajectories.**~~ **RESOLVED — `--ak trace_out=true`
   (commit `ea4caa29b`).** The trace lands at `agent/trace/<uuid>.jsonl` in the
   trial directory, and the metadata records `trace_state` = `present` / `empty`
   / `absent` so a missing trajectory is never ambiguous. Verified in a real
   run: a trial produced 123 records (41 `llm_call`, 42 `tool_call`, 40 `turn`).
   **The loop diagnosis and the §6.2 deny classification are now possible and
   have not yet been done** — that is the remaining work, not the capture.
6. **A run wide enough to report a number.** The report item in #1167 is
   _partially_ delivered: the harness, the adapter, and the measurement
   procedure are working end to end and have now produced both a pass and a
   fail; the capability estimate is not, and needs items 1 and 5 first. **The
   binding limit on any rate is n=1 per task, not the environment** — even a
   perfect run of all 89 tasks once would give n=1 everywhere, so re-runs per
   task are required, not just breadth.
