# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This changelog
is a curated snapshot; the complete development history lives in the git log.

## 0.1.0 (unreleased)

### Breaking

- **Model output budgets moved to per-route `models[].maxTokens`; `IKNOW_LLM_MAX_OUTPUT_TOKENS` is retired (spec `model-output-truncation`, ADR-0126, 2026-09-27)**:
  the global `maxOutputTokens` ladder (2048 → 8192 → 16384, logged below) is replaced
  by a per-model-route budget. Any non-empty `IKNOW_LLM_MAX_OUTPUT_TOKENS` — process
  environment or user / project settings file — now fails fast with a typed
  `LlmBudgetConfigError` (`legacy_max_output_tokens_env`) rendered on all three startup
  surfaces (CLI, chat, TUI) rather than being silently read. `LlmEnv.maxOutputTokens`
  is deprecated and never consulted as a budget; it is kept only so the ~70 fixtures
  that pin it keep compiling, and its removal plus fixture migration is a separate
  ticket. Truncation is now a recorded terminal outcome rather than an error fold: the
  output-limit stop performs no retry and requests no closing summary, because the
  settled partial turn is itself the record, and a `tool_use` the limit left
  unexecuted is closed out with a synthetic `is_error` tool result stating the call
  never ran.
- **Memory entry frontmatter is now written as real YAML (spec `frontmatter-shared-parser`, ADR-0123 amendment, 2026-09-23)**:
  `serializeMemoryEntry` emits `yaml.stringify` instead of unquoted `key: value`
  lines, because the shared parser made the read side strict and the old writer
  produced bytes that reader rejects — an unquoted plain scalar may not carry
  `": "`, so a title like `Rule: …` cost the whole frontmatter block, reading
  back an empty `title` and `id`. On-disk divergence is two shapes only: a blank
  value becomes `key: ""` and an ambiguous scalar gains quotes. Key order
  (`KNOWN_FRONT_KEYS` first, extras sorted), the comma-flat `supersedes` list,
  `body` staying outside the block and no line folding are all pinned. Migration
  is lazy — an existing file is rewritten on its next save; measured over 19 real
  files, 17 need no change and 2 grow 2 bytes (the two blank-value entries), with
  `computeSignature` stable in all 19. A memory file whose block cannot be parsed
  at all now throws on read, so the store quarantines it and GC leaves the
  original bytes untouched instead of soft-disabling a defaulted copy of them.
- **Skill frontmatter degradation is block-atomic (ADR-0123)**: a `SKILL.md`
  whose block is not valid YAML now loses every field (plus one warn, name
  falling back to the directory basename, the skill still indexed) where the
  per-line parser previously kept the parseable lines. Authors must quote a
  `description` containing `": "` — e.g. `description: Emits "GATE: BLOCKED"`.

- **`settings.hooks` switched to the Claude-compatible command shape (2026-09-20)**:
  user-level `~/.iknow/settings.json` `hooks` now accepts only `PreToolUse` /
  `PostToolUse` entries (`matcher` + `type: "command"`), the same form as plugin
  `hooks.json`; a Pre hook exiting 2 blocks the tool call. The legacy deny-only
  `{ enabled, rules }` shape (including `PreWrite` / `PreCommit`) was removed and
  no longer takes effect. `hooks` left the project-settings allowlist — a project
  file declaring it warns and is discarded. Guide: `docs/guides/user-hooks.md`;
  ADR-0055 / ADR-0084 amendments.

- **Worktree gate: unbound bash predictive interception replaced by a physical read-only bind (ADR-0109, 2026-09-19)**:
  with the gate ON and the session not bound to a task tree, bash commands are no
  longer intercepted based on a guess of whether they might write the workspace.
  Instead the fence adds `--ro-bind` for the main checkout (placed after the
  writable bind, last-mount-wins; the session's scratch pad is re-bound writable
  afterwards, so scratch writes still work) and unbound bash always executes.
  Real writes to the main repo — including `.git`, with dedicated guidance when
  git-metadata paths are hit — come back as a typed EROFS violation that offers
  `create-worktree` and a re-issue guide; detached background commands, whose
  stderr never reaches a receipt, get a read-only preflight notice on the spawn
  receipt (unbound state only; bound / gate-OFF assembly is byte-identical).
  `write_file` / `edit_file` and root flip (enter/exit) are unchanged, and the
  previous "fail-closed on unknown bash commands" clause (the bash adjudication
  core of ADR-0037) is superseded in place. Trace evidence: the previously
  observed mis-trigger surface across 23 sessions (cd / curl / gh / sleep and
  friends) dropped to zero. Spec: `specs/worktree-unbound-ro-bind.md`.

- **Project settings allowlist and permission DSL relocated into `settings.permissions` (ADR-0084, 2026-09-12)**:
  the project-level `<cwd>/.iknow/settings.json` now adopts only four top-level
  sections — `hooks`, `verify`, `secrets`, `permissions`; every other section
  (`isolation`, `llm`, `subagent`, `web`, `lsp`, `memory`, `loop`, `graph`) is
  dropped, does not override user-level values, and warns per key at startup.
  `llm`-class keys live only in `~/.iknow/settings.json`. The permission machinery
  (schema version + rule DSL with allow/deny/ask, predicate semantics unchanged)
  moved from `.iknow/permissions.toml` into the project `settings.permissions`;
  the toml file is no longer read. Both present → a typed fail-loud
  `ProjectSettingsError` at assembly; toml alone is tolerated (retired file is
  inert). The user layer does not accept `permissions` (warn-and-ignore per key).
  Settings write-back now targets the right layer: user-level keys always write
  `~/.iknow/settings.json`; the old "write to the project file if one exists"
  two-tier rule is retired. See also `docs/guides/project-permissions.md`.

- **Project memory relocated into the home project tree (ADR-0099, 2026-09-18)**:
  the project memory store moved from `<workspaceRoot>/.iknow/memory/<slug>/` to
  `<dataDir or ~/.iknow>/projects/<slug>/memory/`, the same tree as sessions and
  tasks. `--workspace-root` no longer isolates project memory; a separate pool
  uses `--data-dir`. Existing workspace-local stores are not migrated
  automatically.

- **Session folder consolidation (2026-09-09)**: session storage is unified into a
  two-level tree `~/.iknow/projects/<slug>/<conversationId>/`. The leaf is the
  session folder holding `<id>.jsonl` (history of record), `todos.md`,
  `trace.jsonl` (trace anchor; the repo-root `./trace/` directory is no longer
  written), `blobs/` (content-addressed blob store; whole-message replacement was
  retired and role projections such as `last_assistant_preview` were restored in
  blob mode), `subagents/agent-<taskId>.jsonl` (per-agent subagent traces; the
  random-UUID aggregate file was retired), and `stderr/` — all anchored at the
  leaf. One `(project identity root, conversationId)` derives one stable path;
  starting the same conversation from a different cwd or worktree no longer drifts
  to a different store. The three read-side trace tools (`list_sessions`,
  `query_trace`, `get_record`, exposed both as ACI tools and over stdio MCP) walk
  the two-level tree, and `query_trace` message previews dereference blobs into
  full text in blob mode. **Existing data in the old layout no longer resolves;
  there is no automatic migration**: sessions under the old `~/.iknow/sessions/`
  anchor, repo-root `trace/`, and root-level todos cannot be resumed and no longer
  appear in the TUI session list; legacy trace anchors were archived under
  `~/.iknow/archive/trace-legacy/` (restoring them requires moving files back and
  reading them with the old code).

- **Global user profile no longer follows the workspace root (2026-08-21)**:
  `user.md`, `BOOTSTRAP.md`, and the identity `state.json` are seeded into and
  read only from `~/.iknow/`. `--workspace-root` and a project `.iknow/` no
  longer seed empty templates, and the assembly layer ignores the workspace root
  as a persona root. ADR-0019 D1.1–D1.3 / D1.5 (memory / settings fallback / serve
  data) are unchanged; D1.4 (per-root persona) is superseded by ADR-0025. Files
  already mis-seeded into a project directory are not auto-deleted.

- **`iknow serve` explicit workspace bind (ADR-0023, 2026-08-19)**: `iknow serve`
  no longer falls back to `process.cwd()` as workspace root — a long-running
  server's cwd is not necessarily the user's project root, so the serve hub stays
  unbound by default. The WebUI picker (chip + `/workspace` slash command) is the
  canonical bind surface; before binding,
  `POST /api/v1/sessions/:id/messages` returns 400 `validation` on field
  `workspaceRoot`. After binding, `workspaceRoot` is recorded in every session
  file and the engine converges `cwd === workspaceRoot === sandboxRoot` to one
  absolute path. The trust roster lives in `~/.iknow/workspaces.json`; a new
  absolute path requires `confirmTrust` on PUT (optimistic revision CAS). CLI
  `--workspace-root <abs>` and `IKNOW_WORKSPACE_ROOT` still support an explicit
  pre-bind (unchanged for `chat` / `tui` / `ask`).

- **`iknow trace` default behavior inverted (ADR-0020, 2026-08-17)**: the command
  no longer starts a standalone server (former default port 24881) by default. It
  now probes `http://<host>:<port>/api/v1/health` (default `127.0.0.1:8787`); on
  success it prints the mounted `http://host:port/trace` URL and opens a browser
  (`--no-open` suppresses), on failure it reports that no `iknow serve` was
  detected and exits 1. Scripts depending on the old standalone behavior switch to
  `iknow trace --separate` (escape hatch keeping the standalone process on port
  24881 for one version). The `detectLegacyTrace` migration check remains in
  front of both modes.

- **Breaking (internal, pre-release)** — recorded for API audit traceability; the
  package is private and unreleased, so there are no external consumers:
  - `iknow serve` no longer hosts the `/api/v1/traces` read API; the inspection
    panel moved to a separate `iknow trace` process (default port 24881;
    `iknow trace --trace-out <path>` reads the same JSONL written by
    `serve --trace-out`). Write-side `--trace-out` on `serve` / `chat` / `ask` is
    unchanged.
  - `getApiKey` / `assertOfflineCompatible` (re-exported from the package entry)
    changed to a single options-object parameter; repo-wide refactor of all
    two-plus positional-argument functions to options objects (41 files, zero
    behavior change; frozen contracts — step / run / LoopAdapter /
    Executor.executeAll / Registry / TurnTrace and the Error constructors —
    untouched).
  - Archived the `kb_retrieve` / `kb_verify_citation` / `kb_compile` /
    `kb_governance` four-tool suite and the `src/tools/registry.ts` assembly
    facade. The CLI product path stopped consuming them after the harness switch;
    package exports and related shared types were trimmed accordingly, and the
    runtime vector-index/embedding path was removed. Orphan surfaces
    (`--governance-timeout`, `simulate_governance_timeout`, `--embeddings`) were
    left pending later cleanup. Archive, not deletion.
  - Removed the package entry's re-exports of the old `src/agent-loop/` and
    `src/eval/` layers (13 loop symbols + 5 eval symbols).
  - Session API paths switched to the harness foundation (`src/session-api/` has
    zero imports from the old loop; `SessionHub` calls `run()` directly with
    `priorMessages` continuation): `TurnDto.answer` changed from the G2 envelope
    (`IknowAnswer`) to `TurnAnswerDto {finalText, stopReason, turnCount}`;
    `SessionSummary` dropped `caller_role` and the wire no longer accepts or
    returns a caller role; `POST /api/v1/sessions/:id/commands` was deleted (404);
    `GET /api/v1/sessions` was added; `IknowAnswer` / `ToolCallLog` were removed
    from shared schema types; `src/interaction/` and `src/agent-loop/` were
    archived.

### Added

- **Verify reads only the current turn, and its evidence checker reads what it claims
  to read (spec `verify-trust-boundary-and-goal-decoupling`, ADR-0137, 2026-10-05)**:
  the verify gate and the evidence checker are both scoped to the current turn, so a
  cross-turn conversation can no longer produce a verify record out of evidence that
  belongs to an earlier turn.
  - A green summary has to be its own line. Each framework's `green` rule tolerates
    the decorator bytes runners actually emit (` ✓ Tests  3 passed (3)`,
    `Tests:       14 passed, 14 total`) but rejects a summary phrase echoed or
    printed into someone else's line, so `npx vitest run; echo "Tests  42 passed"`
    no longer reads as passing evidence while `npx vitest run && echo done` still
    does — the check keys on the emitted text, never on the keyword, and reuses the
    per-framework rules as the one definition of "summary-shaped".
  - Staleness is judged per `tool_use` block rather than per message, so an edit that
    is a sibling of the green run inside the same assistant message — or a block
    inside the claim message itself — is now visible, and that is exactly the code
    the green run could not have described. Ordering uses the session's own block
    order, never mtime, diff, or git.
  - The rerun probe reader reads the production `path` key, so a transcript that
    wrote a project flag file can actually derive a rerun command instead of
    silently probing nothing.
  - Verify envelopes name the actor that really produced the record: a contradiction
    names the checker that found it while a genuine judge failure still names the
    judge, and the not-verified envelope reports the verdict its own record carries
    rather than asserting a completion claim that nothing in the loop tests.
  - Goal activation is decided by one predicate in the goal layer instead of four
    call-site copies, with `/continue`'s `isPinnedUserGoal` left as the narrower
    user-pinned question layered on that predicate. The two mode axes are now named
    apart, so the TUI's `[auto] ` marker states a permission fact and nothing on the
    goal axis feeds it.

- **Native session checkpoints: a published native-context snapshot survives an abnormal
  exit, and file writes are durable before they mutate (spec `session-checkpoint-architecture`,
  ADR-0136, plan A 2026-10-03)**:
  before a model turn starts, the host publishes the session's native context as a
  content-addressed body under `<session>/blobs/native/<sha256>` plus an append-only
  `native_state` record anchored at the accepted input's own event. Selection is derived
  from the event/head chain alone — no timestamp ordering, no independent current-state
  pointer, no branch registry — and the body is always written before the reference, so a
  failed body write leaves nothing selectable. On reopen, `openSessionWithRecovery` selects
  the published state, restores that saved context as the next turn's model context, and
  classifies the session as `recovered` / `needs handling` / `blocked` /
  `unsupported_format` / `no_published_state`; recovery is read-only and issues no model
  or tool call. A missing, corrupt, or invalid body fails closed as `blocked` rather than
  falling back to transcript reconstruction. Separately, every `write_file` / `edit_file` /
  `symbol-mutate` now appends a durable per-file intent before touching its target — so a
  multi-file call keeps an association for every target instead of last-write-wins — and
  publishes each target atomically (staged write + rename), leaving a target's bytes wholly
  old or wholly new and never partial. With `codeRestore.enabled: false` the write still
  proceeds and is recorded as unverified rather than blocking or claiming completion.
  Old-format sessions are detected by a new-format marker written only at session creation,
  so an existing session is never relabelled and its bytes are never rewritten. Terminal,
  tool-batch, and compaction boundaries, plus worker/graph runtime facts, are the parallel
  plan B and plan C surface and are deliberately absent here.

- **Session saved state: the harness now emits typed runtime persistence requests
  (spec `session-checkpoint-architecture`, plan B, 2026-10-03)**:
  `src/shared/runtime-persistence.ts` declares one dependency-neutral port, and the loop
  engine, the `run_graph` handler, and the subagent manager each publish through it. The
  harness owns no session file, no store error type, and no independent head; a host that
  wires nothing sees byte-identical behavior, and every write site awaits the port and
  blocks its dependent execution on failure.
  - Loop: the accepted user input is published before the first model dispatch; each
    settled tool result appends a fact carrying its tool-use id, batch position and batch
    size, so a result is durable while an earlier call of the same batch is still blocked
    and protocol order is reconstructible without replaying the batch. A batch is published
    as a whole state only once every returned result — tool errors included — is in the
    saved context, and never for a cancelled batch or a detached ADR-0134 handler that is
    still running. Compaction publishes the exact post-compaction context on both the
    proactive and the reactive path; the terminal publication carries the observed stop
    reason and never a completeness verdict, which stays the host's call under ADR-0126.
  - Graph: node facts are written per node at its own settlement point rather than in one
    post-convergence pass, which is where a kill inside the scheduler previously lost every
    already-settled node. A dispatched node is marked before the spawn, so an interrupted
    node is distinguishable from one that was never submitted, and a failed node carries its
    error. The cancel, string-output and `skipped` rules have a single definition that both
    the in-process ledger and the fact stream call, so the two cannot drift. No
    `nextNodeIds`, no second journal, no per-conversation mutex.
  - Workers: a per-task identity record captures pid plus `/proc` start time, so a recycled
    pid is never signalled and an unreadable identity is a needs-handling answer rather than
    a "stopped" one. The worker is deliberately not detached, so the background-task
    process-group helpers are not reused — this worker shares the host's group and signalling
    it would take the host down with it; liveness is pid-granular instead, carrying over the
    start-time read and the cleanup evidence vocabulary. Continuation is refused until the
    exact prior process is proven gone.
  - Recovery-critical writes that cannot be awaited (the worker spawn seam is synchronous by
    contract) write their own durable record first, treat the fact as a projection of it, and
    surface a rejected append explicitly with its cause.
  - Plan status, including which acceptance clauses remain open and which single owner each
    one has, is recorded per-clause in
    `docs/implementation-plans/session-checkpoint-runtime-workers.md` and
    `docs/implementation-plans/session-checkpoint-storage-recovery.md`. After all three plans
    merged, the remaining host-side work has named owners rather than a sibling plan: the
    fresh-process reopen halves sit with the host-side runtime persistence adapter that no host
    binds yet, the session-host abnormal-exit hook and the reopen sweep sit with the
    session-host entry path (`stopOwnedWorkers()` still has no caller, and `resumeTask` still
    gates on the in-memory task map), per-file associations sit with this plan's write-capture
    seam, and SC24 and SC25 are combined acceptance across all three plans and are not claimed
    here.
  - Model-input surface: three new model-visible strings, not one. The
    `prior_process_unconfirmed` continuation refusal and the two `undurable` node-failure
    sentences in `src/harness/graph/run-graph-tool.ts` (a node that was not started because
    its dispatch could not be recorded; a node that finished as `done` but whose outcome
    could not be recorded) each carry a STATIC lock
    (`tests/subagent/subagent-continue-refusal-text.test.ts`,
    `tests/harness/graph/graph-undurable-text.test.ts`) and their trajectory gaps are
    registered in `docs/guides/prompt-development.md`; no tool description, tool schema, or
    system prefix changed.

- **Session traces: reopening a trace now shows the exact request that was sent, and says so
  when it cannot (spec `session-checkpoint-architecture`, ADR-0136, plan C, 2026-10-03)**:
  every governed SDK invocation is retained with the request object as it was finally
  dispatched — post-injection, post-compaction, post-instruction- and post-tool-projection —
  under a new `dispatch_evidence` row, one identity per invocation even when two calls reuse
  the same bodies, carrying that attempt's outcome so a rejected or stream-failed call stays
  attached to the invocation it belongs to. Bodies are masked before they are hashed and
  stored, so the session-local pool `<session>/blobs/<sha256>` shares one immutable body per
  distinct masked representation while the raw native recovery bodies stay physically out of
  reach. On reopen, the `get-record` manifest arm returns `final_request_evidence` — the
  complete dereferenced request rather than a hash — through one address gate that authorizes
  only the bodies the selected trace references, so an unrelated raw checkpoint body in the
  same pool can neither be read nor enumerated. A trace copied without its referenced bodies
  is reported as an explicit `evidence_gap: "unreadable_referenced_body"` with fail-closed
  empty parts, so missing evidence cannot read as a record that had no content. Capture is
  best-effort: a capture or storage failure never re-dispatches the model call, credentials
  and transport headers are never captured, and a reader gets no new export command, bundle,
  or UI.

- **Harbor adapter: `--ak trace_out=true` retains the per-turn trajectory as a trial
  artifact (2026-09-29)**:
  the adapter previously kept only the merged `ask` stream, so the Terminal-Bench pilot
  scored two model-attributable trials with no per-turn record and named what that cost
  (`docs/evidence/adr-0130/terminal-bench-2-1-pilot.md` §8): the loop diagnosis for both
  scored trials, any tool-selection rate, and the classification of a second hard-wall
  deny whose correctness stayed "undetermined" because the offending command text was
  never captured. With it on, `ask` receives `--trace-out /logs/agent/trace` and writes
  its JSONL trace there. Off by default, so a scripted run is byte-for-byte the one the
  pilot measured. Three things the option is shaped around, each measured against a real
  `ask` run rather than read off the flag name: the flag takes a **directory** and writes
  `<dir>/<conversationId>.jsonl` with a container-minted UUID, so the adapter records the
  directory and never claims a filename it has not seen; it **composes with
  `--eval-state`** (the real parser returns both with no rejection), which are exactly
  the trials whose diagnosis is wanted; and a trace write that **fails** warns once and
  answers anyway, so the adapter parses that notice and records
  `trace_write_failed: true` on the trial rather than letting a lost trajectory read as
  a clean run. No harbor `--artifact` entry is involved — `/logs/agent/` is already
  collected whole by `_download_agent_logs`, and `/logs/artifacts/` is reserved for
  inputs re-materialized into a separate verifier environment. The option carries **no
  `Env` fallback**, unlike `permission_mode` / `eval_state`: harbor's env lookup falls
  through to the host process environment, so a fallback would let a bare
  `IKNOW_TRACE_OUT=1` rewrite a pilot-baseline trial's argv, and `IKNOW_TRACE_OUT` is
  already a shipped iknow variable with _path_ semantics, so it is also a name
  collision. Because iknow prints no notice at all when a run never got far enough to
  write a record (measured: no API key → the provider envelope, exit 1, and a trace dir
  with zero files), the adapter reads the directory in the container after `run()` and
  records `trace_state` — `present` / `empty` / `absent`, with the key simply absent
  when tracing was not requested — so a reader of `results.json` can never mistake a
  missing trajectory for a retained one. The probe tests `-s` (size > 0), so a
  zero-byte `.jsonl` from a run that died mid-write is not read as a trace.

- **Protected filesystem and credential effects are refused by every spelling, not just the shell one (issue #1155, spec `effect-boundary-protection`, ADR-0129, 2026-09-28)**:
  a protected target is refused identically by `rm -f`, by `python3 -c 'import os; os.remove(...)'`,
  and by any other interpreter the fence admits, because the protection now lives at the
  bwrap mount and capability boundary rather than in shell-command scanning: the existing
  sensitive-path roster and the system read-only prefixes became one resolved-target
  inventory, present targets get read-only binds ordered after every writable bind
  (kernel EROFS to any program inside the fence), and credential sources additionally get
  a mount-level cover so a protected credential inside the fence reads as a masked value
  or as nothing — for the foreground bash tool, background spawns, and the verify
  executor. A boundary refusal now reports as a boundary refusal: an `[fs_denied]`-prefixed
  message naming the target _class_ (an SSH private key, a cloud credential file, an
  environment file) and the fence layer, stating unconditionally that the session cannot
  remove that target at all, and explicitly not recommending a re-spelling. An
  exact-file target is masked rather than bound, so its unlink surfaces EBUSY instead of
  EROFS; that second bounded trigger fires only when the diagnostic names a mask the same
  fence actually emitted, and unmatched stderr stays byte-identical (issue #1157).
  Name-pattern rules (`*.pem`, `.env*`, `id_rsa`, …) are materialized per fence assembly
  over the workspace root resolved by `resolveWorkspaceRoot`, shared by both fs modes and
  read through the env SSOT rather than raw `process.env`: **12 ms** measured against
  **4110 ms** for the withdrawn whole-home scope (791,575 entries), which the 2M
  fail-closed bound would have refused outright on a larger home. The narrowed scope is
  the only source of that speed — hidden directories, `node_modules` and caches are all
  walked — and its coverage floor is deliberate and documented: a name match outside the
  workspace gets nothing physical from the name arm, while the hard-wall's text arm still
  denies naming it and an explicit concrete target still gets its mount. A protected target
  absent from the host is skipped with a typed warning that carries the surviving-enforcement
  count; traversal errors, symlink cycles and escapes, bind-source swaps, and match-count
  exhaustion are typed refusals at assembly, never partial fences.
  **The authorized-cleanup receipt mechanism (issues #1156/#1158) was withdrawn, not
  shipped, and is not part of this release.** A real-bwrap feasibility run proved it could
  not have worked: `--bind <path> <path>` makes the path a mount point and `unlink` on a
  mount point returns EBUSY, so the route could never have deleted anything (#1163) — the
  only shape that did delete was the shape that escalates, granting RW and unmasked access
  to every sibling credential. Ordinary backups are unaffected: they live in
  already-authorized writable locations, are removed by ordinary filesystem permissions
  under either spelling, and cleanup never opens a protected path's parent directory. The
  spec records the withdrawal visibly — SC9 is tombstoned rather than renumbered away, and
  the old contract is stated as not fulfilled. ADR-0128 (host read capability across agent
  tools) shipped alongside.

- **Per-model-route output budgets and an explicit output-limit notice (spec `model-output-truncation`, ADR-0126, 2026-09-27)**:
  each `models[]` entry takes an optional `maxTokens`; the matched route carries it as
  `llm.routeMaxTokens` / `ModelRouteEnv.maxTokens`, and request assembly falls back to
  32,000 only for a route that declares none. The limit is a request budget, not
  evidence that the route returned one. When the supplier stops on the output limit the
  terminal outcome is persisted in the session JSONL, and one server-owned notice —
  a single exported constant, so the live append and every replay of it carry identical
  bytes — is rendered verbatim by both TUI and Web, live and on reopen. `compactSession`
  consults the persisted outcomes and never synthesizes `completed` for a truncated
  turn, so a rewind / compact round keeps the truth.
- **Independent subagent thinking settings (spec `subagent-thinking-settings`, 2026-09-27)**:
  `settings.json` gains optional `subagent.thinking` and `subagent.thinkingEffort`, so
  a worker's thinking mode and effort are configurable independently of the parent.
  When either field is unset the parent's effective values are inherited, including
  per-turn overrides and continuation calls. An immutable parent snapshot is carried
  through the executor wrappers and the worker envelope, the envelope is validated, and
  the legacy worker (no snapshot) still falls back to `env.llm` thinking. No TUI change.

- **Shared frontmatter module (spec `frontmatter-shared-parser`, ADR-0123, 2026-09-23)**: `src/harness/frontmatter/`
  exposes two APIs that replace the four hand-rolled `---` parsers — `stripFence`
  (content-independent, never throws, returns the body as an exact byte slice) and
  `parseFrontmatter` (a real YAML parse plus the scalar coerce boundary: scalars to
  string, scalar sequences folded with `", "`, mappings skipped with a warning and
  never registered as a top-level key; a broken block yields an empty map plus a
  warning and never throws upward). This is the repo's first `yaml` production
  dependency, exempted from the zero-new-dependency gate by ADR-0123's gate check.
- **`when_to_use` as a second skill selection signal (spec `frontmatter-shared-parser`, 2026-09-23)**:
  an optional `SKILL.md` field rendered on its own line in the opening frozen
  `<available_skills>` table and in the in-session delta rows, with its own 1536
  truncation budget independent of `description`, stripped together with
  `description` under index demotion, and carried on `SkillSummary`. Eligibility
  is unchanged — a skill still needs a `description` to enter the index.

- **Code restore on rewind (ADR-0121, 2026-09-22)**: a successful workspace write
  by `edit_file`, `write_file` or one of the five symbol-mutation tools first
  captures the bytes it replaced. Blobs are content-addressed (`sha256`,
  write-if-missing so identical content dedups) under the session folder's
  `code-snapshots/`, and the committed `tool_result` event carries the ref:
  relative path, root identity, preimage sha, post-image sha. Capture is ON by
  default and user-layer only (`codeRestore.enabled`; a project settings file's
  value is dropped). A rewind can then put the abandoned segment's files back:
  `restoreCode` on `POST /api/v1/sessions/:id/rewind` (absent → transcript-only,
  no `codeRestore` key), and the TUI's double-Esc confirm now offers three
  actions — restore code, transcript only, cancel. The transcript stays
  append-only (ADR-0027): only the head moves. Restore is all-or-nothing — every
  blob is read before any file is written, so an unreadable preimage aborts and
  the head never advances past code that could not be put back. A path is written
  back only while its live bytes still equal the last recorded postimage and the
  workspace identity is unchanged; drift and identity mismatch are reported
  skips, not errors. Worker writes join the parent's plan (their blobs land in
  the parent session folder, ADR-0102). Transcript-supplied locators are
  validated: a ref whose path is absolute or climbs out of the root, or whose
  blob name is not sha256 hex, is dropped — a transcript is history, not a
  license to touch anything outside the workspace's own store. A multi-file
  rename likewise captures every file's preimage before the first write. Spec:
  `specs/code-restore.md`.

- **TUI slash commands accept bare-name skill aliases (2026-09-15)**:
  `/using-agent-skills` and `/arthurpower:using-agent-skills` resolve to the same
  entry — candidate lists, completion, and skill-load parsing accept a canonical
  name or a unique bare-name alias (case-insensitive), while emitted entries and
  payloads always carry the canonical name; `/help` and Tab completion display the
  canonical form. Static command words win exact collisions. Aliases fold-case
  across plugin and workspace skills; a bare name colliding with more than one
  canonical name yields no alias at all (unavailable beats ambiguous). The
  remainder after a bare-name invocation is cut by the input token's length, so
  short aliases no longer eat the prompt prefix. Agents are structurally excluded
  from slash. Spec: `specs/tui-skill-slash-catalog.md`.

- **Global plugin component loading (ADR-0095, 2026-09-14)**: skills, agents, and
  hooks carried by locally installed plugins are now read and fully used. Plugin
  roots: `~/.iknow/plugins` (default), plus `IKNOW_PLUGIN_ROOTS` env and the
  user-level `plugins.roots` setting (user layer only — plugin-contributed hooks
  execute arbitrary commands, so the project layer is deliberately excluded).
  Discovery prefers the `installed_plugins.json` ledger (the marketplace key's
  leading segment is the namespace, install paths at any depth) with a directory
  scan fallback including `<root>/<plugin>/<version>/` nesting. Canonical names are
  `<plugin>:<name>` with bare-name aliases (conflicts drop the alias and warn);
  agent ids allow `:` and pass through verbatim. Hooks from `hooks/hooks.json`
  compile into async subprocess hooks: matcher dispatch by character class
  (exact alternation vs unanchored regex), tool-name candidate sets, envelope key
  aliases, and `${*_PLUGIN_ROOT}` / `${*_PLUGIN_DATA}` / `${*_PROJECT_DIR}`
  substitution exported as env; Pre exit 2 blocks, everything else fails open;
  hook errors gain `plugin-init` / `plugin-exec` phases. The pre/post tool-hook
  chain became additive-async (hooks may return promises; existing synchronous
  hooks unchanged).

- **Graph-mode short presence line, once per run (ADR-0081, 2026-09-11)**: with
  the graph open, a single short `<graph_mode>` line is stamped at the start of
  each run instead of appended on every hop of the same turn. Flip moments can
  still carry the long ON/OFF line; a long ON already stamped suppresses the
  short line for that turn. Supersedes the previous per-hop stamping semantics.

- **Live graph, phases 1 + 2 (2026-09-10)**: repeated `run_graph` calls in one
  session share an in-process live-graph ledger (remaining subgraph, per-id
  freeze, cancellation keeps only done nodes). Phase 2 adds `onFailure`, re-entry
  by id, and an 8-entry fuse per id. The ledger never enters the JSONL transcript.

- **`web_fetch` HTML window (2026-08-28)**: transport-level decoded-body cap of
  1 MiB (streamed read plus a second refusal at stub level); `start_chars`
  continuation fetch; `Window:` / `Representation:` headers before the untrusted
  banner; `max_chars` cap 16000 so total output stays within the executor's
  20000-char truncate budget. Opt-in `as: "html"` returns markup (html
  content-types only); binary types are refused. Sandbox curl and fence env are
  unchanged — browsing still goes through the SSRF-guarded `web_fetch`.

- **Auto-memory dream gate (2026-08-28)**: `settings.memory.dream` is decoupled
  from extraction. A dream run requires both at least 24h since the last
  success-or-skip and at least 5 distinct sessions (in-process chat/TUI
  sessions; serve `conversation_id`). A cursor JSON lives in each memory
  directory. With fewer than 2 current entries the merge LLM call is skipped and
  the time gate still advances. Extraction remains `completed`-turn-triggered
  with N≥2.

- **Subagent runtime and handoff alignment (2026-08-28)**: non-positive
  timeout/token env values fall back to settings/defaults (`0` no longer means a
  dead clock or `max_tokens=0`); a clean `exit(0)` without an envelope is an
  immediate `protocolError` and frees the slot; workers inherit the parent's
  idle/hard-cap; the concurrency cap is configurable, default 15, and over-limit
  calls fail immediately instead of queueing; the parent-model handoff is now a
  short summary plus paths (artifacts remain reachable through IPC and
  `run_graph` edges); generic workers get the static instruction layer and memory
  tools off, and explore agents are not fed the full AGENTS.md; the default
  `subagent_type` is `general-purpose`.

- **Automatic memory extraction with mechanical GC (ADR-0031, 2026-08-26)**:
  delivers the long-deferred item of ADR-0009 D5. New switch
  `settings.memory.autoExtract` (boolean, **default off**) — when absent or not
  `true`, nothing is wired: zero extra calls, LLM usage, or writes, byte-for-byte
  matching previous behavior. When on, chat / tui / serve trigger an async
  extraction after a `completed` turn (one pass once N≥2 turns complete; the
  `ask` entry stays opt-out per ADR-0010 D3): the LLM extracts atomic candidates,
  BM25-lite neighbors are found, an ADD/UPDATE/SUPERSEDE/NOOP verdict is decided,
  and the existing affirmative-sentence gate plus tmp+rename atomic write store
  the entry tagged `source: auto`. Cleanup is a zero-LLM mechanical GC (expired
  `ttl_days`, entries named by `supersedes`, or eviction by
  `importance × recency × (1 + recall_count)` over the store cap) that
  **retires without deleting files**. Auto entries do not bypass the promote gate
  and do not enter the `system` channel. Extraction or IO failures surface as
  typed memory errors that the host logs and swallows; the user turn still
  succeeds.

- **Fault-class recovery and fused stop (2026-08-25)**: a closed-set FaultClass
  taxonomy, bounded transport retry inside `ModelAdapter.step`, and a tool-loop
  `StopReason: fused` + LOOP_DETECTED path. Transport retries exhausted map to a
  `protocolError` stop.

- **Shared sandbox discipline for foreground/background bash and parallel tool scheduling (2026-08-25)**:
  foreground and background `bash` now share one bwrap fence. Within a tool phase,
  consecutive `isConcurrencySafe` calls overlap; unsafe calls stay serial; result
  order still matches `tool_use` order.

- **TUI verify end-state visibility and environment snapshot (2026-08-24)**: HITL
  and auto mode show verification pass/fail in the TUI (host projection includes
  `passed`). A human-readable environment snapshot (cwd / git / diff, up to 2000
  codepoints) rides on chrome and is deliberately not written into the
  ADR-0028 append-only status bar.

- **Settings.json reverse channel (2026-08-13)**: saving and exiting the
  `/thinking` / `/effort` panels with Esc now writes changes back to
  `settings.json` (merging the `llm` subtree while preserving apiKey / model /
  secrets and all unrelated fields). The write-back skips its own reload via a
  sha256 self-write sentinel, so the one-way external hot-reload channel is
  unaffected. On failure a TUI notice shows, the in-memory override stays, and
  nothing crashes; Enter inside the panel pins, Space/Tab preview without
  writing.

- **Trace read side fused into `iknow serve` (ADR-0020, 2026-08-17)**: same
  process, same port — route subtree `/api/v1/traces/*` (filter + paginate,
  `/traces/fields`, `/traces/sessions`) plus a `/trace` SPA sharing the web
  multi-entry build. A trace-router factory with injected options removed the
  reverse dependency from the trace server onto CLI usage, and static serving
  gained path-prefix mounting. The legacy `/api/v1/sessions` alias under
  `--separate` mode was kept one version (deprecated). Error envelopes are unified
  (validation 400 / trace-read 500 without echoing filesystem detail). Web entry
  points: a global Trace link, per-session deep-link `/trace?session=<id>`, and a
  back-to-chat link. The trace server and session API stay sibling modules; the
  write side is untouched.

- **Per-root workspace state isolation (ADR-0019, 2026-08-17)**: per-root state
  (identity workspace seed, `user.md`, `BOOTSTRAP.md`, memory store, serve data,
  settings write-back fallback) follows the launch root, decoupled from `home`
  (global config anchor, settings merge fallback, host-init script, global-scope
  memory). New `--workspace-root <dir>` CLI flag (mirroring `--data-dir`) and
  `IKNOW_WORKSPACE_ROOT` env, precedence explicit > env > `process.cwd()`; a
  migration opt-out `--workspace-root "$HOME"`. The protected-path policy extends
  to `<workspaceRoot>/.iknow` and its children. Settings write-back redirects to
  `<workspaceRoot>/.iknow/settings.json`, and thinking persistence uses a
  per-invocation unique temp name, fixing a concurrent-clobber defect. Boundary
  coverage for the resolver (empty / invalid / overflow / concurrent / exception)
  and an integration probe verified persona files land in the workspace while
  `~/.iknow/state.json` stays untouched.

- **TUI skill and MCP extension sources (2026-08-11)**: the TUI entry assembles the
  skill scanner/catalog (`skill` / `skill_search` tools plus the
  `<available_skills>` system section) and a live MCP manager (`mcp__*` tools
  resolvable by the executor; idempotent shutdown of stdio children on exit).
  Slash candidates mix static commands with dynamic skill entries; Tab completion
  spans both; `/skill-name [prompt]` deterministically loads the skill body with
  the prompt appended (not relying on model initiative), echoing exactly what is
  sent. A `/mcp` board shows per-server status colors, tool counts, Enter for
  detail, `r` to reload, Esc to back out. Supporting harness seams: external-tool
  unregister for reload and a non-blocking `McpManager.reload`.

- **Settings inheritance channel for loop configuration (2026-08-11)**:
  `.iknow/settings.json` becomes the single source for loop config (maxTurns and
  compaction contextWindow/thresholdTokens), user- and project-layer with project
  overriding user, per-layer merge, invalid-value fallback, and deep freeze.
  Precedence `process.env > .env.local > .env > settings.json (project > user) >
hardcoded defaults` for those three fields only; other fields unchanged.
  Subagents self-assemble through the same loader and inherit naturally. With
  nothing set, behavior matches the previous defaults (unlimited maxTurns,
  proactive compaction off).

- **Manual session compaction (TUI `/compact` + web button)**: the harness
  `compactMessages` (shared by proactive/reactive paths) gained manual entry.
  Backend: an idempotent `compactSession` on the hub (below threshold: no write,
  no `updatedAt` bump) exposed as `POST /api/v1/sessions/:id/compact`. TUI: the
  `/compact` slash command (refused while running, notice when there is no
  context, refreshes from disk afterwards preserving the usage readout). Web: a
  compact button beside the context-usage strip with non-blocking local error
  display.

- **TUI mouse drag selection (ink era, 2026-08)**: an in-app selection layer —
  drag coordinates, inverted highlight, and mouseup copying the selection to the
  system clipboard through a multi-platform fallback chain; Ctrl+Y as a keyboard
  escape hatch. Superseded by OpenTUI's `<text selectable>` drag selection after
  the rendering-backend migration.

- **Memory injection v0 (ADR-0009 / ADR-0010)**: layered memory-file injection
  landing (`src/harness/memory/`: paths, schema, discovery, BM25, promote,
  assembly, refresh) and the `memory_recall` / `memory_save` tools registered in
  the default ACI registry. The system assembly order converged to five sections
  (identity / soul / user_profile / bootstrap / memory_layer); the memory layer is
  a single slot delegating to a cached, in-flight-deduplicated resolver that never
  poisons assembly on failure. Surface split: `ask` strips memory tools and the
  memory layer; chat / tui / serve default to on.

- **Shift+Tab toggles auto permission mode**: TUI and REPL flip in place between
  `default` and `full_auto` (label "Auto") — no ask-bridge detour, no engine
  rebuild, no `/permissions` roundtrip. `plan` mode is kept but excluded from the
  cycle to avoid silently denying mutating tools; pressing Shift+Tab while in
  `plan` goes straight to `full_auto`. TUI shows a dim mode indicator (narrow
  columns degrade to a short tag); REPL hooks the same flip on stdin keypress.

- **Identity assembly layer**: identity (Name/Kind/Signature), soul (core
  truths/boundaries/vibe/continuity), the `~/.iknow/user.md` profile, and a
  first-run BOOTSTRAP guide, all injected through the `deps.system` seam by every
  entry point (chat / tui / ask / serve). `state.json` records `bootstrap_seeded`
  so the BOOTSTRAP section is skipped on later runs. Workspace initialization is
  eager and idempotent at the build seam and all four entry points; failure warns
  instead of blocking assembly.

- **Single-source ACI tool registry**: the eight default tools
  (bash / read_file / grep / glob / edit_file / write_file + web_fetch /
  web_search) moved from a hand-written array to one assembly factory shared by
  the engine builder and the TUI deps, ending the TUI entry's tool-set drift
  (which had been missing web tools and ignoring `IKNOW_WEB_PROXY`). Factory
  inputs are narrowed (web config + sandbox root, no secrets); an invalid proxy
  URL fails fast at assembly; out-of-root file access stays refused at execution.

- **Streaming render seam across chat and TUI (2026-08)**: a shared stream-draft
  accumulator (pure append/mask/raw/reset/subscribe, full re-mask of the current
  secret values per snapshot, cross-delta truncated keys masked on the accumulated
  text, no fd / no React dependency); the hub's `postMessage` gained an optional
  `onStream` passed to `run()`; TUI deps enable streaming from the same env SSOT
  as the engine, so the TUI truly streams. The TUI renders the masked draft as
  markdown before the spinner and commits it at turn end (abort clears it and
  shows an "interrupted" notice). The chat TTY preview switched to the same
  draft, making the full secret-masking path effective. Thinking display
  collapsed-state unified: chat `showThinking` now renders a collapsed summary
  row instead of the full text, and TUI gained the folding toggle wired to row
  estimation.

- **Trace inspection panel (2026-08)**: a read-only trace server module — synced
  JSONL reader (`MAX_TRACE_BYTES = 8 MiB`, line-boundary truncation, filesystem
  errors wrapped as `TraceReadError`), `GET /api/v1/traces` (filters:
  conversation_id / record_type / status; pagination limit 1..200 / offset ≥ 0;
  malformed lines counted in `skipped_lines`; snake_case wire) and
  `GET /api/v1/traces/fields` (field declaration table as single source, unique-key
  self-check at load). The web UI gained the trace panel (stats bar, filter bar,
  table, expandable rows, column picking) with view switching that keeps chat
  state mounted. Adding a trace field = one type + one declaration row.

- **Trace panel moved to a standalone `iknow trace`-hosted page (2026-08)**:
  extracted from the chat SPA, which returned to chat-only form. Shared Vite
  multi-entry build and assets; the trace process reuses the static-serving helper
  (index route, SPA fallback, path-traversal 403, `/api` refusal); API routes take
  precedence over static files.

- **ACI web tools `web_fetch` / `web_search` with a shared SSRF egress guard (2026-08)**:
  URL syntax, embedded credentials, non-public IP literals and DNS results, local
  hostnames, single-label hosts, ≤5 redirect hops re-validated per hop, non-2xx
  refused; fetch and DNS deps injectable so tests run fully offline. Shared HTML →
  text and IP-classification primitives. Tool metadata: read-only category
  (default allow), concurrency-safe, cancel-on-interrupt, default timeout tier.
  `web_fetch` prefixes an untrusted-content banner against prompt injection and
  clamps `max_chars` (default 12000, 500..50000); `web_search` defaults to 5
  results (1..10) with an overridable search URL (env or parameter, same SSRF
  validation). The registry grew append-only 6 → 8 tools keeping existing order.
  The default user agent is a browser-style string to pass common anti-bot
  filtering.

- **Outbound proxy arm for the web tools (`IKNOW_WEB_PROXY`)**: explicit
  configuration only (`trust_env=False` semantics — system `HTTP(S)_PROXY` is
  never read). The proxy URL passes the same SSRF syntax validation as targets
  (http/https, host, credentials; no public-IP refusal for the proxy itself, local
  proxies must be allowed); both web tools fail fast at assembly on a bad proxy
  config. New env field in the config SSOT; dependency added: `undici`.

- **Early web/CLI foundation (2026-07)**: see the dated narrative sections below.

### Changed

- **Proactive auto-compact gate reads context occupancy (spec `context-occupancy-autocompact`, ADR-0118, 2026-09-21)**: the bar and the gate now share one numerator — `evaluateCompactTrigger` compares in the priority chain this-beat `countTokens` (finite and > 0) → previous-beat occupancy (usage) → chars estimate; a missing / throwing / non-positive reading always falls through and never collapses into `below_token_threshold`. loop-engine probes the gate-visible messages before the gate and always passes `lastUsage`; hosts without `onStream` still measure and gate. Display readings are unchanged (the TUI numerator now uses the harness SSOT `occupancyFromUsage` directly; the Web keeps a cross-package mirror pinned to the same formula by a shared table). The denominator, the 95% formula, the window/full_summary compactors, and manual `/compact` bypassing the gate all keep their semantics.
- **TUI `/model` switching no longer re-renders the whole tree and no longer resets manual thinking/effort overrides (2026-09-15)**:
  env-derived display snapshots (model routing string + thinking baseline) flow
  through a framework-agnostic store consumed with `useSyncExternalStore`; a
  successful env reload publishes a snapshot instead of re-rendering the root, and
  the context bar's model segment re-projects on its own (regression pinned with
  line-by-line frame diffs). Takeover layering for thinking/effort: submitting via
  the `/thinking` / `/effort` panels marks the field, after which in-session
  settings-baseline changes no longer overwrite it (the old behavior dragged all
  three states back to each new baseline); unclaimed fields still follow the
  baseline and external settings hot-reloads keep updating the display. `/info`'s
  model line and per-turn thinking-override baseline read the store's latest
  snapshot at call time. Model display naming and registry flattening moved to the
  picker leaf module (no app ↔ context-bar cycle).

- **Unified secret handling — roundtrip mask (2026-08-13)**: replaces the earlier
  deny-only guard. Recognition replaces secret-shaped text in user input with
  per-engine in-memory placeholders; the bash restore layer substitutes real
  values back at spawn; output masking falls back to the registry's values —
  **the real key value physically exists only in the bash process while it
  constructs the HTTP request**. `settings.secrets.mode`: `roundtrip` (default:
  recognize + placeholder + restore + fallback mask) or `block` (legacy deny-only
  guard, kept for backward compatibility). End-to-end matrix across the four
  surfaces (chat / ask / tui / serve) × two modes.

- **Settings.json file-level hot reload for the TUI chat path (2026-08-13)**: after
  editing `~/.iknow/settings.json` or `<cwd>/.iknow/settings.json`, a running TUI
  chat process needs no restart — from the next turn it calls the LLM with the new
  environment. A whitelist of nine adapter fields takes effect live (model,
  apiKey, thinking, thinkingEffort, fallback, baseUrl, maxOutputTokens,
  temperature, stream); fields outside it (loop-engine assembly inputs,
  display/env-only fields) still need a restart. The context bar's model and
  thinking labels refresh in real time. A failed reload (bad JSON, missing model,
  unresolvable key) keeps the old environment with a notice instead of crashing.
  Implementation: a pure fs watcher (primary channel plus a missing-directory
  fallback, debounced, idempotent stop), an env-loader factory, and hub seams for
  env-provider / on-change / reload with a minimal adapter rebuild surface.

- **LLM configuration converged onto `settings.json` as the single carrier (ADR-0015, 2026-08-12)**:
  completing the previous phase ("model configurable + fail-fast + hardcoded
  default removed"), this phase converges key configuration too —
  `settings.llm.apiKey` accepts a literal, `${VAR}`, or `$VAR` form. The
  `IKNOW_LLM_API_KEY_ENV` (key-variable-name) and `IKNOW_LLM_MODEL` env channels
  were retired. Unified placeholder expansion resolves process.env > `.env.local`

  > `.env`; `.env.local` degrades to a placeholder-value source.
  > `IKNOW_LLM_BASE_URL` remains (provider/baseUrl is the project-stack decision
  > recorded in ADR-0001). Illegal placeholder forms resolve to undefined with
  > discard semantics aligned to the validator; sandbox secret-name derivation now
  > parses placeholders from settings (a literal key contributes no variable name;
  > the pattern-based sweep remains). Context docs rewritten; ADR-0001 carries a
  > supersede note for the retired indirection; probe/smoke scripts cleaned of the
  > removed env names and point missing-key errors at `settings.llm.apiKey`.

- **Settings field extension: `llm.model` configurable + `llm.fallback` + fail-fast (2026-08-12)**:
  `.iknow/settings.json` extends to `llm.model` and a user-configured
  `llm.fallback` model list, and the hardcoded combo default was removed.
  Precedence `process.env > .env.local > .env > settings.json (project > user)`:
  with neither `IKNOW_LLM_MODEL` nor `settings.llm.model` set, startup now fails
  fast with "no LLM model configured" instead of silently picking a default.
  Invalid project values never override valid user values (drop, not throw). The
  single addressable model-config spot is the user settings file plus an optional
  project override. ADR-0001's "welded default" clause is superseded (key variable
  name / baseUrl / provider retained).

- **TUI thinking control split: `/thinking` toggle + new `/effort` level (2026-08-12)**:
  fixed the semantic overlap where `/thinking` and Ctrl+O only folded the panel —
  `/thinking` now toggles the thinking request itself (aligned with the web
  setting), Ctrl+O stays fold/expand. `/effort <low|medium|high|xhigh|max>` picks
  one of five concrete levels (deliberately excluding the adaptive tier), and
  implies `enabled=true`, matching web radio behavior. Level values reuse the
  wire-contract SSOT. The TUI enables the existing per-turn thinking-override path
  with a validated env passthrough; a gate forwards the override only when the
  user actually changed thinking relative to the baseline. A pure-function module
  holds the override computation and label formatting. `/help` and `/info`
  updated. Also fixed a real bug: slash remainder was dropped for exact
  same-command first tokens (`/effort high` lost `high`).

- **Real-LLM end-to-end tests moved out of the default vitest collection (2026-08-12)**:
  the two real-model e2e suites took ~75% of the full run and flaked on model
  prompt paths; they now live under an archive directory the default include does
  not collect, with a dedicated on-demand `npm run test:real-llm` entry. Missing
  keys still skip explicitly.

- **TUI rendering backend migrated from ink to `@opentui/react` 0.5.1 (2026-08-10)**:
  a one-shot backend swap closing four known rendering problems — scrollback
  pollution (alternate-screen + double-buffered dirty-cell diff eliminated ink's
  per-frame history leakage); line-count drift (the whole row-counting path across
  nine files was deleted; scrolling reads layout positions from the scrollbox);
  ANSI-color test fragility (five skipped cases removed or rewritten as
  structured span assertions); keyboard probe swallowing keys (custom Kitty
  parsing deleted in favor of the built-in parser with input mocking). Selection
  moved to `<text selectable>` with OSC52 clipboard plus a native fallback chain.
  The old TUI is archived read-only. The test runner switched for the TUI suite
  (Node 22 lacked the needed FFI), so `npm test` runs both suites. Platform:
  Linux (incl. WSL2) verified; **macOS / Windows unverified**. `ask` / pipe /
  `serve` paths are unaffected.

- **TUI startup banner restyled (2026-08-06, three review rounds folded into the final form)**:
  from a large square dot-matrix eye with a single-line frame to a full-width
  rounded frame (matching the prompt input style), a small braille eye
  (32x13 cells) at the left, an info column (version / cwd / data dir) vertically
  centered at the right, and a centered `◆ iknow` title. Narrow-terminal
  degradation threshold settled at 80 columns; the gold glyph accent stays.
  Design doc: `docs/design/DESIGN-BANNER.md`.

- **Session persistence relocated (2026-08)**: the session pool root moved from
  `<cwd>/data` to `~/.iknow`, with the project namespace
  `<basename>-<sha1(cwd)[:12]>`; `serve --data-dir` still overrides, and the old
  `<cwd>/data` is neither read, migrated, nor deleted. The session-file schema
  upgraded v1 → v2 (new top-level `summary` / `cwd` / `sanitized_at`);
  `sanitizeSessionFile` forward-compatibly fills v1 on read with zero writes and
  refuses newer/ malformed files without repair. `SessionStore.list()` entries
  gained `summary` (existing fields unchanged). CLI chat state messages are now
  frozen readonly arrays.

- **Shared static-serving helper extracted** for the session HTTP server and the
  trace process (MIME table, web-root resolution, path-traversal 403 + `/api`
  refusal + SPA fallback); pure refactor, chat behavior byte-aligned.

- **Web thinking/tool/markdown display (wire additive extension)**: `TurnAnswerDto`
  gained optional `thinking` (entry texts + `redactedCount`) and `toolCalls`
  (name / input / output preview / isError / truncated) projections — per-entry
  character caps, everything masked before truncation; encrypted thinking data and
  signatures never reach the wire (count only). One projection serves postMessage
  and history replay. `PostMessageRequest` gained an optional per-request thinking
  override (`off` | `adaptive` + effort), validated strictly (illegal → 400, no
  silent fallback), applied by a per-turn adapter rebuild; without an override the
  wire is byte-identical and env values remain defaults. Web UI gained markdown
  rendering (GFM + highlighted code with a copy button), a collapsed thinking
  block (redacted entries render as an encrypted placeholder), tool-call cards
  (single expand + truncation marker), and thinking controls persisted in
  localStorage. Non-`completed` stop reasons show a notice with turn count. The
  SSE `/events` route remains 501.

- **`web_search` default endpoint switched to Bing (2026-08)**: the DDG html
  endpoint (upstream default) is unreachable in some network environments —
  observed as local DNS pollution of the whole duckduckgo.com domain family plus
  egress blocking (DNS-over-HTTPS resolved the real IP while direct connects timed
  out or were unroutable). Bing returned 200 with complete result structure and is
  reachable in affected regions. Parsing dispatches by endpoint hostname: DDG
  selectors kept (reachable via the `search_url` parameter or
  `IKNOW_WEB_SEARCH_URL`), Bing parsed via its organic-result layout; DDG redirect
  normalization applies only to DDG parse paths. Verified end-to-end with an
  unstubbed live search returning titled, linked, snippeted results.

- **Compact focus retention switched to recent-task excerpts (ADR-0026, 2026-08-22)**:
  sessions no longer carry a persistent single `taskFocus`; compaction keeps
  recent user task excerpts instead.

- **Documentation restructure**: the always-on agent-instructions file was
  condensed to constraints plus SSOT pointers — module lists, LLM/settings
  implementation, workspace-root details, and local tooling state moved out;
  architecture/config/status remain authoritative in `docs/architecture.md`,
  `docs/STATUS.md`, `docs/llm-config-quickstart.md`, ADR-0015 and ADR-0019;
  session start no longer loads all docs. The runtime path table duplicated by the
  architecture doc was replaced by a short module-boundaries callout list; dead
  references removed; the capability-gap analysis doc (status bar vs environment
  snapshot, lazy tool-surface claims, background-bash sandbox parity) was filed
  and status sections synced.

### Removed

- **The optional Harbor adapter under `scripts/harbor/` is retired, whole (issue
  #1175, 2026-10-02)**:
  the 10-file adapter — package, bundle script, agent, `ask` output parser,
  attribution, and its own pytest suite — was an optional Terminal-Bench driver
  layered beside the product, not a stage of it, so it retires as one bounded
  context rather than file by file. Nothing native depended on it: no product
  module, npm script, workflow, or TypeScript config referenced the package, and
  its attribution core had no consumer outside the adapter's own tests, so
  splitting that core out would have added an unused module in its place. The
  evaluation and trace paths users actually run are unchanged — `--eval-state`
  and its `runState` handling (ADR-0130) stay as they are, and so does the
  native JSONL trace written by `--trace-out`; the adapter's `--ak trace_out=true`
  only ever asked `ask` for that same `--trace-out` directory, and its artifacts
  stay in `/logs/agent/`, so the pilot report and the `### Added` entry above
  remain valid as a record of what was measured. Live doc references to the
  deleted path were reworded in place; measurements, counts, and the
  `docs/evidence/adr-0130/terminal-bench-2-1-pilot.md` report are untouched
  historical evidence and are labelled as such.

- **`.json` compatibility double-write mirrors dropped (2026-08-23)**: session save
  and head-move persistence no longer write `<id>.json` mirror files — the
  single-file JSONL is the only history format. `load()` keeps a `.json` fallback
  during the migration window, `delete()` still sweeps both paths, and `list()`
  still de-duplicates across both extensions until the legacy-only sessions
  migration script runs. Mirror-contract tests removed or updated; readers migrated
  to JSONL head records or the store API. Related ADR-0027 synced.

### Fixed

- **Hard-wall denials now separate a confirmed sensitive path from a fragment that merely occurs in code, and process teardown reports what it actually observed (ADR-0131/0132, 2026-10-01)**:
  a fragment match was treated as a verdict, so `node -e 'process.env.NODE_OPTIONS'` was
  denied for a string that is not a path. The wall now classifies a match as a confirmed
  path target, a proven chain member, or an unresolved one that routes to the existing
  per-call Security review — and a match must be interior to an identifier chain, so the
  sensitive name itself is never mistaken for an inert member of one. Confirmed reads,
  writes, redirect targets and recursively parsed nested shells stay non-overridable in
  both permission modes. Process cleanup reports `not_started`, `confirmed_stopped` or
  `unconfirmed` rather than a boolean: the background path used to disarm its kill timer
  on the leader's exit, so a surviving descendant was forgotten and the task looked
  cleanly exited.

- **Bounded file cleanup, read-only root search, and a per-call runtime deadline (ADR-0132/0133/0134, 2026-10-01)**:
  `rm -f` of an explicit file inside the calling identity's own session scratch, or of an
  ordinary file inside the active task root, leaves the blanket destructive-command wall
  and enters normal permission handling — `default` asks, `full_auto` may allow. The
  scratch root itself, recursive forms, mixed or outside targets, another identity's pad
  and protected targets receive no exception, and containment is decided from the
  filesystem rather than a text prefix. A read-only search rooted at `/` is no longer
  denied for its root; a mutating one is, and the allowance is a closed roster of
  predicates verified against the real binary. Bash takes an optional `timeout_ms`; an
  omitted one is a 10-second runtime deadline that actually terminates the process tree,
  and a background job's deadline is set at launch and is not extended by polling. A
  background call without `timeout_ms` keeps the persistent-service lifecycle.

- **Three confirmed security violations in one turn now stop that turn and its owned work (ADR-0135, 2026-10-01)**:
  the accumulator was session-wide and its notification did not reliably stop ongoing
  work. The streak is now scoped to the current user turn, an admitted successful tool
  call resets it, and routine denials, reviewer unavailability, timeouts and cleanup
  failures leave it unchanged. Reaching the threshold stops further model and tool
  scheduling, cancels this turn's in-flight work, workers and finite background jobs, and
  retains the session with a structured cause and per-item cleanup confirmation.

- **`--eval-state` is no longer detected by a registry of flags to reject, and `ask --resume --eval-state=true <id>` no longer resumes a session named `--eval-state=true` (ADR-0130, 2026-09-29)**:
  the posture flag was recognized by enumerating the value-taking options that must
  refuse it (`--host`, `--trace-out`, `--data-dir`, `--workspace-root`), which is a
  list that has to be extended by hand every time an option is added and therefore
  could never be complete — completeness being the property ADR-0130 asks for. The
  rule now derives from the parser's own structure: the argument scan loop is the
  single place a token is consumed as a flag, so on the query-bearing path a consumed
  token never reaches the positional stream and a posture spelling between two of the
  operator's words is plainly one of their words. The display path (`-h` / `-V`) reads
  the raw argv instead, where a valueless flag _is_ present; it is settled
  positionally — a display path starts nothing, so it has no operator words at all —
  which is what the deleted registry was proxying for. One `slotValue` reader, applied
  by every value-taking branch except `--resume` (which reports a posture in its slot
  as the existing typed `eval_state_flag_conflict` rather than throwing), makes "a
  posture flag is never a legal value" a property of the parser rather than a list to
  maintain, so a value-taking flag added later inherits it by calling the reader. A
  test now reads the source of `parseArgs` and asserts that every arm consuming
  `argv[++i]` calls `slotValue` other than `--resume`, so the one documented
  exception cannot be joined by a silent second one. The span reading still consults
  one name table, `SUBCOMMAND_HEADS` — pre-existing, and a closed dispatch vocabulary
  rather than an open-ended flag list (ADR-0130 §7).
  The user-visible defect that registry carried: `iknow ask --resume`
  `--eval-state=true` `<id>` silently resumed a session whose id was the literal
  string `--eval-state=true`, with no posture entered and no refusal, while bare
  `--eval-state` in the same slot was correctly refused. Both spellings now take
  ADR-0130's existing typed `eval_state_flag_conflict` refusal. `--yolo` is
  untouched — ADR-0119 ruling 7 stands, `--yolo` is still a parse-time typed
  refusal on `chat` / `serve` / `ask` / `oneshot` / `trace`, and
  `iknow tui --yolo` is still its only legal surface. Evidence: the eight
  argv-parsing files that cover the parser (`parse-args-eval-state`,
  `parse-args-yolo`, `parse-args-resume`, `parse-args-tui`,
  `parse-args-max-turns`, `data-dir`, `trace-out`, `cli-session`) pass at
  8 files / 220 tests, with `parse-args-eval-state` going 63 → 97 cases as the
  enumeration-shaped table was replaced by one rule over all seven
  value-taking slots in all three spellings, the display-path cases extended to
  the token orderings that decide the span, and a source-derived tripwire added
  that reads `parseArgs` itself so an _unpublished_ new value flag cannot leave
  the slot table silently incomplete. The S5 complexity ratchet for
  `parseArgs` went 47 → 40, the seven `raw === undefined` branches having moved
  out of the parse into the shared slot reader. A differential sweep of every
  2- and 3-token permutation over a 16-token pool (4352 vectors) against the
  previous parser shows no input losing a posture, and every difference falls
  into the two intended families above — the resume `=`-form fix and the
  display-path restoration. Real-CLI exit-code probes:
  `iknow ask grep --yolo in src` → exit 1 `yolo_non_tui_entry`, `iknow chat
--eval-state` → exit 1 `eval_state_unsupported_entry`, `iknow ask q
--eval-state --resume abc` → exit 1 `eval_state_flag_conflict`, `iknow ask
--resume --eval-state=true hi` → exit 1 `eval_state_flag_conflict` (the fix),
  `iknow ask --yolo hi` → exit 1 `yolo_non_tui_entry`.

- **A protected credential could be read out through an ancestor mount that the read mask never reached (issue #1159, spec `effect-boundary-protection`, ADR-0129, 2026-09-28)**:
  the credential read mask was computed per direct match, so a filesystem-arm ancestor
  (a bind of a directory holding the credential) shadowed a name-pattern match below it —
  `cat` of the secret succeeded. The mount plan is now coordinated so the cover cannot be
  shadowed, with a before/after real-fence proof and a control that pins the fix does not
  over-mask. The same pass closed a dead `vanished` warn path — the `realpathSync` ENOENT
  branch did a bare `continue` one line above the push, so the typed "disappeared between
  enumeration and bind" diagnostic could never fire (0 hits over 40 racing rounds) — now
  reachable through a broken-symlink fixture, and closed a roster gap: `.config/gh/` was
  the only credential subtree root with no hard-wall fragment, where `.ssh`, `.aws`,
  `.gnupg` and `.kube` all had one; a new completeness test now fails if a roster seed is
  added without a matching fragment.

- **`todo_write` advertised a flat schema its handler would not accept, and a model repeating itself burned the full retry budget (issue #1136, 2026-09-27)**:
  the tool exposed one schema while the handler enforced per-mode field rules, so a
  cross-mode call reached deterministic validation, failed, and re-fired identically —
  spending the generic R=5 loop budget before anything stopped. The schema now carries
  the per-mode `oneOf` and a schema rejection names the offending field instead of
  quoting the generic `must be equal to constant`. A narrow fuse (threshold
  `VALIDATION_LOOP_REPEAT = 3`) trips before the generic R=5 detector when the last
  three tool events are the same call with the same deterministic validation error;
  it reuses the existing `LOOP_DETECTED:` envelope so `isStalledToolLoop` is unchanged,
  and both seams' texts and the validation tag have a single source. A handler
  rejection is now classified `validation_failed` via a new `ToolInputValidationError`
  subclass, with the model-visible message bytes unchanged; cancel and timeout still
  outrank a handler rejection.
- **Host-injected messages were indistinguishable from real user input after a resume (follow-up to #1136, ADR-0112, 2026-09-27)**:
  the loop fuses and the new validation-stall fuse persist a `user`-role message
  carrying the `hostInjected` stamp, but the TUI drew it as an ordinary user bubble —
  no way to tell host injection from something the user typed. Stamped envelopes now
  render with a `[系统注入]` prefix in the amber `running` colour, with no user-bubble
  background fill and no `❯` prompt. The render is marker-driven only: it keys on
  `message.hostInjected === true` and never on envelope text, so an unstamped message
  carrying the same words still renders as a normal bubble. The renderer is shared with
  the interrupt notice. Web-layer parity is still open.
- **A memory write-back could drop a field it did not understand, and a quarantined file stayed silent (issue #1137, spec `memory-frontmatter-write-signals`, ADR-0123 residuals, 2026-09-26)**:
  `serializeMemoryEntry` now throws a typed `MemorySchemaInvalid` naming the key when
  an unknown frontmatter extra is not a scalar — the old `isScalar` filter emitted the
  entry without that field — and `writeMemoryEntryAtomic` warns once (`[memory/save]`,
  slug and key, never the value) and leaves the file on disk as it was. The refusal is
  defense-in-depth: no on-disk file reaches it today, because the shared coerce
  boundary hands the reader scalars only (spec assumption 6). On the read side
  `MemoryStoreScan.skipped` / `MemoryGcResult.skipped` became `{ slug, reason }` records
  and every scan consumer (gc, assembly, dream, ingest, prefetch) now warns when it
  drops a file the reader could not parse, instead of the omission being discoverable
  only by inspecting the disk. Healthy files are byte-unchanged: re-measured over the
  rebuilt SC-Corpus stand-in corpus, 17/19 round-trip identical, 2/19 still grow 2 B at
  byte offset 8 on their next save (the two blank-`id` entries), 0 rejected blocks, 0
  field changes, `computeSignature` stable 19/19 — evidence
  `docs/evidence/frontmatter-serialize-remeasure-1137.md`.

- **Three valid YAML frontmatter shapes were misread, one of them silently (issue #1128, ADR-0123, 2026-09-23)**:
  the skill scanner's per-line parser dropped fields and miswarned on a block
  sequence, lost the body on a block scalar, and — the only unwarned data
  corruption in the set — let a nested mapping overwrite the top-level `name` and
  `description`, so a skill could enter the model index under a polluted identity.
  Parsing now goes through the shared module, so all three shapes read correctly
  and a mapping key is never registered top-level. The subagent user-catalog and
  the memory read side migrated with it, which also makes a block-scalar
  `description` and a YAML-list `disallowedTools` in a user agent file mean the
  same thing as their single-line and comma forms.
- **A memory value containing a line break could split its own fence block (ADR-0123, 2026-09-23)**:
  `sanitizeMemoryFile` now folds `\r\n` / `\n` / `\r` in `title` and unknown
  scalar extras to a single space, and the fold is applied at
  `writeMemoryEntryAtomic` — the choke point all three writers (`memory_save`,
  auto-memory ingest, gc) pass through — so a model-supplied multi-line title can
  no longer reach the writer unsanitized and orphan a second index row. Line-free
  values are untouched, so healthy files stay byte-identical.

- **First-turn overflow governance could silently never run (2026-09-22)**:
  both ADR-0043 measurement gates — tool-surface overflow eviction and disclosure-index
  demotion — asked `countTokens` with `messages: []`, because a first turn has no
  history. A gateway enforcing the documented Anthropic contract answers that body with
  `400 messages must not be empty` (code 2013); each gate caught the rejection and took
  its documented skip path, so the session looked healthy while oversized tool surfaces
  were never evicted — two warnings at startup were the only trace. A gateway tolerant of
  the empty array hid the defect completely. The measurement request now carries one
  stand-in `user` message, a shape both classes accept: against a live endpoint both gates
  returned 200 before and after, with the numerator up by 2 and 1 tokens respectively — the
  constant offset ADR-0043's amendment now records. The count stays a measurement (the
  forbidden chars/4 estimate is still out of the decision), the adapter still projects
  exactly what it is given (ADR-0112), and the threshold plus eviction order are unchanged.

- **TUI startup printed 42 lines of false settings warnings (2026-09-22)**: launching
  the TUI with `$HOME` as the entry directory printed one
  `[settings] project settings key "X" ignored (not in project allowlist)` line per
  non-allowlist key, once per settings load — measured 42 lines in one startup (7 keys ×
  6 loads), 119 on the `ask` entry. They were false: `~/.iknow/settings.json` and
  `<cwd>/.iknow/settings.json` were the _same file_, which keeps feeding both layers
  exactly as before (the entry directory is a workspace scope of its own), so nothing left
  the merged result (the sibling `user settings key "permissions" ignored` claim was
  backwards too, since `permissions` takes effect through that very project layer). The
  warning text is now suppressed when the two paths name one file — including when `$HOME`
  is reached through a symlink — and repeated identical facts are deduplicated on the
  default sink, keyed by a per-file change signal so an edit re-arms them. The allowlist
  filter still discards the same keys, and an injected warning channel still receives every
  message. Merge output is byte-identical in all cases. ADR-0084 amendment.

- **TUI streaming-silence notice is cleared by resumed streaming; default silence threshold raised to 60s (2026-09-22)**:
  the "waiting for model output" box was cleared only by `tool_call_start`, so on a
  route where a large `tool_use` input arrives as a single delta after 65–174s of
  zero stream events it stayed on screen long after streaming had resumed,
  asserting something false — and at the old 20s default it fired routinely on
  normal model-phase silence. The waiting copy is now cleared by **any** resumed
  stream event, through the silence-timer re-arm ahead of `onStream`'s per-type
  branches, so a `transport_retry` event's own notice in the same call is not
  erased; notices from other sources (stop_summary / transport_retry / abnormal
  stop) still survive by identity, and the turn-end clear stays for the case where
  nothing resumes. The default threshold moved 20_000ms → 60_000ms (still
  host-injectable) and the copy no longer embeds a duration, since any number
  there can contradict the configured value. Sticky discipline is unchanged — the
  box still has no TTL auto-dismiss. Spec: `specs/transport-continue-persist.md`
  invariant 3 / SC6–SC7; glossary: `docs/CONTEXT.md` (sticky notice).

- **TUI silence notice no longer misfires during tool execution; copy moved to English (2026-09-17)**:
  the "~20s with no new stream bytes" waiting notice reset only on stream events,
  but the harness deliberately emits none while a tool runs (long bash commands,
  foreground subagents, permission/ask dialogs) — any tool past 20s triggered a
  bogus "still waiting for model output — check your network" message. A
  tool-phase gate now treats the window from `tool_call_start` to the next
  model-call boundary as tool phase, where an expiring timer simply rearms
  (a genuine model-phase silence still warns). The gate keys on event semantics,
  not display state, because permission-blocked calls never post the after-hook
  and display state would stall the round as running. Also fixed: a successful
  finish now clears any still-displayed waiting text (previously only transport
  retry progress was cleared, leaving a stale network hint on screen). Copy is
  English, aligned with the sticky-notice convention in `docs/CONTEXT.md`.
  Invariants 3 / acceptance criteria 6–7 of `specs/transport-continue-persist.md`;
  a pure phase-predicate plus regression cases pin load-bearingness. Test-side:
  the fake bridge became release-latch driven (timing controlled explicitly, not
  by fixed observation windows) — the root cause of this file's earlier flakiness.

- **CLI worktree isolation assembly seam passed `name` through again (2026-09-04)**:
  an inline CLI wrapper hand-destructured the provision context and silently
  dropped `name` (and any future field), so the CLI entry degraded to UUID-only
  worktree leaves while compilation stayed green and no runtime signal appeared.
  A host factory now forwards the whole context; a regression test with a real
  session store, a temp git repo, and fresh conversation ids covers both the
  labeled leaf and the UUID-only fallback, mirroring the hub-side behavior that
  was already correct. Stale tests whose assumptions expired with the hub-side
  change were re-grounded on derived-from-SSOT counts and current contracts.

- **Search output integrity (2026-08-27)**: an unparseable continuation line in
  skill frontmatter no longer discards the whole skill — the line is skipped and
  valid fields such as `disable-model-invocation` are kept. `tool_search` /
  `skill_search` trim the query, so blank queries no longer dump full results.
  `tool_search` gained an optional schema-validated `limit` (default cap 20) and
  a whole-line output budget, appending narrowing guidance instead of leaking
  `truncated` / `total` meta fields.

- **`spawn_subagent` foreground wait no longer cuts subagents short (2026-08-23)**:
  the wait path had carried a 30-minute tier while the tool description claimed a
  5-minute default, both shorter than the manager's 2-hour per-task budget, so an
  ACI abort turned real tasks into cancelled ones. The wait is now unbounded at
  the executor (lifetime belongs to the per-task clock), the description says 2
  hours, and the wait-timeout error dispatches by buffer state (not_found throws,
  running returns a timeout envelope, already-failed buffers pass through).

- **LLM defaults raised to coding-agent standard ceilings (2026-08-21)**:
  `maxOutputTokens` 16384 → 32000 (billed for actual generation) and `timeoutMs`
  60s → 300s (thinking + long tool_use turns compete per call). No per-task
  ratcheting. MCP `connectTimeoutMs` stays 60s.

- **`maxOutputTokens` default raised 8192 → 16384 (2026-08-21)**: `thinking:
"adaptive"` plus a self-contained multi-hundred-line HTML `write_file` payload
  exceeded 8192 and was truncated with the tool call left without `content`. The
  fallback now fits the thinking budget plus a complete document; doc examples
  synced. `timeoutMs` and the loop-engine truncation semantics unchanged. The
  earlier 2048 → 8192 step remains logged below.

- **TUI live tail no longer renders failed tool rows without a start (2026-08-21)**:
  when `max_tokens` truncation left a `write_file` call without `content` and no
  matching start event, the live reducer used to append a ghost `failed` row;
  unmatched post-tool events are now ignored live (the completed turn still shows
  it in history).

- **`maxOutputTokens` default raised 2048 → 8192 (2026-08-17)**: a trace showed a
  user task truncated at `stop_reason=max_tokens` (2047 output tokens at the 2048
  cap) folding into a non-success stop and surfacing as an error with zero output.
  Root cause: the 2048 default collides inevitably with `thinking: "adaptive"`
  (thinking tokens count against the output budget) on long generations. Config
  fallback raised (fits a thinking budget + full response without inflating cost);
  env-example and quickstart values synced, new default locked by tests. The
  truncation → non-success-stop contract in the loop engine was deliberately left
  intact.

### Web MVP prototype → CLI integration (iknow-prototype, 2026-07)

- Prototype `/api/chat` mock removed; the frontend now consumes the real Session
  HTTP API (`iknow serve`).
- Typed Session API client with error envelope and graceful degrade.
- Non-streaming chat hook (the API returns one full answer envelope per turn):
  lazy session, host-side fake typewriter, abort/reset/commands; shared via a
  chat provider.
- Machine panel: governance-status badge, snapshot id, tool-call trajectory,
  cited source spans, hops, notes — replacing the demo card.
- Caller role (employee|manager|admin) + mode (deterministic|llm) wired to the
  live session's commands endpoint.
- Same-origin proxy to the local API target, or a public base-URL override to
  call a backend directly.
- Mock-only dependencies removed (`ai` / `@ai-sdk/react` / `zod`).
- E2E rewritten against real `iknow serve` (Playwright dual webServer): six specs
  green.
- Typecheck / lint / static-export build / e2e all verified green.
- Unchanged / not claimed: the Session API contract, the 4-tool protocol, and the
  existing Vite `web/` SPA; the prototype was not yet the shipped UI path.

### Web MVP prototype (iknow-prototype, standalone, 2026-07)

- New `iknow-prototype/`: Next.js 15.5 + React 19 App Router MVP, TypeScript
  strict.
- Stack: Vercel AI SDK (streaming + tool-call rendering), Tailwind 3.4 +
  shadcn-style button, Zustand + TanStack Query, Framer Motion, Lucide,
  react-markdown + rehype-highlight.
- Design: light base, ≤5-color palette, no emoji.
- Key-free mock backend: a deterministic streaming model plus one demo tool call;
  no real LLM/auth.
- E2E: Playwright six specs using the installed Chrome channel.
- Typecheck / lint / build / e2e all green.
- Unchanged / not claimed: existing `web/` SPA, Session API contract, tool
  protocol; not yet wired to the CLI backend.

### LLM client resilience (2026-07)

- Full deterministic / embeddings / llm CLI + Session HTTP interaction smoke.
- LLM client forces `stream: false`; response parsing tolerates SSE
  `data: [DONE]` trailers.

### Frontend stack upgrade — Vite + React + TS (2026-07)

- Product UI package under `web/`: Vite 6 + React 19 + TypeScript SPA.
- Build output `web/dist`; `iknow serve` prefers dist, falling back to `web/`.
- Design tokens ("forest cockpit"); the API client mirrors Session API DTOs.
- Dev workflow via a proxy to the local serve; prod via build + serve.
- Unchanged / not claimed: Session API contract; SSE still 501; no production
  auth.

### Session HTTP API + Web UI (2026-07)

- `iknow serve`: in-process Session API plus SPA static host (`web/dist`
  preferred).
- Routes: health, sessions create/list, messages, commands, reset.
- Every message returns the full answer envelope; human projection optional.
- Reserved: the per-session events route replies 501 (SSE future).

### Product CLI chat (2026-07)

- TTY REPL plus pipe-aware serial turns.
- Conversation state with prior-chunk bridging and slash commands
  (`/status` `/mode` `/role` …).
- Human view is the default in chat; `ask` / oneshot stay machine JSON for
  scripts.
- Explicit `--mode` wins over the env var; an empty ask prints usage (no demo
  query).
- SIGINT: first warns, second exits immediately (status 130).

### Model wiring (2026-07)

- Embedding vector arm (OpenAI-compatible) plus an optional LLM tool agent.
- Fail-closed offline / key / protocol checks; the deterministic path remains the
  CI default.

### Trajectory eval harness (2026-07)

- `npm run eval`: full 32-sample trajectory suite.
- Structured `tool_calls` on every answer.
- Hard gates plus a sprint-1 soft target on mean trajectory score.
- Result artifacts gitignored.

### P3 scaffold (2026-07)

Standalone enterprise KB agent (no external runtime dependency):

- Four tools: `kb_retrieve`, `kb_verify_citation`, `kb_compile`,
  `kb_governance` (later retired; see Breaking).
- Hop-bounded agent loop with an envelope response.
- In-memory knowledge store with fixture seed for demos/eval.
- Unit + eval-set + trajectory tests under `npm test`.

### Review hardening (trajectory OCR + staged reviews)

- Shared lexicon module plus a policy-string scorer in the eval layer.
- Data-driven `session_overrides` on eval samples; resilient suite runner.
- `ToolCallLog.ordinal`; release gates; draft eval-set warning.
- Store / compile / loop root-cause fixes from the prior staged review.

### Ops

- Remote: `https://github.com/winter6205/iknow` (`master` tracks
  `origin/master`).

### Initial scaffold

Bootstrap scaffold from the project template: an idempotent bootstrap script, a
default fast-tier evaluation runner, a tier-grouped eval framework, and a
three-layer memory model.
