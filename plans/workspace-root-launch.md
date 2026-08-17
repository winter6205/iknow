# Plan — `workspace-root` per-root launch

**Feature**: 让 iknow 在任意根目录启动时，per-root 状态（identity workspace seed、memory store、serve data、settings 写回 fallback）跟从该根目录；global 配置（`settings.json` merge fallback、user-level AGENTS.md、user rules、settings watcher、host-init）保持共享。

**Tracker**: GitHub（gh auth 已在 github.com 登录，origin = `winter6205/iknow.git`，issue tracker = main path，非 fallback）。

**Status of ACR cross-check (PASS — hand to writing-plans)**:

```
bounded-context-guardian: yes — T2 covers both identity/workspace.ts:27 and identity/assemble.ts:194-233; resolveWorkspaceRoot in src/config/ consumed by harness/tui/session-api follows existing build-engine→config import (no new cross-context edge); identity/memory/serve/aci/settings remain separate modules, sliced by capability not technical layer.
defensive-contract-validator: yes — T1 enumerates all 5 boundary classes from .claude/rules/test.md (empty_explicit, empty_env, non_absolute, not_found overflow, concurrent parallel resolve, exception nonexistent path); T3 adds concurrent dual-TUI same-workspace tmp-rename atomic-write test; T2 integration probe is binary asserts (test -f, hash compare).
error-handling-enforcer: yes — T1 specifies WorkspaceRootError discriminated union mirroring IknowIdentityError at identity/workspace.ts:37-41; resolver throws typed (not silent fallback); workspace.ts:185-196 initIknowWorkspaceSafe retains existing try/catch + warn discipline; 4 kinds enumerated (empty_explicit/empty_env/non_absolute/not_found).
complexity-anti-drift: yes — resolver ≤5 cyclomatic branches (well under 10-branch trigger); param-threading across 7 files in T2 is necessary for the per-root capability, not god-function drift; T3 and T4 are per-file small edits; T5 is docs.
minimal-change-verifier: yes — T2 explicitly forbids adding workspaceRoot to LoopEngineDeps (per-root consumers all live at BuildHarnessEngineOptions/BuildTuiDepsOptions layer); T1 registers IKNOW_WORKSPACE_ROOT in src/config/env.ts env-SSOT; assemble.ts:194-233 IS in T2; lockfile untouched (no package.json changes in T1-T5); diff scope matches per-root state isolation only.
OVERALL: PASS — hand to writing-plans
```

**Spec / contracts consumed** (NOT produced by this plan):

- ADR-0009 (memory layered injection) — `user-level = ~/.iknow`, project-level = `<cwd>/AGENTS.md`；auto memory lives under `~/.iknow/memory/<base>-<hash>/`. The change threads `workspaceRoot` as a NEW dimension without displacing user-level globals.
- ADR-0010 (memory-injection landing) — `IKNOW_ASSEMBLY_ORDER` LOCKED, memory_layer slot reserved. The change does not alter segment order or slot indices.
- ADR-0015 (settings.json single source) — `home` parameter remains the global-config anchor for settings merge; the new `workspaceRoot` parameter is added for per-root state only.

---

## D1. `[decision]` Per-root workspace semantics + home/workspace decoupling contract + 4 sub-decisions

**Affects**: `src/config/workspace-root.ts` (new, interface surface) + every downstream consumer's `home` vs `workspaceRoot` resolution.

**Acceptance**: This decision is recorded as an ADR. Five binary answers; each is yes/no + one-line rationale. After approval, all `[implementation]` bullets below use the recorded answers verbatim.

- **D1.1** workspace-root default (when no `--workspace-root` and no `IKNOW_WORKSPACE_ROOT` env):
  - **Recommended: default = `process.cwd()`**. Faithful Claude-Code adapter; user explicitly asked for "per-root state differs, global same". Migration concern: existing users running iknow from project dirs will see identity/memory relocate to that dir's `.iknow`. Mitigation: a one-release `--workspace-root $HOME` opt-out for the migration window.
  - Counter-option: default = `homedir()` (current behaviour preserved, per-root only when explicit opt-in). Rejected: contradicts stated user model.
- **D1.2** host-init script (`~/.iknow/init.sh`):
  - **Recommended: keep global**. `host-init` is one-per-machine (user-authored machine init), not one-per-project. `src/harness/identity/host-init.ts:34` continues to default to `homedir()/.iknow/init.sh`; no `workspaceRoot` parameter threaded.
- **D1.3** settings write-back fallback target when no project settings file exists:
  - **Recommended: workspace root**. `<workspaceRoot>/.iknow/settings.json` (mkdir -p), NOT `<home>/.iknow/settings.json`. Rationale: this is the exact path the user complained about polluting global; redirecting kills the global-pollution path entirely under per-root mode.
- **D1.4** `user.md` / `BOOTSTRAP.md` reads in `identity/assemble.ts:194-233`:
  - **Recommended: per-root** (follow `workspaceRoot`). Rationale: user stated "per-root state differs"; persona state is per-root in this model. The reads become `<workspaceRoot>/.iknow/{user.md, BOOTSTRAP.md}`, NOT `~/.iknow/...`. This is the explicit fix for ACR axis 1 (bounded-context-guardian: no) — leaving `assemble.ts` on `userHome` would silently split the end-state.
- **D1.5** `IKNOW_WORKSPACE_ROOT` env SSOT registration:
  - **Recommended: register** at `src/config/env.ts` even though this skill uses the value directly. Reasoning: env SSOT table is the project convention; `envOptional` is the canonical reader. **Drop the direct `process.env` read inside the resolver** — read via the SSOT.

---

## T1. `[implementation]` workspace-root resolver + CLI flag + env-SSOT registration

- **Affects**:
  - NEW `src/config/workspace-root.ts` — pure resolver, no I/O.
  - NEW `src/config/workspace-root.test.ts` — boundary class coverage (test.md mandates 5 classes).
  - `src/cli/parse-args.ts` — add `--workspace-root <dir>` value-flag (mirror `--data-dir` pattern at line 220-225).
  - `src/config/env.ts` — add `IKNOW_WORKSPACE_ROOT` to env-SSOT table (per ADR-0015 env-handler convention; resolver consumes via env SSOT, not direct `process.env`).
- **Acceptance** (binary):
  - `npm test -- src/config/workspace-root.test.ts` exits 0 with **all 5 boundary classes** per `.claude/rules/test.md`:
    1. **empty** — `explicit = ""` → throw `WorkspaceRootError{ kind: "empty_explicit" }`; `IKNOW_WORKSPACE_ROOT = ""` → throw `kind: "empty_env"`.
    2. **negative** — `explicit = "not/absolute"` (relative path) → throw `kind: "non_absolute"`.
    3. **overflow** — `explicit = "/" + "x".repeat(8192)` → throw `kind: "non_absolute"` or `not_found` (binary: does not crash; does not silently truncate).
    4. **concurrent** — two parallel `resolveWorkspaceRoot` calls with different explicit → both succeed with their respective roots, no shared mutable state.
    5. **exception** — `explicit` is a non-existent absolute path → throw `kind: "not_found"`.
  - **Happy path**: priority chain `[explicit, env, process.cwd()]` returns in order. With all three unset, returns `process.cwd()`.
  - `node dist/cli.js --help` lists `--workspace-root <dir>` in the usage output.
  - `node dist/cli.js chat --workspace-root /tmp/x` runs without crash; `process.exit(0)` or expected exit.
- **Resolver contract** (precise, mirrors `IknowIdentityError` discriminated union at `identity/workspace.ts:37-41`):
  ```ts
  export type WorkspaceRootError =
    | { kind: "empty_explicit"; path: string }
    | { kind: "empty_env"; varName: "IKNOW_WORKSPACE_ROOT" }
    | { kind: "non_absolute"; path: string }
    | { kind: "not_found"; path: string };
  export function resolveWorkspaceRoot(opts?: {
    explicit?: string;
    cwd?: string;
    env?: Record<string, string | undefined>;
  }): string;
  ```
  - Cyclomatic scope: ≤5 branches (3 priority slots + 4 validation guards), well under the 10-branch hard trigger.
  - No I/O. Pure. Testable without touching fs / env.
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch.

---

## T2. `[implementation]` Decouple `home` (global config) from `workspaceRoot` (per-root state) at assembly seams

- **Affects**:
  - `src/harness/build-engine.ts:75-120, 187-230` — split `BuildHarnessEngineOptions.userHome` (global-config anchor, default `homedir()`) from new `BuildHarnessEngineOptions.workspaceRoot` (per-root state anchor, default `resolveWorkspaceRoot({explicit})`). **NOT** added to `LoopEngineDeps` (ACR minimal-change-verifier:unclear — over-scoped; per-root consumers all live at the build-engine / tui-deps layer).
  - `src/tui/run.tsx:133-168` — resolve `workspaceRoot` at startup; pass into `run()` and into the assembly sites. `home` parameter (line 135) stays `homedir()`.
  - `src/harness/identity/workspace.ts:27` — `iknowWorkspaceRoot()` → `resolveWorkspaceRoot()`. Identity workspace seed (user.md / state.json / BOOTSTRAP.md) follows workspace.
  - `src/harness/identity/assemble.ts:194-233` — `readUserProfile` / `readBootstrapIfNeeded` accept `workspaceRoot` via `AssemblyContext`. Read paths switch from `path.join(ctx.userHome, ".iknow")` to `<ctx.workspaceRoot>/.iknow/{user.md, BOOTSTRAP.md}`. **CRITICAL** (ACR axis 1: without this the feature is half-wired).
  - `src/session-api/serve.ts:43-60` — `resolveServeDataDir(dataDir, workspaceRoot?)` resolution order: explicit `dataDir` > `workspaceRoot/.iknow` > `homedir()/.iknow`. Same `workspaceRoot` flows into serve's `initIknowWorkspaceSafe` + `runHostInitScriptSafe` calls.
  - `src/harness/memory/paths.ts:21-30` — `resolveProjectMemoryDir(cwd, workspaceRoot)` and `resolveUserMemoryDir(workspaceRoot)` accept an explicit `workspaceRoot`. `resolveUserMemoryDir` joins the new arg, defaulting to `resolveWorkspaceRoot()`. Decision: **per-root memory** (D1 aligned with user's stated model).
  - `src/harness/memory/assembly.ts:46-71` — `AssemblyContext` adds `workspaceRoot` field; `loadStaticLayer` uses it for **both** `user` and `project` scope roots (the layering is user/project content-wise, but the physical root now resolves via workspaceRoot — keeping ADR-0009 user-level semantics for the read-order precedence).
  - `src/harness/identity/host-init.ts:34` — **NOT modified** (D1.2 keeps host-init global). No `workspaceRoot` threading here.
- **Acceptance** (binary):
  - `npm test -- src/harness/identity/ src/harness/memory/ src/session-api/` exits 0; existing tests still pass (the `opts.home` / `opts.userHome` seams continue to work; the new `workspaceRoot` is additive with safe defaults).
  - **Integration probe** (the verification-before-completion ritual's actual evidence):
    ```bash
    FAKE=$(mktemp -d)
    REAL_HOME_HASH_BEFORE=$(sha256sum ~/.iknow/state.json 2>/dev/null | awk '{print $1}')
    node dist/cli.js chat --workspace-root "$FAKE" "" || true  # whatever exit
    REAL_HOME_HASH_AFTER=$(sha256sum ~/.iknow/state.json 2>/dev/null | awk '{print $1}')
    # binary asserts:
    test -f "$FAKE/.iknow/user.md"      # identity seeded under workspace
    test -f "$FAKE/.iknow/state.json"   # identity state under workspace
    test -d "$FAKE/.iknow/memory"       # memory root under workspace
    test "$REAL_HOME_HASH_BEFORE" = "$REAL_HOME_HASH_AFTER"  # global untouched
    ```
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch.

---

## T3. `[implementation]` Settings write-back fallback target → workspace root (kill global-pollution path)

- **Affects**:
  - `src/config/persist-settings.ts:147-156` — `resolveThinkingSettingsPath({cwd, workspaceRoot, home?})`: project file exists → project; else → `<workspaceRoot>/.iknow/settings.json` (mkdir -p the dir). Add `workspaceRoot?: string` to `ResolveSettingsPathOptions`.
  - `src/tui/run.tsx:154-168` — `persistThinking` callback uses resolved `workspaceRoot` instead of hardcoded `homedir()`.
  - `src/config/settings-write-back.test.ts` (or extend existing) — cover the redirect path AND the concurrent-double-write path.
- **Acceptance** (binary):
  - **Single-TUI redirect**: open thinking-panel, Esc → settings.json created at `<workspaceRoot>/.iknow/settings.json`; `~/.iknow/settings.json` hash unchanged.
  - **Concurrent dual-TUI same-workspace** (boundary class `concurrent` from test.md): two `persistThinkingChanges(<same>/.iknow/settings.json, patch1)` and `patch2` fired in parallel via `Promise.all` → atomic rename semantics (existing tmp-file `.settings.json.tmp` rename) guarantee no half-written JSON, no torn file. Test asserts `JSON.parse` succeeds for the final file and contains one of the two patches (not a merge disaster).
  - **Fallback-to-workspace** when no project file: `resolveThinkingSettingsPath({cwd: "/tmp/x", workspaceRoot: "/tmp/y"})` returns `/tmp/y/.iknow/settings.json` (NOT `/tmp/x/.iknow/settings.json`, NOT home).
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch.

---

## T4. `[implementation]` fs-policy protection covers workspace-root state files

- **Affects**:
  - `src/harness/sandbox/fs-policy.ts:50-88` — protected-path list extended to include `<workspaceRoot>/.iknow` AND its protected children (`user.md`, `state.json`, `BOOTSTRAP.md`, `memory/`, `skills/`). Same pattern as existing `<home>/.iknow` coverage.
  - `src/harness/aci/tools/read-file.ts:28-36` — uses extended policy.
  - `src/harness/aci/tools/bash.ts:37` — `createFsPolicy({home, workspaceRoot})`; both roots protected.
  - `src/harness/aci/tools/registry.ts:236-241` — registry flows `workspaceRoot` through to all fs-touching tool factories.
  - `src/harness/aci/tools/helpers.ts:51-77` — `~` expansion unchanged (tilde = home, still global). Documented as a deliberate distinction (tilde expansion is user input convenience; workspace is the state boundary).
  - NEW `src/harness/sandbox/fs-policy.test.ts` (or extend existing) — policy test covering BOTH roots.
- **Acceptance** (binary):
  - `npm test -- src/harness/sandbox/ src/harness/aci/` exits 0.
  - **policy-refusal test**: with `home = $HOME`, `workspaceRoot = $FAKE`, an agent `fs.write` to `$FAKE/.iknow/state.json` is refused with `execution_failed`; same for `$HOME/.iknow/state.json`. `fs.write` to `$FAKE/AGENTS.md` (allowed path) succeeds.
  - **boundary class `negative`**: a `cd $FAKE && fs.read .iknow/state.json` is refused; `fs.read README.md` succeeds.
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch.

---

## T5. `[implementation]` Docs — `IKNOW_WORKSPACE_ROOT` / `--workspace-root` user-facing surface

- **Affects**:
  - `CLAUDE.md` — "Settings 热更新" + "启动入口" section: add `IKNOW_WORKSPACE_ROOT` env + `--workspace-root <dir>` CLI flag description, with typical scenarios (throwaway-dir isolation; per-project state).
  - `docs/architecture.md` — capability table adds `workspace-root` row (resolver + semantics + per-root vs global split).
  - `CHANGELOG.md` — entry under unreleased section.
- **Acceptance** (binary):
  - `grep -E "IKNOW_WORKSPACE_ROOT|--workspace-root" CLAUDE.md` returns ≥2 hits.
  - `grep -E "workspace-root|workspaceRoot" docs/architecture.md` returns ≥1 hit.
  - `CHANGELOG.md` contains a line mentioning the new surface.
- **Per-ticket loop**: tdd (doc-render test: `tests/docs/CLAUDE.md.test.ts` asserts presence of the flag string) → typecheck+tests → code-review → verification-before-completion → commit on ticket branch.

---

## Execution order (dependency graph)

```
D1 ──┬──► T1 ──┬──► T2 ──┬──► T3
     │         │         │
     │         │         └──► T4
     │         └──► T4
     └──► T5 (depends on T1+T2+T3+T4 being green, so docs describe actual behavior)
```

- **Parallelizable**: T3 and T4 are independent of each other (different files, different test seams) — both blockedBy T2. Run after T2 lands.
- **Blocking**: T5 blockedBy all of T1, T2, T3, T4 (docs must describe shipped behaviour).
- **1 commit per bullet**, on its own branch off `worktree-wayfinder-gh-collab-adapt`.

## Verification (post-execution)

1. `cat plans/workspace-root-launch.md | grep -E "^\s*## [DT][0-9]+"` — bullet list present, numbered.
2. `git log --oneline | head -6` — 1 commit per implementation bullet (T1–T5 = 5 commits, plus any decision ADR commit).
3. `git diff --stat HEAD~5..HEAD` — scope matches the per-bullet files list; no scope creep.
4. `npm test` exits 0 (all boundary-class tests green; no skipped tests without explicit reason).
5. Manual integration probe from the T2 acceptance block produces the 4 binary asserts.
