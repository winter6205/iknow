# 0070. Worktree occupancy lock: opt-in tier, zero new state, release by explicit exit

Date: 2026-09-08

Status: accepted

> Depends on the recoverability classification axis established the same day (new kind `worktree_claimed` enters the table).

## Context

`enter-task-worktree` today has four checks (caller in the main checkout / target exists / target is a linked checkout / same repository), and **not one of them is ownership**. So two live sessions can bind the same tree at once: interleaved edits, one shared git index, commits cutting in front of each other. ADR-0037 was justified precisely by "parallel sessions mutating each other's work", and this path has no gate.

Meanwhile the operator's daily use does not need this lock — allowing sharing most of the time (e.g. a new session taking over a tree a previous session kept, to continue the task) is exactly the wanted workflow. So the question is not "exclusivity or not" but "should exclusivity be the default".

One wrong direction already ruled out: treating the owner sidecar as an authorization credential. The sidecar's job is to **inform**, and `enter-task-worktree` deliberately does not consult it; making it a lock would also block the legitimate "new session continues on the old tree" workflow.

## Decision

### 1. Opt-in tier

New `isolation.worktreeExclusive` (boolean-only, **default OFF**), following the **same value-domain discipline** as `isolation.worktreeOnMutate`: missing or anything other than `true` means OFF (fail-closed); read once at the startup load point; the config layer does not read git and holds no session state; session-root rebind does not implicitly reload settings (ADR-0037 §5).

**OFF-tier behavior is byte-identical to today's** — the four checks unchanged, no new rejection path. Zero regression is this tier's acceptance criterion, not an implicit assumption.

### 2. Occupancy criterion: `workspaceRoot` of live session records

When ON, enter gains one pre-check: is the target tree occupied by **another live session**.

**Occupancy = among live session records, someone else's `workspaceRoot` points at this tree.** That is the only criterion.

Release is therefore automatic: a session exits normally via `exit-task-worktree` → its `workspaceRoot` rebinds to the main-checkout root → the occupancy disappears → others can enter. **No release mechanism is needed at all.**

### 3. Zero new persistent state

No lock file, no new owner-sidecar field, no occupancy registry, no in-memory Map surviving across calls.

This is a hard constraint, not a preference: any cross-process shared state, once stale (process crash, machine reboot, expired record), recreates zombie occupancy — and zombie occupancy is exactly what this ADR exists to eliminate. Using an existing field as the criterion makes the zombie problem undefined by construction: **no record, no occupancy**.

### 4. Zombie occupancy recovers via existing paths

Sessions are persistent and restorable: restoring session A starts the engine with A's binding (the "restart-safe explicit opt-in" adoption at `worktree-rebind.ts:790-798`; `worktree-gate.ts:913` `initiallyBound`), and A calling `exit-task-worktree` itself releases the claim. **No history lost, no session deleted, no new command needed.**

Secondary path: deleting that session record also clears the occupancy (at the cost of losing that history).

### 5. No model-side force

`enter-task-worktree`'s `inputSchema` gains **no** override or force field.

A party locked out by the gate must not hold the override switch, or the lock is a suggestion — and the operator turned this tier on precisely because it needed to really block. Override authority lives only on the operator side (the two paths in Decision 4).

### 6. New kind and classification

Colliding with an occupancy → typed rejection, `kind === "worktree_claimed"`, receipt includes the **occupier's session id** and the **release path**.

This kind enters the recoverability classification table and is classified `operator_required` — the model cannot resolve someone else's occupancy, so the receipt carries its own stop instruction and must not invite a model retry.

### 7. Ownership disclosure is decoupled from this tier

The `enter-task-worktree` success receipt noting "this tree was created by session X" is **always on**: zero cost (one file read), never blocks, controlled by no setting.

Informing and blocking are two things: informing makes sharing an **informed** decision, blocking makes sharing a **prohibited** decision. The operator can want only the former (default tier) or both (ON tier).

## Known limitations

- **L1 enumeration scope**: the occupancy criterion enumerates live session records; the entry point and cost are **unverified** (spec Open Questions 1). If the cost is too high and we fall back to "only sessions already loaded in the current hub", the semantics are **one notch weaker**: cross-process / cross-hub occupancy is invisible, and two independent CLI processes can enter the same tree without blocking each other. On fallback it must be stated explicitly in three places — the setting's documentation, the receipt text, and the spec — and the operator **must not** be left believing they got cross-process exclusivity.
- **L2 concurrent TOCTOU**: occupancy comes from persisted records, and records are written only on "tool success + session save". Two sessions entering, within the same window, a tree no record points at yet may both read "no occupancy" and both succeed. This ADR **does not solve it** — solving it needs a lock file or a registry, conflicting with Decision 3. Tests must **pin the behavior** of that window (rather than pretend mutual exclusion) and the docs must state it; the fuller L1's enumeration is, the narrower the window.

## Why not

- **Why not exclusive-by-default**: it would block the legitimate and common "new session takes over the old tree to continue the task" workflow; and changing the default is an all-tier semantics change whose cost is on par with the fence reversal in ADR-0037 §9.1, while the benefit holds only for the minority multi-session-parallel scenario.
- **Why not liveness detection (PID probe / heartbeat TTL)**: PID probing suffers pid reuse and breaks across machines under serve; heartbeats need a per-session timer — a new mechanism and a new state surface. Both are mechanisms that **cannot be guaranteed reliable**, whereas Decision 4 already covers the same need with the existing restart-safe binding design at zero cost.
- **Why not a new `release` command**: its only standalone value is "unbind but keep the session record", and Decision 4's main path (restore the session, let it exit itself) already unbinds without losing history. If a real pain appears later — "deleting history I want to keep just to free a tree" — add it then; the shape is already worked out (touch only the binding record, never the tree, never uncommitted changes), so no rework.
- **Why not a lock file / occupancy registry**: see Decision 3 — cross-process shared state reintroduces the zombie staleness surface.
- **Why not the owner sidecar for authorization**: see the closing paragraph of Context; sidecar ownership is pure path/file derivation, `enter-task-worktree` deliberately does not consult it, and starting to consult it would also break the "includes someone else's tree" semantics of ADR-0037 Amendment 2026-08-30.

## Consequences

### Positive

- Operators who need ownership isolation get a tier that really blocks; operators who don't see zero change (OFF tier byte-identical).
- Zero new persistent state ⇒ zero zombie staleness surface; release is an automatic consequence of `exit`, not a mechanism to maintain.
- Orthogonal composition with ownership disclosure: even the default tier turns sharing into an informed decision.

### Negative / Trade-offs

- With ON, if A crashes without exiting, B is rejected; recovery requires operator action (restore session A, or delete its record). This is the accepted cost of an explicit opt-in tier.
- L1 / L2 are real semantic gaps and must be documented alongside the implementation, or the operator will overestimate this lock's strength.
- Every new setting is a new combination state (`worktreeOnMutate` × `worktreeExclusive`); the test matrix grows accordingly.

### Reversibility

- Flipping the switch OFF fully restores today's behavior; typed rejections already produced leave no persistent trace (Decision 3).
- Removing the tier takes only the setting plus one pre-check; the `worktree_claimed` kind and its row in the table can go in the same change — no migration.

## Evidence

- The four enter checks contain no ownership: `src/session-api/worktree-rebind.ts:896-944`.
- Restart-safe adoption and `initiallyBound`: `worktree-rebind.ts:790-798`, `src/harness/isolation/worktree-gate.ts:913`.
- Value-domain discipline reference: `src/config/settings.ts:223-226` (`worktreeOnMutate`), `:299-303` (single read point `resolveWorktreeOnMutate`).
- Idempotent re-enter: `worktree-rebind.ts` `if (current === target) return target`.
