# 0091. 单 call 工具超时不是回合 timeout

Date: 2026-09-13
Status: accepted

## Context

ACI default 档（30s）到点时，executor 对该**一条**调用返回 `execution_failed` + `"timeout"`（ADR-0005 仍成立）。`computeToolStopFlags`（`src/harness/loop-engine.ts`）得判本次 tool 阶段是否触发 cancelled / timeout 来决定 loop 走向。旧判据是 `results.some(message === "timeout")` —— 一票否决把「慢 `grep`」变成整场会话失败，同波成功的只读 bash 跟着作废（既有 trace 里可见该形态：一波两条 `grep` error + 一条 `bash` ok，session 根记录落 `error.type: "timeout"`）。单 call 超时的用户可见面是该条 tool_result 错误，不是会话死。

## Decision

`StopReason: timeout` 只在外层 `AbortSignal` 已 abort、且 cancelled 未抢先时成立。单 call 工具超时不升格。同波其它 call 的成功 `tool_result` 必须交给模型继续。

回合/宿主钟 abort 在 `signal.reason` 上的标记常量为 `TURN_CLOCK_ABORT_REASON = "turn-timeout"`（从旧字面 `"timeout"` 改名而来 —— 避免与每 call 的 `"timeout"` 失败标签、以及与既有 `StopReason: timeout` 字面相撞；严格 equal，不允许 substring / prefix 优化）。`computeToolStopFlags` 仅在 `opts.signal?.reason === TURN_CLOCK_ABORT_REASON` 且 `signal.aborted === true` 时把 `timedOut` 置真；其它 abort（包括 caller 主动 cancel）一律走 `cancelled` 路径。

## Why not

**Why not 沿用 `"timeout"` 字面：** 与 per-call 的 `execution_failed` + `"timeout"` 同字，与 `StopReason: timeout` 同字；任何 substring / prefix 比较都会把单 call 超时或模型命中字面回误吞成回合 timeout。改名是最便宜的解，且不丢 `StopReason: timeout` 的控制流（`StopReason` 仍是 `"timeout"`，常量是 `signal.reason` 标记，二者不一处）。

**Why not 让单 call 超时也升格为回合 timeout：** 用户可见面错位；并行波里成功的工具结果被浪费；超时档（30s）离真正的「整场卡死」太近，长跑工作动辄被打死。

**Why not 把判定扩到任何 `signal.aborted === true`：** 取消语义被时钟 abort 吞掉，「取消」与「时钟到点」在 trace 上不可区分。

## Consequences

- (+) 单 call 工具超时只失败该条 tool_result（仍为 `execution_failed` + `"timeout"`，ADR-0005 不变）；同波其它调用继续。
- (+) 回合时钟 abort 与 caller cancel 在 trace 与控制流上各占一条独立路径。
- (−) `TURN_CLOCK_ABORT_REASON` 的字面与 `StopReason: timeout` 的字面分家；任何对 `signal.reason` 的 substring / prefix 比较都视为 bug（peer 修改常量值的同时也修了 SC16 单测的对接锚，从 `"timeout"` 改到 `"turn-timeout"`）。

## Status of the turn-clock producer

工具阶段当前**没有**真正的回合/宿主钟 producer：`computeToolStopFlags` 的 `timedOut === true` 现在只可能来自测试接缝（`tests/harness/aci/interrupt-routing.test.ts` 的 SC16/ADR-0091 单测直接 `controller.abort("turn-timeout")`）。未来 host / turn 时钟 producer 接入时，必须以 `signal.reason === "turn-timeout"` 的 `AbortSignal` 形态 abort，与现有锚同字面，**不要**复用 `"timeout"` 字面以免重回同名歧义。本 ADR 不为那个 producer 开票。
