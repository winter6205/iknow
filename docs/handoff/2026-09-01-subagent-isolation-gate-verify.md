# Session Handoff — subagent-isolation-gate T3/T4 验收坐实 (2026-09-01)

## 当前 live 状态

- **任务**: 在 `worktree-subagent-isolation-gate` worktree 上坐实 T3 / T4 验收 —— T3（`332d9742 refactor(subagent): centralize catalog capability derivation`）的「零行为变化」二选一（实测对比基线 vs 当前工具面）；T4（worktree rebind worker root）的 `sandboxRoot` 真断言；并把 4 条 High 修复 commit 收口 merge 回 master。
- **为什么重要**: T3 自我声明「without changing existing wire or tool-surface behavior」—— 该声明目前无 ground truth。要么证实、要么二选一改实现 / 改契约。T4 的 fake manager 只记录 task/result 没断言 sandboxRoot，导致「重派落在 task worktree」这条契约从未被证明。
- **operator 显式指令（本 session）**:
  - 「三个名额跑满」—— T3/T4 验收 + Medium 清理 + CLI 丢结果，三个并发轨道
  - 「T3 声称零行为变化，如果实测下来确实变了，那就不许既保留变化又继续宣称零变化——只能二选一」
  - 「从主仓另建临时 worktree 指向 `332d9742^`（T3 之前）去取真实工具面做对比」
  - 「会话中断，现在需要写交接，下一会话继续」

## 已固化工件（引用，不复制 inline）

| 类型          | 路径 / SHA                                                                                                                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 领域词汇      | `docs/CONTEXT.md`（worktree-isolation / task-worktree / rebind / sandboxRoot / 跨会话泄漏 等术语）                                                                                                                                             |
| 主计划 ①      | `plans/worktree-isolation-model-provision.md`（T1–T8 总盘 + mutate gate 形状 + 三件套 ACI 工具面契约；**当前 master 工作树已删**，权威版从 `f68580a0^{tree}` 取）                                                                              |
| 主计划 ②      | `plans/worktree-session-roots.md`（rebind 时只换 taskRoot，identity + per-root 状态留在 productRoot；**当前 master 工作树已删**，权威版从 `da01fde4^{tree}` 取）                                                                               |
| 决策记录      | `docs/adr/0037-worktree-isolation-on-mutate.md`（rebind / gate 修的根章程，`9b4e4612` 修订为 model-provisioned 形态）；`f6137d61 docs(adr): rebind switches taskRoot only; identity and per-root state stay on productRoot`（plan ② 配套 ADR） |
| 关联 plan     | `plans/worktree-mcp-rebind-lifecycle.md`（MCP 配套）；`plans/worktree-isolation-on-mutate.md`（早期版，archive 化）                                                                                                                            |
| T3 / T4 issue | T3 = `332d9742` commit；T4 = `feat(harness): assert rebound worker root in envelope`（`af7624e6`）                                                                                                                                             |
| T8 issue      | #839（enter / exit 对称）；T5 issue #840（subagents 继承 rebound session root）                                                                                                                                                                |
| 上轮 handoff  | `docs/handoff/2026-08-31-worktree-isolation-bug-fixes.md`（tui-real-test-30min 分支，bug-1/2 真修 + 测试覆盖）                                                                                                                                 |

> 注：主计划 ①/② 在 master 工作树已删（`D  plans/worktree-isolation-model-provision.md`、`D  plans/worktree-session-roots.md`），但 plan 权威性没动 —— 仍以 `f68580a0^{tree}` / `da01fde4^{tree}` 为准。下个 agent 取 plan 时直接 `git show <sha>:plans/<file>.md` 或 `git checkout <sha> -- plans/<file>.md` 拉回。

## 本 session 变更（定位阶段，零代码）

| 变更                                                        | 一行效果                  |
| ----------------------------------------------------------- | ------------------------- |
| `docs/handoff/2026-09-01-subagent-isolation-gate-verify.md` | 新建交接文件（本 commit） |

> 本 session **没有写任何业务代码**。所有诊断命令、提交树读取、worktree 状态扫描均在 `/home/winner/projects/iknow`（master）只读侧执行。

## 关键状态定位（已验证）

### 验证方工作位置

```
$ git worktree list | grep subagent-isolation-gate
/home/winner/projects/iknow/.claude/worktrees/subagent-isolation-gate   af7624e6 [worktree-subagent-isolation-gate]
=> exit 0
```

### 相对 master 领先（17 commit，含 T3 + 4 条 High 修复 + T4 沙箱根断言 + 若干 pre-T3 ancestor）

```
$ git -C <worktree> log --oneline master..HEAD
af7624e6 test(harness): assert rebound worker root in envelope              ← T4 沙箱根断言
a2a9d59d test(subagent): record role-aware worker surface contract
4a1127a0 fix(session): scope subagent aggregation by conversation            ← 跨会话泄漏
845ee2fa fix(permission): reject late approvals after abort                  ← 迟到批准
d1645705 fix(security): close readonly bash write escapes                    ← 沙箱逃逸
c16ac3a7 fix(harness): classify subagent file-write capabilities             ← symbol 写工具绕过
5f5cceb2 docs(plan): record unresolved Ctrl+C symptom coverage
5d757c00 fix(harness): wire caller abort through ACI permission gate
1c51ae43 fix(permission): cancel pending prompts on abort
0517ecb1 fix(harness): gate subagent dispatch by capabilities
31a7e900 fix(harness): preempt cancellable tool waits on caller abort
9087b5b5 fix(session-api): aggregate subagent managers across rebind
ee2f311d fix(tui): let graph focus handle Ctrl+C
106480fe fix(tui): expose Ctrl+C disposition paths
332d9742 refactor(subagent): centralize catalog capability derivation       ← T3 自身
7c20c021 docs(adr): define subagent identity and dispatch gate              ← T3 基线
9f28ae07 docs(adr): settle non-cancellable wait semantics
=> exit 0
```

### T3 对比基线（pre-T3 真实工具面）

```
$ git rev-parse 332d9742^ 7c20c021
7c20c0211e43076dfc291d427c334af417ff99fe
7c20c0211e43076dfc291d427c334af417ff99fe
=> exit 0  ← 同 SHA，user 描述与 git 真实对齐
```

```
$ git worktree list | grep t3-baseline
/tmp/t3-baseline   7c20c021 (detached HEAD) prunable
=> exit 0
```

### 验证方未提交的脏改动（T4 沙箱根断言 + TUI 收口）

```
$ git -C <worktree> status --short
 M src/cli/chat-session.ts
 M src/harness/aci/aci-executor.ts
 M src/harness/subagent/host-drain.ts
 M src/harness/tools/types.ts
 M src/tui/app.tsx                                                          ← 包含 listSubagents 跨会话侧收口痕迹
 M tests/cli/chat-session-rebind.test.ts
 M tests/harness/aci/interrupt-routing.test.ts
 M tests/tui/interrupt-notice.test.tsx
?? plans/subagent-isolation-gate.md                                          ← 验证方在写的 plan，未读
=> exit 0
```

> `plans/subagent-isolation-gate.md` 是验证方 WIP 中的 plan 文件，本 session 未读其内容。下一会话接手时建议先 read 一遍，对照 plan ①/② 看是否要重定向 plan SSOT。

### TUI listSubagents 跨会话泄漏（已确认未堵）

```
$ grep -n "listSubagents" src/tui/hub-bridge.ts
173:  readonly listSubagents: () => ReadonlyArray<SubagentInfo>;             ← 无 conversationId
394:    listSubagents: () => opts.subagentManager?.listSubagents() ?? [],    ← 无 conversationId
=> exit 0

$ grep -n "listSubagents" src/harness/subagent/manager.ts
1094:  function listSubagents(): ReadonlyArray<SubagentInfo> {                ← 全量遍历 tasks.values()
=> exit 0
```

> HTTP 层有 `listSubagentsForSession(conversationId)`（`session-api/hub.ts:927`）做正确示范。TUI bridge 这条没接，面板会跨会话泄漏。app.tsx 调用点实际在 `app.tsx:1021`（不是 1034 —— user 表述有漂移）。

## 已验证状态

```
$ git status --short | wc -l
=> 60 行（master 工作树脏改，纯 docs/与plan 删除；不是本 session 引入）

$ git log --oneline -1
66469c0b fix(harness): 会话改绑不再搬走项目身份与 per-root 状态 (#861)
=> exit 0

$ git branch --show-current
master
=> exit 0

$ git worktree list | wc -l
=> 41 个 worktree（其中 subagent-isolation-gate 是验证方主场；/tmp/t3-baseline 是 T3 对比基线）
```

未跑：`npm test`、`npm run test:real-llm`、`npm run probe:*` —— 本 session 是诊断 / 定位，不跑测试。

## Open blockers + next steps

**[NEXT] 在 `/home/winner/projects/iknow/.claude/worktrees/subagent-isolation-gate` 工作树下，先 read `plans/subagent-isolation-gate.md`（验证方 WIP 中的 plan）对照 plan ①/② 的权威版（`f68580a0^{tree}:plans/worktree-isolation-model-provision.md`、`da01fde4^{tree}:plans/worktree-session-roots.md`），决定是否把 SSOT 改写到这份 WIP 上。SSOT 决策落地后，按下述顺序收口：(a) 把 T3 二选一的判定结果写到 commit message（零变化证实 → 接受契约；真变了 → 改实现恢复 / 显式更新契约并写 RED 测试，三选一必须留文字证据）；(b) 把 T4 sandboxRoot 真断言那条 commit（`af7624e6`）+ 8 个未 commit 脏改动合成独立 PR；(c) 与 `4a1127a0` / `845ee2fa` / `d1645705` / `c16ac3a7`（4 条 High 修复 commit）合并走 PR；每条 PR 过 `arthurpower:code-review` 双轴后再 merge。**

- 待办（独立项，不阻塞 NEXT）：
  - `app.tsx:1021` 的 `props.bridge.listSubagents()` —— bridge 类型补 `conversationId` 参数，app.tsx 传 `active.conversationId` 下去，堵 TUI 面板跨会话泄漏。等 app.tsx 空出来再补（user 原话）。
  - 5 条 High 中剩余 1 条（CLI 丢结果）在 master 这边 in_progress 中 —— 移交前未跑完。
  - Medium 清理轨道未合并入本 handoff 范围。
- 不在本任务范围：MCP rebind 收口（`plans/worktree-mcp-rebind-lifecycle.md`）、lsp-optimization、auto-memory 落地。

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:test-driven-development` — T3 二选一判定后写 RED 测试固化契约
- `arthurpower:code-review` — 每条 PR merge 前双轴（spec 对 plan ①/②；standards 对 6 smells）
- `arthurpower:verification-before-completion` — push 前 ground truth 复跑（`tests/harness/aci/`、`tests/session-api/`、`tests/tui/` 至少全量 vitest）
- `arthurpower:architecture-change-reviewer` — 若 T3 真变了要改实现 / 改契约时必跑
- `arthurpower:domain-modeling` — 若 T3 真变了需更新 `docs/CONTEXT.md` 术语或新立 ADR

## 脱敏

- 无 API key / token / password / credential 值出现
- 凭据一律用环境变量名（`ANTHROPIC_AUTH_TOKEN`、`IKNOW_LLM_BASE_URL`、`IKNOW_WORKSPACE_ROOT`），不写值
- 真配置在 `/home/winner/projects/iknow/.env.local`，本工作树 `.iknow/settings.json` 仅引用占位符
- `/tmp/t3-baseline` 是 detached HEAD + prunable worktree，**不在项目树内**，仅做工具面对比
