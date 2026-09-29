# iknow Harbor adapter

Measures iknow on Terminal-Bench 2.1 through Harbor 0.23.0. iknow has no Harbor
entry and does not speak ACP, so the adapter is supplied as a custom agent class:

```
--agent iknow_harbor.agent:IKnowAgent
```

## 1. Build the iknow bundle (host)

iknow is `private: true` with no `publishConfig`, so `npm install -g iknow` is
not an option. The adapter uploads a production bundle tarball built on the host.

Canonical path — from the repo root:

```bash
BUNDLE_OUT=/tmp/iknow-bundle.tgz ./scripts/harbor/build-bundle.sh
```

The script runs `npm run build`, copies the **transitive** production closure
(`npm ls --all --omit=dev --parseable`) plus `package.json`, `dist/`, and
`vendor/ripgrep` into a temp stage, stamps `BUILDINFO.json` (gitSha / dirty /
arch), tars to `$BUNDLE_OUT`, then untars into a second temp dir and runs the
same two smoke probes the adapter runs at install time. It never runs
`npm ci --omit=dev` inside the repo, because that would delete the
devDependencies the TypeScript test suite needs.

Measured 2026-09-29 with the **full** script (its own `npm run build` included,
so all three halves — build, staging, verification — were exercised):
both probes green — `0.1.0` and `iknow-native-ok` — 50M tarball,
`vendor/ripgrep/15.1.0/linux-x64/rg` and `BUILDINFO.json` present at the stage
root, `BUILDINFO.json` = `{"gitSha":"4c584c06c…","dirty":true,"arch":"linux-x86_64"}`.
An earlier measurement of the same script had the build step removed (`dist/`
reused from a prior green build) and reported 155 top-level `node_modules`
entries; a depth-1 recount of the freshly built tarball gives 154, which is the
same closure with `@scope` directories counted individually rather than as their
members.
`typescript@5.9.3` appears inside the closure; it is a _production_ dependency of
`@opentui/core → bun-ffi-structs`, not a leak from the dev tree.

For an attributable artifact (a scored run should name a commit, and `dirty:true`
above says the stamp records the truth rather than enforcing it), build the same
closure from `HEAD` in a scratch tree instead:

```bash
WORK=$(mktemp -d)/iknow-build && mkdir -p "$WORK"
git -C ~/projects/iknow archive HEAD | tar -x -C "$WORK"
cd "$WORK"
npm ci --ignore-scripts          # dev deps: needed for tsc
npm run build                    # -> dist/
mkdir bundle && cp package.json package-lock.json bundle/
cp -r dist bundle/dist
cd bundle
npm ci --omit=dev --ignore-scripts   # --ignore-scripts: root "prepare": "husky"
                                     # makes a plain `npm ci` exit 127
du -sh .                         # measured: 197M (node_modules 183M + dist 15M)
tar czf /tmp/iknow-bundle.tgz -C "$PWD" .   # measured: 41M
```

`--ignore-scripts` on the prod install is required: without it `npm ci` runs the
root `prepare` hook (`husky`), which is absent from a prod-only install, and
exits 127.

### Why a host-built tarball instead of an in-container `npm install`

| route                                                                      | size / requirement                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) upload host-built prod bundle tarball                                  | 197M tree -> **41M tarball**, one `upload_file`, no registry access in the container                                                                                                                                   |
| (b) upload `package.json` + `dist/`, `npm install --omit=dev` in-container | full local `node_modules` is 434M gz-equivalent; needs registry egress during setup (task images may set `allow_internet = false`) and rebuilds `tree-sitter`/`tree-sitter-bash` from source unless prebuilds download |
| (c) `npm install -g iknow`                                                 | impossible: package is unpublished                                                                                                                                                                                     |

Chosen: **(a)**. It is the only route that is independent of task-image network
policy, and it keeps the native-addon binaries identical to the ones already
verified on the host. The cross-libc risk that (a) carries is handled explicitly
below — both the libc-family half and, since a scored trial failed on it, the
C++-runtime half.

### Verifying the bundle on the host

`build-bundle.sh` does this itself as its last step; by hand:

```bash
V=$(mktemp -d) && tar xzf /tmp/iknow-bundle.tgz -C "$V" && cd "$V"
node ./dist/cli.js --version                 # 0.1.0
node -e "import('tree-sitter').then(() => import('tree-sitter-bash'))
  .then(() => console.log('iknow-native-ok'), (e) => { console.error(String(e && e.message)); process.exit(1); })"
```

`--version` alone does **not** prove the native addons load: tree-sitter is
imported lazily by the bash tool. The adapter therefore runs both probes as an
install-time smoke test, and refuses musl/Alpine images up front with
`IKnowGlibcRequiredError` (`tree-sitter@0.25.1` and `tree-sitter-bash@0.25.1`
ship glibc-only prebuilds). The smoke test's first leg prints a marker, so a
failure is attributed to the half that failed: node not runnable at all raises
`IKnowNodeUnavailableError`, while node having run and then failed to load the
addons is what raises `IKnowGlibcRequiredError`. Reporting the latter for the
former sent a real trial's missing-node failure to the wrong remedy.

#### The C++ runtime: `GLIBCXX_3.4.31`

A second scored trial (`terminal-bench/fix-git`, Debian 12, glibc 2.36) failed
with `libstdc++.so.6: version 'GLIBCXX_3.4.31' not found`. Node ran fine and
the addons could not load. Nothing in `ensure_system_dependencies` provides a
new enough `libstdc++`, so `install()` now checks and satisfies it up front
(`_ensure_cpp_runtime`, before `_ensure_node` and before the smoke test).

The requirement is **measured from the bundle, not taken from the error text**:

```bash
V=$(mktemp -d) && tar xzf /tmp/iknow-bundle.tgz -C "$V" \
  node_modules/tree-sitter/prebuilds/linux-x64/tree-sitter.node \
  node_modules/tree-sitter-bash/prebuilds/linux-x64/tree-sitter-bash.node
objdump -T "$V"/node_modules/tree-sitter/prebuilds/linux-x64/tree-sitter.node \
  | grep GLIBCXX_3.4.31
# 0000000000000000 DF *UND* (GLIBCXX_3.4.31)
#   _ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE15_M_replace_coldEPcmPKcmm
```

One symbol reaches that version, introduced in **GCC 12**. The other prebuild,
`tree-sitter-bash`, tops out at `GLIBCXX_3.4.21`; every other `linux-x64`
addon in the closure (`lightningcss`, `rollup`, `tailwindcss-oxide`, `lzma`)
needs only `GLIBC_2.14` and no `GLIBCXX` at all. So `GLIBCXX_3.4.31` is the
single binding requirement, and `REQUIRED_GLIBCXX` is it.

What `install()` now guarantees, on return:

- the image's `libstdc++` defines `GLIBCXX_3.4.31` or newer, **verified by a
  probe against the container**, not inferred from an install's exit code;
- if it already does, nothing is installed and no package manager is even
  looked up;
- if it does not, the C++ runtime is installed by the manager found in the
  image: `libstdc++6` on apt-get, `libstdc++` on apk/dnf/yum. Detection is by
  package manager, not by `/etc/os-release`, so a CentOS Stream or UBI base is
  still handled by the manager that is actually present.

What still happens on an image that cannot satisfy it: `install()` raises
`IKnowCppRuntimeTooOldError` naming the ceiling it found, the package it
tried, and the version required. Four cases reach that error, and each is a
real image state, not a hypothetical — the reader's next step differs between
them, so each gets its own message:

| image state                                         | what happens                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| no supported package manager                        | raised before any install; the message lists the four managers it looked for                                                     |
| the install **failed** (stale cache, dead registry) | raised reporting the install's own exit code and stderr, and explicitly _not_ claiming the distribution has nothing newer        |
| the install succeeded but the ceiling did not move  | raised with the _post_-install ceiling and the "distribution's own C++ runtime is the ceiling" verdict; this is Debian 12, below |

The install is run through the bare `environment.exec` rather than
`exec_as_root`, precisely so its outcome is read rather than thrown. A
successful install is still not taken as proof: "already the newest version" is
also an exit 0 that changed nothing, so the post-install probe remains the
authority in both directions. What the return code buys is the _distinction_
between "the repository has nothing newer" and "the repository was never
reached" — reporting the second as the first would send the reader to change
task image when the fix is a cache refresh. The apt row is therefore
`apt-get update && apt-get install …` with `DEBIAN_FRONTEND=noninteractive` on
the exec's `env`, matching harbor's own dependency installer: without the
refresh, an image with an empty package cache fails with "Unable to locate
package libstdc++6" even when the repository carries a new enough build, and
without the flag an unanswered debconf prompt hangs a container with no pty.

**Debian 12 cannot be fixed by a package install, and this is measured, not
assumed.** Its `libstdc++6` is `12.2.0-14+deb12u1`, whose ceiling is
`GLIBCXX_3.4.30` — one short. `apt-get install -y libstdc++6` reports "already
the newest version" and changes nothing; `bookworm-backports` carries no newer
`libstdc++6` (`apt-cache madison` lists the 12.2.0-14+deb12u1 build only). The
only source that clears the bar is trixie's `libstdc++6 14.2.0`, and
installing it pulls `libc-bin 2.41-12+deb13u4` — it upgrades the image's
**glibc** to satisfy one addon. That is refused deliberately: a benchmark
adapter that silently upgrades a task image's libc is changing the environment
underneath a task that measures git behaviour. So the trial is refused with the
ceiling named, and the remedy is a task image with a GCC 12+ runtime.

This also means the two error classes are genuinely distinct and must stay so:
`IKnowGlibcRequiredError` is an image whose libc family cannot host the
prebuilds at all (musl, foreign architecture) and which `_reject_musl` refuses
before any of this runs, while `IKnowCppRuntimeTooOldError` is a glibc image
with a merely old C++ runtime in front of it.

The probe emits **every** `GLIBCXX_` token the library carries and the
maximum is chosen in Python (`_glibcxx_ceiling`, from the same numeric
components `_glibcxx_at_least` compares). The shell deliberately does not sort:
`sort -V` is a GNU extension, at odds with the POSIX-only rationale the rest of
the probe is built on, and plain `sort` is worse than cosmetic — the
lexicographic maximum of a real libstdc++ is `GLIBCXX_3.4.9`, not
`GLIBCXX_3.4.35`, because "9" sorts after "3". A lexicographic max fails
_closed_ but wrongly: it refuses an image that does have the runtime, and issues
a pointless install first. The ordering therefore has exactly one
implementation, and it is the same code as the pass/fail decision.

#### Measured in real containers

The C++-runtime step was exercised against live containers on 2026-09-29, by
running the adapter's own `_ensure_cpp_runtime` over a `BaseEnvironment`
shaped like harbor's docker backend (`bash -c`, `set -o pipefail` prepended):

| container                                             | ceiling          | outcome                                                                                                                       |
| ----------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `alexgshaw/fix-git:20260403` (the failing task image) | `GLIBCXX_3.4.30` | `apt-get install libstdc++6` issued, ceiling re-probed unchanged, `IKnowCppRuntimeTooOldError` raised naming `GLIBCXX_3.4.30` |
| `ubuntu:24.04`                                        | `GLIBCXX_3.4.33` | accepted, no install issued, no package-manager lookup                                                                        |
| `ubuntu:24.04` with `libstdc++6` removed              | none found       | probe exited 0, install attempted, still refused                                                                              |
| `alpine:3.20`                                         | none found       | probe exited 0; musl libstdc++ carries no `GLIBCXX_3.4.x` at all                                                              |

Three defects in this step were found **only** by running it in a container,
and all three are now fixed and regression-tested:

- `grep -a` is a GNU extension busybox does not implement, so the probe
  silently extracted nothing on Alpine even with a current `libstdc++`
  installed. `strings` is not an alternative — it is absent from the Debian
  task images. The probe now splits the file with `tr -c '[:alnum:]_.'` and
  matches whole lines, which is POSIX and behaves the same on busybox and GNU.
  The version _ordering_ is done in Python, so the shell only has to produce a
  token.
- harbor prepends `set -o pipefail` to every command. `grep` exits 1 when it
  matches nothing, so on an image with no readable `libstdc++.so.6` the probe
  aborted `install()` with `NonZeroAgentExitCodeError` instead of reporting "no
  runtime found" and letting the install run — on precisely the image that most
  needs it. A `|| true` inside the loop fixes it. _Inside_ is load-bearing:
  hoisting it outside leaves every element of the pipeline still failing under
  `pipefail`, and an assertion of the form `"|| true" in probe` is satisfied by
  that wrong placement, so the tests assert the guard's _position_ and run the
  probe in a real shell.
- `sort -V` is a GNU extension, and the probe's stated rationale is POSIX-only.
  A comment claimed "the ordering is not done by `sort -V`" while `sort -u -V |
tail -1` was doing exactly that. The claim is now true because `sort` is gone
  entirely and Python computes the maximum.

The end-to-end link was confirmed on the real task image: with the bundle
unpacked and node v22.23.3 installed, the marker leg prints
`iknow-node-runnable` and the native leg fails with exactly the reported
`GLIBCXX_3.4.31' not found`; on `ubuntu:24.04`, which `_ensure_cpp_runtime`
accepts, the same bundle prints `iknow-native-ok` (exit 0). The requirement
the adapter now enforces is exactly the requirement the bundle has.

**Not measured:** the fix-git image is still unscorable, because Debian 12
genuinely has no new enough `libstdc++` to install. What changed is that the
trial now fails at `install()` with the ceiling and the required version named,
instead of failing inside a native-addon load. Reaching a score on that image
needs a task-image change (Debian 13 / Ubuntu 24.04 base), not an adapter
change.

A third probe closes the gap ADR-0130 §1 says must not exist — a stale bundle
that silently ignores `--eval-state`. `iknow ask` folds unknown positionals into
the prompt, so such a run would _answer the question_ and be scored as an
eval-state run while the fence actually stayed on. `_assert_eval_state_flag`
(`iknow_harbor/agent.py`) runs during `install()`: it reads
`node ./dist/cli.js --help`, and raises `IKnowEvalStateUnsupportedError` unless
`--eval-state` is advertised. Behind it, `_assert_run_state_named` checks the
label the run gave itself — the answer payload must carry
`runState="eval_state"` iff the trial asked for that posture, and a
disagreement errors the trial instead of scoring it.

Proved in containers (no task, no model call):

- `ubuntu:24.04` (glibc 2.39, x86_64): musl probe silent -> apt deps -> harbor's
  nvm snippet installs `v22.23.3` -> bundle unpack -> `node ./dist/cli.js
--version` = `0.1.0` and the addon probe prints `iknow-native-ok`, exit 0.
- `alpine:3.20`: the same musl probe echoes `musl`, i.e. the guard fires.

**The `ln -sf` leg was not part of that measurement, and an earlier version of
this file claimed it was.** The original smoke ran in a shell that could already
see `node`, so it could not have detected a missing symlink. What is now
guaranteed instead, by the code and by unit tests:

- the node binary is located by the nvm tree's own layout
  (`$NVM_DIR/versions/node/*/bin/node`) and never by `command -v node` in a
  fresh shell, which is what silently produced an empty `NODE_BIN` and skipped
  the symlink entirely (`|| true` swallowed it — the `|| true` is gone, so the
  listing can no longer fail quietly);
- among the candidates, the **highest major at or above `NODE_MAJOR_FLOOR`**
  wins. The listing is byte-sorted, so its last line is the _oldest_ single-digit
  major (v9 sorts after v22), not the newest; a tree whose every candidate is
  below the floor is an error rather than a silent downgrade;
- an empty nvm tree raises `IKnowNodeUnavailableError` instead of skipping;
- the new link is resolved with a version probe in a plain shell, so a dangling
  symlink — or a linked node below the floor — fails at `install()` rather than
  deep inside a task;
- `_ensure_node` no longer returns early on the nvm-sourcing probe alone: that
  probe sources `nvm.sh`, so a pre-existing nvm that satisfies it could still
  leave a fresh shell unable to see node.

Not yet re-measured in a real container — the `ubuntu:24.04` end of the run
through the _fixed_ symlink path.

## 2. Make the adapter importable by harbor

Harbor's launcher is a plain shebang script into its uv tool venv, so the host
`PYTHONPATH` reaches it. This is the mechanism that was verified:

```bash
export PYTHONPATH=$HOME/projects/iknow/scripts/harbor
```

`uv tool inject` (sometimes suggested for this) does not exist in the installed
uv: `error: unrecognized subcommand 'inject'`. An editable install into the tool
venv also works in principle but was not done here, so as not to mutate the
reviewed Harbor environment:

```bash
uv pip install --python "$HOME/.local/share/uv/tools/harbor/bin/python" -e \
  "$HOME/projects/iknow/scripts/harbor"          # NOT run
```

Verify the class resolves and see its option table:

```bash
harbor agent schema iknow_harbor.agent:IKnowAgent
harbor agent schema iknow_harbor:IKnowAgent      # re-export also resolves
```

## 3. One pilot task

```bash
cd ~/projects/iknow
export PYTHONPATH=$PWD/scripts/harbor

harbor run -d terminal-bench/terminal-bench-2-1 \
  -i terminal-bench/adaptive-rejection-sampler \
  --agent iknow_harbor.agent:IKnowAgent \
  -m minimax-cn/MiniMax-M3.1-Flash-Preview \
  --ak bundle_path=/tmp/iknow-bundle.tgz \
  --ae 'MINIMAX_API_KEY=${MINIMAX_API_KEY}' \
  --ak permission_mode=full_auto \
  --ak max_turns=40 \
  -l 1 --dry-run -y
```

`--dry-run` validated config + preflight + task metadata and printed
`Dry run OK — 1 trial(s); nothing was run.` (exit 0). Task names in this dataset
carry the `terminal-bench/` prefix; `-i curlie` matches nothing,
`-i terminal-bench/adaptive-rejection-sampler` matches. Use `harbor task -h` to
browse ids.

The key arrives from the host environment only. `--ae 'MINIMAX_API_KEY=${MINIMAX_API_KEY}'`
is templatized: `harbor run --print-config` shows the literal string
`${MINIMAX_API_KEY}` and never the value (verified by checking the resolved
config against the live value). The uploaded `settings.json` contains only
`"apiKeyEnv": "MINIMAX_API_KEY"`, never a key value.

Drop `--dry-run` to actually score the task:

```bash
harbor run -d terminal-bench/terminal-bench-2-1 \
  -i terminal-bench/adaptive-rejection-sampler \
  --agent iknow_harbor.agent:IKnowAgent \
  -m minimax-cn/MiniMax-M3.1-Flash-Preview \
  --ak bundle_path=/tmp/iknow-bundle.tgz \
  --ae 'MINIMAX_API_KEY=${MINIMAX_API_KEY}' \
  --ak permission_mode=full_auto --ak max_turns=40 -y      # NOT RUN: costs money
```

## 4. The dataset

```bash
harbor run -d terminal-bench/terminal-bench-2-1 \
  --agent iknow_harbor.agent:IKnowAgent \
  -m minimax-cn/MiniMax-M3.1-Flash-Preview \
  --ak bundle_path=/tmp/iknow-bundle.tgz \
  --ae 'MINIMAX_API_KEY=${MINIMAX_API_KEY}' \
  --ak permission_mode=full_auto --ak max_turns=40 \
  -n 4 -y                                                  # NOT RUN: 89 scored trials
```

89 tasks are available in the dataset (reported by harbor's own filter error).
`-n` sets parallel trials; `--ak eval_state=true` additionally marks the run as
ADR-0130 eval state, and the resulting number must be reported as eval state,
never mixed with sandboxed numbers.

## Options

`harbor agent schema iknow_harbor.agent:IKnowAgent` prints this table from the
code. Env fallbacks work for all four (`--ae IKNOW_BUNDLE_TGZ=...`).

| kwarg             | env                     | default     | meaning                                                                                                                                                                          |
| ----------------- | ----------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle_path`     | `IKNOW_BUNDLE_TGZ`      | none        | host tarball uploaded into the container                                                                                                                                         |
| `permission_mode` | `IKNOW_PERMISSION_MODE` | `full_auto` | always injected explicitly; `default` would deny every mutation and still exit 0                                                                                                 |
| `eval_state`      | `IKNOW_EVAL_STATE`      | `false`     | ADR-0130 posture. The env var is only the _adapter option's_ fallback for `--ae`; it is never forwarded into the container — the posture travels as the argv flag `--eval-state` |
| `max_turns`       | —                       | none        | `--max-turns` for `iknow ask`                                                                                                                                                    |

No option changed with the node fix, but `install()`'s guarantee did: on return,
a plain non-login shell in the task container can resolve `node` — either it
was already there, or it was linked onto the system PATH and proven with a
version probe in a shell that sources no nvm. So `get_version_command()` and
`run()`'s `node ./dist/cli.js ask` are not left to discover a node that exists
only inside nvm's per-shell PATH.

The C++-runtime step added a second guarantee: on return, either the image's
`libstdc++` provides `GLIBCXX_3.4.31` (verified by probing the container, not
inferred from an install's exit code) or `install()` has already raised
`IKnowCppRuntimeTooOldError` naming the ceiling and the version required. No
option was added for it — it is not configurable, because the required version
is a property of the bundle, not of the trial.

## What is proven and what is not

Proven:

- `harbor run ... --dry-run` with `--agent iknow_harbor.agent:IKnowAgent` exits 0.
- Preflight fails locally with actionable messages for a missing bundle and a
  missing `MINIMAX_API_KEY`; `--ak permission_mode=yolo` is rejected by the
  option schema before any container starts.
- Unit tests: 109 passed (measured 2026-09-29, `pytest -q`).
- `REQUIRED_GLIBCXX` is measured from the shipped prebuilds, not from a
  failure message: `GLIBCXX_3.4.31` on `tree-sitter`, `GLIBCXX_3.4.21` on
  `tree-sitter-bash`, nothing above `GLIBC_2.14` for every other addon.
- `_ensure_cpp_runtime` was run against live containers (table above): it
  accepts `ubuntu:24.04` without installing, and on the real
  `alexgshaw/fix-git:20260403` it issues `apt-get install libstdc++6`, re-probes,
  and refuses with the ceiling named.
- Debian 12's `libstdc++6` ceiling is `GLIBCXX_3.4.30` and no newer one is
  installable on it (measured: `apt-cache madison`, backports empty, trixie
  would pull `libc-bin 2.41`). That image is refused, not silently upgraded.
- Bundle + node + native addons load inside `ubuntu:24.04`; the musl guard fires
  on `alpine:3.20`. The image is glibc 2.39 — the `IKnowGlibcRequiredError` a
  real trial reported there was a misattribution, see below.
- `render_iknow_settings()` output is accepted by iknow: with a valid route and
  no key, the unpacked bundle exits 1 with
  `{"error":"llm_provider_api_key_missing","code":"provider_api_key_missing",...}`,
  the exact string the adapter maps to `AgentAuthenticationError`.

Not proven:

- **The end-to-end trial path is still unproven — it has never reached
  `run()`.** Two scored trials _were_ attempted
  (`harbor run -d terminal-bench/terminal-bench-2-1 -i
terminal-bench/adaptive-rejection-sampler ...` and then
  `-i terminal-bench/fix-git`). The first reached `install()`
  and failed: `iknow bundle smoke test failed (exit 127) ... bash: line 1:
node: command not found`. The cause was the adapter's own symlink step
  resolving `NODE_BIN` from an ambient PATH that a fresh shell does not have,
  so node stayed inside `$NVM_DIR` and nothing on the system PATH could run it.
  That is now fixed and unit-tested. The second got past that and failed
  _correctly_ attributed — node ran, the marker printed, and the native leg
  died on `GLIBCXX_3.4.31' not found` → `IKnowGlibcRequiredError` — which is
  the case the C++-runtime step now handles by refusing the image with its
  ceiling named. Neither trial reached `run()`, so nothing in this document is
  evidence about terminal-bench scores: `setup() -> install() -> run() ->
verifier` has still not completed once.
- The fixed `install()` path has not been re-measured in a real container; the
  `ubuntu:24.04` claim above predates it. (The C++-runtime step _has_ been
  measured in real containers — see the table above — but the full
  `setup() -> install()` sequence driven by harbor's own trial machinery has
  not.)
- `environment.upload_file()` semantics for a 41M tarball (docker cp) and
  `_upload_config_text()` path permissions inside a real task container.
- Harbor's `exec_as_agent` user model on task images whose `default_user` is not
  root: `$HOME`, `/logs/agent` writability, and nvm's 200M footprint against the
  2048MB memory / 10240MB storage limits of these tasks.
- The real `iknow ask --json` success payload from inside the container (needs
  one live, paid trial).
- `provider_model_not_registered` at runtime: with `llm.providers` present,
  iknow resolves the provider by prefix and only validates `models[].id`
  opportunistically (`src/config/env.ts:536-544`), so this message surfaced in
  neither host probe. The unit test pins the mapping, not the occurrence.
- Retry/timeout interaction: the tasks' 900s agent timeout versus iknow's own
  turn budget is unmeasured.
- The `runState` guard only sees answer payloads. A trial that ends in an error
  envelope — a capped turn budget included — records `eval_state` as _requested_
  in `context.metadata`, because `formatRunJson` is the only emitter of the label
  and it does not run on those paths. Whether the two agree on such a run is
  unmeasured until a real one happens.

`eval_state` status: the TypeScript entry exists in the working tree
(`src/harness/sandbox/eval-state.ts`; `--eval-state` accepted on `ask` /
`oneshot` only, `IKNOW_EVAL_STATE` read nowhere in `src/`), and the adapter now
matches it: the posture travels as the argv flag, `_assert_eval_state_flag`
refuses a bundle that does not advertise it, and `_assert_run_state_named`
refuses an answer whose own `runState` disagrees with what the trial asked for.
What still blocks a scored eval-state trial is the credential, not the code: the
entry builds green (`tsc -p tsconfig.json` exit 0) and `./scripts/harbor/build-bundle.sh`
produces the uploadable tarball, measured 2026-09-29 — both install-time probes
green (`0.1.0`, `iknow-native-ok`), 50M. ADR-0130 §3 requires that the first real
run use a **scoped, revocable key with a spend cap** — advisory, not a gate
(the operator ruled on 2026-09-29 that the local key, which already carries the
full test suite's traffic, carries nothing a trial does not; see ADR-0130 §3
amendment). The entry is otherwise ready to run. (The `enterEvalStateForAsk` /
unused-import `tsc` errors that blocked the bundle earlier are gone: the ask-entry
function and the `evalStateRejection` dispatch consumer now exist in `src/cli.ts`.)

## Tests

```bash
cd ~/projects/iknow/scripts/harbor
PYTHONPATH="$PWD:$HOME/.local/share/uv/tools/harbor/lib/python3.13/site-packages" \
  uv run --python 3.13 --no-project --with pytest -- pytest -q
```

The adapter is not installed into Harbor's own venv, so the tests import harbor
from its site-packages via `PYTHONPATH`. 109 tests as of 2026-09-29.
(Plain `python3 -m pytest` does not work here: the system python3.14 has no
pytest, and the adapter is not installed into Harbor's venv — use the command
above.)

- `tests/test_parse_iknow_ask_output.py` — pure parsing: pretty and compact JSON,
  braces inside strings, JSON after stderr noise, last-answer-wins, missing and
  partially-filled `lastUsage`, non-numeric and null usage fields, empty/whitespace/
  truncated/array input, `max_turns_exceeded` envelope (incl. the Chinese message),
  answer-beats-envelope precedence, `runState` absent vs. `eval_state`.
- `tests/test_iknow_adapter.py` — harbor error-taxonomy mapping for observed
  strings, `render_iknow_settings()` shape and route rejections, and the surface
  harbor's CLI touches: option validation, `preflight`, the assembled `ask`
  command, `--max-turns`. Plus the eval-state carrier: the flag reaches argv and
  the env never carries it, the `--help` capability probe (refusal, pass, skip),
  and the `runState` agreement gate in both directions. Plus the node PATH and
  smoke-test attribution: the symlink resolves the binary from the nvm tree with
  an empty ambient PATH, a multi-version tree links the highest eligible major
  rather than the byte-last one, a tree of only legacy nodes links nothing, the
  link is proven in a plain shell, an empty tree is an error rather than a
  skipped step, the nvm _install_ branch is covered end to end, an nvm-sourced
  probe alone no longer skips the link, `node: command not found` is
  `IKnowNodeUnavailableError` (not `IKnowGlibcRequiredError`), a missing shared
  library _after_ node ran is `IKnowGlibcRequiredError`, and a native addon load
  failure is still `IKnowGlibcRequiredError`. Plus the C++ runtime: a new-enough
  ceiling issues no install and does not even look up a package manager, a
  too-old one installs the per-distro package name (`libstdc++6` vs
  `libstdc++`) as root and re-probes afterwards, the apt row carries both
  `apt-get update` and `DEBIAN_FRONTEND=noninteractive` (asserted through the
  issued command's exec `env` as well as through the table), an image with no
  package manager is refused listing the four it looked for, an install that
  leaves the ceiling unchanged raises `IKnowCppRuntimeTooOldError` naming the
  ceiling, a **failing** install raises instead reporting its own exit code and
  stderr and explicitly does _not_ claim the distribution is the ceiling, a
  missing `libstdc++` is treated as too old rather than as new enough, and the
  probe is run for real rather than string-matched: a binary `libstdc++.so.6`
  fixture is written to a temp dir and probed under `bash -c` with
  `set -o pipefail`, asserting that every token is emitted (so any
  `sort … | tail -1` fails), that the numeric maximum is what Python derives,
  and that the `|| true` guard is _inside_ the loop (its position, and the
  exit code a real shell gives on an image with no readable library). The
  probe also avoids the GNU-only `grep -a` / `strings`.

  The step _ordering_ is asserted by driving `install()` itself over a stub
  that answers every probe it issues, so removing the call or moving it after
  `_ensure_node` or the smoke test fails — including on the failing-install
  path, where nothing is uploaded, nothing is unpacked, and node is never
  probed. The manager table is one row per manager (package, command, env) with
  a guarded lookup, so a manager missing from it raises a readable error rather
  than a bare `KeyError`. The version comparison itself is covered by a table
  including the lexicographic trap (`GLIBCXX_3.4.9` sorts after `3.4.31` as
  text and is still eleven releases short) and the non-ASCII-digit trap
  (`isdigit()` is true for superscripts, where `int()` raises).

  Each of these was checked by mutating the adapter and watching the suite go
  red: deleting / reordering the `install()` call, hoisting `|| true` out of the
  loop, restoring `sort -u -V | tail -1` or plain `sort -u | tail -1`, dropping
  `apt-get update` or the `DEBIAN_FRONTEND` env, forcing the
  distribution-ceiling message on a failed install, taking the ceiling maximum
  by byte order, dropping the `isascii()` guard, and removing the guarded
  manager lookup each fail at least one named test.
