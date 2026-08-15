# Spec: 449a — evidence-checker：证据优先判定的纯函数规则引擎（三态 verdict + 三防 + D2 探测）

> 来源：#449 map 的 G2 #451（规则引擎位置 / PASS 公式 / 三态 verdict 制）+ G4 #453（框架白名单 / 时效 / anti-gaming 两档 / fail-closed）+ G3 #452（D2 自动探测方向）；移植蓝图 = R2 #456（did-it evidence.py + agent-receipts gaming.py + truth structured/count 分层）；证据基线 = R3 #457（bash exit code 在 tool_result 结构化 JSON；插入点缝）。
> 上游 map：#449（verify 证据优先判定）。
> 定位：本 spec = **纯函数层**（G2-1 明示落点 `src/harness/verify/evidence-checker.ts`），零 IO、零 LLM、零 loop 接线；编排层消费归 SPEC `449-verify-evidence-first-loop`。两份 spec 同属 #449，本份先行（编排层依赖 verdict 契约）。
> 假设闸门：operator 已授权"自己决策、自己审完写好"（delegated assumption confirmation）。

## Glossary（exact copy from docs/CONTEXT.md + 决议新术语）

- **append-only messages**: Foundation 的权威 Anthropic 原生会话历史，是唯一事实来源；消息只能以不可变追加更新。——evidence-checker 的输入就是这份历史的只读快照。
- **三态判定 (tri-state verdict)**: 验证结果判定 = pass / 真失败 / 不稳定。——注意与下面 checker 三态区分：那是闭环轮次判定，这是证据充分性判定。
- **外挂自检层 (external self-check layer)**: (#128 决议 D1) orchestrator 层的 advisor 形态验证闭环。evidence-checker 是该 advisor 判定段的确定性前级。
- **checker 三态 verdict【G2 决议术语】**：`EVIDENCE_SUFFICIENT`（充分 → 直接 PASS）/ `EVIDENCE_CONTRADICTED`（矛盾）/ `EVIDENCE_INSUFFICIENT`（不足或歧义 → 先补跑、再判官）。6 条检查全部封装在 evidence-checker 内部，**调用方只消费 verdict，不数条件**。
- **green marker【R2/G4-1 术语】**：测试框架输出里的通过摘要行（pytest/jest/vitest/go test/cargo test 白名单）。只从框架摘要行读数字，**绝不扫描任意输出**。
- **弱绿（weak green）【R2/truth 术语】**：exit 0 但不代表整套过的绿——`0 tests run` / `collected 0 items` / `no tests found` / 窄跑（`-k`/`-t`/`::`）。弱绿不算充分证据。
- **吞失败模式【G4-3 硬信号】**：`|| true` / `|| exit 0` / `; exit 0` / `--passWithNoTests`——命令文本命中即该证据作废。
- **gamingSignals【G4-3 软信号记录字段】**：断言数减少 / 新增 skip/xfail / `git commit --no-verify|-n`——仅记录随 trace 落盘，不参与判定。
- **D2 自动探测【G3 决议术语】**：无 `verify.command` 时按项目类型探测默认验证命令（pyproject→pytest 等），让零配置也有补跑命令可用。

## Architectural Constraints（ADR 引用）

- **ADR-0003 / ADR-0008**（trace placement / token accounting）：checker 产出的 `gamingSignals` 随 `VerificationRecord` 落 TraceService（字段扩展在 SPEC 449-verify-evidence-first-loop）；checker 本体不写 trace、不做 IO。
- **ADR-0006**（tool-output-capping）：checker 只消费已被 sandbox（12k codepoints）/ executor（20k chars）截断过的 stdout——截断是上游权威，checker 不信任也不重建截断元数据（executor truncation authority 契约 X 精神）。
- **冻结契约**：checker 是纯函数模块——不 import loop-engine / session-api / subagent；输入 = 只读 messages 数组 + 少量标量，输出 = verdict 报告。编排缝（`verify-loop.ts:610` produceObservation）的接线不在本 spec。

## Objective

实现 #449 证据优先判定的确定性前级：主会话 completed 后，先由纯函数规则引擎核对主会话 transcript 里的真实执行证据（bash tool_use + exit 0 + 框架 green marker + 时效 + 无削弱痕迹），产出三态 verdict；证据扎实 → SUFFICIENT（直接 PASS，零 LLM 成本）；不足/歧义 → INSUFFICIENT（走补跑/判官）；硬矛盾（删/清空测试文件）→ CONTRADICTED。附 D2 自动探测：无用户 command 时给出项目默认验证命令（供补跑信封消费）。

依据（R1 四路外部证据 + R2 三个开源实现已验证该设计可移植）：PASS 仅由「绿证据 + 无中间编辑」给出，其余落判官；a verifier that bluffs is worse than none（fail-closed）。

用户：verify 闭环全体消费者（判定成本与可信度同时改善）。成功 = 给定 messages 快照，checker 对五框架的绿/弱绿/吞失败/过期/矛盾样本给出正确三态，且任何歧义一律不 SUFFICIENT。

## Tech Stack

不变：TypeScript + Node（ESM，tsc strict）。无新依赖。纯正则 + 字符串解析（框架 marker 识别）；不引入 parser 库。

## Commands

```bash
npm run typecheck
npm test
npx vitest run tests/harness/verify/evidence-checker   # 本模块定向
npm run lint
```

## Project Structure

```
src/harness/verify/evidence-checker.ts   # 【新】纯函数规则引擎：extractTestRuns + 6 条检查 + 三态 verdict
src/harness/verify/command-probe.ts      # 【新】D2 自动探测纯函数（项目标志文件 → 默认验证命令）
src/harness/verify/types.ts              # + EvidenceVerdict / EvidenceReport / TestRunEvidence / GamingSignal 类型
tests/harness/verify/evidence-checker/   # 【新】单元矩阵（五框架 marker × 三防 × 边界类）
tests/harness/verify/command-probe.test.ts
```

不改：`verify-loop.ts`（接线归 SPEC 449-verify-evidence-first-loop）、`verdict.ts`（闭环三态，不同域）、`classifier.ts`。

## Code Style

沿用既有风格（显式 readonly 类型、纯函数、注释只解释 why）。契约形状：

```ts
export type EvidenceVerdict =
  "EVIDENCE_SUFFICIENT" | "EVIDENCE_CONTRADICTED" | "EVIDENCE_INSUFFICIENT";

export interface TestRunEvidence {
  readonly messageIndex: number; // messages 数组 index（时序锚，R2/G4-2：不用 mtime/diff/git）
  readonly command: string; // bash tool_use input.command
  readonly exitCode: number | null; // JSON.parse tool_result text block {code}；is_error → null
  readonly framework: "pytest" | "jest" | "vitest" | "go" | "cargo" | null;
  readonly greenSummary: boolean; // stdout 含白名单 green 摘要行
  readonly weakGreen: boolean; // 0 tests / collected 0 / no tests found / 窄跑
  readonly swallowed: boolean; // || true / || exit 0 / ; exit 0 / --passWithNoTests
}

export interface EvidenceReport {
  readonly verdict: EvidenceVerdict;
  readonly reasons: ReadonlyArray<string>; // 不足/矛盾的具体原因（补跑信封与 evidenceContext 消费）
  readonly runs: ReadonlyArray<TestRunEvidence>; // 已执行测试命令清单
  readonly gamingSignals: ReadonlyArray<string>; // 软信号仅记录
  readonly stale: boolean; // 绿证据后被代码编辑（agent-receipts STALE 语义）
}

export function checkEvidence(args: {
  readonly messages: ReadonlyArray<AnthropicNativeMessage>; // 只读快照（截至最后一次 compact）
  readonly claimIndex: number; // completed 声称位置（时效窗口右端）
}): EvidenceReport;

/** D2：项目标志文件 → 默认验证命令；探测失败返回 null（fail-closed，落判官）。 */
export function probeVerifyCommand(files: ReadonlyArray<string>): string | null;
```

关键实现纪律（R2 移植）：

- exit code 提取：先 `JSON.parse` tool_result 首个 text block（`{code, stdout, stderr}`，bash.ts:79-83 → executor.ts:46 文本契约）；解析失败回退 `^Exit code (\d+)`；`is_error=true`（`[execution_failed]` 前缀）→ 无 code。
- green marker 判定：命令位置锚定 + env 前缀 + 引用剥离识别 runner；**只读摘要行数字**（pytest 需 count+duration 双子句；jest/vitest `N total`/`Tests: N passed`；cargo `test result:`；go `ok pkg`）。
- 时效：绿测试 turn 之后、claimIndex 之前存在 `edit_file`/`write_file` 且目标路径非 doc-only（`.md`/`.txt`/`docs/` 等）→ stale → 不 SUFFICIENT。bash 内联改文件（`sed -i`/`echo >`）v1 不追（G4-2 已知局限）。
- CONTRADICTED 触发（二进制事实才配矛盾，truth count-based 永不指控）：`write_file` 把测试文件清空（内容 ≈ 空）；bash `rm` 测试文件。
- D2 探测表（v1 覆盖面）：`pyproject.toml`/`pytest.ini`→`pytest`；`package.json`（含 vitest dep）→`npx vitest run`、（含 jest dep）→`npx jest`；`go.mod`→`go test ./...`；`Cargo.toml`→`cargo test`。多标志冲突 → null（不猜）。

## Testing Strategy

vitest 纯单元（合成 messages fixture），落 `tests/harness/verify/evidence-checker/`。覆盖测试规范六类：

| 层                 | 内容                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正常               | 五框架各一条「exit 0 + green 摘要 + 无编辑」→ SUFFICIENT；一条即够（G2-4 阈值）。                                                                                                                                                                                                     |
| 失败               | exit ≠ 0 → INSUFFICIENT；`is_error` execution_failed → INSUFFICIENT；绿后 edit_file 代码文件 → stale → INSUFFICIENT；删/清空测试文件 → CONTRADICTED。                                                                                                                                 |
| 边界               | 弱绿四形态逐个（0 tests run / collected 0 items / no tests found / `-k`/`::` 窄跑）→ 非 SUFFICIENT；吞失败四 pattern 逐个 → 该证据作废；doc-only 编辑（`.md`/`docs/`）豁免 → 仍 SUFFICIENT；恰好一条合格证据 + 多条不合格 → SUFFICIENT；claimIndex = 0 / messages 空 → INSUFFICIENT。 |
| 空/非法输入        | messages 无任何 bash → INSUFFICIENT；bash 有但 tool_result 非 JSON 且无 Exit code 行 → 该 run exitCode null → INSUFFICIENT；畸形 message 形状（缺 content）→ 不 crash，INSUFFICIENT。                                                                                                 |
| 权限               | N/A（纯函数，无权限面）。                                                                                                                                                                                                                                                             |
| 并发               | N/A（纯函数无状态）。                                                                                                                                                                                                                                                                 |
| anti-gaming 软信号 | 断言数减少 / 新增 skip / `git commit --no-verify` → 记入 `gamingSignals`，**不改 verdict**（count-based 永不指控）。                                                                                                                                                                  |
| D2 探测            | 五类标志文件各命中正确命令；无标志 → null；多标志冲突 → null。                                                                                                                                                                                                                        |
| fail-closed 总则   | 任何未覆盖歧义样本 → INSUFFICIENT（补充一条属性式用例：随机残缺 fixture 永不 SUFFICIENT）。                                                                                                                                                                                           |

## Boundaries

- **Always do**：只从框架摘要行读通过数字（绝不扫描任意输出）；时序用 messages index（不用 mtime/diff/git）；歧义一律不 SUFFICIENT（fail-closed）；软信号只记录不判定；保持纯函数（无 IO / 无 LLM / 无 import loop-engine）。
- **Ask first**：doc-only 豁免清单的扩展（v1 = `.md`/`.txt`/`docs/`，加新后缀需确认）；D2 探测表新增框架/标志文件。
- **Never do**：让 checker 消费 verdict 之外的条件数（调用方不数条件，G2 升级决议）；把 bash 内联改文件检测塞进 v1 时效（G4-2 明示已知局限）；用软信号定罪；在 checker 里写 trace / 发信封（越层）；为 marker 解析引入新依赖。

## Success Criteria（binary，每条映射可执行检查）

1. **模块存在且纯**：`evidence-checker.ts` 只 import 类型与纯工具，不 import loop-engine/session-api/subagent/fs。**Check**: `grep -n "^import" src/harness/verify/evidence-checker.ts`（无禁项）。✅/❌
2. **三态 verdict 制**：导出 `EvidenceVerdict` 三态 + `checkEvidence` 返回 `EvidenceReport`；调用方接口无"条件计数"面。**Check**: `grep -n "EVIDENCE_SUFFICIENT\|EVIDENCE_CONTRADICTED\|EVIDENCE_INSUFFICIENT" src/harness/verify/types.ts`。✅/❌
3. **五框架 marker**：pytest/jest/vitest/go/cargo 各有 green 摘要行识别测试通过。**Check**: `tests/harness/verify/evidence-checker/frameworks.test.ts` 五用例全绿。✅/❌
4. **exit code 双路解析**：结构化 JSON 优先、`Exit code N` 正则回退、is_error→null。**Check**: `exit-code.test.ts` 三路用例。✅/❌
5. **三防落点**：弱绿/吞失败/时效各有独立用例；doc-only 豁免用例存在。**Check**: `three-guards.test.ts` 全绿。✅/❌
6. **CONTRADICTED 仅二进制事实**：清空/删除测试文件 → CONTRADICTED；数字类信号（断言减少）永不 CONTRADICTED。**Check**: `contradicted.test.ts` + `gaming-soft.test.ts`。✅/❌
7. **fail-closed**：歧义/残缺/空输入样本集全部非 SUFFICIENT。**Check**: `fail-closed.test.ts`（含属性式残缺用例）。✅/❌
8. **D2 探测**：五类标志文件命中 + 无标志/冲突 → null。**Check**: `command-probe.test.ts` 全绿。✅/❌
9. **gamingSignals 只记录**：软信号命中时 verdict 不变、`gamingSignals` 非空。**Check**: `gaming-soft.test.ts` 断言。✅/❌

## Open Questions

- **OQ1**：第 6 条检查"相关性"的最小语义——v1 取「该 run 是会话自身 tool 历史中的 bash 测试执行（非信封注入文本引述）且框架在白名单」；更细的任务↔证据相关性匹配留待判官（evidenceContext 消费侧）。不阻塞。
- **OQ2**：compact 后证据缺失的处置——按 fail-closed 归 INSUFFICIENT（被裁轮次证据从 messages 消失，R3 实证），补跑不可用时落判官（G3 判官定位段已含"compact 后证据链断裂"场景）。不阻塞。

## Assumptions（operator delegated，逐条挂外部真值）

1. **A1 模块位置 = `src/harness/verify/evidence-checker.ts` 独立纯函数，loop 仅在 produceObservation 缝调用**——CONFIRMED by G2-1（#451 comment）。
2. **A2 三态 verdict 制 + 6 条检查封装内部、调用方只消费 verdict**——CONFIRMED by G2 升级补充（#451 owner 确认 comment）。
3. **A3 PASS 五条件合取（exit 0 / green 摘要 / 非弱绿 / 无吞失败 / 时效窗口无代码编辑）**——CONFIRMED by G2-2。
4. **A4 阈值 = 一条合格执行即 SUFFICIENT**——CONFIRMED by G2-4。
5. **A5 框架白名单 = pytest/jest/vitest/go/cargo；解析失败 → INSUFFICIENT 不 fail-open**——CONFIRMED by G4-1。
6. **A6 时效 = messages 工具调用时序（index），doc-only 豁免，bash 内联改文件 v1 不追**——CONFIRMED by G4-2。
7. **A7 anti-gaming 两档：硬信号作废证据（吞失败→INSUFFICIENT；删/清空测试→CONTRADICTED），软信号仅记 gamingSignals**——CONFIRMED by G4-3。
8. **A8 fail-closed 立场（拿不准不 PASS）**——CONFIRMED by G4-4。
9. **A9 exit code 解析 = JSON.parse 优先 + 正则回退 + is_error→无 code**——CONFIRMED by R3 #457 Resolution（bash.ts:79-83 / executor.ts:46 文本契约）。
10. **A10 D2 探测 v1 覆盖面 = pyproject/pytest.ini→pytest、package.json(vitest|jest)→对应 runner、go.mod→go test、Cargo.toml→cargo test；冲突/无标志 → null**——方向 CONFIRMED by G3（"pyproject→pytest 等"），覆盖面清单为本 spec 细化（#449 Not yet specified 明示 spec 阶段定）。
11. **A11 checker 不做补跑/不发信封/不落 trace**（纯函数层纪律，接线归编排 spec）——CONFIRMED by G2-1 + v2 纯函数层纪律。

→ 全部挂决议票原文 / research Resolution，无静默假设。

## ACR Verdict（architecture-change-reviewer）

**Round 1（2026-08-16）**: `5/5 yes` → **OVERALL: PASS → hand to writing-plans**。

```
bounded-context-guardian: yes — checker 冻结为纯 import，SC1 给出可执行 grep 禁项检查；唯一跨 context import（AnthropicNativeMessage 自 model-adapter/types）与 verify-loop.ts:28 既有同款，无反向依赖。
defensive-contract-validator: yes — 矩阵覆盖 empty（空 messages / 无 bash / claimIndex=0）、negative（exit≠0 / 畸形 tool_result JSON / is_error）、overflow（多条不合格 + 恰好一条合格）、concurrent（N/A 纯函数无状态，defensible）、exception（畸形 shape 不 crash → INSUFFICIENT），另设五框架 × 三防专项测试文件。
error-handling-enforcer: yes — fail-closed 显式（"歧义一律不 SUFFICIENT"）+ 随机残缺 fixture 永不 SUFFICIENT 属性测试；CONTRADICTED 限于二进制删除/清空测试文件事实（取自 tool_use args）；软信号仅记录；probeVerifyCommand 冲突返回 null；JSON 解析失败 → exitCode null → INSUFFICIENT，无静默放行。
complexity-anti-drift: yes — 两个单一职责纯模块（规则引擎 vs D2 探测）、types.ts 仅类型扩展、零新依赖、零 IO/LLM/trace；6 条检查封装在单一 verdict 契约后，非 god-function。
minimal-change-verifier: yes — 1 logical task（证据规则引擎）；loop 接线与 VerificationRecord trace 字段扩展显式移交 sibling spec；verify-loop.ts / verdict.ts / classifier.ts 明示不改。
```

Ground truth 核验（reviewer 实证）：verify-loop.ts:610 produceObservation 缝确认；bash.ts:79-83 返回 `{code,stdout,stderr}` + executor.ts:46 JSON 序列化确认；tool-result.ts:33/44 is_error + `[execution_failed]` 前缀确认；runner.ts:16 stdout 12k / executor.ts:30 硬上限 20000 确认；compress/window.ts preserveToolPairs 保证 compact 后 tool_use↔tool_result 成对，checker 只读快照输入仍配对（OQ2 一致）。非阻塞观察：`^Exit code (\d+)` 回退正则当前无生产 producer（模型面 bash 恒为 JSON shape），属防御性兜底，非 fail-open 风险。
