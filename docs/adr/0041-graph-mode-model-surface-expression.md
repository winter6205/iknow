# 0041. graph mode 切换的模型面表达：run_graph 常驻 + 尾部追加提示，编排段撤出 system

Date: 2026-09-04
Status: accepted

## Context

wayfinder 图「模型面前缀分层与缓存兑现」G4 票裁决。依据：目标端点（MiniMax / 火山）走被动前缀缓存，前缀序 `tools → system → messages`，`run_graph` 在 42 件注册序约第 21 位——[ADR-0030](0030-graph-mode-shift-tab-overlay.md) 的「条件装配」使翻图成为**中段删除**，从该位置起约半数工具 + system + 全部 messages 缓存作废；长会话翻一次图的代价远超常驻 `run_graph` schema 的固定 ~350 tok（九成时间吃被动缓存价，命中 ≈ 20% 输入价；火山按请求计费，常驻严格占优）。

## Decision

修订 ADR-0030 的**表达方式**，不动其产品语义（Shift+Tab 三态轮、下一次 `run()` 装配生效、过程不拦均原样保留）：

1. **`run_graph` 常驻注册**，graph 关闭时由 handler 层 EXIT 拒绝调用（ADR-0030 已有「注册 ≠ 可见，handler 亦二次 EXIT」先例）；description 一句静态文字说明仅在 graph mode 可用。
2. **模式切换改在 `messages` 末尾追加一条更换提示**：开图时编排指引并入该提示，关图时追加关闭提示——尾部追加对前缀字节零影响。
3. **编排段（`orchestration`，~883 chars）整体撤出 system**，内容并入切换提示；system 侧从此无随模式变化的段。
4. **可执行纪律**：凡会话内可变的闸门必须落位在 `messages` 尾部或 handler 层；工具面与 system 的条件装配只允许以**会话级常量**为闸门（如 ask 表面无翻图能力，`run_graph` 在该面缺席 = 恒定，可继续条件化）。相邻两轮 `tools` deep-equal 即前缀稳定断言的 tools 侧形式。

## Considered Options

- **B：`run_graph` 挪注册序最末位 + 保留条件装配**——中段删除变尾部增删（lazy 尾巴同形），默认模式零面积；但每次翻图仍废 system + 全部 messages 缓存，交给 G1 的纪律退化为较弱的「尾部规则」。被否。
- **C：维持现状（条件装配 + 编排段 system 注入）**——人工触发低频，但每次翻图 ~5.7K+ tok 全废，违反 G1 将立的无例外纪律。
- **编排段 A2（留 system 改常驻）**——默认模式白常驻 883 chars 且开图无动态指引，两套都留。被否：A1（并入切换提示）单一来源。

## Consequences

- **正面 / Applied:** 翻图对模型面前缀零字节影响（tools 恒定、system 无模式段、messages 只尾部追加）；G1 的 tools 侧纪律可用一条 deep-equal 断言表达。
- **负面 / Trade-offs:** 编排指引从常驻降为切换时一次出现，长图任务后期模型可能遗忘（补救如工具回执重提留待实施票）；默认模式模型看得见 `run_graph` 但调用被拒（description 静态文字压低误调率，字节恒定不破契约）。

## Evidence pointers

- R2/R3 实测：tools ≈ 10.4K tok（前缀 94%）、`run_graph` schema 1,383 chars ≈ 350 tok（asset: `scripts/wayfinder-measure-prefix.ts`）。
- R5：翻图中段删除波及范围与 MCP 尾部追加对比；lazy 尾巴「尾部追加保 KV cache 前缀」先例（`src/harness/aci/aci-registry.ts:143`）。
- R4：编排段「仅用户翻图时变」实测；system 变动带走整条 messages 缓存的推论。
