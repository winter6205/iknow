# Spec: #119 上下文压缩 — 滑动窗口 + 阈值 + 估算(docs layer + impl ticket)

> **Lean spec.** 本 spec 锁定 #119 Resolution 2026-08-07 落档的设计真值:Q1–Q5(8-05)+ Q6/Q7(8-07)。**范围**:滑动窗口压缩(tier 2)+ proactive 触发 + 阈值配置 + 估算函数 + 边界占位符 + turnCount 锚点。**不含**:cache_control(Q6a 实施挂 #129,独立 spec)、LLM 摘要(L3b 留门)、工具结果封顶(tier 1 ADR-0006 已落地)。

## Assumptions (confirmed)

> 8 条假设经 self-review(operator delegated "你自己过一下" 2026-08-07)与 #119 7 题 grilling 决议一致,3 条来自既定先例(228 / OpenHarness / 项目惯例),**未独立重开**。

1. **A1 模块边界** = `src/harness/compress/` 新 bounded context,无新 npm 依赖(`node:` 内置),与 `src/harness/memory/` 平级,与 `src/harness/identity/` 单向接线(`compress` 不 import 其他 harness 子模块,只 import types)
2. **A2 接入点** = `src/harness/loop-engine.ts` 的 `run()` while loop 主循环 `stepWithTrace` 之前一句 proactive check;新增 `lastCompactTurn: number = 0` 闭包变量(类同 `lastUsage: TokenUsage | null`),**不加 LoopState 字段**(对齐 Q4 决议)。压缩配置经 `LoopEngineDeps.compress` 注入(类同 `deps.system`/`deps.promptTools` 模式);`build-engine.ts` 在构造 `LoopEngineDeps` 时从 `env.compress.*` 透传
3. **A3 配置键**:`IKNOW_MODEL_CONTEXT_WINDOW`(int,默认 200000,可配至 1M)、`IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS`(optional int,缺省推导 `window - 33000`,硬校验 `threshold < window`);位置 = `src/config/env.ts` `IknowEnv.compress.{contextWindow, thresholdTokens}`,与 `llm.*` 平级
4. **A4 Keep-recent N = 6**(对齐 OpenHarness `auto_compact_if_needed` 默认 `preserve_recent=6`;保证最近一回合 + 工具对完整)。N 为常量 `DEFAULT_KEEP_RECENT = 6`,**不在运行期可配**(YAGNI;若需可配,后续独立票)
5. **A5 边界占位符文本** = 单字符串 `[compaction boundary — earlier messages cleared]`,常量化 `COMPACTION_BOUNDARY_PLACEHOLDER`;L3b 留门时换为 LLM 摘要结构,但**本期不需实现**
6. **A6 Proactive 触发** = 纯函数 `shouldAutoCompact(messages, ctx) → boolean`,reactive 钩子**留接口不实现**(对齐 Q3 决议 B 折中);失败证据触发后才接 L3b
7. **A7 落地路径** = worktree branch `worktree-compression-119-landing`,1 commit per tracer bullet,独立 PR off master;PR base 与 #228 同惯例
8. **A8 不重开项** = #119 已决 7 题 Q1–Q7、ADR-0004/0006/0008/0009/0010、`upload-only` 纪律(append-only messages 唯一权威源)、cache_control(Q6a 归 #129)、LLM 摘要(Q1 留门)、Token 实施推迟(017 纪律,#160 路径)。

## Objective

**What**: 把 #119 八-05/八-07 grilling 落档的**压缩设计真值**转译为可实施的 sliding-window 模块,接入 loop-engine,提供按需触发与按需重构 messages 数组的能力。

**Why**: 长对话超出模型上下文窗口会被 9router 静默报错或丢弃;无压缩 → 长任务不可持续。免费两级骨架(tier 1 工具结果封顶已落地 + tier 2 滑动窗口待落地)足以覆盖 iknow 典型场景。

**Who**:

- 实施者:本 spec 下游 `writing-plans` 消费者 + 实施 agent
- 操作员:审核每个 tracer bullet 的 commit 落地是否与 Q1–Q7 决议一致
- 维护者:若重审压缩策略,需重新走 #119 grilling

**Success**: tier 2 滑动窗口压缩落地,长对话场景下 `estimate(state.messages)` 永久 < 阈值,system prompt + 工具 schema 前缀字节级不变,tool_use↔tool_result 配对完整,turnCount 锚点阻止重复扫描,ACR 5/5 verdict yes 且 SC1–SC15 全部 binary 验证通过。

## Glossary(CONTEXT.md 原样引用,不重新定义)

- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史;消息只能以不可变追加更新,压缩 = 重建新数组(immutable 替换),非原地 mutate
- **Loop Engine**: Foundation 的状态机运行内核,位于 `src/harness/`,驱动模型 → 工具 → 真实结果 → 下一轮模型 → 明确停止
- **client-side provider-agnostic compression** (ADR-0004):压缩由 iknow 端做,不依赖服务端 SDK edit;9router(MiniMax-M3)实测静默丢弃 `context_management`,MiniMax 支持 `cache_control`
- **executor truncation authority（契约 X）** (ADR-0006):executor 是工具结果截断元数据的唯一权威;工具结果封顶 20000 字符已落地,是 tier 1 压缩
- **KV cache 前缀稳定性**:system prompt + 工具 schema 字节级不变以维持 Anthropic provider 缓存命中;压缩只动 messages 数组,绝不触碰前缀区
- **RUN scoped closure variable**:loop-engine `run()` 主函数内的可变引用变量(如 `lastUsage: TokenUsage | null`),非 `state` 字段,与回放无关
- **streaming arm** (CLAUDE.md):LLM 客户端默认流式臂(`IKNOW_LLM_STREAM` 值域 `on | off`,默认 `on`);压缩触发在 `stepWithTrace` 之前,不与流式路径冲突
- **token accounting usage placement** (ADR-0008):`LlmCallRecord` 承载 usage + `RunResult.lastUsage` 暴露;**不**用 `lastUsage` 作压缩触发锚点(压缩决策与 TUI 显示正交,Q6b-D3)

## Architectural Constraints(按编号引用 ADR)

- **ADR-0003**: TraceService 领域接口 — 压缩功能不写 trace JSONL,失败证据归 trace 旁路记录
- **ADR-0004**: 工具集 6 / live 8 — 压缩不增删工具
- **ADR-0006**: tool output capping — tier 1 已落地,本 spec 不再重叠封顶
- **ADR-0008**: token accounting — 压缩路径**不**依赖 `lastUsage`;`estimate_messages_tokens` 走纯字符估算
- **ADR-0009**: 记忆文件分层注入 — 压缩触发**不**触碰 system prompt(memory_layer 在 system 字段,压缩只改 messages 数组)
- **ADR-0010**: #121 实施着陆 — 现有 `deps.system` 缝接缝 carry-over,压缩接缝在 loop-engine 内,不动 build-engine
- **#114 Standing preferences**: append-only 纪律不可破(压缩 = 重建数组显式例外);压缩骨架 = 免费两级;LLM 摘要留门不实现

## Tech Stack

- TypeScript + Node ≥20;**无新增 npm 依赖**
- vitest 既有,无新测试依赖
- 不动 `src/harness/identity/` `src/harness/memory/` `src/harness/aci/` `src/harness/trace/` `src/harness/builder/` `src/model-adapter/*` `src/web/` `src/session-api/` `upstream-openharness/`

## Commands

```
Build:      npm run build
Typecheck:  npm run typecheck
Test:       npm test
Lint:       npm run lint
Smoke:      bash .evals/run.sh --task 017    # 本 spec 自带 baseline(新增)
PR:         gh pr create --base master --draft \
              --title "feat(harness): #119 tier-2 滑动窗口压缩落地"
```

## Project Structure

```
src/harness/compress/                          [NEW bounded context]
  constant.ts                                  ← 7 个常量 + 边界占位符
  estimate.ts                                  ← estimateTokens / estimateMessagesTokens
  threshold.ts                                 ← getAutoCompactThreshold / validateThreshold
  window.ts                                    ← compactMessages (sliding window + boundary placeholder)
  index.ts                                     ← shouldAutoCompact (proactive trigger)

src/config/env.ts                              [extend IknowEnv.compress.*]

src/harness/loop-engine.ts                     [LoopEngineDeps.compress 字段 + run() proactive check]

src/harness/build-engine.ts                    [构造 LoopEngineDeps 时透传 env.compress → deps.compress]

tests/harness/compress/                        [NEW test module]
  constant.test.ts
  estimate.test.ts
  threshold.test.ts
  window.test.ts
  index.test.ts
  integration.test.ts                          ← 真 FS + 真 config env,assert boundary + threshold

.evals/tasks/017-compression.yaml              [NEW eval baseline]
```

## Code Style

继承项目既有 ES2022 / strict / noUnusedLocals / verbatimModuleSyntax。本 spec 关键代码段示意。

```ts
// src/harness/compress/constant.ts
// Q6b-D4 决议:7 个常量从 OpenHarness 照搬,2 个接逻辑,5 个留 L3b 门后
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
export const TOKEN_ESTIMATION_PADDING = 4 / 3;
export const DEFAULT_KEEP_RECENT = 6; // A4
export const COMPACTION_BOUNDARY_PLACEHOLDER =
  "[compaction boundary — earlier messages cleared]"; // A5
const _DEFAULT_VISION_IMAGE_TOKEN_ESTIMATE = 3_072; // 留 L3b 门后
const COMPACT_TIMEOUT_SECONDS = 25; // 留 L3b 门后
const MAX_COMPACT_STREAMING_RETRIES = 2; // 留 L3b 门后
```

```ts
// src/harness/compress/estimate.ts
// Q6b-D3 决议:全量字符重估 × 4/3 padding,纯函数,不用 lastUsage
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.floor((text.length + 3) / 4));
}

export function estimateMessagesTokens(
  messages: ReadonlyArray<AnthropicNativeMessage>
): number {
  let total = 0;
  for (const msg of messages) {
    for (const block of msg.content) {
      switch (block.type) {
        case "text":
          total += estimateTokens(block.text);
          break;
        case "tool_use":
          total +=
            estimateTokens(block.name) +
            estimateTokens(JSON.stringify(block.input));
          break;
        case "tool_result":
          total += estimateTokens(String(block.content));
          break;
        case "thinking":
        case "redacted_thinking":
          break; // 不计入输入 token(thinking 非发送历史)
      }
    }
  }
  return Math.ceil(total * TOKEN_ESTIMATION_PADDING);
}
```

```ts
// src/harness/compress/threshold.ts
// Q6b-D1/D2 决议:env 可配,硬校验 threshold < window
export function getAutoCompactThreshold(
  contextWindow: number,
  explicitThreshold: number | undefined
): number {
  if (explicitThreshold !== undefined && explicitThreshold > 0) {
    if (explicitThreshold >= contextWindow) {
      throw new Error(
        `autoCompactThreshold (${explicitThreshold}) must be < contextWindow (${contextWindow})`
      );
    }
    return explicitThreshold;
  }
  const effective =
    contextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS;
  return effective;
}
```

```ts
// src/harness/compress/window.ts
// Q1/Q2/Q5 决议:纯丢弃 + 边界占位符,immutable 重建,tool 配对完整
export function compactMessages(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  keepRecent: number = DEFAULT_KEEP_RECENT
): ReadonlyArray<AnthropicNativeMessage> {
  // 1. 从末尾向前走 keepRecent + 边界修补,确保 tool_use↔tool_result 配对完整
  const safe = preserveToolPairs(messages, keepRecent);
  // 2. 剩余部分若有 → 全部丢弃,边界占位符替代
  if (safe.slicedFrom === 0) return messages; // 没东西可压
  return [
    {
      role: "user",
      content: [{ type: "text", text: COMPACTION_BOUNDARY_PLACEHOLDER }],
    },
    ...safe.kept,
  ];
}
```

```ts
// src/harness/compress/index.ts
// Q3 决议:proactive trigger,reactive 不实现
export function shouldAutoCompact(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  ctx: { contextWindow: number; threshold: number }
): boolean {
  return estimateMessagesTokens(messages) >= ctx.threshold;
}
```

```ts
// src/harness/loop-engine.ts — LoopEngineDeps 新增字段 + run() while loop 主循环
export interface LoopEngineDeps {
  // ...既有字段
  /**
   * #119 Q6b-D1/D2:压缩配置。字段缺席 = 压缩关闭(行为零变化)。
   * contextWindow 默认 200000,thresholdTokens 缺省推导 `window - 33000`。
   */
  readonly compress?: {
    readonly contextWindow: number;
    readonly thresholdTokens: number | undefined;
  };
}

// run() 主循环 — 在 stepWithTrace 之前一句 proactive check
// 闭包变量 — 不加 LoopState 字段(Q4 决议)
let lastCompactTurn: number = 0;
while (true) {
  // Q3 决议:每回合前 proactive check;deps.compress 缺席 → 不压缩(行为零变化)
  if (deps.compress !== undefined && state.turnCount > lastCompactTurn) {
    const threshold = getAutoCompactThreshold(
      deps.compress.contextWindow,
      deps.compress.thresholdTokens,
    );
    if (shouldAutoCompact(state.messages, { threshold })) {
      const compacted = compactMessages(state.messages);
      if (compacted !== state.messages) {  // 有动作(能压出东西)
        state = { ...state, messages: compacted };
        lastCompactTurn = state.turnCount;
      }
    }
  }
  const { transition, turn, modelUsage } = await stepWithTrace({ state, deps, signal, onStream: opts?.onStream });
  ...
}
```

## Testing Strategy

- **unit**:`tests/harness/compress/{constant,estimate,threshold,window,index}.test.ts` 五件,各覆盖 5 boundary classes(empty / negative / overflow / concurrent / exception):
  - `estimate.test.ts`:`""`/单字符/纯 emoji/混合语言/超大文本 × 4/3 padding
  - `threshold.test.ts`:窗口 200000 默认推导;`threshold = 0` reject;`threshold >= window` throw;显式覆盖优先
  - `window.test.ts`:0 条 / 1 条 / N 条 < keepRecent 不动;tool 配对不切;system/tool 前缀不受影响;空 actions 跳过;边界占位符文本字节级断言
  - `index.test.ts`:estimate < threshold 不触发;estimate >= threshold 触发;`shouldAutoCompact` 纯函数
- **integration**:`tests/harness/compress/integration.test.ts` 真 FS:
  - 构造 100 回合长对话,断言每回合 proactive check 正确触发或不触发
  - 构造 N=6 边界 + 工具对,断言压缩后配对完整
  - 构造 system prompt + tools schema 注入,断言压缩前后 system 字段字节级不变
  - 构造 turnCount 锚点:压缩 2 次后断言只扫 `turnCount > lastCompactTurn` 的回合
- **覆盖目标**:line ≥ 80% / branch ≥ 70%(沿用 master 既有)
- **eval baseline**:`.evals/tasks/017-compression.yaml` `npx vitest run tests/harness/compress/`

## Boundaries

- **Always do**:
  - 每个 tracer bullet commit 后跑 `npm test` + `npm run typecheck`
  - 压缩 = immutable 重建 messages 数组,显式 `return { ...state, messages: compacted }`(append-only 纪律显式例外)
  - 压缩**绝不**触碰 `deps.system` 字段、tools 字段、model 参数(`buildMessageParams` 形态不变)
  - tool_use↔tool_result 配对完整为硬不变式(Q7 acceptance #3)
  - 关闭 PR #228 关闭机制:不重复,本 spec 独立 PR
- **Ask first**:
  - 任何 `src/harness/loop-engine.ts` 主循环形态的额外改动(不在本 spec list 内)
  - 改 `src/config/env.ts` `IknowEnv` 主结构(只在 `compress.*` 子结构内扩)
  - 改 pre-commit husky 钩子配置
- **Never do**:
  - 直接修改 `docs/CONTEXT.md` 或 `docs/adr/`(domain-modeling 写入主权)
  - 修改 `buildMessageParams` 形态(条件 spread 已有,无需调整)
  - 把 `lastCompactTurn` 写入 `LoopState`(Q4 决议:不加 LoopState 字段)
  - 实现 LLM 摘要压缩(L3b 留门不实现,Q1 决议)
  - 实现 reactive 触发(reactive 钩子留接口不实现,Q3 决议)
  - 实现 cache_control(Q6a 实施挂 #129,独立 spec)
  - commit 凭证 / `.env.local` / `secrets.*` 进 git

## Success Criteria

binary,yes/no 全部应可在 PR merge 后 1 次 typecheck + 1 次 test 全跑验证:

- **SC1** `npm run typecheck` exit 0
- **SC2** `npm test` 全绿(line ≥ 80% / branch ≥ 70%)
- **SC3** `bash .evals/run.sh --task 017` 1/1 passed
- **SC4** `git grep "AUTOCOMPACT_BUFFER_TOKENS\|TOKEN_ESTIMATION_PADDING\|DEFAULT_KEEP_RECENT" src/harness/compress/constant.ts` 命中 ≥ 3 处
- **SC5** `git grep "estimateMessagesTokens" src/harness/compress/estimate.ts` 命中 ≥ 1 处
- **SC6** `git grep "getAutoCompactThreshold" src/harness/compress/threshold.ts` 命中 ≥ 1 处
- **SC7** `git grep "compactMessages" src/harness/compress/window.ts` 命中 ≥ 1 处
- **SC8** `git grep "shouldAutoCompact" src/harness/compress/index.ts` 命中 ≥ 1 处
- **SC9** `src/harness/loop-engine.ts` 含 `lastCompactTurn` 闭包变量 + `shouldAutoCompact` 调用,`stepWithTrace` 之前一句;`LoopEngineDeps.compress` 字段就位(A2 接入)
- **SC10** `src/config/env.ts` `IknowEnv.compress.{contextWindow, thresholdTokens}` 字段就位 + `loadIknowEnv` 接入(A3 配置);`src/harness/build-engine.ts` 构造 `LoopEngineDeps` 时 `compress` 字段透传(缺省 undefined → 压缩关闭)
- **SC11** 压缩后 messages 数组的 tool_use↔tool_result 配对完整(unit test 断言)
- **SC12** 压缩前后 `deps.system` 字段、tools 字段字节级不变(integration test 断言)
- **SC13** 构造 100 回合长对话,level-set threshold 时只触发 ≥ 1 次压缩,压缩后 estimate 永久 < threshold(integration test)
- **SC14** `IKNOW_MODEL_CONTEXT_WINDOW` 默认 200000,`IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS` 缺省=`window - 33000`(env loader unit test)
- **SC15** `IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS ≥ window` 时 throw(unit test 断言)

## Open Questions

无。本 spec 全部前置已 grounding(#119 Resolution 7 题 + 10 篇 ADR + 8 条 confirmed assumptions)。任何未决议应在实施期 surface 到 #119 评论区,不在本 spec 重开。

---

## ACR Verdict Block (Step 4)

> Self-ACR(operator delegated "你自己过一下" 2026-08-07)。

| Verdict                      | Result  | Reason                                                                                                                                                                                         |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bounded-context-guardian     | **yes** | `src/harness/compress/` 与 `memory/` 平级,import 图限于 `node:` 内置 + `src/harness/types`(types-only leaf);loop-engine → compress 单向接线;无回环                                             |
| defensive-contract-validator | **yes** | 5 boundary classes(empty / negative / overflow / concurrent / exception)在 constant / estimate / threshold / window / index 五件 unit test 全覆盖;integration test 覆盖 100 回合长对话 + 真 FS |
| error-handling-enforcer      | **yes** | `getAutoCompactThreshold` 显式 `throw` on `threshold >= window`;preserveToolPairs tool 配对失败 throw;loop-engine 不裸吞 throw;不返回 -1 / null / empty 兜底                                   |
| complexity-anti-drift        | **yes** | `compactMessages` ≤ 30 行,`shouldAutoCompact` ≤ 10 行,cyclomatic ≤ 4,nesting ≤ 2;estimate 块遍历单层 for/of;无新超阈值函数                                                                     |
| minimal-change-verifier      | **yes** | 1 logical task = 1 PR;tracer bullets = 1 commit each;Project Structure 列出 6 个新增 / 2 个改动文件,scope 闭合;无 deps 改动;无 docs 改动                                                       |

**OVERALL: PASS** → handoff writing-plans(`plans/119-compression-landing.md`)

---

## Handoff to writing-plans (Step 5)

Spec 路径：`specs/119-compression-landing.md`
下游：`arthurpower:writing-plans plans/119-compression-landing.md`
实施分支：`worktree-compression-119-landing`(worktree 已就绪)
Tracer bullets 预计 7:1) 配置层(IknowEnv.compress 接入)2) 常量层 3) 估算层 4) 阈值层 5) 滑动窗口层 6) 触发层 + index 7) 集成层(loop-engine 接线 + eval 017)。
