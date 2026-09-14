# Plan: tui-tool-rhythm

**Goal:** keep 工具卡（历史与 live）彼此空一行；成功 bash **result preview** 尾窗改为 3 行。
**Approach:** 先改合同行数，再两条互不抢语义的显示切片：卡间距、尾窗常量。不改 write/edit 窗、不改 web 预览、不改 live 过程组/open-unit。
**Spec link:** `specs/tui-tool-settled-appearance.md` D4（本计划 T2 改行数）+ `docs/CONTEXT.md` **result preview**。
**ACR:** all-yes

```
bounded-context-guardian: yes — 面锁 src/tui 预览与卡片间距，不新开 BC
defensive-contract-validator: yes — 尾窗纯函数 empty（空输出无窗）/ negative（非进度行不折进窗策略仍先 progress tick）/ overflow（>3 行取尾 3 + 溢出标记）/ concurrent（无共享状态）/ exception（失败 overlay 不走预览窗）
error-handling-enforcer: yes — 无新错误类型；失败不走 result preview
complexity-anti-drift: yes — 改常量与间距，不堆新分支；阈值见 complexity-anti-drift
minimal-change-verifier: yes — 只 TUI keep 间距 + bash 尾窗行数；不动 write/edit、web、fold 闸门
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → （整轮收尾才 code-review）→ verification-before-completion
**待写入:** （空 — **result preview** 3 行已刷入 `docs/CONTEXT.md`；D4 正文由 T2 改 spec）

> Contradicts `specs/tui-tool-settled-appearance.md` D4「bash … 五行走 ANSI（行数不重开）」与 SC3「成功时五行走」— worth reopening because 操作员裁定 bash 尾窗 3 行；write/edit 窗不在本计划。

## Tasks (ordered by dependency)

1. **Persist preview window term** — tag: `[decision]`
   - **Inherits:** 操作员裁定：bash **result preview** 尾部 3 行；write/edit 既有窗不动
   - **Surface:** `docs/CONTEXT.md`
   - **Acceptance:** **result preview** 定义为最多 3 行；无新 ADR
   - Status: [x] done
   - [blocks: T2, T3, T4]

2. **Amend D4 line count** — tag: `[decision]`
   - **Inherits:** D4 keep 足迹仍是标题 + **result preview** + ANSI 透传；仅行数 5→3；write_file / edit_file 预览行数不改
   - **Surface:** `specs/tui-tool-settled-appearance.md`
   - **Acceptance:** D4 / 相关 SC / Inherits 引文不再写 bash 五行走；仍禁止重开 ANSI 合同
   - Status: [x] done
   - [blocks: T1]

3. **Keep-card gap** — tag: `[implementation]`
   - **Inherits:** 相邻 **keep class** 标题卡（历史 MessageBlocks 与 live 尾巴）之间空一行；过程组摘要行不是 keep 卡，不套这条间距
   - **Surface:** `src/tui` 工具卡渲染
   - **Acceptance:** 两条连续成功 bash 落定帧上标题不贴行；live 两条 keep 同样有空行。既有 `tests/tui` 落定/live 预览测改为认证本条
   - Status: [x] done
   - [blocks: T1]
   - [parallel] with T4

4. **Bash result preview three-line window** — tag: `[implementation]`
   - **Inherits:** 先 **progress tick** 再取尾部 3 行；溢出 `… +N 行`；失败 overlay 无此窗
   - **Surface:** `src/tui` 预览投影
   - **Acceptance:** 6 行 stdout → 可见尾 3 行 + 溢出；≤3 行无溢出标记。`tests/tui/tool-summary.test.ts` 与 bash 成功槽测改为认证 3 行
   - Status: [x] done
   - [blocks: T2]
   - [parallel] with T3

## Code review phase

整轮 T2–T4 落地后：`code-review`；`GATE: BLOCKED` → 下一槽 `review-report-repair`。
