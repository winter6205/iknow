# Pre-outcome task selection — #1189 one-task Plan C calibration

**Recorded:** 2026-10-05 (before any model invocation)
**Purpose:** This is evidence calibration, not representative sampling. The task is
chosen to make the _measurement_ trustworthy (known-good environment and grader), not
to estimate capability. No model result existed for this run when these pins were fixed.

## Pinned inputs

| Field                      | Value                                                                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dataset                    | `harbor-framework/terminal-bench-2-1`                                                                                                                                                                                                                        |
| Dataset commit             | `7131e4375048a0e408a8fb404b5f499d726b695b`                                                                                                                                                                                                                   |
| Task                       | `overfull-hbox`                                                                                                                                                                                                                                              |
| Task tree sha256           | `2171f39c8768420dd1c4c765e7f7b99d13aaa92026dad4d0d971a4a4a586a183` — recipe: `find tasks/overfull-hbox -type f -not -path '*/.git/*' \| sort \| xargs sha256sum \| sha256sum`, run from the dataset root, so the per-file lines are part of the hashed input |
| `solution/solve.sh` sha256 | `e0e6d40406b33ed41cebe14636f173374ed2b2d4e2ae6cf734ac7a87a42b84ba`                                                                                                                                                                                           |
| `tests/test.sh` sha256     | `ab4ef5988c8694f6049eac703b7683a7f846c4714a61b764bd8e66e116abe16f`                                                                                                                                                                                           |
| `instruction.md` sha256    | `91381d7490afbbf11255e22471d3ed76317353d8e1da372fbc91887e65c57f47`                                                                                                                                                                                           |
| Task image                 | `alexgshaw/overfull-hbox:20260403`                                                                                                                                                                                                                           |
| Image digest               | `sha256:7dca952bb6736194a736b5110945f48842eafa8551e24468f1dddeed0daee799`                                                                                                                                                                                    |
| Declared difficulty        | easy                                                                                                                                                                                                                                                         |
| Verifier timeout           | 360 s                                                                                                                                                                                                                                                        |
| Agent timeout              | 750 s                                                                                                                                                                                                                                                        |
| Source commit under test   | `9fa88f570e20be3835694c6822802955d6ed4e17`                                                                                                                                                                                                                   |
| Bundle sha256              | `1525d540457b0cb5a68535890eb2960319fcb4a25126c62b51273954ac1b27e7`                                                                                                                                                                                           |

## Selection method (deterministic, applied before outcomes)

1. Enumerate all task directories in the dataset and take the **first** `FROM` line of
   each task's `environment/Dockerfile` as its base image. The pinned commit contains
   **89** task directories (`tasks/README.md` and `tasks/dataset.toml` are the only
   non-directory entries). Counting only the first `FROM` per task keeps a multi-stage
   Dockerfile from being counted twice.
2. The bundle's `tree-sitter` linux-x64 prebuild requires `GLIBCXX_3.4.31`
   (measured with `grep -ao` over `prebuilds/linux-x64/tree-sitter.node`, not read
   from a distribution label). Base-image histogram over the 89 tasks:
   - 41 × `python:3.13-slim-bookworm` — Debian 12, ceiling `GLIBCXX_3.4.30` → **ineligible**
   - 39 × `ubuntu:24.04` — ceiling `GLIBCXX_3.4.33` → eligible
   - 2 × `debian:13.0-slim` (trixie) — eligible
   - 2 × `python:3.11-slim`, 2 × `python:3.10-slim-bookworm`, 2 × `debian:bullseye-slim`, 1 × `python:3.11` → not selected
   - eligible pool: 39 + 2 = **41 of 89**
3. Require a published prebuilt image (`[environment] docker_image`) so no task-image
   build enters the measurement. All 41 candidates have one.
4. Require the grader to emit `ctrf.json`, which the #1167 validity rule names as the
   load-bearing "tests actually ran" signal. All 41 candidates have it.
5. From the eligible set, prefer the smallest verifier timeout and a difficulty the
   model has a demonstrated path to within the 40-turn cap, so that a bounded run
   yields a non-degenerate multi-turn trace to inspect. `overfull-hbox` is
   `easy` with the smallest verifier timeout in the pool (360 s).

## Why this task, stated honestly

- #1169 (2026-09-30) records `overfull-hbox` **passing at 40 turns**. That is a
  different run from this one, and it is the reason this task was preferred: the
  environment and grader are known to produce a runnable, gradeable measurement rather
  than an environment exclusion. It is **not** evidence about this run.
- Selecting a task with a known-good grader biases toward a _valid measurement_, which
  is the point of calibration. It does not bias the result toward a capability claim,
  because no such claim is made from one task.
- The eligible pool is 41 of 89 tasks. The 41 bookworm tasks are excluded on a measured
  runtime ceiling, not on task merit.

## Runtime compatibility, measured

| Measurement                           | Value                        | How                                                                                              |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Task image OS                         | Ubuntu 24.04.4 LTS           | `cat /etc/os-release` in container                                                               |
| Task image libstdc++ ceiling          | `GLIBCXX_3.4.33`             | `grep -ao 'GLIBCXX_3\.4\.[0-9]*' /usr/lib/x86_64-linux-gnu/libstdc++.so.6 \| sort -V \| tail -1` |
| Bundle `tree-sitter.node` requirement | `GLIBCXX_3.4.31`             | `grep -ao` over the prebuild in the bundle                                                       |
| Verdict                               | compatible (3.4.33 ≥ 3.4.31) | arithmetic on the two measurements above                                                         |

The measured ceiling, not the base-image name, is the predicate — the #1167 report
records one task that is nominally Ubuntu but does not clear the floor.
