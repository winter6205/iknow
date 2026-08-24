# Spec: horizon-653 / 包1-感知（Verify 可见 + 环境现势）

> Wayfinder map: [#653](https://github.com/winter6205/iknow/issues/653) · G3 包1 · Assumptions gate confirmed 2026-08-24

## Objective

让单 agent 在 **TUI 主路径**上，把已有的「约束—验证—纠正」内核变成**人可感知**的闭环：验证跑了没有、过没过一眼可见；工作区 cwd / git / diff 对人可见且不污染模型上下文。

用户：TUI 操作者（自动模式与默认 HITL）。成功 = 验证终态在 TUI 有人读提示；环境现势在人读面常在；模型长信封仍隐藏；ADR-0028 状态栏契约不变。

## Boundaries

- **Does:**
  - **Verify 可见（V-b）**：自动模式与默认（HITL）模式，只要本回合跑了验证/确认命令，TUI 显示终态（至少成功 / 失败；内核已有的 `insufficient` / `unstable` 等等价态一并透出）。失败或补跑时可有一条**非聊天气泡**提示。数据源优先复用 `VerificationRecord` / hub 已有 verify 投影；缺「成功」路径则补投影，**不**新造第二套判定逻辑。
  - **信封纪律**：`[VALIDATION FAILED]` / `[VERIFY: rerun needed]` 等给模型的长信封继续经 `isVerifyInjectedText` **隐藏**，不当 ❯ 用户气泡。
  - **环境现势**：TUI 人读面展示至少 cwd、git 摘要（如 branch + dirty/clean）、diff 要点（有上限短摘要）。不写入 ADR-0028 **状态栏** user 消息；不进 `messages`；不充当 verify 输入。
  - **刷新**：至少在用户可见的回合边界刷新环境现势；不得每 tool 跳追加进模型上下文。锚点（banner 旁 / strip / footer 之一）在 plan 定一个固定落点。
  - **失败态（typed / EXIT）**：
    - 缺 `VerificationRecord` 或本回合未跑验证 → **不渲染** verify 人读提示（EXIT：静默缺席，非错误气泡）。
    - 有记录但缺「成功」投影字段 → 宿主补 `passed`（或等价）投影；补齐逻辑失败 → TUI 显示中性「验证结果不可用」一行，**不 throw**、不阻塞聊天（EXIT：degraded）。
    - cwd 不可解析 → 人读面显示显式占位（如 `(cwd unavailable)`），不 throw（EXIT：degraded）。
    - 非 git 工作区 / `git` 失败 → git 摘要用显式 fallback（如 `(not a git repo)` / `(git unavailable)`），不 throw（EXIT：degraded）。
    - 环境现势刷新抛错 → 保留上一帧快照或占位；错误进 trace/log 旁路，不进模型上下文（EXIT：degraded）。
  - **CLI chat**：若与 TUI 共享投影可廉价对齐则做；否则标 Out 留给后续。
- **Confirms with human:** （assumption gate 已收）环境现势 UI 锚点具体组件名；diff/现势摘要默认 **2000 codepoints** 上限（plan 可调数字，不得取消上限）。
- **Out of this spec:**
  - 包2：后台沙箱对齐（S）、并行工具调度（P）— 另开 `653-horizon-pkg2-kernel`（名称 plan/索引约定）。
  - verify-loop / 判官 / goal / evidence-checker **内核**重写；`verify.command` 语义变更。
  - Trace 面板产品 UX 扩展（#284）；Web / SSE（#519）；eval 钩子（#116）。
  - 改 ADR-0028 状态栏字段；把 cwd/git/diff 塞进给模型的状态栏。
  - 澄清轮 / 设计审批 / 持久 PTY / Graph / 多租户鉴权。

## Success Criteria

```bash
npm run typecheck
npx vitest run tests/tui tests/harness/verify tests/session-api
```

每条 yes/no：

- HITL：模拟验证**失败**后，TUI 状态树/视图出现人读失败提示；`isTuiHiddenUserMessage` 仍对 verify 信封返回 true（negative：信封不当聊天气泡）。
- HITL：模拟验证**成功**后，TUI 出现人读成功提示（补齐今日缺 pass 投影的路径）。
- 自动模式（有 `goal`）：验证终态同样出现人读成功或失败提示（concurrent：双模式）。
- 环境现势组件/快照含非空 cwd 字符串，且 git 摘要字段存在（无 git 仓库时有显式 fallback，不 throw）（empty / exception）。
- 合成超长 diff/摘要（> 约定 codepoint 上限，默认 2000）时，人读面仍可渲染且输出长度 ≤ 上限（overflow）。
- 环境现势渲染路径**不**调用写入 ADR-0028 状态栏 / `agent-status` 追加 cwd 的 API（negative：不污染模型栏）。
- 缺 VerificationRecord 时 TUI **不**出现虚假「验证成功/失败」提示（negative / empty）。
- 源码检索：人读 verify 提示组件或投影**不**依赖 `#284` Trace SPA 路由作为唯一可见面（TUI 自足）。
- `npm run typecheck` 与上列 vitest 子集 exit 0。

## Open Questions

(none — assumption gate confirmed)

## Inherits / Changes

**Inherits：**

- 栈：TypeScript + Node/bun TUI（`@opentui/react`）；`npm test` / vitest；无本 spec 强制新依赖。
- Verify 内核与模式分派：`verify-goal-gate.md`、`449-evidence-checker.md`；advisor 外挂（ADR-0011）；信封识别 `isVerifyInjectedText`；TUI 隐藏 `isTuiHiddenUserMessage`。
- 状态栏：ADR-0028；字段仅 `last_tool` + open todos。
- CONTEXT 现行抄录（exact）：
  - **状态栏**: 每次即将调模型前由 harness 算出的现势，以 **user** 消息追加在 `messages` 末尾（含同一用户回合内 tool loop）；旧栏留在历史上，不替换、不写 `deps.system`；UI 只读同一份，in-flight 只给 TUI。字段仅 `last_tool`（本回合尚未跑过工具则为 idle）以及有未勾项时才出现的 todo 段（只投影 `- [ ]` 行；文件缺席 / 空 / 全勾则整段缺席）。ADR-0028。
  - **环境现势**: 给人看的工作区快照（至少 cwd / git 摘要 / diff 要点），投放在 TUI（或等价）人读面；**不**写入 ADR-0028 状态栏 user 消息，也**不**充当 verify 输入。#655（G1）验收画像锁定。
  - **自动模式** / **goal（会话使命）** / **判官（judge）** / **补跑信封**：见 `docs/CONTEXT.md` 现行条（本 spec 不改定义）。
- 邻图契约：#653 G4 — TUI verify 人读 = 本路线；#116 eval；#284 Trace；#519 Web OOS。

**Changes：**

- 新增 TUI（及可选 CLI）对人 **Verify 终态** 的投影与提示，含成功路径。
- 新增 TUI **环境现势** 人读面（与状态栏分离）。
- 待写入（persist）：`环境现势` 词条若尚未合入主干，随本分支提交 `docs/CONTEXT.md`；**无新 ADR**（不改 0028）。
- 索引：`specs/README.md` 活跃表增加本文件一行。

## architecture-change-reviewer

预定接线（实施前 ACR；本块填 verdict）：

- `src/tui/**`（人读提示 / 环境现势锚点）
- `src/session-api/hub.ts` 或 verify 投影消费（若缺 pass）
- `src/harness/verify/**`（只读复用 record；避免内核重写）
- `tests/tui/**`、`tests/harness/verify/**` 或等价
- `specs/653-horizon-pkg1-perception.md`、`specs/README.md`、`docs/CONTEXT.md`（若未合入）

```
bounded-context-guardian: yes — 预定接线仅 TUI 人读 / hub 投影补齐 / harness verify 只读复用；禁内核重写与 ADR-0028 写栏；无新 technical-layer 目录
defensive-contract-validator: yes — SC 覆盖 empty / negative / overflow(≤2000 cp) / concurrent(双模式) / exception(cwd·git·刷新 degraded)
error-handling-enforcer: yes — Boundaries 五条 typed failure 均标 EXIT（静默缺席 / degraded）；不 throw；不进模型上下文
complexity-anti-drift: yes — Verify 投影与环境现势分列；复用 VerificationRecord；固定单一 UI 锚点；无神文件意图
minimal-change-verifier: yes — 单逻辑任务包1-感知；包2 OOS；无新 ADR / 无第二套判定；可 1 commit 合入契约
```

**persist：** `docs/CONTEXT.md` **环境现势** 词条已在本 worktree 起草（G1）；本 spec Changes 要求随分支合入主干。无新 ADR。清单已 flush（skip 新写）。
