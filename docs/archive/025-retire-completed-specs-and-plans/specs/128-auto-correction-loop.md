# Spec: 失败自动修正闭环（外挂自检层）

> 来源：wayfinder 地图 [wayfinder:map] ⑤ 评估闭环 (#116) · 票 #128 resolution（D1–D7，2026-08-12 operator 确认）
> 假设闸门：14 条假设（A 组 5 查证 + B 组 8 确认）已于 2026-08-12 经 operator 最终确认

## Glossary（exact copy from docs/CONTEXT.md）

- **外挂自检层 (external self-check layer)**: (#128 决议 D1) orchestrator 层的 advisor 形态验证闭环——`run()` 以完成收尾后执行项目 settings 声明的验证命令，失败则把结构化错误经 `priorMessages` 注入并再次 `run()`；引擎零改动、停止语义保持冻结，与引擎自带的工具级实时纠错（第一层）互补而非替代。
- **失败签名 (failure signature)**: 单轮验证失败的归一化标识——退出码 + 失败用例名/首行错误，供停滞与趋势判定比对；只有复现过的真失败进签名序列。
- **三态判定 (tri-state verdict)**: 验证结果判定 = pass / 真失败 / 不稳定（全量挂但单跑过）；不稳定不触发修正、不静默放过，收尾报告标注；仅真失败进修正闭环与趋势判定。
- **确认阶梯 (confirmation ladder)**: 失败采信前的两级确认——全量复跑一次 → 失败用例单跑（可选复跑模板配置）；每级至多一次不递归，全过才判 flaky，全不过才判真失败。
- **趋势判定 (trend-based stop)**: 修正轮次的控制准则——进展（失败数优于历史最好）放行 / 同签名停滞停 / 连续两轮差于最好成绩停，允许 1 轮震荡宽容；总轮数上限仅兜底。裁判是趋势不是计数器。
- **escalate 模式**: 修正耗尽后的可选处置（默认 report 停止+如实报告）——注入升级指令（禁止重复同一修复、换思路或明确报告阻塞）并给新预算继续；总预算不重置。
- 关联既有条目：**StopReason**（七类冻结联合，本 spec 不新增）、**append-only messages**（注入只追加）、**host drain**（priorMessages 注入先例）。

## Architectural Constraints（ADR 引用）

- **ADR-0006**：验证输出注入前截断，沿用 20000 字符封顶精神。
- **ADR-0013**：修正轮上下文膨胀走既有 reactive compact，不另建上下文管理。
- **ADR-0015**：验证配置落 `settings.json` 单承载（扩 `verify` 段），不开新配置口。
- **ADR-0003 / ADR-0008**：verdict 轨迹落 TraceService（观测真值落点）；不进 LoopTrace（payload 禁令区）。
- **冻结契约**：StopReason 联合不新增不重排；`run()` 停止语义不改——闭环全部在 orchestrator 层（D1 advisor 形态）。
- **轮间执行 parent 语义**（ACR 裁决）：验证命令在两次 run() 之间执行、无当轮 turn；`SandboxCmdRecord.parentTurnId` 挂**触发本轮验证的 completed turn id**（上一轮 run 的最后回合）；`VerificationRecord` 以自有 id 关联整条验证轨迹，不依赖 turn 树。

## Objective

构建任务级自动修正闭环：模型声称完成后，系统自动跑项目声明的验证命令；真失败则把结构化错误注入对话历史驱动模型修正，趋势判定控制轮次，直至通过或按规则停止并如实报告。

用户：iknow 交互面使用者（chat / tui / serve）。成功 = ch07 验收原文："任务完成有可量化通过标准；失败能被系统自动捕获并修正。"

## Tech Stack

不变：TypeScript + Node（项目既有栈）。无新依赖。新增代码为纯 TS 模块 + vitest 测试。任何栈变更需重开假设闸门。

## Commands

```bash
npm run typecheck      # tsc -p tsconfig.json --noEmit
npm test               # vitest：unit + harness + integration
npx vitest run tests/harness/verify   # 本模块定向
```

## Project Structure

```
src/harness/sandbox/runner.ts  # 【前置 refactor】从 aci/tools/bash.ts 抽取的沙箱公共执行体
                               # （spawn + 超时 + 输出捕获），bash 工具与 verify 共同消费——
                               # 消除 verify → ACI 装饰层的反向依赖
src/harness/verify/            # 新模块：闭环 orchestrator（advisor 层）
  verify-loop.ts               # 闭环主循环：run() 包裹 + 轮次控制 + escalate
  verdict.ts                   # 三态判定 + 确认阶梯 + 失败签名 + 趋势判定（纯函数）
  inject.ts                    # 注入信封构造 + 截断
  types.ts                     # VerificationRecord / VerifyConfig / Verdict
src/config/settings.ts         # 扩 verify 段（parse/merge/freeze 既有模式）
src/harness/trace/types.ts     # + VerificationRecord 记录类型（jsonl sink 同构扩展）
src/harness/trace/noop.ts      # 同步实现新方法（接口扩展必需，否则 tsc 不过）
src/harness/trace/jsonl.ts     # 同步实现新方法
docs/architecture.md           # Capability modules 表入 verify 条目（SSOT 要求）
tests/harness/verify/          # 测试落点
```

## Commit 排序（ACR minimal-change 裁决）

1. **commit 1**：沙箱执行体抽取至 `src/harness/sandbox/runner.ts`，`aci/tools/bash.ts` 改为消费它——**no-behavior-change refactor**，既有 bash 测试全绿为验收。
2. **commit 2**：verify 模块 + settings `verify` 段 + TraceService 记录类型（types/noop/jsonl 三处同步）+ `docs/architecture.md` 入表 + chat/tui/serve 装配接入。

消费面：chat / tui / serve 装配点把裸 `run()` 调用替换为 verify-loop 包裹（`ask` 不接入——假设 B6）。验证命令经 `sandbox/runner.ts` 在 bwrap 沙箱执行（假设 B7），经 SandboxCmdRecord 落盘；验证命令沿用 bash 工具的 fsPolicy / 资源限额，不单独放宽（Ask-first 项就此关闭）。

## Code Style

沿用项目既有风格（显式类型、纯函数优先、注释只解释 why）。注入信封示例——固定英文标记、机器格式、不伪装人类（D2 / 假设 B8）：

```
[VALIDATION FAILED] attempt=2/12 verdict=true-failure
command: npm test
exit_code: 1
failed_count: 3
signature: exit=1|tests/auth.test.ts:login rejects bad token
output_excerpt:
<截断后的失败输出，≤ 20000 字符>
Fix the failures above. Do not claim completion until validation passes.
```

escalate 指令为系统固定模板（假设 B10），核心语义："N attempts with the same approach failed. Do not repeat the same fix — re-read the task and take a different approach, or report the blocker explicitly."

## Testing Strategy

vitest，落 `tests/harness/verify/`。stub model 做确定性替身（演"第一次做错、看到错误后改对"）。覆盖项目测试规范六类：

| 层          | 内容                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit        | verdict.ts 纯函数：三态判定、确认阶梯、签名归一、趋势判定（进展/停滞/退化/震荡宽容各一例）；inject.ts 截断上限具名测试 `truncates output excerpt at 20000 chars` |
| integration | verify-loop + stub model + stub 验证命令：8 条验收标准逐条成测试                                                                                                 |
| 边界        | 空输出、解析不出失败数（退化签名比对）、验证命令超时、abort 中断、未配置透明关闭、exec 启动失败（ENOENT/沙箱拒绝 → exit=127 → 落真失败分支）                     |

## Boundaries

- **Always do**：验证命令走沙箱执行；注入只追加（append-only）；停止时如实报告；每轮判定落 TraceService；测试先行。
- **Ask first**：settings schema 扩字段命名终稿；TraceService 记录类型命名。
- **Never do**：动 Loop Engine 停止语义 / StopReason 联合；注入伪造 tool_use 配对；验证未通过判"完成"（降级放行）；确认复跑递归；裸 spawn 绕过沙箱；删改既有测试。

## Success Criteria（binary，D7 八条 + 假设闸门落点）

1. stub 场景"先错后对"：闭环零人工干预走通 完成→验证失败→注入→修正→复验通过→判完成。✅/❌
2. 捕获无漏网：配置验证命令时，最终验证为真失败/不稳定的任务**永不**获得"完成"判定。✅/❌
3. flaky（全量复跑通过）不触发任何修正轮。✅/❌
4. 套件干扰（单跑通过）判"不稳定"：不修正、收尾报告含标注。✅/❌
5. 趋势判定三规则各自可触发：同签名连续两轮→停；连续两轮差于最好成绩→停；失败数递减→继续放行。✅/❌
6. 耗尽处置：report 模式停止且报告含轮数+最终输出；escalate 模式注入升级指令且总预算不重置；兜底上限（默认 12 轮）生效。✅/❌
7. 未配 `verify.command`：行为与现状逐字节一致（回归测试对比）。✅/❌
8. 每轮判定写 TraceService VerificationRecord，字段含轮次/三态/签名/趋势/终态。✅/❌
9. 仅 StopReason=completed 触发验证；maxTurns/cancelled/timeout 不触发（假设 B9）。✅/❌
10. 验证命令超时（默认 600s，可配）判"不稳定"不判"真失败"（假设 B13）。✅/❌
11. 用户 abort 终止整个闭环，消息历史符合 in-flight closeout 语义（假设 B12）。✅/❌

## Open Questions

无阻塞项。两处 Ask-first 命名（settings 字段 / 记录类型名）在 PLAN 阶段定稿即可，不阻塞 spec 通过。

## ACR Verdict（architecture-change-reviewer，2026-08-12 第二轮复审 PASS）

```
bounded-context-guardian: yes — spec:46-48/64 抽取沙箱 runner 至 src/harness/sandbox/runner.ts，verify/ 与 bash.ts 同向依赖 sandbox 基础层（无 orchestrator→ACI 反向依赖）；spec:23 裁决 SandboxCmdRecord.parentTurnId 语义（对照 trace/types.ts:155 真实字段）。
defensive-contract-validator: yes — spec:94 枚举空输出 / 失败数解析不出 / 超时 / abort（concurrent-interrupt）/ 未配置 / ENOENT(exit=127)；overflow 由 ADR-0006 20000 字符封顶（spec:18/80，inject.ts 承载，具名单元测试已列）。
error-handling-enforcer: yes — 全失败路径类型化：三态 Verdict / 超时→不稳定 / abort→in-flight closeout / exec 失败→exit=127→真失败 / 耗尽→report|escalate 且总预算不重置 / StopReason 冻结。
complexity-anti-drift: yes — 四文件单职责拆分，verdict.ts 纯函数，runner 抽取缩小 bash.ts；无函数/文件形状威胁 ≤10 CC / ≤500 行阈值。
minimal-change-verifier: yes — 单一逻辑任务，文件清单完整（含 noop.ts / jsonl.ts / docs/architecture.md），2-commit 序列明确（commit 1 = no-behavior-change refactor，以既有 bash 测试全绿验收）。
```

OVERALL: PASS → hand off to writing-plans。
