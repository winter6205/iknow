# Spec: subagent three layers + worktree project deps

**Status:** ready for plan  
**Surface:** `src/session-api/worktree-rebind.ts` (provision), `src/harness/subagent/` (spawn, manager, catalog), `src/harness/identity/` (dispatch lesson), TUI non-change for agent slash

## Goal

After `create-worktree`, a Node project task tree can run tests without the model inventing install; the main agent is nudged to dispatch ≤N workers correctly; capacity fails closed with a clear active/max.

## Settled invariants

### Layer 1 — dispatch + tree readiness

1. Short **English** dispatch lesson (not a second project instruction file). May live in spawn tool description and/or a small default injection; follow `docs/guides/prompt-development.md` when editing prompts. Golden-set gaps for soul/usage noted, not invented mid-flight.
2. After successful `git worktree add` (and alongside existing `worktreeinclude` copy), harness **silently installs project dependencies** from the new tree's lockfile when present: prefer `pnpm-lock.yaml` → `pnpm install`; `bun.lock`/`bun.lockb` → `bun install`; `package-lock.json` → `npm ci` (else skip or documented fallback). **Never** install global CLIs / runtimes. **No** whole-tree `node_modules` symlink to the identity root.
3. Missing package manager binary, missing `package.json`, or install failure → **fail-open**: worktree still created; reply reports linked/skipped/failed reason. Do not roll back the git worktree.
4. Do **not** hard-reject bash-as-reader globally.

### Layer 2 — tool + types

5. Omitting `subagent_type` keeps default **`general-purpose`**. `explore` must be requested explicitly (readonly).
6. TUI does **not** add `/<agent-id>` slash entries. Main agent calls `spawn_subagent` against the catalog.

### Layer 3 — runtime

7. At capacity: **reject** with message including **active/max**; **no queue**.
8. Same-turn parallel `spawn_subagent` allowed up to cap (`isConcurrencySafe` stays true).
9. `wait` default **true**.
10. Workers **cannot** nest-spawn.

## Out of scope

- Changing default concurrent cap from 15 to 3 (operator prompt enforces ≤3 for measured workflow)
- Config panel ADR-0096 implementation
- Transport idle/retry (other spec)
- Plugin `commands/` discovery
- Symlink shared `node_modules`

## Input-contract classes

| Surface                    | empty                  | invalid/negative                                               | overflow                                       | concurrent                                 | exception                               |
| -------------------------- | ---------------------- | -------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ | --------------------------------------- |
| provision install          | no package.json → skip | lock present, manager missing → skip + reason                  | N/A                                            | second provision idempotent / enter ensure | install throw → fail-open, tree remains |
| `spawn_subagent` omit type | omit → general-purpose | unknown type → typed reject (existing)                         | at capacity → SubAgentCapacityError active/max | same-turn multi-spawn ≤ max                | nested spawn from worker → reject       |
| explore type               | N/A                    | explore + mutate tool → isolation/readonly contract (existing) | N/A                                            | N/A                                        | N/A                                     |

## Success criteria

- SC1: New task worktree on a lockfile'd JS repo gets a usable `node_modules` without a model-run `npm install` when the manager binary exists.
- SC2: Omit type → GP worker (writable under isolation rules). Explicit `explore` stays readonly.
- SC3: Spawn past max returns active/max and does not start an extra worker.
- SC4: Dispatch lesson text is discoverable in the spawn description and/or injected lesson surface without welding a foreign CLAUDE.md.

## Measured acceptance (after this + skill slash land)

Operator runs the **unchanged** leader prompt with `task` = deepen **one** iknow module via project skill `improve-codebase-architecture`. Where that skill says **grilling**, the measured run uses **`logicsync`** instead. Companion vocab skill `codebase-design` is installed under `.iknow/skills/` (and local `.claude/skills/`). Deliverable: HTML architecture report + LogicSync grill on one chosen candidate — not a full-repo rewrite.
