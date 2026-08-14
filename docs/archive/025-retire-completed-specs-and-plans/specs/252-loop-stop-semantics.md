# Spec: 252 — loop stop 语义:超限收尾 + maxTurns 开关 + reactive compact 兜底

Date: 2026-08-08
Status: draft

## Objective

修复 iknow Loop Engine 的"停下来不知道做了什么"缺陷。当前 `loop-engine.ts:593-603`
在 turn 数达到上限时静默返回 `{ kind: "stop", reason: "maxTurns" }` —— 无摘要、
无通知、不进 turn 记录 (`turn: null`),外部若忽略返回值就"无声死亡",用户看到就是
"6 轮就挂了"且不知道为什么。同时,proactive compact 估算永远有误差,极端情况下
窗口被撑爆时 SDK 抛 prompt-too-long,adapter 对其零翻译 (裸 rethrow) 直接崩整个 run。

本 spec 把三项已有决策折叠成 buildable 契约:

1. **超限/异常停不静默** (ADR-0011): 抛 `MaxTurnsExceeded` + 真·模型收尾摘要。
2. **maxTurns 降级为显式开关,默认无限** (ADR-0012): CLI flag + env 变量,防 runaway
   剥离到成本护栏待办。
3. **reactive compact 兜底** (ADR-0013): prompt-too-long → `PromptTooLongError` →
   强制压缩一次 → 重试一次,每 run 限 1 次。

成功 = 三种 surface (chat REPL / ask / serve) 在超限 / 异常停时都能让用户感知
"做了什么 + 为什么停",且 prompt 超窗不再硬崩 run。

## Tech Stack

TypeScript (项目现有), 不变更依赖。新增/复用类型:

- `HarnessStreamEvent` (`src/harness/stream.ts`) — 扩联合加终态成员。
- `PromptTooLongError extends ProtocolError` (`src/harness/errors.ts`, 已宿主
  `ProtocolError` 定义于 `:17`)。
- `MaxTurnsExceeded` — 新异常类型 (可复用现有 errors 分层)。
- SDK `@anthropic-ai/sdk` 现有 `APIError` (识别 400 prompt-too-long)。
- 无新技术栈 / 无新第三方依赖。

**无 tech stack 变更 → 不触发新一轮 assumption gate。**

## Commands

Build: `npm run build`
Test: `npm test` (vitest: unit + harness + integration)
Typecheck: `npx tsc --noEmit`
Lint: `npm run lint` (若项目有)

运行验证 (手动, 需 LLM key):

```bash
# 显式限 3 轮, 观察超限后的收尾摘要与 throw 行为
iknow chat --max-turns 3

# env 覆盖 (serve 走 env 默认)
IKNOW_LLM_MAX_TURNS=5 iknow serve

# 默认无限 (不设 flag / env)
iknow chat
```

## Project Structure

- `src/harness/errors.ts` — 新增 `PromptTooLongError extends ProtocolError` (ProtocolError
  已宿主于此 `:17`)。
- `src/harness/model-adapter/anthropic-adapter.ts:643/:510` — 两个 SDK 调用点包
  try/catch, `instanceof APIError && status 400 && 含 prompt length` → 抛
  `PromptTooLongError`。
- `src/harness/loop-engine.ts:593-603` — silent stop 分支改为 `throw MaxTurnsExceeded`。
- `src/harness/loop-engine.ts:430-439` — `ProtocolError` 捕获分支加 reactive 处理
  (`PromptTooLongError` → 压缩一次 → 重试)。
- `src/harness/stream.ts` — `HarnessStreamEvent` 扩终态成员。
- `src/harness/loop-engine.ts:128` — `LoopEngineDeps.maxTurns: number` → `number | undefined`;
  `:593` `turnCount >= maxTurns` 需处理 undefined (undefined = 永不触发, 默认无限)。
- `src/harness/build-engine.ts:172` — `maxTurns: 6` 改读 `env.llm.maxTurns` / CLI flag,
  缺省 `undefined` = 无限。
- `src/tui/deps.ts:129` — `maxTurns: 6` 改读 `env.llm.maxTurns`, 缺省 `undefined` —
  TUI 是独立装配点 (不经过 buildHarnessEngine), 需单独覆盖。
- `src/cli/parse-args.ts` — 新增 `--max-turns` flag (照 `--max-bytes` 先例)。
- `src/config/env.ts` — `LlmEnv` 加 `maxTurns?` (env `IKNOW_LLM_MAX_TURNS`)。
- 四个 surface 消费点 (chat / ask / serve / tui) — 适配 throw 契约 + 接收收尾摘要事件。
- 测试: `test/` 对应 harness 单测 + surface 集成。

## Code Style

照项目现有风格 (TypeScript, 类型注解, 纯函数, 不引入框架)。示例:

```ts
// 收尾摘要事件 (stream.ts 扩联合)
export type HarnessStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; name: string; id: string }
  | { type: "stop_summary"; text: string };

// reactive compact 触发 (adapter, R1 最小改动)
} catch (e) {
  if (e instanceof APIError && e.status === 400 && /prompt.*length|too long/i.test(e.message)) {
    throw new PromptTooLongError(e.message);
  }
  throw e;
}
```

## Testing Strategy

- **Unit (harness)**:
  - adapter: 400 prompt-too-long → 抛 `PromptTooLongError`; 其他 400 → 原样 rethrow。
  - loop-engine: 超限 → `throw MaxTurnsExceeded` (不再 silent stop); reactive 触发 →
    压缩一次重试; 压缩后仍超 → throw。
  - compress: reactive 与 proactive 共用 `compactMessages` (同一逻辑)。
- **Integration (surface)**:
  - chat / ask / serve / tui 各验证: 设 `--max-turns` 撞上 → 收到 throw + 收尾摘要。
  - serve 走 `IKNOW_LLM_MAX_TURNS` env。
- **Token 审计**: 收尾摘要轮 usage 落 `LlmCallRecord` (单测断言), 不污染 `_messages`。
- 覆盖边界类 (defensive-contract 五类):
  - **empty-class**: 空 `_messages` 历史 (无摘要输入) → 摘要轮跳过/空摘要, 不崩 run。
  - **negative-class**: `--max-turns 0` / `-1` / 非整数 → parse-args 拒绝 (照
    `--max-bytes` 先例 `n < 1`)。
  - **overflow-class**: 超限 (maxTurns) / prompt-too-long 超窗 → 兜底路径。
  - **exception-class**: 摘要失败降级 (catch-all + ~15s 独立超时)、reactive 压缩后
    仍超 → throw。
  - **concurrent-class**: 收尾摘要 in-flight 时 signal abort → 摘要被取消, 原始停因
    不被阻塞; 摘要轮与 in-flight 工具 closeout 不交错污染 `_messages`。

## Boundaries

- **Always do**: 跑测试后才 commit; 收尾摘要失败即跳过 (绝不让摘要阻塞原始停因);
  摘要不 append 进 `_messages`; 每 run reactive 限 1 次。
- **Ask first**: 改 `HarnessStreamEvent` 联合 (需同步所有消费点); 改 `_messages`
  append-only 语义; 引入新依赖; 触碰 `docs/CONTEXT.md` / ADR (走 domain-modeling)。
- **Never do**: 保留 silent-stop 契约 (本次明确抛弃旧设计, 不向后兼容);
  摘要 repeat 递归 (不处理"摘要的摘要"); 让 reactive 无限重试烧 token;
  maxTurns 默认非无限 (默认 `undefined` = 无限, 除非显式设)。

## ACR 5-Verdict Block (architecture-change-reviewer)

Gate result: **PASS** (all 5 yes). Original run: defensive-contract `unclear` → patched
(empty/negative/concurrent boundary classes + anchor `src/harness/errors.ts`), re-gated → PASS.

- **bounded-context-guardian: yes** — mutations stay in `src/harness/` (errors.ts:17,
  loop-engine.ts:593-603/:430-439, stream.ts, build-engine.ts:172, anthropic-adapter.ts:510/:643)
  - config plumbing (parse-args.ts:120-129, env.ts); surface adaptation is contract-only
    (throw + event), no session-api / RuntimeBundle / TUI semantic leak.
- **defensive-contract-validator: yes** — Testing Strategy enumerates all five classes
  (empty / negative / overflow / exception / concurrent); reinforced by Success Criterion
  "flag 校验".
- **error-handling-enforcer: yes** — summary degrade (catch-all + ~15s → skip), reactive
  exceeded → throw (ADR-0012 handoff), protocol-error rethrow (loop-engine.ts:430-439
  instanceof branch); no silent path.
- **complexity-anti-drift: yes** — reuses `compactMessages`, `envInt` + `LlmEnv` pattern,
  `--max-bytes` flag precedent, existing `ProtocolError` catch; +2 error classes + 1
  `HarnessStreamEvent` member, zero new deps.
- **minimal-change-verifier: yes** — single logical task folding three accepted ADRs
  (0011/0012/0013); Open Questions are PLAN-phase deferrals, not scope creep.

## Success Criteria

每个可测、二值:

- [ ] **超限可感知**: 用户显式设 `--max-turns` 且撞上 → `MaxTurnsExceeded` 抛到
      surface, 不再静默返回 stop。单测断言 throw。
- [ ] **收尾摘要存在**: 超限/异常停后, surface 收到 `stop_summary` 事件 (真·模型
      文本, 非结构化快照)。
- [ ] **摘要不计 maxTurns**: 设 `--max-turns 3` 实际跑 3 轮工具 + 1 轮摘要, 摘要轮
      不消费工具预算。单测断言 turnCount 计数。
- [ ] **摘要不污染历史**: 摘要文本不出现在 `_messages` (append-only 权威历史干净);
      usage 落 `LlmCallRecord`。单测断言。
- [ ] **摘要失败降级**: 摘要轮超时/失败 → 跳过, 原始停因仍正常抛出, 不阻塞。
      单测断言 (stub model 摘要失败)。
- [ ] **默认无限**: 不设 flag/env → maxTurns 为 `undefined` (无限), 无 6 硬编码。
      单测断言 build-engine deps。
- [ ] **flag 校验**: `--max-turns 0` / `-1` / 非整数 → parse-args 抛错拒绝 (照
      `--max-bytes` 先例)。单测断言。
- [ ] **reactive 兜底**: 模拟 prompt-too-long → 压缩一次 → 重试; 每 run 限 1 次;
      压缩后仍超 → throw。单测断言 (stub model 抛 400)。
- [ ] **四 surface 适配**: chat / ask / serve / tui 各自能 catch throw + 呈现收尾摘要。
      集成测试断言。

## Open Questions

- 收尾摘要的 TUI/Web 展示形态 (是否要单独 UI 组件, 还是沿用现有事件流透传) —
  留给 PLAN 阶段, 不阻塞 spec 落地。
- `MaxTurnsExceeded` 是否携带已跑轮数作为字段 (ADR-0011 说"携带已跑轮数 + 原因",
  不携带 payload) — 字段形态待 PLAN 定。
- 收尾摘要是否也覆盖 `cancelled` / `timeout` (ADR-0011 说"覆盖所有异常停",
  但这两条路径的触发点不同) — 落地范围待 PLAN 确认。

## Architectural Constraints (ADR 引用)

- ADR-0011 — 超限/异常停 → `throw MaxTurnsExceeded` + 真·模型收尾摘要 (不计 maxTurns,
  固定尾部窗口 ~8K, 独立超时 ~15s, 挂 `HarnessStreamEvent` 终态成员, 不 append
  `_messages`)。
- ADR-0012 — maxTurns 降级为显式开关, 默认无限; CLI `--max-turns` + env
  `IKNOW_LLM_MAX_TURNS`; 防 runaway 剥离到 conditional remediation layer 待办
  (017:27)。
- ADR-0013 — reactive compact 兜底; `PromptTooLongError extends ProtocolError`;
  每 run 限 1 次; 复用 `compactMessages`; 超窗不硬崩。
- ADR-0008 — usage 权威落点 = `LlmCallRecord`; 估算只供压缩决策, 永不进核算/显示。
- required/conditional remediation layer (CONTEXT.md) — reactive compact 属 required
  runtime layer; token-cost 护栏 / 总耗时护栏属 conditional (显式禁止, 017 待办)。

## Glossary (自 docs/CONTEXT.md 摘录)

- **Loop Engine**: Foundation 的状态机运行内核, 驱动模型 -> 工具 -> 真实结果 -> 下一轮
  模型 -> 明确停止; 位于 `src/harness/`。
- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史, 是唯一事实来源;
  消息只能以不可变追加 (`[...prev, x]`) 更新, 禁止原地修改或建立第二份权威副本。
- **turnCount / maxTurns**: turnCount 是运行时回合计数, 每完成一个 assistant 回合加一;
  maxTurns 是在调用模型前检查的运行时上限。
- **StopReason**: Loop Engine 的停止判别联合 (completed / maxTurns / protocolError /
  cancelled / timeout 等)。
- **usage (token accounting)**: LLM API 每次成功调用回传的 token 计费; 权威落点 =
  TraceService `LlmCallRecord`; chars/N 估算只供压缩决策, 永不进核算/显示 (ADR-0008)。
- **required runtime layer / conditional remediation layer**: 017 两层对仗边界;
  required (signal/timeout/trace/异常停止) 已实施; conditional (token-cost 护栏等)
  显式禁止, 推迟到 018 后按条件式修复原则补。
- **streaming arm**: LLM 客户端默认流式臂 (`IKNOW_LLM_STREAM`), 原生 SSE 事件不出
  adapter 边界, 收敛为 `HarnessStreamEvent` 最小集。
