# Spec: TUI `run_graph` 执行视图（chrome 一行 + 语义分组）

> Wayfinder: map [TUI run_graph 执行视图（拓扑 + 状态同屏）](https://github.com/winter6205/iknow/issues/749)。原型拍板：[run_graph 执行中 DAG 在 TUI 里长什么样](https://github.com/winter6205/iknow/issues/751) CLOSED。
> 本文件 **不写** CONTEXT / ADR 正文。无新术语、无新 ADR（流事件若 additive，沿用既有 `HarnessStreamEvent` 扩展点）。
> 原型 `npm run prototype:run-graph-dag` / `src/tui/prototypes/` **对照定稿，不推进生产路径**。

## ASSUMPTIONS（地图 + 原型已收；grilling 未关票一并收口，不重开）

1. 产品面是 **TUI**。Web / traceserver 生命周期面板不是本 spec。
2. **不画**竖树 / wave 列 / 盒线 DAG。眼选定稿 = 主会话 **chrome 一行** + `enter` 后的 **语义分组视图**（now / issues / done / waiting / selected）。标识英文 **`graph`**，不叫 dag。不可编辑。
3. 热路径 = `runGraph` 已有 `onWave` / `onNode` **push 快照**到 TUI。不扫 JSONL、不问 traceserver。JSONL 仍只给回放。
4. 同一份快照驱动 chrome 与分组视图；节点状态变化即更新（含 running 起跳）。chrome **恒 1 行**。
5. 分组规则（原型）：**now** = 正在跑；**issues** = 失败，因此 skipped 的节点挂在对应失败行下；**done** = 已完成（可并行的同一波可并列）；**waiting** = 按 `waiting on <node>` 分簇；**selected** = needs / unlocks / last。
6. glyph：`*` running · `+` done · `x` failed · `-` skipped · `.` pending。分组标题 dim，正文默认色（本 spec **不加**红绿状态色）。
7. 焦点：`down`/`tab` 离开输入框落到 graph 行，行首 `>`；`enter` 进分组视图；视图内 `up`/`down` 选节点；`esc` 逐级返回。
8. 节点 `enter`：展示该节点 **last 输出 / 失败原因 / 耗时**（有现成 worker 会话 UI 则复用，没有则文本即可）。禁止把原型假 transcript 当产品。
9. 大图：分组视图 **滚动**，不截断 N、不另做折叠产品。chrome 仍 1 行。
10. [TUI 图模式可视化（进度 / 节点状态 / 摘要展示）](https://github.com/winter6205/iknow/issues/726) 的产品意图由 **本 spec 落地**；合入后关那张票。不另开「只做摘要行」分叉。
11. 零新 runtime 依赖。栈仍 TypeScript + vitest + 现有 OpenTUI TUI。
12. 不改 `run_graph` 编排语义（仍前景 wait、全局 cap 4、拓扑失败零 spawn）。本 spec 只加 **人眼进度**。

→ 以上视为已确认。

## Glossary（exact copy from docs/CONTEXT.md）

- **graph mode**: 会话级编排 overlay，不是 PermissionMode。Shift+Tab 三态轮 `Default → Auto → Graph → Default`（`/graph` 为非 TTY 对等物）；进 Graph 后**下一次 `run()` 装配**才注入编排段并露出 `run_graph`，过程中切换不拦、不中途重装配。ADR-0030。
- **run_graph**: 仅 graph mode 打开时装配的 ACI 工具——父代理声明 DAG，host 走 `validateGraph` → waves → `createSubAgentNodeExecutor`；图节点仍是前景 spawn。默认模式不装。
- **前景 spawn / 后景 spawn**: `spawn_subagent` 的两种结果契约（#361 裁决，ADR-0014）——前景（`wait:true`，默认）= handler 同步等 worker 到终态、envelope 直接作 tool_result 返回，当回合闭环；后景（`wait:false`，显式选项）= 立即返回 task_id，结果经 host 唤醒/drain 通道回传。worker 恒为独立进程，与前景/后景正交。

## Objective

`run_graph` 在跑时，TUI 操作员能看见 **这是一张图、现在谁在跑、谁因谁失败/等待**，而不必读 tool JSON。成功 = 下列 Success Criteria 全绿。

## Boundaries

- **Does:**
  - 接 `onWave` / `onNode`，把节点 id / deps / status / 粗摘要推到 TUI（经既有 host 流或 hub 缝；additive）。
  - ContextBar 一带 **1 行** `graph` chrome（计数 + now 节点）；计入 `chromeReserveRows`。
  - 全屏语义分组视图（规则见 ASSUMPTIONS）；键盘路径见上。
  - 无 `run_graph` 或无快照 → **不出现** graph 行（零行为变化）。
- **Confirms with human:** （none）
- **Out of this spec:**
  - [性能优化 + 编排 prompt 实测迭代](https://github.com/winter6205/iknow/issues/727)
  - [智能体完整生命周期追踪面板](https://github.com/winter6205/iknow/issues/284) Web 主视图
  - DAG 编辑器；盒线/竖树/wave 列布局；LangGraph；`wait:false` / mailbox
  - serve / Web 对等 UI
  - 把 `src/tui/prototypes/` 并进生产入口

## Success Criteria

每条 yes/no。命令以 worktree 根为准。

1. **有图才有行**：一次带 `run_graph` 的 TUI 路径，工具运行中 chrome 出现 `graph` 一行（含 done 计数与 now 节点名或等价）；该次调用结束或取消后该行消失。无 `run_graph` 的回合不出现该行。
2. **分组能扫读**：同一假或真快照下，分组视图同时展示 now / issues（失败行下挂 skipped）/ done / waiting（按 `waiting on <id>` 分簇）/ selected；文案英文；glyph 集合为 `*+x-.`。
3. **不是 JSONL 热路径**：进度更新在 `runGraph` 回调之后即可被 TUI 状态读到；测试不依赖读会话 JSONL 文件。
4. **拓扑失败仍零 spawn**：非法图仍 typed 拒绝、零 spawn（既有 SC 不回退）。`npx vitest run` 覆盖 graph 校验的既有测试退出 0。
5. **栈**：`package.json` 无新 runtime 依赖。`npm run typecheck` 退出 0；本 spec 新增测试含在 `npm test` 内且退出 0。

## Open Questions

(none)

## Inherits / Changes

**Inherits：**

- ADR-0030 graph mode overlay；ADR-0014 前景节点 + 全局 cap 4。
- `runGraph` 的 `onWave` / `onNode`；`createSubAgentNodeExecutor`。
- `HarnessStreamEvent` additive 扩展 + `safeEmitStream`（观察者不得反流）。
- TUI：`chromeReserveRows`、ContextBar、SubagentPanel 扁平条、ChatView **禁止行账**（`specs/tui-transcript-viewport.md`）。分组视图走独立 view，不拿 markdown 估行。
- 测试：`npm test`、`npm run typecheck`。
- 原型决议只作视觉契约，见 [issue 751 resolution](https://github.com/winter6205/iknow/issues/751)。

**Changes：**

- TUI 增加 `run_graph` 执行中 chrome + 分组视图。
- host 增加图进度快照（缝的具体类型名由实施定）。

## architecture-change-reviewer

Affects（实施时）：`src/harness/graph/`（接回调，不改拓扑语义）、`src/harness/stream.ts` 或等价 hub 缝、`src/tui/`（chrome + view + 键）、对应 `tests/`。不改 `PERMISSION_MODES`、不改 ACI 工具 schema。

```
bounded-context-guardian: yes — 编排与 topo 留在 harness/graph；TUI 只消费快照 DTO，不反向 import topo 实现。
defensive-contract-validator: yes — 无快照/空节点、取消中途、节点数滚动溢出、并发 onNode、handler abort EXIT 五类由进度缝 + 视图测试覆盖。
error-handling-enforcer: yes — 沿用 run_graph 取消 EXIT；emit 走 never-throw 观察者；无快照则不画行，不空 catch。
complexity-anti-drift: yes — 快照 / chrome / 分组视图三层，不把分组规则写进 run-graph-tool。
minimal-change-verifier: yes — 只加人眼进度；不混 #727、不把 prototypes 目录当生产。
```

## 待写入

空。
