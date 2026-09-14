# Plan: tui-viewport-always

**Goal:** ChatView 始终按视口 + 小 overscan 挂载消息；滚动位置更新不再每像素触发整树提交。
**Approach:** 先改 viewport spec 的全量挂载与 overscan 下限，再去掉「短于 N 屏则全挂」，再缩小 overscan，最后量化 scroll 提交。滚动文档仍全量；live tail 仍在虚拟集合外。
**Spec link:** `specs/tui-transcript-viewport.md`（本计划 T1 改 invariant 4 与「短会话全挂」实现约定）。
**ACR:** all-yes

```
bounded-context-guardian: yes — 面锁 src/tui viewport + ChatView 订阅，不新开 BC
defensive-contract-validator: yes — 窗口纯函数沿用 empty / negative clamp / overflow（挂载 ≪ 总条数，含不足旧 8 屏的会话）/ concurrent / exception（messages 非数组 TypeError）
error-handling-enforcer: yes — 无新错误类型；沿用既有 TypeError
complexity-anti-drift: yes — 删除全量短路优于加分支；阈值见 complexity-anti-drift
minimal-change-verifier: yes — 只挂载窗口与 scroll 提交粒度；不改 session 数据、不改「只挂最近 N 条」、不混 live fold
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → （整轮收尾才 code-review）→ verification-before-completion
**待写入:** （空 — 无新 CONTEXT 词；spec 正文由 T1 改）

> Contradicts `specs/tui-transcript-viewport.md` invariant 4「overscan **至少一屏**」以及实现里「约 8 屏以内全量挂载」— worth reopening because 操作员裁定始终视口挂载、overscan 小于一屏；短会话在内容落入视口+overscan 时仍应全部挂上，不是固定条数尾窗。

## Tasks (ordered by dependency)

1. **Amend viewport spec mount floor** — tag: `[decision]`
   - **Inherits:** invariant 1–3、5–8 仍成立（全量滚动文档、方案 B banner、禁止行账、live tail 不进虚拟集合、sticky、无揭示更早一页、跟 `verticalScrollBar` `change` 同步；禁止劫持 `scrollTop` setter、禁止 rAF 轮询）。改 invariant 4：挂载 = `scrollTop` + `viewport.height` + **小于一屏的 overscan**；禁止「内容高度低于 N 个视口则全量挂载」。内容全部落在视口+overscan 内时行为仍与全量 map 相同
   - **Surface:** `specs/tui-transcript-viewport.md`
   - **Acceptance:** invariant 4 与 Testing strategy overflow 不再要求 overscan 至少一屏、不再把「普通会话全挂」写成合同；Never do 仍禁止默认只 mount 最近 N **条**
   - Status: [x] done（9bb1134f）

2. **Always windowed mount** — tag: `[implementation]`
   - **Inherits:** T1；条目数极大时挂载仍是视口+overscan，spacer 吸收其余高度
   - **Surface:** `src/tui` transcript viewport 纯函数
   - **Acceptance:** 内容高度大于一屏但小于旧 8 屏阈值时，挂载区间长度仍 ≪ 总条数（除非它们落在视口+overscan 内）；`scrollTop=0` 窗口含第一条。`tests/tui/transcript-viewport.test.ts` 改为认证本条
   - Status: [x] done（9bb1134f）
   - [blocks: T1]

3. **Smaller overscan** — tag: `[implementation]`
   - **Inherits:** T1「overscan 小于一屏」；未测高条目仍用与内容无关的占位高度
   - **Surface:** `src/tui` transcript viewport
   - **Acceptance:** 默认 overscan 不再被抬到「至少一屏」；短会话内容在视口内仍全部挂上、无「↑ N 条更早的消息」。上列 viewport 测覆盖 overflow 与短会话
   - Status: [x] done（9bb1134f）
   - [blocks: T1, T2]

4. **Quantize scroll commits** — tag: `[implementation]`
   - **Inherits:** 仍订阅 `verticalScrollBar` `change`（invariant 8）；不 patch setter、不用 rAF 轮询；对 React 状态提交做量化，避免每次 change 整棵 ChatView 重算
   - **Surface:** `src/tui` ChatView 滚动同步
   - **Acceptance:** 连续亚阈值 `change` 不导致每次都 `setScrollTop` 提交；跨越量化阈值或贴底/置顶仍更新窗口。既有 sticky / `scrollToBottom` 测不倒退
   - Status: [x] done（9bb1134f）
   - [blocks: T1]
   - [parallel] with T2（窗口函数与订阅可分文件；T3 依赖 T2）

## Code review phase

整轮 T1–T4 落地后：`code-review`；`GATE: BLOCKED` → 下一槽 `review-report-repair`。
