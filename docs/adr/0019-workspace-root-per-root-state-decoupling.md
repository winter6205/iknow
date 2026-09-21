# 0019. workspace-root makes per-root state follow the launch directory while global config stays shared

Date: 2026-08-17

Status: accepted

> **Amendment 2026-09-18** (ADR-0099): **memory** also does not shard with `workspaceRoot`; it lives in the home project tree at `projects/<slug>/memory/`. The remaining per-root items in D1 are still settings write-back / worktrees. The throwaway-isolation claim in Positive no longer holds for **serve / session records / tasks / project memory**.
> **Amendment 2026-09-13** (ADR-0088): **tasks** also do not shard with `workspaceRoot`; they live in the home project tree at `projects/<slug>/tasks/`. The other per-root items in D1 remain memory / settings write-back / worktrees. The throwaway-isolation claim in Positive no longer holds for **serve / session records / tasks**.
>
> **Amendment 2026-09-13** (ADR-0087): the session pool (transcript / todos / trace / blobs) does **not** shard with `workspaceRoot`; it lands in `~/.iknow/projects/…` (except with an explicit `--data-dir`). The early implementation that read serve data from `<workspaceRoot>/.iknow` is **superseded** (session records only). memory / settings write-back / worktrees remain per-root (for tasks see the entry above). The Positive claim "a throwaway dir fully isolates identity / memory / serve / settings" no longer holds for **serve / session records**.

## Context

Today, whenever iknow starts in any directory, the identity workspace seed (`user.md` / `BOOTSTRAP.md` / `state.json`), the memory store, serve data, and the settings write-back fallback all implicitly follow `~/.iknow` — so a user switching between project root directories cannot get "per-root iknow state isolated per root directory, while global config is shared across roots". Prior constraints (none shifted by this ADR): ADR-0009 (memory layered injection) pins user-level = `~/.iknow` and project-level = `<cwd>/AGENTS.md`, fixing the memory read order and slots; ADR-0010 (memory-injection landing) pins the `IKNOW_ASSEMBLY_ORDER` sequence and slot indexes; ADR-0015 (settings.json single source) pins the `home` argument of settings merge as the global config anchor. This ADR introduces `workspaceRoot` as a **new dimension** (per-root state anchor), not a replacement of any semantics of those three ADRs.

## Decision

Introduce `workspaceRoot` as the per-root state anchor (default = `process.cwd()`), decoupled from `home` (global config anchor, default `homedir()`) at the assembly layer. Five sub-decisions:

### 1. workspace-root default = `process.cwd()` (D1.1)

**Recommended: default = `process.cwd()`**. Satisfies the user's requirement "per-root state differs, global same". Migration concern: existing users who ran iknow inside a project directory will see identity/memory move into that directory's `.iknow`. Mitigation: a one-release `--workspace-root $HOME` opt-out migration window. Counter-option: default = `homedir()` (keep status quo, per-root only via explicit opt-in) was rejected — it conflicts with the user's stated per-root model.

### 2. host-init stays global (D1.2)

The `host-init` script (`~/.iknow/init.sh`) is per-machine (user-authored machine init), not per-project. `src/harness/identity/host-init.ts:34` keeps defaulting to `homedir()/.iknow/init.sh` and does **not** thread `workspaceRoot`.

### 3. settings write-back fallback (when no project settings.json) → workspace root (D1.3)

**Recommended: workspace root**. The fallback target = `<workspaceRoot>/.iknow/settings.json` (mkdir -p), **not** `<home>/.iknow/settings.json`. Rationale: this is exactly the path users complained about for polluting global config; in per-root mode the redirect kills the global-pollution path entirely.

### 4. `user.md` / `BOOTSTRAP.md` reads follow workspaceRoot (D1.4)

**Superseded by ADR-0025.** The original Recommendation was per-root. The operator later clarified that the profile is always a single global copy; identity files moved back to `userHome/.iknow`. D1.1–D1.3 / D1.5 are unaffected by this supersede.

### 5. `IKNOW_WORKSPACE_ROOT` env SSOT registration (D1.5)

**Recommended: register** at `src/config/env.ts`. The env SSOT table is a project convention; `envOptional` is the canonical reader. **The resolver does not read `process.env` directly** — it reads through the SSOT. A CLI flag `--workspace-root <dir>` mirroring the `--data-dir` pattern (`src/cli/parse-args.ts:220-225`) is added.

## Consequences

### Positive

- Explicit split of the two anchors `home` and `workspaceRoot`: settings merge / user-level memory global scope / host-init remain `home`-authoritative (ADR-0009/0015 unchanged); per-root state is `workspaceRoot`-authoritative.
- Starting a throwaway dir with `--workspace-root <dir>` yields fully isolated identity / memory / serve / settings without touching `~/.iknow`.

### Negative / Trade-offs

- Existing users who start in a project directory will see identity/memory migrate into that directory's `.iknow` — backstopped by a one-release `--workspace-root $HOME` opt-out migration window.
- Persona reads in `assemble.ts` (user.md / BOOTSTRAP.md) no longer default to `~/.iknow` — users who expect them to be global need an explicit `--workspace-root $HOME`. **Outdated for persona: superseded by ADR-0025** (the profile returned to home; `--workspace-root` no longer moves user.md away).

### Concrete Quiddity

- The resolver `resolveWorkspaceRoot` is a pure function (no I/O), priority chain `[explicit, env, process.cwd()]`; 4 validation error kinds throw a `WorkspaceRootError` discriminated union (`empty_explicit` / `empty_env` / `non_absolute` / `not_found`), mirroring `IknowIdentityError`.
- `workspaceRoot` is **not** added to `LoopEngineDeps` (all per-root consumers live at the build-engine / tui-deps layer).
- `fs-policy` protected-path extended to `<workspaceRoot>/.iknow` and its children — same protection pattern as the existing `<home>/.iknow`. **2026-09-13 (ADR-0092 fix round)**: the `isSensitive` predicate and the `home` / `workspaceRoot` options of fs-policy were retired with ADR-0092 (zero consumers); the "protected-state" fs-policy predicate surface over `<home>/.iknow` / `<workspaceRoot>/.iknow` no longer exists, and write interception moved to the permission chain + hard-wall; the Round-2 workspace tier will reintroduce a write-set contract per the fs-isolation-modes spec.
- Tilde expansion (`~`) still points at `home` (global) — tilde is a user-input convenience, workspace is a state boundary.

### Reversibility

- Within the migration window, `--workspace-root $HOME` fully restores the old behavior; after the default switch, each root's `.iknow` is an independent directory and deleting it reverts.

## Evidence

- Implementation plan passed ACR 5/5 (bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier).
- Implementation evidence comes from 5 slices across 5 commits, one logical task per commit: resolver + CLI flag + env SSOT + 5 boundary-class tests → build-engine / run.tsx / identity / memory / serve decoupling at 7 seams + integration probe with 4 binary asserts → settings write-back fallback redirect + concurrent dual-write test → fs-policy dual-root protection + policy-refusal tests → CLAUDE.md / docs/architecture.md / CHANGELOG.md.
