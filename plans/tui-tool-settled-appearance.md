# Plan: TUI 工具落定态

**Goal:** 落定后按类留 / 收 / 点名着色；折叠只数成功的收；失败横切可见且不 dim 堆长文。
**Approach:** 先扩策略核（生产行为不变），再给注册表挂上 class，然后把折叠与渲染切到只消费 slot（删 `hideToolSummaries`），最后补失败一行错误与 accent 着色。对照调研不入库。
**Spec link:** `specs/tui-tool-settled-appearance.md`
**ACR:** all-yes（见下方）
**Tracker:** 本地 markdown（本图 / 本工作用户裁定不开 GitHub issue）
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on `worktree-tui-tool-settled-appearance`

```
bounded-context-guardian: yes — 落点在既有 TUI 能力 `src/tui/tool-settled.ts`，不新开仓库级 context，禁止 services/utils/tool-display 预拆。
defensive-contract-validator: yes — SC2 覆盖 empty / negative / overflow / concurrent（pure N/A）/ exception（SC1/SC4）。
error-handling-enforcer: yes — 失败横切在核最后一步返回 typed slot（error 色、不抛、不 null）；未知工具走 retract；缺 settledClass 测试拒绝。
complexity-anti-drift: yes — deriveSlot 核 + 一行注册表 + 渲染只消费 slot；overlay 不进 JSX。
minimal-change-verifier: yes — 单一逻辑任务：落定态（核 + settledClass + 折叠改语义 + 删 hideToolSummaries + D3 supersede）。
```

## 待写入

（空）

## Tasks (ordered by dependency)

1. **策略核：deriveSlot 表测（生产仍走旧折叠）** — tag: `[implementation]`
   - **Inherits:** spec D1 — `deriveSlot(name, { running, failed })` → `{ showTitle, showPreview, inFoldCount, color }`；失败横切在核最后一步；running 时 `inFoldCount` 假、`showTitle` 真；未知名缺省 retract。SC2 五类。
   - **Surface:** TUI（`src/tui`）
   - **Acceptance:** 策略核单测覆盖 SC1 + SC2 五类；现有折叠测试仍绿（调用方未切核）。复杂度门见 `complexity-anti-drift`，本栏不抄行数。
   - Status: [ ] pending
   - [parallel]

2. **注册表加 settledClass + 建树四件** — tag: `[implementation]`
   - **Inherits:** spec D2 / D8 分类表；缺 `settledClass` 测试拒绝；`create-task-worktree` / `enter-task-worktree` / `exit-task-worktree` / `remove-task-worktree` 必须在表内。
   - **Surface:** TUI
   - **Acceptance:** `EXPECTED_TOOLSET_*` 与显示注册表每一件都有 class；建树四件在表内（spec SC6 的注册半边）。折叠行为此时仍可旧。
   - Status: [ ] pending
   - [blocks: T1]

3. **折叠与渲染只消费 slot；删除 hideToolSummaries** — tag: `[implementation]`
   - **Inherits:** spec D3 / D7 / D4 的「收必须标题与预览同假」；计数只聚合 `inFoldCount`；零条收不画工具计数行；bash 成功仍可带五行走 ANSI。
   - **Surface:** TUI
   - **Acceptance:** spec SC3 与 SC7（`rg hideToolSummaries src/tui/` 零命中）；`bun test tests/tui/chat-view-thinking-tool-fold.test.tsx tests/tui/turn-activity.test.ts` 按新语义绿。
   - Status: [ ] pending
   - [blocks: T2]

4. **失败一行短错误 + 点名 accent** — tag: `[implementation]`
   - **Inherits:** spec D5 / D6 — 失败 error 色、一行截断、不进计数、不画五行走 dim `⎿`；accent 成功走 `accent` + 人读表述；skill 无五行走正文；error 优先于 accent。
   - **Surface:** TUI
   - **Acceptance:** spec SC4 与 SC5。
   - Status: [ ] pending
   - [blocks: T3]

5. **覆盖闸 + 回归** — tag: `[implementation]`
   - **Inherits:** spec SC6 收口 + SC8；旧 spec D3 已在 `specs/tui-display-consistency.md` 标明 superseded，本 bullet 不改合同。
   - **Surface:** TUI
   - **Acceptance:** `bun test tests/tui/deps-tools.test.ts tests/tui/tool-summary.test.ts` 与 `npm test` 全绿。
   - Status: [ ] pending
   - [blocks: T4]

## 收尾

全部 bullet 落地后跑一轮 code review（整轮改动，非每 bullet 重复），对照 spec SC1–SC8。
