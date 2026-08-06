# Spec: Minimum Sequential Agent Loop (016 Gate A)

> **Lean spec.** 016 ticket 的 Q1–Q6 Resolution 是本 spec 的权威先决决议;本 spec 只补充 Resolution 未钉死的实施层细节(文件级布局、TS 类型签名、ACR gate)。未在本 spec 重述的内容,以 016 Resolution + 013/014/015 冻结契约为准。

## Objective

**What**: 实现 Foundation 的 Gate A — 用冻结的模型回合契约(014)和工具 ACI 契约(015)跑通"模型 -> 工具 -> 真实结果 -> Adapter 原生编码 -> 下一轮模型 -> 明确停止"的最小顺序闭环。

**Why**: 旧 `src/agent-loop/` 不可继续作为后续能力的可靠底座(013 冻)。Foundation 是 Agent Runtime v0 与 Knowledge Evidence v0 的共同地基;Gate A 先证明闭环可信,Gate B(017)才加产品路径真实需要的加固,018 才迁移退役旧 loop。

**Who**: 实施者(本 spec 的下游 `writing-plans` 消费者)。Gate A 用替身 model / 替身 tool 验证,**不接产品流量**。

**Success**: S1–S11 fixture 矩阵 + Adapter 7 类离线样例 + Registry 构造验收全过;append-only 历史可重放(S10 + S11 + 替身确定性);`src/harness/` 不含 Gate B 能力。

> 详见 016 Resolution Q1–Q6 与 Exit condition。

## Tech Stack

- **Language**: TypeScript(项目 `tsconfig.json`:ES2022 / NodeNext / strict / noUnusedLocals / verbatimModuleSyntax / isolatedModules)。
- **Module**: ESM(`package.json` `"type": "module"`);TS 源码内部相对导入用 `.js` 后缀。
- **Model SDK**: `@anthropic-ai/sdk`(A1 决策)。Adapter 可用 SDK 或直接 HTTP,但不得改变 014 历史契约。
- **JSON Schema validator**: `ajv@^8.17.1` + `ajv-formats@^2.1.1`(A2 决策),`strict: true`。固定版本,pin 在 `package.json`。
- **Test runner**: Node 内建 test runner via `tsx --test tests/**/*.test.ts`(A4,015 冻)。不引入 Jest/Vitest。
- **Runtime**: Node 服务端(非边缘)。iknow 是 `node:http` + CLI,validator 体积非敏感。

> Tech stack 变更需新假设门(spec-driven-development Iron Law)。

## Commands

```bash
# Type check
npm run typecheck

# Full test suite (Node built-in runner via tsx)
npm test

# (Gate A 不需要 dev/serve;不接产品流量)
```

> 命令继承项目 `package.json` scripts,016 不新增 npm script。

## Project Structure

新建 `src/harness/` 独立根(015 §Implementation target 冻)。016 实施期间**完全不碰**旧 `src/agent-loop/`(不 import / 不改 / 不复用类型)。

```
src/harness/
├── index.ts                  # 公共出口:run / createLoopEngine / createAdapter
├── errors.ts                 # Foundation 自治错误类(E2 决策)
├── loop-engine.ts            # Loop Engine: LoopState + step(state, deps)->Transition + run()
├── model-adapter/
│   ├── anthropic-adapter.ts  # Anthropic Model Adapter(请求组装/调用/解释/tool_result 编码)
│   └── types.ts              # ModelAdapter 接口、Transition/StopReason 公共类型(014 拥有)
├── tools/
│   ├── registry.ts           # Registry(构造期校验、不可变、按名定位)
│   ├── executor.ts           # Executor(持有 Registry,串行执行,无自动重试)
│   ├── tool-result.ts        # ToolExecutionResult 结构化结果类型(015 拥有)
│   └── types.ts              # ToolDef、ToolRegistry 等公共类型
└── stubs/                    # 替身(仅供测试,不进生产装配路径)
    ├── stub-model.ts         # 替身 model:脚本驱动,确定性
    └── stub-tool.ts          # 替身 tool:可控成功/失败

tests/harness/
├── loop-engine.test.ts                    # S1–S11(Loop Engine fixture 矩阵)
├── model-adapter/
│   └── anthropic-adapter.test.ts          # 014 的 7 类离线验收样例(含流中断)
└── tools/
    └── registry.test.ts                   # S13(重复名/坏 schema 构造失败)
```

> 文件名 / 子模块拆分是实施细节;writing-plans 可微调,但职责切分(Loop Engine / Model Adapter / tools / stubs)不得变。

## Code Style

### TS 类型签名(016 Q1–Q3 落定的接口形状)

```ts
// src/harness/model-adapter/types.ts

/** Foundation 运行时权威状态(013 冻:唯一事实来源,不许第二份副本)。 */
export interface LoopState {
  /** Anthropic 原生 messages,append-only,immutable 追加。 */
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  /** 每完成一个 assistant 回合(含纯文本完成)+1。 */
  readonly turnCount: number;
}

/** 016 Q3 五类停止原因。 */
export type StopReason =
  | "completed" // 成功停止 + 无 tool call + 至少一段非空文本
  | "maxTurns" // turnCount 到达上限
  | "nonSuccessStop" // 截断/拒绝等合法但未完成的供应商结果
  | "protocolError" // assistant 回合协议结构错误,整回合不进入历史
  | "emptyFinalResponse"; // 供应商报告成功停止但无可展示文本,不进入权威历史

/** 016 Q1 状态机 Transition(判别联合,向后兼容扩展)。 */
export type Transition =
  | { kind: "continue"; nextState: LoopState }
  | { kind: "stop"; reason: StopReason; finalState: LoopState };

/** 一次 run 的对外结果。 */
export interface RunResult {
  readonly finalText: string | null; // 从最后成功 assistant 回合的 text blocks 派生(非权威)
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly turnCount: number;
  readonly stopReason: StopReason;
}
```

```ts
// src/harness/loop-engine.ts

/** Loop Engine 依赖(构造期注入;运行时状态不挂实例 — 016 Q2 纯 B)。 */
export interface LoopEngineDeps {
  readonly adapter: ModelAdapter;
  readonly executor: Executor;
  readonly registry: Registry;
  readonly maxTurns: number;
}

/**
 * 单步状态机推进。公开给替身测试;生产消费方用 run()。
 * 无可变实例状态;state 线程化、immutable 追加。
 */
export function step(state: LoopState, deps: LoopEngineDeps): Transition;

/** 整轮运行;公共入口。 */
export function run(userText: string, deps: LoopEngineDeps): Promise<RunResult>;
```

```ts
// src/harness/errors.ts(E2 决策:Foundation 自治)

export class RegistryConstructionError extends Error {
  /* 015: 重复名/坏 schema/validator 编译失败 */
}
export class ProtocolError extends Error {
  /* 014: assistant 回合协议结构错误 */
}
export class ToolExecutionError extends Error {
  /* 015: 公开可反馈业务失败,被 Executor 接住净化 */
}
```

### 风格要点

- **Immutable append**: `messages` 更新用 `[...prev.messages, x]`,禁止 `push` / 原地修改(S10 守门)。
- **无可变实例字段**: Loop Engine 函数不持有 `this.messages` / `this.turnCount`;state 只在入参/返回值流转(S11 守门)。
- **同源 JSON Schema**: 工具 `input_schema`(给模型)与 Executor 校验用同一份 schema 同一个 ajv validator(015 冻)。
- **不按业务名分派**: Loop/Registry/Executor 不得 `switch(name)` on `kb_*`(015 冻)。

> 命名 / 格式细节沿用项目既有 TS 风格;writing-plans 可补具体 lint 规则。

## Testing Strategy

继承 016 Q5 + 015 §Implementation target 已冻范围:

- **Loop Engine fixture 矩阵 S1–S11**(行为验收 S1–S9 + 结构不变式 S10/S11)— `tests/harness/loop-engine.test.ts`。
- **Adapter 离线验收 7 类**(含流中断)— `tests/harness/model-adapter/anthropic-adapter.test.ts`。
- **Registry 构造验收**(重复名 / 坏 schema / validator 编译失败)— `tests/harness/tools/registry.test.ts`。
- **重放性**: 由 S10 + S11 + 替身 model 确定性间接保证;S1–S9 每条即一次确定性重放。不单列 S14。
- **测试层**: 全 unit(替身 model / 替身 tool,无真实模型/网络/产品流量)。

> Success Criteria 区把每条转成二元判据。

## Boundaries

- **Always do**:
  - 跑 `npm run typecheck` + `npm test` 全绿后才算完成(015 冻)。
  - 严格校验(ajv `strict: true`):不做隐式类型转换、不裁剪未知字段、不猜测缺失值。
  - 同回路多 tool call 串行、无短路、无自动重试(015 冻)。
  - append-only `messages`:immutable 追加,不原地修改。
- **Ask first**:
  - 新增 runtime 依赖(除已定的 `@anthropic-ai/sdk` / `ajv` / `ajv-formats`)。
  - 修改 `tsconfig.json` 或 `package.json` scripts。
  - 调整 `src/harness/` 子模块职责切分(Loop Engine / Model Adapter / tools / stubs 四块边界)。
- **Never do**:
  - 碰旧 `src/agent-loop/`(不 import / 不改 / 不复用类型)— 016 Q6。
  - 把现有 `src/tools/registry.ts` 误作通用 ACI Registry — 015 冻。
  - 接入真实 `kb_*` 工具或产品流量 — 018 范围。
  - 引入 Gate B 能力:重试 / 取消 / 超时 / trace / checkpoint / 并发调度 / durable memory / 上下文压缩 — 017/runtime 范围。
  - 手写伪 JSON Schema validator — 015 禁。
  - 删除测试让构建通过;把失败测试改成跳过 — 项目 code-quality.md。

## Success Criteria

二元判据(每条 yes/no):

1. `npm run typecheck` 退出码 0?□
2. `npm test` 退出码 0?□
3. S1 单轮完成: 替身 model 发纯文本 -> `stopReason="completed"` + `turnCount=1` + `messages=[user, assistant(text)]`?□
4. S2 单工具调用后完成: 闭环 4 条消息顺序正确?□
5. S3 多工具调用后完成: N 个 tool_use / tool_result 顺序匹配(015 串行)?□
6. S4 工具失败 -> 修正 -> 完成: 失败结果作为 `is_error` tool_result 进入历史,模型下一轮可见?□
7. S5 同回合多调用部分失败: 第 2 个失败不短路第 3 个,3 个结果都进历史且可区分?□
8. S6 maxTurns 触顶: `turnCount >= maxTurns` 时 `stopReason="maxTurns"`,未多调一次模型(调用前检查)?□
9. S7 非成功停止: `stopReason="nonSuccessStop"`,截断/拒绝文本不作成功最终答案?□
10. S8 空最终响应: `stopReason="emptyFinalResponse"`,空响应不进入权威历史?□
11. S9 协议错误回合: 整坏回合不进入历史,不触发工具执行?□
12. S10 append-only 不可变: 跑完后 `state.messages` 引用从未被原地修改(每次新数组)?□
13. S11 跨 run 不污染: `run #2` 的 `messages` 不含 `run #1` 任何消息(纯 B 兑现)?□
14. Adapter 7 类离线样例全过(含流中断不提交半回合)?□
15. Registry 构造验收全过(重复名 / 坏 schema / validator 编译失败均抛 `RegistryConstructionError`)?□
16. 代码审查确认 `src/harness/` 不含 Gate B 能力(重试 / 取消 / 超时 / trace / checkpoint / 并发)?□

> 判据 12–13 是 016 Exit condition "append-only 历史可重放" 的显式守门。判据 16 是 "没有把 Gate B 提前带入内核" 的显式守门。

## Open Questions

无。016 Q1–Q6 Resolution + 本 spec A1/A2/E2 决策已覆盖全部实施层决策点。剩余文件名 / lint 规则 / 具体版本号微调属 writing-plans 范围,不阻塞 spec。

---

## ACR 5-Verdict Gate

> `architecture-change-reviewer` 已跑(本 spec 同步会话)。5 维全绿。

1. **bounded-context-guardian**: `yes` - `src/harness/` 按能力切四模块(Loop Engine / Model Adapter / tools / stubs),无技术层命名;stubs 显式排除生产装配;Loop/Registry/Executor/Adapter 禁止 `switch(name) on kb_*`(015);`src/tools/registry.ts` 明确不被当作新 ACI Registry。
2. **defensive-contract-validator**: `yes` - S1–S9 覆盖正/负/overflow/empty/exception 五类;concurrent 正确 N/A(单线程顺序,015);retry/cancel/timeout 显式后置 017。
3. **error-handling-enforcer**: `yes` - 三类 Foundation 错误(RegistryConstructionError / ProtocolError / ToolExecutionError)定义于 `errors.ts`;`ToolExecutionResult` 结构化结果与抛出异常区分(015);错误路径不污染主控流(S9 protocolError 整回合丢弃不进历史)。
4. **complexity-anti-drift**: `yes` - 纯函数设计(`step(state, deps)->Transition`、`run(...)`);immutable state thread-through;`LoopEngineDeps` 4 参数;9 个小文件单一职责;阈值按构造满足,非靠未来重构。
5. **minimal-change-verifier**: `yes` - 仅 scope `src/harness/**` + `tests/harness/**`;明确禁止碰旧 `src/agent-loop/`、误用 `src/tools/registry.ts`、预建 Gate B 能力;单 logical task 单 commit。

**OVERALL: PASS** - 5 维全绿,hand to writing-plans。

---

## Cross-references

- 016 Resolution(Q1–Q6): `.wayfinder/issues/016-minimum-sequential-agent-loop.md`
- 013 Foundation 边界: `.wayfinder/issues/013-agent-loop-foundation-and-migration-boundary.md`
- 014 模型回合契约: `.wayfinder/issues/014-model-turn-and-history-contract.md`
- 015 工具 ACI 契约: `.wayfinder/issues/015-tool-aci-and-result-boundary.md`
- 领域语言: `docs/CONTEXT.md`(Loop Engine / append-only messages / turnCount / stub model+tool / turnCount-vs-max_hops)
