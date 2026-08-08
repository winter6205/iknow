# 0013. Reactive compact: prompt-too-long 兜底,推翻 Q3 "reactive 不实现"

Date: 2026-08-08
Status: accepted

## Context

`src/harness/compress/index.ts:1` 的 Q3 决议写明 "proactive trigger, reactive
不实现"。proactive compact (`loop-engine.ts:919-929`) 靠 `estimateMessagesTokens`
**估算** token 数,超阈值提前压。但估算永远有误差,极端情况下 (突发增长 / 估算
失准) 窗口仍会被撑爆 —— 此时 SDK 抛 prompt-too-long (400 `BadRequestError`),
R1 已证 adapter 层对其零翻译,裸 rethrow 到 `loop-engine.ts:430-439` 只有
`ProtocolError` 分支,其余 `throw err` 直接崩 run。proactive + 校准只能**降低**
崩溃概率,消灭不了"估算漏了"的硬崩溃。OpenHarness 把 reactive 列为 loop contract
的一部分 (p02 §2.8, `query.py:768-777`),不是可选项。

## Decision

推翻 Q3,补 reactive compact 兜底:

1. **触发**: SDK 抛 prompt-too-long (400) → adapter 加
   `PromptTooLongError extends ProtocolError` (R1 最小改动: `errors.ts` 加类 +
   `anthropic-adapter.ts:643/:510` 两个 SDK 调用点包 try/catch, `instanceof APIError
&& status 400 && invalid_request_error && 含 prompt length` → 抛
   `PromptTooLongError`) → `loop-engine.ts:430-439` 捕获 (`instanceof ProtocolError`
   分支命中)。
2. **patch 契约**: 每 run 限 **1 次** (`reactive_compact_attempted`, 对齐
   OpenHarness)。压缩后重试仍超 → throw (交回 ADR-0012 超限语义收场)。避免
   "压→抛→压→抛" 的浪费循环。
3. **压缩函数**: 复用 `compactMessages` (`loop-engine.ts:930`),与 proactive
   同一逻辑,只是错误触发 vs 估算触发。不引入 proactive/reactive 的力度区分。
4. **与 proactive 共存**: reactive (离散"错误触发") + proactive (连续"估算触发")
   双保险,天然不冲突,无需额外优先级/阈值设计。

## Considered Options

- **维持 Q3 (不补 reactive)**: 靠 R3 估算校准降低概率,但估算永远是估算,
  极端情况 (估算漏了) 仍硬崩溃。崩 run 是"最后一层防御"缺失,不可接受。被否。
- **reactive 用更强制压缩 (`force=True`, OpenHarness 全量)**: OpenHarness 是
  proactive 轻量 / reactive 全量的折衷;iknow 的 `compactMessages` 本身已能做压缩,
  proactive 没有轻量/全量之分,复用最干净。被否。
- **限多次 reactive**: 无限重试只会在"压缩降不下窗口"时陷入浪费循环,烧 token
  不解决问题。限 1 次,超了就 throw。被否。

## Consequences

- (+) proactive 估算失败时兜底压缩重试,loop 不崩 —— 消灭"估算漏了"的硬崩溃。
- (+) 与 OpenHarness loop contract 对齐 (p02 §2.8)。
- (+) 最小改动: 一个 `PromptTooLongError` + 两个 SDK 调用点 try/catch +
  loop-engine 一个分支,纯增量。
- (−) 多一次模型调用 (压缩重试) 在"估算漏了"时发生;但限 1 次 + 超了就 throw,
  成本有界。
- (−) 推翻既有 Q3 决议 —— 需更新 `compress/index.ts:1` 注释 ("reactive 不实现"
  → "reactive 已实现"),该代码改动留给 spec/实现阶段 (spec-driven-development),
  ADR 只记决策不碰代码。
- 回退 = 移除 `PromptTooLongError` + loop-engine reactive 分支,恢复 Q3;但一旦
  surface 消费者依赖 reactive 兜底,回退成本上升。

## Evidence pointers

- `src/harness/compress/index.ts:1` — Q3 决议 "proactive trigger, reactive 不实现"。
- `src/harness/loop-engine.ts:919-929` — proactive compact 估算触发。
- `src/harness/loop-engine.ts:430-439` — 唯一 `ProtocolError` 捕获点 (reactive 分支落点)。
- `src/harness/model-adapter/anthropic-adapter.ts:643/:510` — 两个 SDK 调用点
  (reactive try/catch 落点)。
- R1 ticket (#271, closed) — adapter 错误翻译 inventory;验证 prompt-too-long
  当前零翻译、裸 rethrow 崩 run。
- OpenHarness 基准: `upstream-openharness/src/openharness/engine/query.py:768-777`
  (reactive compact → continue) · `query.py:66-87` (`_is_prompt_too_long_error`) ·
  `query.py:651` (`reactive_compact_attempted`)。
- `docs/adr/0012-max-turns-user-switch-default-unlimited.md` — 超限语义,
  reactive 压后重试仍超时 throw 依赖它收场。
