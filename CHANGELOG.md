# Changelog

All notable changes to this project are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This changelog
is a curated snapshot; the complete development history lives in the git log.

## 0.1.0 (unreleased)

### Breaking

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

- **`.json` compatibility double-write mirrors dropped (2026-08-23)**: session save
  and head-move persistence no longer write `<id>.json` mirror files — the
  single-file JSONL is the only history format. `load()` keeps a `.json` fallback
  during the migration window, `delete()` still sweeps both paths, and `list()`
  still de-duplicates across both extensions until the legacy-only sessions
  migration script runs. Mirror-contract tests removed or updated; readers migrated
  to JSONL head records or the store API. Related ADR-0027 synced.

### Fixed

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
