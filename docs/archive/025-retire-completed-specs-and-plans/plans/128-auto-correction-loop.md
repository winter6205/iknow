# Plan: 失败自动修正闭环（外挂自检层）

Spec: `specs/128-auto-correction-loop.md`（ACR 五维全 yes，2026-08-12）
Source: #116 [wayfinder:map] ⑤ 评估闭环 · #128 resolution（D1–D7）
Tracker: GitHub（label `ready-for-agent`，native blocking via addBlockedBy）

---

## Architecture Change Reviewer verdict

引自 spec（第二轮复审 PASS）：

- bounded-context-guardian: yes — 沙箱 runner 抽取至 `src/harness/sandbox/runner.ts`，verify/ 与 bash.ts 同向依赖 sandbox 基础层；parentTurnId 语义已裁决。
- defensive-contract-validator: yes — 空输出 / 解析失败 / 超时 / abort / 未配置 / ENOENT(exit=127) / 20000 字符截断全覆盖。
- error-handling-enforcer: yes — 全失败路径类型化（三态 Verdict / 超时→不稳定 / abort→closeout / 耗尽→report|escalate）。
- complexity-anti-drift: yes — 四文件单职责拆分，verdict.ts 纯函数。
- minimal-change-verifier: yes — 文件清单完整，2-commit 主序列（runner 抽取 refactor + verify 主体）。

---

## Decisions（PLAN 阶段定稿，原 spec Ask-first 项）

- **settings 字段**（项目 `.iknow/settings.json`，parse/merge/freeze 既有模式）：

  ```
  verify.command: string            # 必填才启用闭环
  verify.rerunTemplate?: string     # 失败用例单跑模板，{files} 占位
  verify.countRegex?: string        # 失败数提取覆盖（可选）
  verify.timeoutSec?: number        # 默认 600；超时判"不稳定"
  verify.onExhausted?: "report" | "escalate"   # 默认 report
  verify.maxRounds?: number         # 兜底总轮数上限，默认 12
  ```

- **TraceService 记录**：`VerificationRecord { id, sessionId, round, verdict: "pass" | "true-failure" | "unstable", exitCode, failedCount?, signature?, action: "continue" | "stop" | "escalate", finalOutcome?, ts }`；方法 `recordVerification(record)`（types / noop / jsonl 三处同步，`@throws never` 契约沿用）。
- **内置失败行识别**：exit≠0 时计输出中匹配 `/^\s*(FAIL(ED)?|✗|×)\b|\berror:/i` 的行数为 failedCount；`countRegex` 配置优先；两者均无 → 纯签名比对（仅停滞检测）。
- **SandboxCmdRecord.parentTurnId**：挂触发本轮验证的 completed turn id（上一轮 run 最后回合）。

---

## Tracer bullets

1. `[decision]` **命名与格式定稿** — 本 plan §Decisions 即裁决记录（settings 字段名 / VerificationRecord 字段 / 失败行正则 / parentTurnId 语义）。
   - **Acceptance**: §Decisions 四项裁决齐全且与 spec 无矛盾。
2. `[implementation]` **沙箱 runner 抽取**（no-behavior-change refactor，ACR commit 1）[blocks: 7]
   - **Affects**: `src/harness/sandbox/runner.ts`（新）· `src/harness/aci/tools/bash.ts`（改消费 runner）
   - **Acceptance**: `npm test` 既有 bash / sandbox 测试全绿 + `npm run typecheck` 绿；bash 工具行为不变。
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
3. `[implementation]` **verdict 纯函数**（三态判定 / 确认阶梯 / 失败签名 / 趋势判定）`[parallel]`
   - **Affects**: `src/harness/verify/verdict.ts` · `src/harness/verify/types.ts`（新）· `tests/harness/verify/verdict.test.ts`（新）
   - **Acceptance**: 单元测试覆盖三态、阶梯两级、签名归一、趋势四用例（进展放行 / 同签名停滞停 / 连续两轮退化停 / 单轮震荡宽容）全绿。
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
4. `[implementation]` **注入信封与截断** `[parallel]`
   - **Affects**: `src/harness/verify/inject.ts`（新）· `tests/harness/verify/inject.test.ts`（新）
   - **Acceptance**: 具名测试 `truncates output excerpt at 20000 chars` + 信封格式（`[VALIDATION FAILED]` 标记、字段齐全、append-only 消息形状）全绿。
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
5. `[implementation]` **settings verify 段** `[parallel]`
   - **Affects**: `src/config/settings.ts` · `tests/config/settings.test.ts`
   - **Acceptance**: 未配置 → `verify` undefined（透明关闭）；默认值 timeoutSec=600 / onExhausted=report / maxRounds=12；非法值（负数 / 空 command / 未知 onExhausted）按既有降级模式处理；全绿。
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
6. `[implementation]` **TraceService VerificationRecord** `[parallel]`
   - **Affects**: `src/harness/trace/types.ts` · `src/harness/trace/noop.ts` · `src/harness/trace/jsonl.ts` · `tests/harness/trace/`（新增用例）
   - **Acceptance**: jsonl sink 写入 VerificationRecord 测试绿；noop 实现编译通过；`npm run typecheck` 绿。
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
7. `[implementation]` **verify-loop 主循环 + 集成测试** [blocks: 8]
   - **Affects**: `src/harness/verify/verify-loop.ts`（新）· `tests/harness/verify/verify-loop.test.ts`（新，stub model + stub 验证命令）
   - **Acceptance**: spec 11 条 binary Success Criteria 逐条成测试全绿（先错后对走通 / 捕获无漏网 / flaky 不修正 / 不稳定标注 / 趋势三规则 / report+escalate+兜底 12 / 未配置逐字节一致 / TraceService 落盘 / 仅 completed 触发 / 超时判不稳定 / abort closeout）。
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
8. `[implementation]` **装配接线 + SSOT 入表 + eval 基线**
   - **Affects**: chat / tui / serve 装配点（`run()` → verify-loop 包裹）· `docs/architecture.md`（Capability modules 表入 verify）· `.evals/tasks/020-verify-loop.yaml`（新）
   - **Acceptance**: `bash .evals/run.sh` 020 任务 exit 0；`ask` 路径确认未接入；`npm test` 全绿。
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## 依赖图

```
T1 (decision) ──► T3, T4, T5, T6 [parallel]
T2 (runner 抽取) ──────────────► T7 ◄── T3, T4, T5, T6
                                  │
                                  ▼
                                 T8
```

## Validation

- `cat plans/128-auto-correction-loop.md | grep -E "^\s*[0-9]+\."` — 8 bullets 编号齐全
- 执行期：8 bullets = 8 commits（各自分支）；diff scope 与 Affects 一致
- 闭环验收：`bash .evals/run.sh` 020 任务通过 = plan 完成
