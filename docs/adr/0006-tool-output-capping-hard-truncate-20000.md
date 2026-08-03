# 0006. Tool output capping (hard truncation, executor floor 20000 chars, no disk offload)

Date: 2026-08-04
Status: accepted

## Context

GH issue #140 C+D 块（Q9 截断策略 / Q10 封顶阈值，吸收自 #138 封顶设计票）。问题域：单条工具结果可能撑爆上下文窗口（"单条撑爆"轴，与"累积增长"轴的压缩策略 #119 正交）。前置契约（ADR-0004 契约 X）已定：工具返回纯数据，executor 是截断唯一权威。#138 曾有一版草稿 Resolution（8000 字符 / 双层策略），被操作员标记"跳过 grilling，非决议"并 reopen；本轮 #140 grilling 正式重新裁决。iknow 无 token 核算（#136 未做），字符级是当前唯一可行兜底。操作员 2026-08-04 裁决。

## Decision

**Q9 = 硬截断丢尾巴，不落盘。**

1. executor 兜底超过阈值时：截断 + 追加统一标记（含原长/保留长 + "如需更多信息，用更精确的输入重新调用"引导）。完整内容**不写盘**。
2. 否决落盘（microcompact 写文件 + 预览 + 路径，OpenHarness `_offload_tool_output_if_needed` 范式）：落盘需文件路径协议 + 生命周期 + session-api 暴露 = 范围扩张；#114 地图既定"与 #119 阶段 2 滑动窗口统一讨论历史序列化协议"，本期不碰。
3. 理由：iknow 工具多为"读文件/搜内容"等**可再生查询**——被截断后模型可 grep 收窄 pattern / read_file 换 offset / bash 加过滤重新获取，成本低于维护落盘文件生命周期。落盘是为"数据不可再生"场景（沙箱内昂贵命令输出）设计，iknow 主场景不适用。

**Q10 = executor 兜底阈值 20000 字符。**

4. 硬约束：≥ 各工具正常最大输出，避免双层重复截断。各工具正常最大：bash 12000（工具级已截）/ grep 200 条×~70 字 ≈ 14000 / glob 200 条×~50 字 ≈ 10000 / read_file 受 1MB 文件大小上限约束。20000 ≈ 5000-10000 tokens。
5. 对照 OpenHarness inline 阈值 16000：iknow 略宽——因本期无落盘第二层，单阈值需更宽。
6. 两层各司其职：工具级管"读多少"（语义单位：行/条/字符），executor 管"输出不超多少"（字符兜底）。

**工具级截断参数（随 ADR-0004 工具集一并定案）**：bash 12000 字符（按 code point，修 surrogate 拆断）/ read_file limit 默认 200 上限 2000 行 + 文件大小 1MB / grep limit 默认 200 上限 2000 / glob limit 默认 200 上限 5000。

**Why not alternatives**:

- _落盘 + 预览 + 路径（OpenHarness 范式）_：见 Decision 2-3；且 #114 地图已将其占位至 #119 阶段 2 统一讨论，本期落地会割裂历史序列化协议设计。
- _#138 草稿的 8000 字符兜底_：8000 < bash 工具级 12000 → bash 截到 12000 后 executor 再截到 8000，双层重复截断 + 标记冲突。正式推翻。
- _按 modelWindow 比例的相对阈值_：依赖 #136 token 核算（未做），本期不可行；列为 #114 阶段 2 衍生。
- _executor 信任工具的 truncated 字段跳过兜底_：违反契约 X（executor 永不信任工具声称字段）；MCP 第三方可伪造 `truncated:true` 绕过封顶。

## Consequences

- (+) "单条撑爆"轴闭环：任何工具（含未来 MCP 第三方）输出经 executor 总闸必不超 20000 字符。
- (+) 两层截断无冲突：工具级（语义单位）与 executor 级（字符兜底）阈值不重叠（20000 > 各工具正常最大）。
- (+) 无落盘 = 无文件生命周期/路径协议/session-api 暴露的运维负担；实现面小。
- (−) 超阈输出**不可恢复**（尾巴真丢）——模型靠"收窄输入重新调用"恢复；对不可再生输出（如一次昂贵的构建日志）是真实损失。缓解：bash 工具级 12000 已先截，executor 层 rarely 触发；#119 阶段 2 重审落盘。
- (−) 字符级 ≠ token 级精度：20000 字符按 1:1~1:4 浮动约 5000-10000 tokens，误差在上限下可控；token 级精度等 #136。
- (−) 推翻 #138 草稿数字（8000）：以本 ADR 为准；#138 Resolution 存档标注"草稿，经 #140 grill 推翻"。

**Evidence pointers**:

- GH issue #140 C+D 块决议评论 + Resolution（2026-08-04）。
- GH issue #138（closed）— 草稿 Resolution（8000 字符）存档，正式被本 ADR 推翻。
- OpenHarness 参照：`engine/query.py:524-553`（`_offload_tool_output_if_needed`，16000 阈值 + 3000 预览 + 落盘）/ `services/tool_outputs.py:10-12`（阈值可配 + microcompact 4000）/ `tools/bash_tool.py:139-140`（12000 硬编码）。
- GH issue #136（token 核算，相对阈值的前置）/ #119（压缩策略，落盘重审点）。
- 关联 ADR：0004（工具集 + 契约 X）/ 0005（executor 加固——兜底执行的主体）。
