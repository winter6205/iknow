# 0040. Subagent identity and capability-based dispatch gate

Date: 2026-08-31

Status: accepted

> This ADR supplements and narrows the subagent clause of ADR-0037 §2. ADR-0037
> keeps governing the worktree isolation mode's switch, creation, rebind, and failure
> semantics; for subagent root ownership, the dual conversationId, and the dispatch
> gate, this ADR prevails.

## Context

This verification pass confirmed that ADR-0037 §2 already states "a subagent spawns from the parent session, follows the same tree after the parent's rebind, and does not trigger a second tree" (`docs/adr/0037-worktree-isolation-on-mutate.md:27-29`); `docs/CONTEXT.md` likewise already says a subagent spawned after the parent session rebinds inherits that root without building a new tree (`docs/CONTEXT.md:350`). So this is not defining worktree inheritance from scratch — it writes out, as a standalone contract, the identity, session-identifier, and gate boundaries that sentence left unexpanded.

Existing terminology already separates the declared tool surface from the worker's actually-assembled tool surface and requires the two to be equal (`docs/CONTEXT.md:98`). With the isolation switch ON, gating by `subagent_type` role name alone would let catalog growth or custom roles detach real write capability from the gate's verdict; treating every subagent as an independent isolation unit would break the parent session's unified orchestration of one task worktree.

## Decision

### 1. Subagent identity and root ownership

A subagent's identity = **an execution arm of the parent session**, not a parallel session with its own workspace. It shares the parent's task worktree and inherits the root currently in effect for the parent:

- If the parent session has already rebound to a task worktree, the subagent uses that same task worktree; no second tree is created.
- If the parent has not rebound yet, a subagent that satisfies the read-only gate may stay in the main checkout and do read-only work; this still grants it no independent root and does not change the parent's later rebind ownership.
- Whether a subagent's write capability triggers the parent session's existing worktree gate is decided in section 3 by the effective tool surface; once the gate fires, the subagent follows the parent through the rebind and never owns a separate tree.

### 2. Dual `conversationId` identity

A single subagent invocation carries two layers of identity at once; one ID must not stand in for both:

- The **manager layer** uses the parent session's `conversationId`. It records who dispatched the worker and serves that parent's mailbox, host drain, wake, and result attribution.
- The **worker / LoopEngine layer** uses the worker's own `conversationId`. It is the subagent's own execution identity for trace, run state, and turns, keeping different workers' run records from colliding.

So the parent ID owns parent-side routing and attribution, and the worker ID owns child-side execution and observation; this division does not change between foreground and background spawn.

### 3. Dispatch gate: derived from effective tool-surface capability

The criterion derives from **effective tool-surface capability**, **never from role-name matching**. A subagent may stay read-only in the main checkout only if both dimensions hold:

1. the effective tool surface contains neither `write_file` nor `edit_file`;
2. the effective tool surface contains no `bash`, or that role has `bashMode === "readonly"`.

If either dimension fails, the subagent is classified as writing: with isolation ON and the parent still in the main checkout, the existing ADR-0037 gate intercepts and drives the task-worktree creation/rebind flow; with isolation OFF, existing off-mode behavior holds. The verdict must retain both the conclusion and the failing dimension, for the gate message and diagnostics.

`bashMode` is taken solely from the role catalog definition; the parent's `disallowedTools` cannot turn `bashMode: "any"` into `"readonly"`. Unknown roles fail closed with the conservative `bashMode` of `"any"`, hence are classified as writing and intercepted.

## Rejected alternatives

### (a) One independent worktree per subagent

Rejected. A subagent is the parent's execution arm, not an independent task owner; a separate worktree would split one task's writes across multiple trees, leaving the parent's task worktree, result paths, and subsequent tool calls without single ownership, and would additionally require new protocols for merge, reclamation, and permission grants. ADR-0037 already forbids subagents triggering a second tree; this ADR pins down that rule's identity implications.

### (b) All subagents read-only when isolation is ON

Rejected. That would leave legitimate implementation subagents unable to do the work the parent delegated, forcing the parent to reimplement it or spend extra shuttling turns — defeating the point of dispatch. Read-only capability is admitted by the effective tool surface; genuinely writable roles are intercepted by section 3 so the parent completes its existing rebind, rather than blanket-demoting every role to read-only.

## Consequences

### Positive

- Parent and subagent share one clearly-owned task worktree; no implicit second tree.
- Parent-side mailbox/drain/wake and child-side LoopEngine trace each have a stable ID; result routing and run observation do not pollute each other.
- As the catalog grows roles or tools, the gate still works off actual capability; unknown roles fail closed, so a role-name allowlist can never leak write capability.

### Negative / Trade-offs

- One spawn must maintain both a parent routing ID and a worker execution ID; diagnostics and trace queries must state the layer explicitly.
- Under isolation ON, a writable subagent's first dispatch may trigger the parent's worktree gate and then be redispatched on the new root; read-only subagents can stay in the main checkout directly.
- The effective tool surface must be computed from the same source the worker assembly uses, or drift between declared and actual surfaces would change gate verdicts.

## Reversibility

Allowing subagents their own worktrees in the future requires a new ADR spelling out result merge, permission grants, lifecycle, and the parent-visible path protocol; this ADR's shared-root semantics must not be silently turned into one-tree-per-subagent. Any change to the role tool-surface model must also update the two-dimension criterion and the fail-closed rule.

## Evidence

- `docs/adr/0037-worktree-isolation-on-mutate.md:27-29`: existing ADR-0037 §2 already defines the subagent inheriting the parent's rebound tree and not triggering a second tree.
- `docs/CONTEXT.md:98`: existing "declared vs actual tool surface" terminology.
- `docs/CONTEXT.md:344`: the `session worktree rebind` term already states that subagents spawned after the parent rebinds inherit that root.
- `src/harness/subagent/spawn-subagent-tool.ts:277-281`: spawn writes the parent session's `conversationId` from the current context into the subagent definition.
- `src/harness/subagent/worker.ts:415-419`: the worker's trace assembly uses its own freshly generated `conversationId`.
