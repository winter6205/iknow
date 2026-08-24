# verify-loop v2 原型 — 研究报告与成功结论

新一代验证闭环（v2 原型）的研究与交付报告。实现位于 `worktree-verify-loop-prototype` 分支（PR #465，**不并入 master**），本页是研究结论的 docs 归档。

## 报告

- [verify-loop v2 学术研究报告](verify-loop-v2-research-report.html) — 24 篇论文交叉验证，学术 → 实现映射，设计决策与诚实局限
- [verify-loop v2 原型成功结论报告](verify-loop-v2-prototype-report.html) — 交付物清单、实测验证证据、code-review 结论、后续 lift 步骤

## 背景

v1 verify-loop（#128）是失败自动修正闭环 orchestrator：advisor 包裹 `run()`，command 沙箱执行，信封 append-only 注入，command 缺失时子代理 LLM 判官（分类器）接管。

v2 原型在其上做学术升级（**不替换 v1 装配**，仅研究验证）：

| 升级点                       | 学术依据                                                 | 原型实现                                                  |
| ---------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| best-of-N + self-consistency | Self-Consistency (2203.11171) / LLM Monkeys (2407.21787) | `consensus.ts` — 多候选 majority 聚合 + dispersion        |
| multi-judge pool             | JudgeBench (2410.12784) / 判官去相关                     | `judge-pool.ts` — 3 判官 majority + position-bias shuffle |
| effort budget 多维           | Scaling Test-Time Compute (2408.03314)                   | `effort-budget.ts` — rounds/tokens/costUsd/wallMs 四元组  |
| confidence-based stop        | 2408.03314                                               | dispersion 记录（stop 仍纯 majority，lift 项）            |
| execution-first 分层         | 2310.01798（无外部 verifier 修正必败）                   | command 产 artifact（exit+signature），LLM judge 兜底     |

## 验证摘要

- vitest 全量 **2975/2975 通过**（210 文件，exit 0）
- verify 套件 **170 例**（含 e2e stub-runVerify + bwrap 增强）
- pty 实测 8 场景 TUI，outcome 全符合预期
- master 基线对比：4 个 TUI 失败为 pre-existing 环境问题，与 verify 改动零关联
- code-review（Standards + Spec 双轴）：0 High，7 Medium 已修

## 关键 issue 回填

见 #408（会话级 goal 机制）讨论区 — 原型研究结论回填于该 issue 的 verify-loop 分类器升级上下文。
