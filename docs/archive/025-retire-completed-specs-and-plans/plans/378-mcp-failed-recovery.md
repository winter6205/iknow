# Plan: MCP failed 状态恢复 + reload 超时可控 + 看板错误可见（#378）

> **Spec**: 无独立 spec，以 issue #378 为真值（三个根因 + 一个共性）。
> **Map**: wayfinder:map #378；根因 A/B/C + 共性见 issue 正文。
> **Tracker**: 本文件 12 bullets = 12 commits（D1 决策 + 11 实施/测试）；blocked-by 以本文件依赖图为真值，同 #337/#321/#343 先例。
> **前置隔离**: 工作树现存 `tests/harness/aci/tools/write-file-iknow.test.ts` 未提交漂移与本 plan 无关——执行第一票前先单独提交或 stash 隔离，此后每票 diff 只含 Affects 所列文件。

## 依赖图

```
D1（flip-back 裁决）──┬──────────────── T1（Slot 状态机）── T4（manager 测试）──┐
                      └──────────────── T2（env 超时）── T6（deps 注入测试）──┼── T7（npm test）── T8（集成）── T9（review）── T10（修）── T11（commit/push/PR）
                                                          T3（看板 error）── T5（mcp-view 测试）──┘
```

- `[parallel]`：T1 ∥ T2 ∥ T3（互不消费彼此产出；T1 与 T2 在 T6 装配点汇合）
- T4 依赖 T1（测试目标）；T5 依赖 T3；T6 依赖 T2 + T1（装配点注入）
- T7 依赖 T1/T2/T3/T4/T5/T6 全部；T8 独立但仅收 manager 层产物
- D1 只阻塞 T1（flip-back 语义是 T1 状态机的规格输入）

---

## Tracer Bullets

### D1. `[decision]` 超时 flip-back 语义 + 根因 C 边界裁决 `[blocks: T1]`

- **Affects**: `plans/378-mcp-failed-recovery.md`（D1 裁决区）、`CHANGELOG.md`（根因 C 一条记录，随 T11 落）
- **Acceptance**:
  1. **裁决 1（flip-back）**：仅超时路径可翻回——`setTimeout → markFailed(slot, "connect timeout")` 触发的 failed 允许迟到 connect/listTools 成功翻回 `connected`；`onclose → markFailed("connection closed by server")` 触发的 failed **不翻回**（server 已物理 EOF，成功信号不可能到达）；connect/listTools 真抛错路径（L262-264 / L279）触发的 failed **不翻回**（明确失败，不吞错）。判定依据：`timedOut` 标记只由超时回调置位，`markFailed` 时按 `timedOut` 分离两路状态迁移（见 T1）
  2. **裁决 2（根因 C）**：**本轮不实施**——MCP 子进程与 TUI 同进程组、终端 SIGINT 物理穿透 → child EOF → `onclose → markFailed`。SDK `StdioClientTransport` spawn 选项仅 env/stdio/shell/windowsHide/cwd，无 detached；改法需换 spawn 层（child_process.spawn + detached + 自建 IPC）或 setsid，风险跨模块（shutdown 收口 / CLI 信号语义），超出本票。单独 issue 承接；Affects 只列记录文件（CHANGELOG 一条 + 本 plan D1 区），不碰 `src/`
  3. 裁决理由写入本 plan D1 区：flip-back 只保超时路径，杜绝"真失败被 30s 超时吞掉后翻回"的状态漂移；`timedOut` 为 Slot 新字段，测试可断言
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T1. `[implementation]` Slot `timedOut` 标记 + flip-back 状态机 `[blocks: D1]`

- **Affects**: `src/harness/mcp/manager.ts`、`tests/mcp/manager.test.ts`（扩）
- **Acceptance**:
  1. Slot 增 `timedOut: boolean`（false 初始）；setTimeout 回调内先置 `slot.timedOut = true` 再 `markFailed(slot, "connect timeout")`（L235-237）；`markFailed` 统一兜底 `slot.timedOut = false`（恢复为 pending 时清除标记）；`rebuildSlots` 新建 slot 重置
  2. 两处 `if (slot.state !== "pending")` 守卫（L267-270 connect 后 / L274 listTools 后）改为：`slot.state !== "pending" && !slot.timedOut` 时直接 return；`timedOut` 且未真抛错 → 走注册 + `slot.state = "connected"` + 清除 `timedOut`。真抛错路径（connect/listTools catch）不翻回（`timedOut` 不参与——catch 直接 return）
  3. `onclose` 路径（L240-243）不置 `timedOut`，维持"非 connected 即 return"，与 flip-back 无关；`bootSlot` 内 `clearTimeout(timeoutHandle)` 时机不变
  4. `npm run typecheck` + `tests/mcp/manager.test.ts` 既有断言全绿（无回归）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` `IKNOW_MCP_CONNECT_TIMEOUT_MS` env + 装配透传 `[parallel]`

- **Affects**: `src/config/env.ts`、`src/tui/deps.ts`、`src/harness/build-engine.ts`、`tests/config/env.test.ts`（扩）、`tests/tui/deps-skill-mcp.test.ts`（扩）、`tests/build-engine.test.ts`（扩）
- **Acceptance**:
  1. `src/config/env.ts` 的 llm 命名空间（L318-335 envInt 先例）旁增 `mcp` 命名空间字段 `connectTimeoutMs`：`envInt({ file, key: "IKNOW_MCP_CONNECT_TIMEOUT_MS", fallback: 30_000 })`（envInt L166-171 值域纪律：非法/非有限 → fallback）；`loadIknowEnv` 装配进 `IknowEnv`（loop 三字段设置回退先例照搬，其他字段行为不变）
  2. `src/tui/deps.ts` L245-253 createMcpManager 装配点补 `timeoutMsOverride: env.mcp.connectTimeoutMs`（不设时 `?? DEFAULT_CONNECT_TIMEOUT_MS`，语义不变）；`src/harness/build-engine.ts` L226-230 装配点镜像透传同字段
  3. env.test.ts 补 3 例（合法数字 / 非数字非法回退 30_000 / 负值回退）；deps-skill-mcp.test.ts 与 build-engine.test.ts 断言装配点注入后 `createMcpManager` 收到 `timeoutMsOverride`（stub 工厂捕获入参）
  4. `npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` 看板渲染 `status.error`（列表行 + 详情模式）`[parallel]`

- **Affects**: `src/tui/mcp-view.tsx`、`tests/tui/mcp-view.test.tsx`（扩）
- **Acceptance**:
  1. 列表行（L188-205）：`failed` 且有 `status.error` → state 旁追渲染 error 首行（`clipOneLine` 截断，`pal.dim` + `pal.error` 色；error 列宽预算让位于名称截断 `maxLineWidth - 8` 既定逻辑，不溢出行）；`status.error` 缺席时列表行与现状字节一致（既有快照断言不破）
  2. 详情模式（L233-283，L273 无 error 现状）：failed + error → header 下追加 error 多行（按 `\n` 拆行、逐行 `clipOneLine`、`pal.error` 色），放于工具行之前；非 failed 态不渲染 error 区
  3. `mcp-view.test.tsx` 补"failed + error → 列表含 error 文本 + 详情含 error 首行"断言；`npm run typecheck` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` manager 测试：超时 → 迟到成功 → flip-back `[blocks: T1]`

- **Affects**: `tests/mcp/manager.test.ts`（扩）
- **Acceptance**:
  1. 场景 1（flip-back 主路径）：stub client connect 挂起 > 注入短 `timeoutMsOverride` → 断言超时后 `state: "failed"` + error 含 "connect timeout"；随后 stub connect/listTools 返回 → 断言 `state: "connected"` + 工具已 registerExternal
  2. 场景 2（onclose 不翻回）：`onClose` 触发后 failed，stub 迟到的 connect/listTools 成功 → 断言仍 `failed`、无 flip-back
  3. 场景 3（真抛错不翻回）：connect 真 reject → failed；listTools 真 reject → failed（无 flip-back）
  4. 5 边界类：empty（空 config 列表启动不抛）/ negative（`timeoutMsOverride: -1` 立即超时路径不崩）/ overflow（超时值超大或未设 → 默认 30_000 生效）/ concurrent（多 server 并发，一慢一快，快的不被慢的超时误标）/ exception（stub 抛异常 → failed 且 error 带 stderr 尾段，既有 `_stderrTail` 语义保留）
  5. reload 场景：reload 后 connect 慢 → 超时 → failed（旧 slots 已 shutdown，新 slots 从 pending 起算超时，断言 `McpServerStatus.error` 非空）；`npm run typecheck` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T5. `[implementation]` mcp-view 测试：pending→connected 过渡 + error 渲染 `[blocks: T3]`

- **Affects**: `tests/tui/mcp-view.test.tsx`（扩）
- **Acceptance**:
  1. pending→connected 过渡：props 注入 pending 态 → 渲染 `· pending` → 再注入 connected 态 → 渲染 `· connected`（无 error 行）；既有快照断言不破
  2. `status.error` 断言：failed + error → 列表行含 error 首行文本 + 详情模式 header 下含 error 行；长 error（> 行长）被 `clipOneLine` 截断不溢出行
  3. `npm test`（bun test tests/tui/）全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T6. `[implementation]` deps 注入测试：timeoutMsOverride 透传 `[blocks: T2, T1]`

- **Affects**: `tests/tui/deps-skill-mcp.test.ts`（扩）、`tests/build-engine.test.ts`（扩，可选并入 T2）
- **Acceptance**:
  1. deps-skill-mcp.test.ts：stub createMcpManager 捕获入参，断言 `timeoutMsOverride` 等于 `loadIknowEnv` 读到的 `env.mcp.connectTimeoutMs`；env 未设 → 断言未传或 fallback（取决于装配实现，取 `?? DEFAULT` 语义）
  2. build-engine.test.ts：TUI surface 装配断言同款捕获；`ask` surface 不创建 manager（SC12 既有语义不变）
  3. `npm run typecheck` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T7. `[implementation]` 全量测试绿 `[blocks: T1, T2, T3, T4, T5, T6]`

- **Affects**: 无代码改动（仅跑测）；回归清单 = T1/T2/T3/T4/T5/T6 全部新断言 + 既有 `tests/mcp/*` / `tests/tui/*` / `tests/config/*` / `tests/build-engine.test.ts`
- **Acceptance**:
  1. `npm test`（vitest run && bun test tests/tui/）exit 0，全绿
  2. `npm run typecheck` exit 0
  3. 输出完整粘贴进 T7 报告（ground truth，不摘录断言数）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T8. `[implementation]` 集成：server 启动超 30s → failed `[blocks: T1]`

- **Affects**: `tests/integration/mcp-chain.test.ts`（扩）
- **Acceptance**:
  1. 扩既有链测试：fixture stdio MCP server 注入环境变量使启动延迟 > 超时 → 断言 `McpServerStatus.state === "failed"` + error 含 "connect timeout"；启动 < 超时的对照用例保持 connected（不回归现有链断言）
  2. fixture 超时通过 `timeoutMsOverride` 注入短值实现（不真等 30s）
  3. `npm test` 全绿；若环境无法起真子进程 → 显式标注 Not run + 原因 + expected command，不得删测试（test.md 规范）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T9. `[implementation]` code review（Standards + Spec 双轴）`[blocks: T7, T8]`

- **Affects**: 无代码改动；审查对象 = D1 起的全部 diff
- **Acceptance**:
  1. 走 `arthurpower:code-review`（Standards + Spec 双轴并行子代理）→ High/Medium/Low findings 落到 T9 票
  2. 零 High；Medium/Low 全部进入 T10 修复清单或显式裁决不修
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T10. `[implementation]` 修 review findings + 重新验证 `[blocks: T9]`

- **Affects**: T9 findings 指向的文件（预期集中在 `src/harness/mcp/manager.ts`、`src/config/env.ts`、`src/tui/mcp-view.tsx` 及对应测试）
- **Acceptance**:
  1. T9 全部 High/Medium 修复落地；修复 diff 只含 findings 范围，不夹带新功能（minimal-change 纪律）
  2. `npm test` + `npm run typecheck` 重跑全绿（含 T7/T8 清单）
  3. `arthurpower:verification-before-completion` 过检（实际输出，不摘录）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T11. `[implementation]` commit + push + draft PR `[blocks: T10]`

- **Affects**: 全部 Affects 文件 + `CHANGELOG.md`（#378 一条：根因 A/B 修复 + 根因 C 单列后续）+ `docs/handoff/<latest>.md` 交接（如按常规）
- **Acceptance**:
  1. 每 bullet 独立 commit、Conventional Commits（如 `fix(mcp): #378 超时 flip-back` / `feat(config): #378 IKNOW_MCP_CONNECT_TIMEOUT_MS` / `fix(tui): #378 mcp-view 渲染 status.error` / `test(mcp): #378 超时 flip-back 边界`）
  2. `git push -u origin issue-378-mcp-failed-recovery`（有明确授权时）+ `gh pr create --draft`（标题含 #378）
  3. PR 描述列：12 bullets 完成态、T7 全绿证据、根因 C 单独 issue 链接
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Commit 纪律

- 每 bullet ≤1 commit、独立票分支；12 bullets = 12 commits（自然满足 ≥4 逻辑分组：①D1+T1 状态机 ②T2+T6 env 与装配 ③T3+T5 看板 ④T4/T7/T8 测试与集成 ⑤T9/T10/T11 收口）
- 根因 C 本轮不实施：Affects 只列 `CHANGELOG.md` 一条 + 本 plan D1 区，不碰 `src/`；承接走单独 issue
- 不改 `src/harness/mcp/manager.ts` 的 `_handles` 测试钩子、不改 shutdown 收口、不动 `archive/tui-ink/`、不改 `.iknow/mcp.json` 产品配置
