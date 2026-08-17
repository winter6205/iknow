# 0019. workspace-root 让 per-root 状态跟随启动根目录，global 配置保持共享

Date: 2026-08-17

Status: accepted

## Context

当前 iknow 在任意根目录启动时，identity workspace seed（`user.md` / `BOOTSTRAP.md` / `state.json`）、memory store、serve data、settings 写回 fallback 全部隐式跟随 `~/.iknow` —— 用户在多项目根目录间切换时，无法做到「每个根目录的 iknow per-root 状态相互隔离，而 global 配置跨根目录共享」。前置约束（本 ADR 均不位移）：ADR-0009（memory layered injection）锁定 user-level = `~/.iknow`、project-level = `<cwd>/AGENTS.md`，memory 读序与 slot 已定；ADR-0010（memory-injection landing）锁定 `IKNOW_ASSEMBLY_ORDER` 顺序与 slot 索引；ADR-0015（settings.json single source）锁定 settings merge 的 `home` 参数为 global config anchor。本 ADR 引入 `workspaceRoot` 作为**新增维度**（per-root state anchor），不是替换这三个 ADR 的任何语义。

## Decision

引入 `workspaceRoot` 作为 per-root state anchor（默认 = `process.cwd()`），与 `home`（global config anchor，默认 `homedir()`）在装配层解耦。五个子决策：

### 1. workspace-root default = `process.cwd()`（D1.1）

**Recommended: default = `process.cwd()`**。Faithful Claude-Code adapter；满足用户「per-root state differs, global same」诉求。迁移顾虑：既有用户在项目目录跑 iknow 会看到 identity/memory 迁移到该目录的 `.iknow`。缓解：一个 release 的 `--workspace-root $HOME` opt-out 迁移窗口。Counter-option：default = `homedir()`（保持现状，per-root 仅显式 opt-in）被 reject —— 与用户陈述的 per-root 模型冲突。

### 2. host-init 保持 global（D1.2）

`host-init` script（`~/.iknow/init.sh`）是 per-machine（用户书写的 machine init），不是 per-project。`src/harness/identity/host-init.ts:34` 继续默认 `homedir()/.iknow/init.sh`，**不** thread `workspaceRoot`。

### 3. settings 写回 fallback（无 project settings.json 时）→ workspace root（D1.3）

**Recommended: workspace root**。fallback 目标 = `<workspaceRoot>/.iknow/settings.json`（mkdir -p），**不是** `<home>/.iknow/settings.json`。Rationale：这正是用户抱怨污染 global 的路径；per-root 模式下重定向将彻底杀死 global-pollution 路径。

### 4. `user.md` / `BOOTSTRAP.md` reads 跟随 workspaceRoot（D1.4）

**Recommended: per-root**。`identity/assemble.ts` 的 `readUserProfile` / `readBootstrapIfNeeded` 从 `path.join(ctx.userHome, ".iknow")` 改为 `path.join(ctx.workspaceRoot, ".iknow")` —— user.md / BOOTSTRAP.md 读取路径 = `<workspaceRoot>/.iknow/{user.md, BOOTSTRAP.md}`，**不是** `~/.iknow/...`。Rationale：用户陈述「per-root state differs」；persona state 属于 per-root。这是 ACR axis 1（bounded-context-guardian）要点 —— 若 `assemble.ts` 仍留在 `userHome` 上会静默拆散 end-state。

### 5. `IKNOW_WORKSPACE_ROOT` env SSOT 注册（D1.5）

**Recommended: register** at `src/config/env.ts`。env SSOT 表是项目约定；`envOptional` 是 canonical reader。**resolver 内不直接读 `process.env`** —— 通过 SSOT 读取。CLI flag `--workspace-root <dir>` mirror `--data-dir` 模式（`src/cli/parse-args.ts:220-225`）加入。

## Consequences

### Positive

- `home` 与 `workspaceRoot` 两条 anchor 显式拆分：settings merge / user-level memory global scope / host-init 仍由 `home` 权威（ADR-0009/0015 不变），per-root 状态由 `workspaceRoot` 权威。
- 用 `--workspace-root <dir>` 启动 throwaway dir 可获得完全隔离的 identity / memory / serve / settings，不触碰 `~/.iknow`。

### Negative / Trade-offs

- 既有用户在项目目录启动会看到 identity/memory 迁移到该目录 `.iknow` —— 一个 release 的 `--workspace-root $HOME` opt-out 迁移窗口兜底。
- `assemble.ts` 的 persona 读取（user.md / BOOTSTRAP.md）默认不再从 `~/.iknow` 读 —— 若用户期望这些是 global，需要显式 `--workspace-root $HOME`。

### Concrete Quiddity

- resolver `resolveWorkspaceRoot` 是纯函数（无 I/O），priority chain `[explicit, env, process.cwd()]`；4 种 validation error 抛 `WorkspaceRootError` 判别联合（`empty_explicit` / `empty_env` / `non_absolute` / `not_found`），mirror `IknowIdentityError`。
- `workspaceRoot` **不**加入 `LoopEngineDeps`（per-root consumers 都在 build-engine / tui-deps 层）。
- `fs-policy` protected-path 扩展到 `<workspaceRoot>/.iknow` 及其 children —— 与既有 `<home>/.iknow` 同模式保护。
- tilde expansion（`~`）仍指向 `home`（global）—— tilde 是用户输入便利，workspace 是状态边界。

### Reversibility

- 迁移窗口期内可 `--workspace-root $HOME` 完全还原旧行为；默认切换后每个 root 的 `.iknow` 都是独立目录，删除即还原。

## Evidence

- `plans/workspace-root-launch.md` ACR 5/5 PASS（bounded-context-guardian / defensive-contract-validator / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier）。
- 实施证据由 T1（resolver + CLI flag + env SSOT + 5 boundary classes 测试）→ T2（build-engine / run.tsx / identity / memory / serve 7 个 seam 解耦 + integration probe 4 个 binary asserts）→ T3（settings 写回 fallback 重定向 + concurrent dual-write 测试）→ T4（fs-policy 双 root 保护 + policy-refusal 测试）→ T5（CLAUDE.md / docs/architecture.md / CHANGELOG.md）共 5 commits 提供，各 commit 单逻辑任务。
