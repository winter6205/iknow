# Plan: tui-display-chrome

**Goal:** TUI 把 git 类进度流收成一行仍能看见最后一跳，结果行去掉每行 `>`，底栏固定为 ContextBar → 路径 → 子代理/Graph。
**Approach:** 先把已拍板词条写入 CONTEXT，再三条互不抢文件的显示切片并行落地：折叠函数进预览投影、装饰换 gutter、footer JSX 换序。不改 harness / 不接 bash 流式 stdout（运行中仍无预览事件）。
**Spec link:** 无独立 spec；合同来自 LogicSync（2026-09-11）+ 本文件 Inherits。
**ACR:** all-yes（DCV 首轮 unclear 已在本计划分配五类边界后关闭）

```
bounded-context-guardian: yes — 面锁 src/tui + tests/tui + CONTEXT 词条，不新开 BC
defensive-contract-validator: yes — fold 纯函数覆盖 empty / negative（非进度 `%` 行不折）/ overflow（先折再 5 行窗）/ concurrent（无共享状态）/ exception（失败仍 overlay）
error-handling-enforcer: yes — 无新错误类型；失败不走预览
complexity-anti-drift: yes — 折叠不进 JSX；阈值见 complexity-anti-drift
minimal-change-verifier: yes — 只做人读显示 + 词条，不扩 ACI
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → （整轮收尾才 code-review）→ verification-before-completion
**待写入:** （空 — T1 已刷入本 worktree `docs/CONTEXT.md`）

## Tasks (ordered by dependency)

1. **Persist display terms** — tag: `[decision]`
   - **Inherits:** 操作员改口：进度信息必须看见，只消轨迹；底栏 ContextBar→路径→子代理/Graph；结果行不要每行 `>`
   - **Surface:** `docs/CONTEXT.md`
   - **Acceptance:** 上列四词与两行对照已与本计划 Inherits 同义；无新 ADR
   - Status: [x] done
   - [blocks: T2, T3, T4]

2. **Fold progress ticks then tail-window** — tag: `[implementation]`
   - **Inherits:** 「同一过程只占一行、留最后一跳；Preparing / HEAD is now 等非进度行保留；先折再 5 行窗；成功 bash 落定仍画该窗」；`\\r` 视为原地覆盖
   - **Surface:** `src/tui` 预览投影（`tool-summary` / `tool-settled`）
   - **Acceptance:** `Updating files: 69%…100%` + 两行实况 → 可见最后一跳与两行实况，无中间百分比；`done at 50%` 这类非进度 `%` 不折；空输出仍 empty；失败 bash 无预览。现有 `tests/tui/tool-summary.test.ts` SC5 与 `tests/tui/tool-settled.test.ts` bash 成功槽改为认证本条
   - Status: [x] done
   - [blocks: T1]
   - [parallel] with T3 T4

3. **Result line gutter** — tag: `[implementation]`
   - **Inherits:** 不要每行 `>`；`… +N 行` 无箭头；正文 2 空格或一条 `│`；内容色 / 装饰 dim
   - **Surface:** `src/tui` 完成态预览渲染
   - **Acceptance:** 帧里结果行不再以 `> ` 开头；溢出行无 `>`；`tests/tui/completed-tool-preview-view.test.tsx` 与 live bash 预览前缀断言改钉本条
   - Status: [x] done
   - [blocks: T1]
   - [parallel] with T2 T4

4. **Footer slot order** — tag: `[implementation]`
   - **Inherits:** 输入框下第 1 行 ContextBar、第 2 行 session location、其后子代理再 Graph；路径不进焦点环
   - **Surface:** `src/tui` app chrome
   - **Acceptance:** 有活子代理时路径行下标介于 ContextBar 与子代理行之间；`tests/tui/chrome-footer-order.test.tsx` 认证该序
   - Status: [x] done
   - [blocks: T1]
   - [parallel] with T2 T3
