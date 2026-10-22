# Evaluation runner (terminal-bench-2.1 headless + TUI calibration)

Read this when operating the versioned evaluation tooling under `scripts/eval/` — running the
preflight gate before a real headless run, writing or running a frozen TUI protocol, recovering
after an unclean stop, or interpreting a run report. This guide covers what the tools are, how to
drive them, and what each verdict does and does not license. It does not describe evaluation
design, task selection, or any product behaviour; those live in the issue and `specs/`.

**Out of scope here.** `scripts/eval/agent-qa/` is a third runner under the same tree with its own
runbook ([agent-qa-eval.md](agent-qa-eval.md)): a 20-slot offline catalog and its `run` / `report`
/ `compare` exit-code gate. This guide's frozen counting policy (`1219-denominator-v1`) and its
preflight gate belong to the two #1219 runners and do not apply to that mechanism.

Every flag, field name, verdict string and exit code quoted here was read from the source in this
tree. Where an interface is not yet settled, it is called out in
[Not yet stable](#not-yet-stable) rather than smoothed over.

**Which version this guide documents.** The `scripts/eval/` tree as rebuilt by #1219 (commit
`71847fd47`), whose frozen counting policy is version `1219-denominator-v1` (§4). That commit added
the whole capability area — implementation plus tests — in one change, so this runbook describes that
one snapshot rather than a rolling target. Capability index: `docs/STATUS.md` §1.3 "Evaluation &
quality gates" is the repository's record of which capabilities exist; this guide is the operator
runbook for this one and does not restate the status record.

**Post-#1220 repair qualification.** The reviewed repair code at
`74d226f54b6a870e52147f03c3d9e81208a4389c` halts TUI dispatch on a session-store
observer fault, blocks headless dispatch when a readable ledger contains torn
records, and waits for PTY child-reap evidence and relay closure before reporting
successful cleanup. Incomplete cleanup throws `PtyCleanupError`. See the
[verification receipt](../evidence/1220-fail-closed-verification.md) for the
tested source trees, exact checks, retained no-model smoke evidence, and remaining
coverage limitations.

**Line references in this guide are re-verified against the current tree**, not against commit
`71847fd47`. They were originally written for that snapshot and had drifted through #1220; each
`file.ts:NNN` / `file.py:NNN` below now points at the construct its sentence names in the tree as of
the #1219-post-#1220 repair.

---

## 1. What these tools are, and are not

There are two independently testable capabilities. They share no runtime dependency and neither
imports the other.

| Capability                  | Entry point                              | What it drives                                           |
| --------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| Headless terminal-bench-2.1 | `scripts/eval/terminal-bench-2.1/cli.ts` | A frozen manifest of task slots through Docker           |
| TUI calibration             | `scripts/eval/tui/run.ts`                | A frozen protocol against a real PTY, real child process |

The headless capability is **two modules**. `cli.ts` is the thin entry point — argv parsing, seam
wiring, the driver loop and the exit mapping. `scripts/eval/terminal-bench-2.1/report.ts` holds the
whole report half: the report types, `buildReport`/`persistReport`, and the retained gate records.
`cli.ts` re-exports the report half's public surface, so every import path that resolved before the
split still resolves (`scripts/eval/terminal-bench-2.1/cli.ts:106-124`).

**These tools do not authorize a new evaluation run.** Issue #1219 is a tooling repair: it rebuilt
the harness so that a future run can be measured honestly, and it wrote a runbook so an operator can
drive it. Authorizing an evaluation run requires a **separate evaluation issue** with its own newly
frozen protocol and its own artifact directory.

**A repeat is not a completion.** Re-running any of this tooling produces new evidence about the
current tree. It does not complete, repair, or adjudicate any earlier frozen run. Historical
accounting for #1212 and #1213 is in
[`docs/evidence/1219-historical-reconciliation.md`](../evidence/1219-historical-reconciliation.md);
that note is annotation, not adjudication, and deliberately renders no verdict on either run. Read
it for the historical numbers rather than expecting them here.

---

## 2. Prerequisites

| Requirement                                   | Why                                                           | Source                                              |
| --------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| Node >= 20                                    | Runs the tooling via `npx tsx`                                | `package.json` `engines.node`                       |
| `npm ci`                                      | Installs dependencies                                         | —                                                   |
| `python3` on PATH                             | The PTY relay is a generated Python script (`pty.fork`)       | `scripts/eval/tui/pty.ts:1-14`                      |
| Docker, plus the terminal-bench-2.1 images    | Headless path provisions a real container per slot            | `scripts/eval/terminal-bench-2.1/docker.ts`         |
| A dataset root                                | Slot task directories resolve under `<dataset>/tasks/<task>`  | `scripts/eval/terminal-bench-2.1/cli.ts:430-432`    |
| An `iknow` bundle tarball                     | Mounted into the container                                    | `scripts/eval/terminal-bench-2.1/runner.ts:249-253` |
| A Node archive, checksum-verified on the host | Mounted into the container; the same tarball is host-verified | `scripts/eval/terminal-bench-2.1/evidence.ts`       |

`python3` is not optional for the TUI path. There is no `node-pty` dependency in this repository,
so the PTY is the platform's own: a generated Python relay that does `pty.fork()` so the child gets
a real controlling terminal, relays the master verbatim on stdout, and reports the child's exit on
stderr (`scripts/eval/tui/pty.ts:1-14`, `scripts/eval/tui/pty-relay.py`). It **fails loudly** if
`python3` is missing rather than silently skipping (`scripts/eval/tui/pty.ts:13-14`).

### There are no baked-in machine defaults

Every input above is a **parameter you pass**. Nothing has a machine-specific default any more. What
the tooling refuses is an **unresolved** value, not a familiar one. `isPlaceholder` means absent,
blank, or an unresolved template (`scripts/eval/terminal-bench-2.1/identities.ts:118-123`):

- a non-string, or a string that is empty after trimming;
- an unexpanded substitution — `${VAR}` / `$VAR`, or a `{{name}}` handle;
- a whole `/`-separated path segment that **is** `TODO`, `FIXME`, `CHANGEME`, `TBD` or `XXX`,
  case-insensitively (`identities.ts:85-86`).

Every path parameter additionally passes the path-only predicate `isUnresolvedPathTemplate`, which
adds the `<…>` angle-bracket form (`identities.ts:132-143`). The split exists because a layout
template is legitimately built from angle brackets — the frozen #1221 `outputLayout` is
`tb2.1-slot-v1/<task>:<arm>:<maxTurns>` — while no real filesystem path contains one.

Naming one of the historical #1212 defaults is **allowed**:
`isInheritedDefaultLiteral` / `HISTORICAL_DEFAULT_LITERALS` (`identities.ts:95-110`) keep that
distinction available as a non-blocking diagnostic, because each of those four paths —

- `/home/winner/eval-1189/dataset`
- `/home/winner/eval-1189/bundle/iknow-bundle-9fa88f57.tgz`
- `/home/winner/eval-1212/prov/node.tar.gz`
- `/home/winner/.iknow/settings.json`

— is a real artifact an operator may legitimately name. Existence and type of an artifact stay
PREFLIGHT facts; they are deliberately **not** folded into `resolveConfig`, so a missing file does
not turn a configuration error into a measurement.

The historical `run-attempt.sh` had all four as `${VAR:-default}` assignments, plus a
non-overridable `BUNDLE_GLIBCXX_FLOOR="3.4.31"`; the new CLI requires `--bundle-glibcxx-floor`
explicitly and validates it against `^GLIBCXX_\d+\.\d+\.\d+$`
(`scripts/eval/terminal-bench-2.1/config.ts:104`, applied at `config.ts:144-148`).

---

## 3. Credentials policy

**The retained evidence records a settings file's `sha256` and nothing else.** The started record
carries `settingsSha256` — hash only; "Contents never enter a record or fixture"
(`scripts/eval/terminal-bench-2.1/attempt.ts:63-81`, written at `attempt.ts:298-299`, which stores the
literal `"absent"` when there is no settings path).

The historical tooling behaved the same way at the record level: `run-attempt.sh` recorded only
`SETTINGS_SHA` from `sha256sum`, never the file.

What may reach the container is a different question, and the answer depends on the run:

- **GATE and ORACLE grading never need real credentials.** The disposable smoke `docker cp`s a
  credential-free stand-in — `SMOKE_SETTINGS_BODY = '{\n  "_note": "issue-1219 smoke
placeholder; no credentials"\n}\n'` — so no real key is ever used
  (`scripts/eval/terminal-bench-2.1/smoke-types.ts:193-195`, written at
  `scripts/eval/terminal-bench-2.1/smoke.ts:125`). `dispatch()` is unreachable in that path
  because the port is sealed, which is what makes "zero model dispatch" structural rather than a
  promise (`smoke.ts:11-15`, seal at `smoke-exec.ts:169-187`).
- **A real agent attempt does `docker cp` a settings file** into `/root/.iknow/settings.json`
  (`scripts/eval/terminal-bench-2.1/docker.ts:504-510`). That is the only reason `--settings` is a
  required parameter.

Both the real `--container-env` path and the smoke guard a credential before it can reach a
container, and **neither ever prints the value it caught**:

- The real path refuses a credential-looking name or value in `assertNotACredential`
  (`scripts/eval/terminal-bench-2.1/cli.ts:312-330`, called from `containerEnvFrom` at `cli.ts:373`).
  A name is matched by a whole-word pattern shaped so the documented proxy variables are untouched
  (`cli.ts:279-286`); a value is matched against well-known provider key shapes
  (`cli.ts:288-293`) and against the live values of `MINIMAX_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY` and `DEEPSEEK_API_KEY` (`cli.ts:295-304`). The refusal names the **variable**
  and never interpolates a value, because a guard that prints the secret it just caught copies that
  secret into the terminal, the log and every transcript of it.
- The smoke's guard is tightened the same way: `redactArg` and `describeHits`
  (`smoke-exec.ts:110-126`) report the variable name and the value's **length** only, never the value
  and not even a prefix, and the message says so. A pinning test asserts that **zero characters**
  of a planted secret may appear in what the guard produces.

Hard rules for anything you commit:

1. **Settings contents never enter a committed fixture, snapshot, report or evidence file.** Only
   the hash may.
2. **No dataset contents and no historical run payloads** — no trace, session JSONL, CTRF blob or
   real `preflight.env` — belong in the repository.
3. The smoke **refuses before the process starts** if a secret environment name reaches the docker
   line: `MINIMAX_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`
   (`smoke-exec.ts:37-43`, enforced by `assertNoCredentials` at `smoke-exec.ts:129-145` on every docker
   argv at `smoke-exec.ts:155`). The real `--container-env` path carries the same guard
   (`cli.ts:319-337`).
4. The TUI report carries a required check `evidence.no_secrets`, whose failure text is
   `credential-shaped text was found in the retained artifacts` (`scripts/eval/tui/check-report.ts:52-53`,
   gate at `check-report.ts:194-198`).

### Why `model` is recorded at dispatch time

The `FinalRecord` carries a `model: string` field, and a started record does not
(`scripts/eval/terminal-bench-2.1/attempt.ts:107-120`). The model identity is captured at **dispatch**
time so the run is attributable.

This field exists because the historical evidence did not have it: the #1212 pilot ledger header has
32 columns and **no `model` key at all**, so from the retained bundle alone it was not recoverable
which model produced any given attempt. Do not remove the field.

---

## 4. The frozen counting policy

Verbatim from `COUNTING_POLICY` (`scripts/eval/terminal-bench-2.1/accounting.ts:49-64`):

| Key                               | Value                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `policyId`                        | `1219-denominator-v1`                                                                                                                            |
| `frozenBeforeNextRun`             | `true`                                                                                                                                           |
| `attemptedIncludesInvalid`        | `true`                                                                                                                                           |
| `attemptedIncludesInterrupted`    | `true`                                                                                                                                           |
| `excludedIsNotAttempted`          | `true`                                                                                                                                           |
| `gateFailuresCountedSeparately`   | `true`                                                                                                                                           |
| `unknownUsageIsNotZero`           | `true`                                                                                                                                           |
| `unknownUsageBlocksDispatch`      | `true`                                                                                                                                           |
| `cacheTokensCountedAsSpend`       | `true`                                                                                                                                           |
| `ceilingsObservedBetweenAttempts` | `true`                                                                                                                                           |
| `ceilingsEnforcedLive`            | `false`                                                                                                                                          |
| `ceilingNote`                     | `Ceilings are observed between attempts, not enforced live: a single in-flight attempt can overshoot the claimed budget by its own final usage.` |

`computeDenominator` derives the buckets from the ledger and each attempt's real artifacts
(`accounting.ts:141-189`). The `Denominator` shape is `attempted`, `valid`, `invalid`,
`interrupted`, `modelAttributable`, `excluded`, `gateFailures`, `policyId`
(`accounting.ts:90-103`). The rules:

- **Invalid and interrupted attempts stay visible inside `attempted`.** A kill mid-attempt is an
  attempt, not an absence.
- **Pre-dispatch gate failures are a SEPARATE visible bucket.** A gate failure increments both
  `gateFailures` and `excluded` and is counted in neither `attempted` nor `modelAttributable`
  (`accounting.ts:153-160`) — no model ran, so it is neither an attempt nor a task outcome.
- **Exclusions are never back-filled by substitution.** An excluded slot is skipped; it is never
  replaced by another task or another arm.
- `modelAttributable` counts only attempts that actually dispatched a model
  (`accounting.ts:174`).

### The historical rule this replaces

#1212's frozen rules already said the right thing — "an interrupted or infrastructure-failed
attempt is still attempted", and exclusions are "left in the denominator". The problem was that
later prose in the same document overrode them after the fact: amendments A3 and A4 removed
attempts from the denominators, and were recorded _after_ model dispatch had happened and grader
verdicts had been observed. The discrepancy register of
`docs/evidence/1219-historical-reconciliation.md` carries the removal from the denominators as D2, D3
and D4 (§2), measured against the frozen rules it quotes in §4; the chronology behind D20 — A3
recorded after run 1 aborted, A4 after run 2 stopped, with three grader verdicts already observed —
is in §12.1, not §13.

**Retrofitted denominators are exactly what the next protocol must not do.** Freeze the counting
policy before any outcome exists; the manifest enforces this
(`frozenBeforeAnyOutcome`, `scripts/eval/terminal-bench-2.1/config.ts:67`,
validated at `config.ts:251-253`).

---

## 5. Spend and budgets

Token ceilings are **observed between attempts, not enforced live**
(`accounting.ts:59-60`, `ceilingVerdict` at `accounting.ts:321-351`, which returns
`enforcement: "observed-between-attempts"`). A single in-flight attempt can overshoot the claimed
budget by its own final usage; every ceiling verdict carries `overshootNote` saying so
(`accounting.ts:61-63`). **Any overshoot must be disclosed in the report.**

**All four counters count toward the budget.** `aggregateSpend` sums `inputTokens`,
`outputTokens`, `cacheCreationInputTokens`, `cacheReadInputTokens` and reports
`totalTokens = ` all four, "so cache reads count as spend rather than as free context"
(`accounting.ts:211-256`, `SpendTotals` at `accounting.ts:66-77`). The old ceiling summed only
input+output. That was not a rounding difference: on one measured task cache-read was **179,410
tokens against 15,645 input — about 11.5x** (`accounting.ts:9-10`).

**Unknown usage is `unknown`, never zero.** `usageFromEvidence` returns `null` for both a
nonexistent attempt directory and an unreadable tally, and distinguishes them deliberately: a lost
attempt must not read as a free dispatch against the budget
(`scripts/eval/terminal-bench-2.1/cli.ts:343-360`). `aggregateSpend` counts an attempt whose intent
row was never finalized as UNKNOWN, resolved per **attempt** rather than per ledger row
(`accounting.ts:223-239`).

Unknown usage **blocks further dispatch**. `ceilingVerdict` returns `mayDispatch: false` with
`reached: true` whenever `usageComplete` is false — "unknown is not evidence that the budget is
intact" — and the reason reads `unknown usage for N attempt(s); unknown is not zero`
(`accounting.ts:325-333`). The driver consults this before every dispatch via
`mayDispatchMore()` (`scripts/eval/terminal-bench-2.1/driver.ts:102-104`,
wired at `scripts/eval/terminal-bench-2.1/cli.ts:500`).

**SIGKILL consequence:** a SIGKILL cannot run any handler, so the in-flight attempt keeps its
`intent` ledger row and no finalization. Until it is reconciled, its usage is unknown and the run
must not dispatch again. See [recovery](#recovery-after-an-unclean-stop).

---

## 6. The frozen manifest

The manifest is a JSON document, validated by `validateManifest`
(`scripts/eval/terminal-bench-2.1/config.ts:195-246`). Field names and types are exact
(`config.ts:58-68`, `config.ts:29-36`):

```json
{
  "runId": "<non-empty string>",
  "datasetCommit": "<non-empty string>",
  "bundleSha256": "<non-empty string>",
  "nodeArchiveSha256": "<non-empty string>",
  "runnerVersion": "<non-empty string>",
  "outputLayout": "<non-empty string>",
  "frozenBeforeAnyOutcome": true,
  "slots": [
    {
      "task": "<non-empty string>",
      "image": "<non-empty string>",
      "imageDigest": "<non-empty string>",
      "maxTurns": 40,
      "arm": "pilot"
    }
  ]
}
```

Validity rules, all enforced:

- All six top-level strings must be non-empty (`config.ts:200-212`).
- `slots` must be a **non-empty** array. An empty slot list is a refusal, not an empty run
  (`config.ts:213-217`).
- Per slot, `task`, `image`, `imageDigest`, `arm` must be non-empty strings and `maxTurns` must be a
  **positive integer** (`config.ts:218-240`).
- `frozenBeforeAnyOutcome` must be exactly `true` (`config.ts:251-253`).

The slot key — the cross-driver exclusivity unit — is `` `${task}:${arm}:${maxTurns}` ``
(`config.ts:44-47`). Two arms of one task differ by construction, which is what lets a paired study
run both without either claiming the other's slot.

## 7. Run identity

Nine pinned fields, in this fixed order (`identities.ts:16-27`, `IDENTITY_FIELDS` at
`identities.ts:39-49`): `runId`, `task`, `image`, `imageDigest`, `datasetCommit`, `bundleSha256`,
`nodeArchiveSha256`, `runnerVersion`, `outputLayout`.

- `imageDigest` is the immutable content digest. **A mutable tag is not an identity**
  (`identities.ts:20-21`).
- `image` is compared too, deliberately: a name change with an unchanged digest still means the
  runner's `-v` mounts were built for a different tag (`identities.ts:20-21`).
- An **absent or non-string** field counts as a mismatch. A record that never recorded an identity
  cannot prove it describes the current instrument (`identities.ts:182-194`).

Every identity you supply is compared before a decision is trusted
(`driver.ts:56-63`).

---

## 8. Running the gate before a real run

### The command

```bash
npx tsx scripts/eval/terminal-bench-2.1/cli.ts \
  --manifest /path/to/manifest.json \
  --dataset-root /path/to/dataset \
  --bundle /path/to/iknow-bundle.tgz \
  --node-archive /path/to/node.tar.gz \
  --settings /path/to/settings.json \
  --run-root /path/to/new-artifact-dir \
  --agent-wall-sec 3600 \
  --grader-grace-sec 600 \
  --bundle-glibcxx-floor GLIBCXX_3.4.31 \
  --token-ceiling-input 1000000 \
  --token-ceiling-output 500000 \
  [--container-env NAME=VALUE ...]
```

The flag set is exactly `FLAGS` in `scripts/eval/terminal-bench-2.1/cli.ts:147-160` — twelve names. An
unknown flag is a refusal, not a warning (`cli.ts:211-213`).

Which flags are effectively required:

| Flag                                                                       | Required?           | Consequence if absent                                                                                                                                            |
| -------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--manifest`                                                               | yes                 | `requiredFlag` throw, exit 1 (`cli.ts:233-238`, `cli.ts:889-892`)                                                                                                |
| `--agent-wall-sec`                                                         | yes                 | `missing required flag` throw, exit 1 (`numberFlag`, `cli.ts:226-230`)                                                                                           |
| `--grader-grace-sec`                                                       | yes                 | same                                                                                                                                                             |
| `--token-ceiling-input`                                                    | yes                 | same                                                                                                                                                             |
| `--token-ceiling-output`                                                   | yes                 | same                                                                                                                                                             |
| `--dataset-root`, `--bundle`, `--node-archive`, `--settings`, `--run-root` | yes                 | `requiredFlag` throw, exit 1 (`cli.ts:240-255`); a blank or unresolved-template value is also refused as a placeholder (`config.ts:96-102`, `config.ts:120-122`) |
| `--bundle-glibcxx-floor`                                                   | yes in practice     | `requiredFlag` throw, exit 1; a value that is not `^GLIBCXX_\d+\.\d+\.\d+$` also fails validation (`config.ts:107`, `config.ts:149-153`)                         |
| `--container-env`                                                          | **no** — repeatable | nothing; unset emits zero `-e` flags (`cli.ts:158`, `cli.ts:276-277`)                                                                                            |
| `--report-only`                                                            | **no** — valueless  | the run loop executes normally (`SWITCHES`, `cli.ts:174`, `cli.ts:854-856`)                                                                                      |

**There are no `""` defaults that are later refused.** A missing required flag now **throws** from
`requiredFlag` (`cli.ts:233-238`) before anything is read or created, and the top-level handler turns
that into exit 1 (`cli.ts:889-892`). The placeholder check is a second, independent guard: it refuses
an explicitly passed blank or unresolved template (`config.ts:120-122`). Naming a historical #1212
default is **not** refused — see [There are no baked-in machine defaults](#there-are-no-baked-in-machine-defaults).

Note `--settings` must be a **real, non-placeholder path**, even though no gate or oracle grading
step reads it — the config validation applies `isUnresolvedPathTemplate` to all five path
parameters uniformly (`PATH_PARAMS`, `config.ts:96-102`, applied at `config.ts:120-122`). A real settings file is
needed only for an actual agent attempt.

### `--container-env NAME=VALUE` (repeatable, optional)

This is how you supply a proxy on a host whose network is only reachable through one. Every task's
`test.sh` apt-installs `curl` and installs `uv` over the network, so a host that reaches the network
only through a proxy cannot run the real attempt path at all (`cli.ts:33-38`, `docker.ts:75-78`). There
is deliberately no default: a host address baked into the instrument would make the run
irreproducible anywhere else.

- **Repeatable.** One occurrence per variable, in argv order (`REPEATABLE_FLAGS`, `cli.ts:166`,
  accumulation at `cli.ts:189-196`), because `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` are needed
  together.
- **Only the FIRST `=` splits** (`cli.ts:360-362`), so a value may itself contain `=` and spaces and
  stays one argv element (`tests/scripts/eval/terminal-bench-2.1/cli.test.ts:797-808` — "only the
  first = separates the name, so the value must arrive unsplit").
- **No default proxy, and nothing is read from `process.env`.** A host address baked into the
  instrument would make the run irreproducible on any other machine. Omitting the flag emits **zero**
  `-e` flags — byte-for-byte the previous argv (`cli.ts:355-356`, `docker.ts:105-112`).
- `docker.ts` renders each entry as `-e NAME=VALUE`, placed after `--name` and before the mounts and
  the image, because that is where `docker run` accepts it (`docker.ts:429-451`). Empty values are
  dropped (`docker.ts:105-112`). `docker exec` inherits the `docker run` env, so one `-e` covers the
  provision script, the agent and the grader alike (`docker.ts:84-90`).
- **Malformed values are refused before anything is created** — measured: the run root was still
  empty afterwards, and no container existed (`containerEnvFrom`, `cli.ts:352-377`; parsed at
  `cli.ts:862`, after the config check at `cli.ts:858` and before the loop). A value with no `=`, or a
  name that is not shell-style:
  `` `--container-env needs NAME=VALUE with a shell-style NAME; got "HTTP_PROXY"` ``. An empty value:
  `` `--container-env HTTP_PROXY= has an empty value, which docker run would not forward; omit the flag instead` ``.
  A **credential-looking** name or value is refused here too, naming the variable and never the
  value (§3). Note the order: a missing required flag is reported **first**, so a malformed
  `--container-env` is only the message you see once the rest of the argv is complete.
- **It is ignored under `--report-only`**, which provisions no containers
  (`cli.ts:854-856`).

Wiring: `dockerRunnerFor` passes the parsed map to `createDockerRunner` as
`DockerRunnerOptions.containerEnv` (`cli.ts:387-394`, `docker.ts:93-103`), and `main` calls it
(`cli.ts:862`).

### Ordering is fixed

`runDriver` runs the frozen slot list once, and the order is mechanical: **gate before any dispatch,
budget before any dispatch, and the ledger intent row written inside dispatch before the runner is
invoked** (`driver.ts:90-107`). The standing preflight/wiring gate is
**mandatory for both pilot and paired runs**; there is no flag that skips it.

### The gate runs in its own tree, and the first attempt is reachable

Two integration defects made the real path fail on the first slot of every run. Both were found by
reproducing the real path against real Docker, not by reading the code. **If you are reading this
section because a run excluded every slot, this is why.**

**1. The gate and the attempt directory could not coexist.** `docker run -v` **auto-creates a missing
host source**. The gate provisioned inside the attempt directory, so the gate created it; the
dispatch's `reserveAttemptDir` — which exists precisely to refuse accidental reuse — then threw
`AttemptDirReservedError` **after the gate had passed and before any dispatch**, so nothing was
persisted and no report could be read. The fix moved the probe, not the reservation:

|         | Path                              | Why                                                   |
| ------- | --------------------------------- | ----------------------------------------------------- |
| GATE    | `<run-root>/.preflight/<slotKey>` | a scratch tree the gate owns, under the same run root |
| ATTEMPT | `<run-root>/<slotKey>`            | unchanged, and its name is **load-bearing**           |

`GATE_SCRATCH_DIR = ".preflight"` (`cli.ts:145`), `gateDirFor` at `cli.ts:467-469`,
`attemptDirFor` at `cli.ts:453-455`. The gate gets `mkdirSync(outDir)` of its own scratch directory
(`cli.ts:649-651`), keeps the same `sharedMounts` wiring it always used, and leaves the attempt
directory untouched.

**The attempt directory's name must not change.** `attemptDirFor` produces `<run-root>/<slotKey>`
because `report.ts` re-derives that same path as `join(runRoot, slotKey)` in four places — the
retained record (`report.ts:141`), the per-row classification (`report.ts:539`), the per-slot evidence
outcome (`report.ts:640`) and the final-record read (`report.ts:656`). A "prettier" name on the CLI
side would silently empty every denominator the report prints (`cli.ts:448-455`).

**2. `docker run -v` refuses more than two colons, and a slot key is not colon-free.** A slot key is
`` `${task}:${arm}:${maxTurns}` `` (`slotKeyOf`, `config.ts:44-47`) — for example
`db-wal-recovery:arm40:40`. An attempt directory named after one is therefore **unmountable**, and the
real driver excluded **every** slot as `EXCLUDE:runner-wiring`. The fix is a colon-free symlink alias:

- `MOUNT_ALIAS_DIR = ".mounts"` (`runner.ts:176`) — a sibling directory holding the aliases.
- `mountBindSource` (`runner.ts:189-194`) returns a colon-free path **UNCHANGED**, so the smoke's
  `join(outRoot, sub, task)` and every fixture keep a **byte-for-byte identical argv**. Only a path
  actually carrying a colon is aliased. The alias basename keeps the original readable and appends a
  digest of the **full** path, so two directories that sanitize to the same name still get their own
  alias and no attempt's evidence can land in another's directory.
- `ensureMountAlias` (`runner.ts:205-224`) creates it and is **idempotent**. It MUST run before
  anything mounts the directory, because an alias path that already exists as a real _directory_
  would silently collect that attempt's evidence where no report reads it — so an existing alias is
  accepted only when it is the symlink this function creates, and anything else is a **refusal**
  rather than a silent redirection.
- It is called at the single place a spec is built (`provisionSpecFor`, `cli.ts:418`), so the gate and
  the attempt both get it and neither can forget it.

### The gate applies the task's own reference solution, then grades

**A gate that can never say `OK` validates nothing.** `GRADER_SCRIPT` ran `test.sh` and nothing else:
it never applied `<taskDir>/solution/solve.sh`, so every task measured `oracleReward=0`, so the
gate could only ever return `EXCLUDE:oracle-or-grader`. That is a green-looking exclusion produced by
a measurement path that measured nothing.

The oracle step is now a real step:

- `ORACLE_SCRIPT` is `cd /app && bash /opt/oracle/solve.sh`, echoing `--- applying oracle ---`
  first and then `oracle_exit=$?` (`docker.ts:272-278`), with `SOLUTION_RELATIVE` at
  `docker.ts:260` and the in-container destination `/opt/oracle` at `docker.ts:258`. The phase is
  `oraclePhase` (`docker.ts:912-944`).
- `solve.sh` is `docker cp`'d **in**, not mounted, so `sharedMounts` stays the single mount
  definition and the agent's mount surface is unchanged by an oracle run. The grader that runs
  afterwards is the **same** `GRADER_SCRIPT` the agent path uses, and the reward comes from the same
  retained host artifact.
- It is exposed as `DockerRunner.gradeOracle` (`docker.ts:369-378`, wired at `docker.ts:423-424`).

**Measured before/after on `alexgshaw/db-wal-recovery:20251031`, same harness, same images:**

|                     | `grade()`                  | `gradeOracle()`           |
| ------------------- | -------------------------- | ------------------------- |
| `reward`            | `0`                        | `1`                       |
| result line         | `7 failed`                 | `7 passed`                |
| CTRF bytes retained | 6475                       | 2872                      |
| verdict             | `EXCLUDE:oracle-or-grader` | `OK:oracle-passes-grader` |
| `oracle.state`      | —                          | `"applied"`               |
| `appliedMarkerSeen` | —                          | `true`                    |

Both with `bootVerified: true`, `logsMountWritable: true` and
`glibcxxMeasured: GLIBCXX_3.4.33` against a floor of `3.4.31`. This matches the historical
preflight-retry1 target (`oracle_reward=1`, `7 passed`, CTRF present) recorded in the reconciliation
note — the gate and the retained evidence now agree, which they did not before.

**Both abnormal oracle outcomes THROW, and they throw before the grader runs:**

| Condition                                 | Error                      | Thrown at                                      |
| ----------------------------------------- | -------------------------- | ---------------------------------------------- |
| no `solution/solve.sh` under the task dir | `OracleNotApplicableError` | `docker.ts:306-313`, raised at `docker.ts:919` |
| `solve.sh` exits nonzero                  | `OracleFailedError`        | `docker.ts:316-326`, raised at `docker.ts:932` |

Neither can be mistaken for a measurement. A missing or broken oracle used to be the path that
produced a fabricated `reward=0`; now a caller that reaches either gets a typed error, which is the
one representation it cannot accidentally read as a result. `OracleState` is `"applied"` for that
reason — the type admits no other value (`docker.ts:280-291`).

**The gate measures through the oracle, and classifies both refusals as a GATE FAILURE.** The gate's
measurement is `probeMeasurement` (`cli.ts:606-632`): it resolves the runner's oracle entry point
**first**, so a runner that cannot apply a reference solution refuses _before_ creating a container;
then it provisions; then it calls `gradeOracle` and maps the result into a `PreflightMeasurement` that
`runGate` judges. The gate's own container is reaped in the same `finally` on every path, including
both oracle refusals, which are thrown before any grade exists.

- `oracleGraderFor` (`cli.ts:542-557`) takes `runner.gradeOracle` or throws
  `OracleGateRefusal("oracle-unavailable")`. **It never falls back to `grade()`.** That absence check
  is the load-bearing part: falling back would re-measure a pristine workspace and publish it as the
  gate's verdict — the exact defect this path exists to remove — and it would do so _invisibly_,
  because a fallback looks precisely like a passing run.
- `probeGate` (`cli.ts:643-665`) wraps the call, because `runGate` has no catch: without it an
  `OracleNotApplicableError` or `OracleFailedError` raised inside the measurement would escape
  `runGate` → `gateFor` → `deps.gate(slot)` as an unhandled crash, with no report, no actionable
  exit code and no ledger row — a refusal indistinguishable from a bug. Anything that is not one of
  the three oracle refusal kinds is rethrown unchanged, so a real fault still surfaces as one.
- `oracleRefusalDecision` (`cli.ts:584-596`) turns a refusal into `kind: "reject"`, `verdict:
"REJECT:no-record"`, `record: null`, `reasons: [kind, message]`, `excluded: false`, **`stopDriver: true`**. `reject` rather than
  `exclude` is the distinction that matters: an exclusion is a property of the **task** and the frozen
  list continues, while a reject is a statement about the **harness** and stops the whole driver with a
  nonzero exit. A task with no `solution/solve.sh`, or a broken reference solution, is the harness's
  inability to measure — never the task's fault, so charging it as an exclusion is precisely what issue
  1219 exists to stop. Because `record` is `null`, no gate record is retained and a later
  `--report-only` pass reports `REJECT:no-record` for that identity: the same verdict, never a stale
  one. `preflight.ts` owns the `REJECT:*` union and is deliberately not widened by `cli.ts`, so the
  specific cause travels in `reasons` — which is what `recordGateFailure` puts in front of the
  operator.
- The three refusal names are `oracle-unavailable`, `oracle-not-applicable` and `oracle-failed`
  (`OracleRefusalKind`, `cli.ts:514-515`), mapped by `oracleRefusalKindOf` (`cli.ts:560-565`).

#### Why this cannot contaminate a real attempt

The separation is **structural, not conventional**. Three independent properties hold at once:

1. `gradeOracle` is a **separate method** on `DockerRunner` (`docker.ts:369-378`), not an option on
   `grade`. `grade()` and `dispatch()` are the two paths a real attempt and the pristine smoke take,
   and neither can reach `solve.sh`.
2. `dispatchScript(maxTurns)` — the script the agent path runs — has **no reference** to
   `oraclePhase` or `SOLUTION_RELATIVE`; the only reader of `SOLUTION_RELATIVE` is `oraclePhase`
   (`docker.ts:918`).
3. The smoke cannot reach it either: it holds a **sealed** `RunnerPort` whose surface is
   `provision`/`grade`/`reap` plus a `dispatch` that always throws (`smoke-exec.ts:169-187`) — the
   port does not even carry `gradeOracle`, so the oracle path is unreachable from that runner
   entirely, and a gate handed that port would refuse rather than measure.

`probeGate` is the one production caller that applies a reference solution, and it does so on a
throwaway container in its own scratch tree, reaped in the same `finally` that provisions it. A
dispatch still grades through the **unmodified** `GRADER_SCRIPT` against whatever the agent produced.

### Verdicts

`judgeMeasurement` is a fixed order — wiring, then an **unmeasured** ceiling, then library, then
oracle/grader — because "an infrastructure fault is not a task property"
(`preflight.ts:187-198`). The complete vocabulary is **five** strings
(`preflight.ts:42-48`):

| Verdict                         | Means                                                                                                                   | Driver effect                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `OK:oracle-passes-grader`       | Wiring proven, glibcxx compatible, oracle exits 0 with reward `1`, CTRF retained, a real result line, no network marker | dispatches the slot                                                              |
| `UNRESOLVED:glibcxx-unmeasured` | The in-container library probe did not complete, so this task's ceiling is **unknown**                                  | **stops the driver**; excludes nothing                                           |
| `EXCLUDE:runner-wiring`         | The real provisioning path did not prove itself                                                                         | **stops the driver**; a harness fault, charged to no task (`preflight.ts:72-85`) |
| `EXCLUDE:glibcxx`               | Measured ceiling absent or below the bundle floor                                                                       | explicit exclusion, next slot continues                                          |
| `EXCLUDE:oracle-or-grader`      | Oracle/grader half unproven                                                                                             | explicit exclusion, next slot continues                                          |

The spelling of a verdict does not decide its driver effect; the **classification** does.
`EXCLUDE:runner-wiring` is spelled `EXCLUDE:` yet is a HARNESS fault, so it belongs with
`UNRESOLVED:` and not with the two task/environment exclusions. The rule is stated once, in
`HARNESS_FAULT_VERDICTS` (`preflight.ts:61-64`), and applied once in `decisionFromRecord`
(`preflight.ts:263-314`); every other non-`OK:` verdict excludes that one slot. Before this
correction a wiring fault advanced the driver to the next task and exited `0`, reporting
itself complete — the same failure shape as #1212, in a new costume.

#### An unmeasured value is no longer an exclusion

**This is the rule that keeps a harness fault off the task's record.** A nonzero in-container probe
exit used to read as `ABSENT`, and `ABSENT` is a measured incompatibility — so an image with no
`bash`, a blocked `docker exec`, a full tmpfs or a daemon error was published as
`EXCLUDE:glibcxx`. The task was blamed for the harness's failure, silently, because the row still
looked measured.

- `measuredGlibcxx(probeExit, output)` (`docker.ts:489-493`) now returns **`PROBE_FAILED`** for a
  nonzero probe, and `ABSENT` only for exit 0 with no match. Exit 0 with no `GLIBCXX_x.y.z` on stdout
  is a real measured property of the image — the probe pipeline ends in `tail -1`, so an image
  without `libstdc++.so.6` genuinely exits 0 with nothing — and that is what a library exclusion is
  for. The call site is `docker.ts:523`, which passes the **whole** provisioning invocation's exit
  status, not just the final `grep`.
- `PROBE_FAILED` is a single exported constant imported from `smoke-types.ts` by `docker.ts:43`, so
  the real path and the smoke carry **one** representation rather than two strings that can drift.
- `judgeMeasurement` tests it **before** `libraryCompatible` (`preflight.ts:193-195`), so it can never be
  laundered into a measured exclusion. `libraryCompatible` documents that it relies on that
  interception (`preflight.ts:154-159`).
- Its decision is `kind: "reject"`, `excluded: false`, **`stopDriver: true`**
  (`preflight.ts:326-337`): the driver stops rather than dispatching against a ceiling nobody
  measured. `driver.ts` and `report.ts` already branch on `decision.kind` and needed no change.
- In the smoke the same distinction is a row verdict of its own: `PROBE_FAILED` rows are excluded
  from every task verdict, counted in `coverage.probeFailed`, rendered in
  `coverage.verdictHistogram`, and named in the coverage statement
  (`smoke-preflight.ts:39-56`, `smoke-preflight.ts:119-127`, `smoke-preflight.ts:161-180`). The
  smoke's `finalize` **fails the run** when any row is unresolved
  (`smoke-report.ts:252-256`), so a `PROBE_FAILED` row can never sit in a green report.

Note the third test in the oracle/grader half is `oracleReward === "1"`
(`preflight.ts:174-188`, specifically line 155). A reward that is `null` is **not** a passing oracle —
see [the reward comes from the host file](#the-reward-comes-from-the-host-file-not-the-graders-stdout)
below.

Two more verdicts come from record **selection**, not measurement (`preflight.ts:254-281`):
`REJECT:no-record` and `REJECT:stale-identity`.

**An `EXCLUDE:*` is an explicit exclusion, not a green check.** It records that no model was ever
dispatched for that slot; it says nothing about how hard the task is and it does not license a
replacement.

### Record selection is by identity, never by directory presence

`selectGateRecord` filters the supplied records by `compareIdentities(...).fresh` and takes the
first survivor (`preflight.ts:254-281`). There is no "look in `preflight/`, else fall back to
`preflight-retry1`" search — that first-existing-wins fallback is exactly what silently kept the
stale `EXCLUDE:oracle-or-grader` record for `db-wal-recovery` in #1212 after the oracle had passed
(`preflight.ts:256-261`; reconciliation note D6).

**A stale record is REJECTED even when its verdict string still says `OK:`**
(`preflight.ts:254-281`, tested at `tests/scripts/eval/terminal-bench-2.1/preflight.test.ts:387-400`
— "a stale OK record must be rejected, not accepted").
If every supplied record is stale, the decision is `kind: "reject"`, `stopDriver: true`.

**Presence is not selection.** A gate record whose `identity.runId` (or any other pinned field)
differs is reported as `REJECT:stale-identity` even though the file is right there on disk — and it is
still counted in `gate.recordsRetained`, which counts files, not decisions
(`gateSummary`, `report.ts:568-595`).

The driver re-verifies independently. `decisionIsTrustworthy` requires a non-reject decision, a
present record, **and** a fresh identity comparison; a mismatch is a **gate failure, not an
exclusion**, "because it says the harness is untrustworthy rather than the task is hard"
(`driver.ts:56-63`).

### A gate failure stops the whole driver

A reject returns immediately from `runDriver` — "This is the defect the #1212 `break` failed to stop"
(`driver.ts:93-97`). `stop()` returns `code: 1` for every terminal stop
(`driver.ts:66-78`). An exclusion, by contrast, skips only that slot
(`driver.ts:98-101`, `preflight.ts:303-313`). An **`UNRESOLVED:`** decision skips nothing: it returns
from the driver exactly as a reject does, because dispatching on a ceiling nobody measured would
grade a task the gate never cleared — and neither does an **oracle refusal**, for the same reason
(§8).

### Exit codes

| Exit | When                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| `0`  | Every slot either dispatched or was explicitly excluded (`driver.ts:109-115`)                                |
| `1`  | `gate-failure` or `ceiling` (`StopReason` at `driver.ts:22-23`, `stop` at `driver.ts:66-78`)                 |
| `1`  | `slot-unavailable` — a contended slot, now classified instead of escaping (`cli.ts:768-781`)                 |
| `1`  | Any thrown error: unknown flag, missing required flag, `ConfigError`, unreadable manifest (`cli.ts:889-892`) |

`stopReason` is one of `completed`, `gate-failure`, `ceiling`, `slot-unavailable`
(`driver.ts:22-23`); `stoppedAt` is the slot key it stopped on, or `null`. An `UNRESOLVED:` gate
verdict and an **oracle refusal** are both reported under `gate-failure`, because the driver's only
question is whether the record it was handed is trustworthy (`driver.ts:93-97`); the distinction
between a stale record, an unmeasured ceiling and an inapplicable oracle lives in the verdict string,
in `gate.rejected` and in the refusal's `reasons` — not in a fifth stop reason.

### The reward comes from the host file, not the grader's stdout

`grade().reward` is read from the **host** artifact `<outDir>/logs/verifier/reward.txt` by
`retainedHostReward` (`docker.ts:973-982`, called at `docker.ts:892`). This was a real defect, found
by running the smoke: `grade()` used to scrape `/reward=(\S+)/` out of the grader's stdout, but every
task's `test.sh` writes `reward.txt` and never echoes it. The reward was therefore always `null`, and
since `judgeMeasurement` gates on `oracleReward === "1"`, **every** task — including one whose oracle
genuinely passes — was recorded `EXCLUDE:oracle-or-grader`. A green-looking exclusion produced by a
broken measurement path. The `/logs` bind mount exists precisely so the host can read this file, the
same way `retainedCtrfBytes` reads the CTRF (`docker.ts:950-956`).

A missing, empty or unreadable file reads as `null` and **never** as `"0"`: `0` is a real grader
verdict, and inventing it would make a broken measurement indistinguishable from a legitimately
failing oracle (`docker.ts:973-982`).

**`grade().exitCode` is NOT a success signal.** Every `test.sh` ends in the `if` that writes
`reward.txt`, so the grader script can exit `0` even when every test failed — measured: all three
graded tasks in the smoke returned exit `0` with reward `"0"`. Read `reward.txt` and the CTRF, never
the exit code alone. The smoke makes the same point structurally: it records `graderExit` but does
not assert it (`smoke-oracle.ts:73-76`, recorded at `smoke-oracle.ts:58`).

### The CLI emits a report

`main` builds the report after the loop and persists it (`cli.ts:866-878`). The output is the whole
`RunReport` object — **not** a three-key summary (`RunReport`, `report.ts:460-478`; built by
`buildReport`, `report.ts:768-807`).

| Where                        | Form                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| stdout                       | exactly **one compact JSON line** — `console.log(JSON.stringify(report))` (`cli.ts:887`)                                              |
| `<run-root>/run-report.json` | the **same object**, pretty-printed: `JSON.stringify(report, null, 2)` plus a trailing newline (`persistReport`, `report.ts:810-813`) |

The two are **semantically identical, not byte-identical**: the file is indented and newline-
terminated, stdout is compact. Compare them as JSON, not with `diff`.

`code` is the process exit status (`cli.ts:886`), so the exit code and the report's `code` field
always agree. `stopReason` and `stoppedAt` are `null` under `--report-only`, because no loop ran and
no stop is claimed (`report.ts:465-467`).

Top-level fields (`report.ts:460-478`): `schemaVersion`, `mode`, `runId`, `code`, `stopReason`,
`stoppedAt`, `slots`, `denominator`, `gate`, `attempts`, `spend`, `ceiling`, `checks`,
`countingPolicy`, `tornLines`, `reportPath`. `schemaVersion` is `REPORT_SCHEMA_VERSION = 1`
(`report.ts:114`), bumped whenever the shape changes so a stale report cannot be read as this one's.

Three things in it are load-bearing and are worth reading carefully:

- **Token fields are `number | null`, never `0` when usage is unknown.** `spend.usage` is `"unknown"`
  and every counter is `null` whenever any started attempt's usage could not be read
  (`spendSummary`, `report.ts:548-561`). `spend.observed` still carries what _was_ measured, so you
  can see it without it passing for a total. The ceiling's own reason reads
  `unknown usage for N attempt(s); unknown is not zero` (`accounting.ts:325-333`).
- **A failed required check forces the conditional verdict.** `checks` is
  `{"usable":false,"verdict":"not-usable","unconditional":false,"failedCheckIds":[…]}`
  (`buildReport`, `report.ts:796-802`), which is `evaluateChecks` + `usableVerdict` +
  `isUnconditionallyUsable` (`checks.ts:178-181`, `checks.ts:173-176`). There is no path from "a
  check failed" to an unconditional `usable`.
- **Gate records are persisted, and selected by identity only.** See below.

### Gate records are retained on disk

Every gate outcome is retained to `<run-root>/gates/<slotKey>.gate.json` and fsynced
(`retainGateRecord`, `report.ts:253-269`, fsync at line 221; called from `retainGateOutcome`,
`report.ts:345-362`, which `gateFor` invokes at `cli.ts:675-693`). Each file carries the **full
ten-field identity** inside the record — the nine pinned fields plus the slot key — so a later
selection can be made by identity alone (`RetainedGate`, `report.ts:239-244`; `GATE_RECORD_VERSION`,
`report.ts:116`).

A gate outcome that is not a pass is also written into the ledger, so accounting can count it: a
reject becomes a gate-failure row and an exclusion becomes a lifecycle row marked `excluded: true`
with `attemptStarted: false` and `modelDispatched: false` (`report.ts:354-361`, `recordGateExclusion`,
`report.ts:276-295`). This is how a run can state a denominator and still show the refusals that
produced it.

`readGateRecords` reads them back in slot-key order (it sorts the `<slotKey>.gate.json` names), and a
torn or recordless file reads as absent, never as `OK` (`report.ts:365-379`, `report.ts:381-394`). A
`--run-root` with no `gates/` directory at all yields an empty list, not an error — so
`gate.recordsRetained: 0` means "nothing was retained", and every slot then reads
`REJECT:no-record`.

**Presence is not selection.** `gateSummary` runs every manifest slot through `selectGateRecord`
(`report.ts:568-595`), so a record whose identity drifted is reported under `gate.rejected` as
`REJECT:stale-identity` while still being counted in `gate.recordsRetained`, which counts files rather
than decisions. `gate.ledgerRefusals` separately lists the pre-dispatch refusals the ledger recorded,
with their reasons.

### `--report-only` audits a run that already happened

`--report-only` emits the same report from a run root's retained records and dispatches nothing. It
needs only `--manifest` and `--run-root`, and it **refuses to create a run root it was not given** — a
mistyped path is a refusal, not a confident all-zero run (`reportOnly`, `cli.ts:819-839`; the refusal
message is `--report-only needs an existing run root to audit; … does not exist`). Gate records are
selected by identity only; there is deliberately no `preflight` / `preflight-retry1` fallback
(`cli.ts:47-49`). The ceiling still applies if you pass the two `--token-ceiling-*` flags
(`ceilingFrom`, `cli.ts:261-274`), and `--container-env` is irrelevant here because no container is
created.

```bash
npx tsx scripts/eval/terminal-bench-2.1/cli.ts \
  --manifest /path/to/manifest.json \
  --run-root /path/to/existing-artifact-dir \
  --report-only
```

---

## 9. Attempt lifecycle and recovery

### Ordering guarantees

1. **Unique attempt id** — `` `${slotKey}@${startedAtEpochMs}-${pid}` ``, so no two attempts collide
   (`attempt.ts:173-180`).
2. **Exclusive slot claim** using `O_EXCL` — "the kernel decides the winner atomically rather than a
   check-then-write in user space" (`attempt.ts:182-212`). A contended slot throws `SlotClaimError`
   (`attempt.ts:154-162`).
3. **Exclusive output-directory reservation** — an already-reserved directory throws
   `AttemptDirReservedError` rather than being reused or overwritten (`attempt.ts:224-233`,
   `attempt.ts:164-172`).
4. **Fsynced `started` record BEFORE dispatch** — `beginAttempt` writes
   `attempt-started.json` and fsyncs it; the ledger `intent` row is appended and fsynced
   (`attempt.ts:277-335`, `cli.ts:702-718`, `ledger.ts:102-110`). The started record carries real
   booleans for `attemptStarted` and `modelDispatched`; "#1212 wrote `pending` here and never updated
   it" (`attempt.ts:73-75`).
5. **Finalization records** for each outcome. `AttemptStatus` is `"completed" | "invalid" |
"interrupted"` (`attempt.ts:61`), written as `attempt-finalized.json`
   (`attempt.ts:107-120`, `attempt.ts:149-152`). The ledger phase vocabulary is `intent`, `completed`,
   `invalid`, `interrupted` (`ledger.ts:30`).
6. **TERM/INT inline finalization.** `TerminationSignal` is `"SIGTERM" | "SIGINT"`; SIGKILL is
   deliberately absent because nothing can act on it (`attempt.ts:478`). Exit codes are the
   conventional 128+signum — SIGTERM 143, SIGINT 130 (`attempt.ts:481-484`). A settled attempt is
   left untouched and no listener lingers to swallow a later signal.

Ledger phases and torn lines: `readLedger` counts unparseable lines as `tornLines`, and a non-zero
count is evidence the file was killed mid-append (`ledger.ts:142-152`, `ledger.ts:122-141`).

### Recovery after an unclean stop

`classifyRetained(dir)` classifies an attempt from its retained records alone (`attempt.ts:414-424`):

| Retained state              | Classification        |
| --------------------------- | --------------------- |
| Finalization record present | its recorded `status` |
| `started` present, no final | `interrupted`         |
| Nothing                     | `missing`             |

A started record with no finalization means the process died before the runner returned — the
SIGKILL case. That is **`interrupted`, never `missing`** (`attempt.ts:404-406`, `attempt.ts:408-412`).

To reconcile, run the library call — there is **no CLI flag for this today**:

```ts
reconcileInterrupted(ledgerPath, handleById, finishedAtEpochMs);
```

It finalizes every retained-`interrupted` attempt with `reason: "reconciled-from-retained-artifacts"`
(`attempt.ts:426-448`).

Rules for the operator:

- **Recovery must NOT silently redispatch.** An `interrupted` attempt was already dispatched. Its
  usage stays unknown (`accounting.ts:223-239`), which blocks further dispatch against a claimed
  budget until reconciled. Dispatching the slot again is a protocol change, not a recovery step —
  re-run under a new run id with a new artifact directory.
- An interrupted attempt stays visible inside `attempted` (§4). Do not delete its directory to make
  a report read cleaner; `missing` and `interrupted` are different facts.
- The `clean-stop` check fails when any attempt is unfinished or the ledger has a torn line
  (`scripts/eval/terminal-bench-2.1/checks.ts:90-99`).

---

## 10. The TUI protocol

A protocol is a JSON document validated by `parseProtocol`, which **fails closed**: a document that
cannot be honored raises `ProtocolError` rather than being repaired at run time
(`scripts/eval/tui/protocol.ts:1-20`, `protocol.ts:102-107`, `protocol.ts:214-236`).

```json
{
  "label": "<non-empty string>",
  "runKind": "measured",
  "dataDir": "<non-empty string>",
  "cwd": "<non-empty string>",
  "artifactsDir": "<non-empty string>",
  "conversationId": "<non-empty string>",
  "child": {
    "command": "<non-empty string>",
    "args": [],
    "env": { "<NAME>": "<value>" }
  },
  "stimuli": [{ "at": 0, "tag": "S1", "text": "<fixed stimulus text>" }],
  "readiness": {
    "tokenPrefix": "<non-empty string>",
    "probeTimeoutMs": 5000,
    "echoTimeoutMs": 3000,
    "attempts": 3
  },
  "delivery": {
    "chunkBytes": 8,
    "chunkDelayMs": 20,
    "settleBeforeSubmit": true,
    "settleWaitMs": 60000,
    "acceptTimeoutMs": 30000,
    "retryEnter": false
  },
  "stop": {
    "minSettleMs": 0,
    "horizonMs": 180000,
    "exitGraceMs": 10000,
    "innerWallMs": 3600000
  },
  "outerWatchdogMs": 3700000,
  "rssIntervalMs": 5000,
  "snapshotIntervalMs": 30000
}
```

Field names are exact (`protocol.ts:20-93`, `protocol.ts:245-273`). Two structural rules are
**enforced, not advisory**:

- **`delivery.retryEnter` must be `false`.** Any other value raises `ProtocolError` — "resending an
  unproven input is the #1219 defect; so it is not a knob" (`protocol.ts:13-17`,
  `protocol.ts:193-197`).
- **`outerWatchdogMs` must exceed `stop.innerWallMs + stop.exitGraceMs`**, so a forced kill can never
  race the graceful path it exists to protect (`protocol.ts:298-305`).

### Writing a protocol

- **Stimulus content is fixed.** `text` is frozen and matched exactly at acceptance (§11); an
  improvised follow-up cannot be matched.
- **`at` is an EARLIEST delivery time**, relative to the measured window — "never a promise that it
  is delivered at that instant" (`protocol.ts:20-21`). Stimuli are sorted by `at` and duplicate
  `tag`s are refused (`protocol.ts:187-201`).
- **Never blindly resend.** `retryEnter` is `false`; a stimulus past `settleWaitMs` is `refused`,
  "never silently discarded and never retried" (`protocol.ts:44-46`).
- **`child.env` names the child's EXACT environment.** Omit it (or set it `null`) and the child
  inherits the runner's byte-for-byte; an explicit `{}` is a real, empty environment, which is what
  makes a hermetic run hermetic (`ChildSpec`, `scripts/eval/tui/protocol.ts:64-74`; applied at
  `pty.ts:232`, `run.ts:702-706`). `parseChildEnv` (`protocol.ts:270-301`) rejects a non-object, a
  non-string value, an empty name, a name containing `=`, a NUL in either name or value, and any
  unexpanded `${…}` value. Every rejection names only the **variable name**, never the value: a
  value is the one place a protocol could smuggle a credential into evidence, and no env value is
  journalled, logged or written to an artifact.
- **`settleBeforeSubmit` is a real gate, not a hint.** When it is `true`, at most one stimulus may
  be **outstanding** — sent but not yet accepted — and the next one is held until that one is
  resolved or bounded out. The full rule is in _The `refused` verdict is reachable, and it halts_
  below.
- **`runKind` defaults to `measured`**, and must be declared as `resume` or `smoke` otherwise
  (`protocol.ts:218-229`). An unlabelled sample cannot be told apart from the
  measured window. **Never pool resume, preflight or smoke samples into the measured run.**

### Running it

```bash
npx tsx scripts/eval/tui/run.ts --protocol /path/to/protocol.json [--artifacts /path/to/dir]
```

`--protocol` is required; without it the CLI prints usage and returns **2**
(`scripts/eval/tui/run.ts:1163-1183`, the CLI entry that holds the guard and maps the code onto
`process.exitCode` at `run.ts:1205-1220`). `--artifacts` overrides the protocol's own
`artifactsDir` (`run.ts:1174-1177`); a thrown error exits 2 (`run.ts:1216-1219`).

Exit **0** means one specific, checkable thing: `check-report.json` is on disk and says `usable`.
Every deadline this driver awaits used to be an `unref()`ed timer, so a closing PTY child or relay
let the Node event loop drain and the process left with Node's **default status 0** — no report
printed, no `check-report.json` written. Three things close that:

- a ref'd `holdProcessAlive()` guard is held from **before the PTY is opened** until after teardown
  (`scripts/eval/tui/pty.ts:143-155`; acquired at `run.ts:695`, released by `releaseSession`'s
  `finally` after `session.dispose()` at `run.ts:754-765`; the CLI holds its own at
  `run.ts:1210`);
- `waitForExit`'s deadline is ref'd (`pty.ts:447-468`) — it is what phase 3 blocks on;
- `main` returns `verdictExitCode()` (`run.ts:1142-1161`), which **re-reads `check-report.json` from
  disk** and yields 0 only when the persisted report is `usable`; a missing, unreadable or
  non-usable persisted report is 1.

An unproven teardown is part of that verdict, not an exception out of it: `PtyCleanupError`
(`pty.ts:91-114`) is folded in as `cleanup_error` (`run.ts:1100`) and blocks `teardown.no_stray_process`
(`run.ts:978-983`), instead of throwing out of the `finally` and skipping the verdict entirely.

**This lifetime work does not explain the measured 24-second run.** That run preserved neither the
relay `EXIT` line nor any post-sample process status, so why its child and relay handles disappeared
remains unknown. The mechanism above stops the process from _silently_ draining out of a run; it does
not retroactively say what happened there.

`RunResult.runKind` is read from the protocol (`run.ts:1050-1055`), not hardcoded to `"measured"`, and
its type is the `RunKind` union. A resume or smoke run therefore reports the slot it actually
claimed, instead of contradicting the `counters.runKind` in its own artifact.

### Four timestamps, never one boolean

Every stimulus owns one record with four separate run-relative fields
(`scripts/eval/tui/acceptance.ts:40-55`):

| Field            | Meaning                                     |
| ---------------- | ------------------------------------------- |
| `due_at_ms`      | the earliest time it may be delivered       |
| `sent_at_ms`     | when it was actually written to the PTY     |
| `accepted_at_ms` | when persisted acceptance evidence appeared |
| `settled_at_ms`  | when its round reached a terminal boundary  |

The historical driver had ONE pending slot, so a failed verification was overwritten the moment the
next stimulus went due, and its report counted attempts instead of outcomes — "a run where two of
four stimuli were REFUSED read exactly like a clean 4/4" (`acceptance.ts:1-18`; reconciliation note
D9). `pending` is a real answer, never a soft pass (`isFinal`, `acceptance.ts:165-171`: only
`accepted`, `refused` and `timeout` are final, so `pending` can never be read as settled).

Verdict vocabulary per stimulus: `"pending" | "accepted" | "refused" | "timeout" |
"observer-error"` (`acceptance.ts:34-35`). A record is settled once its `settled_at_ms` is non-null
(`isSettled`, `acceptance.ts:509-515`), which only happens when a `boundary:"terminal"` descending
from the accepted event was found (`settledState`, `acceptance.ts:267-299`).

### The `refused` verdict is reachable, and it halts

A run that recorded a refusal must stop, not keep spinning to the inner wall — but read that
precisely. It holds only once **nothing is in flight**: a stimulus that is `accepted` but whose
round has not settled still counts as in flight (`isInFlight`, `run.ts:367-375`), so the driver
keeps polling toward the inner wall while that round is genuinely open. The verdict is unusable
either way; the difference is only how long the run takes to say so. `settleBeforeSubmit`
was parsed and every fixture set it `true`, but no code read it; the delivery gate it was supposed
to describe now exists, and it is shaped more strictly than "wait for the round to settle":

- **At most ONE stimulus may be OUTSTANDING.** A stimulus that is SENT but not yet ACCEPTED counts
  as outstanding, and the test is the ledger's own unresolved state, not the persisted lifecycle's
  `busy` (`outstandingSubmission`, `scripts/eval/tui/delivery.ts:107-118`). A typed but unaccepted
  stimulus has published no persisted boundary, so it is **not** `busy` while it sits in the
  composer — which is exactly why gating on `busy` typed the next stimulus into a composer that
  already held the previous one, and #1221's measured run persisted S1 and S2 as ONE user event.
- **A sent record is resolved only when BOTH halves are proven**: the independently persisted
  acceptance AND the correlated round's settlement.
- **Each half has its own bound, on its own clock** (`outstandingGate`, `delivery.ts:133-147`): the
  acceptance half by `delivery.acceptTimeoutMs` measured from `sent_at_ms`, the settlement half by
  `delivery.settleWaitMs` measured from `accepted_at_ms`.
- **Past either bound the PENDING stimulus is `refused`** — never typed, never retried, never
  silently discarded (`outstandingDecision`, `delivery.ts:151-177`).
- **The decision is a pure function** of `(protocol, ledger, clock)` in `decideDelivery`
  (`delivery.ts:241-283`); `busy` and `busySinceMs` are passed in rather than read from ambient
  state.

Four further properties keep a recorded refusal from being lost. All are test-verified:

- **`markRefused` no longer requires `sent_at_ms`** (`acceptance.ts:391-396`, docblock
  `acceptance.ts:382-397`). The only production caller refuses a stimulus the scheduler could not
  **submit**, which by construction was never marked sent. Guarding on a send made the `refused`
  verdict unreachable in production: a round that stayed busy was recorded `pending` / "not
  submitted" and the run had no way to close.
- **`noProgressLeft` uses a predicate, not a counter** (`run.ts:349-352` with `isDeliverable` at
  `run.ts:359-365` and `isInFlight` at `run.ts:367-375`). A stimulus is deliverable when it was never
  written **and is not already refused** — a refusal is final, so once recorded nothing further can be
  delivered, whatever the host does next. A run stays open while anything is still deliverable or
  still in flight, and only final verdicts close it.
- **A refused stimulus can no longer be blind-resent.** `markSent` returns `false` for a `refused`
  record (`acceptance.ts:371-379`), and `submit` honors that: it journals `submission_skipped` and
  types **nothing** (`run.ts:244-269`, the skip branch at `run.ts:257-265`). The refusal is the
  evidence; retyping the same unproven input is the #1219 defect `retryEnter: false` exists to
  prevent.

---

## 11. How acceptance is actually decided

The signature, implemented exactly (`scripts/eval/tui/acceptance.ts:12-19`): a **new persisted
user-message event** with `type === "message"`, `message.role === "user"`, `hostInjected` **absent**,
an `id` **not in the baseline set**, and concatenated text **equal** to the submitted text —
**corroborated by a `native_state` record with `boundary:"input"` anchored at that event in the
same conversation**.

Settlement is a `boundary:"terminal"` anchored at the round's reply
(`acceptance.ts:16-19`, resolved at `acceptance.ts:267-299`). `boundary:"tool_batch"` is internal
per-LLM-turn activity and is **never** a settle (`acceptance.ts:17-18`, tracked in `trackBoundary` at
`acceptance.ts:473-500`).

### What does NOT prove acceptance

Each of the following produced a false positive or a false negative in #1213. None of them is
evidence:

| Signal                               | Why it is not proof                                                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| A new session **filename** appearing | A sub-agent transcript is a real `.jsonl` under the measured conversation — this was the S4 false positive (reconciliation note D10) |
| File **mtime** or **size growth**    | Growth happens for writes that never become a user turn                                                                              |
| Terminal **byte growth**             | Redraw and status-line churn produce bytes with no submitted input                                                                   |
| **Sub-agent** session activity       | Real files under the conversation that the human never typed into                                                                    |

### The `hostInjected` guard

**176 of 386 user-role records in the measured store are `hostInjected` host plumbing**
(`tests/scripts/eval/tui/session-store-reader.test.ts:6-7`;
`scripts/eval/tui/session-store-reader.ts:15-16`). A text prefix match alone therefore accepts an
echo the human never typed. `isHostEcho` matches on `hostInjected` being **present** (`acceptance.ts:94-107`), while
`isRealUserMessage` is the rule that requires it **absent/undefined** before a user record counts
as real (`session-store-reader.ts:184-194`, at line 190).

### If idle cannot be proven, the run FAILS

`idleProven` is true **only** when the persisted lifecycle's last word is a `boundary:"terminal"` —
`lifecycleState` returns `"idle"` only for that boundary, and `"unproven"` when no boundary or an
observer error stands (`lifecycleState`, `acceptance.ts:481-485`). Idleness is never inferred
from silence. `missingPreconditions` adds `idle_proven` to the unmet list when it is false
(`scripts/eval/tui/stop-policy.ts:59-80`), and the required check
`idle.proven_from_persistence` fails — it requires `idleProven && allSettled`, so a partial run cannot
satisfy it on the strength of one terminal boundary (`check-report.ts:146-150`).

### Observer errors are never a quiet terminal

A malformed **complete** JSONL line is an `ObserverError`; an incomplete **trailing** line is a
normal mid-append state and must be waited on
(`tests/scripts/eval/tui/session-store-reader.test.ts:10-12`). Treating the malformed case as quiet
would read as "idle". `observer.no_errors` is a required check (`check-report.ts:182-186`), and an
observer error drives a stimulus to the `observer-error` verdict (`acceptance.ts:152`,
`acceptance.ts:408-417`).

**`observerClean` also considers `!state.observerFailed`** (`run.ts:973-976`). An observer error never
throws — it sets the flag and the tick returns `"halt"` — so a phase-throw-only predicate left this
check **green on a run that had stopped reading the store it is judged on**. The same corrupt store
meanwhile reddened `evidence.counters_derived`, so a broken store produced a report that was half
red about the wrong thing. The check now turns red on the malformed store itself.

### A split multi-byte character at EOF is not a corrupted store

The session-store reader holds its unterminated tail as **raw BYTES** and decodes through a
`StringDecoder` (`session-store-reader.ts:501`, `session-store-reader.ts:351-369`,
`session-store-reader.ts:615-618`). Decoding the tail eagerly turned the bytes after a multi-byte
character split at EOF into `U+FFFD`, which is indistinguishable from real corruption in a file that
genuinely is malformed. The reader no longer carries a byte cursor at all: it advances a **line ordinal** and re-reads
whole lines each poll, so the next read always resumes at a character boundary
(`session-store-reader.ts:617-619`).

It also no longer trusts that ordinal across a rewrite. `save()` rewrites the whole log and the
`session` header on line 1 grows, so every record after it shifts; the reader therefore re-anchors
on the TEXT of the last record it consumed, and raises an `ObserverError` rather than resuming
somewhere else when that record is no longer in the file (`reanchor`,
`session-store-reader.ts:568-583`).

---

## 12. The readiness probe

**There is no machine-readable READY event on this entry.** The historical driver's `--warmup 20` was
a bare `time.sleep` and "was the only reason its Enter landed" (`scripts/eval/tui/pty.ts:16-19`).

So readiness is proven by a **non-submitting PTY probe** (`probeReadiness`, `scripts/eval/tui/pty.ts:727`):

1. Type a unique token (prefix from the protocol plus a per-attempt random suffix) in paced chunks
   (`planChunks`, `PROBE_CHUNK_BYTES`/`PROBE_CHUNK_DELAY_MS` at `pty.ts:530-531`).
2. Assert every chunk is **painted by the surface**, not merely echoed by the line discipline
   (`waitForPaint`, `pty.ts:641`; the classification is `observePaint`, `pty.ts:604`).
3. **Clear the composer unconditionally** and assert no readable fragment of the token survives
   (`confirmNoResidue`, `pty.ts:682`).

`ready = echoed && cleared && enterWrites === 0` (`pty.ts:763`). The probe **never writes a CR**:
`PtySession.writes` is retained precisely so a test can prove that structurally
(`pty.ts:20-22`, `pty.ts:65`, `countEnterWrites` at `pty.ts:780`). The token must not contain CR or
LF (`makeToken`, `pty.ts:784`).

**"Echoed" means cell-addressed, and that distinction is the whole point.** A raw-PTY search for the
token is not evidence of a rendered composer: before the TUI takes input, the terminal echoes every
keystroke back itself, byte for byte, with no escape sequence at all. A real renderer, by contrast,
emits a cursor/erase sequence that **addresses a cell immediately before** each chunk it paints. The
probe therefore requires, for every chunk, an escape that addresses a cell — it counts the
cell-addressed chunks and the bare-echo chunks separately and reports both
(`PaintObservation.painted`/`bare`/`complete`, `pty.ts:563-567`), and `describeReadiness`
(`pty.ts:795`) names them in the failure detail. This is why the probe is chunk-by-chunk rather than
whole-token: the real composer repaints each paced chunk at the cursor, so the token is generally
**not contiguous** in the raw stream, and demanding one contiguous occurrence reported a ready,
rendering surface as not ready.

**The composer is cleared on every attempt, including the failing one** (`pty.ts:756-758`). This is
not a detail. Leaving residue behind is what made a failed probe corrupt the measurement: the next
attempt typed its token on top of the previous attempt's leftovers, and the first real stimulus was
then submitted together with all of it and persisted as a single merged user message — the #1221
symptom. The clear is written from the token's own length (`composerClear`, imported from
`delivery.js` at `pty.ts:30`) and the residue check scans **fragments**, so a partially echoed token
is caught too.

**Verified on the real surface, not only against a synthetic child.** `probeReadiness` is exercised
against the actual product TUI (`bun src/cli.ts tui`) in a real PTY against an isolated loopback stub
model, in a temp `HOME`/data-dir/workspace-root — see
`tests/scripts/eval/tui/readiness-probe-real-surface.test.ts`,
`readiness-probe-residue.test.ts` and `real-tui-input-acceptance.test.ts`. The assertion is
behavioural: a passed probe leaves **zero** token copies behind and the next real stimulus is
persisted verbatim as its own user event.

**The probe's verdict is recorded separately from the measured stimulus sequence** (`pty.ts:20-23`,
`run.ts:1-18`, Phase 1 at `run.ts:777-783`).

**Baseline order, stated precisely.** The store baseline is taken by `buildState` at
`run.ts:646`, **before** `runPhases` runs the Phase 1 readiness probe at `run.ts:781-784`. The probe is
therefore _inside_ the window the baseline opens, not after it. The probe still cannot contaminate
its own verdict — it is non-submitting by construction and its verdict is stored under its own key.
The module header already agrees with this call order: `run.ts:6-8` derives the Phase 2 report
relative to "a baseline taken BEFORE the probe", and records WHY taking it first is safe (the probe
only types, reads back and clears in the composer, so it never submits and adds no `type:"message"`
record). **No discrepancy is outstanding between the header and the code**; if a future edit moves
either call site, re-check that reasoning rather than trusting the comment (§17).

**Deliberate fail-loud behavior.** Readiness is never replaced by a fixed sleep. A surface that does
not paint every chunk, or that leaves residue behind, exhausts the protocol's `attempts` with
`ready: false` (`pty.ts:756-763`) — and the run does **not** stop there: it logs the verdict and
still enters the measured sequence (`run.ts:778-781`), so the report is the record of what the surface
actually did. The run is failed by the `readiness.probe` required check
(`check-report.ts:125-129`) and cannot produce a usable verdict, which is the fail-closed direction
that matters. Do not read the probe as a precondition that prevents typing; read it as a recorded,
required, falsifiable claim about the surface. A relay that cannot start is the harder failure and
does throw, naming `python3` as the required path (`pty.ts:500-509`). Detail strings name which
condition failed (`describeReadiness`, `pty.ts:795-812`).

### One line per stimulus: the transport fix and the ambiguity fix are different

Two independent defects could both produce "the host got only part of what the run sent". They are
fixed in two different places, and the two fixes are **complementary, not alternatives**:

|                           | Where                                      | What it fixes                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Transport correctness** | `pty-relay.py:135-158` (`consume_control`) | The relay drained only up to the first control line, so a multi-line stimulus written in one chunk was **silently truncated** — the remainder waited for a stdin read that never came. It now drains the whole buffer and returns the byte count actually consumed, with a guard so a future non-consuming branch can never spin the relay. |
| **Ambiguity**             | `protocol.ts:161-175` (`stimulusText`)     | A stimulus containing raw CR/LF is **refused by name**, quoting the tag and the offending field: the composer submits on the first newline, so a multi-line stimulus would put its first line in the host and strand the rest, and the run would then measure a stimulus the host never received as a whole.                                |

The relay fix makes the transport faithful; the protocol fix removes the input that made faithfulness
ambiguous. Neither alone is enough: draining the buffer faithfully would deliver a two-line stimulus
as two submissions and still measure the wrong thing.

---

## 13. Stop and exit

`/quit` is sent **only after every required stimulus is accepted AND settled AND the frozen horizon
is met** — `missingPreconditions` enumerates `accept:<tag>`, `settle:<tag>`, `settlement`,
`horizon` and `idle_proven` one by one (`scripts/eval/tui/stop-policy.ts:59-80`), and clean process
exit is then **verified**, with `detectedBy` retained because "a teardown discovery is weaker
evidence than a waitpid observed during the run" (`stop-policy.ts:18-26`).

Stop causes (`stop-policy.ts:15-16`):

| Cause          | Meaning                                      |
| -------------- | -------------------------------------------- |
| `clean_quit`   | `/quit` sent, process exited 0, not signaled |
| `forced`       | The harness had to kill the child            |
| `wall_timeout` | Inner wall exhausted                         |
| `process_exit` | Exited, but not as a clean quit              |
| `unproven`     | No exit observed at all                      |

`classifyStop` order is wall → forced → unproven → exit (`stop-policy.ts:42-57`).

**A forced stop can never satisfy natural-stop acceptance.** `natural` is true for exactly one
cause — a clean `/quit` exit with every precondition met — and `usable` follows `natural`
(`stop-policy.ts:90-125`, at lines 113-120). The two facts are deliberately separate: "a process that
exits 0 while two of four stimuli were refused is a `clean_quit` cause with `natural:false`", so
neither can hide the other (`stop-policy.ts:83-89`). On wall exhaustion or forced termination,
**evidence is retained** and the stop is classified explicitly by `forcedStop`
(`stop-policy.ts:127-139`).

### The cautionary example

#1213 run3 ended with `pty_eof`, `exit_status {exited:true, code:143,
detected_by:"teardown-waitpid"}`, `died_at_rel_s: null` — a forced stop with **no `stop_cause` field
anywhere** and no `quit` record, so the old report read as a run that had simply finished
(`scripts/eval/tui/stop-policy.ts:1-14`). Measured: 3330.3 s, exit code 143, `stimuli_sent: 4` /
`stimuli_total: 4` while the journal recorded two `submission_verified` and two `submission_failed`
(reconciliation note §8, §9; D8, D9, D12). Required checks `stop.clean_natural_exit` and
`evidence.counters_derived` exist to prevent that reading (`check-report.ts:152-156`).

### What is deliberately NOT in the verdict

Two things that looked like evidence were removed rather than kept:

- **The `EXIT-STATUS` relay verb is gone**, together with its doc comment. It always wrote a
  constant and no consumer ever read it, so it was a field that looked like a measurement and was
  not. The relay now recognises only the verbs it acts on — `KILL` and `SIZE`, and nothing else (`pty-relay.py:48-49`, dispatched at `pty-relay.py:172-176`).
- **`buildState` disposes the PTY session on any throw** before the `finally` is entered
  (`run.ts:626-667`). Teardown is owned by `runTuiCalibration`'s `try`/`finally`
  (`run.ts:729-737`), but that block is only entered once the state exists — so a throw while
  building it orphaned the relay and its child. Nothing in there throws today (`takeBaseline`
  swallows every error), which is exactly why the gap was worth closing: the first assertion added
  there would otherwise have leaked processes.

---

## 14. Evidence and reports

### Counts are derived, never hardcoded

Every count comes from the retained artifacts. The headless `summarize` reads the ledger and each
attempt's real on-disk evidence — `process/grader.log`, retained CTRF byte length, the scraped
result line — and returns `{denominator, spend, tornLines, slots}`
(`scripts/eval/terminal-bench-2.1/report.ts:198-224`, reached from `main` through `buildReport` at
`report.ts:768-772`). It is `main` that now calls it, and the report it builds is the CLI's output
(§8). Two details make the numbers trustworthy:

- `lifecycleRows` passes **one row per attempt**, preferring the finalization over the write-ahead
  intent, because a settled attempt leaves two ledger rows and `computeDenominator` counts what it is
  handed — passing the raw ledger counted every settled attempt twice (`report.ts:180-193`).
- The evidence map is keyed by **attempt id**, not by manifest slot key, because that is what
  `computeDenominator` looks the evidence up by. Keying by slot key made every lookup miss, so every
  settled attempt classified as `INVALID:ctrf,result_line` (`report.ts:207-219`).

`checksOf` derives `acceptedStimuli` as the frozen slot count **minus the explicit exclusions**, not
as the number of attempts that happened, so a slot that was accepted and then never settled is named
rather than counted as complete (`report.ts:736-761`).

`evidenceAssessments` passes `expectedTraces: null` deliberately: no caller can know the expectation
up front, and inventing one is what made the #1212 completeness verdict meaningless. The assessment
therefore records `unknown-expectation`, which fails `evidence-complete` rather than claiming a
completeness the run cannot prove (`report.ts:623-646`).

**Report independent counters with the observation window.** The TUI counters carry
`window: {startedIso, endedIso}` (`scripts/eval/tui/evidence.ts:198-208`, carried into `RunCounters`
at `tui/evidence.ts:220-224`). `deriveCounters` reads only the bytes **after the baseline offset** and
filters against the baseline event ids (`tui/evidence.ts:301-307`, `deriveCounters` at
`tui/evidence.ts:327`).

**Do not pool.** `separateRuns` keeps other runs' samples apart from the measured one
(`tui/evidence.ts:357`); required check `evidence.no_pooling`
("resume and smoke samples were kept separate") (`check-report.ts:170-174`).

### The hash index

The headless index excludes **itself and any temp file**: `name !== INDEX_NAME &&
!name.startsWith(`${INDEX_NAME}.`)` (`scripts/eval/terminal-bench-2.1/evidence.ts:415-430`, the filter
at line 419; rationale at `terminal-bench-2.1/evidence.ts:408-414`). It is written **atomically** —
payloads finalized first, then fsynced to a temp name and renamed — so a reader never observes a
partial index (`writeHashIndex`, `terminal-bench-2.1/evidence.ts:436-443`). `verifyHashIndex` checks
both the digest **and** the byte length on readback (`terminal-bench-2.1/evidence.ts:457-482`).

The TUI index is payload-only and holds back one further name: the verdict file
`check-report.json`, which carries this index's own digest (`scripts/eval/tui/evidence.ts:1-13`,
`buildIndex` at `tui/evidence.ts:88-95`, the exclude contract at `tui/evidence.ts:82-88`, and the
caller at `run.ts:812-828` with `exclude: [VERDICT_FILE]` at line 768 and `VERDICT_FILE` at
`run.ts:128`). Its digest and size are **verified on readback**, digest and bytes both
(`verifyIndex`, `tui/evidence.ts:156-198`, called at `run.ts:821`).

This is the direct fix for the historical index, which listed itself and recorded its own
pre-write digest and size — permanently 256 B stale, because a sha256 self-entry is structurally
unsatisfiable (reconciliation note D13, §10; `scripts/eval/tui/evidence.ts:6-9`). Required checks
`evidence.index_verified` ("digest and size verified on readback") and
`evidence.counters_derived` (`check-report.ts:158-162`).

### A failed required check prevents an unconditional `usable` verdict

The verdict rule is one-way: "There is no path from 'a check failed' to an unconditional `usable`"
(`run.ts:12-15`). `isUnconditionallyUsable` requires `report.usable &&
failedCheckIds.length === 0` (`scripts/eval/terminal-bench-2.1/checks.ts:178-181`), and
`usableVerdict` maps to `"usable" | "not-usable"` (`checks.ts:173-176`).

The headless side evaluates five checks, **all five required, none advisory**
(`checks.ts:154-167`):

| Check                 | Passes when                                                                   |
| --------------------- | ----------------------------------------------------------------------------- |
| `run-measured`        | The frozen list was measured at all, and not over-settled (`checks.ts:74-88`) |
| `clean-stop`          | No unfinished attempts and no torn ledger lines (`checks.ts:90-106`)          |
| `stimuli-settled`     | `settledStimuli === acceptedStimuli` (`checks.ts:107-118`)                    |
| `evidence-complete`   | Every assessment has `status === "complete"` (`checks.ts:120-137`)            |
| `protocol-compliance` | All four protocol clauses hold (`checks.ts:139-152`)                          |

`run-measured` exists because every check above passes vacuously over an empty
collection. A run whose slots were all gate-excluded previously reported
`usable`/`unconditional` with `failedCheckIds: []` — it had measured nothing and said
so with a clean bill of health. The floor check fails when the manifest declared at
least one slot and the run produced zero attempts, and it fails again when
`settledStimuli > acceptedStimuli`, so over-settlement is reported rather than absorbed.
A manifest declaring **zero** slots stays legal: there was nothing to miss.

Two consequences an operator will hit: the headless `usable` verdict is now **strictly
harder** to reach than before, and any prior run whose only claim to `usable` rested on a
declared-but-unmeasured list will now read `not-usable` with `run-measured` named. That is
the intended correction, not a regression.

The TUI side has fourteen required checks (`REQUIRED_CHECK_IDS`, `check-report.ts:14`, re-exported from `run.ts:78-86`): `protocol.pinned`,
`readiness.probe`, `acceptance.all_required`, `settlement.all_required`,
`idle.proven_from_persistence`, `stop.clean_natural_exit`, `evidence.counters_derived`,
`evidence.index_verified`, `evidence.no_pooling`, `evidence.single_session_file`,
`observer.no_errors`, `store.production_valid`, `evidence.no_secrets`,
`teardown.no_stray_process`. A failed check populates `blockedBy`, and `usable` is exactly
"no required check is red" — there is no override and no default-on for a missing fact
(`buildCheckReport`, `check-report.ts:219-230`).

**The gates are data; the verdict is the rule that consumes them.** `CHECK_GATES`
(`check-report.ts:118-205`) is an ordered fact → `(ok, diagnostic)` table, and `buildCheckReport`
derives `blockedBy` and the one-way verdict from it **without restating any gate**. A check added to
the table cannot be forgotten by the verdict, because the verdict reads the table. That separation
is why the table lives in `check-report.ts` and `run.ts` re-exports the names
(`run.ts:77-86`) — the extraction moved the implementation without moving a single name.

Evidence failure codes an attempt can carry: `tally-failed`, `zero-traces`,
`unknown-expectation`, `parse-failure`, `missing-blob`, `broken-reference`
(`scripts/eval/terminal-bench-2.1/evidence.ts:291-297`). Note the standing caveat: zero broken
references proves reference integrity, **not** the absence of lost whole records, "because a whole
record lost takes its references with it and leaves nothing to break"
(`terminal-bench-2.1/evidence.ts:309-316`).

---

## 15. The verification suite

Run the eval regression suite from the repository root:

```bash
npx vitest run tests/scripts/eval/
```

**Measured on this tree (Node v24.21.0, vitest 3.2.7): 38 test files, 658 tests, all passed, exit
0, duration 55.04 s.** Re-measure after any change to these modules; the numbers above are a
measurement, not a target.

```text
 Test Files  38 passed (38)
      Tests  658 passed (658)
   Start at  00:00:17
   Duration  55.04s (transform 5.37s, setup 0ms, collect 13.56s, tests 119.76s, environment 31ms, prepare 9.37s)
```

> **The PTY fixture is load-sensitive, so read a single PTY timeout with care.** The same suite
> measured 17.19 s green before the #1221 repair and 55.04 s green after it, and minutes earlier
> during development — while `cli.ts` and `runner.ts` were being edited underneath it — took 41.86 s
> with `pty-fixture.test.ts > halts on a recorded refusal instead of spinning to the inner wall`
> **timing out at 30 s** while all 21 other files and the file's other 9 tests passed. The same test
> passes in isolation in ~3.7 s. A PTY timeout under parallel load is therefore a contention signal,
> not a verdict about the refusal-halt path: re-run that file alone before believing it. The suite
> grants no extra grace for this, which is why the note is here. The growth after the repair is
> expected: the real-surface cases spawn a real `bun` TUI and a PTY per case, and `vitest.config.ts`
> caps the run at 3 forks.

| Area                    | Files                                                                                                                                                                       | What needs what                                                                                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless unit-level     | `terminal-bench-2.1/{accounting,attempt,cli,config,cli-config-path,docker,driver,evidence,identities,preflight,runner,smoke-exec,smoke-probe-failure,smoke-report}.test.ts` | Node only — no Docker, no PTY, no model calls                                                                                                                                                         |
| TUI unit-level          | `tui/{acceptance,check-report,delivery,evidence,protocol,pty-relay,pty-shutdown,session-store-reader,stop-policy,readiness-probe-residue}.test.ts`                          | Node only                                                                                                                                                                                             |
| Real PTY                | `tui/pty-fixture.test.ts`                                                                                                                                                   | `python3` and a PTY. Deterministic child, continuous redraw, existing session, delayed acceptance, recorded refusal — **no model calls**                                                              |
| Real product surface    | `tui/real-tui-input-acceptance.test.ts`, `tui/readiness-probe-real-surface.test.ts` (helpers: `_real-tui-pty-harness.ts`, `repainting-composer-child.ts`)                   | `bun` — the renderer is Bun-only, loaded through FFI — plus a PTY and the in-process **loopback stub model**. Fresh temp `HOME`/data-dir/workspace-root. **No real model, no credentials, no Docker** |
| Standalone CLI          | `tui/exit-contract.test.ts`                                                                                                                                                 | Spawns the CLI as a child process. In-process vitest holds the event loop open and structurally masks a standalone drain, so the exit contract cannot be proven any other way                         |
| Disposable Docker smoke | `scripts/eval/terminal-bench-2.1/smoke.ts`                                                                                                                                  | Docker, real images, a dataset, a bundle, a Node archive. **Not a vitest file** — see below                                                                                                           |

`smoke-exec.test.ts` covers the credential guard and the redaction; `smoke-probe-failure.test.ts`
covers the `PROBE_FAILED` row; `pty-relay.test.ts` covers the relay's buffer drain; and
`check-report.test.ts` covers the extracted gate table. None of them needs Docker or a model.

`real-tui-input-acceptance.test.ts` is the only place the **real** TUI input path is exercised end to
end, and it exists because a synthetic PTY child cannot prove acceptance: `fixture-tui-child.ts`
submits on every CR by construction, so it _assumed_ the very thing #1219 had to establish. The
real-surface cases assert against the persisted store — an independently tagged `type:"message"` per
stimulus, the correlated `head`, the `boundary:"input"` and `boundary:"terminal"` records, a genuinely
refused input persisting **nothing** — and record the whole timeline (outbound writes, stub request
times, first persisted event, relay exit) so a failure can be attributed to startup/readiness rather
than to acceptance. Measured on that surface, CR _does_ submit: the original worry that Enter never
reaches the product was disproven, and the merged-message failure was root-caused to the readiness
probe instead (§12).

There is **no `report.test.ts` and no `checks.test.ts`**. The report half is covered through
`terminal-bench-2.1/cli.test.ts` (54 tests), which drives the real entry point in a child process
against real files and asserts the emitted report — the denominator with its pre-dispatch gate
bucket kept separately visible, cache-creation and cache-read tokens inside the spend totals, and
one identity-bound gate record per slot selected by identity rather than by presence. The check
semantics (`checks.ts`) are covered from the same file. Do not assume a missing `*.test.ts` means a
missing test.

The PTY fixture covers `probeReadiness` proving readiness by echo + clear and never writing an Enter;
a surface that never goes quiet (so silence can never be read as idle); first input and follow-up
verified from persisted events; a resume in the **same** conversation without creating a new session
file; a recorded refusal **halting** the run instead of spinning to the inner wall; an observer error
reported as its own failed check rather than as clean; wall exhaustion classified forced and never
as natural completion; every counter derived from retained artifacts with output volume kept out of
it; and no live process after teardown.

### The disposable Docker smoke

This is a **standalone entry point, not a vitest file** — verified: no test under
`tests/scripts/eval/` imports `smoke.ts`. Run it manually:

```bash
npx tsx scripts/eval/terminal-bench-2.1/smoke.ts \
  --dataset <tasks-parent> --bundle <tgz> --node-archive <tar.gz> --out <dir> \
  [--tasks a,b] [--node-sha <hex>] [--bundle-sha <hex>] \
  [--glibcxx-floor GLIBCXX_3.4.31] [--grader-wall-sec 1800] [--grader-grace-sec 600] \
  [--skip-image-probe]
```

#### `smoke.ts` is a thin entry point: nine modules

`smoke.ts` is the entry point and composition only; the bulk of the work lives in the eight
modules below. It was one 1571-line file; it is now split along its real seams, and every
public symbol the monolith exported is re-exported from `smoke.ts`
(`smoke.ts:470-543`). Line counts are as of the review-repair round and are measured, not
aspirational:

| Module               | Owns                                                                                               | Lines |
| -------------------- | -------------------------------------------------------------------------------------------------- | ----- |
| `smoke.ts`           | entry point, composition, `runSmoke`, `main`, interrupt handling                                   | 542   |
| `smoke-types.ts`     | shared report/option/context vocabulary and constants                                              | 195   |
| `smoke-options.ts`   | argument parsing and `optionsFrom`                                                                 | 133   |
| `smoke-exec.ts`      | credential guard, redaction, exec wrapper, sealed port, container inventory, reap + signal install | 270   |
| `smoke-tasks.ts`     | task enumeration, per-task fact collection, independent expected mount list                        | 325   |
| `smoke-oracle.ts`    | the oracle/graded case and the curl-gap case                                                       | 314   |
| `smoke-negatives.ts` | the three negative cases                                                                           | 305   |
| `smoke-preflight.ts` | the full-list preflight sweep and coverage statement                                               | 198   |
| `smoke-report.ts`    | findings, markdown rendering, interrupted marker and the run's exit status                         | 280   |

Flag list and required set are `FLAGS` / `REQUIRED_FLAGS` at
`scripts/eval/terminal-bench-2.1/smoke-options.ts:11-24`; the usage block is at `smoke.ts:36-42`. Only
`--dataset`, `--bundle`, `--node-archive` and `--out` are required (`smoke-options.ts:24`, enforced by
`requiredFlag` at `smoke-options.ts:64-72`). `--tasks` defaults to `db-wal-recovery`,
`password-recovery`, `custom-memory-heap-crash` (`DEFAULT_GRADED_TASKS` at `smoke.ts:102`, applied
at `smoke.ts:421`). `--node-sha` / `--bundle-sha` must be 64 lowercase hex
(`shaFlag`, `smoke-options.ts:103-110`). Defaults for the rest — `glibcxx-floor` `GLIBCXX_3.4.31`,
`grader-wall-sec` 1800, `grader-grace-sec` 600, image probing on — are at `smoke-options.ts:124-131`.

It writes **only under `--out`** — every path it creates goes through `options.outRoot`
(`smoke.ts:112-115`, `smoke.ts:124`, `smoke.ts:346-348`), never into the repo or the reference
directories — and `main` sets `process.exitCode = 0` only when `report.passed`, else `1`
(`smoke.ts:450-455`).

#### The reward is expected to be `0`

**This surprises people, and it is correct.** The smoke grades a **pristine** container that nobody
solved, so reward `0` is the expected outcome for a task nobody has solved (`smoke-oracle.ts:128-132`).
The agent is never started: `dispatch` is unreachable through the sealed port, so no model can be
called and the smoke never alters a real task grade (`smoke-oracle.ts:1-12`, seal at
`smoke-exec.ts:169-187`). The harness proof is therefore the retained host-side CTRF plus a real
pytest result line and a clean `/logs` mount — never the reward alone, which would be exactly the
reward-only check issue 1219 forbids.

**The smoke still calls only `port.grade(...)`** — `gradeThenReap` at `smoke-oracle.ts:104-116` and
its one caller at `smoke-oracle.ts:155`. It has **no** route to `gradeOracle`: the sealed port it
holds is a `RunnerPort` whose surface does not include that method at all
(`smoke-exec.ts:169-187`). So a smoke row's `reward 0` / `EXCLUDE:oracle-or-grader` is **expected
output of a pristine grade**, and the oracle measurement in §8 happens on a different, disposable
container that the smoke never creates. Read the two separately: the smoke proves the harness runs;
`gradeOracle` proves the harness can see a task succeed.

A genuine oracle pass requires applying the task's own `solution/solve.sh` first, as the historical
preflight did. The smoke deliberately does not, because doing so would modify a real task's grade.

**Measured** on this machine, all three default graded tasks came back with `reward "0"` and
`hostReward "0"`, and every one of them reported `graderExit 0` — reward `0` with a clean exit, which
is exactly the trap in the paragraph below. Before the host-reward fix, all three reported
`reward null`.

What a graded row _does_ assert: `provision_exit=0`, boot verified (`iknow-native-ok`), `/logs`
writable from the grader's own path, host-side `ctrf.json` non-empty and retained, a real test result
line, and no network-failure marker (`provisionFailures`, `smoke-oracle.ts:81-108`). `graderExit` and
`reward` are **recorded, not asserted** — every `test.sh` ends in the `if` that writes `reward.txt`,
so it exits 0 even when all tests failed (`smoke-oracle.ts:73-76`). Read `reward.txt` and the CTRF,
never the exit code. The report carries both the port's `reward` and the independently read
`hostReward` (`smoke-oracle.ts:179`).

The report proves five things (`smoke.ts:11-21`): `preflightMounts(spec)` deep-equals
`sharedMounts(spec)` for every spec it builds; the **original grader** runs on a pristine container
with a real reward, retained host-side CTRF, a real pytest result line and the network marker; an
image genuinely lacking `curl` still provisions because Node is host-verified, with the image chosen
by **probing**, never assumed (`selectCurlGapImage` / `curlGapCase`, `smoke-oracle.ts:240-314`);
**three negative cases are detected** — a missing `/logs` mount
(`smoke-negatives.ts:84-119`), a stale identity fingerprint (`smoke-negatives.ts:168-213`), and a
corrupted Node archive (`corruptArchive` at `smoke-negatives.ts:222-233`, the case at
`smoke-negatives.ts:223-234`); and every container it creates is reaped and then **proven absent**
from `docker ps -a` (`cleanupOf` at `smoke.ts:237-248` against `listSmokeContainers` at
`smoke-exec.ts:190-207`, prefix `tb21-` at `smoke-types.ts:179`). The whole run's `modelDispatchCalls`
must be `0` or the report fails (the run-wide guard at `smoke-report.ts:250-263`), and so
must a `coverage.probeFailed` above zero (`smoke-report.ts:252-256`).

Note the smoke drives docker itself, so it forwards the host's proxy variables into its own `docker`
argv by itself (`injectProxyEnv`, `smoke-exec.ts:88-96`, enabled at `smoke.ts:160`). That is
independent of the headless CLI's explicit `--container-env` (§8), which reads nothing from
`process.env`.

```text
Validation:
- Run: the disposable Docker smoke, on this machine, against real Docker and the real images.
  npx tsx scripts/eval/terminal-bench-2.1/smoke.ts --dataset /home/winner/eval-1189/dataset
  --bundle /home/winner/eval-1189/bundle/iknow-bundle-9fa88f57.tgz
  --node-archive /home/winner/eval-1212/prov/node.tar.gz --out /tmp/tb21-smoke-1219
  --grader-wall-sec 420 --grader-grace-sec 120
  Result: exit 0, report.passed true, failures [], modelDispatchCalls 0, all three graded tasks
  reward "0" and hostReward "0", all three negative cases DETECTED, curl-gap case PASSED, leaked
  containers [].
- Note the trap this measures: every graded task reported graderExit 0 with reward "0". The exit
  code alone would have read as success on a run where every test failed. Read reward.txt.
- The grader wall was capped at 420 s (the default is 1800 s) to bound the run. The default is the
  value to use for a real grading run; a cap short enough to interrupt a grader can fail a task for
  a reason that has nothing to do with the harness.
- Recorded on the tree this guide describes; re-run it after any change to `smoke*.ts` or
  `docker.ts`, because a smoke result measures the harness rather than the task.
- Not run (in the pass that last revised this guide): a real agent attempt (`dispatch`) through the
  headless CLI. It needs a provider key and spends real tokens, and this guide documents the path
  rather than exercising it.
- Not run (in that pass): the `gradeOracle` before/after table in §8. Those numbers were measured
  earlier against real Docker and the real images while fixing the gate; they were not re-measured
  for this revision, which changed documentation only. Re-measure before quoting them as current.
- Expected command: npx tsx scripts/eval/terminal-bench-2.1/cli.ts --manifest <manifest.json>
  --dataset-root <dataset> --bundle <tgz> --node-archive <tar.gz> --settings <settings.json>
  --run-root <new-dir> --agent-wall-sec 3600 --grader-grace-sec 600
  --bundle-glibcxx-floor GLIBCXX_3.4.31 --token-ceiling-input 1000000 --token-ceiling-output 500000
- Blocking issue: authorizing a headless run requires a separate evaluation issue with its own newly
  frozen protocol and artifact directory (§1, §16). No run is claimed here, and none is authorized
  by this guide.
```

---

## 16. What this does not authorize

- **Not a new evaluation run.** Authorizing one requires a separate evaluation issue with a newly
  frozen protocol and artifact directory (§1).
- **Not a completion of any historical run.** The reconciliation note renders no verdict on #1212 or
  #1213 and no future document should make one retroactively. Cite it; do not restate it.
- **Not product change.** This tooling observes the product. Product changes — including the resume
  affordance — are out of scope for #1219.
- **Not permission to commit credentials, settings contents, dataset contents or historical run
  payloads** (§3).
- **Not permission to retrofit a denominator.** The counting policy is frozen
  (`frozenBeforeAnyOutcome`); exclusions are never back-filled by substitution (§4).
- **Not permission to report a forced stop, an unverified acceptance or a failed check as a clean
  run.** All three have a required check that blocks it (§11, §13, §14).

---

## Not yet stable

Interfaces that are implemented and covered by tests but are **not yet wired into a command**, or
where the code and the declared vocabulary disagree. Nothing below is documented as a runnable
operation because no such operation exists yet.

**Resolved since the first draft of this guide** — recorded so you do not look for them:
`slot-unavailable` is now emitted (`runSlots`, `cli.ts:768-782`); `summarize()` is now called by
`main` through `buildReport` (`report.ts:768-772`) and the CLI emits the full `RunReport` (§8);
`usageFromEvidence` is now reached from the report path as well as the per-attempt path; and gate
records **are** now persisted under `<run-root>/gates/` and selected by identity (§8).

1. **`reconcileInterrupted()` has no CLI flag.** The library call is the only way to finalize
   attempts left `interrupted` by an unclean stop (`attempt.ts:426-448`). It is covered by tests and
   described in §9, but no command invokes it. Reconciling by hand is a deliberate operator step,
   not a mode.

2. **`evidence-complete` cannot pass on the headless path today.** `evidenceAssessments` passes
   `expectedTraces: null` on purpose — no caller can know the expectation up front, and inventing one
   is what made the #1212 completeness verdict meaningless (`report.ts:623-646`). A `null`
   expectation always yields a `unknown-expectation` failure (`tallyFailures`,
   `terminal-bench-2.1/evidence.ts:330-345`), so for any run that attempted anything the check is red, `checks.verdict`
   reads `not-usable` and `unconditional` is `false` (`report.ts:796-802`).

   **This is the stated gap, not a broken run.** Read `failedCheckIds`: if the only entry is
   `evidence-complete`, the denominator, gate, spend and ceiling fields still stand on their own. Do
   not read a `not-usable` verdict as "the run failed", and do not delete the field to make the
   report read cleaner.

3. **A contended slot reports empty `dispatched`/`excluded` tallies.** When `runDriver` throws
   `SlotClaimError`, the driver's own tallies are lost, so `runSlots` returns them empty and says so
   (`cli.ts:768-781`). The artifact does not restate them: per-attempt truth is re-derived from the
   ledger, which still holds every row the contended run wrote. Read `report.attempts` and
   `report.denominator`, not `dispatched`.

4. **`StopReason` still contains a value the driver never constructs itself.** `slot-unavailable` is
   in the union (`driver.ts:22-23`) but only `runSlots` builds it, by catching `SlotClaimError`. A
   library caller of `runDriver` that does not wrap it in `runSlots` still sees the raw throw.

5. **The Docker smoke's Docker-dependent paths have no automated regression test** (§15). The pure
   report half is covered (`tests/scripts/eval/terminal-bench-2.1/smoke-report.test.ts`), but anything
   that needs a real container is exercised only by the manual entry point.

---

## 17. Known comment/code discrepancies

**This is no longer "none outstanding".** The #1219-post-#1220 repair and the reconciliation of this
guide against it added two records.

**`scripts/eval/tui/pty.ts:127-137` — stale item in a code comment, since FIXED.** The docblock above
`holdProcessAlive` enumerated what used to be unref'd: "`delay` below, **`waitForExit`'s deadline**, the
outer watchdog, …". `waitForExit`'s deadline is now **ref'd on purpose** and says so at
`pty.ts:459-467`; `delay` is still unref'd (`pty.ts:156-161`). The docblock reads as the history that
motivated the guard, which is worth keeping, but a reader checking the current code found one item no
longer true. Reported during the guide reconciliation, then corrected as part of the repair — the
comment now separates the two that are still unref'd from the one that was deliberately made ref'd.

**This guide's line references drifted during the repair and were re-derived.** The repair moved
`pty.ts`, `run.ts`, `delivery.ts`, `protocol.ts`, `session-store-reader.ts` and `config.ts` — and
running Prettier over the result shifted line numbers again after the first pass. Every `file:line`
reference in this guide was re-swept against the current tree, and the ones that no longer landed on
real content were corrected. The pre-existing baseline references that had already rotted were
corrected in the same sweep. **This is a maintenance hazard, not a solved problem:** a
`file:NNN` citation is load-bearing here and rots on every code change. A sweep that finds a
reference pointing at a blank line is a _detector_; it cannot tell you the reference is wrong rather
than merely badly aimed, and it says nothing at all about a reference that still lands on a line of
plausible-looking code that is no longer what the sentence is about. Treat these citations as
approximate and re-derive them when the code they name moves.

**One pre-existing markdown defect, since FIXED.** In the load-sensitivity note in §15, the line
beginning "spinning to the inner wall" was missing its `>` blockquote marker, so the note broke into
two paragraphs with the warning half-outside the warning. Present since before this repair.

**A diagnosis was wrong, and the correction matters more than the fix.** §12 previously described
the readiness probe as proving readiness by a whole-token echo search. Measured against the real
product TUI, that is not what happened: the composer repaints each paced chunk at the cursor, so the
token is generally **not contiguous**, the probe reported a ready surface as not ready, and because
the `!echoed` branch skipped the composer clear, the next attempt stacked another copy into the
composer. That — not a scheduler defect and not a CR that never submitted — is what merged two
stimuli into one user event. CR _does_ submit on the real path. §12 now describes the repaired
probe; the probe's contract is unchanged in intent, but its failure mode was exactly the thing that
corrupted the measurement.

**Three contracts in this guide described behaviour the code did not have, and one described a
behaviour that did not exist.** Correcting prose was necessary; no code was changed to match either
way, and no run's measured behaviour moved.

- The headless config input contract was stated as a literal blocklist of four historical #1212
  paths, and as "a blank value is treated the same as an inherited default". Neither is true.
  `isPlaceholder` means absent, blank, or an **unresolved template**; `isUnresolvedPathTemplate` adds
  the `<…>` form for paths only; `isInheritedDefaultLiteral` is a non-blocking diagnostic. The old
  blocklist refused every spec-compliant invocation, because the CLI makes those values mandatory
  explicit flags.
- `settleBeforeSubmit` was documented as a bounded settle wait that no code performed. The gate now
  exists and is stricter: at most one OUTSTANDING stimulus, two independently bounded halves, refusal
  past either.
- The CLI exit contract was stated as "0 only for an unconditional `usable` verdict". It now also
  requires the verdict to be **persisted** and re-read from disk.
- `child.env` did not exist. It is now documented in the protocol example and in _Writing a protocol_.

The earlier item this section listed — an ordering claim in the `run.ts` file header — remains
corrected: the baseline is taken at `run.ts:646` inside `buildState`, BEFORE the Phase 1 readiness
probe at `run.ts:781-784` inside `runPhases`. The comment records WHY taking it first is safe: the
probe only types, reads back and clears in the composer, so it never submits and adds no
`type:"message"` record, and the acceptance predicate could not match it either way. If a future edit
moves either call site, re-check that reasoning rather than trusting the comment.

issue 1219 puts product changes out of scope, so any _new_ comment/code discrepancy found while
reconciling this guide against the tree should be reported as a documentation defect in the
tooling — never silently "fixed" by changing what a run measures, and never left to mislead an
operator reading a report.

---

Historical accounting for #1212 and #1213, including the discrepancy register:
[`docs/evidence/1219-historical-reconciliation.md`](../evidence/1219-historical-reconciliation.md).
This guide deliberately renders no verdict on either run.
