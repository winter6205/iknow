# Plan: 子代理能力 V1 · SPEC-1 种子（#356）

> **Spec**: `specs/356-subagent-v1.md`（ACR self-audit 5/5 yes，2026-08-10）
> **Map**: wayfinder:map #331；决策出典 T1 #130 / T2 #332 / T3 #333 / T4 #334 / T5 #335 / T6 #353
> **Tracker**: GitHub issue（`ready-for-agent` 标签）；blocked-by 以本文件依赖图为真值。
> **前置隔离**（spec 假设 19）：工作树已存在的 `package.json` / `package-lock.json` / `.iknow/mcp.json` 未提交漂移与本 plan 无关——执行第一票前先单独提交或 stash 隔离，此后每票 diff 只含 Affects 所列文件。

## 依赖图

```
D1（worker 协议探针）──┐
T1（worker 模式 + 信封）┤
T2（SubAgentManager）──┼────── T4（spawn_subagent 工具）──┐
T3（role deny-list）───┤                                    ├─ T6（装配 + shutdown）
T5（subagent_result）──┘                                   │
                            └──────────── T7（host drain + E2E）──┘
```

- `[parallel]`：T1 ∥ T2 ∥ T3（互不消费彼此产出；T2 消费 T1 的 spawn 签名约定，但可并行写）；T4 ∥ T5（各自消费 T2/T3 工具面）；T6 依赖 T4+T5；T7 依赖 T6
- D1 只阻塞 T1（探针结论决定信封 schema 形态与 ajv 编译路径）

---

## Tracer Bullets

### D1. `[decision]` worker 协议信封 ajv 兼容性探针 + envelope schema 冻结 `[blocks: T1]`

**裁决（D1 探针实跑 2026-08-10）**：**全 pass → T1 直连**，无前置 schema 归一化子步骤。

- `scripts/subagent-envelope-probe.ts` 实跑：`PASS  worker envelope schema` / `PASS  parent envelope schema` / 5 个 fixture 验证 PASS（含 parent 三类 ok / failed+reason / illegal 缺 status；worker 合法最小 / 缺必填 task）。
- ajv 配置 = 仓库同款 `strict:true + allErrors + ajv-formats`，与 `src/harness/tools/registry.ts makeAjv` 一致；两组 schema 编译 exit 0。
- 落点 `src/harness/subagent/envelope.ts` 导出 `parseWorkerEnvelope` / `parseParentEnvelope` / `truncateEnvelopeResult` + 类型 `WorkerEnvelope` / `SubAgentEnvelope` + schemas（`Record<string, unknown>` 形态，对齐 `ToolDef.inputSchema`），错误用既有 `ProtocolError`。

- **Affects**: `scripts/subagent-envelope-probe.ts`（新，一次性探针）、`src/harness/subagent/envelope.ts`（schema 冻结落点）
- **Acceptance**:
  1. 探针用仓库同款 ajv 配置（`strict: true` + ajv-formats，同 `src/harness/tools/registry.ts`）编译两组 envelope schema（父→子：`{task, systemPrompt?, disallowedTools?, maxTurns?, timeoutMs?, sandboxRoot, env}`；子→父：`{status, summary, result, fileRefs, usage}`，status ∈ {ok, failed} + reason 四值），输出每组 pass/fail
  2. 结论写入本 plan D1 裁决区：**全 pass → T1 直连**；**任一 fail → T1 前置 schema 归一化子步骤**（只作用于 envelope 路径，不改全局 ajv，spec Boundaries Ask first）
  3. schema 冻结：缺字段 / wrong type / 非对象 → throw（协议错误）；多 newline → 第二条独立 parse；stdout 一条 newline 收尾（SC2/SC13 形态）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T1. `[implementation]` `--subagent-worker` 二进制模式 + JSON 信封 + worker 独立 run() `[parallel]`

- **Affects**: `src/cli/parse-args.ts`（`CliCommand` 加 `"__subagent_worker__"` + `--subagent-worker` 早 flag 解析）、`src/cli.ts`（main dispatch 加早返回分支）、`src/harness/subagent/worker.ts`（新）、`src/harness/subagent/envelope.ts`（新，D1 冻结后落地）、`tests/subagent/envelope.test.ts`（新）、`tests/subagent/worker.test.ts`（新）
- **Acceptance**:
  1. `node <iknow-bin> --subagent-worker` 进入 worker 模式：`process.stdin` 一行 JSON → 解析（envelope schema，D1 冻结）→ 独立 `run()` → stdout newline-JSON emit `{status, summary, result, fileRefs, usage}`（SC2）
  2. `parseArgs` 公共 argv 形态不暴露 `--subagent-worker` 给产品用户（`CliCommand` 联合含 `__subagent_worker__` 但 `printUsage` 不含；双下划线前缀区别，spec Boundaries Never）；`console.log` 全部改 `process.stderr.write`，stdout 严格单 wire（SC11）
  3. worker 进程 `SIGTERM` 友好收尾（flush 后退出码 0）；未捕获错误 → exit 非 0（协议层崩溃，SC13）
  4. `npm test` 全绿（stub env，无真 LLM key）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T2. `[implementation]` SubAgentManager：spawn / 状态机 / buffer / shutdown `[parallel]`

- **Affects**: `src/harness/subagent/manager.ts`（新）、`tests/subagent/manager.test.ts`（新）
- **Acceptance**:
  1. `spawn(def): { taskId }` 同步入 map 立即返（`randomUUID()` 唯一真值，SC3）；child spawn 后 `task.state = running`；`child.on('exit', code≠0 || signal)` → crashed；`child.on('error')` → crashed（协议错误路由）
  2. `queryBuffer(task_id)` 同步非阻塞四态：not_found / running / completed / failed（reason 含 crashed | maxTurnsExceeded | timeout | protocolError，SC5 形态）
  3. `shutdown()` 仿 mcp/manager 蓝本：abort in-flight + SIGTERM stdio 子孙 + ≥5s 未退出 SIGKILL 兜底（SC12）；与 in-flight 并发 → 明确取消语义不悬挂（SC16）
  4. 三类失败各自独立判定函数 + fixture（crashed / timeout / maxTurnsExceeded，SC6，不可合并）；`npm test` 全绿（fake spawn 工厂）
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T3. `[implementation]` 角色机制 + deny-list 装配裁剪 `[parallel]`

- **Affects**: `src/harness/subagent/role.ts`（新）、`tests/subagent/role.test.ts`（新）
- **Acceptance**:
  1. `SubAgentDefinition { systemPrompt, disallowedTools, model, maxTurns, timeoutMs }` 类型 + 默认 deny-list = `['spawn_subagent']`（SC9，v1 嵌套禁派发）
  2. 装配期工具面裁剪：`disallowedTools` × 子代理 registry 可用集交集 → 从 worker 的 registry 剔除；越界工具名（不在 registry）→ `RegistryConstructionError`（SC9）
  3. 空 deny-list → 全 25 件可用；deny-list 含 `edit_file`/`write_file`（verifier 角色，#334 Q5 基础）→ 只剔除这两件；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T4. `[implementation]` `spawn_subagent` ACI 工具 + 名单 23→24 `[blocks: T2, T3]`

- **Affects**: `src/harness/subagent/spawn-subagent-tool.ts`（新）、`src/harness/aci/tools/registry.ts`（append `spawn_subagent`）、`tests/subagent/spawn-subagent.test.ts`（新）、`tests/harness/registry.test.ts`（改断言 24 件）
- **Acceptance**:
  1. `ACI_TOOLSET_NAMES` 长度 24、末尾 `spawn_subagent`；Gate 3 装配校验通过（SC1）；`isConcurrencySafe:true` + `category:"read-only"` + `timeoutTier:"fast"` + `lazy:false`（SC4）
  2. handler ≤ 50ms 返回 `{task_id}` JSON（同步，SC4）；`task` 缺失/非 string → `ToolExecutionError`；`background:true` → `ToolExecutionError("background:true not implemented in v1")`（SC4）
  3. 工具 description 含派发规则引导（#331 T7：派发规则在 tool description 而非主 system prompt）；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T5. `[implementation]` `subagent_result` ACI 工具 + 名单 24→25 `[blocks: T2, T3]`

- **Affects**: `src/harness/subagent/subagent-result-tool.ts`（新）、`src/harness/aci/tools/registry.ts`（append `subagent_result`）、`tests/subagent/subagent-result.test.ts`（新）、`tests/harness/registry.test.ts`（改断言 25 件）
- **Acceptance**:
  1. `ACI_TOOLSET_NAMES` 长度 25、末尾 `spawn_subagent` / `subagent_result`；Gate 3 校验通过（SC1）
  2. handler 同步非阻塞查询面四态（SC5）：not_found → `{status:"not_found"}`；running → `{status:"running"}`；completed → full envelope；failed → `{status:"failed", reason, summary}`（reason 四值各自 fixture）；handler ≤ 10ms（无 sleep）
  3. `category:"read-only"` + `timeoutTier:"fast"` + `lazy:false`；`npm test` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T6. `[implementation]` build-engine 装配 + ask 剥离 + shutdown 接线 `[blocks: T4, T5]`

- **Affects**: `src/harness/build-engine.ts`、`src/cli/runtime.ts`（registerShutdown 顺序）、`tests/build-engine.test.ts`（扩）
- **Acceptance**:
  1. chat/tui/serve surface：创建 `SubAgentManager` + 两件工具在场；ask surface：manager 未创建、registry/executor/catalog 三方视图不含 `spawn_subagent` / `subagent_result`（SC8）
  2. `BuiltEngine.shutdown` 多挂 `subagentManager.shutdown()`；`registerShutdown` 顺序 mcpManager.first → subagentManager.second（SC12）
  3. `npm test` + `npm run typecheck` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### T7. `[implementation]` host drain + run() 边界注入 + E2E A `[blocks: T6]`

- **Affects**: `src/harness/subagent/host-drain.ts`（新）、`src/cli/chat-session.ts` / `src/session-api/` / `src/tui/`（run() 边界之间调用 drain，loop-engine 零改动）、`tests/subagent/host-drain.test.ts`（新）、`tests/integration/subagent-chain.test.ts`（新）、`tests/e2e/subagent-acceptance.test.ts`（新）
- **Acceptance**:
  1. `drainPendingSubagents(manager)`：completed 浓缩 envelope → 拼成 `## Sub-agent <id> result: <summary>\n\n[result]` user message 串；空 manager → ""；混合 completed + running → 只 drain completed（SC7 形态）
  2. 在 `chat` / `tui` / `serve` 三入口每次 `run()` 收尾后、下一次 run 启动前调用，结果作为一条 user message 入 `run(..., {priorMessages})`；**loop-engine 自身零改动**（`run()` 签名与行为不变，断言对 run 无 diff）
  3. E2E A（SC14）：stub-model 脚本 `spawn_subagent → drain → 下一轮模型可见浓缩结果`，`npm test` 内可复现不依赖真 LLM key
  4. `npm test` + `npm run typecheck` 全绿
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## 验收汇总（spec Success Criteria 映射）

| SC                       | 落点              |
| ------------------------ | ----------------- |
| SC1 名单 25 件           | T4/T5             |
| SC2 worker 协议          | T1                |
| SC3 manager API          | T2                |
| SC4 spawn_subagent 语义  | T4                |
| SC5 subagent_result 四态 | T5                |
| SC6 三类失败独立         | T2                |
| SC7 host drain           | T7                |
| SC8 ask 剥离             | T6                |
| SC9 deny-list            | T3                |
| SC10 浓缩截断            | T1（envelope.ts） |
| SC11 stdout 单 wire      | T1                |
| SC12 退出链              | T2/T6             |
| SC13 schema 严校验       | T1/D1             |
| SC14 E2E A               | T7                |
| SC15 全绿                | 每票              |
| SC16 并发                | T2                |

## 依赖出典

- worker 协议 + 独立 registry：#130 Q1/Q2 + #331 T1
- JSON 信封四态：#130 Q1 + #331 T1 + #335 Q7（reason 细分）
- 角色 deny-list：#334 Q5 + #331 T4
- manager 生命周期蓝本：`mcp/manager.ts:266-306`（#337 已落地）
- surface 门控：#331 T1（chat/tui/serve 挂载、ask 不挂）
- spawn 复用先例：`identity/host-init.ts:29`（`child_process.spawn`）
