# Task selection manifest: `aider/aider-polyglot` A/B pilot (#1173)

Six tasks, one per required language, selected **before** any model outcome was
collected. This file is the recorded selection; the digests below are what makes
it checkable after the fact.

## Pinned inputs

| Item                | Value                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| Dataset             | `aider/aider-polyglot` (registry), 225 tasks                                                       |
| Harbor              | 0.23.0                                                                                             |
| Dataset resolution  | `@latest`; task content pinned per-task by digest below                                            |
| Dataset-wide digest | `sha256` over the 225 sorted `task.toml` files → `65cb15ba5457dd26138e4855625c7aa9` (first 32 hex) |
| Selection seed      | `1171` (the #1171 ticket number, as the issue specifies)                                           |
| Language order      | `cpp, go, java, javascript, python, rust` (fixed, alphabetical)                                    |

## Sampling method

For each language, over the **eligible** public task IDs:

1. sort the IDs lexicographically (byte order);
2. derive a per-language digest `sha256("<seed>:<language>")`;
3. take its first 8 hex characters as an integer;
4. select `index = int % len(eligible)`, and take `eligible[index]`.

The method is a pure function of `(seed, language, eligible-set)`, so it is
reproducible without reference to this run, and it cannot see any model result —
it is drawn from the ID ordering, not from pass/fail.

## Selected six

| Language   | Eligible | `sha256(1171:lang)[:8]` | Index | Task ID                        | Task content digest (16) | Grader present                                                  |
| ---------- | -------- | ----------------------- | ----- | ------------------------------ | ------------------------ | --------------------------------------------------------------- |
| C++        | 26       | `a9c903d9`              | 15    | `polyglot_cpp_meetup`          | `ba65a14af104fea0`       | `tests/meetup_test.cpp`, `tests/test.sh`                        |
| Go         | 39       | `56d965e7`              | 5     | `polyglot_go_connect`          | `49017914ab4ad8c7`       | `tests/cases_test.go`, `tests/connect_test.go`, `tests/test.sh` |
| Java       | 47       | `92f02c15`              | 11    | `polyglot_java_dominoes`       | `d35b35a56cd25469`       | `tests/src`, `tests/test.sh`                                    |
| JavaScript | 49       | `1a7366b6`              | 41    | `polyglot_javascript_triangle` | `c5556c90f604964b`       | `tests/triangle.spec.js`, `tests/test.sh`                       |
| Python     | 34       | `5d5ef497`              | 21    | `polyglot_python_react`        | `d8b052664b4f7205`       | `tests/react_test.py`, `tests/test.sh`                          |
| Rust       | 30       | `0b929f12`              | 4     | `polyglot_rust_bowling`        | `5be1d51191b4dc60`       | `tests/tests`, `tests/test.sh`                                  |

Per-language eligible counts are the full public task set of that language in the
installed dataset (no task was excluded before selection).

## Exclusions

None were applied to the eligible set: all 225 tasks are public, and every one of
the six selected tasks ships its own `tests/test.sh` grader. Harbor registry
ref, `sha256:aee7e2b9eb32b2526227cf77cd9c5ccc36ca386bf939651874125609602163ce`
is recorded per trial in each run's `result.json` (`task_id.ref`).

The task content digest is `sha256` over the task's own non-`.oracle` files, so
it moves if the graders or instructions change, and not on registry re-uploads of
an unchanged task.

## Reproduction

```bash
cd <dataset-root>            # the directory holding the 225 polyglot_* task dirs
python3 - <<'PY'
import hashlib, os, re
for L in ["cpp","go","java","javascript","python","rust"]:
    elig = sorted(t for t in os.listdir(".") if re.fullmatch(rf"polyglot_{L}_[A-Za-z0-9\-_]+", t))
    h = hashlib.sha256(f"1171:{L}".encode()).hexdigest()
    print(L, len(elig), h[:8], int(h[:8],16) % len(elig), elig[int(h[:8],16) % len(elig)])
PY
```
