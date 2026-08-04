# Token accounting 显示路径 — 实施计划

**Source**: #160 Resolution（wayfinder:grilling，closed 2026-08-05，六题 HITL 裁决）+ ADR-0008（accepted，设计真值 SSOT，commit c7fc464）。
**Tracker**: GitHub issues（label `ready-for-agent`，native blocking via GraphQL `addBlockedBy`）。
**范围**: 只实施 ADR-0008 Implementation split 的**显示路径**——adapter 透出 usage → `AssistantTurnResult` 密封透传 → loop-engine 抄入 `recordLlmCall` → `RunResult.lastUsage` 供 TUI/CLI 显示。**压缩路径（in-run 锚点 / 增量估算 / 触发逻辑）不在本计划**——仍 blocked by 失败证据 + #119/#132（ADR-0008 Decision 6 + #160 Q6 分路裁决）。

## 裁决速览（详见 #160 Resolution / ADR-0008，本计划不重述理由）

- **Q1 落点**：TraceService `LlmCallRecord` 单承载，usage = 观测事实；`AssistantTurnResult` 仅密封透传。
- **Q2 字段**：SDK `Usage` 四字段对齐——`inputTokens: number` / `outputTokens: number` 必填 + `cacheCreationInputTokens` / `cacheReadInputTokens` 为 `number | null`；**错误分支整条 usage 缺席**（不写 null 占位）；顶层平铺。
- **Q3 传输**：adapter 投到 `AssistantTurnResult`（与 `supplierStop` 同构），loop-engine 在既有 `recordLlmCall` 埋点抄入；adapter 不接收 TraceService 依赖。
- **Q4 暴露**：`RunResult.lastUsage`（最后一次成功调用的 usage；run 无成功模型调用时为 `null`——Resolution Q4 + ADR-0008 Decision 5 双源裁决；字段缺席/Postel 语义仅管 `LlmCallRecord` 落盘面，不管 RunResult 进程内值）。TUI（specs/146）经 `hub-bridge` 直接消费 `RunResult`，本计划不动 `TurnAnswerDto` wire 契约。
- **Q5 估算**：不做 chars/N fallback；缺失 = 字段缺席。估算永不进核算/显示。
- **Q6 分路**：显示路径可实施（本计划）；压缩路径不动。

## Context-loop 预检

- `docs/CONTEXT.md`：`usage (token accounting)` 词条已落（ADR-0008 同 commit）；LoopTrace 词条 _Avoid_ 已注明 token 禁令仅对 LoopTrace 本体、不外延到 TraceService——**无冲突**。
- `docs/adr/`：ADR-0008 accepted 是本计划的授权依据；ADR-0003（trace domain interface）的 Postel（Decision 9）/ ID 串链（Decision 5）/ `recordXxx` 永不抛错（Decision 13）是硬约束——本计划字段缺席语义（Q2）即 Postel 落地。**无矛盾，无需 reopening 注记。**
- 017:67 反转已由 ADR-0008 Decision 5 显式记录（TUI 真实读者），不属静默推翻。

## 关键代码事实（explorer 核验，写计划时有效）

- `RunResult` 生产字面量仅一处：`src/harness/loop-engine.ts:824-829`（explorer 实测；计划原稿 :820-833 为宽范围、`createLoopEngine` "镜像"系误读——:850-859 只是工厂闭包）。`src/session-api/hub.ts:317-318` 是 spread 字面量（`killed ? { ...result, stopReason: "protocolError" } : result`），仅 override stopReason，新字段自动透传、无需改动。**测试 fixture** 构造 `RunResult` 处（`tests/cli/format.test.ts` mkResult、`tests/harness/sandbox/output-mask-wiring.test.ts` mkResult、`tests/session-api/contract.test.ts` 等）在 T4 加必填 `lastUsage` 后需补 `lastUsage: null`。
- `recordLlmCall` 埋点两处：`loop-engine.ts:553-563`（error 分支）/ `:564-576`（ok 分支，现读 `modelPhase.result.supplierStop`）；`turnResult = modelPhase.result` 在 :599。
- `interpretMessage`（`anthropic-adapter.ts:64-184`）是 `AssistantTurnResult` 的**唯一**生产地；真实路径 `:415`、离线脚本路径 `:306` 都经它。
- `src/harness/trace/jsonl.ts` 是**泛型反射序列化**（`toSnakeCaseRecord` :47-55 + spread :98-113）——`LlmCallRecord` 加顶层字段**零改动自动落盘**，camelCase→snake_case 自动转换。
- 测试夹具：offline adapter 测试的 SdkMessage fixture **已含** `usage: {input_tokens, output_tokens}`（当前被静默丢弃，T2 直接复用）；`assistantResult` 工厂（`tests/cli/_fixtures.ts:50-85`）无 usage 参数（T5 需扩展）。
- 字节级一致性契约 `tests/harness/trace/loop-engine-trace.test.ts:33-111` 用 `assert.deepEqual(resultB, resultA)`（trace vs 无 trace）——新字段必须两侧一致（stub 路径 usage 缺席则两侧都缺席，天然满足）。
- 已知 flaky：`tests/harness/aci/bash-sandbox.test.ts` SC13（并行负载下偶发；单跑 3/3 绿，2026-08-05 实测）——执行期遇到先单跑复测，勿当回归。

## T1 Resolution（实施级裁决确认，2026-08-05 orchestrator 落档）

计划头注明「T1 issue 有 Resolution comment」，但 tracker 未建 T1-T6 系列 issue（#160 已 closed，`ready-for-agent` 仅存无关的 #173）——裁决确认落档于此，作为 T2-T6 的类型形状真值引用点：

1. `TokenUsage` 域类型落点 `src/harness/model-adapter/types.ts`，形状锁死为四字段 readonly（`inputTokens: number` / `outputTokens: number` 必填 + `cacheCreationInputTokens` / `cacheReadInputTokens: number | null`），对齐 SDK `Usage` 语义但不 import SDK 类型。
2. `AssistantTurnResult.usage?: TokenUsage` —— 可选，stub 路径字段缺席（密封透传，与 `supplierStop` 同构，ADR-0008 Decision 4）。
3. `LlmCallRecord` 增 4 个**顶层平铺**可选字段（不包 usage 子对象；trace bounded context 不 import model-adapter 类型，沿用字面量联合先例）；error 分支整条缺席（Postel，ADR-0008 Decision 3）。
4. `RunResult.lastUsage: TokenUsage | null` —— **必填字段，null = run 无成功模型调用**。实施级修正确认：计划原稿 `lastUsage?: TokenUsage`（undefined）与 Resolution Q4 + ADR-0008 Decision 5 双源 `| null` 冲突，按 SSOT 层级修正为 `| null`；Postel 字段缺席语义仅约束 `LlmCallRecord` 落盘面，不外延到 RunResult 进程内值（ACR gate error-handling-enforcer 独立复核同结论）。
5. snake↔camel 映射一处定义：adapter 侧 SDK→域投影纯函数；`LlmCallRecord` 侧靠 jsonl.ts 泛型反射自动落盘，不另写映射。
6. Explorer 基线复核修正：`RunResult` 生产字面量仅 loop-engine.ts:824-829 一处（hub.ts:317-318 为 spread，新字段自动透传）；eval 任务编号 011→**015**（011 已被 sandbox-policy 占用，ACR 独立复核同结论）；formatRunJson 为 camelCase 风格（T5 锁 camel）。
7. ACR gate fix（defensive-contract-validator 两项，2026-08-05）：(a) lastUsage 形状分歧 → 按第 4 条修正解除；(b) **T2 投影畸形 usage 语义锁死**：usage 存在但形状畸形（`usage: {}` / input_tokens 或 output_tokens 非 number）→ 投影返回 `undefined`（整条缺席，Postel），禁止产出 `{inputTokens: undefined, ...}` 违约对象；cache 两字段非 number 归一 `null`；T2 补测试用例 (d) 锁死。

## Tracer bullets

依赖图：T1 → T2 → T3 → T4 → T5；T6 [blocks: T3]（spec/eval 对齐代码形状），可与 T4/T5 并行。

### 1. T1. `[decision]` TokenUsage 类型与字段落点裁决确认

- **Affects**: 无代码改动——裁决票。ADR-0008 已 accepted，本票记录实施级确认并锁定类型形状，供 T2-T5 引用。
- **裁决内容**:
  - 新增 iknow 域类型 `TokenUsage`，落点 `src/harness/model-adapter/types.ts`（与 `AssistantTurnResult` / `RunResult` 同文件；harness 不 import SDK 类型，域内定义对齐 SDK 语义）：
    ```ts
    /** 对齐 Anthropic SDK Usage 的 token 四字段（ADR-0008 Decision 2）。 */
    interface TokenUsage {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cacheCreationInputTokens: number | null;
      readonly cacheReadInputTokens: number | null;
    }
    ```
  - `AssistantTurnResult` 增 `readonly usage?: TokenUsage`（可选：stub 路径缺席）。
  - `RunResult` 增 `readonly lastUsage?: TokenUsage`（可选：无成功调用时缺席——**不写 null**，字段缺席即 Postel 语义）。
  - snake↔camel 映射规则一处定义（adapter 侧 SDK→域投影函数），`LlmCallRecord` 侧靠 jsonl.ts 泛型反射（不另写映射）。
- **Acceptance**: T1 issue 有 Resolution comment 记录上述形状并 closed；下游票（T2-T5）issue body 引用此形状无歧义。

### 2. T2. `[implementation]` adapter 透出 usage 到 AssistantTurnResult [blocks: T1]

- **Affects**: `src/harness/model-adapter/types.ts`（TokenUsage 类型 + `AssistantTurnResult.usage?`）、`src/harness/model-adapter/anthropic-adapter.ts`（`interpretMessage` 返回增 `usage` 投影；新增 SDK Usage→TokenUsage 纯函数，丢弃周边字段）、`tests/harness/model-adapter/anthropic-adapter.test.ts`（复用已含 usage 的 fixture 断言透出；补 cache 两字段 nullable 用例 + usage 缺失→`undefined` 用例）、`src/harness/index.ts`（导出 `TokenUsage` 类型）。
- **Acceptance**: 新测试绿：(a) 含 `usage:{input_tokens:100,output_tokens:20,cache_read_input_tokens:5}` 的 fixture → `result.usage` = `{inputTokens:100, outputTokens:20, cacheCreationInputTokens:null, cacheReadInputTokens:5}`；(b) fixture 无 usage → `result.usage === undefined`；(c) SDK 周边字段（service_tier 等）不出现在 `result.usage`。`npm run typecheck` + `npm test` 全绿（stub 路径不回归——`usage` 可选）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 3. T3. `[implementation]` LlmCallRecord 四 token 字段 + loop-engine 抄入（ok 分支） [blocks: T2]

- **Affects**: `src/harness/trace/types.ts`（`LlmCallRecord` 增 4 个可选顶层字段 `inputTokens?` / `outputTokens?` / `cacheCreationInputTokens?` / `cacheReadInputTokens?`——`number` 与 `number|null` 语义按 Q2：成功记录 input/output 必有）、`src/harness/loop-engine.ts`（ok 分支 `recordLlmCall` 从 `modelPhase.result.usage` 抄入；**error 分支不动**——整条缺席）、`tests/harness/trace/jsonl.test.ts`（token 字段 camel→snake 落盘断言 + 字段缺席不落盘断言）、`tests/harness/trace/loop-engine-trace.test.ts`（stub 带 usage 的 run → llm_call 记录含 `input_tokens` 等；取消/超时路径 llm_call 无 token 键；字节级一致性契约保持）。
- **注意**: `jsonl.ts` 零改动（泛型反射自动落盘）；`undefined` 被 `JSON.stringify` 丢弃 = 字段缺席，正是 Q2 错误分支语义。
- **Acceptance**: 新测试绿：(a) 成功 run（stub 带 usage）→ JSONL llm_call 行含 `input_tokens` / `output_tokens`（snake_case）；(b) 取消/超时 run → llm_call 行**无任何** `*_tokens` 键；(c) `assert.deepEqual` 字节级一致性契约（trace vs 无 trace）不破。`npm test` 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 4. T4. `[implementation]` RunResult.lastUsage（loop-engine 持有最后成功调用的 usage） [blocks: T3]

- **Affects**: `src/harness/model-adapter/types.ts`（`RunResult.lastUsage: TokenUsage | null`——必填字段，null = run 无成功模型调用；Resolution Q4 + ADR-0008 Decision 5 双源裁决）、`src/harness/loop-engine.ts`（run 作用域加 `lastUsage` 可变引用，初值 `null`，stepWithTrace ok 分支在抄 trace 处同步更新；`RunResult` 字面量 explorer 实测 :825-838 + `createLoopEngine` 镜像 :864-873 填入——**仅此两处**）、`tests/harness/loop-engine.test.ts`（S 矩阵新增用例：多轮 run → `lastUsage` = 最后一次成功调用的值；纯 stub 无 usage → `lastUsage === null`）、`tests/cli/_fixtures.ts`（`assistantResult` 工厂增可选 `usage` 参数——向后兼容，不传则字段缺席）。
- **Acceptance**: 新测试绿：(a) `assistantResult({..., usage:{inputTokens:7,outputTokens:3,cacheCreationInputTokens:null,cacheReadInputTokens:null}})` 两轮 run → `result.lastUsage.inputTokens` = 第二轮值；(b) 不带 usage 的 stub run → `result.lastUsage === null`；(c) 既有 S1-S17 矩阵零回归（含 loop-engine-trace.test.ts 字节级一致性契约——两侧 lastUsage 同为 null 或同值）。`npm test` 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 5. T5. `[implementation]` 显示面最小接通：ask/chat 格式投影 [blocks: T4]

- **Affects**: `src/cli/format.ts`（`formatRunJson` :207-221 增 `lastUsage` 序列化（有则输出四字段，无则键缺席）；`formatRunHuman` :174-191 状态行追加 token 读数（如 `tokens in/out: 1234/56`，无 usage 不显示））、对应测试（`tests/cli/` 内 format 相关测试文件 + 新增断言）。
- **范围注**: 不动 `TurnAnswerDto` / `toTurnDto`（wire 契约）——TUI（specs/146）经 `hub-bridge` 直接消费 `RunResult`，本票只接通已有 CLI 显示面；TUI 组件渲染归 TUI 实施票（见 Out of scope）。
- **Acceptance**: 新测试绿：(a) 带 lastUsage 的 RunResult → `formatRunJson` 输出 JSON 含 `lastUsage.inputTokens` 等 **camelCase** 形态（explorer 实测 format.ts 现状全 camel——风格一致者锁死）；(b) lastUsage 为 null → `lastUsage` 键缺席；(c) `formatRunHuman` 有/无 usage 两种渲染快照断言。`npm test` 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 6. T6. `[implementation]` spec/eval 对齐：trace-service.md 四字段 + eval 闭环 [blocks: T3] [parallel]

- **Affects**: `specs/trace-service.md`（:120 tokens 类目从三字段改四字段形状 + 引 ADR-0008；:126 Postel 排除清单措辞核对）、`.evals/tasks/015-token-usage-display-path.yaml`（新增 eval 断言，见下；**编号修正**：计划原稿 011 已被 `011-sandbox-policy.yaml` 占用，explorer 实测取下一空号 015）。
- **Acceptance**: (a) `grep -c "cacheCreationInputTokens" specs/trace-service.md` ≥ 1 且 :120 不再出现「三字段」旧形状；(b) `bash .evals/run.sh --task 015-token-usage-display-path` exit 0；(c) `bash .evals/run.sh`（fast tier 默认）exit 0。docs-render 验收：eval task 即本票的 render 测试。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

## Eval 闭环（计划完成 = eval 全绿）

`.evals/tasks/015-token-usage-display-path.yaml`（T6 交付），断言形状锚点：

```yaml
id: 015-token-usage-display-path
tier: fast
description: "ADR-0008 显示路径形状锚点 — TokenUsage 四字段 + lastUsage + trace 落盘"
repo: .
test_command: |
  set -e
  grep -q "cacheCreationInputTokens" src/harness/model-adapter/types.ts || { echo "FAIL: TokenUsage 缺 cacheCreationInputTokens"; exit 1; }
  grep -q "lastUsage" src/harness/model-adapter/types.ts || { echo "FAIL: RunResult 缺 lastUsage"; exit 1; }
  grep -q "inputTokens" src/harness/trace/types.ts || { echo "FAIL: LlmCallRecord 缺 token 字段"; exit 1; }
  grep -q "usage" src/harness/model-adapter/anthropic-adapter.ts || { echo "FAIL: adapter 未透出 usage"; exit 1; }
  grep -q "cacheCreationInputTokens" specs/trace-service.md || { echo "FAIL: spec 未对齐四字段"; exit 1; }
  npx tsc --noEmit || { echo "FAIL: typecheck"; exit 1; }
  echo "PASS: token usage display path shape OK"
prompt: |
  Run `bash .evals/run.sh --task 015-token-usage-display-path`. Confirms the
  ADR-0008 display-path shape anchors: TokenUsage 4 fields on
  AssistantTurnResult/RunResult/LlmCallRecord, adapter usage projection,
  spec alignment — and that typecheck passes.
```

## Out of scope（边界明示）

- **压缩路径**：in-run 锚点 / 增量估算 / 压缩触发——blocked by 失败证据 + #119/#132（ADR-0008 Decision 6）。
- **TurnAnswerDto / session-api wire**：TUI 直读 RunResult，wire 契约不动；若未来 TUI 改走 wire，另立票。
- **TUI 组件渲染**：`src/tui/` 的 token 显示 UI 归 TUI 实施票（specs/146），本计划只保证 `RunResult.lastUsage` 可供消费。
- **context window 大小配置**：百分比显示的前提，iknow 当前无此概念——#160 Resolution fog，归 #119 或 TUI 票。
- **chars/N 估算器**：Q5 裁决不做；估算器若将来被需要，家在压缩子系统。

## 执行约定

- 分支基线：`worktree-wayfinder-160-token-accounting`（活跃 worktree）。
- 每 tracer bullet = 1 commit（票分支）；per-ticket loop 逐步嵌入（见各票）。
- pre-commit hook 跑全量测试；遇 SC13 flaky 先单跑复测（见「关键代码事实」末条）。
- push 需操作员显式授权（项目 Git 纪律）。
