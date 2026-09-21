# 0021. background task lifecycle: iknow process as the single physical anchor + on-disk registry + stale sweep at startup

Date: 2026-08-18
Status: accepted

> **Amendment 2026-09-13** (ADR-0088): the on-disk namespace anchor moved from `workspaceRoot` to the **home project tree**. D1.3 path = `<dataDir or ~/.iknow>/projects/<slug>/tasks/<task_id>.{json,log}`, slug key = `projectIdentityRoot`. `--workspace-root` no longer separates task registries. The physical process anchor, the conversation visibility anchor, the stale sweep, and the task_id format are unchanged. The registry still does **not** enter the session-folder leaf.

## Context

The bash tool needs to support the "start a long-running service → verify → stop" loop, which requires three capabilities: background execution (return a task_id immediately after spawn), log readback (bash_output), and a termination handle (bash_stop). Key premise: **iknow has no conversation-teardown event** — a repo-wide src search for `removeSession` / `deleteSession` / `closeSession` returned zero hits (measured 2026-08-18); only `registerShutdown` (`src/cli/runtime.ts:172-218`) runs a single layer of cleanup at process exit. Therefore the lifecycle anchor can only be chosen from the existing event surface. The resolution comes from the grilling decisions (D1-D6); this document finalizes the unlocked details (task_id format) in that resolution's direction and gives the three-condition argument.

## Decision

The background task lifecycle is anchored three ways, one segment each, where the **physical anchor = the iknow process**:

- **conversation = visibility + operation-rights anchor**: conversationId serves only as a bookkeeping field and an input filter for bash_output / bash_stop (the `task_not_in_scope` rejection bounds cross-conversation read/stop), and **takes no part in the kill anchor** — there is no teardown event to hook (zero search hits), and no mechanism is invented for consumers that do not exist.
- **iknow process = physical boundary anchor**: before exit, reap all running children + bwrap `--die-with-parent` as backstop for the host being force-killed (SIGKILL).
- **home project tree = on-disk namespace anchor** (ADR-0088; the original workspace root is **superseded**): the registry lives at `<dataDir or ~/.iknow>/projects/<slug>/tasks/`, the same slug as session records. "`--workspace-root` mutual invisibility" **no longer** applies to tasks.

Key sub-decisions:

- **D1.1 Reap before exit (mirror subagent)**: `registerShutdown` (`src/cli/runtime.ts:172-218`) → manager.shutdown() replicates the `src/harness/subagent/manager.ts:479` shutdown chain: clear timers / killFallback → abort in-flight → SIGTERM all running children → wait ≤5s for exit (`SHUTDOWN_SIGKILL_GRACE_MS = 5000`) → SIGKILL as backstop.
- **D1.2 Keep bwrap `--die-with-parent`**: the kernel unconditionally delivers the death signal when the parent dies, including when the host is SIGKILLed — it is not in conflict with background (detached process group, independent lifecycle) but is the correct anti-leak semantics. A background task must survive the sandbox runner's return, and must die with the iknow process; the two layers are carried by different mechanisms.
- **D1.3 Two-layer registry**: in-memory Map (child/pgid/status live handles, valid only within the process) + on-disk `<dataDir or ~/.iknow>/projects/<slug>/tasks/<task_id>.{json,log}` (ADR-0088). The json records owner_pid + conversationId. Path derivation uses the same `(baseDir, projectIdentityRoot)` formula as the session pool, no longer mirroring the memory workspace-root precedent.
- **D1.4 conversationId is pure bookkeeping**: not part of the kill anchor; visibility scope (bash_output / bash_stop filtered by conversationId) is an independent axis — this ADR only declares the final three-anchor division of labor (see the opening paragraph of the Decision).
- **D1.5 Stale sweep at startup**: scan tasks/ at boot, act only on records whose owner_pid is dead (a live owner = a live task of another iknow process, skip): kill the process group + mark dead + log hygiene. No file locks — single writer (each iknow process writes only its own task files) + idempotent sweep (compare `/proc/<pid>/stat` starttime against the registry record; on mismatch only mark dead without acting — mistakenly killing a pgid already recycled by the kernel is an unacceptable failure).
- **D1.6 Governance values finalized (cites that resolution's D6; this is the SSOT)**: concurrency cap **8**; at the cap, refuse in positive wording (state the current situation + available actions, no prohibitive phrasing); log reads return the tail only to prevent context blowup: default **12KB**, cap **100KB** (the semantics of bash_output's max_bytes parameter).
- **D1.7 task_id format finalized (previously open, finalized here)**: `bg-` prefix + 12 random hex characters (`crypto.randomBytes(6).toString("hex")`, equivalent to randomUUID). Rationale: a short prefix aids recognition in logs / ask hints; 12 hex = 48 bits of entropy, collision probability negligible; no auto-increment, no leaked counter; filename-safe (no path separators / dot issues), search-friendly, one-to-one with bash_stop / bash_output inputs.
- **D1.8 bash_stop handle semantics**: host-side `kill(-pgid)`, SIGTERM → 2s → SIGKILL (reuses the `src/harness/sandbox/runner.ts:121-129` stopTree pattern); never hand the model a bare pid — the pid namespace inside the sandbox differs from the host, and task_id is the only clean handle.
- **D1.9 Out of scope (into fog / tracked separately)**: conversation lifecycle v2 (createdAt/archivedAt schema, archive, session events, busy/idle, SSE seams) — tracked as its own grilling issue, the implementation ticket only reserves an `onConversationDeleted(conversationId)` subscription seam; service-completion notification mechanism (the model polls with bash_output, observe first); egress-side secret auditing.

## Three-Condition Argument

- **hard-to-reverse**: the registry's on-disk shape + the task_id external contract (bash_output / bash_stop inputs) become hard to migrate once real tasks exist — a format change touches the existing `<task_id>.json/log` files and model-side tool calls; the lifecycle-anchor choice determines orphan-process cleanup semantics, and switching anchors afterwards either leaks orphans or kills someone else's process.
- **surprising-without-context**: three "every newcomer trips" points — why no conversation-teardown reap (no teardown event to hook; no mechanisms invented without consumers; the answer is one search away); why keep `--die-with-parent` (it looks like it conflicts with long-running services but is in fact the correct anti-leak semantics, background independence being carried by the detached process group); why the stale sweep only touches records whose owner is dead (with multiple iknow processes coexisting, killing another's live task is an unacceptable incident).
- **real-trade-off**: three-way lifecycle-anchor choice — "three-anchor division (conversation = visibility / iknow process = physical boundary / workspace root = namespace)" vs single conversation anchor (no event to hook, rejected outright) vs fully on-disk self-governance (outside the process boundary you cannot guarantee a clean pre-exit sweep while the host lives); file locks vs single writer + idempotent sweep (locks introduce cross-process coupling and a deadlock surface; the idempotent sweep buys equivalent safety with the starttime comparison); starttime verification vs trusting pgid (trusting pgid kills the wrong process under PID recycling).

## Consequences

- The bash tool gains a third form: a `background: true` task is no longer harvested by the sandbox runner's tier timer; survival semantics transfer to the two layers of manager + bwrap `--die-with-parent`.
- The iknow process must guarantee a complete exit path: `registerShutdown` is the only exit; the existing shutdown chains of serve / chat stay unchanged, manager.shutdown hooks in by mirroring.
- Multiple iknow processes sharing one `projects/<slug>/tasks/` do not interfere: each writes its own files, and the sweep only touches records whose owner is dead.
- Governance values (concurrency 8 / log 12KB default 100KB cap / task_id format) are pinned in this ADR from now on; implementation and CLI docs reference this document, none hard-coded in plans.
- Implementation provides evidence across 5 commits, one logical task each: manager + on-disk registry + state machine → bash background e2e → bash_output / bash_stop + assembly → conversation scope + concurrency cap → exit reap + startup sweep + onConversationDeleted seam.

## Evidence

- Grilling resolution (D1-D6 + post-close revision comment); architecture-change-reviewer PASS (2026-08-18, 5/5 yes, recorded in the bash-service-loop plan).
- Premise assertions (zero search hits for conversation-teardown events; source locations of the registerShutdown / shutdown / stopTree / fs-policy anchors) confirmed by measurement against the then-current HEAD on 2026-08-18.
- ACR 5-dimension PASS (bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier).
