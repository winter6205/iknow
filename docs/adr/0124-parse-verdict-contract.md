# 0124. 解析判定契约：六档分类与 fail-closed 归宿

Date: 2026-09-24
Status: accepted

## Context

ADR-0123 定了统一解析地基（tree-sitter 原生绑定、同步 `parseForSecurity`）。地基与各墙之间需要一份共同输入契约：一条命令的解析结果分几档、每档在权限系统里走到哪。没有这份契约，各墙会退回各自扫裸文本。本 ADR 记录 wayfinder map `unified-shell-parsing` usp-2 的定案；`full_auto` 下不撞硬墙即放行（`policy.ts` 步骤 3）是既有事实，本契约的"ask 归宿"以其为基准平价设计。

## Decision

`parseForSecurity` 输出**六档判定**，消费规则如下：

1. **ok**（树完整且结构全部已建模）：墙检查树中**每一个命令节点**（循环体内、替换括号内的都算；替换语法的具体政策归 spec/usp-4）。命中危险 id → deny；未命中 → 现有分层规则/模式流程，与今天同构。
2. **unknown-syntax**（解析成功，但含未建模的节点类型）：落正常权限流 **ask**，reason 注明"含未识别语法结构"；full_auto 下与现状平价放行。依据：未知 ≠ 危险，硬墙只管危险意图（ADR-0117 精神）；grammar 升级新增句式时不至于大面积误拒。
3. **malformed**（树带 ERROR，如引号不闭合）：**硬拒**。bash 对其行为不可预期，ERROR 也可能是解析分歧的表现。
4. **aborted**（超时预算 → null，或 READY 后任何意外异常）：**硬拒**。可被对抗性输入刻意触发，必须 fail-closed。
5. **over-cap**（超过调用侧长度上限，不进解析器）：**硬拒**，reason 写明"过长无法分析"。上限取值从宽（64KB 量级，精确值归 spec），保住 heredoc 写文档类正当长命令。
6. **parser-unavailable**（**初始加载失败**）：降级旧裸子串扫描 + 醒目日志 + **TUI 输入框区域红字警示**（降级不许静默）。这是**唯一**的降级路径：UNAVAILABLE 为进程内终态、不重试；加载成功（READY）后的任何运行时故障一律归第 4 档硬拒；旧扫描自身抛异常 → 硬拒该条命令（兜底）。

**前置否决（分档之前）**：命令含**解析分歧字符**——控制字符（豁免 `\t\n\r`）、Unicode 空白/零宽（NBSP、ZWSP、BOM 等）、反斜杠+空白——连解析都不做，直接**硬拒**，reason 写明字符类别。依据：这些形状使"分析器所见 token ≠ bash 所见 token"，契约的信任基础失效；零宽字符人眼不可见，ask 等于让人盲签。清单住 `shell-parse.ts`、登记进 spec，每发现一个新分歧登记一条（`echo\ test` 类合法惯用法的误拒由 reason 提示改写为引号形式）。

## Consequences

**正面 / Applied:**

- 六档判定是所有墙的唯一解析输入；新增墙只定义"在 ok 树上查什么"，不再触碰分档语义。
- "坏了降级"与"坏了硬拒"的区分零运行时诊断：一个初始化时设置一次的三态标志（UNINITIALIZED → READY / UNAVAILABLE）+ 一个 try/catch，约五行代码。
- unknown-syntax 与现状平价，grammar/依赖升级不引发误拒风暴。

**负面 / Trade-offs:**

- full_auto + 未知句式 = 自动放行（与今天相同，未收紧）；更严选项（未知 → 硬拒）被明确放弃，代价是升级期误拒。
- 反斜杠+空白入前置否决清单，`echo\ test` 被拒（reason 给改写提示）。
- malformed / over-cap 比现状更严（今天落正常流程）；误拒成本低：bash 自己多半报语法错、模型可自纠。
- 旧扫描器必须永久保留为降级层（预答 usp-5"旧扫描器去留"的一半）；红字警示的呈现形态（sticky notice 还是一次性）归 spec。

## Evidence pointers

- 决策过程：`docs/wayfinder/tickets/usp-2-tristate-fail-closed-contract.md`（map `unified-shell-parsing`）。
- 超时确定性 / stale-state / 解析分歧字符实测：`docs/wayfinder/research/usp-1-parser-survey.md`。
- 地基形态：ADR-0123；硬墙职责划分：ADR-0068（经 ADR-0123 修正）。
