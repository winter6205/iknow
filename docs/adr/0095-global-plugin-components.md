# 0095. Global plugin component loading: ledger-first, directory-scan fallback, second slice of the hook file source

Date: 2026-09-14
Status: accepted

> **Live-behavior carrier**: the `Global plugin component loading (ADR-0095)` row of `docs/STATUS.md` restates the shipped behavior. This ADR keeps the decision rationale.

## Context

Plugins installed globally on this machine carry components (skills / agents / hooks) that iknow does not read. This ADR adds that loading capability; its shape (roots, discovery, naming, hooks) is decided below.

## Decision

1. **Plugin roots are not session roots**: `~/.iknow/plugins` (default, isomorphic to `~/.iknow/skills` / `~/.iknow/agents`) + the `IKNOW_PLUGIN_ROOTS` env + the user setting `plugins.roots`. Orthogonal to the three session roots of `session-roots.ts` — plugin roots are component source paths, invariant across worktree rebind, and never enter `resolveSessionRoots`.
2. **Discovery = ledger first, directory-scan fallback**: `<root>/installed_plugins.json` (`<plugin>@<marketplace>` → installPath/version/scope) supplies exact plugin names and arbitrary-depth paths; no ledger / broken JSON → directory scan (covering the nested `<root>/<plugin>/<version>/` layout). Namespace precision depends on the ledger key — plugin skills reference agents in their bodies as `<plugin>:<agent>`, so guessing names from the directory would be wrong.
3. **Namespaced ids**: skills and agents register the canonical name `<plugin>:<name>` plus a bare-name alias (conflicts dropped + warned); the agent `ROLE_ID_PATTERN` is relaxed to allow `:`. The id travels **verbatim with zero normalization** across all three segments (enum / model-supplied argument / capability).
4. **Second slice of the hook file source**: the `HookContribution` seam (reserved in `hooks/index.ts`) lands as `hooks/plugin-hooks.ts` — `PreToolUse` / `PostToolUse` in `hooks/hooks.json` compile into async subprocess hooks. Matchers split by character class (exact alternation vs non-anchored regex); iknow tool names map to candidate sets of the external names (`write_file`→`Write`, `edit_file`→`Edit|MultiEdit`; `todo_write` is **not** mapped to `Write`); the envelope carries common key aliases (`file_path`←`path` etc.); `${*_PLUGIN_ROOT}` / `${*_PLUGIN_DATA}` / `${*_PROJECT_DIR}` are substituted by suffix and exported as env. exit 2 = block at Pre (stderr JSON `systemMessage`/`permissionDecisionReason` take priority); anything else fails open.
5. **Async hook chain (additive type widening)**: `PreToolUseHook` / `PostToolUseHook` return types allow Promises; the two call sites in `permission-executor` and the observe call in `violation-executor` all `await` (a rejected post hook must enter the catch, otherwise unhandledRejection); `composePreHooks` is async, first block wins. Existing synchronous hooks need zero changes.
6. **`plugins` is user layer only**: not added to `PROJECT_SETTINGS_ALLOWED_KEYS`. Plugin-contributed hooks mean arbitrary command execution; allowing the project layer to configure plugin roots amounts to clone-then-execute (supply chain). The bun launcher auto-loads the repo `.env` into `process.env`, so the `IKNOW_PLUGIN_ROOTS` bypass is still reachable on that path — judgment: the bun path executes the iknow repo itself, script trust already dominates there, risk equals the existing `npm run` surface; recorded here, not a code blocker.

**Why not parse plugin manifests such as `.claude-plugin/plugin.json`**: it binds a third party's private schema; ledger + directory scan are isomorphic across the two install layouts, and a half-installed plugin degrades naturally.
**Why not run hooks via `spawnSync`**: serial blocking of the event loop on every tool call is unacceptable under the TUI.
**Why not let Post change tool results**: the existing `PostToolUseHook` invariant "observability only" stays untouched.
**Why not fail-closed**: hooks are an interception surface; the cost of a false block is higher than a false pass (same judgment basis as user-hook-router).

## Consequences

- Amends ADR-0055 (the second slice of hook file source H1 lands).
