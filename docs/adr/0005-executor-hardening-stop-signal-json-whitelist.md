# 0005. Executor hardening (unified stop signal + JSON-compatibility whitelist)

Date: 2026-08-04
Status: accepted

## Context

GH issue #140 B 块（Q6/Q7/Q8，executor 底盘加固）。executor 是 Foundation 工具执行的总闸（所有工具结果必经 `safeContent` chokepoint），现行有三处既定债：① timeout 只等不杀——`executor.ts:94-103` 用 `Promise.race` 约束等待时长，到点放弃等待但 handler 继续跑（`:93` 注释"timeout 在外层约束执行时长，不依赖 handler 内部支持取消"是**故意的设计意图**）；② cancel 靠 handler 自愿——executor 原样透传 signal（`:87`），5 个工具仅 shell_exec 监听（`ctx?.signal` 传给 `exec()`），其余 4 个 handler 签名不接 ctx；③ `isJsonCompatible`（`:38-48`）过宽——NaN/Infinity 按 typeof number 放行（JSON.stringify 静默变 null）、Date/Map/Set/类实例因 `Object.values` 返回空数组误判兼容（JSON 化变 `{}` 丢数据）、循环引用致检查本身栈溢出。平台限制：Node.js 无法强行中断正在执行的同步代码；可终止的只有外部进程与等待中的操作。操作员 2026-08-04 grilling 裁决。

## Decision

**B-1（Q6+Q7 合并）：统一停止信号管超时与取消。**

1. executor 为每次工具调用发一个统一的 **AbortSignal**，合并两种触发：超时到点 → 触发信号 → 返回 "timeout"；用户取消 → 触发同一信号 → 返回 "cancelled"。停止原因四值区分（none/callerAbort/timerTimeout/hostCancel）沿用 CONTEXT.md 既有 `cancelKind` 定义，不新发明。
2. 工具分两类响应：**有子进程的工具**（bash、grep）必须监听信号，收到即杀子进程——SIGTERM → 等 2 秒 → SIGKILL，且 `detached` + 负 pid **杀整棵进程树**（比只杀一层进程更干净，补其漏）；**纯本地操作工具**（read_file/glob/edit_file/write_file）信号递达但无可杀对象，executor 不等待，结果丢弃。
3. **推翻现行"只等不杀"设计意图**（executor.ts:93 注释）——改为 executor 发信号 + 子进程工具必须配合杀。

**B-2（Q8）：isJsonCompatible 收紧为白名单 + 严格原型检查。**

4. 只放行：字符串、布尔值、**有限数字**（显式拒绝 NaN/Infinity/-Infinity）、数组、**纯对象**（原型 === Object.prototype；Map/Set/Date/类实例全部拒绝）。
5. Date 显式拒绝：不依赖 toJSON 隐式魔法；工具要表达时间须显式返回字符串（"明确优于隐式"）。
6. 防循环引用：检查时维护已访问对象集合（WeakSet），重复访问即拒绝。
7. **被拒后处理 = 提示文字替换，不判调用失败**（维持现状语义）。理由：避免把"返回值瑕疵"升级为"整次失败"触发模型误重试；后续是否升级为判失败留作未来议题（操作员明示"后续要升级再说"）。

**Why not alternatives**:

- _超时与取消两套信号分治_：对工具而言两者动作相同（停手 + 清理），区分是 executor 的事（返回给模型的说法不同），工具侧合并降低每个工具的实现负担。
- _维持"只等不杀"_：放弃等待的 handler 继续在后台跑 = 资源泄漏 + 副作用不可控（bash 命令可能正在写文件）；"杀不了的就丢弃"对纯本地操作已足够，对有子进程的工具必须真杀。
- _被拒后判调用失败_：对第三方（MCP）工具可能误伤，且失败触发模型重试循环；提示文字让模型知道"这次结果不可用"即可。升级路径保留。
- _允许 Date 走 toJSON_：隐式序列化是"魔法"，序列化方式一变行为悄悄变；项目原则"明确优于隐式"。

## Consequences

- (+) 超时/取消真正终止有子进程的工具（含进程树），消除"放弃等待但后台继续跑"的资源泄漏与副作用失控。
- (+) JSON 把关诚实化：NaN/Infinity/Map/循环引用不再静默损坏，防"模型拿到 `{}` 空壳数据"。
- (+) executor 总闸独立严格，为 MCP 第三方工具接入打底（第三方返回值不受 iknow 约束，这道关必须自己把严）。
- (−) 设计意图翻转：executor 从"只约束等待时长"变为"主动终止"，工具契约随之变化（有子进程工具必须监听停止信号）——所有工具实现与测试需同步。
- (−) "杀不了的就丢弃"意味着纯本地操作被取消时结果丢失——可接受（这类操作本身瞬时，且 in-flight closeout 语义已定取消时填 `execution_failed`）。
- (−) 被拒后提示文字方案对"有 bug 的工具"偏宽容，可能掩盖 bug——留了升级路径（改判失败）作未来议题。

**Evidence pointers**:

- GH issue #140 B-1 / B-2 决议评论（2026-08-04）。
- `src/harness/tools/executor.ts:38-48`（isJsonCompatible 现状）/ `:86-103`（timeout/cancel 现状）/ `:93`（被推翻的设计意图注释）。
- 参照：`tools/bash_tool.py:55-100`（wait_for → SIGTERM → 2s → SIGKILL，仅杀一层）；iknow 补进程树 kill。
- CONTEXT.md `cancelKind` 四值枚举 + `in-flight closeout` 语义（停止原因区分沿用，不新发明）。
- 关联 ADR：0004（工具集）/ 0006（封顶策略——契约 X 的执行主体即本 ADR 的 executor）。
