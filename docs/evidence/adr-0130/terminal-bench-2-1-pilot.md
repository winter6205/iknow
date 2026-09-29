# Evidence: iknow on Terminal-Bench 2.1, first scored pilot (#1167, 2026-09-29)

External-capability measurement of the iknow harness driving
`minimax-cn/MiniMax-M3.1-Flash-Preview` over
`terminal-bench/terminal-bench-2-1`, under ADR-0130 eval state.

**Headline: 2 scored trials, both reward 0.0, 0/2 passing.** With n=2 this is
not a capability estimate. It is a first end-to-end proof that
`setup() -> install() -> run() -> verifier` completes, plus the first real
harness behavior observed inside a task container. **ADR-0130 §5: every number
below is eval state and is named as such. None of it is evidence about the
fence.**

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

**n=2.** Every taxonomy reading in §5 is grounded in the observed behavior of
these two trials and nothing wider. It is a receipt for two runs, not a
rate.

## 3. Scored trials (n=2, both hard)

| task                                        | difficulty | reward | turn_count | iknow_error          | agent_exec |
| ------------------------------------------- | ---------- | ------ | ---------- | -------------------- | ---------- |
| `terminal-bench/adaptive-rejection-sampler` | hard       | 0.0    | 40         | `max_turns_exceeded` | 878s       |
| `terminal-bench/dna-assembly`               | hard       | 0.0    | 40         | `max_turns_exceeded` | 1512s      |

Both runs died in the loop, **not at install**: `turn_count` reached the 40-turn
budget, and the harness reported `max_turns_exceeded`. Both install-time probes
were green (§1), so the native-addon and node paths cleared before the model
ever took a turn.

**Attribution fields.** Harbor reported `exception_info: null` for the second
run and `AgentTimeoutError` for the first. Trial metadata carried
`eval_state: true`, `permission_mode: full_auto`, `turn_count: 40`,
`iknow_error: max_turns_exceeded` — the ADR-0130 §5 fields, so these two
numbers are attributable to the posture they were produced under.

### 3.1 `adaptive-rejection-sampler`

**6 of 9 verifier tests passed.** Passing: the `ars` function exists; a test
function is present; modularity; error handling; input validation;
log-concavity.

Failing, by test:

- **Sample generation** — `Non-numeric argument to mathematical function`.
- **The formal `TEST_NAME: PASS/FAIL` output format** — the required contract
  was not emitted.
- **Required sample files absent.**

Both 40-turn runs on this task died inside the loop, not during install. The
function was written and four of five quality dimensions were met; what was not
met is runtime correctness on the sampler and the output contract.

### 3.2 `dna-assembly`

PCR fragments, sizes, overhangs and a 3591-bp circular assembly were all
simulated, and the structural checks passed. The final sequence did **not**
exactly match the target, and the last debugging round was cut off by the turn
budget (`agent_exec` 1512s — 1.7x the other task's, i.e. this task spent
substantially more of its wall clock inside the loop before the cap).

## 4. Unscored: environment, not harness (12 trials, 0 rewards)

These produced **zero scores and zero model turns**. They are recorded so the
2/89 coverage in §3 is not read as an agent result.

### 4.1 Container egress is intermittent

20 sequential probes from a plain container: **16/20 succeeded (80%)**. Failures
arrive **in clusters**, not uniformly — e.g. probes 9, 10, 12, 18 failed within
one run. Host egress was **100% throughout**, including runs with the proxy env
vars unset, so the fault is specific to the **host→container path** under this
WSL2 fake-IP proxy setup, not to the network itself.

Consequences observed:

- `NetworkConnectionError` on `apt-get update` and on the nvm install script.
- `AgentSetupTimeoutError` (360s) on one task.

**Every failure occurred in `install()`.** In all five trials of the final
retry job the `agent/` directory was completely empty: no model turns were
billed, and the model never ran.

### 4.2 Retry policy was incomplete on our side

A retry job with `-r 3 --retry-include NetworkConnectionError --retry-include
NonZeroAgentExitCodeError` consumed **12 retries and produced zero scores**. One
task (`password-recovery`) failed as `AgentSetupTimeoutError`, which was **not**
in the include list, so harbor declined to retry it. Recorded as our gap, not
the harness's: the include list did not cover the error class the environment
actually produced.

### 4.3 Debian-12 task images are unscorable with this bundle — image constraint, not adapter

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

## 5. Analysis: Execution / Coherence / Verification

Grounded **only** in the two trials in §3, at n=2. The TB paper's three axes
are used as the vocabulary; nothing wider is claimed.

### Execution — partial evidence

Both trials demonstrate real command execution reaching task state: files were
written, tests were written, PCR fragments and a 3591-bp circular assembly were
simulated, structural checks passed. The failure in both cases is **not** an
off-PATH executable or a command that failed to take effect (TB's top
execution failure, 24.1% in the paper's census). `adaptive-rejection-sampler`'s
`Non-numeric argument to mathematical function` is a **runtime correctness**
failure inside a command that did run. `dna-assembly` reached a final state that
was close but not exact.

**This run therefore gives no evidence for or against the paper's headline
execution failure mode** — the only two tasks attempted do not fail that way,
which is a property of the sample, not a measurement of the rate.

### Coherence — one observation, and it is a harness observation

Both runs consumed the **entire 40-turn budget**. For `dna-assembly` the last
debugging round was cut off by that budget; for `adaptive-rejection-sampler`
the loop was still going at 40. Whether the model was looping or making slow
progress is **not distinguishable from these two trials** — the transcripts
that would separate those were not retained. This is recorded as "hit the
budget twice", not as a recovery-rate number.

### Verification — no evidence

The `TEST_NAME: PASS/FAIL` output contract was one of the three failing tests
on `adaptive-rejection-sampler`. The harness's own three-value verify outcome
(`passed` / `not_run` / failed family) is a **model-visible prompt surface** and
is **not exercised by Terminal-Bench 2.1 at all**: TB scores final state with
programmatic tests, and its verifier is the task's, not ours. Nothing about our
verify-status honesty contract is measured by these two trials. That surface
remains covered only by its own golden set.

### 5.1 Failure taxonomy mapped onto harness subsystems

For each subsystem, either an observation **from these two trials**, or an
explicit statement that it was not exercised and why.

| subsystem            | observation from this run                                                                                                                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **hard-wall**        | **Exercised — one fail-closed false positive.** See §6. The deny's message is `pattern="verdict=malformed"`, i.e. "the bash parser could not produce a clean tree" (typically an unclosed quote), carrying **nothing about the command's content being dangerous**. At least three such denies occurred in the first scored trial. |
| **permission chain** | Not exercised as a denial. `full_auto` granted what was asked of it in both trials; no `permission_denied` from the ask path was recorded. The `[permission_denied]` line in §6 is the hard-wall's own prefix, not a separate permission-chain stop.                                                                               |
| **bash fence**       | **Out of scope by construction.** The bwrap fence retires wholesale in eval state (ADR-0130 §2), so no number here measures it. What remains is the which-tree axis, and writes did land on the task root — but with n=2 and no controlled comparison, that is an observation, not a measurement.                                  |
| **verify status**    | **Not exercised, and not measurable by TB.** See §5 — the task's own verifier replaced ours; our three-value outcome surface is a prompt surface TB does not touch.                                                                                                                                                                |
| **tool selection**   | Weakly exercised: the model used `bash` and, on `adaptive-rejection-sampler`, wrote a test function. Whether the **right** tool was chosen against the available alternatives is **not recoverable** from these two trials — no per-turn tool-choice trace was retained.                                                           |

## 6. The one harness finding: a hard-wall false positive

Observed in the first scored trial (`adaptive-rejection-sampler`):

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

## 7. Adapter defects found and fixed

Both committed; both were found by running real trials, not by reading code.

### `68a3f0843` — node resolved from an unsourced shell; smoke-test misattribution

`_ensure_node` resolved node with `command -v node` in a shell that had **not
sourced nvm**, so the `ln -sf` was silently skipped and every later bare `exec`
saw no node. A scored trial died at install with
`bash: line 1: node: command not found`, and it was **misreported as
`IKnowGlibcRequiredError`** on an Ubuntu 24.04 / glibc 2.39 image — an image
that satisfies the requirement. The node binary is now located from the nvm
tree's own layout and never from an ambient PATH.

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

- **No capability number.** 2 scored trials, both hard, both 0.0. There is no
  mean reward, no per-difficulty band, no per-category breakdown, and no
  comparison against any other agent. #1167's report item asked for those; **at
  n=2 they would be fabricated**, so they are omitted rather than estimated.
- **No breadth.** 87 of 89 tasks were not attempted. 12 further trials produced
  zero scores for the environment reasons in §4.
- **No retry-policy effectiveness.** 12 retries were consumed and produced
  zero scores; the policy itself was incomplete (§4.2), so the number measures
  our config, not harbor's retry logic.
- **No background / subagent / verify-sandbox-run evidence.** Structurally
  absent (§2).
- **No fence evidence.** Retired in eval state (§2).
- **No verify-status evidence.** Not reachable from TB at all (§5).
- **No tool-selection rate.** Per-turn traces were not retained for either
  scored trial.
- **No loop diagnosis.** Both runs hit the 40-turn cap; whether that is the
  model looping or making slow progress is not distinguishable from what was
  retained.
- **No hard-wall false-positive _rate_.** One observation in one trial, with
  the command text unrecoverable. The mechanism is pinned by repo tests; the
  benchmark-specific rate is unmeasured.
- **The offending command is not recovered and is not guessed** (§6).
- **Post-fix `install()` in a real container.** Both adapter fixes are
  unit-tested and the `_ensure_cpp_runtime` step was exercised against live
  containers (see `scripts/harbor/README.md`), but the full harbor-driven
  `setup() -> install() -> run() -> verifier` sequence has completed **once**,
  on the pre-fix bundle.

## 9. What remains

1. **A task image with a new-enough C++ runtime** (Debian 13 / Ubuntu 24.04
   base) for the Debian-based tasks. This is the single largest blocker to
   breadth and it is not an adapter change.
2. **Container egress stability** under this WSL2 fake-IP proxy (80% success, in
   clusters). Until this is resolved, most attempts die in `install()` and
   cannot score.
3. **A retry policy that includes the error classes the environment actually
   produces** — `AgentSetupTimeoutError` was missing (§4.2).
4. **Retain per-turn trajectories** for scored trials. Both the loop diagnosis
   and the tool-selection reading above are lost for want of it.
5. **A run wide enough to report a number.** The report item in #1167 is
   _partially_ delivered: the harness, the adapter, and the measurement
   procedure are working end to end; the capability estimate is not, and needs
   items 1 and 2 first.
