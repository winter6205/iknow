# Evidence: `aider/aider-polyglot` A/B pilot for #1173 — blocked at `install()`, zero scored attempts

**Date:** 2026-10-02 · **Harbor:** 0.23.0 · **Adapter:** `iknow_harbor.agent:IKnowAgent`

## 0. Headline

**No scored attempt was made, in either arm.** The pilot did not reach the model
on any task. Every `aider/aider-polyglot` task ships the same base image,
`buildpack-deps:jammy`, whose C++ runtime ceiling is `GLIBCXX_3.4.30`; the iknow
bundle's `tree-sitter` prebuild requires `GLIBCXX_3.4.31`; and jammy's archive
carries no newer `libstdc++6` to install. The adapter therefore refuses the image
at `install()` with `IKnowCppRuntimeTooOldError`, by design, on all 225 tasks.

Consequently:

- **Software-task completion: unmeasured.** No reward, no turn count, no usage,
  no cost, no trajectory exists for iknow on this dataset.
- **#1171 permission behaviour: unmeasured.** The model is never invoked, so the
  A/B has no signal at all. The paired comparison this issue asks for **was not
  produced**, and this note must not be read as a clean result for either arm.
- **What _was_ established:** the adapter and dataset are mutually incompatible
  on this host for a precisely measured, single-release reason; the dataset's own
  graders are functional; and the selection, pinning, and both arm bundles are
  built and reusable for a follow-up run.

This is a report of an **incomplete** paired execution, per the issue's
acceptance criterion that "missing paired execution must be reported as
incomplete, not a successful evaluation".

## 1. Pinned configuration (all values measured on this run)

| Item                | Value                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Dataset             | `aider/aider-polyglot`, 225 tasks (cpp 26, go 39, java 47, javascript 49, python 34, rust 30)                                  |
| Dataset-wide digest | `sha256` over the 225 sorted `task.toml` → `65cb15ba5457dd26138e4855625c7aa9` (first 32 hex)                                   |
| Task registry ref   | `sha256:aee7e2b9eb32b2526227cf77cd9c5ccc36ca386bf939651874125609602163ce` (per trial `result.json` → `task_id.ref`)            |
| Model / provider    | `minimax-cn/MiniMax-M3.1-Flash-Preview`, endpoint `https://api.minimaxi.com/anthropic`, context 1,000,000 / max output 128,000 |
| Credential          | `--ae 'MINIMAX_API_KEY=${MINIMAX_API_KEY}'` (templatized; only `apiKeyEnv` is written into the container)                      |
| Selected tasks      | see [`polyglot-pilot-selection-manifest.md`](./polyglot-pilot-selection-manifest.md) (seed `1171`, before any model outcome)   |
| Budget planned      | 6 tasks × 2 arms, `max_turns=40`, no retries, concurrency 1                                                                    |
| Budget used         | **0 scored attempts** (install refused before the model call)                                                                  |

### The two arms

The GitHub CLI startup repair is held **byte-identical** in both arms, so it
cannot be misattributed to #1171.

| Arm       | Effective revision                                                                                   | Bundle sha256                                                      | Bundle size  | `BUILDINFO.json` | Smoke probes                     |
| --------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------ | ---------------- | -------------------------------- |
| Baseline  | `7d92e8e5bb9791fb5945a2c58668d2cd2f41ea91` (= `a094e728aa4e…` + the #1172 production fix, committed) | `9e494d16c722dd5fc101ba9b68bfa8a10f86bc540ab851fa4a3c9761793bbebf` | 49,816,426 B | `dirty:false`    | `0.1.0` ✅, `iknow-native-ok` ✅ |
| Candidate | `da2128efc36e6f8b8c9a756b412ef3398844b457` (#1171 + #1172)                                           | `e70a641b83e00490d14c3059a41b0c510b36e9d9ecbb169415eecc5458e59dbd` | 49,904,714 B | `dirty:false`    | `0.1.0` ✅, `iknow-native-ok` ✅ |

The backport is the production file `src/harness/sandbox/credential-read-mask.ts`
only, taken verbatim from `7d7e291a72c8610951a5aca9ea06fb2e4cebb76b`:

- patch-id (stable): `b7f41ed49a7845c5af9299803d2d4d2c8d8c3b7e`
- patch file sha256: `779aabfc922485a77975e453740bb3797d9b40a67055c5fd0b6c790cfd40123e`
- resulting file sha256, **identical in both arms**: `064e630949856b6f555b8f9b78e0be811b454c764d734af0bad8751f88a54a03`

A full `src/` tree diff of the two arms shows **39 differing entries** — exactly
the #1171 production delta, with `credential-read-mask.ts` absent from the list.
The arms differ in production code only by the change under test.

## 2. The blocking failure, verbatim

`harbor run … --install-only` on `aider/polyglot_cpp_meetup`, candidate arm, in
**1 m 13 s**, raising the adapter's own typed error:

```
iknow_harbor.agent.IKnowCppRuntimeTooOldError: the task image's libstdc++ still
provides at most GLIBCXX_3.4.30 after installing libstdc++6 via apt-get, but
iknow's tree-sitter prebuild needs GLIBCXX_3.4.31 (measured from the bundle:
_NZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE15__M_replace_cold...@GLIBCXX_3.4.31).
The distribution's own C++ runtime is the ceiling here, so this image cannot host
the shipped prebuild; use a task image with a GCC 12+ toolchain
(Debian 13/Ubuntu 24.04 or newer, RHEL 9+).
```

Retained at `runs/install2/2026-10-02__03-33-58/polyglot_cpp_meetup__9YiTGvL/exception.txt`.

### Why it cannot be cleared in place

| Measurement                                       | Value                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Base image, all six languages                     | `buildpack-deps:jammy` — 6 distinct Dockerfiles across 225 tasks, every one `FROM buildpack-deps:jammy`     |
| Toolchain change in any Dockerfile                | none. The only PPA is `deadsnakes` for `python3.11`; Rust uses rustup. `build-essential` on jammy is GCC 12 |
| `libstdc++6` in the image                         | `12.3.0-1ubuntu1~22.04.3`                                                                                   |
| `GLIBCXX_` ceiling in the image                   | **`GLIBCXX_3.4.30`**                                                                                        |
| Newest `libstdc++6` in the jammy archive          | `12.3.0-1ubuntu1~22.04.3` — **nothing newer exists**                                                        |
| `apt-get update && apt-get install -y libstdc++6` | exit 0, "already the newest version", ceiling **unchanged**                                                 |
| Bundle requirement (`tree-sitter.node`)           | **`GLIBCXX_3.4.31`** (measured with `objdump -T`, not read off an error string)                             |
| Bundle requirement (`tree-sitter-bash.node`)      | `GLIBCXX_3.4.21` — not binding                                                                              |
| Host toolchain (a rebuild source)                 | Ubuntu 26.04, g++ 15.2.0, `GLIBCXX_3.4.35` — **newer, so rebuilding on the host does not help**             |

The gap is one libstdc++ release and it is **the distribution's own ceiling**, not
a stale package cache: a refresh plus an install changes nothing. This is the
same failure class the adapter already documents and refuses by design for
Terminal-Bench's `fix-git` image; here it applies to the **entire dataset**.

**Classification: environment/verifier.** Not a model failure, not a turn-budget
failure, not a permission denial, and not process cleanup. No trace row exists to
cite because the process that would have written one is never started.

## 3. Environment / oracle check (per the issue's step 3)

Run before any model scoring, with Harbor's own `oracle` agent, which applies each
task's encrypted reference solution and then runs that task's own grader.

| Language   | Task                           | Oracle reward | What the check establishes                                                                                                                     |
| ---------- | ------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| C++        | `polyglot_cpp_meetup`          | **1.0**       | **Environment, grader, and reference-payload mechanism all work end to end on jammy.** One full clean `oracle → verifier` pass.                |
| Go         | `polyglot_go_connect`          | 0.0           | Grader runs and reports precisely, but the oracle payload did not land in the workspace                                                        |
| JavaScript | `polyglot_javascript_triangle` | 0.0           | same                                                                                                                                           |
| Python     | `polyglot_python_react`        | 0.0           | same (12 failed / 2 passed)                                                                                                                    |
| Java       | `polyglot_java_dominoes`       | **errored**   | task image **cannot be built**: `apt-get install -y openjdk-21-jdk` → exit 100 during `docker compose build`                                   |
| Rust       | `polyglot_rust_bowling`        | **errored**   | task image **cannot be built**: `curl … https://sh.rustup.rs \| sh -s -- -y` → exit 1; the build has no proxy, so the toolchain download fails |

So **two of six languages (Java, Rust) carry a second, independent exclusion**:
their task images do not build on this host at all, before the C++ runtime is
ever considered. Only C++ completed the full oracle cycle, which is why it is the
one language whose environment and grader this pilot can certify.

### The 0.0s are not a dataset defect, and not only a concurrency artifact

I checked this rather than reporting it as a broken dataset, and the dataset is
**fine**. Decrypting each task's own `solution.enc` with the documented default
password gives correct, per-language manifests:

```
polyglot_cpp_meetup          -> files/example.h|meetup.h
polyglot_go_connect          -> files/example.go|connect.go
polyglot_javascript_triangle -> files/proof.ci.js|triangle.js
polyglot_java_dominoes       -> files/Dominoes.java|src/main/java/Dominoes.java
polyglot_python_react        -> files/example.py|react.py
polyglot_rust_bowling        -> files/example.rs|src/lib.rs
```

The Go and JavaScript payloads are correct in **three** independent places: the
installed dataset, Harbor's own task cache
(`~/.cache/harbor/tasks/packages/aider/polyglot_go_connect/503ca184…/environment`),
and a **fresh image built from that cache context** — I built one and decrypted
`/app/.oracle/solution.enc` inside it, and it carries the correct
`files/example.go|connect.go`.

Yet the executed trials applied the **JavaScript** payload to the Go workspace.
At `-n 2` the two trials took each other's payload; at `-n 1` the Go trial **still**
logged `Copied proof.ci.js -> triangle.js`, while the JavaScript trial got its own
payload right and scored **1.0**. So:

- the JavaScript 0.0 was a concurrency artifact — the `-n 1` re-run scores 1.0;
- the **Go 0.0 is not explained by concurrency** and is **unresolved**. The
  substitution happens at trial execution, not in the dataset, the cache, or the
  image build, and I did not isolate the mechanism.

This is why the graders look "failing" when the solution was simply never written
into the workspace:

```text
[go task]  panic: Please implement the ResultOf function
           at /app/connect.go:4
[js task]  throw new Error('Remove this statement and implement this function')
           at triangle.js:8:11
```

**Coverage conclusion:** the _verifier and image_ are validated by the C++ 1.0
pass, and the JavaScript task is validated by its `-n 1` 1.0. The Go 0.0 and the
Python 0.0 must **not** be read as "these tasks are unsolvable" — for Go the
cause is an unexplained payload substitution, for Python it was the same
concurrency crossing and has not had its own `-n 1` control. Java and Rust are
excluded on image build. No per-language oracle number should be quoted from this
pilot beyond C++ and JavaScript.

## 4. A host-level blocker found and fixed en route (not part of the A/B)

The first oracle attempt failed in 42 s for every task, before any image build:

```
#3 ERROR: failed to do request: Head
"https://registry-1.docker.io/v2/library/buildpack-deps/manifests/jammy":
dial tcp 168.143.162.42:443: i/o timeout
```

Root cause, measured rather than guessed: the **active buildx builder was
`g4repro`**, a `docker-container`-driver builder. Such a builder resolves
base-image metadata from inside its own buildkit container, which inherits **no
proxy** (`docker exec buildx_buildkit_g4repro0 env | grep -i proxy` → empty). The
`docker`-driver `default` builder resolves inside `dockerd`, which _does_ carry
`HTTP_PROXY`/`HTTPS_PROXY` from
`/etc/systemd/system/docker.service.d/proxy.conf`. Same Dockerfile, both builders:

| Builder                      | Result                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `g4repro` (docker-container) | `i/o timeout` to `registry-1.docker.io`                                         |
| `default` (docker)           | `resolve docker.io/library/buildpack-deps:jammy@sha256:dedabd7e46cd… 0.0s done` |

Fix: `docker buildx use default`. No daemon restart, no running container
disturbed. Container egress is separately required: `github.com` and
`raw.githubusercontent.com/.../nvm.sh` both **FAIL** from a container with no
`*_PROXY` variables (the node/nvm install the adapter performs), while
`apt-get update` happens to work — so the proxy must be injected on both `--ae`
and `--ve`. Measured detail: [`environment-probe.md`](./environment-probe.md).

## 5. Per-task accounting — nothing is silently missing

| Task                           | Language   | Oracle                | iknow install (candidate)    | iknow scored run | Reason not run                                                                                                |
| ------------------------------ | ---------- | --------------------- | ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `polyglot_cpp_meetup`          | C++        | 1.0                   | `IKnowCppRuntimeTooOldError` | **none**         | install refused; ceiling `3.4.30` < `3.4.31`                                                                  |
| `polyglot_go_connect`          | Go         | 0.0 (unresolved)      | not attempted                | **none**         | same, dataset-wide; image build ~15 min, would fail identically                                               |
| `polyglot_java_dominoes`       | Java       | errored               | not attempted                | **none**         | **two** independent blockers: image build fails (`openjdk-21-jdk` exit 100) **and** the GLIBCXX ceiling       |
| `polyglot_javascript_triangle` | JavaScript | 1.0 at `-n 1`         | not attempted                | **none**         | same as Go                                                                                                    |
| `polyglot_python_react`        | Python     | 0.0 (uncorrected)     | not attempted                | **none**         | same as Go                                                                                                    |
| `polyglot_rust_bowling`        | Rust       | errored (image build) | not attempted                | **none**         | **two** independent blockers: image build fails (`sh.rustup.rs` download, exit 1) **and** the GLIBCXX ceiling |

Excluding the languages whose images will not build (Java, Rust) and stopping
after the first refusal is deliberate: the refusal is **dataset-wide and
arm-independent** (all
225 tasks share one base image, and both bundles carry the same
`tree-sitter@0.25.1` prebuild), so repeating it on four more languages would
spend hours of image builds to re-measure a constant. One refusal per distinct
failure mode is the evidence, not twelve copies of it.

## 6. What this pilot establishes, and what it does not

**Establishes**

1. **`aider/aider-polyglot` is not runnable by the current iknow bundle on this
   host**, for a measured one-release reason, with the adapter correctly
   refusing rather than mis-scoring. This is a genuine finding about adapter
   feasibility that the issue asked for, and it is a **hard** finding: it applies
   to all 225 tasks and both arms.
2. **The dataset's graders are functional** on `buildpack-deps:jammy` — a
   reference solution scores 1.0 — so the exclusion is attributable to the
   bundle's native-addon requirement, not to the tasks.
3. The selection, dataset pinning, both arm bundles, and the gh-CLI parity
   backport are all built, hashed, and verified, so a follow-up run starts from
   a reproducible state rather than from scratch.
4. A reusable host-level fix: the buildx builder choice, not the proxy
   configuration, was what broke image builds.

**Does not establish (must not be inferred)**

- Anything about **iknow's ability to complete software tasks**. No reward exists.
- Anything about **#1171's permission behaviour** — no false-denial change, no
  hard-wall denial, no preserved protection. The permission posture requested
  (`permission_mode=full_auto`, `eval_state=false`, real production sandbox) was
  configured but never exercised, so the issue's central question is **open**, not
  answered.
- Any rate, score, or comparison. Twelve attempts were budgeted; **zero** were
  made. This is a feasibility check that stopped at the first hard gate.

## 7. Follow-up proposals (from the observed failure, not invented)

1. **Decide the C++-runtime policy for old task images.** The adapter currently
   refuses, which is correct but makes a whole dataset unmeasurable. Options:
   a build-time remedy (compile `tree-sitter`/`tree-sitter-bash` from source with
   a `GLIBCXX ≤ 3.4.30` toolchain and ship that prebuild, applied identically to
   both arms, recorded as a deviation from the stock bundle), or an accepted
   exclusion of pre-GCC-12 images. This is a product decision, not a test fix.
2. **Use a dataset whose base image clears `GLIBCXX_3.4.31`** (Ubuntu 24.04 /
   Debian 13 / RHEL 9+) to get the paired #1171 measurement this issue actually
   wants. `terminal-bench/terminal-bench-2-1` is the existing precedent and
   already completes `setup → install → run → verifier` per #1167.
3. **Investigate the Go payload substitution** (§3): the Go trial applied the
   JavaScript solution at both `-n 2` and `-n 1`, although the payload is
   correct in the dataset, in Harbor's cache, and in a freshly built image. Until
   that is explained, no Go oracle number from this dataset is trustworthy.
4. **Investigate `openjdk-21-jdk` on jammy** (exit 100) if Java coverage is
   wanted; the build has no proxy of its own, so the cause is not yet separated
   from the registry-egress issue.
5. Consider a per-task `libstdc++` preflight in the task-selection step, so an
   image/runtime incompatibility is caught in seconds instead of after a 15-minute
   image build.

No testing-rule change, no new evaluation framework, and no leaderboard work is
included, per this issue's scope.

## 8. Acceptance checklist

- [x] Public dataset revision, task selection manifest, configurations and both
      effective code versions pinned and reproducible (§1, manifest file).
- [x] Environment/oracle checks preserved; every excluded or unrun item
      explicitly accounted for (§3, §5).
- [ ] **Paired per-task report with raw outcomes, failure evidence, duration and
      cost — NOT MET.** No scored run exists, so there are no raw outcomes,
      costs, or durations to report. Reported as incomplete, as required.
- [x] Conclusion states what the pilot establishes and what remains unmeasured (§6).
- [x] Follow-up proposals based on observed failures; no testing-rule changes (§7).
