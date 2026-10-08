# Worktree discovery and entry beyond `.iknow/worktrees/`

> Issue #1231. Amends ADR-0037 §4 and the `foreign_worktree` contract; touches
> ADR-0019 (`mainCheckoutOf` resolution). Design of record:
> `plans/issue-1231-worktree-discovery.md`.

## Problem

`list-worktrees` returned `[]` and `enter-worktree` exited `worktree_not_found`
while `git worktree list` plainly showed the requested checkout. Two layers
caused it, and fixing only the first ships a broken session.

**Layer 1 — discovery was filtered to task-shaped paths.** `list()` already ran
`git worktree list --porcelain`, but every record was dropped unless
`isTaskWorktreePath(record.path)` — a pure path-shape test for
`<x>/.iknow/worktrees/<leaf>`. `enter` derived its target only from that list
plus the same path derivation, so it inherited the blind spot.

**Layer 2 — an entered external worktree would still have been read-only.**
`isTaskWorktreePath` was not merely a discovery filter; it was the _only_
"is this session bound to a writable tree?" predicate, at every enforcement
surface:

| surface                                                     | consequence for a non-task-shaped root               |
| ----------------------------------------------------------- | ---------------------------------------------------- |
| mutate gate (`gateMutate`)                                  | every mutate blocked with the `create-worktree` hint |
| bash fence (`unboundFenceMainCheckout` → bwrap `--ro-bind`) | the entered tree itself mounted read-only            |
| `writeSituation`                                            | reported `no_writable_root`                          |
| `gateProjectIdentityRoot`                                   | identity-root read grant denied                      |

bash is classified `read` by the gate, so its writes are stopped by the
**physical** ro-bind rather than by gate adjudication. Without fixing layer 2,
"entered" would have meant "reads from the new root but cannot write to it".

## Boundness becomes stamped, not shape-only

`isBoundWorktreeRoot(root)` = task-shape **or** a durable explicit-enter stamp.

| root                                           | writable? | why                    |
| ---------------------------------------------- | --------- | ---------------------- |
| main checkout (`.git` is a directory)          | no        | unchanged — ro-bind    |
| task worktree `<repo>/.iknow/worktrees/<leaf>` | yes       | unchanged — path shape |
| external linked worktree iknow **entered**     | yes       | new — stamp            |
| external linked worktree never entered         | **no**    | closes the `cd` hole   |

The stamp is a gitdir sidecar (`iknow-entered-by`, beside the existing
`iknow-conversation-id`) written by `markWorktreeEntered` only after `enter`
succeeds. It is therefore a record of _explicit_ entry by construction, and it
is durable — unlike the in-process `bound` Map, it survives a restart.

### Why not simply "is a linked worktree"

Git's own discriminator is that a linked worktree's `.git` is a **file** and the
main checkout's is a **directory**. Widening the predicate to
`isLinkedWorktreeRoot` is the one-line fix, and it opens a hole: with isolation
ON and the session started from an arbitrary registered worktree (the operator
runs `iknow chat` inside `/home/winner/iknow-wt-1220-finalize`), that root is
not task-shaped, so today it is ro-bound read-only. Swapping the predicate
makes it writable, and the ro-bind is the only thing that ever stopped bash
writes there. The stamp keeps the fail-closed posture for every tree iknow did
not explicitly enter.

The same reasoning rules out adopting on the durable `session.workspaceRoot`
alone: that field is unconstrained (`serve.bindWorkspace` legitimately persists
the main root), so shape-only adoption would grant writes to a manual checkout
that was never entered.

## Contracts

**Discovery.** `list()` keeps every task-worktree row byte-identical — a
task-shaped path whose owner cannot be resolved is still dropped. It
additionally emits registered same-repository checkouts that are not task-shaped
as `external: true` rows with `conversationId: ""` and `label: undefined`.
Same-repository is guaranteed by `git worktree list` reporting only the current
repository's trees; `enter`'s existing `gitCommonDir` comparison remains the
authority. No extra git call is spent re-proving it.

**Selection.** `selectTaskWorktree` prefers an exact conversation-id match, then
an exact label, then a per-entry fallback selector (branch name, then leaf
name). Ambiguity keeps the typed `ambiguous_worktree`, and the diagnostic
interpolates the _selector_ — never `conversationId`, which is `""` for external
rows.

**Entry.** `enter-worktree` gains an optional `path` that must exactly match a
listed entry's path. It is never joined onto anything and never accepted
free-form. On success the target is stamped, so the harness predicate
recognizes the root on the next wave. Existing validation and ordering are
unchanged: absent → `worktree_not_found`, not a linked checkout or a different
common dir → `foreign_worktree`, claimed by another live session →
`worktree_claimed`. `git worktree add` never runs for an external target, so its
branch and uncommitted changes survive untouched.

**Removal.** `remove-worktree` refuses an `external` row with the named
`external_worktree` kind (classified `operator_required`, like
`worktree_claimed`: no model action can make it succeed, so the receipt carries
the stop directive). iknow removes only task trees it created — it must never
destroy an operator's checkout.

**Identity root.** `mainCheckoutOf` resolves a linked worktree to the stable
main checkout by reading the gitdir pointer (honouring git's `commondir` file)
instead of returning the tree itself. Without this, `productRoot` /
`projectIdentityRoot` and the memory namespace would drift onto the entered
external tree — an ADR-0019 divergence introduced by this change rather than
pre-existing debt. It stays filesystem-only: no subprocess, no new async.

## Out of scope (per the issue)

GitHub issue-reading tool preference, network/DNS failures, sandbox file-type
errors.
