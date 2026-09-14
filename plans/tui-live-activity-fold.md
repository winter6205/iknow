# Plan: tui-live-activity-fold

**Goal:** 进行中只露 **live activity group**（一行摘要 + 最多一条细节）和独立 thinking panel；落定仍是 **unit fold** + keep 标题；已画折叠不再把当前 **open unit** 吞掉。
**Approach:** 先改落定 spec 的 live 可见性条款，再把折叠闸改成 open-unit 派生，再画过程组与布局，最后去掉收类双重删除。不改 `deriveSlot` 分类、CSI/bash 预览清洗、viewport 挂载。
**Spec link:** 无独立新 spec。合同 = `docs/CONTEXT.md`（**unit fold** / **open unit** / **live activity group** / **keep class** / **retract class**）+ `specs/tui-tool-settled-appearance.md`（idle D3/D7；本计划 T2 改 live 条款）。
**ACR:** all-yes

```
bounded-context-guardian: yes — 面锁 src/tui + tests/tui + 已有 settled spec 条款，不新开 BC
defensive-contract-validator: yes — open-unit / 过程组纯派生覆盖 empty（无 live）/ negative（无 painted fold 不得当折叠存在）/ overflow（多条 retract 仍一行组）/ concurrent（history 折叠与当前 open unit 并存）/ exception（失败 keep overlay 仍逐条）
error-handling-enforcer: yes — 无新错误类型；失败不进过程组计数
complexity-anti-drift: yes — 闸门与分组不进 JSX 堆砌；阈值见 complexity-anti-drift
minimal-change-verifier: yes — 只做人读 live/idle 显示；不改 tool-settled 分类核、不混 CSI、不混 viewport
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → （整轮收尾才 code-review）→ verification-before-completion
**待写入:** （空 — CONTEXT 词条已刷入本轮 `docs/CONTEXT.md`；settled spec live 条款由 T2 改文件，不是词条）

> Contradicts `specs/tui-tool-settled-appearance.md` D1「running 时全部逐条可见」与 Out of spec「live 流式协议；running 仍逐条可见」— worth reopening because 操作员裁定 live 走过程组压缩，idle keep 标题不变。

## Tasks (ordered by dependency)

1. **Persist live-fold terms** — tag: `[decision]`
   - **Inherits:** 操作员裁定：两套折叠（进行中过程组 / 簇关闭 unit fold）；open unit 最近 prompt；思考不焊进工具摘要；有工具 running 时 thinking panel 让位；不因已画 unit fold 关掉后续过程组或思考
   - **Surface:** `docs/CONTEXT.md`
   - **Acceptance:** **open unit** / **live activity group** 已与上列同义；**live tool line** / **unit fold** 的 _Avoid_ 已禁止整轮闸；无新 ADR
   - Status: [x] done
   - [blocks: T2, T3, T4, T5]

2. **Amend settled spec for live chrome** — tag: `[decision]`
   - **Inherits:** idle 仍 D3/D7（成功 retract 进计数、keep 留标题）；live 改为 **live activity group** + ≤1 细节，不再「running 逐条可见」
   - **Surface:** `specs/tui-tool-settled-appearance.md`
   - **Acceptance:** D1 / Out of spec / 相关 SC 的 live 表述与 T1 词条同义；`deriveSlot` 成功/失败表与 SC1 不改
   - Status: [x] done
   - [blocks: T1]

3. **Open-unit gates replace turn-level fold** — tag: `[implementation]`
   - **Inherits:** 「painted `foldLinesBySegmentIndex` 是唯一折叠存在」；open unit = 最后一条已画 fold 之后的思考流 / 正文 draft / live runs；thinking panel = `thinkingDraft` 非空且该 burst 尚无已画 `Thought for`，且当前无工具 running；`hideThinking` 仅当已画 fold **含时长**（或用户展开）；retract 离开 tail 仅当已画 fold（或当前过程组）已含该计数；删除把 `foldDisplayLines.length` 当 collapse 信号、删除整轮 `currentTurnHasFold` 关 panel
   - **Surface:** `src/tui` 折叠派生与 ChatView / tail / message 行消费
   - **Acceptance:** 已画 unit fold 时，其后仍在思考或仍有 live 工具 → 过程组或 thinking panel 仍在帧上；仅 counts、尚无 `thinkingMs` 的 fold 行不得藏 thinking。现有 `tests/tui/chat-view-thinking-tool-fold.test.tsx`、`tests/tui/running-unit-fold-chatview.test.tsx`、`tests/tui/thinking-peek.test.tsx`、`tests/tui/turn-fold-lines.test.ts` 改为认证本条
   - Status: [x] done
   - [blocks: T1]
   - [parallel] with T4 after T2（T4 消费本条闸门）

4. **Live activity group + one detail + stack** — tag: `[implementation]`
   - **Inherits:** 进行中一行：Listing / Reading / Searching 聚合收类，bash `Running N shell command(s)`；细节槽 ≤1（当前 running 或最后 keep bash 短预览）；write/edit 仍 keep 标题；思考独立 panel，默认栈为过程组在上、thinking 在下（近输入）；工具 running 时不叠两个 live panel；idle 不把过程组当 unit fold
   - **Surface:** `src/tui` live 尾巴
   - **Acceptance:** 多条成功 `read_file` + 一条 running bash → 帧上不是 `read_file × 1` 刷屏，有一条过程组摘要和至多一条 bash 细节；thinking 中途出现不把过程组改成过去时、不关 panel（除非工具 running 让位）。`tests/tui/live-tool-preview.test.tsx` 与上列 ChatView 测改为认证本条
   - Status: [x] done
   - [blocks: T2, T3]

5. **Stop retract dual-delete** — tag: `[implementation]`
   - **Inherits:** 成功收类不得既从 live 数组抹掉又因 history `tool_use` id 被 tail 丢弃而无处可去；须进当前 **live activity group** 或已画 **unit fold** 计数
   - **Surface:** `src/tui` live 工具状态与 tail 过滤
   - **Acceptance:** 仅 user 查询在 history、live 刚完成 `read_file` → 帧上可见过程组或 `read_file × 1`，不得空白。既有 keep bash running 时历史 retract 折叠仍可见（`tests/tui/running-unit-fold-chatview.test.tsx` 不倒退）
   - Status: [x] done
   - [blocks: T3]
   - [parallel] with T4

## Code review phase

整轮 T2–T5 落地后：`code-review`；`GATE: BLOCKED` → 下一槽 `review-report-repair`。
