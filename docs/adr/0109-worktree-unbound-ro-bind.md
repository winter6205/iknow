# 0109. Worktree-gate bash interception: flipping from predictive classification to a physical ro-bind guarantee

Date: 2026-09-19
Status: accepted

> **Live carrier**: the shipped contract is carried by the "Worktree gate bash surface: physical ro-bind flip" row in docs/STATUS.md and the in-place supersession notes in ADR-0037; the contract spec is `specs/worktree-unbound-ro-bind.md`. This ADR records the decision and its rationale.

## Context

Under the ADR-0037 gate, the "gate ON ∧ not bound to a task worktree" tier applied **predictive interception** to bash: `classifyCall` itself adjudicated "will this write the workspace", and `>` redirection / `rm` / **unknown commands were all judged mutate fail-closed** (the semantics locked by Amendment 2026-09-04). The deny-by-default prediction table structurally misfires on read-only commands: trace measurement across 23 sessions shows `cd` combinations 15 times, `curl` 10 times, `gh` 4 times, `sleep` 3 times and other read-only commands judged mutate and intercepted. Patching the read-arm whitelist is whack-a-mole — the command language surface is unbounded, predictive classification can never finish enumerating, and every misfire turns "the model doing its normal work" into the context pollution of "gate receipt + model workaround".

The real invariant the gate must certify is "**writes never land in the main checkout**", not "commands are predicted as reads". bwrap's last-mount-wins mount order (ADR-0037 Amendment 2026-09-05 (b) already established the "later mounts override earlier ones" discipline) allows turning this invariant directly into a physical guarantee: the main checkout exists inside the fence as `--ro-bind`, so real writes naturally get EROFS.

## Decision

**Bash write protection for unbound sessions flips from "predictive interception" to "physical ro-bind + after-the-fact EROFS violation feedback". This overturns ADR-0037's predictive-interception clauses targeting bash (Amendment 2026-09-04's adjudication core, and the unbound form of the §9.2 write whitelist); all other gate semantics (model-provision, live `taskRoot`, fail-closed tree building, no auto-provision) are unchanged.**

Locked sub-decisions:

1. **Applicability** = gate ON ∧ this wave's waveRoot is the main checkout (unbound). For the bound (already re-bound to the task tree) and gate-OFF tiers the fence assembly is **byte-identical** to today's.
2. **fence argv**: when condition 1 holds, append `--ro-bind <mainCheckout> <mainCheckout>`, placed **after** that root's writable bind and **before** `--proc` — bwrap last-mount-wins, so the read-only mount overrides the writable one. The session fence tmp pad is re-bound rw **after** it (the pad may sit inside the main checkout subtree, so it must be covered by the ro-bind and then flipped back to writable); scratch writes go through the pad.
3. **Execution posture**: unbound bash is **always allowed to execute**; the gate no longer intercepts any bash command by predictive classification. The only fail-closed exception = **non-string / whitespace commands** (intent unparseable, keep the pre-intercept mutate verdict). A real write to the main checkout → the filesystem returns **EROFS** → when **non-zero exit ∧ stderr matches EROFS**, it is delivered back to the model as a violation with the `[fs_denied]` prefix (using the existing ok-envelope stderr side-channel — the ssh-hostkey precedent — and not counted as a violation); the message names `create-worktree` and the resend guidance (reusing `unboundMutateNotice`'s conditional form + "resend this one call" semantics). For background launches stderr never reaches the receipt, so the same fact is pre-disclosed in the **spawn-receipt preflight notice** (present only in the unbound state; the bound / gate-OFF receipt shape is byte-identical).
4. **`.git` writes**: writes to the main checkout's `.git` (gitdir) likewise get EROFS and likewise bounce back — the semantics are correct (an unbound tree must not write the main repo's gitdir), but the **message is differentiated**: when a path clue is recognized (target under `.git`) the guidance is specific (create the tree first, then commit in the task tree) rather than sharing one vague message with ordinary file writes.
5. **Unchanged items**: interception for `write_file` / `edit_file` (FILE_WRITE-class tools) and `root_flip` (enter/exit) **stays predictive** — they are structured calls with zero classification ambiguity, so the whack-a-mole problem does not exist for them.
6. **The way out after EROFS** = the existing re-bind machinery: the model calls `create-worktree` successfully → the live `taskRoot` flips to the new root → per ADR-0037 §7.2 batch-snapshot semantics, the next wave of tool calls in this run resends the EROFS'd write on the new root outside the main checkout. No second re-bind path is added.

**Adjudication points made explicit** (anchors for implementation and any later reversal):

- `.git` EROFS semantics correct but message differentiated (sub-decision 4);
- scratch writes go through the session fence tmp pad rather than the main checkout (sub-decision 2);
- EROFS → `create-worktree` → reuse of the existing re-bind machinery, no new mechanism (sub-decision 6).

**ADR relationships:** ADR-0037 Amendment 2026-09-04's bash "will it write the workspace" self-adjudication and unknown-command fail-closed interception clause, and the physical form of the §9.2 write whitelist in the unbound tier, are **superseded by this ADR** (noted in place in 0037). `validateReadonlyCommand` still serves only `bashMode === "readonly"`, unrelated to this decision (that half-clause persists). The PreWrite user-hook event still reuses `classifyCall`, but for bash `classifyCall` is no longer the gate's enforcement surface.

## Why not

- **Batch-patch the read arm short-term (expand the whitelist to save the prediction table)**: whack-a-mole. Trace measurement already proves the misfire surface is structurally generated by "command language ∩ unknown-command fail-closed"; it cannot be finished, and each round of table-patching also incurs the secondary-adjudication debt of "what counts as a read". Rejected.
- **Keep predictive interception, merely relax unknown commands to allowed**: swaps fail-closed for fail-open — first interception of a real write relies on luck, opening a hole in main-checkout write protection. Rejected.
- **Also move FILE_WRITE tools to after-the-fact feedback**: for structured tools the call surface is the complete intent, predictive classification has zero misfires, and after-the-fact-izing only loses the stronger guarantee of "no write without execution". Keep pre-interception.

## Consequences

- The "unknown commands fail closed" clause is **void for bash**: the gate's bash enforcement moves from pre-interception to after-the-fact — commands genuinely execute, but the mount surface guarantees zero writes land in the main checkout; non-FS side effects (network, processes) were never under the worktree gate's jurisdiction and are unaffected by this flip. The bash half of the acceptance constraints pinned by the old spec `casual-ask-context-hygiene.md` (already retired in `5ae9889a`) is voided along with it.
- The misfire surface for unbound sessions drops to zero: `cd` / `curl` / `gh` / `sleep`-class read-only commands no longer receive gate receipts.
- The feedback point for real writes moves from "before the call" to "EROFS during execution"; what the model sees shifts from gate wording to a filesystem-violation feedback carrying equivalent guidance.
- The correctness anchor of write protection moves from the classification table to argv assembly: the position of `--ro-bind` (after the rw binds, before `--proc`) and the pad re-bind order become a contract that must be measured (`npm run probe:sandbox` + TUI).
- The byte-identical promise for the bound / gate-OFF tiers gives the regression floor: the flip introduces differences only in the unbound tier.

## Evidence pointers

- Trace measurement: misfire samples across 23 sessions (cd 15 / curl 10 / gh 4 / sleep 3 etc.).
- The voided old nail: acceptance clauses of the old spec retired in `5ae9889a` (the citation does not restore them).
- ADR-0037 Amendment 2026-09-04, Amendment 2026-09-05 (b) (the later-mount-overrides discipline), §9.2 (write whitelist).
- Spec `specs/worktree-unbound-ro-bind.md` (three acceptance clauses: unbound zero-misfire / EROFS feedback with guidance and no main-checkout pollution / bound byte-identical + probe all green).
