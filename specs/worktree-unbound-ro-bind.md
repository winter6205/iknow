# Spec: worktree gate — physical ro-bind for unbound bash (predictive interception flipped to EROFS feedback)

> Basis: issue #1059 / ADR-0109. Flip target = the bash predictive-decision core of ADR-0037 Amendment 2026-09-04 and the unbound tier of the §9.2 write allowlist (already marked superseded in place).
>
> Gate receipts and violation-feedback wording **must be English only** (continuing the copy discipline of ADR-0037 Amendment 2026-09-04).

## Objective

When the worktree gate is ON and the session is unbound (waveRoot = main checkout): bash is **no longer predictively intercepted** — the fence appends a `--ro-bind` for the main checkout and all bash is allowed to execute; an actual write to the main repo (including `.git`) returns EROFS from the filesystem, delivered to the model as a typed violation feedback whose wording names `create-worktree` and the "create the tree, then resend this exact call" guidance; zero writes land on the main checkout. The pre-write gates for `write_file` / `edit_file` (FILE_WRITE-class tools) and `root_flip` (enter / exit) are unchanged. The fence assembly for the bound tier and the gate-OFF tier stays byte-identical to today's.

## Boundaries

- **Does:**
  - **fence argv**: under the condition "gate ON ∧ waveRoot = main checkout", append `--ro-bind <mainCheckout> <mainCheckout>`, placed **after** that root's writable bind and **before** `--proc` (bwrap last-mount-wins, inheriting the later-mount discipline of ADR-0037 Amendment 2026-09-05 (b)).
  - **session fence tmp pad**: re-bound as rw after the `--ro-bind`; scratch / temp-file writes go to the pad, never landing on the main checkout.
  - **EROFS violation feedback**: a real write hitting EROFS with a non-zero exit → the `[fs_denied]`-prefixed guidance is fed back via tool-result stderr (ok-envelope bypass, not counted as a violation), including the `create-worktree` guidance (conditional phrasing + resend semantics, keeping the three-part structure of `unboundMutateNotice`); non-zero exit without EROFS, or zero exit with the wording on stderr → result byte-identical. The background tier attaches a `notice` preflight to the spawn receipt (unbound state only).
  - **`.git` wording split**: when the feedback's target path lies under the main repo's `.git` (gitdir), recognized path clues yield the corresponding guidance (create the tree first, commit in the task tree); EROFS semantics themselves unchanged.
  - **Escape route reuses existing machinery**: `create-worktree` success → flip to the live `taskRoot` → per the ADR-0037 §7.2 batch snapshot, resend this run's next wave of tool calls on the new root; no second rebinding path is added.
- **Confirms with human:** (none. The flip decision is closed in issue #1059 and ADR-0109.)
- **Out of this spec:** changing the FILE_WRITE / root_flip interception shape; changing `validateReadonlyCommand` (still serving only `bashMode === "readonly"`); changing the isolation switch value range / settings wiring; changing `create-worktree`'s ACI shape; non-FS side effects (network egress belongs to ADR-0107); a read-arm allowlist (an explicitly rejected route, not reopened).

## Success Criteria

1. **Zero false triggers when unbound**: with the gate ON and unbound, trace false-trigger sample-class commands (`cd` combinations, `curl` to allowed domains, `gh`, `sleep`, `date && ls 2>&1 | head`, etc.) actually execute and return normal results, with no gate receipt (vitest + TUI `mcp__aiterm__pty_*` measured, with on-screen evidence).
2. **EROFS feedback carries guidance and keeps the main checkout clean**: unbound bash `echo x > <main-checkout>/f.txt` and `.git` writes (e.g. bare `git add`) → EROFS typed violation feedback whose wording contains `create-worktree` and resend semantics (semantic + substring dual assertion, keeping the SC7 discipline); the `.git` branch carries path-clue wording; after execution the main checkout's `git status` is clean with zero new files.
3. **bound / gate OFF byte-identical + probes all green**: fence argv for the rebound task-tree tier and the gate-OFF tier is byte-equal to before the flip (vitest argv deepEqual); `npm run probe:sandbox` all categories (14 classes, 11 physical + 3 violation) green.
4. **Invariants regression**: FILE_WRITE tools and root_flip pre-write tests remain green; `validateReadonlyCommand` readonly-mode tests remain green; the "tree-creation failure leaves the main repo with zero writes" acceptance (ADR-0037 §6) is unaffected.

## Inherits / Changes

- Inherits: the ADR-0037 model-provision contract, the live `taskRoot` (§7), fail-closed tree creation (§6), the three-part semantics of `unboundMutateNotice`; ADR-0109 (this spec's decision source).
- Changes: the bash decision core of ADR-0037 Amendment 2026-09-04, the unbound tier of the §9.2 write allowlist (the superseded note already landed in 0037's body); `classifyCall` is no longer the gate's enforcement surface for bash (PreWrite hook-surface semantics adjusted per ADR-0109).
- Voided old pins: the bash half of `casual-ask-context-hygiene.md` SC5/SC6 (original text: `git show 5ae9889a^:specs/casual-ask-context-hygiene.md`; cited, not restored).
- Test command: `npm test`; the sandbox surface additionally runs `npm run probe:sandbox`; the acceptance surface is the TUI (`mcp__aiterm__pty_*`).
- Surfaces: `src/harness/isolation/`, `src/harness/sandbox/bwrap.ts` (argv order discipline: see `.claude/rules/security-boundaries.md`; after changes the full-category probes must be green).
