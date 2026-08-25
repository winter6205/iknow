# 0012. maxTurns 降级为用户显式开关,默认无限,防 runaway 剥离到成本护栏

Date: 2026-08-08
Status: accepted

## Context

`src/harness/build-engine.ts:172` 把 `maxTurns: 6` 硬编码在装配层,无 env/config
覆盖。它既是"运行上限"又是事实上的**防 runaway 护栏**。但 turn 计数区分不了
"工具失控循环"和"合法长程探索"——探索任务撞上 6 轮上限时,正在进行的探索直接
被 `MaxTurnsExceeded` 切断,无法续、无法降级。用 turn 数当护栏,等于用"粗暴的
回合计数"无差别砍断所有任务,包括需要长程探索的合法场景。这是致命缺陷。

## Decision

1. **maxTurns 降级为"用户显式开关",默认无限**。语义对齐上游参考实现
   (`query.py:700` `while context.max_turns is None or turn_count < ...`):
   `None` / unset = 不设上限,探索永不会被 turn 计数误杀;只有用户显式设上限
   时才强制。
2. **配置 source = CLI flag `--max-turns` + env 变量 `IKNOW_LLM_MAX_TURNS`**。
   chat/ask 命令行设 (`parse-args.ts` 照 `--max-bytes` 先例),serve 走 env 默认。
   不做 serve per-session 上限 (无需求,不做过度设计)。
3. **防 runaway 职责从 maxTurns 剥离**,记到 017 conditional remediation layer
   的待办:token 成本护栏 / 总耗时护栏 (017:27 已列,condy.layer 显式禁止,
   待 018 真实接通后按 013 条件式修复原则补)。在成本护栏落地前,maxTurns
   默认无限意味着**无防 runaway 兜底** —— 这是有意的取舍,不是疏漏。
4. **装配**: `build-engine.ts:172` 从 `env.llm.maxTurns` (env 变量) 或 CLI flag
   读入 `LoopEngineDeps.maxTurns`;均缺省 → `undefined` (无限)。
5. **超限语义**: 一旦用户显式设了上限且撞上 → 走 ADR-0011 的
   `throw MaxTurnsExceeded` + 模型收尾摘要。

## Considered Options

- **设高默认值 (200) 而非无限**: 保留防 runaway 兜底,但 200 仍是"粗暴计数",
  长程探索仍可能撞上,且上游参考实现内部逃逸默认 200 (`query.py:153`) 与面向
  用户的默认 8 (`query_engine.py:36`) 矛盾,反映"turn 上限防 runaway"本身站不住。
  被否:每次"设高一点"都只是推迟误杀,不是解决。
- **保留 hardcoded 6 / 做复杂分层配置 (env + CLI + serve settings 三态)**:
  前者是当前缺陷,后者 (上游参考实现 `react_launcher.py` 的 `enforce_max_turns`
  三态) 是为"用户罕见想要限制"的诉求造机制,过度设计。被否。
- **默认无限但有 cost 护栏同时落地**: 最正确,但把 017 conditional layer 的
  禁止项提前到本轮,扩大范围,是另一个 hard-to-reverse 决策。本轮不硬扩,
  记为待办。

## Consequences

- (+) 探索撞护栏的致命问题解决:默认无限,长程任务不被 turn 计数误杀。
- (+) 与上游参考实现语义对齐 (默认 None=无限,用户显式才设)。
- (+) 配置最小:一个 CLI flag + 一个 env 变量,零新机制,不做 serve settings。
- (−) 成本护栏落地前**无防 runaway 兜底** —— 有意的默认可infinite 取舍,
  已记入 conditional layer 待办;失控循环的兜底推迟到 token/耗时护栏。
- (−) 用户若不设 `--max-turns`,一次运行可无限迭代 (文本完成才停)。
  可接受:文本完成 (无 tool_use) 是自然终止,只有纯工具循环才失控,而那是
  成本护栏该管的。
- 回退 = 恢复 `maxTurns: 6` 硬编码;但一旦 surface 消费者已适配 CLI flag 透传,
  回退成本上升。

## Evidence pointers

- `src/harness/build-engine.ts:172` — 当前 `maxTurns: 6` 硬编码。
- `src/cli/parse-args.ts:120-129` — `--max-bytes` flag 先例 (新 flag 照此模式)。
- `src/config/env.ts:9-36` (`LlmEnv`) + `:299-308` — env 配置先例
  (`IKNOW_LLM_MAX_OUTPUT_TOKENS` / `IKNOW_LLM_TIMEOUT_MS` 走 `envInt`)。
- `docs/archive/wayfinder/issues/017-loop-hardening-for-migration.md:27` —
  "maxTurns 以外确有必要的时间、token 或成本护栏" 列入 conditional layer 显式禁止。
- `docs/CONTEXT.md:17` — `maxTurns` 是"调用模型前检查的运行时上限"。
- 上游参考实现基准: `upstream-ref/src/<baseline>/engine/query.py:700,882-883`
  (None=无限) · `query_engine.py:36` (默认 8) · `query.py:153` (逃逸默认 200) ·
  `react_launcher.py:85-100` (`--max-turns` flag)。
- `docs/adr/0011-loop-stop-summary-and-max-turns-exceeded.md` — 超限语义
  (throw + 收尾摘要),本 ADR 的超限行为依赖它。
