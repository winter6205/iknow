# 0101. Multiple spawns in one turn are parallel; the parent model stops workers via `subagent_stop`

Date: 2026-09-18
Status: accepted

Amends ADR-0014 (adds only the control plane; the `wait` default is unchanged). Does not change ADR-0040's dual `conversationId`.

## Context

ADR-0014 already set: omitting `wait` = foreground; background only via explicit `wait:false`. The tool comment and the description also said that multiple `spawn_subagent` calls in one round may run in parallel. What was missing: writing that up as a contract, and adding the symmetric surface of the parent model stopping workers.

Current state: `spawn_subagent` carries `isConcurrencySafe: true`, so multiple spawns in one assistant message enter the same wave and start workers concurrently. A cross-round `wait:true` binds the parent to the previous hop's terminal state, which looks like "one dispatch at a time" — that is the foreground contract, not a rendering or catalog fault. The operator already has Esc (all foreground in this session) and Ctrl+X (`abortTask` on the focused row). The parent model has no counterpart tool: the registry has `bash_stop`, no `subagent_stop`. The `task_id` on the handoff envelope already works for `subagent_result`, mailbox, tmp, and human-side abort. Post-terminal continuation is ADR-0102; this ADR does not rule on continuation lifetime.

## Decision

1. **The parallel product = N `spawn_subagent` calls in one assistant message.** Each call owns its `task_id`; with `wait:true` each handler blocks until its own worker reaches a terminal state, with concurrent launch inside the wave. Spawning again across rounds is blocked by the previous hop's foreground — that is the default contract; no "auto-flip to `wait:false`" is added to fake parallelism.
2. **The background arm remains an explicit option, not the definition of parallelism.** `wait:false` serves "the parent still has other work this round / be woken by the mailbox terminal state"; it does not replace same-turn multi-spawn.
3. **Parent-model worker stopping: new tool `subagent_stop`.** Its input is a `task_id` visible in this session; internally it takes the existing `abortTask` (the same process-kill path as Ctrl+X). Scope matches `bash_stop`: it stops only workers spawned by this session and rejects cross-session requests. Idempotent: already-terminal / not-found → a structured explanation, never a fabricated "task failed". The assembly condition is the same as `spawn_subagent` / `subagent_result` (a `subagentManager` must exist).
4. **What `task_id` means in this ADR.** The manager handle for one dispatch: lookup, mailbox, parent-visible envelope, tmp, human stop, `subagent_stop`. The worker's own `conversationId` still governs the worker-side trace / rounds per ADR-0040 and is not a parent tool input.
5. **Continuation is out of scope here.** Pushing another sentence after a terminal state: see ADR-0102. Injecting into a running loop is still not done.

## Why not

**Why not flip the default to `wait:false` and call that parallel:** ADR-0014 rejected this on 2026-09-18; same-turn foreground closure is still wanted.  
**Why not just lengthen the description until the model pre-empts with `wait:false` across rounds:** prose is not a gate; the real parallelism gate is the same-turn wave.  
**Why not let the parent model call `abortTask` or reuse `bash_stop`:** those are manager / bash process-group handles, not the subagent lifecycle.  
**Why not settle terminal-state continuation in this ADR:** continuation changes worker session lifetime, not stopping or same-turn launch; see ADR-0102.

## Consequences

- (+) Two cards showing "one finished, one still running" become a legitimate picture of two same-turn spawns; single-card serialization is mostly cross-round foreground, not the TUI dropping a card.
- (+) Parent model and operator stop workers through the same `task_id` / `abortTask` path.
- (−) Tool surface +1; must enter the registry append-only, and the trace must prove: two same-turn spawns start two workers; `subagent_stop` stops a running worker, is idempotent on terminal states, and rejects cross-session.
- (−) Until ADR-0102 lands, stop = process end; `task_id` still queries the archive but cannot wake the same worker again.

## Evidence

- `src/harness/subagent/spawn-subagent-tool.ts`: `isConcurrencySafe: true`; the file-header comment documents multiple spawns in one turn.
- `src/harness/aci/aci-executor.ts`: consecutive `isConcurrencySafe` calls run via `Promise.all` in the same wave.
- `src/harness/subagent/manager.ts`: `abortTask`; the TUI Ctrl+X / Esc fan-out is wired.
- `src/harness/aci/tools/registry.ts`: `bash_stop` present, `subagent_stop` absent.
- ADR-0014 Decision 3's original text already contains "issue multiple calls in one turn to parallelize".
