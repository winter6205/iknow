# Session Handoff — 子代理两行从 prompt 上方搬进会话 spawn 卡（2026-09-17）

分支 `worktree-tui-subagent-transcript`（从 `origin/master` @ `da74f29e` 拉出）。
计划 `plans/tui-subagent-transcript-live.md`（ACR 5/5 yes）；spec `specs/tui-subagent-transcript-live.md`（九句锁句 + SC1–SC7）。

## 本轮做了什么

1. **契约落 spec**（T1）：九句锁句、Card contract（`SubagentCardLines`）、卡状态表、Superseded 表、
   Input-contract classes（empty / negative / overflow / concurrent / exception）、SC1–SC7。
2. **卡级两行投影**（T2）：`src/tui/subagent-message-lines.ts` 从「live 列表整体铺开」改为
   `subagents × toolUseId → {roleLine, detailLine, done}`；join 键 = `SubagentInfo.toolUseId`
   （`manager.ts` `listSubagents` 新增只读字段，Postel：非空串才在场）。
3. **两宿主同渲染面**（T3）：新增 `src/tui/subagent-card-view.tsx`；live tail
   （`live-tool-preview.tsx`）与历史卡（`message-blocks.tsx`）都走它，分流判据收敛为
   `cardIfLive(run, card)` 单函数。`src/tui/subagent-identity-strip.tsx` 删除；
   `subagentRowBudget` 保留签名、恒返 0（显式声明「不再入账」）。
4. **perf 守卫**：`subagentCardsKey` 用内容签名做 `useMemo` 依赖 —— app 层 1Hz
   `setSubagents` 每次产新数组，用引用做依赖会让 memo 化的历史消息块每秒全量重建元素树。

## review 结果与处置

| 轴        | 结果                      | 处置                                                                            |
| --------- | ------------------------- | ------------------------------------------------------------------------------- |
| Standards | 2 High / 4 Medium / 3 Low | 8 修，1 保留并说明理由（`subagentRowBudget` 保留签名 = spec Superseded 表已锁） |
| Spec      | 0 High / 1 Medium / 4 Low | 全修（含归档头的 emoji 覆盖声明 → 在新宿主补真断言）                            |

两个 High 都是真问题，值得记录：

- **High-1 字面控制字节**：`subagentCardsKey` 原用字面 NUL/0x01 做分隔符 → `file` 判为
  binary、`git diff` 零 hunk、grep/rg 双失明。改为 `JSON.stringify` 嵌套数组（顺带拿到
  单射性：role / task 是模型给的任意串，手拼分隔符会撞签名）。新增分隔符注入测 8 组。
- **High-2 链无覆盖**：`subagentCards` 四跳（ChatView memo → MessageRow → MessageBlocks
  → renderToolUseBlock）删掉任一跳所有测试仍绿。新增
  `tests/tui/subagent-card-history-host.test.tsx`（7 例）钉住真实渲染 + 回落面。

## 未做

- 未改 `SubagentPanel` / Ctrl+X 行序 / web `SubagentStatusBar` / activity-block live-signal
  （spec 明列「不授权」）。
- `tests/tui/subagent-kill-key.test.tsx` SC14 两条用例在**同进程并跑 message-blocks** 且
  机器 load ≳50（4 核）时偶发失败：断言分别落在 `killed` 与 notice 帧上，失败帧是 app 启动
  splash，即该测自己的 settle 预算（120ms + `waitForVisualIdle`）在极端负载下不够 ——
  单独跑 5/5 绿，同 pair 在 load ~32 时 76/76 绿，同 pair 在 clean HEAD 上同样 76/76 绿。
  判为既有负载敏感（该测注释已自述 120ms「负载高的机器上偶尔不够」），非本切片逻辑；
  未改该测。

## 实测地面

- `npx tsc --noEmit -p tsconfig.json` → exit 0。
- `vitest run`（全量）→ **543 files / 8523 tests passed，0 failed**。
- `bun test tests/tui/`（全量）→ 见完成汇报；7 个触碰/新增文件 **260 pass / 0 fail**。
- 真实 TUI（`mcp__aiterm__pty_*` + 真 Opus 模型 + 真子代理）：`general-purpose running...` +
  dim 预览 → 完成后原位绿 `done`；输入框上方无身份条；底栏 `SubagentPanel` 不变。
  颜色证据来自 raw PTY ANSI：`38;2;46;160;67`（= `tuiPalette.add`）/ `38;2;138;135;126`（= dim）。

## 复跑入口

```bash
npx tsc --noEmit -p tsconfig.json
npx vitest run
$HOME/.bun/bin/bun test tests/tui/subagent-card-lines.test.ts \
  tests/tui/subagent-card-history-host.test.tsx \
  tests/tui/subagent-two-line-budget.test.tsx \
  tests/tui/subagent-message-lines.test.tsx tests/tui/message-blocks.test.tsx
```

注：本 worktree 的 `vendor/` 被 gitignore 覆盖，`tests/harness/aci/tools/grep.test.ts` 需要
`ln -s <主仓>/vendor/ripgrep vendor/ripgrep`（或 `npm run install:search-engine`）才绿。
