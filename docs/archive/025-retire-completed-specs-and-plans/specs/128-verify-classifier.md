> **ARCHIVED 2026-08-20.** Superseded by `specs/verify-goal-gate.md`. Do not implement from this file.

# Spec: 128 — verify 分类器（子代理 LLM 判官，填空 command 缺失）

> 来源：wayfinder 地图 #128 验证闭环 · 本 session（2026-08-13/14）grilling D1–D8 operator 逐条确认（见 git log `128-verify-loop` 分支讨论）
> 假设闸门：8 条（A1–A8）已于 2026-08-14 经 operator 确认（"同意"）
> 前置：`specs/128-auto-correction-loop.md`（闭环引擎本体，本 spec 不重复其已冻结契约）、`specs/408-session-goal.md`（`session.goal.text` 是分类器 task 字段来源）

## Glossary（exact copy from docs/CONTEXT.md + 本 spec 新术语）

- **外挂自检层 (external self-check layer)**: (#128 决议 D1) orchestrator 层的 advisor 形态验证闭环——`run()` 以完成收尾后执行项目 settings 声明的验证命令，失败则把结构化错误经 `priorMessages` 注入并再次 `run()`；引擎零改动、停止语义保持冻结，与引擎自带的工具级实时纠错（第一层）互补而非替代。
- **失败签名 (failure signature)**: 单轮验证失败的归一化标识——退出码 + 失败用例名/首行错误，供停滞与趋势判定比对；只有复现过的真失败进签名序列。
- **三态判定 (tri-state verdict)**: 验证结果判定 = pass / 真失败 / 不稳定（全量挂但单跑过）；不稳定不触发修正、不静默放过，收尾报告标注；仅真失败进修正闭环与趋势判定。
- **trend-based stop（趋势判定）**: 修正轮次的控制准则——进展（失败数优于历史最好）放行 / 同签名停滞停 / 连续两轮差于最好成绩停，允许 1 轮震荡宽容；总轮数上限仅兜底。裁判是趋势不是计数器。
- **前景 / 后景 spawn**: `spawn_subagent` 的两种结果契约（#361 裁决，ADR-0014）——前景（`wait:true`，默认）= handler 同步等 worker 到终态、envelope 直接作 tool_result 返回，当回合闭环；后景（`wait:false`）= 立即返回 task_id，结果经 host 唤醒/drain 通道回传。worker 恒为独立进程。
- **分类器（classifier）**【本 spec 新术语】：command 缺失时接管"任务完成了吗"的**子代理 LLM 判官**。输入 `{ task, summary, finalText }`，输出 `{ kind, reason, evidence?, missing? }`。与命令路径互斥（二选一，见 A1）。
- **轻量模型槽位（lightweight-model slot）**【本 spec 新术语】：`settings.verify.classifierModel` 指向的模型路由 ID。代码层不硬编码具体模型；缺省解析到 `settings.llm.model`（A7）。

## Architectural Constraints（ADR 引用）

- **ADR-0011**（loop-engine stop semantics）：verify-loop 是 advisor 形态包裹 `run()`，引擎零改动、StopReason 联合冻结不新增不重排。分类器只是这个 advisor 的**另一条验证体分支**，不改变轮次模型 / 趋势判定 / maxRounds 兜底。
- **ADR-0006**（tool-output-capping）：验证输出注入前截断。分类器路径沿用同一精神：判官输出在宿主侧截断（A8）。
- **ADR-0008 / ADR-0003**（token accounting / trace placement）：verdict 轨迹落 TraceService；分类器每轮判定同样落 `VerificationRecord`（字段扩展见 Project Structure）。
- **ADR-0014**（subagent-foreground-spawn-default）：分类器以子代理 worker 进程 spawn（前景语义），**不**走 in-process 函数——进程隔离是分类器的形态承诺（A2）。
- **ADR-0015**（settings single source）：模型字面值唯一来源 = settings.json；分类器模型槽位（`classifierModel`）是 ADR-0015 的扩展，不开新配置口。
- **冻结契约**：`run()` 停止语义不改；验证命令（已配时）走 sandbox bwrap 执行（#128 既有）；分类器路径的 bwrap exec 信任边界与 `verify.command` **对称**（同一 sandbox 层，不单独放宽）。

## Objective

修复 #128 的 SC7 透明关闭缺陷：当项目没有一条有意义的验证命令时（非代码任务 / 研究 / 写作 / 设计），`verify.command` 缺失导致整个闭环"透明关闭"（能力消失）。分类器 = command 缺失时的填空，让闭环在**没有命令的世界里也能运转**。

用户：iknow 交互面使用者（chat / tui / serve）。成功 = 未配 `verify.command` 时，闭环不再透明关闭，而是由子代理判官对任务完成度做带证据判断（A1 填空语义）。

## Tech Stack

不变：TypeScript + Node（项目既有栈）。无新依赖。分类器复用既有 sub-agent 基建（#356/#361 worker / spawn / envelope）。判官模型由 settings 槽位指向（A7），非新增运行时依赖。

## Commands

```bash
npm run typecheck      # tsc -p tsconfig.json --noEmit
npm test               # vitest：unit + harness + integration
npx vitest run tests/harness/verify   # 本模块定向（含分类器新增用例）
```

## Project Structure

```
src/harness/verify/
  verify-loop.ts        # 主循环：completed 后按 command 有无二选一
                        #   command 缺失 → 调 runClassifierOnce（新）
                        #   command 已配 → 既有 runVerifyOnce（不变）
  classifier.ts         # 【新】分类器子代理：spawn worker + 解析 + 降级规则
  inject.ts             # + 第二信封构造器 buildClassifierEnvelope
                        #   （不带 command/exitCode；带 task + missing[] + reason）
src/config/settings.ts  # verify 段 + classifierModel?: string（parse/merge/freeze 既有模式）
src/harness/verify/types.ts  # + ClassifierResult / ClassifierCheck / ClassifierVerdict
src/harness/trace/types.ts   # + VerificationRecord 扩展（classifier 分支字段：reason/evidence/missing）
src/harness/trace/noop.ts    # 同步实现新字段（接口扩展必需）
src/harness/trace/jsonl.ts   # 同步实现新字段
tests/harness/verify/        # 新增 classifier 用例（stub worker + stub 判官）
```

## Code Style

沿用项目既有风格（显式类型、纯函数优先、注释只解释 why）。分类器输出 schema（A4）：

```ts
type ClassifierCheck = {
  command: string; // 判官跑了什么验证（必填；无 command 的 check 算 skip 不算 pass）
  output?: string; // 截断后的输出（过长省略）
  result: "pass" | "fail";
};

type ClassifierResult =
  | { kind: "pass"; reason: string; evidence: ClassifierCheck[] }
  | {
      kind: "fail";
      reason: string;
      missing: string[];
      evidence: ClassifierCheck[];
    }
  | { kind: "abort"; reason: string };
```

**降级规则**：`{kind:"pass", evidence:[]}` 在 verify-loop 内部静默改写为 abort（理由补"证据缺失"），子代理 prompt 显式禁止该写法（A4 末尾）。`abort` = "判官跑完了但判不了"，不是任务失败。

分类器失败信封（A8，区别于 command 路径）：

```
[VALIDATION FAILED] attempt=2/12 verdict=true-failure source=classifier
task: <goal.text>
missing: ["部署到 staging", "迁移脚本"]
reason: <判官的一句话立论>
Fix the failures above. Do not claim completion until validation passes.
```

（无 command / exit_code / failed_count / signature —— 那些是命令路径字段。）

## Testing Strategy

vitest，落 `tests/harness/verify/`。stub worker 做确定性替身（spawn 返回固定 envelope / 假判官 / 假 transport 错）。覆盖项目测试规范六类：

| 层          | 内容                                                                                                                                                                                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | classifier.ts 纯函数：schema 解析、pass 空 evidence 降级、missing 仅 fail、输出截断 2000 chars 具名测试                                                                                                                                                                     |
| integration | verify-loop + stub worker：A1 二选一（command 配了走命令、command 缺失走分类器）、触发时机 completed-only、fail→信封继续、abort/transport/schema→unstable、maxRounds 兜底                                                                                                   |
| 边界        | 判官 JSON 残缺（解析降级→unstable）、transport 错（spawn fail→unstable）、goal 空 text→query fallback（沿用 408）、**并发/中断**：分类器 spawn 后在飞时用户 abort → 终止闭环（不等待 worker 回包，closeout 不残留）；两轮间无并发窗口（每轮至多一个分类器在飞，await 串行） |

> **并发不变量论证**：verify-loop 是串行循环（`run() → verify → 信封 → run() await`），每轮**至多一个**分类器在飞。两轮间不存在竞态窗口。**abort 与分类器在飞并存**是唯一并发维度：用户在分类器等待 worker 回包时按 Ctrl+C，闭环须立即停止，不等待 worker 回包，in-flight closeout 不残留 stale 信封。测试：`tests/harness/verify/classifier-abort.test.ts` stub worker 延迟响应，abort 中断 → 闭环 outcome=aborted，message 历史无 stale 注入。 |

## Boundaries

- **Always do**：分类器走子代理进程隔离（不 in-process）；判官 JSON 宿主侧截断（A8）；abort/error→unstable 不静默放行；每轮判定落 TraceService；测试先行。
- **Ask first**：`settings.verify.classifierModel` 字段命名终稿；`VerificationRecord` 分类器分支字段命名；`buildClassifierEnvelope` 信封文本格式。
- **Never do**：command 已配时双跑分类器（A1，路径 X 独占）；分类器写 `goal.text`（408 spec Never: 判官写 status 不写 text）；分类器伪造 tool_use / 伪造命令证据（prompt 层 + 降级规则双防护）；动 Loop Engine 停止语义 / StopReason 联合；裸 spawn 绕过沙箱；删改既有测试。

## Success Criteria（binary，每条映射可执行检查）

> Check 均为**实施后**验收命令（对照 `specs/408-session-goal.md` SC1 先例）：实施前代码不存在属预期，不阻塞 spec 通过；实施后逐条执行作为 merge gate。grep 无命中的 SC（如 SC7 无硬编码模型 ID）以"反向断言无命中"为通过。

1. **A1 填空**：command 缺失 → completed 后 spawn 分类器；command 已配 → 只走命令，分类器不 spawn。**Check**: `grep -n "runClassifierOnce" src/harness/verify/verify-loop.ts`（command-absent 分支存在）。✅/❌
2. **形态 B3**：分类器以独立 worker 进程 spawn（非 in-process 函数），envelope 走 sub-agent channel。**Check**: `grep -rn "spawnSubAgent\|subagent" src/harness/verify/classifier.ts`。✅/❌
3. **输入三字段**：worker 收到 `{ task: goal.text ?? query, summary, finalText }`，无 toolCalls / 无 signature。**Check**: `tests/harness/verify/classifier-input.test.ts` 断言 prompt 含 task/summary/finalText 且不含 toolCalls/signature。✅/❌
4. **输出 schema**：判官输出解析成 `{kind, reason, evidence?, missing?}`；pass 必有非空 evidence；`{kind:"pass", evidence:[]}` 静默改写为 abort。**Check**: `grep -n "\"pass\"\|evidence\|missing" src/harness/verify/types.ts && tests/harness/verify/classifier.test.ts`。✅/❌
5. **失败语义**：fail → 注入 classifier 信封继续（trend / maxRounds 兜底）；abort / transport 错 / schema 错 → 停 + unstable。**Check**: `tests/harness/verify/classifier-loop.test.ts`（stub worker 三态 → 三处置断言）。✅/❌
6. **触发时机**：仅 StopReason=completed 触发；maxTurns/cancelled/timeout 原样透传不触发（沿用 408/128 假设 B9）。**Check**: `grep -n "stopReason" src/harness/verify/verify-loop.ts`（completed-only 分支存在）。✅/❌
7. **模型槽位**：`settings.verify.classifierModel` 显式时用其值；缺省解析到 `settings.llm.model`；代码层无硬编码模型 ID。**Check**: `grep -n "classifierModel" src/config/settings.ts && grep -rn "claude-haiku\|claude-opus\|deepseek\|gpt-4" src/harness/verify/`（**无命中**）。✅/❌
8. **宿主侧截断**：判官 JSON 宿主侧 `truncateByCodePoint` 至 2000 chars；prompt 不写长度（对齐 128 的 sandbox stdout 20000 截断纪律，A8）。**Check**: `grep -n "2000\|truncateByCodePoint" src/harness/verify/classifier.ts`。✅/❌
9. **SC7 修正**：未配 `verify.command` 时闭环**不再透明关闭**（对照 128 spec SC7 废除新语义）——分类器路径行为 ≠ 裸 run 逐字节一致。**Check**: `tests/harness/verify/classifier-sc7.test.ts`（对照 128 spec SC7 回归语义反转：未配 command → 分类器跑，非逐字节一致）。✅/❌
10. **每轮判定落 Trace**：分类器每轮写 `VerificationRecord`，含 kind/reason/evidence/missing 字段。**Check**: `grep -n "reason\|evidence\|missing" src/harness/trace/types.ts`。✅/❌

## Open Questions

无阻塞项。Ask-first 命名（`classifierModel` / `VerificationRecord` 分支字段 / 信封文本）在 PLAN 阶段定稿即可，不阻塞 spec 通过。

## ACR Verdict（architecture-change-reviewer）

**Round 1（2026-08-14）**: `4 yes + 1 unclear`（defensive-contract-validator unclear）→ OVERALL BLOCKED。

- 4 yes: bounded-context-guardian / error-handling-enforcer / complexity-anti-drift / minimal-change-verifier
- 1 unclear: defensive-contract-validator — SC 缺命令级 Check、concurrent 维度无测试、A1–A8 缺外部确认 trail
- 整改：SC 补 10 条 Check 命令（grep / test 双重 anchor）；Testing Strategy 边界行补 concurrent/abort 中断 + 不变量论证；Assumptions 补外部确认 trail 表（PR #427 / #408 / 408 假设 B9）
  **Round 2（2026-08-14）**: `5/5 yes` → **OVERALL: PASS → hand to writing-plans**。

```
bounded-context-guardian: yes — additions confined to src/harness/verify/（classifier.ts 新增 + verify-loop.ts 单分支 + types.ts 接口扩展）、src/config/settings.ts（ADR-0015 扩展）、src/harness/trace/{types,noop,jsonl}.ts（interface only）; no reverse deps, no cross-layer slicing.
defensive-contract-validator: yes — 5 边界类全 anchor：empty（SC4 pass→abort 降级）/ negative+exception（SC4 schema + SC5 transport/schema→unstable）/ overflow（SC8 2000 chars）/ concurrent（边界行 classifier-abort.test.ts）; SC1-10 每条带可执行 Check; A1-A8 外部确认 trail 齐。
error-handling-enforcer: yes — ClassifierResult 三态联合 typed; 失败信封 fixed-shape; transport/schema/error→unstable; maxRounds 兜底 + in-flight abort closeout; goal 空 text→query fallback（408）。
complexity-anti-drift: yes — classifier.ts 单职责（spawn+parse+截断）、types.ts 仅接口扩展、verify-loop.ts 仅 1 条件分支; 6 文件 cohesive 局部改动。
minimal-change-verifier: yes — 1 logical task（填空 SC7 transparent close）; 6 文件同 commit 可行, 无混合动机。
```

## Assumptions（operator pre-confirmed 2026-08-14）

1. **A1 定位 = 填空**：command 已配时只走命令路径，分类器永不双跑（路径 X）。
2. **A2 形态 = sub-agent（B3）**：进程隔离 + 只读 + bwrap exec，信任边界与 verify.command 对称。
3. **A3 输入三字段**：`{ task: goal.text ?? query, summary, finalText }`，无 toolCalls / 无 signature。
4. **A4 输出 schema**：`{kind, reason, evidence?, missing?}`；pass 空 evidence 静默降级 abort；子代理 prompt 禁止该写法。
5. **A5 失败语义**：fail → 信封继续；abort / transport 错 / schema 错 → unstable（fail-open on transport/schema）。
6. **A6 触发时机**：仅 StopReason=completed 后，与 command 同构。
7. **A7 模型**：`settings.verify.classifierModel ?? settings.llm.model`，代码层不硬编码模型 ID。
8. **A8 截断**：判官输出宿主侧 2000 chars，prompt 不写长度。

→ 全部经 operator 显式确认（"同意"），无静默假设。

**外部确认 trail**（ACR 要求，非 spec 自述）：

| 假设                                                    | 外部真值源                                                                                                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1（填空）、A2（sub-agent）、A3（三字段）、A4（schema） | 本 session grilling 对话（`128-verify-loop` 分支 git log 讨论）+ [iknow#408](https://github.com/winter6205/iknow/issues/408)（会话级 goal = task 字段来源） |
| A5（失败语义 fail-open）、A6（触发时机 completed-only） | 本 session grilling 对话（A5/A6 逐条 operator "同意"）+ `specs/128-auto-correction-loop.md` 假设 B9（completed-only 触发）                                  |
| A7（模型槽位）                                          | 本 session grilling 对话（operator "同意：设置 configurable"）；ground truth = `settings.ts` ADR-0015 扩展                                                  |
| A8（截断宿主侧 2000）                                   | 本 session grilling 对话（operator "同意"）+ ADR-0006 截断纪律先例                                                                                          |
| session.goal.text 绑定                                  | PR #427（merged，T4）——`hub.ts` userText = `goal.text ?? query` 已落地                                                                                      |

> 注：本 spec 处于**架构决策阶段**（无代码改动），grilling 确认即假设闸门证据；实施后的 merge gate 以 SC Check 为准。
