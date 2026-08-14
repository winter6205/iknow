# Session Handoff — #128 verify-loop 产品定位修正 (2026-08-13)

## 当前 live 状态

- **任务**: 把 #128 verify 闭环从「配置才存在」改成「内置默认开 + TUI 可见」，回答用户对产品定位的质疑。
- **为什么重要**: 128 交付的闭环引擎（`src/harness/verify/`）是**内置能力**，却绑在 `settings.verify.command` 上——不配 = 整个能力消失（SC7 透明关闭）。用户判断「默认不开等于白做」成立。同时 TUI 前端零消费 verify 结果，导致「在 TUI 里体验」目前不可行。
- **operator 显式指令**: 「先告诉我 chat 的收尾报告是什么…第二个问题我觉得要默认开，不然我们做来干什么…第三个问题 TUI 难道你没做吗…评估命令都不该暴露给用户」→ 交接后下会话继续。

## 已固化工件（引用，不复制 inline）

| 类型         | 路径 / URL                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------ |
| 计划         | `plans/128-auto-correction-loop.md`                                                        |
| spec         | `specs/128-auto-correction-loop.md`（SC7 透明关闭 = 待改定稿语义）                         |
| PR           | https://github.com/winter6205/iknow/pull/406（draft, head 分支: worktree-128-verify-loop） |
| 领域词汇     | `docs/CONTEXT.md`                                                                          |
| 决策记录模板 | `docs/adr/`（新 ADR 将落此处）                                                             |

## 本 session 变更

**8-13 session**: 无代码变更，read-only 调查 + 产品定位结论。工作树干净（3 commit：`816e44e`/`481fb9f`/`47e8e75`，PR #406 draft）。

**8-14 session（本次）**:

- **PR #427 已 merged**（`a017304`，target `worktree-128-verify-loop`）——#408 会话级 goal 机制 T1–T5（goal schema v5 / seed / re-pin / verify-loop seam `userText = goal.text ?? query` / status write-back）。
- **新写 spec** `specs/128-verify-classifier.md`——分类器（子代理 LLM 判官）填空 command 缺失,完成架构设计 + ACR Round 1 BLOCKED → Round 2 **5/5 PASS**。

## 已验证状态（本 session 的 read-only 查证）

```
grep -rn "verifyView\|\.verify\b" web/src/  => 0 匹配（TUI 前端零消费）
grep -rn "verify" src/tui/run.tsx src/tui/hub-bridge.ts => 仅装配透传，无渲染
git merge-base --is-ancestor 3151844 HEAD => false（126 hook 系统未并入本分支）
jq '.verify' ~/.iknow/settings.json => null（当前 user 配置未启用 verify）
```

## Open blockers + next steps

**[NEXT] 起草 ADR：verify 默认开 —— 定稿「默认 command 选什么」（唯一待用户拍板点，建议 `npm test`），并改写 SC7「command 缺席=透明关闭」为新语义。** 这是后续所有实现的前置，需用户确认默认 command 后才能动代码。

- **决策内容（ADR 骨架，下会话据此起草）**：verify 是内置能力默认开；`verify.command` 降级为「项目级可覆盖参数」而非「能力开关」；废除 SC7 透明关闭。分层：能力开关=引擎内置默认 on；验证命令=项目配置可覆盖，给安全默认。
- **实现（依赖 ADR 通过）**：
  1. `src/config/verify-config.ts` 的 `resolveVerifyConfig`：command 给默认值、verify 段缺失仍启用（当前 `verify?.command === undefined` 直接返回 undefined）。
  2. TUI 过程可见：`web/src/` 消费 `VerifyAnswerView`（`src/session-api/contract.ts:49`，已上 wire 但前端零消费），surface 每轮判定 + 信封注入，而非仅结尾一行。
  3. chat 补齐 `passed` 态的过程可见（当前 `formatVerifyReport`（`src/cli/format.ts:248`）仅 failed/unstable/escalated 三个失败态一行，passed 完全黑盒）。
- **已确认事实（下会话不必重查）**：闭环引擎完整（T1-T8 全过，spec 11 条 SC 有测试）；TUI 路径闭环会跑（`session-api/hub.ts:556` 包了 runVerifyLoop）但无可见性；verify-loop 与 126 hook 系统无关（D1 advisor 包裹 run，非用户 hook）。
- **8-14 frozen table**（来自 `specs/128-verify-classifier.md`，分类器填空方案已 spec 锁定）：
  - 定位：command 缺失时填空(路径 X,command 已配不双跑分类器)
  - 形态：sub-agent B3（进程隔离 + 只读 + bwrap exec）
  - 输入：`{ task: goal.text ?? query, summary, finalText }`
  - 输出 schema：`{kind, reason, evidence?, missing?}`，pass 空 evidence 静默降级 abort
  - 失败语义：fail → 信封继续；abort/transport/schema 错 → unstable
  - 触发时机：仅 StopReason=completed，与 command 同构
  - 模型：`settings.verify.classifierModel ?? settings.llm.model`，代码层不硬编码
  - 截断：宿主侧 2000 chars，prompt 不写长度
  - settings：`IknowSettingsVerify` 加 `classifierModel?: string`，verify 段语义 = 可调参数非能力开关

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:session-handoff` — 本交接结束后的接续入口（可选）
- 起草 ADR 前可用 `Explore` 确认 `docs/adr/` 现有 ADR 命名/编号约定，避免编号冲突
- 实现阶段按全局规则走 TDD + code-review + verification-before-completion

## 脱敏

- 无 API key / token / password / credential 值出现
- LLM 凭据一律引用 `settings.llm.apiKey`（`${VAR}` 占位符），不写值
