# Plan: 主代理控制面

**Goal:** 工作树工具与隔离开关解耦；项目 settings 只承载团队契约（含权限）；todo 按条 id 做添加 / 更新 / 读取且 worker 共用账本；操作员能取消前景等待并在 TUI 看见、选中、强杀子代理。
**Approach:** 按 spec 四切片顺序落地，禁止一 PR 混四条。A 先解开工具在场；B 收设置允许名单与权限搬家；C 换账本形状再给 worker；D 最后改 quit / 超时 / chrome。Persist（ADR / CONTEXT）已在本文件落盘后立刻 flush，实施不再重开 grilling。
**Spec link:** `specs/agent-control-surface.md`
**ACR:** all-yes（子代理复审，SC 补 empty/overflow/worker-add 后 PASS）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion（整轮落地后再 `code-review`；`GATE: BLOCKED` → `review-report-repair`）。落地粒度为操作员全局 commit 节，不按 bullet 强制一提交。

## 待写入

空（本回合已 flush：ADR-0037 amendment、ADR-0084、ADR-0085、CONTEXT 词条）。

## ACR

Affects（实施时）：`build-engine` 工作树装配、`src/config` 合并与写回、permission 加载、ACI `todo_write`、agent-status 投影、TUI quit / chrome-focus / 子代理面板、`spawn_subagent` 超时 envelope。

```
bounded-context-guardian: yes — Boundaries A–D 落在既有 harness/config/permission/tui；Assumption 2 禁止一 PR 混四条。
defensive-contract-validator: yes — empty SC11/SC15；negative SC8；overflow SC11；concurrent SC9；exception SC5/SC13/SC9 worker add。
error-handling-enforcer: yes — worker add typed 拒绝；空/超限不半写；toml+json fail-loud；超时/取消非 ok。
complexity-anti-drift: yes — 按切片分 PR；todo 三件事拆 helper，禁止单文件神函数。
minimal-change-verifier: yes — 一个 destination；不含跨主会话 todo、不含默认 isolation ON、不含 wait:false 默认。
```

## Tasks (ordered by dependency)

1. **A：工作树工具常在；门禁只跟 isolation ON** — tag: `[implementation]`
   - **Inherits:** spec Slice A / SC1–SC3；ADR-0037 amendment（工具在场 ⇏ 门禁已武装）；门禁从不 auto-provision；`git worktree add` 经 bash **不是** rebind。
   - **Surface:** harness 引擎装配、worktree ACI 注册、isolation 门禁
   - **Acceptance:** isolation OFF 时 registry 含 `create-worktree` 与 `list-worktrees`；ON + 未绑树写主仓仍拦且回执点名 `create-worktree`；bash 建树成功后 `taskRoot` 不变。`npx vitest run tests/harness/aci/tools/registry.test.ts tests/session-api/hub-worktree-isolation.test.ts`（及本刀新增）退出 0。
   - Status: [ ] pending

2. **B：项目允许名单 + 写回落对层** — tag: `[implementation]`
   - **Inherits:** spec Slice B / SC4 / SC6；ADR-0084；项目文件只采纳 `hooks` / `verify` / `secrets` / `permissions`；其余顶层段丢弃且不覆盖用户值；用户层键只写用户文件。
   - **Surface:** `src/config` 合并与 settings 写回
   - **Acceptance:** 项目文件含 `isolation` / `llm.model` 时合并结果等于用户层值且警告可测；写回 thinking 不创建/不改项目文件里的 `llm`。`npx vitest run tests/config/settings.test.ts`（及写回相关既有测）退出 0。
   - [blocks: T1]
   - Status: [ ] pending

3. **B：权限进项目 settings + 停读 toml** — tag: `[implementation]`
   - **Inherits:** spec Slice B / SC5；ADR-0084；rule DSL 语义不变；两份同时存在 fail-loud；用户层不接 `permissions`。
   - **Surface:** permission 加载与项目 settings
   - **Acceptance:** 仅项目 `permissions.rule` 时策略层能加载与今日 toml 同形的一条 deny/allow；toml 与 json 并存 → 加载 typed fail；停读 toml 为 SSOT。`npx vitest run tests/harness/permission/project-settings.test.ts tests/config/settings.test.ts` 退出 0。
   - [blocks: T2]
   - Status: [ ] pending

4. **C：父会话三件事（id / 批量添加 / 按 id 更新 / 读取）** — tag: `[implementation]`
   - **Inherits:** spec Slice C / SC7–SC8 / SC11；ADR-0085；`check` 并入更新；`replace` 降为整表逃生口；空 add 与超限（64KB / 500）typed、不半写。复杂度拆 helper，见 `complexity-anti-drift` 门槛，本栏不抄数字。
   - **Surface:** ACI todo 工具面 + 会话目录账本
   - **Acceptance:** 一次 `add` 多条得到 N 个 id；`update` 按 id 改 subject/status/删除；未知 id typed；空 add / 超限失败且现行不变。`npx vitest run tests/harness/aci/tools/todo-write.test.ts` 退出 0。
   - [blocks: T3]
   - Status: [ ] pending

5. **C：worker 共用同一会话账本** — tag: `[implementation]`
   - **Inherits:** spec Slice C / SC9；worker 可读取与更新；**添加仅父会话**，worker `add` typed 拒绝（非静默、非工具缺席）；两会话 id 不串；跨主会话共用本切片不做。
   - **Surface:** worker 工具面与父会话账本缝
   - **Acceptance:** worker 能 list/update 父账本；worker add 失败可见；两 conversation 的 id 不交叉。相关 worker / todo 测试退出 0。
   - [blocks: T4]
   - Status: [ ] pending

6. **C：状态栏只投影未完成项** — tag: `[implementation]`
   - **Inherits:** spec SC10；ADR-0028（不灌整表进 messages）；栏只投影 pending/in_progress。
   - **Surface:** agent-status 只读投影
   - **Acceptance:** completed 不进栏；文件缺席 / 全完成则 todo 段缺席。`npx vitest run tests/harness/identity/agent-status-read-rule.test.ts`（或现行栏测试）退出 0。
   - [blocks: T4]
   - Status: [ ] pending

7. **D：quit abort、Ctrl+C 取消 wait、超时非 ok** — tag: `[implementation]`
   - **Inherits:** spec Slice D / SC12–SC13 / SC15 的 Ctrl+C 半；ADR-0014 默认仍 `wait:true`；超时 envelope / `tool_kind` 不得为成功 ok；`/quit` 先 abort 再收尾。
   - **Surface:** TUI 退出路径、`spawn_subagent` 等待与超时
   - **Acceptance:** quit 在前景 spawn 期间调用 abort、不等 per-task 墙钟；无选区 + `running-fg` 时 Ctrl+C abort wait；超时不是 ok。`npx vitest run tests/subagent/spawn-subagent.test.ts`（及 TUI quit / interrupt 既有测）退出 0。
   - [blocks: T5, T6]
   - Status: [ ] pending

8. **D：消息两行 + Ctrl+X 强杀** — tag: `[implementation]`
   - **Inherits:** spec Slice D / SC14–SC15；底栏沿用 `● ○` 与 chrome-focus；聚焦行 `> `；无 Enter 进子代理会话；无第二套 picker 文案；无聚焦时 Ctrl+X 不杀、不崩。
   - **Surface:** TUI chrome-focus、子代理面板 / 会话消息投影
   - **Acceptance:** 每个活子代理两行（`{role} running...` + dim 最新）；Ctrl+X 强杀聚焦子代理且父 turn 收到 cancelled；无聚焦 Ctrl+X 为空操作。`npx vitest run tests/tui/subagent-panel.test.ts tests/tui/chrome-focus.test.ts`（及新增）退出 0。
   - [blocks: T7]
   - Status: [ ] pending

9. **四切片回归** — tag: `[implementation]`
   - **Inherits:** spec SC16；真模型夹具缺 key → Not run，不挡。
   - **Surface:** 全仓测试
   - **Acceptance:** `npm test` 退出 0。
   - [blocks: T8]
   - Status: [ ] pending
