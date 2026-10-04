# Session-checkpoint joined acceptance matrix (issue #1182)

**Status: IN PROGRESS — this file is the run record, not a claim of completion.**
Last updated during the final-gates round (issue #1185) on branch
`fix/1185-checkpoint-final-gates`.

**The tree every round-5 number was measured on is a LOCAL tree built on the
pinned baseline `b420e318a`** — the published PR head — with rounds 4 and 5
applied on top. That head is NOT itself green: it is the head whose full `npm
test` run round 3 recorded as exiting non-zero, and none of this work was pushed
to it. Nothing in this file may be read as a claim that `b420e318a` passes the
full suite.

Contract: `specs/session-checkpoint-architecture.md` (ADR-0136).
Plan review that produced the repair scope:
`docs/evidence/session-checkpoint-plan-review-2026-10-03.md`.

## How to read this file

Evidence levels are stated strictly. A test that mocks the store is
**integration**, not fresh-process, no matter what its name says. A test that
forks a real child and `SIGKILL`s it is **real-crash**. Only a test that spawns
a real pty and drives a real host is **real-pty**. `real-llm/` is the only place
a real provider call counts.

The real-pty level in this file means a real controlling terminal obtained from
Python's `pty.fork()`, reached through a relay the harness writes into the temp
root at run time and spawns via `PTY_RELAY_PYTHON`
(`tests/session-api/crash/pty-harness.ts:19`, `:75`, `:103`) — this repository
has no node-pty dependency — and the harness hard-fails rather than skipping
when that relay cannot start (`:622-632`), so a real-pty verdict in this file
cannot be a silent skip.

Verdicts: **PROVEN** = a test genuinely exercises the requirement at the
strongest available level. **PARTIAL** = a test exists but in reduced form.
**UNPROVEN** = no test, or only an adjacent one. Rounding up is not permitted;
where a verdict is PARTIAL the missing experiment is named.

## The criterion list is 29, and the numbering is not SC1..SC29

The spec defines SC1, SC1a, SC2–SC13, SC9a, SC14–SC27 — 29 criteria in total.
**There is no SC28 or SC29.** Any review or plan text that cites "SC28/SC29" is
citing criteria that do not exist and cannot be satisfied.

## Round 1 summary (what the first round changed)

The measurements below are the round-1 record and sit above "Round 2" below. Two
of them are stale for the merged branch, because round 2 added six new test files
plus a pty harness and so changed both populations: the prettier changed-file
count and the two full-suite pass counts. They are left here as the round-1
numbers and are deliberately not restated.

The A/B/C plans were implemented but never connected. Concretely, before this
round: the harness's `RuntimePersistenceBinder` port had no host at any
production entry, so every loop/graph/worker publication was a typechecked
no-op; the recovery reader validated a snapshot's runtime state and then
discarded it; `stopOwnedWorkers`/`sweepOwnedWorkers` had no production caller;
and the input boundary was published twice (engine + hub/chat).

- `npm run typecheck` — clean.
- `npm run typecheck:tests` — 1276 errors, exactly the pre-existing baseline;
  zero of them in a file this change touches.
- `npx prettier --check` over all 98 changed files — clean.
- `npx vitest run` — 12364 passed. The only failures reproduce identically on an
  untouched `master` worktree (a missing vendored `rg` binary, a POSIX grep arm,
  and a `rm` shim that returns a `mavis-trash` message where the test expects a
  kernel refusal). One further failure appeared only in the full 782-file run
  and passes in isolation and in its file group — a load-sensitive flake, not a
  regression.
- `bun test tests/tui/` — 2056 passed, 1 skipped, 0 failed.
- `npm run test:real-llm` — 3 files / 10 tests passed against a real provider.

## Round 2 — closing the eight PARTIAL rows

A second pass went after the eight rows this file first recorded as PARTIAL. Seven
of them now carry a test that exercises the clause at the strongest level the
clause admits, and one (SC2) stayed PARTIAL through this round. Round 3 settled
_why_: both premises behind that row were measured and mutation-tested, and what
remained unmeasured was the bound joining them. Round 4 closed the row; see the
round-4 section and the SC2 section.

- SC3, SC5, SC7, SC9a, SC13, SC23, SC24 → **PROVEN**; SC2 remained PARTIAL after
  this round and was closed in round 4 (see the round-4 section).
- Six new test files plus one new section in an existing one, and one pty harness.
  Six of the seven new suites ship a control that makes the central negative
  non-vacuous: SC5's control runs the same batch to completion so "no batch
  checkpoint" cannot pass because publication is unwired; SC7's negative control
  back-dates the WINNING branch so timestamp order and file order both disagree;
  SC9a's mutation flips only `codeRestore.enabled` and the reason changes from
  `capture_disabled` to `root_identity_mismatch`; SC13's mutation deletes the tmp
  file before the reopen; SC24's control (`:610`, added in round 3) holds one
  session, one log and one predicate constant and varies only the posture, so the
  `--resume` posture — which installs no persistence sink at all — must add no
  `input` boundary to a log that already carries two.
- `npm run typecheck:tests` — 1276 errors, the same baseline, with zero in any of
  the eight touched files.
- Re-measured in round 3, after the SC24 control and the two SC2 arms were
  added: `npx vitest run` over the seven new/extended suites — **7 files, 42
  tests, 0 failed**. (The round-2 figure of "8 files, 33 tests" was not
  reachable — seven suites declaring 41 cases cannot report 33 — and is
  withdrawn here.) No stray child process and no `/tmp` residue after the pty
  run.
- SC24's own `run the complete npm test product path` half is a run-level gate and
  is deliberately **not** inside the automated test; it belongs to the run that
  merges this branch, not to a unit-level suite.

### Round 3 verification — authoritative for round 3 only (SUPERSEDED)

> **Superseded by round 4.** These were the authoritative numbers for round 3 and
> nothing more. The full-suite line below is the round-3 run, on which `npm test`
> exited non-zero and the bun half never ran; the fence failure it records was
> fixed in round 4, and round 4's own full run is green on a different (local,
> uncommitted) tree. Do not quote the full-suite numbers below as the current
> state of this branch.

Everything above is a round-1 or round-2 record. These are the measurements
that stand for the branch as it is now, taken on a tree no agent was editing.

- `npx vitest run` (the vitest half of `npm test`) — **792 files: 791 passed,
  1 failed. 12526 tests: 12525 passed, 1 failed.** The single failure is
  `tests/harness/verify/wired-fence-credential-read.test.ts`, where the host's
  `rm -f` is rewritten to `mavis-trash` and the shim's own failure text arrives
  where the test expects a kernel `Read-only file system` refusal. This branch's
  diff over `src/harness/verify/` and `tests/harness/verify/` is **empty**, so it
  is not a regression here; it is an interaction with the surrounding runtime.
  `npm test` therefore exits non-zero, and the `bun` half never runs inside it.
- `bun test tests/tui/` — **2065 pass, 1 skip, 0 fail; 2066 tests across 131
  files.**
- `npx prettier --check` over all **138** changed files (132 committed plus 6
  uncommitted at the time of the run) — clean. This required formatting
  `tests/session-api/crash/crash-harness.ts` and `crash-host-entry.ts`: both are
  files **this branch created** (neither exists at the merge base `f29ecb5`) and
  both were left prettier-dirty, so the earlier "clean over all changed files"
  claim did not hold for the branch. Formatting them is what makes it true.
- `npm run typecheck:tests` — 1276 errors, the unchanged baseline, zero in any
  file this branch touches.
- The pinned ripgrep engine is **not** installed by any lifecycle hook, so a
  fresh worktree silently degrades to the Node engine and
  `role-substitution-boundaries.test.ts` fails on its POSIX-bracket case. Running
  `npm run install:search-engine` makes it 14/14. That gap is unrelated to this
  branch and is being reported separately; it is recorded here only because it
  initially looked like a failure of this work.

An earlier full run on this same tree reported four failing files. Three of them
were artefacts of that run, not of the branch: two files were being edited while
vitest was still collecting (494 s of collect time), and one was the ripgrep gap
above. Only the `mavis-trash` failure survives an isolated re-run.

### Round 4 — the two remaining gates, closed (issue #1185)

Round 3 left exactly two gates open and this round closes both. They were
investigated independently, in two isolated worktrees off the pinned baseline
`b420e318a` with disjoint file ownership, and combined afterwards. `src/` is
untouched by this round: no production file, no settings key, no public API, no
dependency, no vitest exclusion.

**Gate 1 — SC2's tool-dispatch observation.** The probe no longer rides a
one-def registry. The reopen process now assembles the real production toolset
through `createDefaultAciRegistry` and wraps **every** def before registration.
Measured on the final tree with a one-shot probe: **41 production defs, 41
wrapped** (`assertFullProductionSurface` pins `wrappedCount === productionCount`
and a hard floor on every arm). The surface is held live across the real
`recoverChatSessionEntry` call and reads **0 hits**; a new named crash point,
`tool_use_committed_before_kill`, leaves a real `tool_use` on disk so the
deliberate-replay leg can dispatch exactly the block recovery restored and drive
the same counter non-zero.

What that does and does not prove is stated precisely in the SC2 section, and the
honest version is narrower than it first looked: recovery is handed no registry
and no executor, so the counter is **zero by construction for any implementation
of recovery**, and the probe observes dispatches made _through_ it rather than
intercepts every dispatch in the process. What round 4 genuinely added is that the
instrument is the whole real production toolset rather than one hand-picked def,
that it is provably live in the reopened process, and that the replay leg drives
it red on exactly the block recovery restored.

- `./node_modules/.bin/vitest run tests/session-api/store/fresh-process-recovery.test.ts` — **1 file, 6 tests, 0 failed**.
- All six crash-harness consumers together (`fresh-process-recovery`, `session-tmp-reopen`, `capture-disabled-needs-handling`, `fresh-process-batch-publication`, `pty-host-acceptance`, `graph-fresh-process-recovery`) — **6 files, 18 tests, 0 failed**.

**Gate 2 — the wired-fence fixture, so the kernel refusal is what is asserted.**
Reproduced first, on the pinned baseline, focused: **1 failed / 7 passed, exit 1**,
with `mavis-trash: failed to trash '…/.ssh/id_ed25519'` where the test asserts
`/Read-only file system|Device or resource busy/`. Root cause confirmed rather
than assumed: the host PATH leads with a runtime shim directory that shadows
`rm` with a recoverable-delete wrapper, and the wired call site hands that PATH
into the sandbox — `fenceEnv = { ...envIsolation.filter(process.env), TMPDIR }`
(`src/harness/verify/sandbox-run.ts:178-182`), `PATH` is in
`BASE_ENV_WHITELIST` (`src/harness/sandbox/env-isolation.ts`), so bwrap emits
`--setenv PATH <host PATH>` (`src/harness/sandbox/bwrap.ts:734`). The fence's
read-only protection was never broken; only which `rm` the sandbox resolved
changed.

The fix is a fixture change, not a relaxation: the file pins the fence-visible
PATH to a system-only PATH for its own run and restores the host value in
`afterAll`, so every case depends on the fence rather than on the host's binary
shadowing. The command text is untouched — still `rm -f '<key>'`, never an
absolute `/bin/rm` — and the kernel-refusal regex, the bytes-unchanged
assertion, the exit-code assertion and the no-leak assertions are byte-identical
(the diff is 59 insertions, **0 deletions**). One anti-vacuity control was added
so the refusal cannot be an artefact of a missing or broken `rm`: under the same
fence, `rm -f` on a writable path in the task root exits 0 and the file is gone.

- Focused, in the natural environment where the shim leads PATH — **9 passed (9), exit 0, 0 skipped**; the observed stderr is now the real kernel refusal, `rm: cannot remove '…/.ssh/id_ed25519': Read-only file system`.
- The same file under a system-only PATH (node invoked by absolute path, since this host has no `/usr/bin/node`) — **9 passed, exit 0**.
- `./node_modules/.bin/vitest run tests/harness/verify/ tests/harness/sandbox/ tests/harness/isolation/` — **91 files, 1140 tests, 0 failed, exit 0**.

**The full local `npm test` path — the gate that was blocked is now green.**
Run once on the final combined tree, on top of `pretest`'s `npm run build`.

**Which tree, exactly.** The tested tree is `b420e318a` plus this line of work,
in worktree `/home/winner/projects/iknow-ckpt-finalize` on branch
`fix/1185-checkpoint-final-gates`. Rounds 4 and 5 are recorded separately below
with their own runs, because the tree changed between them: each green number
describes the tree as it stood when that run was executed, and neither is
carried over to the other. The published PR head `b420e318a` is **not** this
tree and does not pass the full suite — it is the head whose round-3 `npm test`
run is recorded above as exiting non-zero. These numbers say nothing about the PR
head's CI status, and are not offered as if they did.

```
npm test            # => exit 0
  vitest run        # => Test Files  792 passed (792)
                    #    Tests       12530 passed (12530)
  bun test tests/tui/  # => 2065 pass, 1 skip, 0 fail
                    #    Ran 2066 tests across 131 files [392.44s]
```

That is the **post-review-repair** run and the authoritative one for the final
tree. The full `npm test` was run three times on this work, and all three are
recorded because one of them was not green and because the tree changed between
them:

| run | tree                                 | result                                                                                                     |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1   | two gates combined                   | 12527 passed / **1 failed, exit 1** — the `build-engine.test.ts` real-`curl` case described below          |
| 2   | same, before the code-review repairs | **exit 0** — vitest 792/792, bun 2066 across 131 files [406.97s]                                           |
| 3   | after the code-review repairs        | **exit 0** — vitest 792/792, 12528/12528; bun 2065 pass / 1 skip / 0 fail, 2066 across 131 files [392.23s] |
| 4   | round 5, first cut                   | **exit 0** — vitest 792/792, 12530/12530; bun 2065 pass / 1 skip / 0 fail, 2066 across 131 files [392.60s] |
| 5   | round 5, **final tree**              | **exit 0** — vitest 792/792, 12530/12530; bun 2065 pass / 1 skip / 0 fail, 2066 across 131 files [392.44s] |

Run 2's green did not carry over to run 3 by assumption: the review repairs
changed test code, so run 3 was executed from scratch on the repaired tree, and
run 2's number is quoted above only as history. The same rule was applied at
every step: a green run is never carried forward over a code change, so each run
below is executed from scratch on the tree as it stood. This is the first time on
this line of work that `npm test` has reached its bun half at all — round 3's
non-zero exit meant the `&&` never got there. Repeated green runs on one machine
are still a thin basis for a stability claim, so this is recorded as an
observation, not as "the suite is stable".

All of them are recorded, because one of them was not green. The first full run on
this tree reported **12527 passed / 1 failed, exit 1**, and the failure was
**not** the fence file — that one passed. It was
`tests/harness/build-engine.test.ts > #126 T5 secrets guard 装配 > settings 追加
pattern 生效 + enabled:false 透明`, where a real `curl` through the fence returned
`execution_failed` where `ok` was expected (that case took 10.3 s in the run).
It is **not** a regression from this round: the file is absent from this round's
diff, and the case passes in isolation
(`vitest run tests/harness/build-engine.test.ts -t "settings 追加 pattern 生效"`
→ 1 passed, exit 0). It is the same load-sensitive class of flake this file
already recorded in round 1. It was not "fixed", skipped or excluded, and no
green run was obtained by suppressing anything — every number is stated here,
including the one that is not flattering.

Also measured on the final tree, by this round's own commands and not
accepted from a worker's report: `npm run typecheck:tests` — **1276 errors, the
unchanged baseline, zero of them in any of the four changed test files**;
`npx prettier --check` over the four test files and this document — clean; and a
one-shot probe of the surface — **`production=41 wrapped=41 minDefs=10`**, so the
41/41 figure above is a measurement of the final tree and not of a tree one
repair older.

**The review round, and what it changed.** A two-axis review (Standards and Spec,
run in parallel over the pinned diff) returned **GATE: BLOCKED** on one Medium
finding that both axes raised independently: the round-4 wording claimed the zero
was read on a surface nothing under test shares, and that claim did not survive
checking. `recoverChatSessionEntry` is handed no registry and no executor, so the
counter is **zero by construction for any implementation of recovery**, and the
probe observes dispatches made _through_ it rather than intercepting every
dispatch in the process. The round-3 text that said so had been dropped in the
rewrite, which is exactly the kind of silent round-up this file forbids. The
bound was restored in the code comments, the SC2 row and this section, and SC2 was
put **back to PARTIAL** — the review was not only an honesty finding. Its own
caveat said the zero is zero by construction for any implementation of recovery,
so the row was not promotable, and round 5 (below) is the work that follows from
taking that seriously. The review also fixed a real defect in the fence fixture: its
`SKIP` decision probed `bwrap` on the host PATH at module load while the run
itself executes under the pinned PATH, so a host with `bwrap` outside
`/usr/bin:/bin` would have skipped in `hasBwrap()` and then failed fixture setup
anyway; the probe now carries `PATH: SYSTEM_PATH` explicitly, and that was
verified by running the file on a PATH with no `bwrap` on it — 9 passed, 0
skipped, where the old shape skipped silently.

The pinned ripgrep engine was installed into this worktree
(`npm run install:search-engine`, `vendor/ripgrep/15.1.0/linux-x64/rg`) before
the runs, so the round-3 ripgrep gap is not a factor in any number above.

### Round 5 — SC2 observed on the host's own dispatch path (issue #1185, acceptance follow-up)

The acceptance review of round 4 did not accept the promotion, and the reason was
not wording: the zero was read in a window where nothing but recovery ran, and
the replay control called the probe by hand. Both halves of the required evidence
are now executed, and the row is promoted on them.

**What changed.** The reopened process no longer stops at recovery. It takes the
operator's next line, as one real turn through `processChatLine` and the real
loop, with the restored messages as the turn's prior history — the same seam
`chat --resume` uses — and with the probed production toolset behind the
**production executor stack** (`createAciExecutor` over `createExecutor`, where
round 4 used a bare `createExecutor`) wired as that turn's `deps`. The probe now
records the wire id of each dispatch from the executor's handler context, so the
negative is about a named `tool_use` rather than a total.

**The pair that carries the row.** On the real build the restored call is not
dispatched, while the turn's own new `tool_use` is — real id, real handler, real
file read, so the window is provably live. On a build with a replay defect
injected into a **copy** of `src/harness/loop-engine.ts` (a second source for the
wave list, the one place dispatch converges), the **same, unchanged** negative
assertion throws and names the restored call, while the turn's own call still
dispatches — so the mutant differs only by the replay. The defect never touches
the repository: the copy is built in a temp dir with symlinked `node_modules`,
the crash host is pointed at the copy's own entry, and the repository's `src/` is
digested before and after so a write-through would fail the test.

#### Round 5 verification — the numbers, on the tree they were measured on

```
vitest run tests/session-api/store/fresh-process-recovery.test.ts
  → 1 file, 8 tests, 0 failed, 0 skipped        exit 0
    -t "host's own dispatch path"                exit 0, 1 passed
    -t "replay mutation"                         exit 0, 1 passed
the other five crash-harness consumers together
  → 5 files, 12 tests, 0 failed                  exit 0
npm run typecheck:tests
  → 1276 errors, the unchanged baseline; 0 in any of the five touched files
npx prettier --check  → clean over all five files
pgrep -a bwrap / -f "crash-host-entry"  → no strays
```

The full `npm test` was run on this tree as well; its result is recorded with the
other runs above rather than here, so the run table stays the single place where
suite totals live.

Three defects a verification pass found in the round-5 machinery itself, all
fixed before the runs above were accepted: the mkdtemp parent directory survived
`cleanup()` (one empty dir leaked per mutant run — the copy root is now the
mkdtemp root, and a before/after count confirms no leak); `assertRepoSourceUnchanged`
threw _before_ `cleanup()` ran, so the one case that most needs the copy removed
was the case that kept it (cleanup is now the inner `finally`); and the
before/after digest covered only `src/`, leaving the three copied test files
unwatched, which is narrower than the file's own header claimed (the digest now
covers the whole copied slice).

**Non-vacuity was checked independently, not asserted.** The mutant arm is only
evidence if the mutated build is what actually ran. A verification pass built a
copy by driving the repo's own `buildMutantTree`, diffed it (`diff -rq src
<copy>/src` reports exactly one differing file, `src/harness/loop-engine.ts`,
+979 bytes, and the repository's copy contains no injected marker), and then ran
the same child input against three entries: a copy carrying a sentinel throw
fired it and exited 1, while a plain copy and the repository were unaffected —
so the child really executes the copy's `src/`. The write-through guard was shown
to be live by pointing the builder at a throwaway fake root: it did not throw
before the mutation and did throw after it. The injection itself refuses to run
if its anchor is not found exactly once, so a silently-unapplied mutation fails
loudly instead of faking a green control.

Tests and evidence only: `src/` is untouched, and no dependency, settings key,
public API or vitest exclusion is introduced.

### Defect found while closing SC24, now fixed

`chat --resume <id>` on an id that does not exist did two contradictory things in
one session open: `seedResumeMessages` (`src/cli/chat-session.ts:2736`) treated
`not_found` as non-blocking, printed `从空开始（仍锚定 <id> 续写）`, and returned an
empty seed; then `openSessionWithRecovery` (`src/session-api/recovery-host.ts:149`)
threw the same `not_found` and the process exited 1 without ever reaching the
REPL. One command, a promise and a crash.

Resolved toward rejection, which is what the rest of the product already does.
`--resume <id>`'s implemented capability is resuming an existing session;
resuming one that does not exist was never implemented, and no status variant
describes it, so by the product's default-deny rule the unimplemented shape is
refused rather than coerced. Three independent signals agree: the recovery host's
own EXIT note; the TUI entry, whose `openSession` calls the same host contract and
rejects (`src/tui/hub-bridge.ts:209` → `runTui`'s single catch → typed stderr, exit
1); and the fact that continuing would have let a checkpoint CREATE the very
session the operator asked to resume. Only a DAMAGED log still degrades to a
warning with the anchor kept, which is what the anchor-preservation guarantee was
originally about.

The two tests that pinned the old behaviour now assert the rejection, strictly
more strongly than before — the typed `kind` survives, it is a typed store error
and not a bare `Error`, and no session file is created by the command that failed
to find it. Those two assertions live in different blocks of
`tests/cli/chat-session-resume.test.ts`, not in one: the `not_found` propagation
test sits in the T4 seed-helper block (`:152-286`, test at `:176`), and the
no-session-file assertion sits in the `resume 续跑集成` block (`:290`, test at
`:426-447`).

The `从空开始` claim is scoped to the missing-id case, and it is not a claim that
the line is dead code. `seedResumeMessages` rethrows `not_found` at
`src/cli/chat-session.ts:2758`, before the warn closure is ever built, so the line
is never printed for a session that does not exist — asserted directly at
`tests/cli/chat-session-resume.test.ts:439`. Every OTHER typed kind still degrades
to it, which is exactly the DAMAGED-log case recorded above, and three live tests
in that same T4 block assert the warn still fires: `:203` `parse_failed`, `:224`
`schema_invalid`, `:250` `io_error`. Verified end to end on the real CLI: the
command now prints one typed error and exits 1. `tests/cli/` is 59 files / 657
tests green.

## Matrix

| Criterion | Requirement (short)                                                                                                     | Level                                                                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Verdict    | What is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC1       | Published-state integrity across every crash point between body write and publication                                   | fresh-process (3 real children) + real fs fault                                | `tests/session-api/store/fresh-process-recovery.test.ts:159` (orphan body), `:247` (torn trailing append); in-process `tests/session-api/store/native-state.test.ts:415`, `:351`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **PROVEN** | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC1a      | Invalid published state is visibly blocked, never silently fallen back                                                  | integration                                                                    | `tests/session-api/store/recovery.test.ts:301` + `:316` corrupt mid-log + `:337` invalid head                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC2       | Accepted input boundary: kill before/during the first model request, fresh-process reopen, no model/tool call on reopen | fresh-process (zero read on the HOST's own dispatch path, per-call by wire id) | **host path**: `tests/session-api/store/fresh-process-recovery.test.ts` "SC2 on the host's own dispatch path" — leg 1 SIGKILLs a real host at `tool_use_committed_before_kill` with a real `tool_use` + settled `tool_result` on disk; leg 2 runs recovery and then ONE real turn through `processChatLine` with the restored messages as the turn's prior history (the seam `chat --resume` itself uses) and the probed production toolset behind the production executor stack as that turn's `deps`. The turn's OWN new `tool_use` (`toolu-after-recovery`) dispatches — real wire id, real handler, real file read — so the window is demonstrably live; the restored `toolu-resumed` is **not** dispatched, named by id rather than counted. Recovery itself: 0 dispatches, 0 provider requests, byte-identical tree. **mutation**: sibling arm "SC2 replay mutation" injects a replay defect into a COPY of `src/harness/loop-engine.ts` (a second source for the wave list — the one place dispatch converges) and runs the same sequence against that build; the ORIGINAL negative helper `noDispatchOf(…, "toolu-resumed")` throws there, naming the restored call, while the turn's own call still dispatches. Mutant confined to the copy (`tests/session-api/crash/mutant-tree.ts`), repo `src/` digested before/after. Supporting: `crash-host-entry.ts` `continueTurnOnHostPath`, `crash-harness.ts` `hostEntryPath` | **PROVEN** | the bound, stated: this observes the dispatch path the product uses — `deps.executor` → registry → handler body, the real loop, real toolset, production permission stack. A dispatch that bypassed `deps.executor` entirely would not be seen, and the loop has no such path today (its wave list comes only from the current turn's projection, `src/harness/loop-engine.ts:3057`). Two production wrappers are deliberately not wired — `createDynamicExecutorRegistry` and `withLazyLspWarmup` — because neither changes which handler body runs for a call that reached the executor. `src/` untouched; no new setting, API or dependency |
| SC3       | Tool-request response persisted before any handler starts                                                               | integration (real session file, real binder, real OS)                          | `tests/harness/loop-engine-runtime-state.test.ts:1025` ordering re-parsed from the real JSONL; `:1137` `chmod 0o444` makes the production append really fail, so zero handlers start; `:1183` truncation-stop response dispatches no enclosed call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | PROVEN     | the criterion has no crash clause, so an on-disk ordering proof is its strongest available level; the negative arm is a real OS-level append failure, not an injected rejection                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SC4       | Parallel settled results durably appended; protocol order after restart                                                 | integration                                                                    | `tests/harness/loop-engine-runtime-state.test.ts:395` (parallel settled calls, one held by a real `deferred()` gate); `tests/session-api/store/recovery-reconcile.test.ts:510`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC5       | No full batch checkpoint until every returned call is incorporated                                                      | **real-crash**                                                                 | `tests/session-api/store/fresh-process-batch-publication.test.ts:453` mixed batch (one ok, one `execution_failed`, one never returns) SIGKILLed to its process group before publication, reopened in two fresh real processes; `:600` the control: the SAME host and batch DO publish `[input, tool_batch, terminal]` once the third call settles                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | PROVEN     | the never-returned call is reported by durable omission (both surviving facts carry `batchSize: 3` while only positions 0/1 exist, restored turn outcome `unknown`), because the product has no explicit `in_flight` field. The control at `:600` is what stops the crash case being vacuous                                                                                                                                                                                                                                                                                                                                                   |
| SC6       | Terminal outcome reopens with the same authoritative turn outcome; missing stays unknown                                | integration                                                                    | `tests/session-api/store/recovery.test.ts:416`, `:428`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC7       | Selection follows the selected head chain; no timestamp/pointer rule                                                    | integration                                                                    | `tests/session-api/store/checkpoint-selection-branches.test.ts:207` two competing branches, three reopens each; `:259` the negative control (the winning branch is back-dated to 2000 so timestamp order and file order both disagree); `:367` the on-disk key walk; `:388` a branch's file intent drops out of selection with the head and returns with it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | PROVEN     | the `no independent mutable current-checkpoint pointer` sub-clause is proven by the on-disk shape plus a head-only delta — NOT by a mutation test, because the pointer does not exist to mutate. Record it that way                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SC8       | Compaction branch: a fresh process restores the exact post-compaction snapshot                                          | fresh-process                                                                  | `tests/session-api/store/fresh-process-recovery.test.ts:533`; publication half `tests/harness/loop-engine-runtime-state.test.ts:670`, `:699`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **PROVEN** | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC9       | Pre-write durability: an evidence-write failure leaves target bytes unchanged                                           | integration                                                                    | `tests/session-api/store/file-intent-durability.test.ts:190`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC9a      | Capture disabled: the write still lands, the intent reports UNVERIFIED                                                  | **real-crash** (host), real hub (the write)                                    | `tests/session-api/store/capture-disabled-needs-handling.test.ts:211` a real forked host takes input and is SIGKILLed at `first_model_dispatch`, a fresh process reports `needs handling` with `reason: capture_disabled` through the production renderer; `:303` bytes equal to the write's postimage still report `needs handling`; `:329` a post-crash third-party edit survives untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | PROVEN     | the file write itself is driven in the vitest process (real `SessionHub`, real engine, real `write_file`, real `codeRestore.enabled`, nothing mocked) because the frozen crash harness has no tool-executing arm and `tests/session-api/crash/**` was out of scope. The crashed child and the reporting process are both real                                                                                                                                                                                                                                                                                                                  |
| SC10      | Per-file atomicity across a real kill                                                                                   | **real-crash**                                                                 | `tests/util/atomic-file-publish.test.ts:217`, `:233`; `recovery-reconcile.test.ts:398`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | PROVEN     | the two-file leg is a seeded fixture, not a real interruption mid-call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| SC11      | Missing tool result: effect preserved, whole tool unknown, not retried                                                  | integration                                                                    | `tests/session-api/store/recovery-reconcile.test.ts:157`; `tests/session-api/hub-entry-restore.test.ts:226`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC12      | Error and mismatch handling; bytes untouched                                                                            | integration                                                                    | `tests/session-api/store/recovery-reconcile.test.ts:457`, `:255`, `:349`, `:371`, `:550`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC13      | Session tmp reread in place, never a tmp checkpoint                                                                     | real fork, not crashed (the criterion has no crash clause)                     | `tests/session-api/store/session-tmp-reopen.test.ts:178` a reopen over real fence-tmp content leaves the tmp set, the records and the whole session fingerprint byte-identical; `:224` missing and truncated (`half-f`) dispensable content is absent, not completed, not rewritten; `:280` an explicit `write_file` regenerates it and only then does it exist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | PROVEN     | do not round this up to `real-crash`: no child is SIGKILLed, because the clause does not ask for it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| SC14      | Crash recovery does not move the rewind head or weaken manual rewind                                                    | integration                                                                    | `tests/session-api/store/recovery.test.ts:463` (`:499`, `:504`); `tests/tui/session-recovery.test.ts:383`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC15      | Graph state: kill, reopen, settled nodes not respawned                                                                  | fresh-process (3 real children, one killed in flight)                          | `tests/harness/graph/graph-fresh-process-recovery.test.ts:81`; in-process `tests/harness/graph/graph-reopen-dispatch.test.ts:180`, `:202`, `:228`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **PROVEN** | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC16      | Real foreground and `wait:false` children stopped by identity after abnormal parent death                               | **real-crash**                                                                 | `tests/subagent/worker-identity-abnormal-exit.test.ts:457`; transcript separation `:687`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | PROVEN     | the host exits via `process.exit(0)`, not SIGKILL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC17      | Unconfirmable stop ⇒ needs handling; a reused pid is never signalled                                                    | **real-crash**                                                                 | `tests/subagent/worker-identity-abnormal-exit.test.ts:573`, `:605`; `tests/session-api/store/recovery-runtime-state.test.ts:568`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC18      | Saved metadata never restores a process-memory grant; post-recovery action re-asks                                      | unit + integration                                                             | `tests/harness/permission/saved-state-excludes-grants.test.ts:530`; `tests/session-api/store/native-state-exclusions.test.ts:189`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC19      | Final-wire oracle: dereferenced trace bodies equal the exact request at the SDK boundary                                | integration (real loopback HTTP)                                               | `tests/harness/model-adapter/dispatch-evidence.test.ts:236`, `:177`, `:306`, `:337`, `:377`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC20      | Bodies equal masker output, marked transformed, distinct from raw native                                                | integration                                                                    | `tests/harness/trace/dispatch-evidence-record.test.ts:132`, `:185`, `:207`; `tests/traceserver/body-access.test.ts:296`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC21      | Trace failure: dispatched exactly once, health reports it, no false capture                                             | integration                                                                    | `tests/harness/trace/dispatch-evidence-record.test.ts:447`; `dispatch-evidence-outcome.test.ts:180`; `tests/session-api/store/native-state-port-host.test.ts:150`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC22      | The reader dereferences trace bodies only                                                                               | integration                                                                    | `tests/traceserver/final-request-evidence.test.ts:546`, `:559`, `:587`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | PROVEN     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| SC23      | Old-format bytes untouched; no expiry by age/quota; deletion scoped to one session                                      | integration                                                                    | `tests/session-api/store/session-retention-deletion.test.ts:256` age: every persisted timestamp and every mtime back-dated to 2000, still selected, tree byte-identical; `:314` no expire/prune/gc/sweep method on `SessionStore`; `:336` quota: 12 states over 300KB, all bodies retained, oldest still readable by its own sha; `:385` deletion scope over two sibling sessions, asserted on the immutable bodies and not only the JSONL; `:447` the two sessions share one body sha and the survivor still recovers; `:481` a repeat deletion is `not_found` and does not touch the sibling. Old-format half: `recovery.test.ts:205`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | PROVEN     | the age and quota arms assert the ABSENCE of an expiry path, not a retention policy; the store defines no budget field, so the quota arm is a size proxy (far beyond any plausible cap) rather than a real threshold                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SC24      | Normal-permission host acceptance over a real PTY                                                                       | **real-pty** (automated, repeatable)                                           | `tests/session-api/pty-host-acceptance.test.ts:259` one continuous experiment: real `pty.fork` host, accepted input, fence-approved `write_file`, SIGKILL inside the model call, reopen in a second real pty host printing `[recovery] recovered`, no provider request carrying any replayed context; `:544` the refusal arm — answering `n` means the file is never written, which is what proves the fence is the product's and not the test's; `:610` its anti-vacuity control (see below). Harness: `tests/session-api/crash/pty-harness.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | PROVEN     | the `run the complete npm test product path` half of this clause is a run-level gate, not part of the test; it is recorded in the round summary. Prove-It control: the same flow driven on the `--resume` posture fails the publication assertion, so it is not vacuous. No `--yolo`, no `eval-state`, no real key                                                                                                                                                                                                                                                                                                                             |
| SC25      | This matrix, with fresh-process tests using real child processes                                                        | this file + the harness                                                        | `tests/session-api/crash/crash-harness.ts` — fork a real child, run to a NAMED crash point, `SIGKILL` the child's process group, reopen in a SECOND real process; consumers as listed above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **PROVEN** | no row is PARTIAL again, so the blocker this cell used to carry is gone on evidence rather than on assertion: the spec (specs/session-checkpoint-architecture.md:186) asks for pass/fail and spec:144 says the criteria are binary, while this file's scale is PROVEN / PARTIAL / UNPROVEN, so a reader must read PROVEN as "measured at the stated evidence level" and read each row's last cell for the residual limit of that level (they are not all empty, and are not meant to be)                                                                                                                                                       |
| SC26      | Model-visible prompt changes recorded; a golden set or a registered gap                                                 | static lock                                                                    | `tests/harness/graph/graph-undurable-text.test.ts`; roster row `docs/guides/prompt-development.md:49`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | PROVEN     | the trajectory-set half is a registered gap with the reason written down                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| SC27      | Repeated recovery adds no duplicate record and no file mutation                                                         | integration + real-crash                                                       | `tests/tui/session-recovery.test.ts:371` (the second open leaves the session tree byte-identical); `tests/session-api/store/recovery.test.ts:463` (a repeated recovery writes nothing), `:513` (a recovery that ended in needs handling stays needs handling on reopen); `runtime-persistence-host.test.ts:510` (a repeated factId is deduped, not double-appended)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | PROVEN     | of the five things specs/session-checkpoint-architecture.md:188 asks for, two are uncited here: no model/tool call on the second open (the TUI block asserts an identical status and a byte-identical tree, not a zero-dispatch count), and no signal to an unrelated or reused process identity on the second open (nearest: SC17's reused-pid test). The needs-handling leg IS covered, at recovery.test.ts:513                                                                                                                                                                                                                              |

## SC2 — the tool-dispatch observation, and what it is still not

SC2 was PARTIAL for three rounds with one reason: the tool half of "no tool call
on reopen" was anchored to a probe riding a **one-def** registry
(`createRegistry([probed])`, `read_file` only) that the recovery path is never
handed. Both premises were measured, but the join between them was a reading of
`runToolPhase`, and the instrument could not see any other tool. Round 4 closed
that, without touching production.

**The mechanism, unchanged and still load-bearing.** `createRegistry` stores
`Object.freeze({ ...def })` — a frozen shallow copy
(`src/harness/tools/registry.ts:74`) — while the base executor resolves
`validation.def.handler(call.input, ctx)` at **call time**
(`src/harness/tools/executor.ts:404`). A wrapper installed on a tool def
**before** registration is therefore the function the real executor really
invokes; installed **after**, the copy is already frozen and the assignment
throws. `executor.executeAll` and `createAciExecutor` are frozen closures, so
the def's `handler` is the only late-resolved property that is also reachable.

**What changed — the whole production toolset, not a bigger hand-pick.** The
reopen process now assembles the **real production toolset** by calling
`createDefaultAciRegistry` — the very factory `buildHarnessEngine` calls — with
production-shaped options rooted in that host's own temp project dir, wraps
**every** def it produced before registration, and registers the wrapped copies
through the real `createRegistry` behind the real `createExecutor`. Measured:
**41 production defs, 41 wrapped** (`productionCount` / `wrappedCount`, asserted
equal on every arm, with a hard floor so a shrinking toolset cannot make the zero
vacuous). That surface is assembled where a production host assembles it,
**before** the recovery call, and is held **across** it.

**Premise 1 — measured.** The reopen process issues zero outbound provider
requests. Self-verified: the `globalThis.fetch` tripwire's own `data:` URL
control must fire or the test fails.

**Premise 2 — measured on the whole surface, not one def.** A real `read_file`
from that 41-def surface is dispatched from a real `tool_use` block: the
counter reads `["handler:read_file"]`, the handler's observed input equals the
provider's `tool_use.input`, and the handler's real file contents land in the
real log under the provider's `tool_use_id`. The same arm also runs the real
**loop** end to end, so the hit comes from a real dispatch, not a routed call.

**The negative — read on the HOST's own dispatch path, not a registry the test owns.**
Round 4 read the zero in a process that ran recovery and nothing else, with the
probed surface assembled beside it. That was the wrong shape and the acceptance
review said so: nothing in that window could ever have run a tool. Round 5 closes
it by making the window the host's.

The first leg dies at `tool_use_committed_before_kill` with a real `tool_use` and
its settled `tool_result` committed, so the reopened process really has a tool
call sitting on its history. The second leg then does what a resumed host does:
recovery, and then the operator's next line, as ONE real turn through
`processChatLine` and the real loop, with the restored messages as the turn's
prior history — the same seam the CLI's `--resume` path uses when it leaves
`state.messages = entry.messages` before the next line. The tool surface is
wired as that turn's `deps`, so the only thing that can run a tool is the
product's own code deciding to run it.

The probe now records the wire id of each dispatch, not just a count: the
executor's handler context carries the call's Anthropic `tool_use_id`, so a
dispatch is attributable to a specific `tool_use`. The negative is therefore
about a named call — **the restored `toolu-resumed` was never dispatched** — and
not about a total that could be zero for uninteresting reasons.

The window is not vacuous, and that is measured rather than asserted: the
scripted response for the continued turn carries a **new** `tool_use`
(`toolu-after-recovery`) naming a different file, and it **did** dispatch, on the
same probed production surface, with its own wire id. The turn's real handler
read the real file. So the path is demonstrably live in that process, and the
restored call is specifically the one that did not run.

**The bound, stated rather than papered over.** What this does and does not cover:
the probe is the host's real dispatch path for that turn, and the restored call
is named by id — but a dispatch that went around `deps.executor` entirely (a
path the loop does not currently have) would not be seen. The loop's own wave
list still comes solely from the current turn's projection, so today there is no
such path; the row claims the dispatch path the product uses, which is what the
criterion asks about.

**The replay leg from round 4 — what it is, kept as a control.** It dispatches
the restored block by hand, through the probed surface, after the fact. That is
the **positive control** it should have been called from the start: it shows the
instrument fires and that the restored block is executable on this surface
(0 hits for recovery, ≥ 1 for the hand-made dispatch, real bytes back). It is not
a mutation check, and is no longer described as one.

**The mutation check — a replay defect injected INTO the product.** Round 5 adds
what round 4 lacked. A copy of the tree (`tests/session-api/crash/mutant-tree.ts`)
is built in a temp dir, and a defect is written into **its** `src/harness/
loop-engine.ts`: `runToolPhase`'s wave list is the one place dispatch converges
(it builds `toolCallViews` solely from this turn's projection, and every
downstream consumer follows from it), so the injection adds a second source —
every historical `tool_use` the live turn has not already claimed. That is the
regression the criterion forbids, expressed as the product would express it. The
crash host is pointed at the copy's own entry via `createCrashHost({
hostEntryPath })`, so the mutated build is what runs.

Then the decisive step: the **original** negative assertion, the same helper the
real build is judged by, is run unchanged against the mutant's window — and it
**fails**, naming `toolu-resumed`. The mutant's replay is a real handler body
that read the real file the checkpoint's `tool_use` named, and the turn's own new
call still dispatched, so the mutant differs from the real build **only** by the
replay. The mutation is confined to the copy and the copy is discarded;
`assertRepoSourceUnchanged` digests the repository's `src/` before and after, so
a write-through would fail the test rather than leave a defective build behind
for the rest of the suite.

So the pair is: **real build → the negative passes; the same negative, unchanged,
on a build that replays → it fails.** That is what makes the zero a measurement
of the behavior under test rather than of a counter the test could keep at zero
itself.
it: the replay is dispatched by the test, after the fact, on a surface the test
assembles. It proves the instrument fires when it is called. It does **not** prove
that a replay regression _in the behavior under test_ would turn the original negative
recovery assertion red — the two claims are different, and only the second one is
what this criterion asks for. The leg is retained as the positive control it actually
is, and the row stays PARTIAL.

**The two things round 4 was missing — both now done.** They are recorded above
in the form they were required in, and the row is **PROVEN** again:

1. _the zero read on the host's own dispatch path_ — done in
   `tests/session-api/store/fresh-process-recovery.test.ts`, "SC2 on the host's
   own dispatch path": recovery, then a real turn through `processChatLine`
   starting from the restored context, with the probed production toolset behind
   the production executor stack wired as that turn's `deps`.
2. _a replay mutation inside that same path turning the original negative red_ —
   done in the sibling arm "SC2 replay mutation": the defect is injected into a
   copied build of `src/harness/loop-engine.ts`, the same crash/reopen sequence
   runs against that build, and `noDispatchOf(…, "toolu-resumed")` — the very
   helper the real build passes — throws there.

**What is still structural, and is still labelled as such.** `runToolPhase`
derives each wave solely from `projection.toolCalls`
(`src/harness/loop-engine.ts:3057`), so a `tool_use` can enter a turn only inside
a provider response. That remains a reading of the code — but it is no longer the
load-bearing part of the argument, because the mutation arm now shows what
happens when that reading is false.

**The honest summary of what rounds 4 and 5 changed.** The instrument went from
one hand-picked def to the whole real production toolset behind the production
executor stack; the window went from "recovery runs and nothing else" to "the
host resumes and takes its next line"; the negative went from a count to a named
call; and the control went from a hand-made dispatch to a defect written into the
product. What it still is not: an interceptor for a dispatch path that bypasses
`deps.executor` entirely — a path the loop does not currently have. No
product-wide observability subsystem, no new settings, no new public API, no
dependency: `src/` is untouched by both rounds.

## Real-pty run record (SC24) — the Round 1 hand run, superseded

> **This section is history, not the current verdict.** The run below is the
> Round 1 by-hand run. SC24 is now **PROVEN**, and its current evidence is the
> automated test `tests/session-api/pty-host-acceptance.test.ts` (see the SC24
> table row). The hand run is kept because the F1 closure it recorded is real
> evidence; what it could not cover has since been covered another way.

Executed by hand against the built CLI, under the normal permission fence — no
`--yolo`, no `--eval-state`, no approval bypass. The host was started on a real
pty (`pty.fork`), driven like a user, then the whole process group was
`SIGKILL`ed: no cleanup handler, no graceful path.

Session pool and workspace were both real temp directories, so the repository's
own `data/` and the operator's `~/.iknow` session pool were never touched.

On-disk result of the killed session, read back from the JSONL:

```
session
head
message
head
native_state   boundary=input      <- the engine's accepted-input publication
message
message
head
```

plus one immutable body at `blobs/native/<sha256>`. That is the F1 defect
closed with real evidence rather than with a mock: the harness's input-boundary
publication now reaches storage on a real host, which it did not before this
round.

What this run did NOT establish, stated plainly: it does not cover the file
write, the reopen, the observed recovery status, or the no-replay assertion, all
of which SC24 also asks for. The model did not reach the file write before the
kill. **On the strength of this run alone SC24 was PARTIAL, not PROVEN — that is
why the round-1 verdict was PARTIAL, and it was correct for the evidence then
available.**

That verdict no longer holds. The missing arms are now covered by
`tests/session-api/pty-host-acceptance.test.ts`, which runs one continuous
experiment: a real `pty.fork` host, accepted input, a fence-approved
`write_file`, a `SIGKILL` inside the model call, a reopen in a second real pty
host printing `[recovery] recovered`, and an assertion that no provider request
carried any replayed context — plus a refusal arm, where answering `n` means the
file is never written, which is what proves the fence is the product's and not
the test's. What is still outside that test is the clause's `run the complete
npm test product path` half, which is a run-level gate and is recorded in the
round summary rather than in a unit-level suite. So SC24 is **PROVEN** as a
repeatable automated real-pty experiment, and the hand run above is retained as
the record of the F1 defect being closed on a real host.

**The anti-vacuity control (`:610`), added after the audit.** This file
previously claimed a Prove-It control for SC24 that had no artifact anywhere in
the repository — the word appeared only in this file. It is now real and
mutation-tested. The control holds one session, one log and one predicate
constant and varies only the posture: a new-format pty host accepts turn 1 and
turn 2 (two `input` boundaries on disk), the process group is `SIGKILL`ed, and
the same conversation is reopened with `--resume` — the identical
crash-recovery open as the main experiment's second leg, confirmed by the
`[recovery] recovered` line — where turn 3 is accepted, really dispatched and
really settles, and the count stays at two. The premise is the product's, not
the test's: `newFormatSession = opts.resumeId === undefined`
(`src/cli/chat-session.ts:3582`) and `newFormat` is the only gate on both
publication paths (`:3188` runtime sink absent, `:3092` commit a no-op), so a
resumed posture installs no persistence sink at all. The control proves the
predicate can detect the absence: mutating production to `newFormatSession =
true` turned it red with `3 !== 2` and the boundary list growing from four
records to six. The mutation was reverted.

One correction this control forced. The old comment on the greeting turn
claimed a chain-less session's publication is skipped, so a single-turn session
would have nothing to reopen. That mechanism is **disproven**: the
accepted-input seam appends the message before the engine dispatches, so a
first turn publishes normally. The comment was rewritten to the measured
behaviour, and the reason the greeting turn exists at all is now stated as
unproven rather than supplied with a new rationalisation. This does not disturb
the F12 record below, which concerns a _terminal wake_ with no accepted input
and therefore no head to anchor to — a different path from an accepted first
turn.

## Decisions recorded rather than silently accepted

**F2 (review finding, not adopted as written).** A review asked for the
per-file `file_intent` path to be gated on new-format sessions, the way the
state-publication binder already is. The clause cited is SC23, whose text is
"opening an old-format fixture does not rewrite or delete any old bytes" — and
appending an intent record rewrites nothing and deletes nothing. Gating it
would also remove the preimage index that the pre-existing code-restore
feature (ADR-0121) needs in order to restore a file in an old-format session,
trading a theoretical uniformity problem for a real loss of function. Decision:
keep recording intents on old-format sessions, and carry the asymmetry as a
known follow-up. `file_intent` did not exist on the base commit (0 occurrences),
so this is new behaviour introduced by this branch and is called out in the PR
body rather than left implicit.

**F12 (review finding, refuted with evidence).** A review called the headless
publication skip "a latent contract hole" because it could not construct a
reachable trigger. It is reachable, and this round hit it: a TUI terminal wake
as the session's very first activity threw
`NativeStatePortError PERSIST_FAILED: no persisted head to anchor to` and broke
the turn. The cause is a genuine contract mismatch — the hub deliberately does
not pre-commit a silent wake's digest, while the harness still treats that
digest as accepted text. The fix keeps both intents: the user-text path still
pre-commits and still blocks on failure, and only a chain-less session's
publication is skipped, because the same context is republished at the next
boundary with a real anchor. `tests/tui/hub-bridge.test.ts` covers the wake;
`tests/session-api/store/runtime-persistence-host.test.ts` covers both halves of
the skip.

**The subagents root (found by review, fixed here).** The TUI derived its worker
identity-record directory from an assembly-time `randomUUID()` because the
session id is not known before the bridge exists. Since `subagentsDir` takes
priority over `projectDir` in the manager, every TUI worker record was pinned
under a directory no later process can compute — the entry sweep resolves
`<projectDir>/<conversationId>/subagents` from the real id and would have found
nothing, leaving an owned worker no process could stop or even see. The TUI now
passes `projectDir` when the caller does not know the id, so the manager derives
the per-conversation leaf at spawn from `def.conversationId` — the same seam
the serve hub already uses and the same path the sweep reads.

## What this round did not do

- No pre-exit proactive sweep. The hub holds no live-session registry, so a
  graceful shutdown has no per-session call site to sweep from. The entry-time
  sweep covers the requirement deterministically, and the shortcut was taken
  deliberately rather than by omission.
- No real-model criterion. Per the spec's own scoping, no criterion in
  SC1–SC27 requires a real provider call; SC19 specifies a provider boundary
  that a loopback capture satisfies, and SC24 forbids `--yolo`/eval-state as
  evidence. `real-llm/` contains no checkpoint test. The real-model suite was
  run anyway as a regression check, not as criterion evidence.
- SC2's no-tool-call half stayed **PARTIAL** through round 3, and the reason was
  narrow enough to state. Both premises behind it were measured and
  mutation-tested; what was not measured was the **bound joining them**, which
  was structural — see the SC2 section. The earlier claim that no instrument can
  exist was wrong and is withdrawn: `createRegistry` freezes a shallow copy of
  each tool def while the executor reads `def.handler` at call time, so a
  wrapper installed before registration is the function the real executor
  invokes. Round 3 stopped short of a _universal_ chokepoint on the judgement
  that it would be a product change. **Round 4 got the coverage test-side
  instead** — the whole real production toolset assembled and wrapped, with no
  `src/` change — and added a replay control. **That was still not enough, and the
  acceptance review was right to send it back**: the replay leg dispatches
  through the test's own probe after the fact, which shows the instrument fires
  when called, not that a replay regression in the behavior under test would
  turn the negative assertion red; and the zero was read in a window where
  nothing but recovery ran, so it was zero by construction. Round 5 supplies
  both missing pieces — the host's own dispatch path, and a replay defect
  injected into the product that turns the same negative red. The round-3
  reasoning here is history; the live verdict is the SC2 row and the SC2
  section.
- `src/util/atomic-file-publish.ts` was added as the canonical atomic publish,
  but several hand-rolled `tmp + writeFile + rename` copies remain elsewhere,
  including in files this change touches. Consolidating them is a separate
  change with its own risk, and is not folded in here.
