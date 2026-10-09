# 0071. Consolidate session records into one conversation folder; content-address trace bodies

Date: 2026-09-08
Status: accepted

> **Scoped extension (2026-10-03, ADR-0136):** Decision 3's body-pool scope extends to native recovery and trace-permitted represented bodies for new-format persistent sessions under [ADR-0136](0136-native-session-checkpoint-architecture.md). Identical represented content remains immutable and session-local; raw recovery and masked trace retain separate consumer/failure contracts. Trace readers must follow trace-permitted references, not expose all bodies in the shared pool. Raw per-write `code-snapshots/` remain separate. Other decisions continue to apply; implementation is pending.

> **Amendment 2026-09-13** (ADR-0088): Decision 2 — "the background-task registry stays at `stateAnchor` / workspace `.iknow/tasks`" — is **superseded**. The registry still does not enter the conversation-folder leaf, but it lands in the sibling `tasks/` directory of the same home project tree. The retirement of the legacy `sessions/` layout still follows Decision 7 (no automatic migration).
>
> **Amendment 2026-09-13** (ADR-0087): the session pool root is `home/.iknow` (or an explicit `dataDir`), not `<workspaceRoot>/.iknow`. The path literals in Decision 1 remain valid as written; an earlier implementation bound `baseDir` to the workspace shard, conflicting with this ADR, and is hereby retracted.

## Context

One conversation's record surface is scattered across **five anchors** keyed by the same `conversationId` yet sharing no location (measured 2026-09-08):

| State                    | Anchor                                                                                              | Source                               |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------ |
| session transcript       | `<dataDir>/sessions/<basename(cwd)>-<sha1[:12]>/`                                                   | `session-store.ts:107-110`           |
| todos                    | `~/.iknow/todos/<surface>/<conversationId>/todos.md`                                                | `todo-write.ts:450-456`              |
| background-task registry | `<stateAnchor>/.iknow/tasks` (now `<pool>/projects/<slug>/tasks`, per the ADR-0088 amendment above) | `build-engine.ts:667`(ADR-0021 D1.3) |
| trace                    | `./trace/<conversationId>.jsonl`(**relative to cwd**)                                               | `cli.ts:77`                          |
| worktrees                | `<repoRoot>/.iknow/worktrees/<leaf>`                                                                | `worktree-gate.ts:548-556`           |

Three defects were measured:

1. **The grouping key is misnamed.** The comment on `resolveProjectSessionDir` claims a "Project namespace", but the actual key is `basename(cwd)`. As cwd moves with worktree rebinds, **one project's conversations are split across N sibling folders**. Of the 127 directories on disk under `~/.iknow/sessions/`, `126-hook-system-3d7759ffa337`, `128-verify-loop-86751ccd061c`, `321-tui-opentui-migration-9d0906d38c93`, `653-hygiene-7dbf90da9ee6` and `820-75d95286e7ef` are all different worktrees of the same project.
2. **Subagents are flattened**: 7 of the 127 directories are `agent-*`, siblings of project directories — the parent/child relationship is lost on the filesystem, and `listSessions` lists subagents as peer conversations.
3. **The O(n²) trace double-write was never fixed.** ADR-0036 measured "of 263.5MB, **98.2% (226.5MB) is byte-for-byte duplication of the fully accumulated message history inlined in `llm_call` rows**, single row up to 891KB". The solution was implemented and tested but **shipped opt-in and default-off — `blobs/` still does not exist**. For one conversation: trace 41 rows / 264K vs transcript 88 rows / 72K — **half the rows, 3.7x the bytes**. Repo-wide: trace 337M vs transcript 12M.

## Decision

**1. Introduce the conversation folder: grouping key = `projectIdentityRoot`, leaf = `conversationId`.**

```
~/.iknow/projects/<basename(root)>-<sha1(root)[:12]>/<conversationId>/
    <conversationId>.jsonl + .json    session transcript(ADR-0027,形状不变)
    todos.md
    trace.jsonl
    blobs/<sha256>
    subagents/agent-<id>.jsonl + .meta.json
    tool-results/
```

The key is `projectIdentityRoot` rather than cwd because it is "pinned once at host startup and unchanged across session worktree rebinds" (`docs/CONTEXT.md`) — exactly the semantics grouping needs. The leaf is the raw conversationId, **no** label is introduced: conversations have no naming entrypoint, and the _Avoid_ clause of `task worktree label` explicitly forbids using a session `title` / `goal` as the slug. The presentation surface is carried by the parent project slug and the `title` field inside the records.

**2. The criterion is "record vs live locked state", not "per-conversation or not".**

Append-only records (transcript / todos / trace / blobs / subagent records) go into the conversation folder; **live state carrying locks does not enter the leaf** — the background-task registry lands in the sibling `tasks/` directory of the same home project tree (ADR-0088 / ADR-0021 D1.3), so it remains visible after a rebind and the tree does not open a second registry (ADR-0037 §4); worktrees stay at `repoRoot`. Lifetimes and access patterns differ: records live and die with the conversation; live state must survive rebinds.

**3. Blob dedup moves from opt-in to the only mode; the dedup granularity moves from the whole message to `content`.**

The ADR-0036 design replaced the **whole message** with `{sha, bytes}`, dropping `role` along with it. Instead, keep the envelope:

```jsonc
{ "role": "user", "content": { "sha": "a3f…", "bytes": 1842 } }
```

Rationale: the read side `query_trace` consumes raw rows directly (`query-trace-core.ts:225-244`), and `messageRole()` (`project-tool-results.ts:48-51`) returns undefined for `{sha,bytes}` → **`last_assistant_preview` silently disappears**, while the comment at `:235-238` explicitly states "field absent = legal state (no assistant message)" → **the fault becomes indistinguishable from the legal empty state**; `first/last_message_preview` render dead previews like `{"sha":…}`. And `last_assistant_preview` is precisely what `:230-232` calls "the path for external agents to take the final assistant conclusion". Keeping `role` inline means `messageRole()` needs **zero changes**; the read side only needs to dereference content at the one preview site (reusing the existing `dereferenceTraceMessages`).

The dedup payoff is unchanged: the duplicated part is the body; the few bytes of `role` are immaterial. `IKNOW_TRACE_MESSAGES` / `MessageStorageMode` / `resolveMessageStorageMode` are retired.

**4. `blobs/` lives inside the conversation folder; lifetime = conversation.**

This closes the one item ADR-0036 left undone: "`blobs/` needs a reclamation policy (rotation orphan rules, to be detailed in the plan)". Inside the conversation folder, reclamation degrades to "delete the folder" — no reference counting, no global GC; and there can be no orphan state where the transcript is still there but its blobs were rotated away. A side simplification: `traceDir` is derivable from `dirname(traceFilePath)`, killing the error-prone parameter pair behind the `options.traceDir!` non-null assertion at `project-tool-results.ts:161`.

**5. Delete the failure fallback, but do not touch the exception contract.**

When blobs cannot be written, **never fall back to writing an inline full row** (explicit operator requirement). But the throw is pinned to the **inner blob IO**: it is swallowed by the existing `safeTrace` / recordFailure warn-once → `recordLlmCall` returns `undefined` → that call lands zero rows → the turn survives; per ADR-0003 **D14**, the downstream `recordToolCall` still lands with `parent_llm_call_id: null`. **ADR-0003 D13 (`recordXxx` MUST NOT throw) is inherited as-is, not amended.**

**6. New invariant: trace must not reference the session transcript to rebuild `messages`.**

The two are **deliberately not equal** in semantics: trace's `messages` is "what the model actually saw" (including `<agent_status>` tail injections, worker prior messages, post-compaction summary views, mask forms), while the transcript is "the durable session record" (an incremental event chain). Measured on one conversation: `agent_status` appears 14 times in trace vs 11 in transcript; the trace role sequence shows consecutive `user | user` — traces of injection.

Deriving "the cumulative array for call N" from an incremental event stream **is a re-computation, not a lookup** — it would replay compaction, replay injection, replay masking. Re-computation drifts, and one drift violates ADR-0036's "what was seen is what is recorded". **Wasted bytes are waste; wrong semantics is lying** — hence rejected.

**7. No compatibility with legacy state.**

The 127 conversation directories are not migrated, `--resume` fails for old conversations, and the TUI session list starts empty. The 337MB `trace/` at the repo root is archived to `~/.iknow/archive/trace-legacy/` (**not into the repo's `archive/`** — measured: `archive/` is not gitignored, only `_archive/` and `/trace/` are, so 337MB carries a mis-commit risk).

## Why not

**Why not let trace reference the transcript's bodies (removing the cross-file double-write)**: see Decision 6 — re-computation is not a lookup and will drift. The residual cross-file duplication is bounded by 12M (the transcript's repo-wide size), and the price would be staking the forensic semantics of "what the model actually saw" on the false premise that two records are always identical.

**Why not keep the blob opt-in switch**: nine days after acceptance, `blobs/` still did not exist and the 337MB sat unchanged — **a default-off switch is equivalent to no feature**. The real reason it dared default off was the silent failure identified in Decision 3 (turning it on breaks the MCP main discovery path), and ADR-0036 recorded only one cost, "bodies can no longer be grepped", **missing that one**. With the granularity fixed, the reason disappears.

**Why not positional pointers (referring to the first occurrence's `(llm_call_id, index)` in the same trace file)**: it requires maintaining a first-occurrence index — more complex than sha with zero payoff, since sha + `flag:"wx"` write-if-missing already stores exactly one physical copy.

**Why not fold the background-task registry into the conversation folder either**: it is per-root live state; ADR-0037 §4 explicitly requires visibility across rebinds. Folding it in would break that, and would reopen the question of reaping orphaned subprocesses (`build-engine.ts:1628` — the shutdown only runs in the main loop).

**Why not name conversation folders with a worktree label**: conversations have no label entrypoint; using `title` instead directly violates the _Avoid_ clause of `task worktree label`. A UUID also avoids sanitization, collision, and the three rules around "fail if the same name exists".

## Consequences

**Positive / Applied:**

- Five anchors → two (conversation folder + root-anchored live state); one conversationId no longer lands under two different roots.
- Trace moves from cwd-relative to conversation-anchored: starting the same conversation from the main repo or a worktree lands the trace in the same file; 337MB no longer hangs off the repo root.
- Size: at the 7x ratio measured in ADR-0036, 348M → about 62M (**−82%**).
- Subagent lineage is visible on the filesystem (`subagents/` nesting); the machine-wide aggregation of `createTrace("subagent")` is retired.
- The `<surface>` layer disappears; todos no longer split by entry point.

**Negative / Trade-offs:**

- **ADR-0003 greppability narrows**: message bodies can no longer be grepped inline in JSONL rows (reachable by sha; the event rows / `tool_call` arguments / `status` / `error` dimensions are unchanged).
- **ADR-0035's "unconditional surface" gains a precondition**: trace crash-forensics integrity is now **predicated on `blobs/` being writable**; while the directory is unwritable, that `llm_call` does not land at all (silently, per D13). Operator-approved.
- **Read-side addressing contract changes**: the three traceserver tools move from the flat `<traceDir>/<conversationId>.jsonl` (`query-trace-core.ts:86`, `get-record-core.ts:112`) to walking the two-level tree; the `list_sessions` scan cost is unmeasured (keeping the "read only the first 64 KiB" window; trigger to revisit: a single scan over 1s introduces an index file).
- **`dist/trace-mcp` must be rebuilt**: `scripts/iknow-trace-mcp.cjs:6-12` spawns the build artifact; without a rebuild after source changes, MCP sees nothing.
- All old conversations become invalid (Decision 7).

## Evidence pointers

- On-disk measurements (2026-09-08): `~/.iknow/sessions/` 127 directories / 7 `agent-*`; `~/projects/iknow/trace/` 337M / 82 jsonl; `~/.iknow/sessions/` 12M; one conversation: trace 41 rows 264K vs transcript 88 rows 72K; `agent_status` trace 14 / transcript 11
- Reference shape: `~/.claude/projects/<slug>/<conversationId>/{tool-results/,subagents/}` + `~/.claude/tasks/<conversationId>/` (measured on disk; `tasks/` sampling: all 8 uuids hit `projects/*/<uuid>`, confirming the conversationId key). The openharness part (`get_project_session_dir` / `read_task_output(task_id, max_bytes=12000)` → "Return the tail of a task's output file") comes from docstrings in the `~/.cache/codebase-memory-mcp/…upstream-openharness.db` index — a **lower evidence tier than reading the source** (the source has been cleared from `.reference/`). Both halves are design references; neither has been checked against upstream source.
- **Mis-citation correction**: ADR-0036 traced "what was seen is what is recorded" back to "ADR-0014 acceptance discipline", but `0014-subagent-foreground-spawn-default.md` is actually about "subagent spawn semantics" and does not contain the phrase anywhere; repo-wide the phrase **appears only in ADR-0036's own text**. ADR-0014 `:46` merely treats trace as acceptance ground truth. All such tracing in this ADR and the CONTEXT entry points at ADR-0036.
