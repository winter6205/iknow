# Loop Engine 支持 thinking blocks — 实施计划

**Source**: #144 Resolution（wayfinder:grilling，2026-08-04，四题 HITL 裁决；gh-22 skip-spec 直通——Resolution 已含 5 段，操作员显式调 `/arthurpower:writing-plans` 收口）。
**Tracker**: GitHub issues（label `ready-for-agent`，native blocking via `addBlockedBy`）。
**设计真值**: #144 Resolution（本计划只分解执行顺序，不重述裁决理由）。裁决输入事实: #143 Resolution。

## 裁决速览（详见 #144 Resolution）

- **Q1 请求侧**：能力控制臂，wire 形状 `thinking:{type:'adaptive'}` + `output_config:{effort:N}`（effort 可省）；fixed-budget 排除；env flag `IKNOW_LLM_THINKING=off|adaptive` **默认 off**、`IKNOW_LLM_THINKING_EFFORT=`（空=不发送）；temperature 与 thinking 正交照旧发送。
- **Q2 历史保留**：thinking / redacted_thinking **全字段原样**进权威历史（含 signature/data），块序保持（thinking 先于 tool_use）；修正 adapter 丢弃 + 注释不一致；未知 block 维持 `ProtocolError` 严格；session-store JSON 序列化天然保留，不动。
- **Q3 投影**：thinking 不进 `texts` / `finalText`；回传=权威历史本身（Q2 自动满足 replay 契约）；**默认不可见、可开启显示**（实现期选 env flag 或 REPL 开关，两者可逆）。
- **Q4 验收**：三轴——单元（adapter 保留 + 请求侧 flag）/ trajectory（持久化消息可见）/ 端到端（Not run，缺 `NINE_ROUTER_KEY`，探针矩阵留 #143 §5 形状）；gate = `npm test` 全绿；#136/#119 只留接口。

## Context-loop 预检

- `docs/CONTEXT.md`：无冲突术语。**关键约束**：LoopTrace 严格不含 payload（CONTEXT.md 词条）——trajectory 轴验收的"thinking 可见面"是持久化/session 消息 JSON，**不是** trace JSONL（Q4 提案原表述已修正）。
- `docs/adr/` 0001–0006：无矛盾。新架构决策（thinking 进权威历史）不满足 ADR 三条件中的"surprising w/o context"——已在 #144 grilling 公开裁决，无需另起 ADR；若执行期出现满足三条件的取舍，走 `domain-modeling`。

## Tracer bullets

依赖图：T1 / T2 并行 → T3（←T2）→ T4（←T1,T2，可与 T3 并行）→ T5（←T3,T4）→ T6（←T5）。
注：T5 的"下一轮回传"断言需请求侧 flag（T4 内容），故 T5 依赖 [blocks: T3, T4]；T4 不依赖 T3，可与 T3 并行。

### 1. T1. `[decision]` env 配置面裁决

- **Affects**: 无代码改动——裁决票，落 Resolution comment。
- **裁决内容**:
  - `IKNOW_LLM_THINKING`：值域 `off | adaptive`，默认 `off`（显式开启）。
  - `IKNOW_LLM_THINKING_EFFORT`：值域 `'' | low | medium | high | xhigh | max`，空=不发送 `output_config`。
  - SSOT 落点：`src/config/env.ts`（与现有 `IKNOW_LLM_*` 一致；CLAUDE.md 记载 env.ts SSOT 纪律）。
  - 非法值行为：THINKING 非法值 → 回退 `off` 且不崩溃；EFFORT 非法值 → 视同空（不发送）。
- **Acceptance**: T1 issue 有 Resolution comment 记录上述四行裁决并 closed。

### 2. T2. `[implementation]` 类型联合扩展 thinking / redacted_thinking

- **Affects**: `src/harness/model-adapter/types.ts`（`AnthropicContentBlock` 加两个变体）、`tests/harness/model-adapter/anthropic-adapter.test.ts`（类型级用例可并入 T3 的测试文件，本票至少保证 tsc 通过）。
- **Acceptance**: `npm run typecheck` 通过；`AnthropicContentBlock` 含 `{type:'thinking'; thinking:string; signature:string}` 与 `{type:'redacted_thinking'; data:string}` 变体（grep 可验证）；现有测试不回归。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 3. T3. `[implementation]` adapter 保留 thinking blocks 进权威历史 [blocks: T2]

- **Affects**: `src/harness/model-adapter/anthropic-adapter.ts`（`nativeContent` 构造加 thinking/redacted 分支，消除丢弃；`:95-96` 注释与代码对齐）、`tests/harness/model-adapter/anthropic-adapter.test.ts`。
- **测试覆盖**:
  - 含 thinking + redacted_thinking + text + tool_use 的响应：`nativeMessage.content` 字段级深保留（thinking 文本、signature、redacted data），块序保持（thinking 先于 tool_use）。
  - `projection.texts` 不含 thinking 文本；`finalText` 派生不变。
  - 未知 block 类型仍抛 `ProtocolError`（回归保护）。
- **Acceptance**: 上述用例全绿；`npm test` 全绿。#134 问题 1（注释不一致）随本票关闭。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 4. T4. `[implementation]` 请求侧 thinking 控制臂（env → adapter params）[blocks: T1, T2]

- **Affects**: `src/config/env.ts`（新增两 env 读取 + 默认值）、`src/harness/model-adapter/anthropic-adapter.ts`（`RealAnthropicAdapterOptions` 加 thinking 配置；`step()` 按配置附加 `thinking` / `output_config`）、`src/cli/runtime.ts` + `src/session-api/hub.ts`（两处装配点传入）、`tests/harness/model-adapter/anthropic-adapter.test.ts`。
- **测试覆盖**:
  - flag `adaptive` → params 含 `thinking:{type:'adaptive'}`；设 effort → 含 `output_config:{effort:N}`；effort 空 → 无 `output_config`。
  - flag `off`（默认）→ params 不含 `thinking` / `output_config` 字段（现状行为不变）。
  - temperature 与 flag 状态正交：开/关 flag 不改变 temperature 发送。
  - env 非法值回退（T1 裁决的行为）。
- **Acceptance**: 上述用例全绿；`npm test` 全绿；默认 off 下现有行为零变化（既有测试不回归）。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 5. T5. `[implementation]` loop 级保留与回传 + 可见开关 [blocks: T3, T4]

- **Affects**: `tests/harness/loop-engine.test.ts`（多轮场景）、显示开关的落点文件（实现期裁决：env flag 或 REPL 开关二选一，在票内记录理由）。
- **测试覆盖**:
  - stub/loop 多轮：含 thinking 的 assistant 回合进 `state.messages`（append-only，全字段）；下一轮 replay 的请求消息原样含 thinking blocks。
  - 可见开关默认关：`texts`/输出面不含 thinking；开启后展示通道含 thinking（开关形态按实现期裁决）。
- **Acceptance**: 上述用例全绿；`npm test` 全绿。
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

### 6. T6. `[implementation]` 9router thinking 探针（一次性，不入 src）[blocks: T5]

- **Affects**: 一次性探针（throwaway 分支或 `scripts/` 一次性脚本，参照 `scripts/i132-probe-9router-context-mgmt.ts` 先例；**不动 `src/`**）。
- **探针矩阵**（#143 Resolution §5）:
  1. 首轮带 `thinking:{type:'adaptive'}`（另备 fixed-budget 变体对照）→ 判定三档：2xx+thinking / 2xx 无 thinking（静默丢弃）/ 400。
  2. 若首轮返回 thinking+tool_use：二轮回传三形状（原样 / 删除 / 截断 signature）记录状态码与脱敏 error body。
  3. 必须制造 tool call（纯 thinking+text 完成轮不能充分测试结构校验）；WSL2 经动态网关 IP（#132 事实）。
- **前置**: `NINE_ROUTER_KEY`。**无 key → Not run 记录 + 票保持 open 待 key**，不阻塞 T1–T5 合入。
- **Acceptance**: 探针跑完 → Resolution comment 记录三档判定，作为"翻转默认值"后续小决策的输入；无 key → comment 记录 `Not run: 缺 NINE_ROUTER_KEY`，票 open。

## 显式排除（Out of scope，与 #144 Resolution 一致）

- #136 token 核算、#119 压缩重启（含 clear_thinking 客户端版）——只留接口：thinking 已进权威历史、可被压缩层识别。
- 探针脚本进 `src/`。
- 默认翻转（adaptive 默认开）——T6 判定后的独立小决策。
- web UI / `ask` JSON 的 thinking 展示细节——T5 开关落地后的后续票（若有真实需求）。

## 验收总门

`npm test`（vitest：unit + eval alignment + trajectory + harness）全绿；端到端轴 Not run 显式记录（测试规范记录的 Not run 格式）。
