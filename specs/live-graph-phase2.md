# Spec: 活图阶段 2（失败边 + 同 id 再跑 + effort 熔断）

> Map: [#929](https://github.com/winter6205/iknow/issues/929)。本文件不写 CONTEXT / ADR 正文。
> Tracker：不建 GitHub tracer issue（操作员 2026-09-08）。落地 `specs/` + `plans/live-graph-phase2.md`。
> 实施前提：阶段 1 spec Success Criteria 已绿（活图 + 剩余子图 + 冻结）。

## ASSUMPTIONS（本轮 ADR 已收；不重开）

1. 仍走同一把 `run_graph`，不另开工具（ADR-0061）。
2. 回边由模型画并**显式标明**；不靠发现环来猜（ADR-0058）。未标明却有圈 → 该次调用拒（ADR-0059）。
3. 失败 = 该格 `NodeOutcome` **failed**；done 只走前进边；skipped 不走失败边。校验是图上普通节点（ADR-0055 / 0056）。
4. 同一次调用内可 **同一 id 再跑**（未冻结）；禁止偷换新 id 冒充绕回（ADR-0053）。回边不得指向已冻结 id（ADR-0060）。
5. 一格 failed 只启动 **一条** 失败边、**一个** 格子（ADR-0062）。终点可以是新格或未冻结旧格；host 不选路（ADR-0063）。
6. effort = 一次 `run_graph` 内每 id **进入次数**（含首次）；默认阈 **8**，第 9 次熔断；本图不进 settings（ADR-0057 / 0064）。
7. 阶段 1 看见失败边标记仍拒（ADR-0067），直到本阶段把字段写进 schema。
8. 字段名本 spec 钉死：`onFailure`（见 Changes）。不是产品分叉，是 wire。

→ 以上视为已确认。

## Glossary（exact copy from docs/CONTEXT.md）

- **run_graph**: 常驻注册的 ACI 工具——父代理声明 DAG，host 走 `validateGraph` → waves → `createSubAgentNodeExecutor`；图节点仍是前景 spawn。graph mode 关闭时由 handler 层 EXIT 拒绝调用，工具面不随模式增删（ADR-0041）。跨回合权威不在单次回执里，见 **活图状态**。阶段 2 绕回仍用这一把，不另开工具（ADR-0061）。一段调用在跑时父代理不能并行干别的；最多主进程静默等待（ADR-0065）。
- **活图状态**: 会话持有的那张可修订 DAG 及已完成节点——跨父代理回合、跨多次 `run_graph` 仍是同一张图；已完成在此冻结、不重演。不是 graph mode，也不是单次 `run_graph` 栈帧里的 `GraphExecution`。第一次交节点时建立；关 overlay 不销毁。ADR-0047 / ADR-0051。
- **图内绕回**: 阶段 2：同一次 `run_graph` 里沿边回到未冻结节点，**同一 id 再跑**；失败边也可指向尚未跑过的新格。回边由模型画在图上并**显式标明失败才走**；仅当该格 `NodeOutcome` 为 **failed** 时走，且失败后只启动**一个**格子；done 走前进边；skipped 不走回边。去向交图时写死，host 不选路。校验是图上普通节点，不是 host 暗闸。有圈却未标明回边、或回边指向已冻结 id、或边指向本次没有的 id，则该次调用拒绝。阶段 1 看见失败边标记亦拒。ADR-0053–0067。
- **NodeOutcome**: 见 `src/harness/graph/types.ts`（done / failed / skipped）。

## Objective

同一段 `run_graph` 内，模型可用标明的失败边在格子 **failed** 后走一个指定格子（回走未冻旧 id 或开新 id）。Host 按标记执行、按进入次数熔断空转。成功 = 下列 Success Criteria 全绿。

## Boundaries

- **Does:**
  - schema 增加可选 `onFailure: string`（单终点）。
  - 前进边 = `deps`（全部 **done** 才启动）。失败边 = `onFailure`（起点 **failed** 才启动终点一次进入）。
  - 只对 `deps` 做环检测：`deps` 成环 → 拒。仅因 `onFailure` 形成的圈合法。
  - 调度按上述启用规则执行（实现不锁 Kahn 函数名）。
  - effort：每 id 进入 +1，>8 则该次调用熔断，已 done 留在活图，typed 说明，之后仍可外环交**新 id**。
- **Confirms with human:** （none）
- **Out of this spec:**
  - TUI 进度；`wait:false`。
  - effort 进 settings / 改 8。
  - 一格多条失败边；host 按失败文本选路。
  - 阶段 1 外环次数硬顶；todo。
  - LangGraph / JS workflow runtime。

## Success Criteria

每条 yes/no。`npm test` 含本 spec 新增测试退出 0；`npm run typecheck` 退出 0。

1. **失败走开格（未冻）：** 格子 C 带 `onFailure: X`。C **failed** 后 X 进入，当且仅当 X 此时不是 **done**（本段内可再进刚 **failed** 的旧 id，含 `onFailure` 指向自己）。C **done** 则不走 `onFailure`。X 在活图上已是外环冻结的终态，或本段里已经 **done** → 不 spawn X，该次调用 typed 拒绝（ADR-0060 / ADR-0053：done 永不因失败边再跑）。
2. **新格：** C `onFailure: D`，D 尚未跑过，C failed 后 D 首次进入；C done 则 D 不因此进入。
3. **skipped 不走失败边：** 节点 skipped 时不触发其 `onFailure`。
4. **未标圈拒：** 仅 `deps` 成环（无 `onFailure` 把圈拆成前进 DAG）→ typed 拒绝、零 spawn。
5. **未知 / 冻结 / 多终点：** `onFailure` 指向本次没有的 id、指向活图上已冻结 id、或节点声明两条失败边（第二属性 / 数组）→ typed 拒绝、零 spawn。
6. **同 id 再跑：** 失败回走到未冻旧 id 时 spawn 次数增加，id 不变；不得靠换新 id 才「像」绕回（测试用同一 id 断言两次 executor 进入）。
7. **effort 8：** 同一 id 在一次调用内第 9 次进入 → 该次调用 typed 熔断；进入次数 ≤8 的合法绕回不熔断。熔断后已 **done** 的 id 仍冻结；外环可交新 id 并 spawn。
8. **仍阻塞：** 失败绕回发生在同一次 handler 返回之前；无 `wait:false`。
9. **阶段 1 行为不回退：** 不带 `onFailure` 的 DAG 仍 Kahn 语义；重交已冻 id 仍拒。

## Open Questions

(none)

## Inherits / Changes

**Inherits：**

- `specs/live-graph-phase1.md` 全绿。
- ADR-0053–0064、0061。
- `NodeOutcome` 三态；节点仍前景 spawn。

**Changes：**

- 节点 schema 增加可选 `onFailure`：`string`，目标必须是本次 `nodes` 的某个 `id`。节点仍 `additionalProperties: false`。
- 阶段 1 的「看见失败标记就拒」改为：只拒非法标记；合法 `onFailure` 执行。
- `deps` 上的自依赖仍拒；`onFailure` 指向自己视为标明的单格再进入，合法。
- 纯 Kahn `topoWaves` 不足以跑带 `onFailure` 的图；调度须按 SC1–SC3。

## architecture-change-reviewer

Affects（实施时）：`src/harness/graph/`（schema、校验、调度、effort）、对应 `tests/`。不改 TUI。不另开 ACI 工具。

```
bounded-context-guardian: yes — 仍在 harness/graph；不新工具名；session 只继续持有活图。
defensive-contract-validator: yes — 空/未知 onFailure、冻 id、deps 环、并发进入超 8、executor 抛错 五类由校验+调度+熔断测试覆盖。
error-handling-enforcer: yes — 非法图与熔断 typed；熔断不丢已 done；无空 catch。
complexity-anti-drift: yes — 前进校验 / 失败边启用 / effort 计数分开，不把熔断塞进 validateGraph。
minimal-change-verifier: yes — 只加失败边与熔断；plan 一刀一提交；阶段 1 冻结语义不重写。
```

## 待写入

空。
