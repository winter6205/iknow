# Plan: TUI compact 进度读条 + 外显文案英文化

**Goal:** 为 TUI 加入 design-25 风格（与 `/effort` 档位面板同视觉语言）的 compact 压缩进度读条；把 TUI 的 compact 外显文案改为英文。
**Approach:** 新增 `src/tui/compact-progress.tsx`（面板组件 + 纯函数投影），手动 `/compact` 与 turn 内 auto-compact 共用同一套事件归约；`app.tsx` 持 state 并把面板排入 chrome 行账；文案 SSOT 原地改英文。
**Spec link:** 无需新 spec（TUI 表现层、可逆；操作员当面要求）。
**ACR:** 见文末。
**Worktree:** `.claude/worktrees/compact-progress-bar` on `worktree-compact-progress-bar`
**Tracker:** 本地 markdown。

## 现状（侦察结论，file:line 为据）

- **无真实进度信号**：harness 只发 5 个离散事件 `compaction_started {droppedCount}` / `compaction_text_delta {text}` / `compaction_completed {summaryLen,durationMs}` / `compaction_failed {reason,durationMs}` / `compaction_cancelled`（`src/harness/stream.ts:43-52`）。无 tick、无百分比、无 phase（全仓 grep `compact_progress` / `CompactPhase` 零命中）。
- **手动路径**：`app.tsx` `/compact` case 用 `setNotice` 出中文静态提示（`app.tsx:2068,2083`），始终 1 行、无进度。
- **auto 路径**：turn 内 `runTurnOnce` 的 `onStream`（`app.tsx:1433`）不处理任何 `compaction_*` 事件 → **对用户完全静默**；reactive 路径也传 onStream（`loop-engine.ts:1509-1513`）。
- **视觉基线**：`/effort` = design-25：圆角流光框（8000ms 边框相位）+ 45 格 `█` 渐变条（`gradAt`）+ 边界水线（`triangleWindow`，2400ms alternate）。`PICKER_WIDTH=50` 已被 `memory-picker.tsx:19` 复用（先例）。

## 设计

### D1 面板（`src/tui/compact-progress.tsx`，新模块）

```
╭────────────────────────────────────────────────╮   ← 圆角框，边框色 8s 流光（同 effort）
│ ◆─ Compacting                                  │   ← 标题
│ ◐  12s · 48 messages folded                    │   ← 状态行
│ ████████████████████████░░░░░░░░░░░░░░░░░░░░░  │   ← 读条（45 格，起点渐变 + 边界水线）
│ [Esc] cancel                                   │   ← 键位提示
╰────────────────────────────────────────────────╯
```

- 宽 `PICKER_WIDTH`（50），`alignSelf="flex-start"`，`marginBottom=1`，`compactProgressRows()` = **6**（边框 2 + 内容 4；不含 marginBottom，与 `thinkingPickerRows` / `memoryPickerRows` 同约定）。
- 读条几何复用 `designs/_geometry.ts` 的 `floorTo5BarLen`（46 内宽 → 45 格，与 effort 条同宽对齐）。
- 色彩数学（`hexToRgb` / `mixHex` / `gradAt` / `triangleWindow` / `flowBorderColor`）抽到共享 `src/tui/designs/_color.ts`，`thinking-picker.tsx` 与 `memory-picker.tsx` 改为 import（消第三份复制；行为零变化，既有测试为证）。

### D2 进度估计（无真信号 → 时间渐近，上限 0.95）

- `fill = min(0.95, 0.05 + 0.90 * (1 - exp(-elapsed / 12000)))`；只有 `compaction_completed` 才到 1.0。
- 边界水线 2400ms 摆动 = 存活信号（填充几乎不动时也看得出在跑）。
- 注释里写明「时间估计不是真实进度」，不冒充真值。

### D3 状态机（纯函数 `reduceCompactionEvent`）

```ts
type CompactProgressState = {
  source: "manual" | "turn";
  droppedCount: number;
  startedAt: number; // ms epoch
  terminal: null | { kind: "done" | "failed" | "cancelled"; atMs: number };
};
```

- `compaction_started` → 建/更新（`droppedCount`）；终态后忽略迟到事件。
- `compaction_completed` → `done`；`failed` → `failed`；`cancelled` → `cancelled`。
- 非 compaction 事件 → 原样返回（identity，供 app 做引用相等守卫）。
- `completed` 无前置 `started` → 忽略（无面板可更新）。
- 负 elapsed → `Math.max(0, …)` 钳制。

### D3.5 终态权威（ACR BLOCKED 修复）

事件是**快路径**，**promise 结果是终态权威** —— pre-abort 早返回（`full-compact.ts:260`，observer 不触发，`app.tsx:2072-2073` 已记录该类）与 catch 都不经任何 `compaction_*` 事件，只靠事件会让面板停在 95% 伪在途态。

- `settleCompactPanel(conversationId, kind)`：统一终态入口，设置终态 + 起 `HOLD_MS` 清除 timer。
- 手动路径结果驱动：`cancelled` → `settle("cancelled")`；`compacted:true` → `settle("done")`；**no-op（`compacted:false` 且非 cancelled）→ 立即清除**（没发生压缩，显示 done 是假话）；catch → `settle("failed")`。
- turn 路径：事件驱动 + `runTurnOnce` 的 `finally` 强制清扫 —— 结束时面板仍非终态 → 立即清除（缺终态事件兜底）；已终态 → 交给 hold timer。
- 卸载 / 重开压缩时清 pending timer（防迟到 timer 打到新面板）。

### D4 状态行文案（英文，SSOT 纯函数 `compactStatusText`）

| 状态                      | 文本                                  |
| ------------------------- | ------------------------------------- |
| running（未收到 started） | `◐  {elapsed}s · preparing`           |
| running                   | `◐  {elapsed}s · {n} messages folded` |
| done                      | `✓  {elapsed}s · done`                |
| failed                    | `✗  {elapsed}s · summary failed`      |
| cancelled                 | `—  {elapsed}s · cancelled`           |

提示行 `[Esc] cancel`（manual）/ `[Esc] interrupt`（turn，Esc 打断 turn → 连带 abort 压缩；无独立取消通道）。

终态后停留 `HOLD_MS = 1200ms` 再卸载（让 100% / 失败色可见），由 app 侧 timer 清除 state（行账与渲染同源）。

### D5 接线（`app.tsx`）

- 新 state `compactPanels: Record<conversationId, CompactProgressState>`；渲染 `view === "chat"` 且当前会话有条目时插在 picker 槽（`notice` 之后、`ModalHost` 之前，JSX 顺序 = 视觉顺序）。
- 手动路径：`/compact` 立即置 `{source:"manual"}`（面板先于任何事件出现），`onStream` 内 `compaction_*` 走同一 reduce；终态 notice 保留英文结果（不再有「进行中」中文 notice）。
- auto 路径：`runTurnOnce` 的 `onStream` 加同一 reduce（`source:"turn"`）→ 首次把 auto-compact 变成可见。
- `chromeReserveRows` 新增可选 `compactRows`（缺省 0；>0 时 +1 marginBottom，与 `pickerRows` 同款）。面板存在 → 6，否则 0。
- 新增小 effect：终态 → `setTimeout(clear, HOLD_MS)`；新压缩开始/卸载时清 timer。

### D6 文案英文化（仅 compact 相关）

- `compactNoticeFor`：windowed → `Context compacted (kept tail, trimmed early messages).`；full_summary → `Context compacted (structured summary + kept tail).`；noop → `Nothing to compact — session unchanged.`
- 守卫：busy → `Session is running; compact after this turn ends.`；re-entry → `Compaction already in progress; press Esc to cancel.`；draft → `Empty session — nothing to compact yet.`；cancelled → `Compaction cancelled — session unchanged.`；failed → `Compaction failed: {err}`。
- `slash.ts`：help 行 → `/compact   Compact context (keep tail, trim early messages)`；hint → `Compact context`。
- 不动：`Crunched for …`（已英文）、web 端（本次范围外）、`describeError` 的错误体、其余 TUI 文案。

## Files expected to change

- 新增：`src/tui/compact-progress.tsx`、`src/tui/designs/_color.ts`、`tests/tui/compact-progress.test.tsx`、本 plan。
- 修改：`src/tui/app.tsx`、`src/tui/thinking-picker.tsx`（改用共享色数学）、`src/tui/memory-picker.tsx`（同）、`src/tui/slash.ts`、`tests/tui/compact-notice.test.ts`、`tests/tui/app.test.tsx`、`tests/tui/continue.test.tsx`、`tests/tui/slash.test.ts`、`tests/tui/chrome-budget.test.ts`、`tests/tui/thinking-picker.test.tsx`（如断言受 import 迁移影响）。

## Commit 切分（1 commit = 1 logical task）

1. `refactor(tui)`: 抽 `designs/_color.ts`，thinking-picker / memory-picker 改用（行为零变化）。
2. `feat(tui)`: compact 进度面板 + 接线 + 行账 + 自动压缩可见化 + 英文文案 + 测试。

## Acceptance — `tests/tui/compact-progress.test.tsx`

纯函数（`reduceCompactionEvent` / `compactBarFill` / `compactStatusText`）逐类用例：

| #   | 类                 | 用例                                           | 期望                                                        |
| --- | ------------------ | ---------------------------------------------- | ----------------------------------------------------------- |
| 1   | happy              | started{droppedCount:12} → completed           | 读条随 elapsed 单调不减；completed 后 fill=1.0，状态 `done` |
| 2   | empty              | started{droppedCount:0}                        | 面板建立（0 条合法），状态行仍渲染，不崩                    |
| 3   | negative           | `compactBarFill(-5000)` / 负 elapsed           | 钳制到 0，fills ∈ [0, 0.95]                                 |
| 4   | 无事件终局         | 仅 settle("cancelled")（pre-abort 早返回路径） | 转 cancelled 终态；无 started 也不留伪在途态                |
| 5   | catch              | settle("failed")（manual catch 路径）          | 转 failed 终态；`✗` + `summary failed`                      |
| 6   | 迟到事件           | 终态后到达的 started/text_delta/completed      | 忽略（引用相等，状态不变）                                  |
| 7   | 终局缺失           | 终态前 `settle("done")`                        | done 终态优先于任何迟到事件                                 |
| 8   | 并发               | 两个 conversationId 各自 reduce                | 互不影响（keyed 投影）                                      |
| 9   | no-op              | `compacted:false` 非 cancelled                 | 面板立即清除（不显示 done）                                 |
| 10  | 未 terminated 清扫 | turn finally 且仍非终态                        | 立即清除                                                    |

渲染（`CompactProgress` 组件 smoke，testRender 截帧）：

| #   | 断言                                                            |
| --- | --------------------------------------------------------------- |
| 11  | 帧含 `Compacting` 标题、`╭`/`╰` 圆角框、`█`×N、`[Esc] cancel`   |
| 12  | 宽度 = `PICKER_WIDTH`（50），不随 cols 变（与 effort 面板同宽） |
| 13  | failed 帧的 `✗` 状态行可见；done 帧 `✓`                         |
| 14  | `compactProgressRows()` === 6（行账 SSOT）                      |

文案英文化（`compactNoticeFor` / 守卫 / `chromeReserveRows`）：

| #   | 断言                                                                                             |
| --- | ------------------------------------------------------------------------------------------------ |
| 15  | `compactNoticeFor` 全分支只返回英文串（无 CJK 字符），reason 契约不变（exhaustiveness 抛错保留） |
| 16  | guard notices（busy / re-entry / draft / cancelled / failed）全英文                              |
| 17  | `chromeReserveRows({compactRows:6}) - chromeReserveRows({})` === 7（6 行 + marginBottom）        |
| 18  | `compactRows` 缺省 0（旧调用零影响）                                                             |

## Validation

- `$HOME/.bun/bin/bun test tests/tui/`（TUI 全量）
- `npm run typecheck` + `npm test`
- 模型可见文案改动：不涉及（panel 仅宿主 UI；压缩 prompt 未动）。
- MCP 实测：`npm run dev:tui` 起真实 TUI（`mcp__aiterm__pty_*`），发消息后 `/compact`，读屏验证面板出现 / 读条推进 / 终态 notice 英文；再验证 Esc 取消路径。
- PR：push 分支 + `gh pr create`。

## 收尾

整轮 `arthurpower:code-review`（Standards + Spec）→ `arthurpower:verification-before-completion` → PR。

## architecture-change-reviewer

首轮（轮次 1）：

```
bounded-context-guardian: yes — 改动全在 src/tui/；PICKER_WIDTH 导入有 memory-picker.tsx:13 先例、per-conversation 状态有 app.tsx:595/619 先例，无 harness/web 触碰。
defensive-contract-validator: no — 仅并发 keying 与 0.95 封顶被显式覆盖；无事件终局（app.tsx:2072-2073 已记录该类）、catch 后 panel 未被终结、negative elapsed 均未声明，新测试文件未列边界用例。
error-handling-enforcer: yes — 无新 catch；失败/取消 notice（app.tsx:2109-2141）与 sealed union 抛错（app.tsx:284-309）保留，0.95 封顶不伪终态。
complexity-anti-drift: yes — 纯函数收敛到新模块、app 仅加 state + 一行 reduce，沿用 app.tsx:1433 逐事件链，无 god-function 计划。
minimal-change-verifier: yes — 单一逻辑任务（compact 外显面）；web/harness 零改动（stream.ts:43-52 无进度事件，决策 1 成立）。
```

**OVERALL: BLOCKED**（defensive-contract-validator）。修复：新增 D3.5 终态权威（promise 结果为终态 SSOT + `finally` 强制清扫 + no-op 立即清除 + 负 elapsed 钳制 + 终局缺失用例），见上。重跑门禁后回填。

轮次 2：D3.5 设计侧已补齐，但测试用例清单未落 plan → BLOCKED（仅文档缺口）。

轮次 3：

```
bounded-context-guardian: yes — 改动全在 src/tui/（新增 compact-progress.tsx / designs/_color.ts）；PICKER_WIDTH 导入先例在 src/tui/memory-picker.tsx:13，per-conversation keyed state 先例在 src/tui/app.tsx:594-595/618-620；harness（src/harness/compress/full-compact.ts:260 aborted 早返回、loop-engine.ts:1509-1513 传 onStream）与 web 零触碰。
defensive-contract-validator: yes — 计划 plans/tui-compact-progress.md:105-138 列出 18 行验收表：empty=行 2/18、negative=行 3、overflow（elapsed 渐近上限）=行 3 的 fills ∈ [0, 0.95]、concurrent=行 8、exception（catch→failed）=行 5；另有行 4/6/7/9/10 覆盖 pre-abort 无事件终局、迟到事件、终局优先、no-op 清除、turn finally 清扫；回归面 tests/tui/{compact-notice.test.ts→改英文断言, chrome-budget.test.ts→compactRows 缺省, thinking-picker.test.tsx→import 迁移} 在计划 :98 列明。
error-handling-enforcer: yes — 终态为判别联合 terminal: {kind: "done"|"failed"|"cancelled"}（计划 :47），失败文案非空（计划 :74 `✗ {elapsed}s · summary failed`）；每条失败路径均 EXIT-documented（计划 :57-64：settle 三终态、no-op 立即清除、turn finally 强扫、HOLD_MS timer、卸载清 timer），且覆盖 src/tui/app.tsx:2088-2101（promise 结果 vs 事件）与 src/harness/compress/full-compact.ts:260 无事件早返回这类真实缺口。
complexity-anti-drift: yes — 状态归约收敛为纯函数模块 src/tui/compact-progress.tsx（reduceCompactionEvent / compactBarFill / compactStatusText，计划 :40-55），app 仅加 state + onStream 一行 reduce + 一个 timer effect（计划 :84-86）；色数学抽 src/tui/designs/_color.ts 消 thinking-picker.tsx:230-282 / memory-picker.tsx:87-110 的重复第三份（计划 :32），无 god-function / 嵌套膨胀计划。
minimal-change-verifier: yes — 单一逻辑任务（compact 外显面：进度条 + 英文文案）；scope 边界显式（计划 :93 排除 web 与「Crunched for…」）；chromeReserveRows 新增可选 compactRows 缺省 0 向后兼容（计划 :85，行 18 钉住旧调用零影响）；两 commit 切分（计划 :100-103）为 refactor 预备 + 单一 feat，属同任务内序列而非 scope 并集。
```

**OVERALL: PASS** — 5/5 yes，门禁对当前计划版本已清。
