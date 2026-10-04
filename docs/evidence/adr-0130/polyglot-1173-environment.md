# Measured environment state for the #1173 polyglot pilot

All values measured on this host during the run, not carried over from any prior note.

## Proxy / egress (WSL2)

| Item                                                                      | Value                                   |
| ------------------------------------------------------------------------- | --------------------------------------- |
| Host proxy                                                                | `http://172.31.128.1:7890`              |
| `registry-1.docker.io` direct (no proxy)                                  | **timeout** after 25s (`curl` code 000) |
| `registry-1.docker.io` via proxy                                          | **HTTP 401** in 1.9s (reachable)        |
| `github.com` in container, no proxy                                       | **FAIL**                                |
| `raw.githubusercontent.com/.../nvm.sh`, container, no proxy               | **FAIL**                                |
| `apt-get update` in container, no proxy                                   | **succeeds** (exit 0)                   |
| `apt-get` + curl + `github.com` + `raw.githubusercontent.com`, with proxy | install OK, 200 / 301                   |

`apt` works without the proxy but `github.com` and `raw.githubusercontent.com` do not, so the
node/nvm install step the adapter performs **requires** the proxy variables on `--ae` and `--ve`.

## Docker buildx — the first blocker, and its fix

| Item                         | Value                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Active builder (before)      | `g4repro`, driver `docker-container`, buildkit v0.32.2                                                            |
| Active builder (after)       | `default`, driver `docker`, buildkit v0.26.2                                                                      |
| `g4repro` build              | `#2 ERROR: ... Head "https://registry-1.docker.io/.../manifests/jammy": dial tcp 168.143.162.42:443: i/o timeout` |
| `default` build              | `resolve docker.io/library/buildpack-deps:jammy@sha256:dedabd7e46cd... 0.0s done`                                 |
| dockerd proxy drop-in        | `/etc/systemd/system/docker.service.d/proxy.conf`, present since 2026-09-29                                       |
| buildkit container proxy env | **absent** (`docker exec buildx_buildkit_g4repro0 env \| grep -i proxy` → empty)                                  |

Root cause: a `docker-container`-driver builder resolves base-image metadata from inside its
own buildkit container, which inherits no proxy. The `docker`-driver `default` builder resolves
inside `dockerd`, which _does_ have `HTTP_PROXY`/`HTTPS_PROXY` from the drop-in. Switching the
active builder with `docker buildx use default` is the whole fix; no daemon restart was needed
and no running container was disturbed. To restore: `docker buildx use g4repro`.

## Task image / C++ runtime — the second, unfixable-in-place blocker

| Item                                     | Value                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Base image, all 6 languages              | `buildpack-deps:jammy` (one Dockerfile per language, 6 distinct, 225 tasks)              |
| Task image `libstdc++6`                  | `12.3.0-1ubuntu1~22.04.3` (GCC 12)                                                       |
| `GLIBCXX_` ceiling measured in image     | **`GLIBCXX_3.4.30`**                                                                     |
| Newest `libstdc++6` in jammy archive     | `12.3.0-1ubuntu1~22.04.3` — nothing newer                                                |
| `apt-get install -y libstdc++6`          | exit 0, "already the newest version", ceiling **unchanged**                              |
| Required by the bundle                   | **`GLIBCXX_3.4.31`** (from `tree-sitter.node`)                                           |
| `tree-sitter-bash` requirement           | `GLIBCXX_3.4.21` (not binding)                                                           |
| Host toolchain (would-be rebuild source) | Ubuntu 26.04, g++ 15.2.0, `GLIBCXX_3.4.35` — **newer**, so rebuilding here does not help |

The gap is one release and it is the image's own ceiling, not a stale cache: jammy has no
newer `libstdc++6` to install.
