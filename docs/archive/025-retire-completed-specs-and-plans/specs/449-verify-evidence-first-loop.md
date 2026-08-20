> **ARCHIVED 2026-08-20.** Superseded by `specs/verify-goal-gate.md`. Do not implement from this file.

# Spec: 449b — verify 闭环重构：证据优先编排 + 补跑信封 + 证据感知只读判官（unverified 四态）

> 来源：#449 map——G1 #450（判官输入 = task + 主会话执行证据文本，只读）/ G2 #451（不足→先补跑再判官）/ G3 #452（command 降级可选覆盖 + 零配置默认 = 证据优先 + D2 探测）/ G5 #454（unverified 四态 / unstable 映射 / task 不重绑 + evidenceContext / 信封策略三分）；消费 SPEC `449-evidence-checker`（verdict 契约）+ SPEC `468-subagent-judge-tool-surface`（判官只读前提）+ SPEC `458-goal-lifecycle-taskfocus`（task 公式数据侧）。
> 本 spec 是"把整个验证循环重构"的主体：把 master 现状「settings 配 command → 沙箱重跑 / command 缺失 → 判官盲查」的 **A/B 二选一模型**，重构为「**证据优先 → 补跑 → 证据感知判官兜底**」的三级判定流。
> 假设闸门：operator 已授权"自己决策、自己审完写好"（delegated assumption confirmation）。

## Glossary（exact copy from docs/CONTEXT.md + 决议新术语）

- **外挂自检层 (external self-check layer)**: (#128 决议 D1) orchestrator 层的 advisor 形态验证闭环——`run()` 以完成收尾后执行验证，失败则把结构化错误经 `priorMessages` 注入并再次 `run()`；引擎零改动、停止语义保持冻结。本 spec 保持 advisor 形态与 StopReason=completed 触发不变，重构的是**判定段内部**。
- **三态判定 (tri-state verdict)**: 验证结果判定 = pass / 真失败 / 不稳定（全量挂但单跑过）；不稳定不触发修正、不静默放过。本 spec 新增的判官 `unverified` 态**映射到 unstable**（G5-2），沿用其"停止、结果原样返回用户"语义。
- **失败签名 (failure signature)**: 单轮验证失败的归一化标识。命令路径沿用；证据路径的 signature = checker reasons 归一化。
- **趋势判定 (trend-based stop)** / **确认阶梯 (confirmation ladder)** / **escalate 模式**：命令路径既有机制，本 spec 对命令路径**不改**。
- **evidenceContext（证据体检单，G5-3 决议术语）**：判官输入信封附加字段 = checker verdict + 不足原因 + 已执行测试命令列表 + 补跑尝试结果 + 原始证据摘要（bash 调用/exit code/测试输出/diff 摘要）。判官据此知道"差什么"，task 字段不重绑。
- **补跑信封（G5-4 决议术语）**：`EVIDENCE_INSUFFICIENT` 时注入主会话的反馈信封——"你声称完成，但缺真实测试证据 + 原因 + 请跑 <测试命令> 并展示框架通过摘要"；命令来源 = 用户 `verify.command` 优先，否则 D2 探测（G3）。
- **unverified（G5-1 决议术语）**：判官第 4 态——判官工作正常，但读完证据后认为证据不足以判定完成，拒绝猜 PASS/FAIL。与 `abort`（判官自身故障：transport/schema/超时）严格区分。

## Architectural Constraints（ADR 引用）

- **ADR-0011**（loop-engine stop semantics）：verify-loop 仍是 advisor 包裹 `run()`；StopReason 联合冻结；仅 completed 触发判定（`verify-loop.ts:597` 既有 gate 不动）。
- **ADR-0014**（subagent-foreground-spawn-default）：判官仍走子代理 worker 进程 spawn（前景语义）；只读能力由 SPEC 468 的 worker 裁剪保证（本 spec 依赖其落地，JUDGE_ROLE 声明不变）。
- **ADR-0006**（tool-output-capping）：evidenceContext 摘要与判官输出沿用宿主侧截断纪律（判官输出 2000 chars 既有；evidenceContext 注入前截断，上限 PLAN 定，建议 ≤ 20000 codepoints 对齐信封纪律）。
- **ADR-0003 / ADR-0008**（trace placement）：`VerificationRecord` 扩展 `gamingSignals` / `evidenceVerdict` / `reason: "unverified"|"abort"` 区分字段；落 TraceService，不另起账本。
- **ADR-0015**（settings single source）：`verify.command` 语义降级为"可选补跑/强制重跑覆盖"，字段本身不删不改名（G3）；不开新配置口。
- **冻结契约**：`run()` 停止语义不改；命令路径（command 已配 **且** 证据不足时）的沙箱重跑链路不改（bwrap fence / 确认阶梯 / 趋势裁判原样）；`buildNextPriorMessages` 的 append-only 信封注入模式不改。

## Objective

重构 verify-loop 判定段的控制流。master 现状（explorer 实证）：`runVerifyLoop`（`verify-loop.ts:786-835`）按 `command` 有无二选一——有 → 命令路径（沙箱重跑 + 确认阶梯 + 趋势裁判）；无 → 分类器盲查（且判官实际只拿到 task，`summary`/`finalText` 未进 worker def，disallowedTools 未消费）。

重构后三级判定流（主会话 completed 后）：

1. **证据优先**（零配置默认，G3）：调 `checkEvidence(messages)`（SPEC 449a）。
   - `EVIDENCE_SUFFICIENT` → 直接 PASS，**不重跑**（即使配了 command，G3 决议）。
   - `EVIDENCE_CONTRADICTED` → 走失败信封（附 evidenceContext 摘要）继续修正轮（命令路径语义）。
   - `EVIDENCE_INSUFFICIENT` → 进第 2 级。
2. **补跑**（G2-3 先补跑）：命令 = 用户 `verify.command` 优先，否则 `probeVerifyCommand`（SPEC 449a D2）。
   - 有命令可跑 → 注入补跑信封给主会话（"请跑 <命令> 并展示框架通过摘要"）→ 再次 `run()` → 回到第 1 级核对补跑产生的新证据（至多 1 次补跑轮，防无限循环）。
   - 无可跑命令（探测失败 / 补跑后仍不足）→ 进第 3 级。
3. **证据感知只读判官**（G1 A / G5 兜底）：喂 `task`（#459 公式原样）+ `evidenceContext`（G5-3 体检单）；输出四态 pass / fail / unverified / abort：
   - `pass` → PASS；`fail` → 失败信封（reason/missing + evidenceContext 摘要）继续修正轮。
   - `unverified` / `abort` → **不注入信封**，outcome = `unstable`，停止，结果原样返回用户（G5-2 fail-open 停法）；`VerificationRecord.reason` 写 `unverified`/`abort` 区分。

命令路径的既有角色重定位（G3）：`verify.command` 从"唯一激活验证的钥匙"降级为补跑/强制重跑的可选覆盖；证据充分时永不重跑。

用户：iknow 交互面使用者。成功 = 证据扎实的 completed 零 LLM 成本直接 PASS；证据不足先给补跑机会；判官只在兜底时启用且只读、带证据、可弃权；拿不准永不 PASS。

## Tech Stack

不变：TypeScript + Node（ESM，tsc strict）。无新依赖。判官复用既有 sub-agent 基建（SPEC 468 落地后其只读面才真实成立）。

## Commands

```bash
npm run typecheck
npm test
npx vitest run tests/harness/verify     # 本模块定向（含既有命令路径回归）
npm run lint
```

## Project Structure

```
src/harness/verify/verify-loop.ts        # 判定段重构：三级流接线（checkEvidence → 补跑 → 判官）；
                                         #   produceObservation 缝（:610）接入 checker；
                                         #   runClassifierLoop 升级为证据感知（task 公式 + evidenceContext）
src/harness/verify/run-classifier-adapter.ts  # SubAgentDefinition 带上 evidenceContext（进判官输入）；
                                         #   JUDGE_ROLE 声明不变（只读由 SPEC 468 worker 裁剪落地）
src/harness/verify/inject.ts             # + buildEvidenceRerunEnvelope（补跑信封）；
                                         #   buildClassifierEnvelope 扩展 evidenceContext 摘要槽
src/harness/verify/types.ts              # VerifyLoopOutcome 不加新态（unverified→unstable，G5-2）；
                                         # VerificationRecord + evidenceVerdict/gamingSignals/reason 区分
src/harness/verify/index.ts              # barrel 同步（仅必要导出）
src/session-api/hub.ts                   # userText 接线 #459 公式（goal.text ?? taskFocus.text ?? query，
                                         #   依赖 SPEC 458 数据侧）；chat-session.ts 同缝对齐
src/harness/trace/{types,jsonl,noop}.ts  # VerificationRecord 新字段双实现
tests/harness/verify/                    # + 三级流集成用例（stub runFn + stub 判官 + trace 双轨）
```

## Code Style

沿用既有风格。三级流接线示意（缝在 `runVerifyLoopBody` 的 `produceObservation`，R3 明示插入点）：

```ts
// 判定段主流程（伪代码，落点 verify-loop.ts:610 produceObservation）
const report = checkEvidence({ messages: current.result.messages, claimIndex: ... });
switch (report.verdict) {
  case "EVIDENCE_SUFFICIENT":
    return passObservation();                       // 零 LLM 成本，即使配了 command（G3）
  case "EVIDENCE_CONTRADICTED":
    return failObservation(withEvidenceContext(report)); // 走修正轮
  case "EVIDENCE_INSUFFICIENT":
    if (rerunAttempts < 1 && (config.command || probed)) {
      return rerunEnvelope(buildEvidenceRerunEnvelope({ report, command: config.command ?? probed }));
    }
    return judgeObservation(await runEvidenceAwareJudge({ task, evidenceContext: toContext(report) }));
}

// 判官四态映射（G5）
// pass → pass | fail → 修正轮信封 | unverified → unstable(不注入) | abort → unstable(不注入)
```

**checker 三态 → 闭环 Verdict 映射**（ACR caveat：证据分支进 trend/decideRoundAction 前必须先落回既有 `Verdict` 联合）：`EVIDENCE_SUFFICIENT` → `"pass"`；`EVIDENCE_CONTRADICTED` → `"true-failure"`（进修正轮，趋势/签名机制原样消费）；判官 `unverified`/`abort` → `"unstable"`（不进 trend，直接 stop 语义）。补跑信封轮不产 verdict（注入后 continue，下一轮重新核对证据）。

`evidenceContext` 形状（G5-3，spec 阶段定稿）：

```ts
export interface EvidenceContext {
  readonly checkerVerdict: EvidenceVerdict;
  readonly reasons: ReadonlyArray<string>;
  readonly executedCommands: ReadonlyArray<string>;
  readonly rerunAttempted: boolean;
  readonly evidenceSummary: string; // bash 调用/exit code/测试输出摘要，宿主侧截断
}
```

task 公式接线（hub.ts:721-724 现状 `goal.text ?? query` 升级）：

```ts
userText: session.goal?.text || session.taskFocus?.text || query; // #459 公式，判定层只读
```

## Testing Strategy

vitest，落 `tests/harness/verify/`。stub runFn + stub 判官做确定性替身。**trace 双轨 assert**（项目规范：trace-based + NoopTraceService-vs-no-trace deepEqual 基线）。覆盖六类：

| 层           | 内容                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常         | 证据充分 → 直接 PASS（零判官 spawn）；证据不足 + 有 command → 补跑信封注入 → 补跑绿 → PASS；证据不足 + 无 command + 判官 pass → PASS；判官 fail → 修正信封继续。              |
| 失败         | 判官 unverified → unstable 停、**不注入信封**、reason="unverified"；判官 abort（transport/schema/超时）→ unstable 停、reason="abort"；CONTRADICTED → 修正轮。                 |
| 边界         | 配了 command 但证据充分 → **不重跑**（G3）；补跑至多 1 次（第 2 次不足直接落判官）；探测失败 + 无 command → 直接判官；compact 后证据缺失 → INSUFFICIENT → 补跑不可用 → 判官。 |
| 空/非法输入  | 判官返回畸形 JSON → 按既有 parseClassifierResult 降级 abort → unstable；evidenceContext 为空对象 → 判官仍可跑。                                                               |
| 权限         | 判官只读：断言判官 worker 的工具面不含 bash/edit_file/write_file/web_fetch/web_search（依赖 SPEC 468 的裁剪测试，本 spec 在集成层复断言）。                                   |
| 并发/中断    | 补跑信封注入后用户 abort → 闭环即停、closeout 不残留 stale 信封（沿用 classifier-abort 测试模式）；每轮至多一个判官在飞（await 串行，既有不变量论证沿用）。                   |
| 命令路径回归 | command 已配 **且** 证据不足时，沙箱重跑 + 确认阶梯 + 趋势裁判行为与 master 一致（既有测试全绿，不许为重构删改）。                                                            |

## Boundaries

- **Always do**：证据优先于一切判定（SUFFICIENT 永不重跑）；判官 task 用 #459 公式原样、不重绑（上下文走 evidenceContext）；unverified/abort 不注入信封直接 unstable 停；补跑至多 1 次；每轮判定落 TraceService；命令路径回归测试先行锁定再重构。
- **Ask first**：`EvidenceContext` 字段命名终稿；补跑信封文案终稿；evidenceContext 截断上限（建议 ≤ 20000 codepoints）。
- **Never do**：给判官执行能力（G1 明示只读；B/C 选项已被决议否决）；把 unverified 猜成 pass 或 fail（"a verifier that bluffs is worse than none"）；证据充分时因配了 command 而重跑（G3 明文）；task 字段塞证据上下文（G5-3 明文走 evidenceContext）；动 StopReason 联合 / `run()` 停止语义；删改命令路径既有测试。

## Success Criteria（binary，每条映射可执行检查）

1. **三级流接线**：produceObservation 缝调用 `checkEvidence`，三态各有独立处置分支。**Check**: `grep -n "checkEvidence" src/harness/verify/verify-loop.ts` + 三态集成用例。✅/❌
2. **SUFFICIENT 零成本 PASS**：证据充分时不 spawn 判官、不跑 command。**Check**: 集成测试断言判官 spawn 计数 = 0 且 outcome=passed。✅/❌
3. **配 command 不重跑**：证据充分 + `verify.command` 已配 → 仍直接 PASS。**Check**: 专项用例断言 sandbox 执行计数 = 0。✅/❌
4. **补跑信封**：INSUFFICIENT + 有可跑命令 → 注入补跑信封（含命令 + "展示框架通过摘要"指令）；补跑至多 1 次。**Check**: `grep -n "buildEvidenceRerunEnvelope" src/harness/verify/inject.ts` + 补跑轮次上限用例。✅/❌
5. **task 公式接线**：hub + chat-session 的 `userText` = `goal.text ?? taskFocus.text ?? query`。**Check**: `grep -n "taskFocus" src/session-api/hub.ts src/cli/chat-session.ts` + 三段 fallback 集成用例。✅/❌
6. **判官输入升级**：判官 def 携带 evidenceContext（checker verdict + reasons + 命令清单 + 补跑结果 + 证据摘要）；task 不重绑。**Check**: `tests/harness/verify/judge-input.test.ts` 断言 envelope 含 evidenceContext 且 task = 公式原样。✅/❌
7. **判官四态**：pass/fail/unverified/abort 解析与映射齐全；unverified ≠ abort（reason 区分落盘）。**Check**: `grep -n "unverified" src/harness/verify/types.ts` + 四态参数化用例。✅/❌
8. **unverified/abort 停法**：不注入信封、outcome=unstable、结果原样返回。**Check**: 用例断言无信封注入 + outcome + reason 字段。✅/❌
9. **只读判官**：判官 worker 工具面不含 5 项禁工具（与 SPEC 468 联动断言）。**Check**: 集成测试断言工具面。✅/❌
10. **命令路径回归**：既有命令路径测试（沙箱/阶梯/趋势）全绿，零删改。**Check**: `git diff --stat -- tests/harness/verify`（既有文件无删除行）+ `npx vitest run tests/harness/verify` exit 0。✅/❌
11. **trace 双轨**：新字段（evidenceVerdict/gamingSignals/reason）在 jsonl 与 noop 双实现；trace-based assert + no-trace deepEqual 基线齐。**Check**: `grep -n "evidenceVerdict\|gamingSignals" src/harness/trace/types.ts` + 双轨测试文件存在。✅/❌

## Open Questions

- **OQ1**：补跑信封文案终稿（G5-4 给了骨架，措辞 PLAN 定）。**v1 PLAN 定稿**（见 `plans/449-verify-evidence-first-loop.md` B1 bullet）：B5 实施时逐字落入 `buildEvidenceRerunEnvelope`。
- **OQ2**：evidenceContext 截断上限具体值（建议 ≤ 20000 codepoints）。**v1 PLAN 定稿**（见 `plans/449-verify-evidence-first-loop.md` B1 bullet）：上限 = `20_000` codepoints，常量复用 `src/harness/verify/inject.ts` 的 `DEFAULT_MAX_CHARS`。
- **OQ3**：CONTRADICTED 走修正轮后的最终 outcome 映射（真失败 vs 升级）——v1 按真失败进既有 trend/maxRounds 处置，与命令路径失败同构。不阻塞。

## Assumptions（operator delegated，逐条挂外部真值）

1. **A1 判官输入契约 = A（task + 主会话执行证据文本，只读不执行）**——CONFIRMED by G1 #450 Resolution。
2. **A2 证据不足 → 先补跑、再判官（方案乙）**——CONFIRMED by G2-3。
3. **A3 零配置默认 = 证据优先 + D2 探测；verify.command 降级为可选覆盖；证据充分不重跑**——CONFIRMED by G3 #452 Resolution。
4. **A4 判官输出加 unverified 第 4 态，与 abort 严格区分**——CONFIRMED by G5-1。
5. **A5 unverified 映射 unstable（不新增 outcome），不注入信封、停止、原样返回**——CONFIRMED by G5-2。
6. **A6 task 不重绑，保持 #459 公式；上下文走 evidenceContext**——CONFIRMED by G5-3。
7. **A7 信封策略三分（INSUFFICIENT→补跑信封 / fail→失败信封附 evidenceContext / unverified+abort→不注入直接停）**——CONFIRMED by G5-4。
8. **A8 判官工具面裁剪由 SPEC 468 承担，本 spec 不重复实现**——CONFIRMED by #450 Resolution"由 #468 待办 2 承担" + #468 Step 0。
9. **A9 插入点 = verify-loop.ts produceObservation 缝；hub 闭包可拿完整 messages（截至 compact）**——CONFIRMED by R3 #457 Resolution。
10. **A10 补跑至多 1 次**（防补跑-不足震荡；G2-3 说"补跑后仍不足→落判官"，本 spec 细化为 1 次上限）——spec 自述细化，挂 G2-3 语义推导，标注非决议原文。
11. **A11 命令路径既有机制（沙箱/阶梯/趋势/escalate）不改，仅在其前级插入证据优先**——CONFIRMED by #449 Destination"替换的是 A/B 二选一模型"，命令路径本体非替换对象 + G3"command 保留为可选覆盖"。

→ 全部挂决议票原文 / research Resolution / explorer 实证，无静默假设。

## ACR Verdict（architecture-change-reviewer）

**Round 1（2026-08-16）**: `5/5 yes` → **OVERALL: PASS → hand to writing-plans**。

```
bounded-context-guardian: yes — 改动限于 src/harness/verify/（checker/probe 缝 + inject/types/barrel）+ hub.ts userText 公式 + trace 双实现；Never-do 明冻 run() 停止语义 / 命令路径沙箱·阶梯·趋势 / buildNextPriorMessages 信封模式；barrel 既有最小面先例保留。
defensive-contract-validator: yes — 测试表覆盖 5 边界类 + 并发：正常（3 子例）/ 失败（unverified/abort/CONTRADICTED）/ 边界（G3 充分不重跑、补跑 1 次上限、探测失败、compact 退化）/ 空非法（畸形判官 JSON、空 evidenceContext）/ 权限（只读工具面）/ 并发中断（补跑中 abort 无 stale closeout、每轮至多一判官串行）；命令路径回归先锁定（零删除检查）；stub runFn + trace 双轨。
error-handling-enforcer: yes — fail-open 停法：unverified/abort → outcome=unstable、零信封注入、typed reason（"unverified" vs "abort"）落 VerificationRecord；"bluffing verifier worse than none" 禁止猜 unverified 成 pass/fail；四态判官输出 + 映射表；transport/schema 降级落 abort → unstable，每路径 EXIT 有文档。
complexity-anti-drift: yes — 三级流插在单一 produceObservation 缝（verify-loop.ts:610），不动 runVerifyLoopBody 轮次/趋势/maxRounds/escalate 框架与 786-835 分发；新纯函数模块独立；soft caveat：checker 三态进 trend 评估前必须映射回闭环 Verdict（pass/true-failure/unstable）——已写入 Code Style。
minimal-change-verifier: yes — 1 logical task（证据优先编排），1 commit；不越界进 goal 语义（SPEC 458）/ checker 内部（SPEC 449a）/ 判官只读实现（SPEC 468）；Never-do 明排 task 重绑 / 上下文塞 task / 删命令路径测试；11 条假设全挂外部决议原文。
```
