# Plan: subagent three layers + worktree project deps

**Goal:** New task worktrees get project deps without model install theatre; spawn defaults and capacity match the settled three-layer contract.
**Approach:** Land provision install first (unblocks tree work), then capacity/default type bullets, then the short dispatch lesson (prompt path last so trees already work in acceptance).
**Spec link:** `specs/subagent-layers-worktree-deps.md`
**ACR:** addressed after split — worktree provision sequenced before lesson; input-contract matrix in spec
**待写入:** (empty — `project dependency provision` / `dispatch lesson` 已入 `docs/CONTEXT.md`)
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

## ACR

bounded-context-guardian: yes — provision in worktree-rebind; spawn/manager; identity lesson.
input-contract-tests: yes — provision + spawn matrices in spec.
error-handling-enforcer: yes — fail-open install; capacity reject active/max; no nested spawn.
complexity-anti-drift: yes — no whole-tree symlink path; short lesson not a second instruction dump.
minimal-change-verifier: yes — sequenced bullets: provision → runtime defaults → lesson.

## Tasks (ordered by dependency)

1. **Provision silently installs project deps from lockfile** — tag: `[implementation]`
   - **Inherits:** spec Layer1 items 2–3; SC1; worktreeinclude stays file-copy only
   - **Surface:** session-api worktree-rebind provision (after worktree add / beside include mirror)
   - **Acceptance:** with lockfile + manager on PATH, new task tree has resolvable project packages without model `npm install`; missing manager / no package.json / install throw → tree still created + reason in tool result; no global install; no `node_modules` symlink to identity root; enter/idempotent ensure does not destroy a real dest directory
   - Status: [ ] pending
   - Input contracts: provision row in spec

2. **Capacity reject + omit type = general-purpose (no agent slash)** — tag: `[implementation]`
   - **Inherits:** spec Layer2–3 items 5–10; SC2–SC3
   - **Surface:** harness subagent spawn tool + manager
   - **Acceptance:** omit `subagent_type` → GP; explicit `explore` readonly; at max concurrent workers next spawn fails with active/max and starts no worker; same-turn multi-spawn up to max still works; worker cannot spawn; TUI slash vocabulary gains no agent ids
   - Status: [ ] pending
   - [parallel] with T1
   - Input contracts: spawn row in spec

3. **Short English dispatch lesson on spawn path** — tag: `[implementation]`
   - **Inherits:** spec Layer1 item 1; SC4; `docs/guides/prompt-development.md`
   - **Surface:** harness identity / spawn-subagent description (choose one injection surface; not a second CLAUDE.md)
   - **Acceptance:** lesson text states explore-first, ≤3 concurrent for operator workflows, create-worktree before mutate when isolation requires it, and skill-check via catalog skills; visible in spawn description and/or default lesson surface; no weld of foreign home CLAUDE.md
   - Status: [ ] pending
   - [blocks: T2] preferred so lesson does not promise behaviour capacity bullet has not locked

## Measured acceptance (after Plan 3 skill slash also lands)

Not a code bullet in this file. Operator paste **unchanged** leader prompt with:

```text
task: {
  Use project skill improve-codebase-architecture on the iknow repo.
  Scope: deepen exactly one module (pick from hot spots or operator named).
  Where that skill calls for "grilling", use logicsync instead.
  Use codebase-design vocabulary. Stop after HTML report + LogicSync on the chosen candidate unless operator asks to implement.
}
```

Skills already installed: `.iknow/skills/improve-codebase-architecture/`, `.iknow/skills/codebase-design/` (local Claude copies under `.claude/skills/`, gitignored).

## Code review phase

End of round: `code-review` → if `GATE: BLOCKED` then `review-report-repair` → `verification-before-completion`.
