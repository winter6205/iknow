# Plan: identity bootstrap 对齐 openharness + 删多余（#196 rev 2026-08-11）

> **Spec**: `specs/196-identity-assembly.md`（Rev 2026-08-11 决策修订块 + §"Bootstrap 机制（rev 2026-08-11 对齐 openharness 隐式完成）" + §"ACI 写工具 extraWriteRoots 对称（rev 2026-08-11）"）
> **Map**: wayfinder:map #196；决策出典：PR #213（14cd709 应急设计）/ #347（挂起"另开 issue 讨论交互"）/ b2f432e（撤回 prompt 过度承诺）/ 本次 Rev 块
> **Tracker**: 本地文件（docs/plans 不入 git），12 bullets 逐条打勾
> **前置隔离**: 本次工作已隔离在 worktree `identity-356-profile-done`（基于 master=33b29a2）；master 上两条误提交（d1beae5/73f23da）已回撤并 format-patch 备份到 `$CLAUDE_JOB_DIR/tmp/`。

## 依赖图

```
D1（决策：agent 写 user.md 是否走 bash）──┐
T1（BOOTSTRAP_TEMPLATE + bootstrapFilePath）┼── T2（seed BOOTSTRAP.md）── T3（装配读文件）──┐
                                          │                                                    │
T7（helpers extraWriteRoots）── T8（write-file）── T9（edit-file）───────────────┼── T10（tests 改造）── T11（docs/spec 收口）
T4（删 IKNOW_BOOTSTRAP_PROMPT）── T5（删 appendIknowUserSections）── T6（删 /profile done）──┘
                                          └── T12（E2E 引导真实 rm）
```

- `[parallel]`：T1 ∥ T4 ∥ T7；T2 依赖 T1；T3 依赖 T2；T5 依赖 T2（append 删除前先确认 seed 就位）；T8/T9 依赖 T7；T10 依赖 T3+T5+T8+T9；T11 依赖全部；T12 依赖 T3+T8+T9
- D1 是实施前决策（写入路径），T1-T12 都可在其后并行推进；D1 结论决定 T8/T9 是否需要

---

## Tracer Bullets

### D1. `[decision]` agent 写 user.md 走哪条路径 `[blocks: T8, T9]`

- **Affects**: 决策记录进 spec Rev 块；不涉代码
- **Acceptance**:
  1. 复核 sandbox 事实：bwrap 把 home `--bind` 进沙箱（`bwrap.ts:49-72`）；hard-walls 不拦 `.iknow` 路径（`SENSITIVE_PATH_FRAGMENTS` 不含）；non-allowlisted 命令走 ask tier（`hard-walls.ts:230`）
  2. 结论二选一：(a) **工具路径**——write_file/edit_file 补 `extraWriteRoots: [~/.iknow]`，agent 直接用 ACI 工具写 user.md / 删 BOOTSTRAP.md；(b) **bash 路径**——引导 prompt 告知 agent 用 bash 写/删。推荐 (a) 工具路径（与 read_file 对称、更稳、agent 更容易做对）
  3. 结论写回 spec Rev 块 D1 裁决区
- **Per-ticket loop**: 复核 → 裁决 → 记录 → 无需 commit（spec 修订并入 T11）

### T1. `[implementation]` BOOTSTRAP_TEMPLATE 文本 + bootstrapFilePath 函数

- **Affects**: `src/harness/identity/bootstrap.ts`、`src/harness/identity/workspace.ts`、`tests/harness/identity/bootstrap-file.test.ts`（新）
- **Acceptance**:
  1. `bootstrap.ts` 导出 `BOOTSTRAP_TEMPLATE`（文件内容，非对话脚本），结尾对齐 ohmo："This file can be deleted when done. If it is gone later, do not assume it should come back."；内容含三节 Goals / Style / When done（对齐 ohmo BOOTSTRAP_TEMPLATE 精神）
  2. `workspace.ts` 新增 `bootstrapFilePath(workspace)` 返回 `<workspace>/BOOTSTRAP.md`（对齐 ohmo `get_bootstrap_path`）
  3. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` initializeIknowWorkspace seed BOOTSTRAP.md

- **Affects**: `src/harness/identity/workspace.ts`、`tests/harness/identity/workspace.test.ts`
- **Acceptance**:
  1. `initializeIknowWorkspace` 在 `bootstrap_seeded=false` 且 BOOTSTRAP.md 不存在时，原子写入 `BOOTSTRAP_TEMPLATE`，随后翻 flag（幂等；文件存在跳过）
  2. seed 顺序：user.md → state.json → BOOTSTRAP.md + 翻 flag；不覆盖用户已改 BOOTSTRAP.md
  3. 返回 state 含 bootstrap_seeded=true（seed 后）；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` 装配层 readBootstrapFile（读文件存在性）

- **Affects**: `src/harness/identity/assemble.ts`、`tests/harness/identity/bootstrap-file.test.ts`
- **Acceptance**:
  1. `readBootstrapIfNeeded` 改为读 BOOTSTRAP.md 文件，存在 → 返回其内容（注入 prompt）；不存在 → undefined（不注入）。**不再读 state.json.bootstrap_seeded**
  2. `assembleIdentityContext` 输入保留 `bootstrapActive` 兼容，但语义从"是否激活"改为"该入口是否参与 bootstrap 装配"（chat/tui/serve 参与；ask 跳过——保持 A12 语义）
  3. 装配顺序 9 段不变，bootstrap 段从第 4 位改读文件；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` 删 IKNOW_BOOTSTRAP_PROMPT（对话脚本常量）

- **Affects**: `src/harness/identity/bootstrap.ts`、`src/harness/identity/index.ts`、`tests/harness/identity/bootstrap.test.ts`
- **Acceptance**:
  1. `IKNOW_BOOTSTRAP_PROMPT` 从 `bootstrap.ts` / `index.ts` 导出中移除（被 `BOOTSTRAP_TEMPLATE` 取代）
  2. `bootstrap.test.ts` 断言从"IKNOW_BOOTSTRAP_PROMPT 是 string"改为"BOOTSTRAP_TEMPLATE 是 string + 含 When done 节"
  3. 全仓 grep `IKNOW_BOOTSTRAP_PROMPT` 零命中；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T5. `[implementation]` 删 appendIknowUserSections + BOOTSTRAP_COMPLETE_SECTIONS

- **Affects**: `src/harness/identity/workspace.ts`、`src/harness/identity/bootstrap.ts`、`src/harness/identity/index.ts`、`tests/harness/identity/workspace.test.ts`
- **Acceptance**:
  1. `appendIknowUserSections` / `BOOTSTRAP_COMPLETE_SECTIONS` 及其 re-export、6 个边界测试全部移除（commit d1beae5 已回撤，本工作树无此代码——确认即可）
  2. 若工作树仍残留（回撤不彻底），移除后全仓 grep 零命中
  3. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T6. `[implementation]` 删 /profile done 三入口钩子

- **Affects**: `src/cli/chat-session.ts`、`src/session-api/hub.ts`、`src/tui/app.tsx`、`tests/cli/slash.test.ts`、`tests/tui/slash.test.ts`
- **Acceptance**:
  1. 三入口 `/profile done` 分支从 slash 词表 + 命令处理中移除（chat-session / hub / app.tsx）
  2. `writeIknowState` 的 caller 清零（bootstrap_seeded 不再被运行时写；仅初始化 seed 时写）—— grep 确认
  3. slash 词表长度回退（tui 词表 8→6 之类）；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T7. `[implementation]` helpers.ts 加 extraWriteRoots 支持

- **Affects**: `src/harness/aci/tools/helpers.ts`、`tests/harness/aci/tools/helpers.test.ts`
- **Acceptance**:
  1. `resolveWithinRoot(root, path, extraReadRoots?, extraWriteRoots?)` 支持可选第 4 参：目标在 extraWriteRoots 内 → 允许写（不抛 path outside fence）
  2. symlink 逃逸仍被拦（extraWriteRoots 内 symlink 指向外 → 拒）；单测覆盖正常写 + 逃逸拒
  3. 不破坏既有 extraReadRoots 行为；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T8. `[implementation]` write_file 传 extraWriteRoots

- **Affects**: `src/harness/aci/tools/write-file.ts`、`tests/harness/aci/tools/write-file.test.ts`
- **Acceptance**:
  1. `createWriteFileTool(root)` 内构造 extraWriteRoots = [~/.iknow]（镜像 read-file.ts:36 的 extraReadRoots），调用 `resolveWithinRoot(root, path, undefined, extraWriteRoots)`
  2. 写 `~/.iknow/user.md` 成功（单测 temp home fixture）；写项目根外其他路径仍拒（path outside fence）
  3. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T9. `[implementation]` edit_file 传 extraWriteRoots

- **Affects**: `src/harness/aci/tools/edit-file.ts`、`tests/harness/aci/tools/edit-file.test.ts`
- **Acceptance**:
  1. 同 T8：`edit_file` 构造 extraWriteRoots = [~/.iknow]，走 resolveWithinRoot 第 4 参
  2. 编辑 `~/.iknow/user.md` 成功（单测）；改项目根外路径仍拒
  3. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T10. `[implementation]` tests 改造对齐（bootstrap-file + workspace 回归）

- **Affects**: `tests/harness/identity/bootstrap-file.test.ts`（新）、`tests/harness/identity/bootstrap.test.ts`（改）、`tests/harness/identity/workspace.test.ts`（改）、`tests/harness/identity/system-injection.test.ts`（改）
- **Acceptance**:
  1. `bootstrap-file.test.ts` 覆盖：seed 存在 → 装配注入；文件缺失 → 不注入；用户删文件 → 二次启动不注入（对齐 openharness 隐式完成）
  2. `workspace.test.ts` 覆盖 seed 幂等（BOOTSTRAP.md 已存在不覆盖）、flag 翻 true、用户已改内容保留
  3. `system-injection.test.ts` "second skip" 断言从 flag 改文件；`bootstrap.test.ts` 从 IKNOW_BOOTSTRAP_PROMPT 改 BOOTSTRAP_TEMPLATE
  4. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T11. `[implementation]` docs/spec 收口（Rev 块 supersede 落定）

- **Affects**: `specs/196-identity-assembly.md`、`docs/STATUS.md`、`docs/handoff/<latest>.md`、`docs/iknow-user-md-patch.md`（如有）
- **Acceptance**:
  1. spec Rev 块 7 项决策全部落地后，把 superseded 旧段收敛（Project Structure 注释、Style 写入显式、Success Criteria、ADR 表）为新语义；Rev 块更新为"已落地"
  2. `docs/STATUS.md` 记录 bootstrap 文件驱动完成机制
  3. 若存在 `docs/iknow-user-md-patch.md`（用户手动补丁指引）——已过时，删除（宿主应用层写入不再需要）
  4. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T12. `[implementation]` E2E 引导对话真实 rm BOOTSTRAP.md

- **Affects**: `tests/e2e/bootstrap-file-acceptance.test.ts`（新）
- **Acceptance**:
  1. stub-model 脚本化全链路：首启装配含 BOOTSTRAP.md 内容 → agent 用工具/命令写 user.md → `rm BOOTSTRAP.md` → 二次装配不含 bootstrap 段
  2. 断言：首启 system prompt 含 "# First-Run Bootstrap"；删文件后二次不含；user.md 内容在 turn 级别生效
  3. `npm test` + `npm run typecheck` exit 0
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Commit 纪律

- 每 bullet ≤1 commit、独立票分支（或单 worktree 顺序 commit）；12 bullets ≈ 12 commits（自然满足 ≥4 逻辑分组：①T1-T3 文件驱动 seed ②T4-T6 删旧机制 ③T7-T9 extraWriteRoots ④T10-T12 测试/收口/E2E）
- E2E 真 LLM 冒烟不入本 plan 自动化：引导对话是否真的让 agent 自己删文件——由 T12 脚本化 stub 覆盖；真 LLM 走手工 smoke
