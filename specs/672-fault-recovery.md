# Spec: 故障恢复（FaultClass · 传输重试 · 工具环检测）

> Wayfinder map: [#672](https://github.com/winter6205/iknow/issues/672)（cleared）· G1–G5 ratified 2026-08-25；操作员授权编排实施类由 agent 收口，SPECIFY 假设沿用 G 决议（跳过现场 assumption 盘问）。

## Objective

让单 agent 的 **Loop Engine** 在失败时有可测试的策略，而不是把 SDK 错原样抛掉、或让同一工具同一参数空转到 `maxTurns`。

用户：所有走 Loop Engine 的入口（TUI / chat / ask / serve / worker）。成功 = （1）失败可分类；（2）LLM 传输瞬态在适配器外层有界重试；（3）工具环在结果已回模型之后停止本 run，说明进历史并进入下一问上下文。

## Boundaries

- **Does:**
  - **T1 FaultClass**：闭集策略 `retry` | `fuse` | `none`，轴为 API / 工具 / 上下文 / 控制流（[#675](https://github.com/winter6205/iknow/issues/675) 表）。不扩、不替代 **StopReason**。
  - **T2 传输重试**：装饰 **ModelAdapter.step**（create/stream 同一层）。各供应商 adapter **只翻译** 瞬态 vs PromptTooLong vs 协议/鉴权。不进 loop 状态机，不进 session-api，不绑 Anthropic SDK `maxRetries`。尊重 AbortSignal；PromptTooLong **立即抛**（ADR-0013）。
  - **T3 环检测**：工具阶段全部 settle 且 `tool_result` 已进 **append-only messages** 之后、下一次 `adapter.step` 之前检查。调用键 + 结果键；周期 k=1..5、重复 R=5；结果键相对上一周期无进展才 trip。bash `ok`+非 0 in。MCP 无法正规化 → fail-open。注入 typed **LOOP_DETECTED** user 信封并落盘；`StopReason: "fused"`；worker 当失败；session-api / CLI `stop=` 扩联合。settings/env 可关检测（默认开）。
  - **Gate B**：仅删除/收窄可执行面 `retry` 禁词；checkpoint / cost / otel / session-api 规则不动。
  - **交付序**：T1 合入后才 T2；T2 合入后才 T3。三 PR，禁止一张大 diff。
- **Confirms with human:** （已收）G1 A2、G2 A、G3 完整环、G3 信封进下一轮、G4 分 PR、G5 A。
- **Out of this spec:**
  - 手动 `/compact` 不走 token 门（#270 / compress 独立 PR）。
  - verify 失败签名 / 趋势停 / 修正注入（#116）；本 spec **零改** `src/harness/verify/`。
  - PromptTooLong compact 一次再调、maxTurns（#270 已有）。
  - 工具失败盲目自动再跑；正文复读检测；TUI 熔断横幅；SSE；graph；#440 bash 产品面。
  - OTel、token-cost 护栏、总耗时独立 stop。

## Success Criteria

```bash
npm run typecheck
npx vitest run tests/harness/loop-engine tests/harness/model-adapter tests/harness/tools tests/harness/subagent tests/session-api tests/cli tests/harness/public-exports.test.ts tests/harness/gate-b-capability.test.ts
```

每条 yes/no：

- FaultClass 对 G2 表中的 API 429 样例策略为 `retry`，对 permission deny 为 out/`none`，对反复同参 `execution_failed` 为 `fuse`（empty / negative）。
- 装饰器：模拟 429 两次后成功 → 只一次成功 `step` 结果；AbortSignal 在退避中 abort → `cancelled` 语义、不抛裸 Error（exception / cancelled）。
- PromptTooLong 经装饰器 **零重试**（negative）。
- `src/harness/**/*.ts` 可执行面允许标识符 `retry`（Gate B 该规则不再失败）；`checkpoint`/`otel`/`session-api` 扫描仍在（negative 卫生）。
- 环：失败 → 成功 read（不同调用键）→ 同样失败，重复至 R=5 停滞 → `stopReason === "fused"`，历史含全部 tool_result **以及** LOOP_DETECTED 信封（positive）。
- 环：同一 bash command 连续非 0 且结果键不变达阈值 → fused（positive）。
- 环：改代码后同一 command 退出码变化 → 不 fused（negative）。
- 单 wave 内并行调用全部执行并回传后才检查；不在 settle 前取消同波调用（concurrent）。
- 无法正规化的 MCP 形状不触发 fused（fail-open / exception）。
- worker：`fused` → 失败信封，不得当成功（negative）。
- session-api / CLI 接受并打印 `fused`；下一 `run(priorMessages)` 含 LOOP_DETECTED（positive）。
- `npm run typecheck` 与上列 vitest 子集 exit 0。

## Open Questions

(none)

## Inherits / Changes

**Inherits：**

- 栈：TypeScript；`npm test` / vitest；无本 spec 强制新运行时依赖。
- CONTEXT 现行抄录（exact）：
  - **Loop Engine**: Foundation 的状态机运行内核，驱动模型 -> 工具 -> 真实结果 -> 下一轮模型 -> 明确停止；位于 `src/harness/`，作为 018 退役旧 loop 后的可靠运行时基础。
  - **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加（`[...prev, x]`）更新，禁止原地修改或建立第二份权威副本。磁盘形态见 **session transcript**（JSONL 事件投影出当前头的 messages）。
  - **StopReason**: Loop Engine 的七类停止判别联合——016 五类（completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse）末尾追加 017 两类 `cancelled`（signal abort）与 `timeout`（超时强制）；追加不重排，Transition 形状随之自动扩展。
  - **in-flight closeout**: abort/timeout/进程死亡时的收尾——live：模型在途则整回合不进历史；工具在途则 assistant 已追加，在途 tool 填 `execution_failed`（`"cancelled"` / `"timeout"`），再编码为 tool_result。signal 优先于 timeout。
  - **Model Adapter 接口** 见 `src/harness/model-adapter/types.ts` `ModelAdapter.step`。
- ADR-0013：PromptTooLong → compact → 每 run 再调模型一次；传输重试不得吞掉该类错误。
- 邻图：G4 — verify=#116；compact 超窗=#270；本路线不改那些模块。

**Changes：**

- StopReason **末尾追加** `fused`（不重排既有七值）。
- 新增 FaultClass 策略面；传输重试装饰 `ModelAdapter`；本 run 工具环检测。
- persist **已刷**：CONTEXT **FaultClass** / **tool-call loop detection** / **LOOP_DETECTED envelope**；**StopReason** 含 `fused`；ADR-0029。
- 索引：`specs/README.md` 增加本文件一行。

## architecture-change-reviewer

预定接线（实施前 ACR）：

- `src/harness/model-adapter/**`、`src/harness/loop-engine.ts`、`src/harness/build-engine.ts`、`src/harness/subagent/worker.ts`
- `src/session-api/contract.ts`、`src/cli/format.ts`
- `tests/harness/gate-b-capability.ts`、`tests/harness/public-exports.test.ts`
- `specs/672-fault-recovery.md`、`specs/README.md`、`docs/CONTEXT.md`、`docs/adr/0029-fault-class-and-fused-stop.md`

```
bounded-context-guardian: yes — FaultClass/重试/环检测在 harness；session-api 与 CLI 只扩 StopReason 联合；零改 verify/；不新建 controllers/services 层目录
defensive-contract-validator: yes — SC 含 empty/negative/overflow（R=5 周期）/ concurrent（wave settle 后检查）/ exception（abort、MCP fail-open）
error-handling-enforcer: yes — 传输耗尽与 fused 为 typed 停止；不抛裸 Error；MCP 不正规化 fail-open 不误杀
complexity-anti-drift: yes — 三 PR 分缝：类型表 / adapter 装饰器 / loop 检测；装饰器不进 loop 状态机
minimal-change-verifier: yes — 一逻辑任务拆三 commit（G5）；T2 不先于 T1、T3 不先于 T2；无第四刀混 compact/verify
```
