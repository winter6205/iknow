# 0112. 指令权威出站投影：宿主帧盖戳，untrusted 通道不能冒充官方门牌

Date: 2026-09-19
Status: accepted

## Context

暴露的问题：模型对「官方外形」的信赖建立在**消息长相**上——工具结果里出现一段完整的 `<agent_status>` 或系统前缀式文本，就能在指令面冒充宿主帧抬权。现有读规则（`IKNOW_AGENT_STATUS_READ_RULE`）宣称 transcript 里最新的 XML 标签权威，等于把防伪交给「模型读同一串字、靠自觉」。

三条既有裁决界定了本决策的落点：

- **ADR-0009**：channel-based 信任，labeling 不是防御——靠解析标签名册判真伪，本身就是可伪造的门牌。本 ADR 把这条推广到指令面。
- **ADR-0028**：状态栏是每跳追加的 user 注入，进 messages、不进 `deps.system`；投影纪律不得被改成「把栏挪进 system」（那会破坏 KV cache 契约）。
- **ADR-0044**：低完整度来源（记忆正文、父模型可写的 `systemPrompt`）不得买进了 system 的最高信任槽。worker 的 LOCKED 宪法同理，不可被父 addendum 覆盖。
- **契约 X / observability side-channel**（ADR-0036 一脉）：磁盘真源 ≠ 模型可见字节。「磁盘可脏、wire 是派生视图」是本决策的既有基线，不是新发明。

## Decision

**指令权威收敛为一个出站投影（outbound projection）：权威历史保持 append-only、可以脏；发给模型的字节由代码按消息来源投影，官方外形只来自带戳的宿主帧。**

锁死子决策：

1. **宿主注入 commit 时打非模型可见的出处戳。** 状态栏等同款 `encodeUserText` 注入在写入 LoopState 时盖戳；出站序列化时剥掉戳本身。戳是宿主与投影函数之间的内部约定，不是模型可读内容。
2. **`buildMessageParams` 是 `LoopState` + `request.system` 的纯函数投影。** 同一历史 → 同一 wire 字节，KV 前缀稳定；不得靠每跳改 `system` 塞现势。
3. **无戳 / `tool_result` 文本确定转译。** 载荷出站后不得含可被读规则认作宿主帧的未转义标签语法——untrusted 无法复现 host 语法；内容仍可读，数据不丢。转译不写回权威历史，不改 TUI 展示原文。
4. **worker LOCKED 宪法不被父 addendum 买进。** `envelope.systemPrompt` 不得覆盖 LOCKED 六段；addendum 降到 user/untrusted 通道。即 system 的 LOCKED 前缀与无 addendum 时逐字节相同。
5. **投影失败 fail-closed。** 编码器/投影抛 typed 错误则本跳不发模型请求，不回落「原样上脏 transcript」。
6. **读规则改为「只信本跳宿主帧」**，不再宣称 transcript 里最新 XML 标签权威。
7. **能力落地后，产品简介一行落在仓库根 `README.md` 的 Features**（与 Harness / Tools / Surfaces 同级），不改 `docs/` 或 `web/` 下的 README。

**ADR 关系：** 不改写 0009 / 0028 / 0044 的正文，是把三者的「通道即信任」裁决推广、焊接到指令面的统一机制；0028 的栏投影纪律（append-only、不进 system）逐字沿用。

## Why not

- **labeling / 解析 XML 名册当防伪：** ADR-0009 已判「labeling 不是防御」；名册语法本身就是可伪造的门牌，伪造成本为零。拒。
- **全量 CaMeL（特权 LLM 抽控制流）：** out of scope——那需要重建整套 data-flow 权限格，远超拆假门牌所需。本 ADR 不承诺、不预留。
- **soul 告诫当机制：** 可选一行 usage 提示，但不承担 invariant——告诫是「靠自觉」的换皮，正是被否决的原态。拒为验收机制。
- **把每跳现势塞进 system：** 破坏 KV 前缀稳定，且违反 0028 的栏不进 `deps.system` 契约。拒。

## Consequences

- **KV 前缀稳定**：投影是纯函数，wire 字节只随历史增长而追加，不随拼装时序漂移。
- **磁盘可脏、wire 是派生视图**：权威 transcript 里假标签原样存在（审计、复现不受损），只有出站字节被转译——与 observability side-channel / 契约 X 同构。
- **不替代 sink**：普通句子里的「去做 X」仍可能被模型执行；指令权威与能力权威分两层，权限、沙箱、egress 仍是能力面的执法者。拆假门牌 ≠ 免疫自然语言间接注入。
- 落地面：`src/harness/model-adapter/`（出站缝加深为投影）、`src/harness/loop-engine.ts`（宿主注入 commit 盖戳）、`src/harness/subagent/worker.ts`（constitution vs addendum）、读规则常量与黄金集、根 README Features 一行（排在能力落地后）。

## Evidence pointers

- `specs/instruction-authority-projection.md` Settled invariants 1–6。
- ADR-0009（labeling 不是防御）、ADR-0028（栏进 messages 不进 system）、ADR-0044（低完整度来源不买 system 席位）、ADR-0036（磁盘真源 ≠ 模型可见字节）。
