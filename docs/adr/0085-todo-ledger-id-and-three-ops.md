# 0085. Todo ledger: id + three ops; workers share the same main session

Date: 2026-09-11
Status: accepted

Corrects the main path of `docs/adr/0046-todo-ledger-replace-and-snapshots.md` (that file's number once collided with another 0046 — now `0114-exact-name-load-and-index-demotion.md`; the collision was resolved by renumbering — so the amendment could not be written back into the original file). The snapshot discipline and "swap the table, don't refill messages" remain in force.

Each current-ledger entry has a stable **id** and status `pending` | `in_progress` | `completed`. The main path is three ops: **add** (one call may carry many; appends, never overwrites), **update** by id (subject / status / deletion; `check` merged in), and **read** the current table. `replace` demotes to a whole-table escape hatch, not the main path for changing plans.

The id's stability domain is **within the table**: `add` takes existing-max-number + 1 (deleting a middle entry does not free its number; old ids are never reused by later entries), and after `replace` swaps the whole table numbering **restarts from `t1`** — old ids die with the old table, do not carry across a replace, and the model must `read` again for the new ids. The receipt stays the short string `Updated todos.md`, without listing ids per entry (whole-table invalidation is not "N entries added").

Within one **main session**, subagents and the parent share the ledger: workers may read and update; **add is parent-session only**, and a worker `add` gets a typed rejection. Sharing across main sessions is not done.

The status bar still projects only unfinished items (ADR-0028) and does not dump the whole table into messages. Size limits and atomic writes keep the existing 64KB / 500 and no-half-write guarantees.

**Why not only widen `add` to accept an array:** the model still needs per-entry status updates; without ids the only option is rewriting the whole table. **Why not a cross-main-session task pool:** this slice's done-marker is "one session can write down multi-step work and workers see it"; no list identity or opt-in is introduced.
