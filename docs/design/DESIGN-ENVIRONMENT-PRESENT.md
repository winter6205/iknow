# DESIGN-ENVIRONMENT-PRESENT · 环境现势 TUI 锚点（#655 G1）

> 包：`horizon-653 / 包1-感知` · G1 验收画像锁定
> Plan：`plans/653-horizon-pkg1-perception.md` T1
> Spec：`specs/653-horizon-pkg1-perception.md` Boundaries · Success Criteria
> 状态：决议（2026-08-24，钉死 T1）

## Context

`#655` G1 要求 TUI 操作员一眼看到工作区现势（cwd / git 摘要 / diff 要点），
且 **不**污染 ADR-0028 状态栏（`agent_status` user 消息）。spec 已明确：

- 数据**给人不给模型**——**不**进 `messages`、**不**当 verify 输入、**不**进
  ADR-0028 状态栏 user 消息。
- 锚点由 plan 在 banner 旁 / strip / footer 之一**钉死一个**固定落点。
- 摘要默认 **2000 codepoints** 上限（plan 可调数字，不得取消上限）。
- 失败态（cwd 不可解析 / 非 git / 刷新抛错）走 degraded 占位，**不 throw**。

TUI 已有一个 `AgentStatusLine`（`src/tui/agent-status-line.tsx`），是**模型向
状态栏**（ADR-0028）在 TUI chrome 的**只读投影**——读的是 `agent_status` 流事件
/ 快照，**不**反向写。两套概念（人读 vs. 模型向）若共用同一条流 / 同一槽位，会
出现「人读字段被模型读走」或「模型字段被人读 UI 误投影」的双向污染，违反 spec
「不进 messages / 不进 verify 输入 / 不写状态栏」的负向契约。

调研见 Explore 阶段结论：另起 `EnvironmentPane` / `EnvPresenceStrip` 命名（避免
与 `AgentStatusLine` 重名），挂点应是 TUI chrome 区，**不**进 `agent_status`
流事件、**不**进 `messages`。

## Decision

**环境现势 = TUI 人读 chrome 条的新独立槽位，与 `AgentStatusLine` 并列、不复用
其数据源。** 具体决议四条：

1. **锚点**：TUI 人读 chrome 条（与 `AgentStatusLine` 同 chrome 区、并列）。
   - 命名建议：`EnvironmentPane`（含 cwd + git 摘要 + diff 要点整块）或
     `EnvPresenceStrip`（仅 cwd + git 短摘要一行）；二者**不**与 `AgentStatusLine`
     重名。
   - 实现者可两选一，但须**全文一致**——一个组件名 = 一处定义 = 一处挂点。
2. **数据源**：与 `AgentStatusLine` **平行的独立流**——harness / TUI 计算的
   「环境现势快照」事件。
   - **不**复用 `agent_status` 事件；**不**复用其快照结构；**不**走
     `session-api/turn-projection.ts` 现有 verify 投影缝。
   - 快照在用户可见的回合边界刷新；不每 tool 跳追加进模型上下文（spec 刷新
     纪律）。
3. **上限**：摘要 ≤ **2000 codepoints**（`String.prototype.length` 计 Unicode
   码点；超长 diff 走截断 + 显式 `(truncated)` 标记）。
4. **不进 verify 输入**：环境现势组件**不**被 verify / 判官 / goal / advisor
   任何路径读取；其数据流与 `VerificationRecord` 互不交叉。

## Consequences

**正向：**

- 锚点**唯一**，plan Acceptance 可一次 grep 断言（`src/tui/`
  下仅一处 `EnvironmentPane` / `EnvPresenceStrip` 定义 + 挂点）。
- 人读 / 模型向两套流**物理隔离**——`agent_status` 仍是 ADR-0028 状态栏专用，
  环境现势另起新事件类型；任何「把人读字段写进模型栏」的回归都会被编译/类型
  边界拦下。
- 上限 2000 codepoints 写入 Acceptance 强约束，T5（`npx vitest run tests/tui
tests/harness/verify tests/session-api`）的 overflow 路径有据可查。
- 命名 `EnvironmentPane` / `EnvPresenceStrip` 避开 `AgentStatusLine` 同名
  冲突，避免后人误以为「同一组件换个数据源」即可接。

**负向（必须守住）：**

- **不**进 `agent_status` 追加路径——grep `agent_status` 在
  `src/tui/environment-*.tsx` / `src/harness/env-snapshot.ts` 类新增文件中
  应**零命中**（T5 收尾 grep 反向契约）。
- **不**进 `messages`——快照消费侧（`src/tui/**`）**不**调用
  `messages.push` / 不向 hub 提交任何含 cwd/git/diff 的 user 消息。
- **不**当 verify 输入——`VerificationRecord` / hub 任何读路径
  **不**反向引 `EnvSnapshot` / `EnvironmentPane`。
- **不**写 ADR-0028 状态栏——`src/harness/agent-status.ts` / `build-engine.ts`
  的状态栏写入路径**不**接收 cwd/git/diff 字段。

**EXIT（typed failure 边界，spec Boundaries 节对齐）：**

- cwd 不可解析 → 占位 `(cwd unavailable)`，**不 throw**。
- 非 git 工作区 / `git` 失败 → `(not a git repo)` / `(git unavailable)`，
  **不 throw**。
- 刷新抛错 → 保留上一帧快照或占位；错误进 trace/log 旁路，**不**进模型上下文。
- 整段快照缺席 → 组件静默缺席（**不**渲染占位行），避免空字符串进 UI。

**验收锚点（plan T1 Acceptance 收口）：**

- 本决议文件存在并指向唯一组件名 → `plans/653-horizon-pkg1-perception.md` T1
  bullet `Status: [x] done — <commit sha>`。
- T5 收尾：`src/tui/` 下 `EnvironmentPane` / `EnvPresenceStrip` **唯一**
  定义 + 挂点；`grep -r agent_status src/tui/environment-*` **零命中**；
  `npx vitest run tests/tui tests/harness/verify tests/session-api` 绿。
