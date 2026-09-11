# Plan: S5 复杂度拆分 — chat-view.tsx 归零（issue #986 优先项）

**Goal:** 把 `src/tui/chat-view.tsx` 的 S5 hard-gate error 清零（当前 3 errors：`ChatView` complexity 45、嵌套 5、内部箭头函数 complexity 12），纯结构重构，零行为改动。

**Approach:** 按仓库既有先例（`turn-activity.ts` / `transcript-viewport.ts`：纯派生逻辑进 `.ts`，渲染进兄弟 `.tsx`）把 `chat-view.tsx` 的内联逻辑与渲染块外移。**关键约束（ACR 实测得出）**：不允许「搬家式抽取」—— 折叠块与段渲染器原样外移会在新文件复现 cc 18 / depth 5 / cc 12，被 pre-commit 的 new-function ratchet（对新增函数零容忍）拦下。新抽出的纯模块必须配 `tests/tui/turn-fold-lines.test.ts` 五类边界测试。

**Spec link:** `specs/tui-transcript-viewport.md`（invariants 1–8）、`specs/tui-display-consistency.md`（D1 shared shell）
**Tracker:** GitHub issue #986（本 PR 只做其点名优先项：chat-view.tsx）
**Per-ticket loop:** 一刀实现 → typecheck + 测试 → S5 复测 → 整轮 code-review。

## 现状证据（实测）

`npm run lint:s5:all`（2026-09-11，本 worktree，commit 32015aa8）：

- 全仓 238 errors / 199 warnings（issue 记录为 240/196，已轻微漂移）
- `src/tui/chat-view.tsx`：573:3 error complexity 45 + warning 577 行；468:15 error max-depth 5；650:47 warning 106 行闭包；688:76 error complexity 12

## ACR

Affects: `src/tui/chat-view.tsx`、`src/tui/` 新兄弟文件（`turn-fold-lines.ts` + 行/尾部组件）、`tests/tui/` 新测试文件。

**首轮 verdict（ACR agent 实测，BLOCKED：2 维 no）**

```
bounded-context-guardian: yes — 新模块全是 src/tui 同 capability 内 sibling；chat-view 导出面不动。
defensive-contract-validator: no — 未给新 pure/helper 面分配五类测试。
error-handling-enforcer: yes — 全文件 0 throw/catch；3 处 EXIT 回退落在抽取区外、原地保留。
complexity-anti-drift: no — 实测抽取集后 ChatView 仍 cc 17；折叠块原样外移 cc 18 + depth 5；688 段外移仍 cc 12。
minimal-change-verifier: yes — 单任务，diff 限于 src/tui/chat-view.tsx + src/tui/ 新文件 + 新测试。
```

**修正后 verdict（按 ACR 的 blocking fixes 重写计划）**

```
bounded-context-guardian: yes — 同上；新增测试落 tests/tui/，与 src/tui/ 同 capability。
defensive-contract-validator: yes — 新增 tests/tui/turn-fold-lines.test.ts，按 tests/tui/turn-activity.test.ts 体例补齐 empty / negative / overflow / concurrent / exception 五类。
error-handling-enforcer: yes — 抽取不引入新失败路径；既有 3 处 EXIT 回退原地保留。
complexity-anti-drift: yes — 折叠块拆成每函数 ≤10（per-segment 循环体与 fallback 路径分离；depth 5 用 early-continue 反转而非抽大 helper）；段渲染器再降 2 分支；ChatView 本体按实测最小集抽到 cc ≤10。
minimal-change-verifier: yes — 单任务（chat-view.tsx hard-gate 清零），无第二 feature，无新增依赖。
```

## 最小抽取集（ACR 实测证明）

| 抽取项                                   | 源行              | 去向                                                                                                                                                                                          |
| ---------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 折叠块派生（turn/fold lines）            | 307–545           | `src/tui/turn-fold-lines.ts`（纯 helper，拆成每个 ≤10；per-segment 循环体 385–430 单独成函数是 clean 的；fallback 437–474 独立；`if (!A && !B) {} else {}` 反转为 early-continue 破 depth 5） |
| banner                                   | 604–638           | 兄弟组件 `<TranscriptBanner>`                                                                                                                                                                 |
| spacerBefore / spacerAfter               | 642–649 / 769–776 | 兄弟组件（或并入 transcript 行组件族）                                                                                                                                                        |
| 挂载消息行                               | 650–768           | 兄弟组件 `<MessageRow>`（`tmsg-${visibleIndex}` id、`width={contentWidth}`、`flexShrink={0}` 必须在根节点保持；`visibleIndex` 由 ChatView 计算后透传）                                        |
| 内层段渲染器                             | 688–748           | `<MessageRow>` 内部再拆（cc 12 → 再降 2 分支或拆子组件）                                                                                                                                      |
| crunched 行                              | 777–785           | tail 组件                                                                                                                                                                                     |
| tail slots                               | 791–817           | tail 组件                                                                                                                                                                                     |
| thinking live 面板                       | 826–852           | tail 组件                                                                                                                                                                                     |
| legacy liveToolLines / askLine / Spinner | 853–867           | tail 组件                                                                                                                                                                                     |

只抽部分不过（ACR 实测：仅抽 4 项主集 → cc 17；+642-649/769-790 → cc 12；再 +853-867 → cc 9）。

## 必须保留的承重契约

- `id={`tmsg-${visibleIndex}`}` + measure `useLayoutEffect`（283–306）的 DOM-id 契约；行组件根节点不得丢 id/width/flexShrink，`visibleIndex` 不得在组件内用 `i` 重算。
- `sbRef` + 两个 `useLayoutEffect` + `useImperativeHandle` 留在 ChatView（scrollbox 元素与 ref 绑定）；折叠 hook 必须顶层无条件调用。
- `statusMap` / `resultTextMap` / `visibleMessages` / `sourceIndexOfVisible` / `historyToolUseIds` 的 useMemo 留 ChatView；真正的 memo 边界是 `MessageBlocks`（`message-blocks.tsx:230`），由 `tests/tui/history-rerender-cost.test.tsx` 钉死。
- fold 行继续用 `<text>`（不得改 Markdown）；`contentWidth = props.cols - 2` 透传。

## Tasks

1. **抽 `turn-fold-lines.ts` 纯模块 + 五类边界测试** — tag: `[implementation]`
   - **Surface:** `src/tui/turn-fold-lines.ts`（新）、`tests/tui/turn-fold-lines.test.ts`（新）
   - **Acceptance:** 折叠派生逻辑逐字节等价；新测试覆盖 5 类；S5 对两个新函数 0 error
2. **抽渲染组件（banner / MessageRow / tail）** — tag: `[implementation]`
   - **Surface:** `src/tui/chat-view.tsx` + 新兄弟 `.tsx`
   - **Acceptance:** `npm run lint:s5:all` 对 `src/tui/chat-view.tsx` 与新增文件 0 error；`chat-view.tsx` ≤1000 行
3. **验证** — tag: `[verification]`
   - **Acceptance:** `npm test` 与 baseline 同集合绿（见下方 baseline 说明）；`npm run test:real-llm` 不涉及；TUI 真实交互实测

## Baseline（改动前，已固化）

- S5 全量：238 errors / 199 warnings（`.tmp-s5/baseline.txt`）
- `npm test`：13 failed files / 20 failed tests，**全部为既有环境债**，已用干净 master 主 checkout 对照复现（`tests/subagent/spawn-subagent.test.ts` 等）。主因：agent catalog 新增 2 个 id 使硬编码断言失效、countTokens 网络不可达、SIGINT 投递时序。**判据：改动后失败集合不得超出此集合。**
