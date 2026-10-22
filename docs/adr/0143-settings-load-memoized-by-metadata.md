# 0143. Settings loading is memoized by source-file metadata, inside the loader

Date: 2026-10-15
Renumbered: 2026-10-17, from 0141 (number collision with `0141-yolo-and-no-sandbox-are-presets-on-one-session-overlay.md`; content unchanged)
Status: accepted
Deciders: operator
Related: ADR-0015 (the settings two-file model this memoizes), ADR-0084 (the project allowlist the merge enforces), ADR-0019 D1.1 / ADR-0088 (the one-file workspace scope the merge must keep working under), ADR-0093 / ADR-0094 (the key material the memoized object carries)

Spec: none — this is a performance decision inside `src/config/settings.ts`.

## Context

`loadIknowSettings` is no longer a startup-only call. The output-masking hot path — `currentSecretValues()` in `src/harness/sandbox/env-isolation.ts`, re-fetched by `currentOutputMask()` before every trace write (`src/harness/trace/jsonl.ts`) and every stream-draft refresh — calls it on each invocation. A first change (perf/b-settings-read, commit `bc55a672`) collapsed the duplicate reads _inside_ `currentSecretValues` and made `loadIknowSettings` itself read each source file once per call: measured, 2 `readFileSync` calls per `currentSecretValues()` where the pre-refactor code did 4. Two per call is still two file reads and a full two-layer merge (parse, allowlist filter, field-by-field validation, deep freeze) on every trace write.

The shape of the load makes memoization attractive: the result is a pure function of the two settings files' contents, the result is already deep-frozen (so a shared instance cannot be mutated through the return value), and all in-repo call sites read it — a repo-wide audit found zero mutation sites (`Object.assign(settings…)` / `structuredClone` / `delete settings.x` / `settings.x =`), so handing the _same_ frozen instance to every caller is observationally safe and gets stronger over time.

Memoizing a _config_ read is dangerous in exactly one way: the answer must not go stale when the operator edits the file. The invariant that makes this safe-or-not is the masking one — after an operator edits `settings.llm.apiKey`, the very next piece of output must already be masked with the new key. A cache that serves the old key for even one write leaks a live credential into a trace or model-visible stream. That invariant, not the performance win, is what shapes the design below.

## Decision

**`loadIknowSettings` memoizes its result inside its own module, keyed by the metadata of its two source files, with a 2-second freshness window that forces a re-read for recently-written files.** No caller changes anywhere; the function signature, return contract, and failure semantics are unchanged.

### 1. The cache key is file metadata, not time

For each source file (user `~/.iknow/settings.json`, project `<cwd>/.iknow/settings.json`) the key captures existence plus, for a present file, the `(dev, ino, size, mtimeNs, ctimeNs)` of the file the path resolves to, read with `statSync(path, { bigint: true })` — one call, which already follows symlinks, so the tuple _is_ the target's identity. A rewrite changes the tuple and invalidates; a symlink retarget to a different inode changes `dev`/`ino` and invalidates; `mtimeNs` in nanoseconds distinguishes same-millisecond rewrites (ms precision does not); `ctimeNs` catches write paths that preserve mtime (any inode metadata write bumps ctime). Nanosecond comparisons run against the wall clock (`Date.now() * 1_000_000n`), not hrtime — mtime is a wall-clock quantity and the two clocks are not comparable.

The paths themselves (`home`, `cwd`) are part of the key, so two concurrent workspaces never share an entry.

### 2. Absence — and unstattable — is a first-class cacheable state

`statSync` throws on a missing file; it does not return a zeroed stat. A missing source file is therefore cached as a stable `"absent"` fragment — the same precedent `fileChangeSignal` (`src/config/settings.ts`, `fileChangeSignal`) already sets — and is invalidated the normal way: creating the file changes the fragment from `"absent"` to a metadata tuple. Without a cacheable absent state, every no-project-file call would be an eternal miss, and no-project-file is the common case.

The same `"absent"` fragment also covers every **unstattable** path (EACCES, ELOOP, ENAMETOOLONG, …). The pre-memo loader's `readSettingsFile` guards each read with `existsSync`, which returns `false` — and so degrades the layer to `{}` — for _every_ stat error, not only ENOENT. The probe must classify those paths identically, or a path that today degrades quietly to `{}` would start throwing out of the memo (a startup crash in a security-adjacent config path). Since `throwIfNoEntry: false` suppresses only ENOENT, the probe wraps the stat in a catch and maps **every** stat error to the `"absent"` fragment. The one observable nuance: `throwIfNoEntry: false` turns ENOTDIR into `undefined` where `existsSync`'s internal stat throws and reports `false` — both classifications end at "absent" / `{}`, so the loader's observable result is unchanged. The unstattable state is itself a cacheable state: it is cached under the `"absent"` fragment exactly like ordinary absence, and when the path becomes stattable again the fragment changes (`"absent"` → a metadata tuple), so the newly readable file is picked up like any other create-after-absent.

### 3. The 2-second window is the security invariant, not a heuristic

If either source file's mtime is within 2 seconds of now, the cache is bypassed and the load re-reads — even when every other key component matches. This is what bounds the worst case of the masking invariant: an edit to a settings key becomes visible on the next read at latest 2 seconds after the edit's mtime, and typically immediately (the edit's mtime _is_ fresh, so the first post-edit read is already a miss). The window is deliberately conservative against filesystems and backup/sync tools that rewrite files with preserved or skewed timestamps: a preserved mtime is still caught by `ctimeNs`/`size`/`ino` in the key, and a clock-skewed _old_ mtime on a truly fresh file is the residual risk the window accepts, bounded at 2 seconds and no worse than the pre-memo world's "read at call time" on the same skew.

### 4. Failures never serve or store a stale cache

The cache is only consulted after both metadata probes have classified their files, and only stored after a full successful load. A probe failure is itself a key fragment: the `"absent"` fragment an unstattable path maps to cannot match a previously cached present-file key, so a path that stops being stattable always forces the real read — a failure never serves the previous value. If the subsequent read throws, the throw happens inside `computeIknowSettings` before `rememberSettings` runs, so nothing is stored; if it instead succeeds by degrading to `{}` (the `existsSync` guard), that result is cached under the `"absent"` fragment like any other state (§2). Present-but-unreadable paths still throw exactly as the un-memoized loader does (today a settings path that is a directory makes `readSettingsFile` throw `EISDIR` — pinned by `tests/config/subagent-settings.test.ts` "propagates non-JSON user settings file read errors", and re-pinned in `tests/config/settings-memo.test.ts`); a failed load never leaves a poisoned entry behind.

### 5. An injected `onWarn` bypasses the cache

`LoadSettingsOpts.onWarn` is a side-effect channel, and the pinned contract (`tests/config/settings.test.ts` "默认通道按文件去重…注入 onWarn 仍逐条收到") is that an injected channel receives every warning on _every_ call. A cache hit returns before the merge runs, so it could not re-emit. A call supplying `onWarn` therefore never reads or writes the cache. The default channel is safe to cache through: `warnOncePerFile`'s dedup key already includes the per-file change signal, so re-warning an unchanged file is already suppressed, and the masking hot path uses the default channel — the bypass costs nothing where the performance matters.

### 6. The returned object is the same deep-frozen instance

The existing `deepFreeze` at the end of the merge is the only freeze path; a hit returns the identical instance. This rests on the audit above: every call site is read-only. A future mutating call site is a compile-visible `TypeError` in strict mode (frozen object), not a silent shared-state bug.

## Rejected alternatives

- **Time-based TTL (re-read every N seconds unconditionally).** The staleness is unconditional: within the window the load re-reads even if the file is unchanged, so the hot path never actually escapes file reads during a session's first seconds, and after the window a genuinely-changed file is _still_ served stale until the TTL fires. It converts a correctness question ("did the file change?") into a timer guess. Metadata keys answer the correctness question directly.
- **Content hashing (read the files, hash, compare to the cached hash).** Reads the files on every call — the exact cost memoization exists to remove. It would only deduplicate the merge, not the I/O.
- **Reusing `settings-watch`.** The settings watcher exists for TUI re-arming of the warn channel, not for cache coherence; coupling the loader to a watcher would make correctness depend on an event source that can drop events, and the loader must stay correct in processes that never started a watcher.
- **Caching in the callers (e.g. `env-isolation`).** N call sites would each own a copy of the invalidation problem, and the masking invariant would depend on _every_ caller's discipline. The task brief forbids caller-side caching for this reason; the memo lives inside the loader, where there is exactly one copy of the rule.

## Consequences

- **Positive:** the masking hot path performs zero settings-file reads in steady state (measured: `readsPerCall` 2 → 0, `scripts/perf/settings-read.ts`); the two-layer merge and deep freeze run once instead of per write; the frozen-instance return makes accidental mutation of the shared object a loud `TypeError`.
- **Negative / trade-offs:** the loader now carries module-level mutable state (one `{key, value}` slot — single-tenant, last-writer-wins across workspaces, and the key includes the paths so a workspace switch is always a miss); an edit whose mtime is skewed older than 2 seconds by the filesystem can serve stale output for at most 2 seconds; the metadata probes cost up to two `stat` syscalls per call even on a miss. An unstattable path is cached under the `"absent"` fragment like any other state: the degraded `{}` result is served from the cache on identical subsequent keys, and the path becoming stattable changes the fragment (`"absent"` → a metadata tuple) and is picked up immediately. A load that throws is never stored — `rememberSettings` runs only after a successful merge — so a failing read keeps throwing on every call until its cause changes.
- The memo is deliberately _not_ persisted or shared across processes; each process re-reads on first load.
- The existing per-layer validation, allowlist filtering, and warn behavior are unchanged — a miss path is byte-identical to the pre-memo loader.
