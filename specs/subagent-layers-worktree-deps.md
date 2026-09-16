# Spec: subagent three layers + worktree project deps

**Status:** ready for plan  
**Surface:** `src/session-api/worktree-rebind.ts` (provision), `src/harness/subagent/` (spawn, manager, catalog), `src/harness/identity/` (dispatch lesson), TUI non-change for agent slash

## Goal

After `create-worktree`, a Node project task tree can run tests without the model inventing install; the main agent is nudged to dispatch ≤N workers correctly; capacity fails closed with a clear active/max.

## Settled invariants

### Layer 1 — dispatch + tree readiness

1. Short **English** dispatch lesson (not a second project instruction file). May live in spawn tool description and/or a small default injection; follow `docs/guides/prompt-development.md` when editing prompts. Golden-set gaps for soul/usage noted, not invented mid-flight.
2. After successful `git worktree add` (and alongside existing `worktreeinclude` copy), harness **silently installs project dependencies** from the new tree's lockfile when present: prefer `pnpm-lock.yaml` → `pnpm install`; `bun.lock`/`bun.lockb` → `bun install`; `package-lock.json` → `npm ci` (else skip or documented fallback). **Never** install global CLIs / runtimes. **No** whole-tree `node_modules` symlink to the identity root. When a tree carries **several** lockfiles the decision order is fixed: `pnpm` → `bun` → `npm` (first match wins, array order is the SSOT in `worktree-deps.ts`). A **completed** install is recognized by manager-specific evidence — npm `node_modules/.package-lock.json`, pnpm `node_modules/.modules.yaml`, bun a non-empty `node_modules` (bun writes no marker of its own) — never by the bare `node_modules` directory: a half-written tree from a failed install must **not** be treated as ready.
3. Missing package manager binary, missing `package.json`, or install failure → **fail-open**: worktree still created; reply reports linked/skipped/failed reason. Do not roll back the git worktree. The three outcomes are distinct and must not be collapsed: `no_package_json` / `no_lockfile` / `already_resolved` are **skips** (`status: "skipped"` + reason — there was nothing to do), whereas a manager that ran and did not finish is a **failure** (`status: "failed"` — a missing binary, a non-zero exit, or an install that outran its own bound). The install carries its own bound (`PACKAGE_MANAGER_INSTALL_TIMEOUT_MS`, 120 s) and `create-worktree` sits at `timeoutTier: "build"` (5 min), so a slow install reports a typed failure line **inside** the tool result instead of the ACI tier killing the call with a bare `timeout` that discards the receipt. `enter-worktree` runs the same ensure but is **still at the 30 s `default` tier** — see Known risks.
4. Do **not** hard-reject bash-as-reader globally.

### Layer 2 — tool + types

5. Omitting `subagent_type` keeps default **`general-purpose`**. `explore` must be requested explicitly (readonly).
6. TUI does **not** add `/<agent-id>` slash entries. Main agent calls `spawn_subagent` against the catalog.

### Layer 3 — runtime

7. At capacity: **reject** with message including **active/max**; **no queue**.
8. Same-turn parallel `spawn_subagent` allowed up to cap (`isConcurrencySafe` stays true).
9. `wait` default **true**.
10. Workers **cannot** nest-spawn.

## Known risks

- **`enter-worktree` still carries the 30 s `default` tier while running the same bounded install.** The install bound is 120 s and a real `npm ci` was measured at 53 s, so an `enter` that has to install deps in a large tree can be killed by its tier first: the model gets a bare `timeout` and the install line is dropped — the exact failure `create-worktree` was raised to `build` to avoid. Registered rather than fixed because `enter-worktree.ts` is outside this repair's write scope; the remedy is the same one-line tier raise, and until it lands the `enter` receipt is only reliable for trees whose install fits in 30 s (a tree whose deps were already installed always fits — the ensure is a marker check).
- **The ≤3-worker discipline has no code gate.** The dispatch lesson ("keep at most 3 sub-agents in flight for operator workflows") is a _working discipline_, not the enforced cap: `DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS` is 15 and the runtime rejects only past 15 (`SubAgentCapacityError`). A model that ignores the lesson can therefore run up to 15 workers; nothing in this feature detects or penalizes that. Deliberately registered here rather than fixed — the cap is out of scope for this spec, and inventing a second gate for the discipline would make the lesson and the enforcement disagree in a new way.

## Out of scope

- Changing default concurrent cap from 15 to 3 (operator prompt enforces ≤3 for measured workflow; see Known risks — the discipline is untested by design)
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
